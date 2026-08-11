/**
 * follow-up/follow-up-routes.js — Módulo Follow-up automático v1.0
 * Adaptado para sg-ventas con auth single-tenant (ADMIN_TOKEN + N8N_SHARED_SECRET).
 *
 * tenant_id está hardcoded a 1 (SG Bolivia). Cuando llegue Sprint multi-tenant real,
 * vamos a cambiar el tenant_id por req.tenant.id que vendrá del middleware.
 *
 * Endpoints:
 *
 *   ADMIN (v0.9.24c: requireTenantSession + requireRole owner/supervisor —
 *          acepta X-Admin-Token/?token= de super-admin o Bearer JWT de cliente):
 *     GET    /admin/follow-ups               — Lista follow-ups con filtros
 *     GET    /admin/follow-ups/stats         — Stats agregadas (30d default)
 *     POST   /admin/follow-ups/:id/cancel    — Cancelar follow-up programado
 *     GET    /admin/bot/config/follow-up     — Lee config follow-up
 *     PATCH  /admin/bot/config/follow-up     — Actualiza config follow-up
 *     PATCH  /admin/conversations/:phone/follow-up-toggle — opt-out por conv
 *
 *   N8N BOT (requireN8nSecret: X-CRM-Secret header):
 *     GET    /bot/follow-up/candidates       — Leads que califican para follow-up AHORA
 *     POST   /bot/follow-up/schedule         — Registra un follow-up programado
 *     POST   /bot/follow-up/:id/sent         — Marca como enviado
 *     POST   /bot/follow-up/:id/failed       — Marca como fallido
 *
 * Helper exportado:
 *     markFollowUpResponse({db, tenant_id, conversation_id, message_id})
 *       Lo llama webhook.js cuando llega un mensaje incoming, para marcar si
 *       responde a un follow-up reciente (últimos 7 días).
 */

// v0.9.354 — modelo Gemini vigente (Google retiró gemini-2.5-flash el 9-jul-2026 con 404 intermitente y gemini-1.5 está muerto). Configurable por env sin redeploy.
const _GEM_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const _GEM_FALLBACK = process.env.GEMINI_MODEL_FALLBACK_BACKEND || 'gemini-flash-latest';

const express = require('express');
const db = require('../db');

// v0.9.492 — score mínimo: 0 es un valor VÁLIDO ("perseguir a todos").
// Antes se leía con `cfg.min_score || 70`, y 0 es falsy → se convertía en 70 en
// silencio: el tenant bajaba el slider a 0 y el motor seguía filtrando en 70.
function _minScore(cfg) {
  const v = cfg && cfg.min_score;
  return (v === null || v === undefined || v === '' || Number.isNaN(Number(v))) ? 70 : Math.max(0, Math.min(100, Number(v)));
}
// v0.9.24c: auth multi-tenant real (antes: requireAdminToken local → 401 en
// modo cliente JWT, que el panel interpretaba como sesión vencida y expulsaba).
const { requireTenantSession, requireRole } = require('../auth');
// v0.9.154: el CRON de follow-ups multi-etapa manda PLANTILLAS aprobadas.
const meta = require('../meta');
const { getConversationMetaCtx } = require('../tenant-resolver');

const N8N_SHARED_SECRET = process.env.N8N_SHARED_SECRET;

// v0.9.154 — Etapas por defecto de la secuencia de follow-up multi-etapa.
//
// REGLA DE NEGOCIO (confirmada por el dueño):
//   · Dentro de las 24h del último mensaje DEL CLIENTE → follow-up generado por
//     IA con contexto de la conversación (mode:'ai', texto libre, variado).
//   · Pasadas las 24h → SOLO plantilla aprobada de WhatsApp (lo exige Meta).
//
// Cada etapa: offset_minutes (minutos desde el último mensaje ENTRANTE del
// cliente para quedar "due") + mode ('ai' | 'template'). La de 24h (1440) usa
// 'template' obligatoriamente. template_name=null en una etapa de plantilla →
// la etapa se SALTA y se loguea 'window_expired' (NUNCA se manda algo en blanco
// ni texto libre fuera de las 24h).
const DEFAULT_FOLLOWUP_STAGES = [
  { offset_minutes: 15,   mode: 'ai' },
  { offset_minutes: 60,   mode: 'ai' },
  { offset_minutes: 240,  mode: 'ai' },
  { offset_minutes: 1440, mode: 'template', template_name: null, language: 'es' },
];

// v0.9.154 — Prompt por defecto para el follow-up generado por IA. CONFIGURABLE
// desde el panel (campo ai_prompt del follow_up_config). Pensado para que el
// mensaje retome lo último hablado y NO sea genérico.
const DEFAULT_AI_PROMPT = `Sos Aitana, la asistente de ventas del negocio por WhatsApp. Escribí UN mensaje de seguimiento para un cliente que mostró interés y dejó de responder. Tenés el contexto de la conversación abajo.

Reglas:
- Español boliviano, cálido y cercano, de tú/vos según cómo venía la charla. NADA de sonar a robot ni a plantilla.
- MUY breve (1 a 3 frases, como un WhatsApp real). Sin saludos largos ni firmas.
- Retomá lo ÚLTIMO que se habló o lo que el cliente estaba mirando/preguntando (producto, inmueble, servicio, precio, lo que aplique). Personalizá con su nombre si lo tenés.
- Invitá suavemente a retomar: una pregunta corta, ofrecer ayuda concreta, o proponer agendar/coordinar. Sin presión ni urgencia falsa.
- No inventes datos, precios ni promociones que no estén en el contexto. No repitas textual lo que ya dijiste antes.
- Devolvé SOLO el texto del mensaje, sin comillas, sin explicaciones, sin emojis excesivos (como mucho uno).`;

// Normaliza el array de stages de un config (default si no hay / inválido).
// Garantiza offset_minutes numérico, mode válido ('ai'|'template') y language
// string; preserva el orden de definición como stage_index (0,1,2,...).
function normalizeStages(cfg) {
  const raw = cfg && Array.isArray(cfg.stages) && cfg.stages.length
    ? cfg.stages
    : DEFAULT_FOLLOWUP_STAGES;
  return raw.map((s, i) => ({
    stage_index: i,
    offset_minutes: Number(s && s.offset_minutes) || 0,
    mode: (s && s.mode === 'template') ? 'template' : 'ai',
    template_name: (s && s.template_name) ? String(s.template_name) : null,
    language: (s && s.language) ? String(s.language) : 'es',
  }));
}

const router = express.Router();

