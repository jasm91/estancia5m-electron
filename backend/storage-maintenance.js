/**
 * storage-maintenance.js — v0.9.272
 *
 * Mantenimiento de almacenamiento para que NO crezca infinito. TODO ES DESTRUCTIVO → con candados:
 *
 *   1. purgeOrphans()     — borra de R2 los objetos que NINGÚN catálogo referencia (usa r2-refs,
 *                            la misma lista que el conteo → no borra archivos legítimos). Skip de
 *                            objetos creados hace < 60 min (red de seguridad).
 *   2. expireChatMedia()  — borra de R2 la media de CHAT (prefijos incoming/ y outgoing/) cuyo MENSAJE
 *                            es más viejo que CHAT_MEDIA_TTL_DAYS (def 90), y libera su media_url en
 *                            la BD. NO toca catálogos/comprobantes/assets.
 *                            v0.9.477: el criterio es la fecha del MENSAJE (antes era la fecha de
 *                            subida a R2, que con historial importado daba 45 días de más).
 *                            Gracia opcional: CHAT_MEDIA_GRACE_HOURS (def 24).
 *   3. pruneOldMessages() — borra filas de `messages` más viejas que MSG_PRUNE_MONTHS (def 12), en lotes.
 *
 * CANDADOS (dos niveles):
 *   - El cron NO corre salvo  STORAGE_MAINT_ENABLED=1  (ver server.js).
 *   - Aun corriendo, es DRY-RUN (solo loguea qué borraría) salvo  STORAGE_MAINT_APPLY=1.
 *   Ventanas: CHAT_MEDIA_TTL_DAYS (def 90), MSG_PRUNE_MONTHS (def 12).
 */

const db = require('./db');
const r2 = require('./r2');
const { getReferencedKeys } = require('./r2-refs');

const APPLY = process.env.STORAGE_MAINT_APPLY === '1';
const CHAT_TTL_DAYS = Math.max(1, parseInt(process.env.CHAT_MEDIA_TTL_DAYS || '90', 10) || 90);
const MSG_PRUNE_MONTHS = Math.max(1, parseInt(process.env.MSG_PRUNE_MONTHS || '12', 10) || 12);
const CHAT_PREFIXES = ['incoming/', 'outgoing/']; // SOLO media de chat (no catálogos/comprobantes/assets)
// v0.9.477 — gracia para media recién subida: aunque el mensaje sea viejo (historial importado),
// no se borra si el objeto entró a R2 hace menos de estas horas. 0 = sin gracia.
const MEDIA_GRACE_HOURS = Math.max(0, parseInt(process.env.CHAT_MEDIA_GRACE_HOURS || '24', 10) || 0);
const ORPHAN_SAFETY_MIN = 60; // no tocar objetos modificados hace < 60 min

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// 1) Huérfanos: objetos de R2 que ningún catálogo referencia.
async function purgeOrphans() {
  if (!r2.isConfigured()) return { skipped: 'r2 no configurado' };
  const state = await r2.listAllSizes();
  const referenced = await getReferencedKeys(db, r2);
  const cutoff = Date.now() - ORPHAN_SAFETY_MIN * 60 * 1000;
  const toDelete = []; let bytes = 0, skippedRecent = 0;
  for (const o of (state.objects || [])) {
    if (referenced.has(o.key)) continue;
    const lm = o.lastModified ? new Date(o.lastModified).getTime() : 0;
    if (lm > cutoff) { skippedRecent += 1; continue; }
    toDelete.push(o.key); bytes += (o.size || 0);
  }
  if (!toDelete.length) { console.log(`🧹 [maint] purgeOrphans: nada para purgar (${skippedRecent} recientes omitidos)`); return { deleted: 0 }; }
  if (!APPLY) { console.log(`🧪 [maint][DRY-RUN] purgeOrphans: borraría ${toDelete.length} obj (${mb(bytes)}). Activá con STORAGE_MAINT_APPLY=1.`); return { dryRun: toDelete.length, bytes }; }
  const res = await r2.deleteObjects(toDelete);
  console.log(`🧹 [maint] purgeOrphans: borrados ${res.deleted}/${toDelete.length} (${mb(bytes)})`);
  return { deleted: res.deleted, bytes };
}

