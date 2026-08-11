/**
 * v0.9.394 — Notas de voz AUTOMÁTICAS de Aitana.
 *
 * Decide si un mensaje del bot sale como AUDIO (nota de voz ElevenLabs) según la
 * config de momentos del tenant (voice_notes_config): greeting / ficha / appointment /
 * reactivation. Lo llama el hot-path del bot en los 4 puntos de envío.
 *
 * REGLA DE ORO: todo es best-effort. Ante CUALQUIER duda o error, devuelve {sent:false}
 * y el que llama manda TEXTO como siempre. Nunca lanza. Nunca bloquea la respuesta.
 *
 * Requiere en el entorno: ELEVENLABS_API_KEY (secreto). La voz sale de la config
 * (voz por línea → voz por defecto del tenant → ELEVEN_VOICE_ID del entorno).
 */
const db = require('./db');

function _cfg(row) {
  const c = (row && row.voice_notes_config) || {};
  return {
    enabled: !!c.enabled,
    greeting: !!c.greeting,
    ficha: !!c.ficha,
    appointment: !!c.appointment,
    reactivation: !!c.reactivation,
    ai_decides: !!c.ai_decides,
    default_voice_id: c.default_voice_id || null,
    model: c.model || null,
  };
}

// voz efectiva: por línea → por defecto del tenant → env.
async function _resolveVoice(tenantId, lineId, cfg) {
  let voiceId = cfg.default_voice_id || null;
  let model = cfg.model || null;
  try {
    if (lineId) {
      const lr = await db.query('SELECT voice_id FROM tenant_lines WHERE id = $1 AND tenant_id = $2', [lineId, tenantId]);
      if (lr.rows[0] && lr.rows[0].voice_id) voiceId = lr.rows[0].voice_id;
    }
  } catch (e) { /* tabla sin migrar → usa default/env */ }
  voiceId = voiceId || process.env.ELEVEN_VOICE_ID || null;
  return { voiceId, model };
}

/**
 * Manda `text` como nota de voz si el momento está habilitado. Best-effort.
 * @param {string} moment  'greeting' | 'ficha' | 'appointment' | 'reactivation'
 * @param {object} opts    { tenantId, conversationId, lineId, phone, text, ctx, firstOnly, recordMessage }
 * @returns {Promise<{sent:boolean, wa_message_id?:string}>}
 */
async function sendVoiceMoment(moment, opts = {}) {
  try {
    if (!process.env.ELEVENLABS_API_KEY) return { sent: false };
    const text = opts.text ? String(opts.text).trim() : '';
    if (!text) return { sent: false };
    const tenantId = opts.tenantId;
    if (!tenantId || !opts.phone) return { sent: false };

    const tr = await db.query('SELECT voice_notes_config FROM tenants WHERE id = $1', [tenantId]).catch(() => ({ rows: [] }));
    const cfg = _cfg(tr.rows[0]);
    if (!cfg.enabled || !cfg[moment]) return { sent: false };

    // Saludo: SOLO el primer mensaje saliente de la conversación.
    if (opts.firstOnly && opts.conversationId) {
      const c = await db.query(
        `SELECT COUNT(*)::int AS n FROM messages WHERE conversation_id = $1 AND direction = 'outgoing'`,
        [opts.conversationId]).catch(() => ({ rows: [{ n: 1 }] }));
      if (c.rows[0] && c.rows[0].n > 0) return { sent: false };
    }

    const { voiceId, model } = await _resolveVoice(tenantId, opts.lineId || null, cfg);
    if (!voiceId) return { sent: false };

    const meta = require('./meta');
    const r = await meta.sendVoiceNote(opts.phone, text, opts.ctx || null, { voiceId, model: model || undefined });
    if (!r || !r.success) return { sent: false };

    // Consumo (billing ElevenLabs) — kind 'auto' (los disparadores) vs 'test' (el botón).
    try { await db.query('INSERT INTO voice_usage (tenant_id, chars, kind) VALUES ($1, $2, $3)', [tenantId, text.length, 'auto']); } catch (e) {}

    // Registrar el saliente en el chat (para que se vea en el panel), salvo que el caller lo haga.
    if (opts.recordMessage !== false && opts.conversationId) {
      try {
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status)
           VALUES ($1, $2, 'outgoing', 'bot', 'audio', $3, 'sent')`,
          [opts.conversationId, r.wa_message_id, text]);
      } catch (e) { /* best-effort */ }
    }
    return { sent: true, wa_message_id: r.wa_message_id };
  } catch (e) {
    console.warn('[voice-moment]', moment, e && e.message);
    return { sent: false };
  }
}

module.exports = { sendVoiceMoment };
