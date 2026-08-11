/**
 * nurture.js — v0.9.304
 * Nurturing por comportamiento (OPT-IN, apagado por defecto). Cron: busca ítems del
 * catálogo que matcheen el search_profile de leads y los re-engancha por WhatsApp
 * (texto <24h / plantilla >24h). Candados: opt-in por tenant, umbral de match, tope de
 * frecuencia (cooldown), no repetir el mismo ítem, no tocar leads ganados/perdidos.
 */
const db = require('./db');
const matcher = require('./catalog-matcher');

const ITEM_MAX_AGE_DAYS = 30;   // solo ítems cargados hace poco
const WINDOW_HOURS = 24;        // ventana de Meta para texto libre
let _running = false;

async function runNurtureScan() {
  if (_running) { console.log('[nurture] corrida anterior en curso → salto'); return { skipped: 'overlap' }; }
  if (process.env.NURTURE_DISABLED === '1') return { skipped: 'disabled_env' };
  _running = true;
  const t0 = Date.now(); let sent = 0, tenants = 0;
  try {
    let rows = [];
    try {
      rows = (await db.query(
        `SELECT id, nurture_min_score, nurture_cooldown_days, nurture_template,
                realestate_bot_enabled, inventory_bot_enabled, vehiculos_bot_enabled
           FROM tenants WHERE COALESCE(nurture_enabled, FALSE) = TRUE`)).rows;
    } catch (e) { return { skipped: 'not_migrated' }; }
    for (const t of rows) {
      try { sent += await nurtureTenant(t); tenants++; } catch (e) { console.warn(`[nurture] tenant ${t.id} falló:`, e.message); }
    }
    if (sent) console.log(`💬 [nurture] ${sent} enviados en ${tenants} tenant(s) (${Date.now() - t0}ms)`);
    return { sent, tenants };
  } finally { _running = false; }
}

async function nurtureTenant(t) {
  const tenantId = t.id;
  const minScore = Number.isFinite(+t.nurture_min_score) ? +t.nurture_min_score : 60;
  const cooldown = Number.isFinite(+t.nurture_cooldown_days) ? +t.nurture_cooldown_days : 3;

  const items = [];
  if (t.realestate_bot_enabled) {
    const r = await db.query(`SELECT * FROM properties WHERE tenant_id=$1 AND active=TRUE AND created_at > NOW() - make_interval(days => ${ITEM_MAX_AGE_DAYS})`, [tenantId]).catch(() => ({ rows: [] }));
    r.rows.forEach((it) => items.push({ raw: it, kind: 'property' }));
  }
  if (t.inventory_bot_enabled || t.vehiculos_bot_enabled) {
    const _invTbl = t.vehiculos_bot_enabled ? 'catalog_vehiculos' : 'inventory_items'; // v0.9.452: vehiculos con tabla propia
    const r = await db.query(`SELECT * FROM ${_invTbl} WHERE tenant_id=$1 AND active=TRUE AND created_at > NOW() - make_interval(days => ${ITEM_MAX_AGE_DAYS})`, [tenantId]).catch(() => ({ rows: [] }));
    r.rows.forEach((it) => items.push({ raw: it, kind: 'inventory' }));
  }
  if (!items.length) return 0;

  // v0.9.369 — STRAIGHT LINE: los arquetipos ordenan la cola de nurturing. El "shopping"
  // (compra en 3-6 meses) es EL cliente ideal del re-enganche → va primero; "ready" segundo
  // (por si se enfrió); "dragged" al final (no gastar plantilla en quien nunca va a comprar).
  const leads = (await db.query(
    `SELECT l.id, l.search_profile, l.name, l.phone, l.conversation_id, c.line_id, c.contact_name
       FROM leads l JOIN conversations c ON c.id = l.conversation_id
      WHERE c.tenant_id = $1 AND l.search_profile IS NOT NULL
        AND COALESCE(l.status, 'new') NOT IN ('won', 'lost')
        AND c.channel = 'whatsapp'
        AND NOT EXISTS (SELECT 1 FROM lead_nurtures n WHERE n.lead_id = l.id AND n.sent_at > NOW() - make_interval(days => $2))
      ORDER BY CASE (to_jsonb(l) -> 'sl_state') ->> 'archetype'
                 WHEN 'shopping' THEN 0 WHEN 'ready' THEN 1
                 WHEN 'curious' THEN 2 WHEN 'dragged' THEN 4 ELSE 3 END,
               l.score DESC NULLS LAST LIMIT 200`,
    [tenantId, cooldown])).rows;

  let sent = 0;
  const _mOpts = { usdToBs: await matcher.getUsdToBsRate(db) }; // v0.9.338 — candado de presupuesto Bs↔USD
  for (const lead of leads) {
    const sp = lead.search_profile;
    if (!sp || typeof sp !== 'object') continue;
    let best = null;
    for (const it of items) {
      const scored = matcher.scoreCatalogItem(sp, it.raw, it.kind, _mOpts);
      if (scored.score < minScore) continue;
      const already = await db.query('SELECT 1 FROM lead_nurtures WHERE lead_id=$1 AND item_kind=$2 AND item_id=$3 LIMIT 1', [lead.id, it.kind, it.raw.id]);
      if (already.rows.length) continue;
      if (!best || scored.score > best.score) best = Object.assign({}, scored, { kind: it.kind, itemId: it.raw.id });
    }
    if (!best) continue;
    if (await sendNurture(t, lead, best)) sent++;
  }
  return sent;
}

