/**
 * notify-prefs.js (v0.9.192 · v0.9.325 template por evento + regla 24h)
 * Preferencias de notificación por tenant: qué ROLES reciben cada evento por push,
 * si el evento va también por WhatsApp (al alert_phone de la org), y qué PLANTILLA
 * aprobada usar cuando el destinatario está fuera de la ventana de 24h de Meta.
 * Tabla: notification_prefs (tenant_id PK, prefs JSONB).
 *
 * Lo usan api.js (hot_lead, call_request, pending_appointment + endpoints) y
 * webhook.js (vip_message, new_message_assigned). Mantener SIN dependencias pesadas.
 */
const db = require('./db');

const EVENTS = ['hot_lead', 'call_request', 'vip_message', 'pending_appointment', 'appointment_assigned', 'new_message_assigned', 'sale_completed']; // v0.9.546 — venta del bot (modo artículos)
const TEAM_EVENTS = new Set(['hot_lead', 'call_request', 'vip_message', 'pending_appointment']); // soportan WhatsApp
const ASSIGNEE_EVENTS = new Set(['appointment_assigned', 'new_message_assigned']);
const PERLINE_EVENTS = new Set(['hot_lead', 'call_request', 'vip_message', 'pending_appointment']); // todos tienen override por línea (v0.9.336)

// Defaults sensatos (si el tenant nunca configuró nada). `template` = plantilla WA aprobada
// para cuando el destinatario del aviso está fuera de las 24h (Meta no deja texto libre).
const DEFAULTS = {
  hot_lead:             { push_roles: ['owner', 'supervisor'],          whatsapp: true,  template: 'nuevo_lead_calificado', phone: '', lines: {} },
  call_request:         { push_roles: ['owner', 'supervisor'],          whatsapp: true,  template: 'solicitud_llamada', phone: '', lines: {} },
  vip_message:          { push_roles: ['owner', 'supervisor', 'agent'], whatsapp: true,  template: 'cliente_vip', phone: '', lines: {} },
  pending_appointment:  { push_roles: ['owner', 'supervisor', 'agent'], whatsapp: false, template: 'cita_por_tomar', phone: '', lines: {} },
  appointment_assigned: { push_roles: ['owner', 'supervisor', 'agent'], whatsapp: false },
  new_message_assigned: { push_roles: ['agent', 'supervisor'],          whatsapp: false },
  // v0.9.546 — VENTA REALIZADA (modo artículos): Aitana registró una venta/pedido → push con el
  // resumen a TODO el equipo con la app para coordinar el envío. Solo visible con artículos activo.
  sale_completed:       { push_roles: ['owner', 'supervisor', 'agent'], whatsapp: false },
};

const VALID_ROLES = ['owner', 'supervisor', 'agent'];

function _tpl(v) { return (typeof v === 'string' && v.trim()) ? v.trim().replace(/[^a-z0-9_]/gi, '').slice(0, 120) : ''; }

// Overrides POR LÍNEA (call_request, vip_message): roles, WhatsApp, número y plantilla propios.
function _cleanLines(lines) {
  const out = {};
  if (lines && typeof lines === 'object') {
    for (const k of Object.keys(lines)) {
      const v = lines[k] || {};
      const entry = {};
      if (Array.isArray(v.push_roles)) entry.push_roles = [...new Set(v.push_roles.filter((r) => VALID_ROLES.includes(r)))];
      if (typeof v.whatsapp === 'boolean') entry.whatsapp = v.whatsapp;
      if (typeof v.phone === 'string' && v.phone.trim()) entry.phone = v.phone.trim().replace(/[^0-9+]/g, '');
      if (typeof v.template === 'string' && v.template.trim()) entry.template = _tpl(v.template);
      if (Object.keys(entry).length) out[String(k)] = entry;
    }
  }
  return out;
}

function _resolvePerLine(base, lineId) {
  const lc = (lineId != null && base.lines && base.lines[String(lineId)]) ? base.lines[String(lineId)] : {};
  return {
    push_roles: Array.isArray(lc.push_roles) ? lc.push_roles : (base.push_roles || []),
    whatsapp: typeof lc.whatsapp === 'boolean' ? lc.whatsapp : !!base.whatsapp,
    phone: (lc.phone && lc.phone.trim()) ? lc.phone.trim() : (base.phone || ''),
    template: (lc.template && lc.template.trim()) ? lc.template.trim() : (base.template || ''),
  };
}

