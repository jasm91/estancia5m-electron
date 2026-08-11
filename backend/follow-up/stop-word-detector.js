/**
 * stop-word-detector.js — Módulo Follow-up automático v1.0
 *
 * Detecta cuando un cliente expresa que NO quiere recibir más mensajes.
 * Cuando se detecta, desactiva follow_up_enabled para esa conversación
 * (override permanente hasta que vos lo reactives manualmente).
 *
 * Uso:
 *   const { handleStopWords } = require('./stop-word-detector');
 *
 *   // En el webhook handler de Meta, después de guardar el mensaje entrante:
 *   if (msg.direction === 'incoming') {
 *     await handleStopWords({
 *       db,
 *       tenant_id: conversation.tenant_id,
 *       conversation_id: conversation.id,
 *       phone: conversation.phone,
 *       body: msg.body || ''
 *     });
 *   }
 *
 * Diseño:
 * - Lista de patrones regex en español (variantes castellano boliviano)
 * - Matching case-insensitive, con normalización de acentos
 * - Si match → UPDATE follow_up_enabled=FALSE + cancelar follow-ups scheduled
 * - Log a stdout para que veas en Railway qué se detectó y cuándo
 *
 * No es perfecto (un cliente diciendo "no me digas que basta" daría falso positivo)
 * pero el costo de un falso positivo es bajo (cliente no recibe follow-up,
 * pero la conversación principal sigue normal). Es mejor pecar de prudente.
 */

// Patrones que indican "no me escriban más"
// Cada patrón es una regex. Se evalúa contra el body normalizado.
const STOP_PATTERNS = [
  // Variantes directas
  /\bno (me|nos) (escriban?|escriba|escribas|hablen?|habla|hables|moleste(n|s)?|moleste|joda(n|s)?|jodan?|llame(n|s)?|llame|contacte(n|s)?|contacten?)\b/i,
  /\bd[ée]jen(me|nos)?\s+(en\s+paz|tranquilo|tranquila|tranquilos?)/i,
  /\bd[ée]ja(me|nos)?\s+(en\s+paz|tranquilo|tranquila|tranquilos?)/i,
  /\bbasta\b/i,  // "basta" solo ya es suficiente
  /\b(no\s+)?(me\s+)?(interesa|interesan)\s+(nada|ya|m[áa]s|para nada)/i,
  /\b(borrame|borranme|elim[ií]name|elim[ií]nenme|sacame|s[áa]quenme)\s+(de|del)\s+(la\s+)?(lista|sus|tus|su|base|datos)/i,
  /\bunsubscribe\b/i,
  /\bspam\b/i,
  /\b(stop|para|alto|paren|parar)\s+(de\s+)?(escribir|enviar|mandar|molestar)/i,
  /^stop$/i,  // "STOP" solo
  // v0.9.68 (auditoría 12-jun P1#5): variantes de BAJA — son las mismas que el
  // opt-out de campañas detecta, pero acá además apagan los follow-ups de Aitana.
  /^baja$/i,                                  // "BAJA" solo
  /\b(dar(me)?|quiero|solicito)\s+(de\s+)?baja\b/i,
  /\bbaja\s+(de\s+)?(la\s+)?(lista|suscripci[oó]n)\b/i,
  /\bcancelar\s+(suscripci[oó]n|mensajes|env[ií]os)\b/i,
  /\bno\s+molestar\b/i,

  // Variantes con desinterés explícito
  /\bya no (me )?(interesa|estoy\s+interesad[oa]|quiero|necesito)/i,
  /\bno\s+(quiero|deseo)\s+(m[áa]s|recibir|seguir|continuar)/i,

  // Quejas / molestia explícita
  /\bd[ée]jenme\s+en\s+paz/i,
  /\bno (vuelvan?|vuelvas)\s+a\s+escribir/i,
  /\bya\s+(les\s+)?dije\s+que\s+no/i,
];

/**
 * Normaliza el texto para matching:
 * - lowercase
 * - quita acentos
 * - colapsa espacios
 */
function normalize(text) {
  if (!text) return '';
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detecta si el body matchea algún patrón de stop.
 * @returns {string|null} El patrón que matchea, o null si no.
 */
function detectStopWord(body) {
  if (!body || typeof body !== 'string') return null;
  const normalized = normalize(body);

  // Mensaje muy corto puede ser stop directo
  if (normalized.length < 100) {
    for (const pattern of STOP_PATTERNS) {
      if (pattern.test(normalized)) {
        return pattern.source;
      }
    }
  } else {
    // Mensaje largo: solo matcheamos los patrones más fuertes
    // para evitar falsos positivos (ej: cliente largando un párrafo
    // donde menciona "no me molesta" en otro contexto)
    const strongPatterns = STOP_PATTERNS.slice(0, 4); // las 4 más explícitas
    for (const pattern of strongPatterns) {
      if (pattern.test(normalized)) {
        return pattern.source;
      }
    }
  }
  return null;
}

/**
 * Procesa un mensaje entrante. Si detecta stop word:
 *   1. Setea conversations.follow_up_enabled = FALSE
 *   2. Cancela cualquier follow-up programado para esa conversación
 *   3. Loguea a stdout
 *
 * Retorna { detected: boolean, pattern: string|null }
 */
async function handleStopWords({ db, tenant_id, conversation_id, phone, body }) {
  try {
    const pattern = detectStopWord(body);
    if (!pattern) return { detected: false, pattern: null };

    console.log(`🛑 STOP-WORD detectado | tenant=${tenant_id} | phone=${phone} | pattern="${pattern}" | body="${(body || '').slice(0, 100)}"`);

    // 1. Desactivar follow-up para esta conversación
    await db.query(`
      UPDATE conversations
      SET follow_up_enabled = FALSE
      WHERE id = $1 AND tenant_id = $2
    `, [conversation_id, tenant_id]);

    // 2. Cancelar follow-ups scheduled (si hubiera)
    await db.query(`
      UPDATE follow_up_log
      SET status = 'cancelled',
          error_message = 'Cancelado: cliente expresó stop word',
          updated_at = NOW()
      WHERE conversation_id = $1
        AND tenant_id = $2
        AND status = 'scheduled'
    `, [conversation_id, tenant_id]);

    return { detected: true, pattern };
  } catch (err) {
    console.error('handleStopWords error:', err);
    return { detected: false, pattern: null, error: err.message };
  }
}

module.exports = {
  detectStopWord,
  handleStopWords,
  normalize,
  STOP_PATTERNS, // exportado para tests
};