async function sendNurture(t, lead, match) {
  const tenantId = t.id;
  const meta = require('./meta');
  let ctx = null;
  try { ctx = await require('./tenant-resolver').getConversationMetaCtx({ tenant_id: tenantId, line_id: lead.line_id, id: lead.conversation_id, phone: lead.phone }); } catch (e) { /* fallback global */ }

  const lastIn = await db.query(`SELECT MAX(created_at) AS t FROM messages WHERE conversation_id=$1 AND direction='incoming'`, [lead.conversation_id]).catch(() => ({ rows: [{}] }));
  const within = !!(lastIn.rows[0] && lastIn.rows[0].t && (Date.now() - new Date(lastIn.rows[0].t).getTime()) < WINDOW_HOURS * 3600 * 1000);
  const name = String(lead.name || lead.contact_name || '').trim().split(/\s+/)[0] || '';
  const priceTxt = (match.price != null && match.price !== '') ? ((match.currency ? match.currency + ' ' : '') + Number(match.price).toLocaleString()) : '';

  let result = null, body = null, mode = null;
  if (within) {
    mode = 'ai';
    body = `¡Hola${name ? ' ' + name : ''}! 👋 Justo entró algo que puede encajar con lo que buscabas: *${match.title}*${match.subtitle ? ' — ' + match.subtitle : ''}${priceTxt ? ' (' + priceTxt + ')' : ''}. ¿Querés que te pase la info?`;
    // v0.9.394 — REACTIVACIÓN con NOTA DE VOZ si está activa (solo dentro de 24h; fuera va la plantilla del else). Best-effort → si falla, texto.
    let _voiced = false;
    try {
      const _vr = await require('./voice-moments').sendVoiceMoment('reactivation', { tenantId, conversationId: lead.conversation_id, lineId: lead.line_id || null, phone: lead.phone, text: body, ctx, recordMessage: false });
      if (_vr && _vr.sent) { _voiced = true; result = { success: true, wa_message_id: _vr.wa_message_id }; }
    } catch (e) { /* best-effort */ }
    if (!_voiced) {
      try { result = await meta.sendText(lead.phone, body, true, ctx); } catch (e) { result = { success: false, error: e.message }; }
    }
  } else {
    mode = 'template';
    const tplName = (t.nurture_template && t.nurture_template.trim()) || process.env.NURTURE_TEMPLATE_NAME || 'nueva_opcion_catalogo';
    const comps = [{ type: 'body', parameters: [
      { type: 'text', text: String(name || 'hola') },
      { type: 'text', text: String(match.title || 'una nueva opción').slice(0, 60) },
    ] }];
    body = `[Plantilla: ${tplName}]`;
    try { result = await meta.sendTemplate(lead.phone, tplName, 'es', comps, ctx); } catch (e) { result = { success: false, error: e.message }; }
  }
  const ok = !!(result && result.success !== false);

  // Registrar el saliente en el chat SOLO si se envió (no ensuciamos el CRM con fallidos).
  if (ok) {
    try {
      await db.query(`INSERT INTO messages (conversation_id, direction, sender_type, type, body, status) VALUES ($1,'outgoing','bot','text',$2,'sent')`, [lead.conversation_id, body]);
    } catch (e) { /* best-effort */ }
  }
  // Log del intento (éxito o fallo) → no repetir el MISMO ítem a este lead (evita loops).
  try {
    await db.query('INSERT INTO lead_nurtures (tenant_id, lead_id, item_kind, item_id, score, channel, mode, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',
      [tenantId, lead.id, match.kind, match.itemId, match.score, 'whatsapp', mode]);
  } catch (e) { /* best-effort */ }
  if (!ok) console.warn(`[nurture] envío falló lead ${lead.id}:`, result && result.error);
  return ok;
}

module.exports = { runNurtureScan };