/** Config EFECTIVA de call_request para una línea (override de línea sobre el default del evento). */
function resolveCallRequest(prefs, lineId) {
  return _resolvePerLine((prefs && prefs.call_request) || DEFAULTS.call_request, lineId);
}
/** Config EFECTIVA de vip_message para una línea. */
function resolveVipMessage(prefs, lineId) {
  return _resolvePerLine((prefs && prefs.vip_message) || DEFAULTS.vip_message, lineId);
}
/** Config EFECTIVA de hot_lead para una línea. */
function resolveHotLead(prefs, lineId) {
  return _resolvePerLine((prefs && prefs.hot_lead) || DEFAULTS.hot_lead, lineId);
}
/** Config EFECTIVA de pending_appointment para una línea. */
function resolvePendingAppointment(prefs, lineId) {
  return _resolvePerLine((prefs && prefs.pending_appointment) || DEFAULTS.pending_appointment, lineId);
}

/** Devuelve las prefs del tenant ya fusionadas con los defaults (todos los eventos presentes). */
async function getNotifPrefs(tenantId) {
  let stored = {};
  try {
    const r = await db.query('SELECT prefs FROM notification_prefs WHERE tenant_id = $1', [tenantId]);
    stored = (r.rows[0] && r.rows[0].prefs) || {};
    if (typeof stored === 'string') { try { stored = JSON.parse(stored); } catch (e) { stored = {}; } }
  } catch (e) { /* tabla aún no migrada → defaults */ }
  const out = {};
  for (const ev of EVENTS) {
    const d = DEFAULTS[ev];
    const s = (stored && stored[ev]) || {};
    out[ev] = {
      push_roles: Array.isArray(s.push_roles) ? s.push_roles.filter(r => VALID_ROLES.includes(r)) : d.push_roles.slice(),
      whatsapp: typeof s.whatsapp === 'boolean' ? s.whatsapp : d.whatsapp,
    };
    if (TEAM_EVENTS.has(ev)) {
      out[ev].template = (typeof s.template === 'string' && s.template.trim()) ? _tpl(s.template) : (d.template || '');
    }
    if (PERLINE_EVENTS.has(ev)) {
      out[ev].phone = (typeof s.phone === 'string') ? s.phone.trim() : '';
      out[ev].lines = _cleanLines(s.lines);
    }
  }
  return out;
}

/** Sanitiza un objeto de prefs entrante (del panel) antes de guardarlo. */
function sanitizePrefs(input) {
  const clean = {};
  for (const ev of EVENTS) {
    const s = (input && input[ev]) || {};
    const roles = Array.isArray(s.push_roles) ? [...new Set(s.push_roles.filter(r => VALID_ROLES.includes(r)))] : DEFAULTS[ev].push_roles.slice();
    const whatsapp = TEAM_EVENTS.has(ev) ? (typeof s.whatsapp === 'boolean' ? s.whatsapp : DEFAULTS[ev].whatsapp) : false;
    clean[ev] = { push_roles: roles, whatsapp };
    if (TEAM_EVENTS.has(ev)) {
      clean[ev].template = (typeof s.template === 'string' && s.template.trim()) ? _tpl(s.template) : (DEFAULTS[ev].template || '');
    }
    if (PERLINE_EVENTS.has(ev)) {
      clean[ev].phone = (typeof s.phone === 'string') ? s.phone.trim().replace(/[^0-9+]/g, '') : '';
      clean[ev].lines = _cleanLines(s.lines);
    }
  }
  return clean;
}

/**
 * v0.9.325 — ¿el DESTINATARIO del aviso (un número del equipo) está DENTRO de la ventana
 * de 24h de Meta? (mandó un inbound al negocio hace <24h). Si sí → se puede texto libre;
 * si no (o no tiene conversación) → hay que usar plantilla aprobada. Defensivo: ante
 * cualquier error devuelve FALSE (fuerza plantilla, que es lo seguro).
 */
async function recipientWithin24h(tenantId, recipientPhone) {
  const digits = String(recipientPhone || '').replace(/[^0-9]/g, '');
  if (!digits) return false;
  try {
    const r = await db.query(
      `SELECT 1 FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.tenant_id = $1
          AND regexp_replace(c.phone, '[^0-9]', '', 'g') = $2
          AND m.direction = 'incoming'
          AND m.created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [tenantId, digits]);
    return r.rows.length > 0;
  } catch (e) { return false; }
}

module.exports = { EVENTS, TEAM_EVENTS, ASSIGNEE_EVENTS, PERLINE_EVENTS, DEFAULTS, VALID_ROLES, getNotifPrefs, sanitizePrefs, resolveCallRequest, resolveVipMessage, resolveHotLead, resolvePendingAppointment, recipientWithin24h };
