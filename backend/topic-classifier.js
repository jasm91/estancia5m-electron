/**
 * topic-classifier.js — v0.9.345
 * AUTO-TOPICS por IA: clasifica conversaciones con actividad reciente en 1-3 temas
 * cortos ("precio", "visita", "financiamiento", "reclamo"…) leyendo los últimos
 * mensajes con Gemini DIRECTO (GEMINI_API_KEY, mismo patrón que el copy de avisos —
 * NO toca n8n ni el hot path del webhook). Corre como cron (30 min) en server.js.
 *
 * - Guarda en conversations.topics (TEXT[]) + topics_updated_at.
 * - Taxonomía semiguiada POR MODO del tenant + etiquetas libres si aparece un tema nuevo.
 * - Solo re-clasifica si hubo mensajes nuevos desde la última pasada.
 * - Batch chico por corrida (20 convs) para mantener el costo de tokens bajo control.
 * - Gate: tenants.ai_enabled (mismo master switch del bot) + GEMINI_API_KEY presente.
 */
// v0.9.354 — modelo Gemini vigente (Google retiró gemini-2.5-flash el 9-jul-2026 con 404 intermitente y gemini-1.5 está muerto). Configurable por env sin redeploy.
const _GEM_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const _GEM_FALLBACK = process.env.GEMINI_MODEL_FALLBACK_BACKEND || 'gemini-flash-latest';

const db = require('./db');
const axios = require('axios');

const BATCH = 20;
const LOOKBACK_DAYS = 7;   // solo conversaciones con actividad en la última semana
const MAX_MSGS = 16;       // últimos N mensajes por conversación para clasificar
let _running = false;

// Taxonomía sugerida por modo (la IA puede crear otras si el tema no calza).
const MODE_TOPICS = {
  inmuebles: 'precio, ubicacion, financiamiento, visita, documentos, alquiler, inversion, caracteristicas',
  articulos: 'precio, stock, envio, garantia, caracteristicas, pago, descuento, devolucion',
  vehiculos: 'precio, financiamiento, estado_vehiculo, papeles, prueba_manejo, permuta',
  servicios: 'precio, disponibilidad, reserva, duracion, ubicacion, profesional',
  restaurante: 'menu, delivery, reserva, precio, horario, promocion',
  software: 'precio, demo, funcionalidades, integraciones, soporte_tecnico, plan',
  soporte: 'reclamo, consulta_uso, facturacion, error_tecnico, estado_pedido, cancelacion',
};

function _modeHint(t, plane) {
  if (plane === 'soporte') return MODE_TOPICS.soporte;
  const hints = [];
  if (t.realestate_bot_enabled) hints.push(MODE_TOPICS.inmuebles);
  if (t.inventory_bot_enabled || t.restaurante_bot_enabled) hints.push(MODE_TOPICS.articulos);
  if (t.vehiculos_bot_enabled) hints.push(MODE_TOPICS.vehiculos);
  if (t.services_bot_enabled || t.salud_bot_enabled || t.belleza_bot_enabled) hints.push(MODE_TOPICS.servicios);
  if (t.restaurante_bot_enabled) hints.push(MODE_TOPICS.restaurante);
  if (!hints.length || t.software_bot_enabled !== false) hints.push(MODE_TOPICS.software);
  return hints.join(', ');
}

async function _classify(transcript, hint) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
  const prompt = `Sos un clasificador de conversaciones comerciales de WhatsApp en Bolivia.
Leé la conversación y devolvé SOLO un JSON (sin markdown): {"topics": ["tema1", "tema2"]}
Reglas:
- 1 a 3 temas que describan QUÉ vino a buscar o consultar el CLIENTE (no lo que respondió el negocio).
- Usá preferentemente estos temas si calzan: ${hint}.
- Si ninguno calza, creá un tema nuevo corto (1-2 palabras, minúsculas, guion_bajo en vez de espacios, sin tildes).
- Nada de temas genéricos tipo "consulta" o "informacion" si hay algo más específico.

CONVERSACIÓN:
${transcript}`;
  try {
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 120, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 25000 });
    const raw = gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const topics = Array.isArray(parsed.topics) ? parsed.topics : [];
    const clean = topics
      .map((t) => String(t).toLowerCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9_ ]/g, '').replace(/\s+/g, '_').slice(0, 30))
      .filter(Boolean).slice(0, 3);
    return clean.length ? clean : null;
  } catch (e) {
    console.warn('[topics] Gemini falló:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

async function runTopicClassifier() {
  if (_running) return { skipped: true };
  // v0.9.360 — el skip por falta de API key ya no es silencioso (hallazgo pruebas MERCALOTES:
  // 0 conversaciones clasificadas en TODOS los tenants y nadie sabía por qué).
  if (!process.env.GEMINI_API_KEY) { console.warn('🏷️  [topics] GEMINI_API_KEY no está configurada en el backend — el clasificador de temas NO corre'); return { skipped: true }; }
  _running = true;
  try {
    // Conversaciones con actividad nueva desde la última clasificación, de tenants con IA activa.
    // v0.9.361 — FIX CRÍTICO: con "SELECT c.id, …, t.*" la columna id de TENANTS pisaba c.id
    // en node-postgres (keys duplicadas: gana la última) → el cron "procesaba" conversaciones
    // cuyos ids eran ids de TENANT: clasificaba siempre las mismas 2-3 convs equivocadas y las
    // reales JAMÁS (topics vacío en todos los tenants desde el v0.9.345). c.id va con alias.
    const convs = (await db.query(`
      SELECT t.*, c.id AS conv_id, c.tenant_id, c.plane AS conv_plane
        FROM conversations c JOIN tenants t ON t.id = c.tenant_id
       WHERE c.last_message_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
         AND COALESCE(t.ai_enabled, TRUE) = TRUE
         AND (c.topics_updated_at IS NULL OR c.last_message_at > c.topics_updated_at)
       ORDER BY c.last_message_at DESC
       LIMIT ${BATCH}`)).rows;
    if (!convs.length) return { classified: 0 };

    let done = 0;
    for (const c of convs) {
      const _cid = c.conv_id; // v0.9.361: id REAL de la conversación (c.id era el del tenant por la colisión)
      const msgs = (await db.query(
        `SELECT direction, body FROM messages
          WHERE conversation_id = $1 AND type = 'text' AND body IS NOT NULL AND body <> ''
          ORDER BY id DESC LIMIT ${MAX_MSGS}`, [_cid])).rows.reverse();
      // Marcar SIEMPRE el intento (aunque no haya texto) para no re-procesar en loop.
      if (msgs.length < 2) {
        await db.query('UPDATE conversations SET topics_updated_at = NOW() WHERE id = $1', [_cid]).catch(() => {});
        continue;
      }
      const transcript = msgs.map((m) => `${m.direction === 'incoming' ? 'CLIENTE' : 'NEGOCIO'}: ${String(m.body).slice(0, 300)}`).join('\n').slice(0, 6000);
      const topics = await _classify(transcript, _modeHint(c, c.conv_plane));
      await db.query(
        'UPDATE conversations SET topics = COALESCE($2, topics), topics_updated_at = NOW() WHERE id = $1',
        [_cid, topics]).catch((e) => console.warn('[topics] update falló:', e.message));
      if (topics) done++;
    }
    if (done) console.log(`🏷️  [topics] ${done}/${convs.length} conversaciones clasificadas`);
    return { classified: done };
  } finally { _running = false; }
}

module.exports = { runTopicClassifier };
