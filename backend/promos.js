/**
 * promos.js — v0.9.570
 * ─────────────────────────────────────────────────────────────────────────────
 * PROMOCIONES TEMPORALES de un inmueble (o de cualquier ítem de catálogo que lo
 * adopte después). Cada promo tiene un período de vigencia y, opcionalmente, su
 * propio arte (imágenes en R2).
 *
 * REGLA DE ORO: la vigencia la calcula el SERVIDOR con la fecha de Bolivia y a la
 * IA le llegan ÚNICAMENTE las promos activas. El modelo nunca ve fechas ni las
 * compara, así que es IMPOSIBLE que ofrezca una promo vencida o que adelante una
 * que todavía no arrancó. Mismo criterio que el guard de stock del inventario:
 * los datos duros no se delegan al modelo.
 *
 * Forma de cada promo (JSONB en properties.promotions):
 *   { id, title, detail, from: 'YYYY-MM-DD'|null, to: 'YYYY-MM-DD'|null,
 *     images: [url], main: url|null }
 *
 *   from vacío  → ya empezó (vale desde siempre)
 *   to   vacío  → no vence (promoción permanente)
 *   ambos vacíos → siempre vigente
 */
const db = require('./db');

const TZ_OFFSET_MIN = -240; // Bolivia = UTC-4 todo el año (sin horario de verano)
const MAX_PROMOS = 12;
const MAX_IMAGES = 4;

/** Fecha de HOY en Bolivia como 'YYYY-MM-DD' (comparable como string). */
function todayBO(now) {
  const t = (now instanceof Date ? now : new Date());
  const shifted = new Date(t.getTime() + TZ_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

const _isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

/** properties.promotions puede venir como JSONB, string o null → array normalizado. */
function parse(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return []; } }
  if (!Array.isArray(v)) return [];
  return v.map(normalize).filter(Boolean).slice(0, MAX_PROMOS);
}

/** Sanitiza UNA promo venida del panel (nunca confiar en el cliente). */
function normalize(p) {
  if (!p || typeof p !== 'object') return null;
  const title = String(p.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!title) return null; // sin título no es una promo
  const images = (Array.isArray(p.images) ? p.images : [])
    .map((u) => String(u || '').trim())
    .filter((u) => /^https:\/\//i.test(u))
    .slice(0, MAX_IMAGES);
  const main = images.includes(String(p.main || '')) ? String(p.main) : (images[0] || null);
  return {
    id: String(p.id || '').slice(0, 40) || ('pr_' + Math.random().toString(36).slice(2, 10)),
    title,
    detail: String(p.detail || '').replace(/\s+/g, ' ').trim().slice(0, 300) || null,
    from: _isDate(p.from) ? String(p.from) : null,
    to: _isDate(p.to) ? String(p.to) : null,
    images,
    main,
  };
}

/** Estado de una promo respecto de HOY (Bolivia). */
function state(p, now) {
  const hoy = todayBO(now);
  if (p.from && p.from > hoy) return 'programada';
  if (p.to && p.to < hoy) return 'vencida';
  return 'vigente';
}

/** SOLO las promos vigentes hoy. Es lo único que ve la IA y lo único que se envía. */
function active(raw, now) {
  return parse(raw).filter((p) => state(p, now) === 'vigente');
}

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** '2026-08-31' → '31 de agosto' */
function humanDate(s) {
  if (!_isDate(s)) return '';
  const [, m, d] = s.split('-');
  return `${parseInt(d, 10)} de ${MESES[parseInt(m, 10) - 1] || ''}`.trim();
}

/**
 * Bloque de texto para la FICHA de WhatsApp. Solo promos vigentes.
 * Devuelve '' si no hay ninguna → la ficha sale exactamente igual que antes.
 */
function fichaBlock(raw, now) {
  const on = active(raw, now);
  if (!on.length) return '';
  const lines = on.slice(0, 3).map((p) => {
    const hasta = p.to ? ` (hasta el ${humanDate(p.to)})` : '';
    return `• *${p.title}*${hasta}${p.detail ? ` — ${p.detail}` : ''}`;
  });
  return (on.length === 1)
    ? `\n\n🏷️ *Promo vigente:* ${lines[0].replace(/^• /, '')}`
    : `\n\n🏷️ *Promos vigentes:*\n${lines.join('\n')}`;
}

/** Imágenes de las promos vigentes, la "principal" primero. Para mandar tras la ficha. */
function activeImages(raw, now) {
  const out = [];
  for (const p of active(raw, now)) {
    const ordered = p.main ? [p.main, ...p.images.filter((u) => u !== p.main)] : p.images;
    for (const u of ordered) if (!out.includes(u)) out.push(u);
  }
  return out.slice(0, MAX_IMAGES);
}

/** Caption del arte de la promo (corto: la imagen ya comunica). */
function imageCaption(raw, now) {
  const on = active(raw, now);
  if (!on.length) return '';
  const p = on[0];
  const hasta = p.to ? ` · válida hasta el ${humanDate(p.to)}` : '';
  return `🏷️ ${p.title}${hasta}`.slice(0, 900);
}

/** Lo que ve la IA: título + detalle, SIN fechas (no puede razonar sobre ellas). */
function forAI(raw, now) {
  return active(raw, now).map((p) => ({
    titulo: p.title,
    detalle: p.detail || null,
    vence: p.to ? humanDate(p.to) : null, // texto ya resuelto, no una fecha comparable
  }));
}

/** Todas las URLs de promo de un array (para r2-refs: que purgeOrphans no las borre). */
function allImageUrls(raw) {
  const out = [];
  for (const p of parse(raw)) for (const u of p.images) out.push(u);
  return out;
}

async function ensureSchema() {
  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS promotions jsonb`).catch(() => {});
}

module.exports = {
  ensureSchema, parse, normalize, state, active, activeImages,
  fichaBlock, imageCaption, forAI, allImageUrls, todayBO, humanDate,
  MAX_PROMOS, MAX_IMAGES,
};