// ─── Middlewares (locales, mismos que api.js) ─────────────────────
// v0.9.67 (auditoría 12-jun): comparación en tiempo constante (patrón C-2)
const _fuCrypto = require('crypto');
function requireN8nSecret(req, res, next) {
  const provided = req.headers['x-crm-secret'];
  const h = (s) => _fuCrypto.createHash('sha256').update(String(s)).digest();
  const ok = N8N_SHARED_SECRET && provided &&
    _fuCrypto.timingSafeEqual(h(provided), h(N8N_SHARED_SECRET));
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Los endpoints /bot/* (n8n) siguen single-tenant con fallback al tenant 1;
// los /admin/* usan el tenant de la sesión desde v0.9.24c.
const FALLBACK_TENANT_ID = 1;

// v0.9.24c: tenant efectivo de la request. Cliente JWT → su tenant.
// Super-admin → ?tenant_id= (lo inyecta el panel) o fallback 1.
function resolveTenantId(req) {
  if (req.isSuperAdmin) {
    const q = parseInt(req.query.tenant_id, 10);
    return Number.isInteger(q) && q > 0 ? q : FALLBACK_TENANT_ID;
  }
  return req.tenantId;
}

// ─── Helper: leer config follow_up del bot_global_config ──────────
async function readFollowUpConfig(tenantId = FALLBACK_TENANT_ID) {
  const r = await db.query(`
    SELECT config_value FROM bot_global_config
    WHERE config_key = 'follow_up_config' AND tenant_id = $1
    LIMIT 1
  `, [tenantId]);
  if (r.rows.length === 0) return null;
  try {
    return JSON.parse(r.rows[0].config_value);
  } catch (e) {
    console.error('readFollowUpConfig: JSON parse error', e);
    return null;
  }
}

// =====================================================================
// PANEL ADMIN — endpoints (requieren X-Admin-Token)
// =====================================================================

/**
 * GET /admin/bot/config/follow-up
 * Devuelve el config actual del módulo follow-up
 */
router.get('/admin/bot/config/follow-up', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const config = await readFollowUpConfig(resolveTenantId(req));
    res.json({ follow_up: config || {} });
  } catch (err) {
    console.error('GET /admin/bot/config/follow-up error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /admin/bot/config/follow-up
 * Actualiza el config (1 row JSON serializado en bot_global_config).
 * Body: { enabled, min_score, ... }
 */
router.patch('/admin/bot/config/follow-up', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const cfg = req.body || {};
    if (typeof cfg.enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled debe ser boolean' });
    }
    if (cfg.min_score && (cfg.min_score < 0 || cfg.min_score > 100)) {
      return res.status(400).json({ error: 'min_score debe estar entre 0 y 100' });
    }
    // v0.9.154 — validación liviana de stages (si el panel los manda). Cada
    // etapa: offset_minutes > 0, mode 'ai'|'template'. Las de 'template' fuera de
    // 24h sin template_name se saltarán en runtime (window_expired), no se bloquea
    // el guardado para permitir configurar la plantilla después.
    if (cfg.stages !== undefined) {
      if (!Array.isArray(cfg.stages) || !cfg.stages.length) {
        return res.status(400).json({ error: 'stages debe ser un array con al menos una etapa' });
      }
      for (const s of cfg.stages) {
        if (!s || !(Number(s.offset_minutes) > 0)) {
          return res.status(400).json({ error: 'cada etapa necesita offset_minutes > 0' });
        }
        if (s.mode && s.mode !== 'ai' && s.mode !== 'template') {
          return res.status(400).json({ error: "mode de etapa debe ser 'ai' o 'template'" });
        }
      }
    }

    await db.query(`
      INSERT INTO bot_global_config (config_key, config_value, description, data_type, tenant_id)
      VALUES ('follow_up_config', $1, 'Configuración del módulo Follow-up automático', 'json', $2)
      ON CONFLICT (tenant_id, config_key) DO UPDATE
      SET config_value = EXCLUDED.config_value, updated_at = NOW()
    `, [JSON.stringify(cfg), resolveTenantId(req)]);

    res.json({ success: true, follow_up: cfg });
  } catch (err) {
    console.error('PATCH /admin/bot/config/follow-up error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /admin/follow-ups/run-now — v0.9.195: corre el cron de follow-ups AHORA (para
 * testear sin esperar el tick de 5 min). owner/supervisor. Devuelve {processed, sent}.
 * Respeta TODOS los candados (quiet hours, finde, score, último msg saliente, etc.).
 */
router.post('/admin/follow-ups/run-now', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const result = await runDueFollowUps();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /admin/follow-ups
 * Lista follow-ups con filtros opcionales.
 * Query: ?status=sent&days=30&limit=50
 */
router.get('/admin/follow-ups', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const { status, days = 30, limit = 100 } = req.query;
    let whereExtra = '';
    const params = [resolveTenantId(req), parseInt(days, 10) || 30, parseInt(limit, 10) || 100];

    if (status) {
      whereExtra = 'AND f.status = $4';
      params.push(status);
    }

    const r = await db.query(`
      SELECT
        f.id,
        f.tenant_id,
        f.conversation_id,
        f.status,
        f.message_body,
        f.score_at_send,
        f.vertical_at_send,
        f.scheduled_for,
        f.sent_at,
        f.response_received,
        f.response_at,
        f.error_message,
        f.created_at,
        c.phone,
        c.contact_name,
        c.mode AS conversation_mode
      FROM follow_up_log f
      LEFT JOIN conversations c ON c.id = f.conversation_id
      WHERE f.tenant_id = $1
        AND f.created_at >= NOW() - ($2 || ' days')::interval
        ${whereExtra}
      ORDER BY f.created_at DESC
      LIMIT $3
    `, params);

    res.json({ follow_ups: r.rows, count: r.rows.length });
  } catch (err) {
    console.error('GET /admin/follow-ups error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/follow-ups/stats
 * Estadísticas agregadas de los últimos N días.
 */
router.get('/admin/follow-ups/stats', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    const r = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'sent') AS sent,
        COUNT(*) FILTER (WHERE status = 'sent' AND response_received) AS responses,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
        COUNT(*) FILTER (WHERE status = 'scheduled') AS scheduled
      FROM follow_up_log
      WHERE tenant_id = $1
        AND created_at >= NOW() - ($2 || ' days')::interval
    `, [resolveTenantId(req), days]);

    const row = r.rows[0];
    const sent = parseInt(row.sent, 10) || 0;
    const responses = parseInt(row.responses, 10) || 0;
    const responseRate = sent > 0 ? Math.round((responses / sent) * 1000) / 10 : 0;

    res.json({
      days,
      sent,
      responses,
      response_rate_percent: responseRate,
      failed: parseInt(row.failed, 10) || 0,
      cancelled: parseInt(row.cancelled, 10) || 0,
      scheduled: parseInt(row.scheduled, 10) || 0,
    });
  } catch (err) {
    console.error('GET /admin/follow-ups/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /admin/follow-ups/upcoming — v0.9.319
 * Próximos follow-ups PROGRAMADOS (calculados al vuelo, igual que el cron): por cada
 * conversación candidata devuelve el ETA de la próxima etapa no enviada, para mostrar
 * un contador regresivo en la pestaña de Follow-ups. NO envía nada, solo calcula.
 */
router.get('/admin/follow-ups/upcoming', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = resolveTenantId(req);
  try {
    const cfg = (await readFollowUpConfig(tenantId)) || {};
    const enabled = cfg.enabled === true || cfg.enabled === 'true';
    const stages = normalizeStages(cfg);
    const gate = _followUpTimeGate(cfg);
    if (!enabled) return res.json({ ok: true, enabled: false, quiet: gate, stages, upcoming: [] });
    const cands = await _followUpDueCandidates(tenantId, cfg);
    const upcoming = [];
    for (const c of cands) {
      const sent = await _sentStageIndexes(tenantId, c.conversation_id);
      const pending = stages.filter((st) => !sent.has(st.stage_index));
      if (!pending.length) continue;
      // La próxima a dispararse = la etapa pendiente de MENOR offset (las etapas
      // van en orden creciente y solo se marca 'sent' cuando ya salió).
      const nextStage = pending.reduce((a, b) => (b.offset_minutes < a.offset_minutes ? b : a));
      const lastInbound = new Date(c.last_inbound_at).getTime();
      const nextAt = lastInbound + nextStage.offset_minutes * 60000;
      upcoming.push({
        conversation_id: c.conversation_id,
        phone: c.phone,
        contact_name: c.contact_name || c.phone,
        score: (c.lead_score != null ? c.lead_score : c.current_score) || 0,
        stage_index: nextStage.stage_index,
        stage_mode: nextStage.mode,
        offset_minutes: nextStage.offset_minutes,
        next_at: new Date(nextAt).toISOString(),
        overdue: nextAt <= Date.now(),
      });
    }
    upcoming.sort((a, b) => new Date(a.next_at) - new Date(b.next_at));

    // v0.9.320 — DIAGNÓSTICO: leads que califican por SCORE pero NO entran en cola, con el motivo.
    const _upIds = new Set(upcoming.map((u) => u.conversation_id));
    const blocked = [];
    try {
      const diag = await db.query(`
        SELECT c.id AS conversation_id, c.phone, c.contact_name, c.mode,
               COALESCE(c.stage, 'venta') AS stage, c.follow_up_enabled,
               COALESCE(c.channel, 'whatsapp') AS channel,
               l.score AS lead_score,
               li.last_inbound_at, lm.last_dir,
               EXISTS (SELECT 1 FROM appointments a WHERE a.conversation_id = c.id AND a.status IN ('pending','scheduled') AND (a.starts_at IS NULL OR a.starts_at > NOW())) AS has_appt,
               EXISTS (SELECT 1 FROM campaign_optout o WHERE o.tenant_id = c.tenant_id AND o.phone = c.phone) AS opted_out
          FROM conversations c
          JOIN leads l ON l.conversation_id = c.id AND l.tenant_id = c.tenant_id
          LEFT JOIN LATERAL (SELECT MAX(created_at) AS last_inbound_at FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'incoming') li ON TRUE
          LEFT JOIN LATERAL (SELECT direction AS last_dir FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) lm ON TRUE
         WHERE c.tenant_id = $1 AND c.status = 'open'
           AND l.score >= $2 AND l.status NOT IN ('lost','won','converted')
         ORDER BY l.score DESC LIMIT 50
      `, [tenantId, _minScore(cfg)]);
      for (const d of diag.rows) {
        if (_upIds.has(d.conversation_id)) continue;
        let reason;
        if (d.mode !== 'bot') reason = 'El chat está tomado por un humano (modo manual).';
        else if ((d.stage || 'venta') !== 'venta') reason = 'La conversación está en post-venta/soporte, no en Venta.';
        else if (d.follow_up_enabled === false) reason = 'Follow-up desactivado para este chat.';
        else if ((d.channel || 'whatsapp') !== 'whatsapp') reason = 'No es WhatsApp (Messenger/IG no tienen ventana de 24h).';
        else if (d.has_appt) reason = 'Tiene una visita agendada a futuro — no se lo persigue hasta que pase.';
        else if (d.opted_out) reason = 'El cliente pidió no recibir mensajes (opt-out).';
        else if (!d.last_inbound_at) reason = 'Todavía no hay un mensaje del cliente.';
        else if (d.last_dir !== 'outgoing') reason = 'El cliente escribió último: la secuencia arranca cuando el último mensaje es de Aitana.';
        else reason = 'Debería estar en cola — revisá las etapas.';
        blocked.push({ conversation_id: d.conversation_id, phone: d.phone, contact_name: d.contact_name || d.phone, score: d.lead_score || 0, reason });
      }
    } catch (e) { /* diagnóstico best-effort */ }

    res.json({ ok: true, enabled: true, quiet: gate, stages, upcoming, blocked });
  } catch (e) {
    if (/follow_up_log|bot_global_config|does not exist|relation/.test(e.message)) {
      return res.json({ ok: true, enabled: false, upcoming: [], error: 'sin migrar' });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /admin/follow-ups/:id/cancel
 */
router.post('/admin/follow-ups/:id/cancel', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'id inválido' });

    const r = await db.query(`
      UPDATE follow_up_log
      SET status = 'cancelled', updated_at = NOW(),
          error_message = COALESCE(error_message, 'Cancelado manualmente desde panel')
      WHERE id = $1 AND tenant_id = $2 AND status = 'scheduled'
      RETURNING *
    `, [id, resolveTenantId(req)]);

    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'No encontrado o ya no está scheduled' });
    }
    res.json({ success: true, follow_up: r.rows[0] });
  } catch (err) {
    console.error('POST /admin/follow-ups/:id/cancel error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /admin/conversations/:phone/follow-up-toggle
 * Activa/desactiva follow-up para una conversación específica.
 */
router.patch('/admin/conversations/:phone/follow-up-toggle', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const phone = req.params.phone;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled debe ser boolean' });
    }
    const r = await db.query(`
      UPDATE conversations
      SET follow_up_enabled = $1
      WHERE phone = $2 AND tenant_id = $3
      RETURNING id, phone, follow_up_enabled
    `, [enabled, phone, resolveTenantId(req)]);

    if (r.rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json({ success: true, conversation: r.rows[0] });
  } catch (err) {
    console.error('PATCH /admin/conversations/.../follow-up-toggle error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// BOT N8N — endpoints (requieren X-CRM-Secret)
// =====================================================================

/**
 * GET /bot/follow-up/candidates
 * Devuelve leads que califican para recibir un follow-up AHORA.
 * Filtros aplicados (ver follow_up_config):
 *   - mode='bot' (no se tomó control humano)
 *   - status conv = 'open' y lead status not in ('lost', 'won')
 *   - score >= min_score
 *   - última actividad cliente entre 22-23h atrás (config)
 *   - sin follow-up activo últimos 7 días
 *   - follow_up_enabled = TRUE (override por conversación)
 *   - fuera de quiet hours
 *   - no es fin de semana (si skip_weekends)
 */
router.get('/bot/follow-up/candidates', requireN8nSecret, async (req, res) => {
  try {
    // v0.9.47 (auditoría A-3/F1/F2): MULTI-TENANT. Antes la config y los
    // candidatos eran SIEMPRE del tenant 1 — ningún otro cliente recibía
    // follow-ups. Ahora se recorren todos los tenants con config propia
    // (cada uno con sus quiet hours / score / ventana) y se suman los
    // candidatos de todos. ?tenant_id= opcional para limitar a uno.
    const onlyTenant = req.query.tenant_id ? parseInt(req.query.tenant_id) : null;
    let tenantIds;
    if (onlyTenant) {
      tenantIds = [onlyTenant];
    } else {
      const tr = await db.query(`SELECT DISTINCT tenant_id FROM bot_global_config WHERE config_key = 'follow_up_config'`);
      tenantIds = tr.rows.map(x => x.tenant_id);
      if (!tenantIds.includes(FALLBACK_TENANT_ID)) tenantIds.push(FALLBACK_TENANT_ID);
    }

    const candidates = [];
    const skipped = [];
    for (const tId of tenantIds) {
      const cfg = await readFollowUpConfig(tId);
      if (!cfg || !cfg.enabled) { skipped.push({ tenant_id: tId, reason: 'disabled' }); continue; }

      // Quiet hours / weekend en el timezone DEL tenant
      const tz = cfg.timezone || 'America/La_Paz';
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
      const hour = now.getHours();
      const dayOfWeek = now.getDay(); // 0=domingo, 6=sábado
      if (cfg.skip_weekends && (dayOfWeek === 0 || dayOfWeek === 6)) { skipped.push({ tenant_id: tId, reason: 'weekend' }); continue; }
      const quietStart = parseInt((cfg.quiet_hours_start || '20:00').split(':')[0], 10);
      const quietEnd = parseInt((cfg.quiet_hours_end || '09:00').split(':')[0], 10);
      const inQuietHours = (quietEnd < quietStart)
        ? (hour < quietEnd || hour >= quietStart)
        : (hour >= quietStart && hour < quietEnd);
      if (inQuietHours) { skipped.push({ tenant_id: tId, reason: 'quiet_hours', hour }); continue; }

      const rT = await runCandidatesQuery(tId, cfg);
      candidates.push(...rT.rows);
    }

    return res.json({
      candidates,
      count: candidates.length,
      tenants_checked: tenantIds.length,
      skipped,
    });
  } catch (err) {
    console.error('GET /bot/follow-up/candidates error:', err);
    res.status(500).json({ error: err.message });
  }
});

// v0.9.47: query de candidatos por tenant (extraída del handler).
// Intervalos type-safe ($N * INTERVAL '1 hour') en vez de concatenación.
async function runCandidatesQuery(tenantId, cfg) {
  return db.query(`
      SELECT
        c.id AS conversation_id,
        c.tenant_id,
        c.phone,
        c.contact_name,
        c.last_message_at,
        c.mode,
        l.id AS lead_id,
        l.score,
        l.status AS lead_status,
        l.vertical,
        l.bant,
        l.spin
      FROM conversations c
      JOIN leads l ON l.conversation_id = c.id AND l.tenant_id = c.tenant_id
      WHERE c.tenant_id = $1
        AND c.mode = 'bot'
        AND c.status = 'open'
        AND COALESCE(c.stage, 'venta') = 'venta' -- v0.9.34: post-venta no se persigue
        AND c.follow_up_enabled = TRUE
        -- v0.9.68 (auditoría 12-jun P1#5): quien está en la lista de exclusión
        -- (respondió BAJA/STOP a una campaña) tampoco recibe follow-ups de Aitana
        AND NOT EXISTS (
          SELECT 1 FROM campaign_optout o
          WHERE o.tenant_id = c.tenant_id AND o.phone = c.phone
        )
        AND l.score >= $2
        AND l.status NOT IN ('lost', 'won', 'converted')
        -- v0.9.499: este endpoint (n8n) NO tenía candado de citas. Misma regla que el cron
        -- interno: nunca perseguir a alguien con una visita FUTURA agendada/pendiente.
        AND NOT EXISTS (
          SELECT 1 FROM appointments a
          WHERE a.conversation_id = c.id AND a.status IN ('pending', 'scheduled')
            AND (a.starts_at IS NULL OR a.starts_at > NOW())
        )
        AND c.last_message_at < NOW() - ($3 * INTERVAL '1 hour')
        AND c.last_message_at > NOW() - ($4 * INTERVAL '1 hour')
        AND NOT EXISTS (
          SELECT 1 FROM follow_up_log f
          WHERE f.conversation_id = c.id
            AND f.tenant_id = c.tenant_id
            AND f.created_at > NOW() - INTERVAL '7 days'
            AND f.status IN ('scheduled', 'sent')
        )
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m.conversation_id = c.id
            AND m.direction = 'outgoing'
            AND m.sender_type = 'bot'
            AND m.created_at = (
              SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id
            )
        )
      ORDER BY l.score DESC, c.last_message_at DESC
      LIMIT 50
    `, [
      tenantId,
      _minScore(cfg),
      Number(cfg.window_hours_min) || 22,
      Number(cfg.window_hours_max) || 23,
    ]);
}

/**
 * POST /bot/follow-up/schedule
 * Registra un follow-up programado.
 * Body: { tenant_id, conversation_id, message_body, score_at_send, vertical_at_send }
 */
router.post('/bot/follow-up/schedule', requireN8nSecret, async (req, res) => {
  try {
    const { tenant_id = FALLBACK_TENANT_ID, conversation_id, message_body, score_at_send, vertical_at_send } = req.body;
    if (!conversation_id || !message_body) {
      return res.status(400).json({ error: 'conversation_id y message_body requeridos' });
    }

    const r = await db.query(`
      INSERT INTO follow_up_log (tenant_id, conversation_id, message_body, score_at_send, vertical_at_send, status)
      VALUES ($1, $2, $3, $4, $5, 'scheduled')
      RETURNING *
    `, [tenant_id, conversation_id, message_body, score_at_send, vertical_at_send]);

    res.json({ success: true, follow_up: r.rows[0] });
  } catch (err) {
    console.error('POST /bot/follow-up/schedule error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /bot/follow-up/:id/sent
 * Marca un follow-up como enviado.
 */
router.post('/bot/follow-up/:id/sent', requireN8nSecret, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // v0.9.47 (auditoría F12): si n8n manda tenant_id, se exige el match
    // (IDs secuenciales — evita marcar follow-ups de otro tenant).
    const tId = req.body?.tenant_id ? parseInt(req.body.tenant_id) : null;
    const r = await db.query(`
      UPDATE follow_up_log
      SET status = 'sent', sent_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND ($2::int IS NULL OR tenant_id = $2)
      RETURNING *
    `, [id, tId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ success: true, follow_up: r.rows[0] });
  } catch (err) {
    console.error('POST /bot/follow-up/:id/sent error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /bot/follow-up/:id/failed
 * Marca un follow-up como fallido.
 */
router.post('/bot/follow-up/:id/failed', requireN8nSecret, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { error_message } = req.body || {};
    const r = await db.query(`
      UPDATE follow_up_log
      SET status = 'failed', error_message = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id, error_message || 'Sin detalle']);
    if (r.rows.length === 0) return res.status(404).json({ error: 'No encontrado' });
    res.json({ success: true, follow_up: r.rows[0] });
  } catch (err) {
    console.error('POST /bot/follow-up/:id/failed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Helper exportado (usado por webhook.js)
// =====================================================================

/**
 * markFollowUpResponse({db, tenant_id, conversation_id, message_id})
 *
 * Cuando llega un mensaje incoming, verifica si hay follow-ups recientes
 * (últimos 7 días, status='sent') para esa conversación y los marca como respondidos.
 */
async function markFollowUpResponse({ db: dbInstance, tenant_id, conversation_id, message_id }) {
  try {
    const dbi = dbInstance || db;
    const tid = tenant_id || FALLBACK_TENANT_ID;
    await dbi.query(`
      UPDATE follow_up_log
      SET response_received = TRUE,
          response_at = NOW(),
          response_message_id = $3,
          updated_at = NOW()
      WHERE tenant_id = $1
        AND conversation_id = $2
        AND status = 'sent'
        AND response_received = FALSE
        AND sent_at > NOW() - INTERVAL '7 days'
    `, [tid, conversation_id, message_id]);
  } catch (err) {
    console.error('markFollowUpResponse error:', err);
  }
}

// =====================================================================
// v0.9.154 — CRON de FOLLOW-UPS multi-etapa (backend, sin n8n)
// =====================================================================
//
// runDueFollowUps() corre cada 5 min vía setInterval en server.js. Recorre los
// tenants con follow_up_config.enabled=TRUE, y por cada conversación que dejó
// de responder envía UNA etapa "due" de la secuencia (stages). Dentro de las 24h
// del último mensaje del cliente, el mensaje lo genera Gemini con contexto; fuera
// de las 24h se usa una plantilla aprobada (lo exige Meta).
//
// CANDADOS DE SEGURIDAD (auto-envío a leads reales):
//   (a) config.enabled=false del tenant → no envía nada.
//   (b) etapa AI fuera de la ventana de 24h SIN template_name → NO envía,
//       loguea 'window_expired' (Meta rechaza texto libre fuera de 24h).
//   (c) cada stage_index se manda MÁXIMO una vez por conversación
//       (chequeo follow_up_log por conversation_id + stage_index).
//   (d) si el cliente respondió después de nuestro último follow-up → la
//       secuencia se CORTA (el último mensaje sería 'incoming' → la conversación
//       ni siquiera entra como candidata).
//   (e) respeta quiet hours + skip_weekends (timezone del tenant) +
//       conversations.follow_up_enabled + lista de opt-out de campañas.
//   (f) LIMIT 50 conversaciones por corrida (por tenant).
//   (g) si Gemini falla → NO se manda fallback genérico, se loguea 'failed'
//       y se sigue (no spamear con el mismo texto sin contexto).

const _meta = meta;                  // alias para legibilidad en el cron
const _getConvCtx = getConversationMetaCtx; // ya importado arriba (tenant-resolver)

const FOLLOWUP_RUN_LIMIT = 50;             // candado (f): máx conversaciones por tenant por corrida
const FOLLOWUP_WINDOW_HOURS = 24;          // ventana de Meta para texto libre
const FOLLOWUP_CONTEXT_MSGS = 12;          // últimos N mensajes para contexto IA

// Flag anti-solapamiento: si una corrida tarda más que el intervalo, la
// siguiente no arranca encima.
let _followUpRunning = false;

// ¿Estamos en quiet hours / fin de semana para este tenant? (mismo criterio
// que /bot/follow-up/candidates). Devuelve { skip, reason }.
function _followUpTimeGate(cfg) {
  const tz = cfg.timezone || 'America/La_Paz';
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
  const hour = now.getHours();
  const dayOfWeek = now.getDay(); // 0=domingo, 6=sábado
  if (cfg.skip_weekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
    return { skip: true, reason: 'weekend' };
  }
  const quietStart = parseInt((cfg.quiet_hours_start || '20:00').split(':')[0], 10);
  const quietEnd = parseInt((cfg.quiet_hours_end || '09:00').split(':')[0], 10);
  const inQuiet = (quietEnd < quietStart)
    ? (hour < quietEnd || hour >= quietStart)
    : (hour >= quietStart && hour < quietEnd);
  return inQuiet ? { skip: true, reason: 'quiet_hours' } : { skip: false };
}

// Candidatos del cron: conversaciones cuyo ÚLTIMO mensaje NO es del cliente
// (no respondió a nuestro último saliente), con score alto, follow_up activo,
// y minutos desde el último mensaje ENTRANTE del cliente (last_inbound_min).
// Mantiene los mismos filtros de negocio que runCandidatesQuery (mode='bot',
// abierta, etapa venta, no opt-out, lead no perdido/ganado).
async function _followUpDueCandidates(tenantId, cfg) {
  const r = await db.query(`
    SELECT
      c.id AS conversation_id,
      c.tenant_id,
      c.line_id,
      c.phone,
      c.contact_name,
      c.current_score,
      c.vertical,
      l.score AS lead_score,
      l.vertical AS lead_vertical,
      li.last_inbound_at,
      EXTRACT(EPOCH FROM (NOW() - li.last_inbound_at)) / 60.0 AS last_inbound_min
    FROM conversations c
    JOIN leads l ON l.conversation_id = c.id AND l.tenant_id = c.tenant_id
    JOIN LATERAL (
      SELECT MAX(created_at) AS last_inbound_at
      FROM messages m
      WHERE m.conversation_id = c.id AND m.direction = 'incoming'
    ) li ON TRUE
    WHERE c.tenant_id = $1
      AND c.mode = 'bot'
      AND c.status = 'open'
      AND COALESCE(c.stage, 'venta') = 'venta'
      AND c.follow_up_enabled = TRUE
      -- Solo WhatsApp: el cron manda por sendText/sendTemplate (Cloud API). IG/
      -- Messenger no tienen ventana de 24h ni plantillas → quedan fuera. Además
      -- follow_up_log.phone es NOT NULL (esas conversaciones tienen phone=NULL).
      AND COALESCE(c.channel, 'whatsapp') = 'whatsapp'
      AND c.phone IS NOT NULL
      AND li.last_inbound_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM campaign_optout o
        WHERE o.tenant_id = c.tenant_id AND o.phone = c.phone
      )
      AND l.score >= $2
      AND l.status NOT IN ('lost', 'won', 'converted')
      -- candado (d): el ÚLTIMO mensaje de la conversación NO es del cliente
      -- (si respondió a nuestro follow-up, su mensaje sería el más reciente y
      --  acá quedaría excluida → la secuencia se corta sola).
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.conversation_id = c.id
          AND m.direction = 'outgoing'
          AND m.created_at = (
            SELECT MAX(created_at) FROM messages WHERE conversation_id = c.id
          )
      )
      -- candado (h, v0.9.499): quien tiene una VISITA FUTURA agendada NO se persigue, punto.
      -- La regla vieja (v0.9.324) solo bloqueaba si la cita era MÁS NUEVA que el último
      -- mensaje del cliente ("interés nuevo"). Falla en el caso más común: el cliente marca
      -- la cita y luego escribe "ok gracias" (o el bot le contesta) → la cita queda "vieja"
      -- respecto al último mensaje → el candado la dejaba pasar y le mandaba follow-up a los
      -- pocos minutos a alguien que YA agendó. Un lead con visita pendiente/agendada a futuro
      -- está siendo atendido: perseguirlo es ruido. Cuando la visita pasa (starts_at < NOW),
      -- vuelve a ser elegible (follow-up de post-visita, legítimo).
      AND NOT EXISTS (
        SELECT 1 FROM appointments a
        WHERE a.conversation_id = c.id AND a.status IN ('pending', 'scheduled')
          AND (a.starts_at IS NULL OR a.starts_at > NOW())
      )
    ORDER BY l.score DESC, li.last_inbound_at ASC
    LIMIT $3
  `, [tenantId, _minScore(cfg), FOLLOWUP_RUN_LIMIT]);
  return r.rows;
}

// Trae las stage_index YA enviadas/programadas para una conversación (candado c).
async function _sentStageIndexes(tenantId, conversationId) {
  const r = await db.query(`
    SELECT DISTINCT stage_index FROM follow_up_log
    WHERE tenant_id = $1 AND conversation_id = $2 AND stage_index IS NOT NULL
      AND status IN ('sent', 'scheduled', 'window_expired')
  `, [tenantId, conversationId]);
  return new Set(r.rows.map(x => Number(x.stage_index)));
}

// Construye el texto del follow-up con Gemini usando el ai_prompt + contexto.
// Devuelve { text, usage } o null si falló (candado g: el caller NO manda nada).
async function _generateAiFollowUp(cand, cfg) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { console.warn('[follow-up cron] sin GEMINI_API_KEY → no se genera IA'); return null; }

  // Últimos N mensajes como contexto (mismo formato que el análisis de lost-opps).
  const msgs = await db.query(
    `SELECT direction, sender_type,
            COALESCE(NULLIF(body, ''), NULLIF(media_caption, ''), NULLIF(transcription, ''), '[' || type || ']') AS text
       FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [cand.conversation_id, FOLLOWUP_CONTEXT_MSGS]
  );
  if (!msgs.rows.length) return null;
  const transcript = msgs.rows.reverse().map(m => {
    const who = m.direction === 'incoming' ? 'CLIENTE' : (m.sender_type === 'human' ? 'HUMANO' : 'AITANA');
    return `${who}: ${String(m.text || '').slice(0, 300)}`;
  }).join('\n').slice(0, 6000);

  const systemPrompt = (cfg.ai_prompt && String(cfg.ai_prompt).trim()) || DEFAULT_AI_PROMPT;
  const score = cand.lead_score != null ? cand.lead_score : cand.current_score;
  const vertical = cand.lead_vertical || cand.vertical || 'n/d';
  const nombre = cand.contact_name || 'n/d';
  const userPrompt = `METADATOS DEL LEAD: nombre=${nombre}; score=${score == null ? 'n/d' : score}; vertical=${vertical}.

CONVERSACIÓN RECIENTE (lo más nuevo abajo):
${transcript}

Escribí ahora el mensaje de seguimiento (solo el texto):`;

  const model = cfg.gemini_model || _GEM_MODEL;
  const axios = require('axios');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 350, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

    const text = (gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    if (!text) return null;
    return { text: text.slice(0, 1000), usage: gr.data?.usageMetadata || null, model };
  } catch (e) {
    console.error('[follow-up cron] Gemini falló conv', cand.conversation_id, ':', e.response?.data?.error?.message || e.message);
    return null; // candado (g)
  }
}

// Registra el consumo de tokens del follow-up en ai_usage (best-effort, para billing).
async function _logFollowUpUsage(cand, model, usage) {
  try {
    if (!usage) return;
    const pt = Number(usage.promptTokenCount) || 0;
    const ot = Number(usage.candidatesTokenCount) || 0;
    await db.query(
      `INSERT INTO ai_usage (tenant_id, conversation_id, phone, model, prompt_tokens, output_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cand.tenant_id, cand.conversation_id, cand.phone || null, model, pt, ot, Number(usage.totalTokenCount) || (pt + ot)]
    );
  } catch (uerr) { console.warn('[ai_usage] log follow-up falló (no bloqueante):', uerr.message); }
}

// Inserta una fila en follow_up_log (scheduled_for y phone son NOT NULL).
async function _logFollowUp(cand, stage, { status, messageBody }) {
  await db.query(`
    INSERT INTO follow_up_log
      (tenant_id, conversation_id, phone, scheduled_for, stage_index, message_body,
       score_at_send, vertical_at_send, status, sent_at)
    VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9)
  `, [
    cand.tenant_id,
    cand.conversation_id,
    cand.phone,
    stage.stage_index,
    messageBody,
    cand.lead_score != null ? cand.lead_score : cand.current_score,
    cand.lead_vertical || cand.vertical || null,
    status,
    status === 'sent' ? new Date() : null,
  ]);
}

// Procesa UNA conversación candidata: elige la etapa due de mayor offset aún no
// enviada y la manda (IA o plantilla). Defensivo: cualquier error se loguea y no
// tumba la corrida. Devuelve un string con el resultado (para el resumen).
async function _processFollowUpCandidate(cand, cfg, stages) {
  const lastInboundMin = Number(cand.last_inbound_min) || 0;
  const sent = await _sentStageIndexes(cand.tenant_id, cand.conversation_id);

  // Etapa DUE = la de MAYOR offset tal que ya venció y NO se envió aún (candados c).
  // (Si dos vencieron juntas, mandamos solo la más avanzada → UNA por corrida.)
  let due = null;
  for (const st of stages) {
    if (st.offset_minutes <= 0) continue;
    if (lastInboundMin < st.offset_minutes) continue;     // todavía no vence
    if (sent.has(st.stage_index)) continue;               // candado (c)
    if (!due || st.offset_minutes > due.offset_minutes) due = st;
  }
  if (!due) return null; // nada que mandar para esta conversación

  // ¿Estamos dentro de la ventana de 24h del último mensaje del cliente?
  const withinWindow = lastInboundMin < (FOLLOWUP_WINDOW_HOURS * 60);

  // Ctx Meta (token + número de la línea correcta) — mismo patrón que send-template.
  const ctx = await _getConvCtx({ line_id: cand.line_id, tenant_id: cand.tenant_id });

  // ── Caso 1: dentro de 24h y la etapa es IA → generar con Gemini + sendText.
  if (withinWindow && due.mode === 'ai') {
    const gen = await _generateAiFollowUp(cand, cfg);
    if (!gen) {
      // candado (g): Gemini falló → NO mandar fallback genérico. Logueamos 'failed'
      // (marca la etapa como intentada → no se reintenta hasta el próximo inbound).
      await _logFollowUp(cand, due, { status: 'failed', messageBody: null });
      return `conv ${cand.conversation_id} etapa ${due.stage_index}: failed (gemini)`;
    }
    const res = await _meta.sendText(cand.phone, gen.text, true, ctx);
    await _logFollowUpUsage(cand, gen.model, gen.usage);
    await _logFollowUp(cand, due, { status: res.success ? 'sent' : 'failed', messageBody: gen.text });
    return `conv ${cand.conversation_id} etapa ${due.stage_index}: ${res.success ? 'sent(ai)' : 'failed(send)'}`;
  }

  // ── Caso 2: fuera de 24h (o etapa template) → SOLO plantilla aprobada.
  // candado (b): sin template_name no se manda NADA → window_expired.
  if (!due.template_name) {
    await _logFollowUp(cand, due, { status: 'window_expired', messageBody: null });
    return `conv ${cand.conversation_id} etapa ${due.stage_index}: window_expired (sin plantilla)`;
  }
  const res = await _meta.sendTemplate(cand.phone, due.template_name, due.language || 'es', [], ctx);
  await _logFollowUp(cand, due, {
    status: res.success ? 'sent' : 'failed',
    messageBody: `[Plantilla: ${due.template_name}]`,
  });
  return `conv ${cand.conversation_id} etapa ${due.stage_index}: ${res.success ? 'sent(template)' : 'failed(send)'}`;
}

/**
 * runDueFollowUps() — punto de entrada del cron (lo llama el setInterval de
 * server.js cada 5 min). Recorre los tenants con follow_up_config.enabled y
 * procesa sus conversaciones candidatas. No lanza nunca (defensivo).
 */
async function runDueFollowUps() {
  if (_followUpRunning) {
    console.log('[follow-up cron] corrida anterior aún en curso → salto');
    return { skipped: 'overlap' };
  }
  _followUpRunning = true;
  const startedAt = Date.now();
  let processed = 0, sent = 0, tenantsRun = 0;
  const _fuDbg = process.env.FOLLOWUP_DEBUG === '1' || process.env.FOLLOWUP_DEBUG === 'true';
  try {
    // Tenants con config follow-up (incluye fallback al tenant 1).
    const tr = await db.query(`SELECT DISTINCT tenant_id FROM bot_global_config WHERE config_key = 'follow_up_config'`);
    const tenantIds = tr.rows.map(x => x.tenant_id);
    if (!tenantIds.includes(FALLBACK_TENANT_ID)) tenantIds.push(FALLBACK_TENANT_ID);

    for (const tId of tenantIds) {
      let cfg;
      try { cfg = await readFollowUpConfig(tId); } catch (e) { continue; }
      if (!cfg || !cfg.enabled) continue;          // candado (a)
      const gate = _followUpTimeGate(cfg);          // candado (e): quiet/weekend
      if (gate.skip) { if (_fuDbg) console.log(`[fu-dbg] tenant ${tId} SALTADO por ${gate.reason} (horario de silencio / fin de semana) → no se evalúan follow-ups`); continue; }

      const stages = normalizeStages(cfg);
      let candidates;
      try { candidates = await _followUpDueCandidates(tId, cfg); } // candados (d)(e)(f)
      catch (e) { console.error(`[follow-up cron] candidatos tenant ${tId}:`, e.message); continue; }
      if (_fuDbg) {
        try {
          const _elig = new Set(candidates.map((c) => c.conversation_id));
          const _diag = await db.query(`
            SELECT c.id AS conversation_id, c.phone, c.mode, COALESCE(c.stage,'venta') AS stage,
                   c.follow_up_enabled, COALESCE(c.channel,'whatsapp') AS channel, l.score AS lead_score,
                   li.last_inbound_at, lm.last_dir,
                   EXISTS (SELECT 1 FROM appointments a WHERE a.conversation_id = c.id AND a.status IN ('pending','scheduled') AND (a.starts_at IS NULL OR a.starts_at > NOW())) AS has_appt,
                   EXISTS (SELECT 1 FROM campaign_optout o WHERE o.tenant_id = c.tenant_id AND o.phone = c.phone) AS opted_out
              FROM conversations c
              JOIN leads l ON l.conversation_id = c.id AND l.tenant_id = c.tenant_id
              LEFT JOIN LATERAL (SELECT MAX(created_at) AS last_inbound_at FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'incoming') li ON TRUE
              LEFT JOIN LATERAL (SELECT direction AS last_dir FROM messages m WHERE m.conversation_id = c.id ORDER BY created_at DESC LIMIT 1) lm ON TRUE
             WHERE c.tenant_id = $1 AND c.status = 'open' AND l.score >= $2 AND l.status NOT IN ('lost','won','converted')
             ORDER BY l.score DESC LIMIT 50`, [tId, _minScore(cfg)]);
          console.log(`[fu-dbg] tenant ${tId}: ${candidates.length} candidato(s) elegibles, ${_diag.rows.length} lead(s) con score>=${_minScore(cfg)}`);
          for (const d of _diag.rows) {
            if (_elig.has(d.conversation_id)) continue;
            let why;
            if (d.mode !== 'bot') why = 'chat en modo humano';
            else if ((d.stage || 'venta') !== 'venta') why = 'etapa post-venta/soporte (no venta)';
            else if (d.follow_up_enabled === false) why = 'follow_up_enabled=false en el chat';
            else if ((d.channel || 'whatsapp') !== 'whatsapp') why = 'canal != whatsapp';
            else if (d.has_appt) why = 'tiene una visita agendada a futuro';
            else if (d.opted_out) why = 'opt-out de campanas';
            else if (!d.last_inbound_at) why = 'sin mensaje entrante';
            else if (d.last_dir !== 'outgoing') why = 'el ultimo mensaje es del cliente (aun activo / falta responder)';
            else why = 'elegible pero sin etapa due todavia (revisar offsets/tiempo)';
            console.log(`[fu-dbg]   conv ${d.conversation_id} (${d.phone} score ${d.lead_score}) NO entra: ${why}`);
          }
        } catch (e) { console.warn('[fu-dbg] diag fallo:', e.message); }
      }
      if (!candidates.length) { tenantsRun++; continue; }

      for (const cand of candidates) {
        try {
          const r = await _processFollowUpCandidate(cand, cfg, stages);
          if (r) { processed++; if (/: sent/.test(r)) sent++; }
        } catch (e) {
          // Defensivo por conversación: una falla no corta el resto.
          console.error(`[follow-up cron] conv ${cand.conversation_id} tenant ${tId}:`, e.message);
        }
      }
      tenantsRun++;
    }
    if (processed) {
      console.log(`📤 [follow-up cron] ${sent} enviados / ${processed} procesados en ${tenantsRun} tenant(s) (${Date.now() - startedAt}ms)`);
    }
    return { processed, sent, tenants: tenantsRun };
  } catch (e) {
    console.error('[follow-up cron] runDueFollowUps error:', e.message);
    return { error: e.message };
  } finally {
    _followUpRunning = false;
  }
}

// v0.9.167 — RECORDATORIOS de citas: ~3h antes de cada cita in-house enlazada a una
// conversación, manda un WhatsApp recordándola (reusa meta.sendText + el ctx de la línea).
// Defensivo: marca reminder_sent_at SIEMPRE (1 intento) para no reintentar en loop.
let _remindersRunning = false;
async function runDueReminders() {
  if (_remindersRunning) return { skipped: 'overlap' };
  _remindersRunning = true;
  let sent = 0;
  try {
    const due = await db.query(`
      SELECT a.id, a.starts_at, a.attendee_name, c.phone, c.line_id, c.tenant_id,
             tu.display_name AS seller, COALESCE(tu.tz_offset_min, -240) AS tz
        FROM appointments a
        JOIN conversations c ON c.id = a.conversation_id
        LEFT JOIN tenant_users tu ON tu.id = a.user_id
       WHERE a.provider = 'inhouse' AND a.status = 'scheduled' AND a.reminder_sent_at IS NULL
         AND a.starts_at > NOW() AND a.starts_at <= NOW() + INTERVAL '2 hours'  -- v0.9.186: ~2h antes de la cita
         AND c.phone IS NOT NULL
       ORDER BY a.starts_at ASC LIMIT 50`).catch(() => ({ rows: [] }));
    for (const a of due.rows) {
      try {
        const local = new Date(new Date(a.starts_at).getTime() + (Number(a.tz) || -240) * 60000);
        const hh = String(local.getUTCHours()).padStart(2, '0'), mm = String(local.getUTCMinutes()).padStart(2, '0');
        const firstName = String(a.attendee_name || '').trim().split(/\s+/)[0] || '';
        const msg = `Hola${firstName ? ' ' + firstName : ''} 👋 Te recordamos tu visita${a.seller ? ' con ' + a.seller : ''} hoy a las ${hh}:${mm} hs. Si necesitás reprogramar, escribinos por acá. ¡Te esperamos!`;
        const ctx = await _getConvCtx({ line_id: a.line_id, tenant_id: a.tenant_id });
        const r = await _meta.sendText(a.phone, msg, true, ctx);
        await db.query(`UPDATE appointments SET reminder_sent_at = NOW() WHERE id = $1`, [a.id]);
        if (r && r.success) sent++;
        else console.warn(`[reminder] cita ${a.id}: envío falló (${(r && r.error) || 'sin detalle'})`);
      } catch (e) { console.error(`[reminder] cita ${a.id}:`, e.message); }
    }
    if (sent) console.log(`⏰ [reminders] ${sent} recordatorio(s) de cita enviado(s)`);
    return { sent };
  } catch (e) {
    console.error('[reminders] runDueReminders error:', e.message);
    return { error: e.message };
  } finally {
    _remindersRunning = false;
  }
}

module.exports = router;
module.exports.markFollowUpResponse = markFollowUpResponse;
module.exports.runDueFollowUps = runDueFollowUps; // v0.9.154 — cron en server.js
module.exports.runDueReminders = runDueReminders;  // v0.9.167 — recordatorios de cita
