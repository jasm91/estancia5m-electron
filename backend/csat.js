/**
 * csat.js — v0.9.331
 * Encuesta de satisfacción (CSAT) para modo BPO/Soporte.
 * Envía la encuesta con BOTONES interactivos cuando un ticket queda 'resolved',
 * dentro de la ventana de 24h; fuera de 24h usa una plantilla aprobada (si está
 * configurada). Marca csat_sent_at para no reenviar y respeta un enfriamiento por
 * conversación. La CAPTURA del puntaje/comentario vive en webhook.js.
 */
const db = require('./db');
const meta = require('./meta');

// 😀=5, 😐=3, 😞=1 → se guardan en support_tickets.csat (1-5), compatible con los analytics ya existentes.
const CSAT_BUTTONS = [
  { id: 'csat:5', title: '😀 Buena' },
  { id: 'csat:3', title: '😐 Regular' },
  { id: 'csat:1', title: '😞 Mala' },
];
const DEFAULT_QUESTION = '¿Cómo estuvo la atención que recibiste? 🙏';

function _ctxFor(conv) {
  try {
    const { getConversationMetaCtx } = require('./tenant-resolver');
    return getConversationMetaCtx(conv);
  } catch (e) { return Promise.resolve(null); }
}

async function _within24h(conversationId) {
  try {
    const r = await db.query(
      `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'incoming'
         AND created_at > NOW() - interval '24 hours' LIMIT 1`,
      [conversationId]
    );
    return r.rows.length > 0;
  } catch (e) { return false; }
}

async function _markSent(ticketId) {
  try { await db.query('UPDATE support_tickets SET csat_sent_at = NOW() WHERE id = $1', [ticketId]); } catch (e) {}
}

// Cron: barre tickets recién resueltos (BPO) sin encuesta enviada y la manda. Best-effort.
async function runCsatSweep() {
  let tenants;
  try {
    tenants = await db.query(
      `SELECT id,
              NULLIF(TRIM(COALESCE(csat_question,'')),'')  AS question,
              NULLIF(TRIM(COALESCE(csat_template,'')),'')  AS template,
              COALESCE(csat_cooldown_days, 7)              AS cooldown
         FROM tenants
        WHERE COALESCE(csat_enabled, FALSE) = TRUE
          AND COALESCE(support_enabled, FALSE) = TRUE`
    );
  } catch (e) {
    if (/csat_enabled|csat_question|csat_cooldown|csat_template/.test(e.message)) return { skipped: 'not_migrated' };
    throw e;
  }
  let sentTotal = 0;
  for (const t of tenants.rows) {
    let rows;
    try {
      rows = await db.query(
        `SELECT st.id, st.conversation_id
           FROM support_tickets st
          WHERE st.tenant_id = $1 AND st.status = 'resolved'
            AND st.csat IS NULL AND st.csat_sent_at IS NULL
            AND st.resolved_at IS NOT NULL AND st.resolved_at > NOW() - interval '6 hours'
            AND NOT EXISTS (
              SELECT 1 FROM support_tickets s2
               WHERE s2.conversation_id = st.conversation_id
                 AND s2.csat_sent_at IS NOT NULL
                 AND s2.csat_sent_at > NOW() - make_interval(days => $2::int))
          ORDER BY st.resolved_at ASC
          LIMIT 30`,
        [t.id, t.cooldown]
      );
    } catch (e) { continue; }
    for (const row of rows.rows) {
      try {
        const cr = await db.query('SELECT * FROM conversations WHERE id = $1', [row.conversation_id]);
        const conv = cr.rows[0];
        if (!conv || !conv.phone) { await _markSent(row.id); continue; }
        const ctx = await _ctxFor(conv);
        const inWindow = await _within24h(row.conversation_id);
        let _sentBody = null;
        if (inWindow) {
          await meta.sendInteractiveButtons(conv.phone, t.question || DEFAULT_QUESTION, CSAT_BUTTONS, ctx);
          _sentBody = (t.question || DEFAULT_QUESTION) + '  [😀 Buena | 😐 Regular | 😞 Mala]';
          sentTotal++;
        } else if (t.template) {
          await meta.sendTemplate(conv.phone, t.template, 'es', [], ctx);
          _sentBody = `[plantilla: ${t.template}]`;
          sentTotal++;
        }
        // v0.9.363 — registrar la encuesta en el hilo (antes las respuestas "😀 Buena"
        // aparecían en el panel sin la pregunta → el supervisor no veía qué se envió).
        if (_sentBody) {
          try {
            // mismo shape que los demás INSERT del backend; tenant_id lo pone el trigger v0.9.199.
            await db.query(
              `INSERT INTO messages (conversation_id, direction, sender_type, type, body, status)
               VALUES ($1, 'outgoing', 'bot', 'interactive', $2, 'sent')`,
              [row.conversation_id, _sentBody]
            );
          } catch (e) { /* best-effort: si messages cambia de shape, la encuesta igual salió */ }
        }
        // marcar procesado (enviado, o salteado por >24h sin plantilla) para no reintentar en cada barrido
        await _markSent(row.id);
      } catch (e) {
        console.warn(`[csat] tenant ${t.id} ticket ${row.id} fallo:`, e.message);
        await _markSent(row.id);
      }
    }
  }
  if (sentTotal) console.log(`🙂 [csat] ${sentTotal} encuesta(s) de satisfaccion enviada(s)`);
  return { sent: sentTotal };
}

module.exports = { runCsatSweep, CSAT_BUTTONS, DEFAULT_QUESTION };