// 2) TTL de la media de chat (incoming/ + outgoing/) más vieja que CHAT_TTL_DAYS.
//
// v0.9.477 — AHORA POR FECHA DEL MENSAJE, no por fecha de subida a R2.
// Antes se miraba `lastModified` del objeto, que es CUÁNDO SE SUBIÓ. Con la importación de
// historial (coexistence) toda la media de conversaciones de hace meses se sube HOY, así que
// con el criterio viejo iba a vivir 45 días más desde la importación en vez de expirar ya.
// Ahora la pregunta correcta la responde la BD: "¿de cuándo es el MENSAJE que la referencia?".
//
// Gracia: se saltea la media subida hace menos de CHAT_MEDIA_GRACE_HOURS (def 24h) aunque el
// mensaje sea viejo. Evita que una importación de historial se borre a los minutos de traerla
// (el dueño acaba de importar y quiere verla) y cubre carreras de reloj.
//
// Cobertura completa: la media cuyo mensaje ya no existe (lo borró pruneOldMessages) queda sin
// referencia → la limpia purgeOrphans. Entre las dos no queda nada colgado.
async function expireChatMedia() {
  if (!r2.isConfigured()) return { skipped: 'r2 no configurado' };

  // (a) Mensajes con media más viejos que el TTL — manda la fecha del MENSAJE.
  let rows = [];
  try {
    const r = await db.query(
      `SELECT media_url FROM messages
        WHERE media_url IS NOT NULL
          AND created_at < NOW() - ($1 * INTERVAL '1 day')
        LIMIT 50000`,
      [CHAT_TTL_DAYS]
    );
    rows = r.rows;
  } catch (e) {
    console.warn('[maint] expireChatMedia (consulta):', e.message);
    return { error: e.message };
  }
  if (!rows.length) { console.log(`🗓️  [maint] expireChatMedia: ningún mensaje con media > ${CHAT_TTL_DAYS}d`); return { deleted: 0 }; }

  // (b) URL → key. Solo prefijos de CHAT: nunca catálogos, comprobantes ni assets.
  const state = await r2.listAllSizes();
  const sizes = state.sizes || new Map();
  const lastMod = new Map();
  for (const o of (state.objects || [])) lastMod.set(o.key, o.lastModified ? new Date(o.lastModified).getTime() : 0);
  const graceCutoff = Date.now() - MEDIA_GRACE_HOURS * 3600000;

  const seen = new Set(); const toDelete = [];
  let bytes = 0, skippedGrace = 0, skippedNotChat = 0, skippedGone = 0;
  for (const row of rows) {
    const key = r2.extractKeyFromUrl(row.media_url);
    if (!key || seen.has(key)) continue;
    if (!CHAT_PREFIXES.some((p) => key.startsWith(p))) { skippedNotChat += 1; continue; }
    if (!sizes.has(key)) { skippedGone += 1; continue; } // ya no está en R2
    const lm = lastMod.get(key) || 0;
    if (lm && lm > graceCutoff) { skippedGrace += 1; continue; } // recién subida → gracia
    seen.add(key); toDelete.push(key); bytes += (sizes.get(key) || 0);
  }
  const extra = `(omitidos: ${skippedGrace} en gracia <${MEDIA_GRACE_HOURS}h · ${skippedNotChat} no-chat · ${skippedGone} ya borrados)`;
  if (!toDelete.length) { console.log(`🗓️  [maint] expireChatMedia: nada para borrar ${extra}`); return { deleted: 0 }; }
  if (!APPLY) { console.log(`🧪 [maint][DRY-RUN] expireChatMedia: borraría ${toDelete.length} obj de chat de mensajes > ${CHAT_TTL_DAYS}d (${mb(bytes)}) ${extra}. Activá con STORAGE_MAINT_APPLY=1.`); return { dryRun: toDelete.length, bytes }; }
  const res = await r2.deleteObjects(toDelete);
  // v0.9.476 — CIERRE DEL HUECO: el objeto ya no existe en R2, así que hay que soltar la
  // referencia en la BD. Sin esto el panel pedía una URL muerta y mostraba la imagen ROTA
  // en los chats viejos. El texto/caption/transcripción del mensaje NO se tocan: el audio
  // viejo se va, pero su transcripción (que es lo que vale) queda.
  const cleaned = await _clearExpiredMediaUrls(toDelete);
  console.log(`🗓️  [maint] expireChatMedia: borrados ${res.deleted}/${toDelete.length} (${mb(bytes)}) de mensajes > ${CHAT_TTL_DAYS}d · media_url liberadas: ${cleaned} ${extra}`);
  return { deleted: res.deleted, bytes, urls_cleared: cleaned };
}

/**
 * v0.9.476 — Pone media_url = NULL en los mensajes cuya media acaba de expirar de R2.
 * Matchea por SUFIJO de key (la URL guardada es `${R2_PUBLIC_URL}/${key}`), así funciona
 * aunque el dominio público del bucket haya cambiado alguna vez. En lotes para no armar
 * una query gigante. Best-effort: si falla, se loguea y el borrado de R2 igual valió.
 */
async function _clearExpiredMediaUrls(keys) {
  let total = 0;
  const BATCH = 300;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    try {
      const r = await db.query(
        `UPDATE messages m SET media_url = NULL
           FROM unnest($1::text[]) AS k
          WHERE m.media_url IS NOT NULL AND m.media_url LIKE '%' || k`,
        [slice]
      );
      total += r.rowCount || 0;
    } catch (e) {
      console.warn('[maint] _clearExpiredMediaUrls:', e.message);
    }
  }
  return total;
}

// 3) Poda de mensajes viejos (texto). En lotes para no bloquear la DB.
async function pruneOldMessages() {
  let cnt = 0;
  try {
    const c = await db.query(`SELECT COUNT(*)::int AS n FROM messages WHERE created_at < NOW() - ($1 * INTERVAL '1 month')`, [MSG_PRUNE_MONTHS]);
    cnt = c.rows[0].n;
  } catch (e) { console.warn('[maint] pruneOldMessages count:', e.message); return { error: e.message }; }
  if (!cnt) { console.log(`🗃️  [maint] pruneOldMessages: nada > ${MSG_PRUNE_MONTHS} meses`); return { deleted: 0 }; }
  if (!APPLY) { console.log(`🧪 [maint][DRY-RUN] pruneOldMessages: borraría ${cnt} mensajes > ${MSG_PRUNE_MONTHS} meses. Activá con STORAGE_MAINT_APPLY=1.`); return { dryRun: cnt }; }
  let total = 0;
  for (let i = 0; i < 2000; i++) { // tope de lotes por corrida (2000 × 5000 = 10M máx)
    const r = await db.query(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages WHERE created_at < NOW() - ($1 * INTERVAL '1 month') LIMIT 5000)`,
      [MSG_PRUNE_MONTHS]);
    total += r.rowCount;
    if (r.rowCount < 5000) break;
  }
  console.log(`🗃️  [maint] pruneOldMessages: borrados ${total} mensajes > ${MSG_PRUNE_MONTHS} meses`);
  return { deleted: total };
}

module.exports = { purgeOrphans, expireChatMedia, pruneOldMessages, APPLY, CHAT_TTL_DAYS, MSG_PRUNE_MONTHS };
