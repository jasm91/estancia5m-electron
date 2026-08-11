/**
 * mailer.js — v0.9.572
 * ─────────────────────────────────────────────────────────────────────────────
 * ALERTAS POR EMAIL (Resend). Canal de aviso INDEPENDIENTE del push del navegador
 * y del WhatsApp del propio CRM.
 *
 * Por qué existe: en el incidente del 10-ago-2026 Aitana estuvo muda ~30 min y no
 * llegó ningún aviso. Los dos canales que había dependen de cosas frágiles — el push
 * necesita una suscripción viva del navegador, y el WhatsApp de alerta sale POR EL
 * MISMO CRM que puede estar degradado. El correo no depende de ninguna de las dos:
 * si el CRM tiene salida a internet, el mail sale.
 *
 * Config (Railway, servicio sg-ventas). Los nombres son los MISMOS que ya usa el
 * Inventario (PPS-Ventas → web), así se copian los valores tal cual:
 *   RESEND_API_KEY    re_xxxxxxxx           (mismo nombre que en Inventario)
 *   MAIL_FROM         remitente verificado  (mismo nombre que en Inventario)
 *   ALERT_EMAIL_TO    destino de las alertas (coma-separado para varios)
 * Opcional: ALERT_EMAIL_FROM pisa a MAIL_FROM si querés otro remitente solo para alertas.
 *
 * Sin esas variables el módulo NO hace nada y NADA se rompe: cada llamada devuelve
 * {skipped:'sin config'} y el resto de los canales sigue igual.
 *
 * Anti-spam: cooldown por CLAVE de alerta (def 15 min). Un n8n que parpadea no
 * llena la bandeja: manda uno, y el siguiente recién pasado el cooldown.
 */
const axios = require('axios');

// v0.9.572b — MISMOS NOMBRES QUE EL INVENTARIO (PPS-Ventas → servicio `web`), que ya
// tiene Resend andando con RESEND_API_KEY + MAIL_FROM. Así se copian los valores tal
// cual entre proyectos: acá MAIL_FROM funciona igual, y ALERT_EMAIL_FROM lo pisa si
// alguna vez querés un remitente distinto solo para alertas.
const API_KEY = process.env.RESEND_API_KEY || '';
const TO = String(process.env.ALERT_EMAIL_TO || process.env.MAIL_ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
const FROM = process.env.ALERT_EMAIL_FROM || process.env.MAIL_FROM || '';
const COOLDOWN_MS = Math.max(1, parseInt(process.env.ALERT_EMAIL_COOLDOWN_MIN || '15', 10) || 15) * 60000;

const _lastSent = new Map(); // clave → timestamp

function isConfigured() {
  return !!(API_KEY && TO.length && FROM);
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Plantilla simple, legible en el móvil y sin imágenes (nada que bloquear). */
function _html({ title, detail, severity, footer }) {
  const color = severity === 'ok' ? '#16a34a' : (severity === 'warn' ? '#d97706' : '#dc2626');
  const icon = severity === 'ok' ? '✅' : (severity === 'warn' ? '⚠️' : '🔴');
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
    <div style="background:${color};color:#fff;padding:16px 20px;font-size:17px;font-weight:700;">${icon} ${_esc(title)}</div>
    <div style="padding:20px;font-size:14px;line-height:1.65;white-space:pre-wrap;">${_esc(detail)}</div>
    <div style="padding:14px 20px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
      ${_esc(footer || 'SG Ventas · alerta automática')}
    </div>
  </div></body></html>`;
}

/**
 * Manda una alerta por correo.
 * @param {string} key     clave de dedupe (ej. 'n8n-down'). Mismo key = 1 mail por cooldown.
 * @param {object} opts    { title, detail, severity: 'error'|'warn'|'ok', force }
 */
async function alert(key, { title, detail, severity = 'error', force = false } = {}) {
  if (!isConfigured()) return { skipped: 'sin config' };
  const now = Date.now();
  const last = _lastSent.get(key) || 0;
  if (!force && now - last < COOLDOWN_MS) return { skipped: 'cooldown' };
  _lastSent.set(key, now);
  const stamp = new Date(now - 4 * 3600000).toISOString().replace('T', ' ').slice(0, 16); // hora Bolivia
  try {
    await axios.post('https://api.resend.com/emails', {
      from: FROM,
      to: TO,
      subject: `${severity === 'ok' ? '✅' : '🔴'} SG Ventas — ${title}`,
      html: _html({ title, detail, severity, footer: `SG Ventas · ${stamp} (hora Bolivia) · alerta automática` }),
      text: `${title}\n\n${detail}\n\n${stamp} (hora Bolivia)`,
    }, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 12000,
    });
    console.log(`📧 [mailer] alerta "${key}" enviada a ${TO.join(', ')}`);
    return { ok: true };
  } catch (e) {
    // Si el mail falla NO se rompe nada: el resto de los canales ya salió.
    console.warn('[mailer] envío falló:', e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    _lastSent.delete(key); // permitir reintento en el próximo evento
    return { error: e.message };
  }
}

function status() {
  return { configured: isConfigured(), to: TO, from: FROM || null, cooldownMin: COOLDOWN_MS / 60000 };
}

module.exports = { alert, isConfigured, status };
