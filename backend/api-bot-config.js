/**
 * Bot Configuration API v0.4.0
 *
 * Endpoints CRUD para que la consola edite la configuración de Aitana.
 * Todos los endpoints requieren admin token (X-Admin-Token o ?token=).
 *
 * Estructura:
 *   GET    /api/admin/bot/config                — devuelve toda la config (verticales + planes + proofs + global + prompt base)
 *   GET    /api/admin/bot/system-prompt         — preview del prompt final con todo armado
 *   PATCH  /api/admin/bot/global/:key           — actualiza un valor de bot_global_config
 *   PATCH  /api/admin/bot/prompt-base           — actualiza el prompt base
 *
 *   Verticales:
 *   GET    /api/admin/bot/verticals             — listar
 *   POST   /api/admin/bot/verticals             — crear
 *   PATCH  /api/admin/bot/verticals/:id         — actualizar
 *   DELETE /api/admin/bot/verticals/:id         — desactivar (soft delete)
 *
 *   Planes:
 *   GET    /api/admin/bot/plans                 — listar
 *   POST   /api/admin/bot/plans                 — crear
 *   PATCH  /api/admin/bot/plans/:id             — actualizar
 *   DELETE /api/admin/bot/plans/:id             — desactivar
 *
 *   Proof points:
 *   GET    /api/admin/bot/proof-points          — listar
 *   POST   /api/admin/bot/proof-points          — crear
 *   PATCH  /api/admin/bot/proof-points/:id      — actualizar
 *   DELETE /api/admin/bot/proof-points/:id      — desactivar
 *
 *   Histórico:
 *   GET    /api/admin/bot/history               — listar snapshots
 *   POST   /api/admin/bot/history/:id/restore   — restaurar a una versión anterior
 *
 *   Test:
 *   POST   /api/admin/bot/test-message          — simula respuesta de Aitana sin afectar conversaciones reales
 *
 * Endpoint público para n8n:
 *   GET    /api/bot/system-prompt               — devuelve el prompt armado (con CRM_SECRET, NO admin token)
 */

// v0.9.354 — modelo Gemini vigente (Google retiró gemini-2.5-flash el 9-jul-2026 con 404 intermitente y gemini-1.5 está muerto). Configurable por env sin redeploy.
const _GEM_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const _GEM_FALLBACK = process.env.GEMINI_MODEL_FALLBACK_BACKEND || 'gemini-flash-latest';

const express = require('express');
const router = express.Router();
const db = require('./db');
const promptBuilder = require('./bot-prompt-builder');
const { resolveTenantByPhone } = require('./tenant-resolver'); // v0.9.7 multi-tenant
const { requireTenantSession } = require('./auth'); // v0.9.8: sesión de cliente o super-admin

// v0.9.67 (auditoría 12-jun): comparación en tiempo constante (patrón C-2)
const _crypto = require('crypto');
function _tse(a, b) {
  if (!a || !b) return false;
  const h = (s) => _crypto.createHash('sha256').update(String(s)).digest();
  return _crypto.timingSafeEqual(h(a), h(b));
}

// Middleware para admin token (igual que en api.js)
function requireAdminToken(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!_tse(token, process.env.ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Middleware para n8n shared secret
function requireN8nSecret(req, res, next) {
  const secret = req.headers['x-crm-secret'];
  if (!_tse(secret, process.env.N8N_SHARED_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// v0.9.7/v0.9.8: resuelve sobre qué tenant operan los endpoints de config.
// SEGURIDAD:
//  - Cliente (JWT): SIEMPRE su propio tenant (req.tenantId). Ignora cualquier
//    tenant_id que mande en query/body → no puede tocar la config de otro.
//  - Super-admin (ADMIN_TOKEN): puede pasar ?tenant_id=N para editar cualquier
//    tenant (comportamiento legacy). Sin tenant_id → default 1 (SG Bolivia).
function getConfigTenant(req) {
  // Cliente autenticado por sesión → forzar su tenant
  if (req.isSuperAdmin === false && req.tenantId) {
    return Number(req.tenantId);
  }
  // Super-admin (o legacy sin flag) → tenant_id explícito o default 1
  const fromQuery = req.query.tenant_id || req.body?.tenant_id;
  const n = Number(fromQuery);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// Helper para snapshot + invalidación de cache + log (v0.9.7: por tenant)
async function commitChange(summary, tenantId = 1) {
  await promptBuilder.saveSnapshot(summary, tenantId);
  promptBuilder.invalidateCache(tenantId);
}

// =====================================================================
// ENDPOINT PARA n8n: prompt armado
// =====================================================================
router.get('/bot/system-prompt', requireN8nSecret, async (req, res) => {
  try {
    const { phone } = req.query; // v0.7.8: opcional, para entry_context
    // v0.9.131 — OMNICANAL: IG/Messenger no tienen teléfono → n8n puede pasar tenant_id directo.
    let tenantId = req.query.tenant_id ? parseInt(req.query.tenant_id) : undefined;
    // v0.9.7: resolver tenant por el phone para construir SU prompt.
    // Si no hay phone/tenant_id o no resuelve → tenantId queda undefined → builder usa tenant 1.
    if (!tenantId && phone) {
      try {
        const tenant = await resolveTenantByPhone(phone);
        if (tenant) tenantId = tenant.id;
      } catch (e) {
        console.warn('[bot/system-prompt] no se pudo resolver tenant por phone, usando default:', e.message);
      }
    }
    // v0.9.284: PROMPT POR CANAL — n8n puede pasar &channel=telegram|messenger|instagram.
    const channel = req.query.channel ? String(req.query.channel).trim().toLowerCase() : undefined;
    const prompt = await promptBuilder.buildSystemPrompt({ phone, tenantId, channel });
    res.json({ system_prompt: prompt });
  } catch (e) {
    console.error('Error armando prompt:', e);
    res.status(500).json({ error: 'Could not build prompt', details: e.message });
  }
});

// =====================================================================
// CONFIG GENERAL (admin)
// =====================================================================
router.get('/admin/bot/config', requireTenantSession, async (req, res) => {
  try {
    const config = await promptBuilder.getFullConfig(getConfigTenant(req));
    res.json(config);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/bot/system-prompt', requireTenantSession, async (req, res) => {
  try {
    const prompt = await promptBuilder.buildSystemPrompt({ tenantId: getConfigTenant(req) });
    res.json({ system_prompt: prompt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Actualizar prompt base
// v0.9.69 (auditoría 12-jun, incidente real): validación blanda del contenido
// al guardar un prompt. Bloquea (a) el texto del modal de preview pegado por
// error ("Prompt completo (con variables resueltas)" — pasó en producción y
// rompió el bot del tenant 1) y (b) prompts sin el contrato JSON de salida
// (sin la clave "respuesta"/"reply" el workflow no puede parsear y el cliente
// recibe "Disculpa, hubo un problema").
function validatePromptContent(content) {
  if (/Prompt completo \(con variables resueltas\)/i.test(content)) {
    return 'Eso parece el texto del visor "Prompt completo" (incluye su título), no un prompt. Pegá solo el contenido del prompt.';
  }
  if (!/respuesta|reply/i.test(content)) {
    return 'El prompt no incluye el contrato de salida (falta la clave "respuesta" en el FORMATO JSON) — Aitana no podría responder. Revisá la plantilla.';
  }
  return null;
}

// v0.9.230 — historial de versiones del prompt (por tenant + modo). Cada guardado
// (manual, mejora con IA, o restauración) deja una versión; se conservan las últimas 15
// por (tenant, mode) — las más viejas se podan al insertar. No bloquea el guardado.
async function snapshotPromptHistory(tenantId, mode, content, source, note, lineId = null) {
  try {
    const src = ['manual', 'ai', 'restore'].includes(String(source)) ? String(source) : 'manual';
    const nt = note ? String(note).slice(0, 300) : null;
    const _ln = (lineId != null && !isNaN(Number(lineId))) ? Number(lineId) : null; // v0.9.258: historial por línea
    await db.query(
      `INSERT INTO tenant_prompt_history (tenant_id, mode, content, source, note, line_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, mode, content, src, nt, _ln]
    );
    await db.query(
      `DELETE FROM tenant_prompt_history
        WHERE tenant_id = $1 AND mode = $2 AND line_id IS NOT DISTINCT FROM $3
          AND id NOT IN (
            SELECT id FROM tenant_prompt_history
             WHERE tenant_id = $1 AND mode = $2 AND line_id IS NOT DISTINCT FROM $3
             ORDER BY created_at DESC, id DESC
             LIMIT 15)`,
      [tenantId, mode, _ln]
    );
  } catch (e) {
    console.warn('[prompt-history] snapshot falló (no bloqueante):', e.message);
  }
}

// v0.9.159 — Mejorador de prompt con IA. El tenant escribe una instrucción en
// lenguaje natural ("hacelo más cálido", "mensajes más cortos") y Gemini reescribe
// el prompt aplicando ese ajuste. NO guarda: devuelve el texto mejorado para que el
// tenant lo revise en el editor y lo guarde con el botón normal. Los tokens se
// registran en ai_usage → cuentan para el consumo/billing del tenant.
router.post('/admin/bot/prompt-base/improve', requireTenantSession, async (req, res) => {
  const content = String(req.body.content || '');
  const instruction = String(req.body.instruction || '').trim();
  const mode = String(req.body.mode || 'software');
  if (!content.trim()) return res.status(400).json({ error: 'content requerido' });
  if (!instruction) return res.status(400).json({ error: 'Escribí qué querés mejorar (ej: "que sea más cálido")' });
  if (instruction.length > 1000) return res.status(400).json({ error: 'La instrucción es demasiado larga (máx 1000 caracteres)' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'El mejorador con IA no está disponible (falta GEMINI_API_KEY).' });
  const tenantId = getConfigTenant(req);

  const systemPrompt = `Sos un editor experto de prompts de sistema para "Aitana", una asistente de ventas por WhatsApp. El dueño del negocio te da el PROMPT ACTUAL (modo de venta "${mode}") y una INSTRUCCIÓN de cómo quiere mejorarlo. Reescribí el prompt aplicando SOLO esa instrucción.
REGLAS DURAS:
- Conservá TODA la estructura, las reglas y el contenido que la instrucción NO pida cambiar. Cambiá lo MÍNIMO necesario.
- NO toques la sección de FORMATO DE SALIDA / el JSON ni sus claves (respuesta, *_to_send, etc.). El prompt SIEMPRE debe seguir pidiendo la clave "respuesta".
- Conservá los placeholders {{...}} tal cual (no los renombres ni borres).
- NO inventes funcionalidades, precios ni datos que no estén en el prompt actual.
- Escribí en el mismo idioma del prompt actual (español).
Devolvé tu respuesta EXACTAMENTE en este formato (sin markdown, sin comillas):
RESUMEN: de 1 a 3 viñetas MUY cortas (empezá cada una con "• ") que digan qué ENTENDISTE de la instrucción y qué CAMBIASTE concretamente en el prompt. En español, claro y específico.
===PROMPT===
<acá va el texto COMPLETO del prompt mejorado, sin comillas, sin markdown, sin explicaciones>`;
  const userPrompt = `INSTRUCCIÓN DEL DUEÑO: ${instruction}\n\nPROMPT ACTUAL:\n${content}`;

  try {
    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.5, maxOutputTokens: 16000, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 60000, headers: { 'Content-Type': 'application/json' } });

    // Tokens → ai_usage (billing). Best-effort: si falla el log, no rompe la respuesta.
    try {
      const um = gr.data && gr.data.usageMetadata;
      if (um) {
        const pt = Number(um.promptTokenCount) || 0;
        const ot = Number(um.candidatesTokenCount) || 0;
        await db.query(
          `INSERT INTO ai_usage (tenant_id, model, prompt_tokens, output_tokens, total_tokens) VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, _GEM_MODEL, pt, ot, Number(um.totalTokenCount) || (pt + ot)]
        );
      }
    } catch (uerr) { console.warn('[ai_usage] log prompt-improve falló (no bloqueante):', uerr.message); }

    let raw = String(gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    raw = raw.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim(); // por si mete fences
    // v0.9.260: la IA devuelve "RESUMEN: ... ===PROMPT=== <prompt>". Separamos el feedback del prompt.
    let changeSummary = null, improved = raw;
    const _dlm = raw.indexOf('===PROMPT===');
    if (_dlm !== -1) {
      changeSummary = raw.slice(0, _dlm).replace(/^\s*RESUMEN:\s*/i, '').trim() || null;
      improved = raw.slice(_dlm + 12).trim();
    }
    improved = improved.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '').trim();
    if (!improved) return res.status(502).json({ error: 'La IA no devolvió un resultado. Probá de nuevo o reformulá la instrucción.' });
    const warning = validatePromptContent(improved); // null si OK; aviso si perdió el contrato de salida
    return res.json({ ok: true, improved, summary: changeSummary, warning });
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    console.error('[prompt-improve] Gemini error:', msg);
    return res.status(502).json({ error: 'No se pudo mejorar el prompt: ' + msg });
  }
});

router.patch('/admin/bot/prompt-base', requireTenantSession, async (req, res) => {
  const { content } = req.body;
  const mode = String(req.body.mode || 'software'); // v0.9.23
  const _histSource = req.body.source; // v0.9.230: manual | ai | restore
  const _histNote = req.body.note;     // v0.9.230: ej. la instrucción de "Mejorar con IA"
  const _lineId = (req.body.line_id != null && !isNaN(Number(req.body.line_id))) ? Number(req.body.line_id) : null; // v0.9.258: override por línea (null = Default del tenant)
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content requerido como string' });
  }
  const _vErr = validatePromptContent(content); // v0.9.69
  if (_vErr) return res.status(422).json({ error: _vErr });
  const tenantId = getConfigTenant(req);
  try {
    if (mode === 'software' && _lineId == null) {
      // v0.9.22c: upsert manual (no depende de constraint UNIQUE en tenant_id).
      // v0.9.261: Default del tenant (lo heredan todas las líneas) → bot_prompt_base.
      const upd = await db.query(
        `UPDATE bot_prompt_base SET content = $1, version = version + 1, updated_at = NOW() WHERE tenant_id = $2`,
        [content, tenantId]
      );
      if (upd.rowCount === 0) {
        await db.query(`INSERT INTO bot_prompt_base (tenant_id, content, version, updated_at) VALUES ($1, $2, 1, NOW())`, [tenantId, content]);
      }
    } else if (mode === 'software') {
      // v0.9.261: override de SOFTWARE por LÍNEA → tenant_mode_prompts (mode='software', line_id=X).
      const upd = await db.query(
        `UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = 'software' AND line_id IS NOT DISTINCT FROM $3`,
        [content, tenantId, _lineId]
      );
      if (upd.rowCount === 0) {
        await db.query(`INSERT INTO tenant_mode_prompts (tenant_id, mode, content, line_id) VALUES ($1, 'software', $2, $3)`, [tenantId, content, _lineId]);
      }
    } else {
      // v0.9.23: prompt de 'articulos' / 'inmuebles' → tenant_mode_prompts
      // v0.9.70: + rubros de primera clase (salud/belleza/restaurante)
      if (!['articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos', 'postventa'].includes(mode)) return res.status(400).json({ error: 'modo inválido' });
      // v0.9.258: upsert por (tenant, mode, línea). line_id NULL = Default; =X = override de la línea.
      const upd = await db.query(
        `UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3 AND line_id IS NOT DISTINCT FROM $4`,
        [content, tenantId, mode, _lineId]
      );
      if (upd.rowCount === 0) {
        await db.query(`INSERT INTO tenant_mode_prompts (tenant_id, mode, content, line_id) VALUES ($1, $2, $3, $4)`, [tenantId, mode, content, _lineId]);
      }
    }
    await snapshotPromptHistory(tenantId, mode, content, _histSource, _histNote, _lineId); // v0.9.230 historial · v0.9.258 por línea
    await commitChange(`Prompt (${mode}) actualizado`, tenantId);
    res.json({ ok: true });
  } catch (e) {
    if (/tenant_mode_prompts/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.23' });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.230 — HISTORIAL DE VERSIONES del prompt (por modo). Devuelve las últimas 15
// versiones guardadas (manual/ai/restore) con su contenido completo, para que el panel
// liste, muestre el diff y permita restaurar.
router.get('/admin/bot/prompt-history', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const mode = String(req.query.mode || 'software');
  const _lineId = (req.query.line_id != null && req.query.line_id !== '' && !isNaN(Number(req.query.line_id))) ? Number(req.query.line_id) : null; // v0.9.258
  try {
    const r = await db.query(
      `SELECT id, mode, source, note, content, created_at
         FROM tenant_prompt_history
        WHERE tenant_id = $1 AND mode = $2 AND line_id IS NOT DISTINCT FROM $3
        ORDER BY created_at DESC, id DESC
        LIMIT 15`, [tenantId, mode, _lineId]);
    res.json({ ok: true, history: r.rows });
  } catch (e) {
    if (/tenant_prompt_history/.test(e.message)) return res.json({ ok: true, history: [] }); // migración pendiente → no romper UI
    res.status(500).json({ error: e.message });
  }
});

// v0.9.230 — restaurar una versión: copia su contenido al prompt activo del modo
// (mismo upsert que el guardado normal) y deja una versión 'restore' en el historial.
router.post('/admin/bot/prompt-history/restore', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const mode = String(req.body.mode || 'software');
  const id = parseInt(req.body.id, 10);
  const _lineId = (req.body.line_id != null && !isNaN(Number(req.body.line_id))) ? Number(req.body.line_id) : null; // v0.9.258
  if (isNaN(id)) return res.status(400).json({ error: 'id requerido' });
  if (!['software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos', 'postventa'].includes(mode)) {
    return res.status(400).json({ error: 'modo inválido' });
  }
  try {
    const h = await db.query(`SELECT content FROM tenant_prompt_history WHERE id = $1 AND tenant_id = $2 AND mode = $3 AND line_id IS NOT DISTINCT FROM $4`, [id, tenantId, mode, _lineId]);
    if (!h.rows[0]) return res.status(404).json({ error: 'versión no encontrada' });
    const content = h.rows[0].content;
    if (mode === 'software' && _lineId == null) {
      const upd = await db.query(`UPDATE bot_prompt_base SET content = $1, version = version + 1, updated_at = NOW() WHERE tenant_id = $2`, [content, tenantId]);
      if (upd.rowCount === 0) await db.query(`INSERT INTO bot_prompt_base (tenant_id, content, version, updated_at) VALUES ($1, $2, 1, NOW())`, [tenantId, content]);
    } else {
      // v0.9.261: software por línea (line_id != null) y demás modos → tenant_mode_prompts.
      const upd = await db.query(`UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3 AND line_id IS NOT DISTINCT FROM $4`, [content, tenantId, mode, _lineId]);
      if (upd.rowCount === 0) await db.query(`INSERT INTO tenant_mode_prompts (tenant_id, mode, content, line_id) VALUES ($1, $2, $3, $4)`, [tenantId, mode, content, _lineId]);
    }
    await snapshotPromptHistory(tenantId, mode, content, 'restore', `Restaurado de versión #${id}`, _lineId);
    await commitChange(`Prompt (${mode}) restaurado de versión #${id}`, tenantId);
    res.json({ ok: true, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------
// v0.9.457 — Modo activo REAL + defaults siempre presentes.
// Bug reportado: onboarding con "hacer después" → active_prompt_mode se
// queda en su valor por defecto ('software'), pero nadie escribe nunca un
// prompt de software (no existe un default SOFTWARE), así que el editor
// abría vacío mostrando el placeholder "Cargando..." para siempre.
// resolveActiveMode() distingue "software elegido" de "software por
// inercia": si no hay prompt de software y la visibilidad apunta a UN solo
// modo real, ese es el modo del tenant y se corrige en la base.
// ---------------------------------------------------------------------
const VIS_MODE_KEYS = ['software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos'];

async function resolveActiveMode(tenantId) {
  let activeMode = 'software';
  try {
    const am = await db.query(
      `SELECT active_prompt_mode AS m, COALESCE(to_jsonb(tenants) -> 'mode_visibility', '{}'::jsonb) AS vis
       FROM tenants WHERE id = $1`, [tenantId]
    );
    if (!am.rows.length) return activeMode;
    activeMode = am.rows[0].m || 'software';
    if (activeMode !== 'software') return activeMode;

    // ¿Eligió software de verdad? Entonces tiene (o tuvo) prompt propio.
    const sw = await db.query('SELECT content FROM bot_prompt_base WHERE tenant_id = $1', [tenantId]);
    if (sw.rows[0] && String(sw.rows[0].content || '').trim()) return 'software';

    const vis = (am.rows[0].vis && typeof am.rows[0].vis === 'object') ? am.rows[0].vis : {};
    const visible = VIS_MODE_KEYS.filter(k => vis[k] === true);
    if (visible.length === 1 && visible[0] !== 'software') {
      const real = visible[0];
      await db.query(
        "UPDATE tenants SET active_prompt_mode = $1 WHERE id = $2 AND (active_prompt_mode IS NULL OR active_prompt_mode = 'software')",
        [real, tenantId]
      );
      console.log(`🔧 [bot-config] tenant ${tenantId}: active_prompt_mode 'software' (por defecto, sin prompt) → '${real}' (según mode_visibility)`);
      return real;
    }
  } catch (e) { /* noop: nunca romper la carga del panel */ }
  return activeMode;
}

function defaultFor(mode) {
  try { return require('./default-mode-prompts').defaultForMode(mode) || ''; } catch (e) { return ''; }
}

// v0.9.23 — GET prompts por modo + cuál está activo
router.get('/admin/bot/mode-prompts', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  try {
    const activeMode = await resolveActiveMode(tenantId); // v0.9.457
    const sw = await db.query('SELECT content FROM bot_prompt_base WHERE tenant_id = $1', [tenantId]);
    const prompts = { software: (sw.rows[0] && sw.rows[0].content) || '' };
    try {
      const mp = await db.query('SELECT mode, content FROM tenant_mode_prompts WHERE tenant_id = $1 AND line_id IS NULL', [tenantId]); // v0.9.258: solo el Default (no overrides de línea)
      for (const r of mp.rows) prompts[r.mode] = r.content || '';
    } catch (e) {}
    // v0.9.457: los 3 modes originales también caen al default si el tenant no
    // tiene prompt propio (antes quedaban en '' → editor vacío). Mismo patrón
    // que arquitectura/rubros/postventa más abajo.
    for (const m of ['articulos', 'servicios', 'inmuebles']) {
      if (!(m in prompts) || !String(prompts[m] || '').trim()) prompts[m] = defaultFor(m);
    }
    // v0.9.122: arquitectura — si el tenant no tiene prompt propio, mostrar el
    // default editable (al guardar queda como suyo). Mismo patrón que postventa.
    try {
      const defaults = require('./default-mode-prompts');
      if (!('arquitectura' in prompts) || !String(prompts.arquitectura || '').trim()) prompts.arquitectura = defaults.ARQUITECTURA;
    } catch (e) {}
    // v0.9.70: rubros de primera clase — si el tenant no tiene prompt propio,
    // se muestra el default (editable; al guardar queda como suyo)
    try {
      const defaults = require('./default-mode-prompts');
      for (const rb of ['salud', 'belleza', 'restaurante', 'vehiculos']) {
        if (!(rb in prompts) || !String(prompts[rb] || '').trim()) prompts[rb] = defaults.RUBROS[rb].prompt;
      }
    } catch (e) {}
    // v0.9.108: prompt de POST-VENTA (soporte). Default editable si no lo tocaron.
    try {
      const defaults = require('./default-mode-prompts');
      if (!('postventa' in prompts) || !String(prompts.postventa || '').trim()) prompts.postventa = defaults.POSTVENTA;
    } catch (e) {}
    let _defPv = '';
    try { _defPv = require('./default-mode-prompts').POSTVENTA || ''; } catch (e) {}
    res.json({ ok: true, active_mode: activeMode, prompts, default_postventa: _defPv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.9.310 — prompt de SOPORTE (postventa) POR LÍNEA. line_id vacío = Default del tenant.
router.get('/admin/bot/support-prompt', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const _lineId = (req.query.line_id != null && req.query.line_id !== '' && !isNaN(Number(req.query.line_id))) ? Number(req.query.line_id) : null;
  try {
    let def = '';
    try { def = require('./default-mode-prompts').POSTVENTA || ''; } catch (e) {}
    let tenantDefault = def;
    try {
      const dr = await db.query("SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = 'postventa' AND line_id IS NULL", [tenantId]);
      if (dr.rows[0] && String(dr.rows[0].content || '').trim()) tenantDefault = dr.rows[0].content;
    } catch (e) {}
    let content = tenantDefault, hasOwn = false;
    if (_lineId != null) {
      try {
        const lr = await db.query("SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = 'postventa' AND line_id = $2", [tenantId, _lineId]);
        if (lr.rows[0] && String(lr.rows[0].content || '').trim()) { content = lr.rows[0].content; hasOwn = true; }
      } catch (e) {}
    }
    res.json({ ok: true, content, has_own: hasOwn, inherited: tenantDefault, default_postventa: def, line_id: _lineId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v0.9.258 — PROMPT POR LÍNEA: carga el prompt del modo ACTIVO para una línea (o el Default).
// line_id vacío = Default del tenant. Devuelve content (lo que se edita), has_own (override propio?),
// inherited (el Default, para "personalizar") y per_line (false en software → no aplica por línea).
router.get('/admin/bot/line-prompt', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const _lineId = (req.query.line_id != null && req.query.line_id !== '' && !isNaN(Number(req.query.line_id))) ? Number(req.query.line_id) : null;
  try {
    const activeMode = await resolveActiveMode(tenantId); // v0.9.457
    let inherited = '';
    if (activeMode === 'software') {
      const sw = await db.query('SELECT content FROM bot_prompt_base WHERE tenant_id = $1', [tenantId]);
      inherited = (sw.rows[0] && sw.rows[0].content) || '';
    } else {
      const d = await db.query('SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND line_id IS NULL', [tenantId, activeMode]);
      inherited = (d.rows[0] && d.rows[0].content) || '';
    }
    // v0.9.457: si el tenant nunca guardó nada, mostrar el DEFAULT del modo
    // (editable; al guardar queda suyo) en vez de un editor en blanco. Es lo
    // que el bot ya usa en runtime, así que el panel deja de mentir.
    let usingDefault = false;
    if (!String(inherited || '').trim()) {
      inherited = defaultFor(activeMode);
      usingDefault = !!String(inherited || '').trim();
    }
    let own = null;
    if (_lineId != null) { // v0.9.261: software también lee override por línea (tenant_mode_prompts, mode='software')
      const o = await db.query('SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND line_id = $3', [tenantId, activeMode, _lineId]);
      own = (o.rows[0] && o.rows[0].content != null) ? o.rows[0].content : null;
    }
    const scope = _lineId == null ? 'default' : 'line';
    const has_own = scope === 'default' ? true : (own != null);
    const content = scope === 'default' ? inherited : (own != null ? own : inherited);
    res.json({ ok: true, active_mode: activeMode, scope, line_id: _lineId, has_own, content, inherited, per_line: true, using_default: usingDefault });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.9.258 — "Volver a heredar del Default": borra el override de la línea (vuelve a usar el Default).
router.delete('/admin/bot/line-prompt', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const _lineId = Number(req.query.line_id);
  if (!_lineId) return res.status(400).json({ error: 'line_id requerido' });
  try {
    let activeMode = 'software';
    try { const am = await db.query('SELECT active_prompt_mode FROM tenants WHERE id = $1', [tenantId]); activeMode = (am.rows[0] && am.rows[0].active_prompt_mode) || 'software'; } catch (e) {}
    // v0.9.261: software también es por línea → se permite revertir el override de la línea al Default.
    await db.query('DELETE FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND line_id = $3', [tenantId, activeMode, _lineId]);
    await commitChange(`Prompt de línea ${_lineId} (${activeMode}) vuelto a heredar del Default`, tenantId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.9.284 — PROMPT POR CANAL: cargar el prompt del modo ACTIVO para un canal (Messenger/Instagram/Telegram)
// o el Default. Espeja /admin/bot/line-prompt pero keyed por canal.
router.get('/admin/bot/channel-prompt', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const channel = String(req.query.channel || '').trim().toLowerCase();
  if (!['messenger', 'instagram', 'telegram'].includes(channel)) return res.status(400).json({ error: 'canal inválido' });
  try {
    const activeMode = await resolveActiveMode(tenantId); // v0.9.457
    let inherited = '';
    if (activeMode === 'software') {
      const sw = await db.query('SELECT content FROM bot_prompt_base WHERE tenant_id = $1', [tenantId]);
      inherited = (sw.rows[0] && sw.rows[0].content) || '';
    } else {
      const d = await db.query('SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND line_id IS NULL AND channel IS NULL', [tenantId, activeMode]);
      inherited = (d.rows[0] && d.rows[0].content) || '';
    }
    let usingDefault = false; // v0.9.457: nunca devolver un editor vacío
    if (!String(inherited || '').trim()) {
      inherited = defaultFor(activeMode);
      usingDefault = !!String(inherited || '').trim();
    }
    const o = await db.query('SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND channel = $3', [tenantId, activeMode, channel]);
    const own = (o.rows[0] && o.rows[0].content != null) ? o.rows[0].content : null;
    const has_own = own != null;
    const content = has_own ? own : inherited;
    res.json({ ok: true, active_mode: activeMode, channel, has_own, content, inherited, using_default: usingDefault });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.9.284 — guardar el prompt propio de un canal (override completo del modo activo).
router.post('/admin/bot/channel-prompt', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const channel = String((req.body && req.body.channel) || '').trim().toLowerCase();
  const content = String((req.body && req.body.content) != null ? req.body.content : '');
  if (!['messenger', 'instagram', 'telegram'].includes(channel)) return res.status(400).json({ error: 'canal inválido' });
  try {
    let activeMode = 'software';
    try { const am = await db.query('SELECT active_prompt_mode FROM tenants WHERE id = $1', [tenantId]); activeMode = (am.rows[0] && am.rows[0].active_prompt_mode) || 'software'; } catch (e) {}
    const upd = await db.query(
      `UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3 AND line_id IS NULL AND channel IS NOT DISTINCT FROM $4`,
      [content, tenantId, activeMode, channel]
    );
    if (upd.rowCount === 0) {
      await db.query(`INSERT INTO tenant_mode_prompts (tenant_id, mode, content, channel) VALUES ($1, $2, $3, $4)`, [tenantId, activeMode, content, channel]);
    }
    await commitChange(`Prompt del canal ${channel} (${activeMode}) actualizado`, tenantId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.9.284 — "Volver a heredar del Default": borra el override del canal.
router.delete('/admin/bot/channel-prompt', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const channel = String(req.query.channel || '').trim().toLowerCase();
  if (!['messenger', 'instagram', 'telegram'].includes(channel)) return res.status(400).json({ error: 'canal inválido' });
  try {
    let activeMode = 'software';
    try { const am = await db.query('SELECT active_prompt_mode FROM tenants WHERE id = $1', [tenantId]); activeMode = (am.rows[0] && am.rows[0].active_prompt_mode) || 'software'; } catch (e) {}
    await db.query('DELETE FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND channel = $3', [tenantId, activeMode, channel]);
    await commitChange(`Prompt del canal ${channel} (${activeMode}) vuelto a heredar del Default`, tenantId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v0.9.23 — activar el prompt de un modo (la persona de Aitana)
router.post('/admin/bot/active-prompt-mode', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  const mode = String(req.body.mode || '');
  // v0.9.70: + rubros de primera clase
  if (!['software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos'].includes(mode)) return res.status(400).json({ error: 'modo inválido' });
  try {
    if (mode !== 'software') {
      const mp = await db.query('SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2', [tenantId, mode]);
      if (!mp.rows[0] || !mp.rows[0].content || !mp.rows[0].content.trim()) {
        // v0.9.70: los RUBROS se auto-siembran con su prompt default — activar
        // un rubro es UN clic, sin paso previo de "escribí y guardá el prompt".
        const defaults = require('./default-mode-prompts');
        // v0.9.122: arquitectura no es RUBRO (lee `services`) pero también
        // auto-siembra su default → activarla es UN clic, igual que los rubros.
        const seedContent = (defaults.RUBROS && defaults.RUBROS[mode]) ? defaults.RUBROS[mode].prompt
          : (mode === 'arquitectura' ? defaults.ARQUITECTURA : null);
        if (seedContent) {
          // v0.9.405 — FIX: el ON CONFLICT (tenant_id, mode, COALESCE(line_id,0)) NO matchea ninguna
          // constraint de tenant_mode_prompts → daba 500 y el modo activo NUNCA cambiaba (un rubro con
          // prompt vacío no se podía activar; rompía el onboarding de concesionaria). Upsert manual por
          // (tenant, mode, Default=line_id NULL), igual patrón que /admin/bot/prompt-base.
          const _seedUpd = await db.query(
            `UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3 AND line_id IS NULL`,
            [seedContent, tenantId, mode]
          );
          if (_seedUpd.rowCount === 0) {
            await db.query(`INSERT INTO tenant_mode_prompts (tenant_id, mode, content, line_id) VALUES ($1, $2, $3, NULL)`, [tenantId, mode, seedContent]);
          }
          console.log(`🌱 [bot-config] Prompt default de "${mode}" sembrado para tenant ${tenantId}`);
        } else {
          return res.status(400).json({ error: `El prompt de "${mode}" está vacío. Escribilo y guardalo antes de activarlo.` });
        }
      }
    }
    await db.query('UPDATE tenants SET active_prompt_mode = $1 WHERE id = $2', [mode, tenantId]);
    await commitChange(`Prompt activo: ${mode}`, tenantId);
    res.json({ ok: true, active_mode: mode });
  } catch (e) {
    if (/active_prompt_mode/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.23' });
    res.status(500).json({ error: e.message });
  }
});

// Actualizar valor global
router.patch('/admin/bot/global/:key', requireTenantSession, async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value === undefined) {
    return res.status(400).json({ error: 'value requerido' });
  }
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(
      `UPDATE bot_global_config SET config_value = $1, updated_at = NOW() WHERE config_key = $2 AND tenant_id = $3 RETURNING *`,
      [String(value), key, tenantId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `Config key '${key}' no existe para este tenant` });
    }
    await commitChange(`Config global actualizada: ${key} = ${value}`, tenantId);
    res.json({ ok: true, config: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// VERTICALES
// =====================================================================
router.get('/admin/bot/verticals', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      SELECT v.*,
        COALESCE(json_agg(
          json_build_object('id', pp.id, 'name', pp.client_name, 'location', pp.client_location, 'active', pp.active)
          ORDER BY pp.client_name
        ) FILTER (WHERE pp.id IS NOT NULL), '[]'::json) AS proof_points
      FROM bot_verticals v
      LEFT JOIN bot_proof_points pp ON pp.vertical_id = v.vertical_id AND pp.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1
      GROUP BY v.tenant_id, v.vertical_id
      ORDER BY v.sort_order, v.display_name
    `, [tenantId]);
    res.json({ verticals: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/bot/verticals', requireTenantSession, async (req, res) => {
  const { vertical_id, display_name, tagline, ideal_client, problem_solved, features, keywords, differentiator, sort_order, integration_type } = req.body;
  if (!vertical_id || !display_name) {
    return res.status(400).json({ error: 'vertical_id y display_name son requeridos' });
  }
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      INSERT INTO bot_verticals (tenant_id, vertical_id, display_name, tagline, ideal_client, problem_solved, features, keywords, differentiator, sort_order, integration_type)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
      RETURNING *
    `, [tenantId, vertical_id, display_name, tagline, ideal_client, problem_solved, JSON.stringify(features || []), keywords || [], differentiator, sort_order || 100, integration_type || 'none']);
    await commitChange(`Producto creado: ${vertical_id}`, tenantId);
    res.json({ ok: true, vertical: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/admin/bot/verticals/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const { display_name, tagline, ideal_client, problem_solved, features, keywords, differentiator, sort_order, active, integration_type } = req.body;
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      UPDATE bot_verticals
      SET display_name = COALESCE($1, display_name),
          tagline = COALESCE($2, tagline),
          ideal_client = COALESCE($3, ideal_client),
          problem_solved = COALESCE($4, problem_solved),
          features = COALESCE($5::jsonb, features),
          keywords = COALESCE($6, keywords),
          differentiator = COALESCE($7, differentiator),
          sort_order = COALESCE($8, sort_order),
          active = COALESCE($9, active),
          integration_type = COALESCE($12, integration_type),
          updated_at = NOW()
      WHERE vertical_id = $10 AND tenant_id = $11
      RETURNING *
    `, [display_name, tagline, ideal_client, problem_solved,
        features !== undefined ? JSON.stringify(features) : null,
        keywords, differentiator, sort_order, active, id, tenantId, integration_type]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Producto no encontrado' });
    }
    await commitChange(`Producto actualizado: ${id}`, tenantId);
    res.json({ ok: true, vertical: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/bot/verticals/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const tenantId = getConfigTenant(req);
  // v0.9.538 — ?hard=1 borra el producto de verdad (y sus planes/proof points locales).
  // Sin el flag: soft-delete (active=FALSE), reversible con el toggle "Ofrecer".
  const hard = req.query.hard === '1' || req.query.hard === 'true';
  try {
    if (hard) {
      await db.query(`DELETE FROM bot_pricing_plans WHERE vertical_id = $1 AND tenant_id = $2`, [id, tenantId]).catch(() => {});
      await db.query(`DELETE FROM bot_proof_points WHERE vertical_id = $1 AND tenant_id = $2`, [id, tenantId]).catch(() => {});
      const result = await db.query(`DELETE FROM bot_verticals WHERE vertical_id = $1 AND tenant_id = $2 RETURNING *`, [id, tenantId]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
      await commitChange(`Producto eliminado: ${id}`, tenantId);
    } else {
      const result = await db.query(`UPDATE bot_verticals SET active = FALSE WHERE vertical_id = $1 AND tenant_id = $2 RETURNING *`, [id, tenantId]);
      if (result.rows.length === 0) return res.status(404).json({ error: 'Producto no encontrado' });
      await commitChange(`Producto desactivado: ${id}`, tenantId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// PLANES
// =====================================================================
router.get('/admin/bot/plans', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`SELECT * FROM bot_pricing_plans WHERE tenant_id = $1 ORDER BY sort_order, monthly_bs`, [tenantId]);
    res.json({ plans: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/bot/plans', requireTenantSession, async (req, res) => {
  const { plan_id, display_name, monthly_bs, target_description, includes, excludes, max_users, max_branches, support_hours, sort_order, recommended, vertical_id } = req.body;
  if (!plan_id || !display_name || monthly_bs === undefined) {
    return res.status(400).json({ error: 'plan_id, display_name y monthly_bs son requeridos' });
  }
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      INSERT INTO bot_pricing_plans (tenant_id, plan_id, display_name, monthly_bs, target_description, includes, excludes, max_users, max_branches, support_hours, sort_order, recommended, vertical_id)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12, $13)
      RETURNING *
    `, [tenantId, plan_id, display_name, monthly_bs, target_description,
        JSON.stringify(includes || []), JSON.stringify(excludes || []),
        max_users, max_branches, support_hours, sort_order || 100, recommended || false, vertical_id || null]);
    await commitChange(`Plan creado: ${plan_id}`, tenantId);
    res.json({ ok: true, plan: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/admin/bot/plans/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const { display_name, monthly_bs, target_description, includes, excludes, max_users, max_branches, support_hours, sort_order, recommended, active, vertical_id } = req.body;
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      UPDATE bot_pricing_plans
      SET display_name = COALESCE($1, display_name),
          monthly_bs = COALESCE($2, monthly_bs),
          target_description = COALESCE($3, target_description),
          includes = COALESCE($4::jsonb, includes),
          excludes = COALESCE($5::jsonb, excludes),
          max_users = COALESCE($6, max_users),
          max_branches = COALESCE($7, max_branches),
          support_hours = COALESCE($8, support_hours),
          sort_order = COALESCE($9, sort_order),
          recommended = COALESCE($10, recommended),
          active = COALESCE($11, active),
          vertical_id = COALESCE($14, vertical_id),
          updated_at = NOW()
      WHERE plan_id = $12 AND tenant_id = $13
      RETURNING *
    `, [display_name, monthly_bs, target_description,
        includes !== undefined ? JSON.stringify(includes) : null,
        excludes !== undefined ? JSON.stringify(excludes) : null,
        max_users, max_branches, support_hours, sort_order, recommended, active, id, tenantId, vertical_id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Plan no encontrado' });
    }
    await commitChange(`Plan actualizado: ${id}`, tenantId);
    res.json({ ok: true, plan: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/bot/plans/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const tenantId = getConfigTenant(req);
  // v0.9.531 — ?hard=1 borra el plan de verdad (desaparece de la lista). Sin el flag,
  // se conserva el comportamiento previo: soft-delete (active=FALSE, reversible).
  const hard = req.query.hard === '1' || req.query.hard === 'true';
  try {
    if (hard) {
      await db.query(`DELETE FROM bot_pricing_plans WHERE plan_id = $1 AND tenant_id = $2`, [id, tenantId]);
      await commitChange(`Plan eliminado: ${id}`, tenantId);
    } else {
      await db.query(`UPDATE bot_pricing_plans SET active = FALSE WHERE plan_id = $1 AND tenant_id = $2`, [id, tenantId]);
      await commitChange(`Plan desactivado: ${id}`, tenantId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// PROOF POINTS
// =====================================================================
router.get('/admin/bot/proof-points', requireTenantSession, async (req, res) => {
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`SELECT * FROM bot_proof_points WHERE tenant_id = $1 ORDER BY vertical_id, client_name`, [tenantId]);
    res.json({ proof_points: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/bot/proof-points', requireTenantSession, async (req, res) => {
  const { vertical_id, client_name, client_location, description } = req.body;
  if (!vertical_id || !client_name) {
    return res.status(400).json({ error: 'vertical_id y client_name son requeridos' });
  }
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      INSERT INTO bot_proof_points (tenant_id, vertical_id, client_name, client_location, description)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [tenantId, vertical_id, client_name, client_location, description]);
    await commitChange(`Proof point creado: ${client_name} (${vertical_id})`, tenantId);
    res.json({ ok: true, proof_point: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/admin/bot/proof-points/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const { client_name, client_location, description, active } = req.body;
  const tenantId = getConfigTenant(req);
  try {
    const result = await db.query(`
      UPDATE bot_proof_points
      SET client_name = COALESCE($1, client_name),
          client_location = COALESCE($2, client_location),
          description = COALESCE($3, description),
          active = COALESCE($4, active),
          updated_at = NOW()
      WHERE id = $5 AND tenant_id = $6 RETURNING *
    `, [client_name, client_location, description, active, id, tenantId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Proof point no encontrado' });
    }
    await commitChange(`Proof point actualizado: id=${id}`, tenantId);
    res.json({ ok: true, proof_point: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/bot/proof-points/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const tenantId = getConfigTenant(req);
  try {
    await db.query(`DELETE FROM bot_proof_points WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    await commitChange(`Proof point eliminado: id=${id}`, tenantId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// HISTÓRICO Y SNAPSHOTS
// =====================================================================
router.get('/admin/bot/history', requireTenantSession, async (req, res) => {
  try {
    // v0.9.67 (auditoría 12-jun P1#10): SOLO el historial del propio tenant.
    // El fix A-1 de v0.9.45 cerró el detalle y el restore pero olvidó el LISTADO
    // (los change_summary incluyen valores de config de otras orgs).
    const result = await db.query(`
      SELECT id, change_summary, created_at FROM bot_prompt_history
      WHERE tenant_id = $1
      ORDER BY created_at DESC LIMIT 50
    `, [getConfigTenant(req)]);
    res.json({ history: result.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/bot/history/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  try {
    // v0.9.45 (auditoría A-1): snapshot SOLO del propio tenant (antes cross-tenant por id)
    const result = await db.query(`SELECT * FROM bot_prompt_history WHERE id = $1 AND tenant_id = $2`, [id, getConfigTenant(req)]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Snapshot no encontrado' });
    }
    res.json({ snapshot: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/bot/history/:id/restore', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const tenantId = getConfigTenant(req);
  try {
    // v0.9.45 (auditoría A-1): restaurar SOLO snapshots del propio tenant
    const snapRes = await db.query(`SELECT snapshot FROM bot_prompt_history WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (snapRes.rows.length === 0) {
      return res.status(404).json({ error: 'Snapshot no encontrado' });
    }
    const snap = snapRes.rows[0].snapshot;

    // Restaurar prompt_base (del tenant)
    if (snap.prompt_base?.content) {
      await db.query(
        `UPDATE bot_prompt_base SET content = $1, version = version + 1, updated_at = NOW() WHERE tenant_id = $2`,
        [snap.prompt_base.content, tenantId]
      );
    }

    // Restaurar global config (del tenant)
    for (const c of snap.global_config || []) {
      await db.query(
        `UPDATE bot_global_config SET config_value = $1, updated_at = NOW() WHERE config_key = $2 AND tenant_id = $3`,
        [c.config_value, c.config_key, tenantId]
      );
    }

    // Nota: para verticales/planes/proof points la restauración completa requeriría DELETE + INSERT.
    // Por simplicidad de v1, solo restauramos prompt_base + global_config.

    await commitChange(`Restaurado a snapshot id=${id}`, tenantId);
    res.json({ ok: true, restored_partial: true, message: 'Prompt base y global config restaurados. Verticales/planes/proofs requieren restauración manual desde el snapshot.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// TEST INTERACTIVO
// =====================================================================
router.post('/admin/bot/test-message', requireTenantSession, async (req, res) => {
  const { message, history } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message requerido' });
  }
  try {
    const tenantId = getConfigTenant(req);
    let systemPrompt = await promptBuilder.buildSystemPrompt({ tenantId });
    // v0.9.432 — calendario real también en test (sin phone no corre el enriquecimiento
    // de buildSystemPrompt y el modelo agendaba fechas inventadas, ej. 2025).
    try { systemPrompt += (promptBuilder.buildCalendarLines ? promptBuilder.buildCalendarLines() : ''); } catch (e) {}

    // v0.9.24d: la ventana de test ahora ve los MISMOS catálogos que producción
    // (webhook.js). Antes el test no mandaba inventory/realestate aunque el
    // modo estuviera ON → parecía que el cambio de modo "no aplicaba".
    let inventoryCatalog = [];
    try {
      // v0.9.452 — paridad con prod (webhook.js): vehiculos/restaurante también arman el catálogo
      // en test y cada modo lee SU tabla (antes solo inventory_bot_enabled → en modo Concesionaria
      // el test quedaba SIN autos aunque prod sí los mandaba).
      const flag = await db.query(`SELECT COALESCE(to_jsonb(tenants) ->> 'inventory_bot_enabled','false')::boolean AS inv, COALESCE(to_jsonb(tenants) ->> 'vehiculos_bot_enabled','false')::boolean AS veh, COALESCE(to_jsonb(tenants) ->> 'restaurante_bot_enabled','false')::boolean AS resto FROM tenants WHERE id = $1`, [tenantId]);
      const _fr = (flag.rows[0] || {});
      if (_fr.inv || _fr.veh || _fr.resto) {
        const _invTbl = _fr.resto ? 'catalog_restaurante' : (_fr.veh ? 'catalog_vehiculos' : 'inventory_items');
        const inv = await db.query(
          `SELECT id, code, name, description, price, currency, (stock > 0) AS in_stock,
                  to_jsonb(${_invTbl}) ->> 'brand'    AS brand,
                  to_jsonb(${_invTbl}) ->> 'category' AS category,
                  to_jsonb(${_invTbl}) ->> 'subcategory' AS subcategory,
                  to_jsonb(${_invTbl}) ->> 'features' AS features,
                  COALESCE(to_jsonb(${_invTbl}) -> 'image_urls',   '[]'::jsonb) AS image_urls,
                  COALESCE(to_jsonb(${_invTbl}) -> 'image_labels', '{}'::jsonb) AS image_labels,
                  image_url
           FROM ${_invTbl}
           WHERE tenant_id = $1 AND active = TRUE
           ORDER BY LOWER(name) LIMIT 300`,
          [tenantId]
        );
        // v0.9.455 — paridad con prod: viaja "photos" (lista de etiquetas de vistas/variantes,
        // sin URLs) para que en el TEST el modelo también pueda usar photo_label ("azul dimensión").
        inventoryCatalog = inv.rows.map((row) => {
          const urls = (Array.isArray(row.image_urls) && row.image_urls.length) ? row.image_urls : (row.image_url ? [row.image_url] : []);
          const lbls = (row.image_labels && typeof row.image_labels === 'object') ? row.image_labels : {};
          const photos = urls.map((u, idx) => lbls[u] || `foto ${idx + 1}`);
          const { image_urls, image_labels, image_url, ...rest } = row;
          return { ...rest, photos };
        });
      }
    } catch (e) { /* inventario no migrado → vacío */ }

    let realestateCatalog = [];
    try {
      const flag = await db.query('SELECT realestate_bot_enabled FROM tenants WHERE id = $1', [tenantId]);
      if (flag.rows[0] && flag.rows[0].realestate_bot_enabled) {
        // v0.9.431 — misma selección por RELEVANCIA que producción (webhook.js).
        // El panel de test acumula el search_profile turno a turno y lo manda
        // en el body → el test reproduce lo que el lead vería de verdad.
        // Además ahora viaja "photos" (lista de ambientes) como en prod, para
        // poder probar las reglas de fotos también desde la ventana de test.
        const { selectRelevantProperties } = require('./catalog-matcher');
        const rows = await selectRelevantProperties(db, {
          tenantId,
          searchProfile: (req.body && typeof req.body.search_profile === 'object') ? req.body.search_profile : null,
        });
        realestateCatalog = rows.map((row) => {
          const urls = Array.isArray(row.image_urls) ? row.image_urls : [];
          const lbls = (row.image_labels && typeof row.image_labels === 'object') ? row.image_labels : {};
          const photos = urls.map((u, idx) => lbls[u] || `foto ${idx + 1}`);
          const { image_urls, image_labels, code, ...rest } = row; // v0.9.244: sin code interno
          return { ...rest, photos };
        });
      }
    } catch (e) { /* no migrado → vacío */ }

    // Llamar a Gemini directamente
    const axios = require('axios');
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'GEMINI_API_KEY no configurado' });
    }

    const catalogBlocks = [];
    if (inventoryCatalog.length > 0) {
      catalogBlocks.push(`## CATÁLOGO DE ARTÍCULOS DISPONIBLE (igual que producción; in_stock booleano, NUNCA reveles cantidades)\n\n${JSON.stringify(inventoryCatalog)}`);
    }
    if (realestateCatalog.length > 0) {
      catalogBlocks.push(`## CATÁLOGO DE INMUEBLES DISPONIBLE (igual que producción)\n\n${JSON.stringify(realestateCatalog)}`);
    }

    const userPrompt = `## CONTEXTO DE TEST

Esta es una conversación de prueba simulada (no es un cliente real).
${catalogBlocks.length > 0 ? '\n' + catalogBlocks.join('\n\n') + '\n' : ''}
## HISTORIAL

${(history || []).map(h => `${h.role === 'user' ? 'CLIENTE' : 'AITANA'}: ${h.text}`).join('\n') || '(primer mensaje)'}

## ÚLTIMO MENSAJE DEL CLIENTE

${message}

## TU TAREA

Responde según las reglas del sistema. Devuelve SOLO JSON válido sin markdown.`;

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    // v0.9.455 — BUG: maxOutputTokens 1000 truncaba el JSON (contrato con sl/intel/search_profile
    // no cabe) → parse_error silencioso → el test devolvía VACÍO intermitente. Se sube el techo y
    // se REINTENTA una vez ante truncado/parse fallido antes de rendirse.
    // v0.9.576 — el test devolvía "Error de parseo: sin respuesta" SIN decir por qué: no
    // guardaba el texto crudo ni el finishReason, así que era imposible saber si el modelo
    // truncó, devolvió vacío o envolvió el JSON en ```. Ahora:
    //   · sube el techo de tokens (el contrato con sl/intel/search_profile + catálogo no entraba)
    //   · limpia fences ```json y se queda con el {...} más externo antes de parsear
    //   · reintenta con el modelo de fallback si el primero falla o viene vacío
    //   · devuelve raw + finish_reason + model para que el error se pueda diagnosticar
    const _extractJson = (t) => {
      if (!t || typeof t !== 'string') return null;
      let x = t.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      try { return JSON.parse(x); } catch (e) {}
      const a = x.indexOf('{'), b = x.lastIndexOf('}');
      if (a >= 0 && b > a) { try { return JSON.parse(x.slice(a, b + 1)); } catch (e) {} }
      return null;
    };
    let parsed = null, lastFinish = null, lastRaw = '', usedModel = _GEM_MODEL, lastErr = null;
    const _models = [_GEM_MODEL, _GEM_FALLBACK];
    outer:
    for (const _model of _models) {
      for (let _try = 0; _try < 2 && !parsed; _try++) {
        try {
          const geminiResp = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/${_model}:generateContent?key=${apiKey}`, {
              contents: [{ parts: [{ text: userPrompt }] }],
              systemInstruction: { parts: [{ text: systemPrompt }] },
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 8192,
                responseMimeType: 'application/json',
                thinkingConfig: { thinkingBudget: 0 },
              },
            }, { timeout: 45000, headers: { 'Content-Type': 'application/json' } });
          const cand = geminiResp.data?.candidates?.[0];
          lastFinish = cand?.finishReason || null;
          usedModel = _model;
          lastRaw = cand?.content?.parts?.[0]?.text || '';
          parsed = _extractJson(lastRaw);
          if (parsed) break outer;
          console.warn(`[test-message] sin JSON · modelo=${_model} · finish=${lastFinish} · chars=${lastRaw.length}`);
        } catch (e) {
          lastErr = e.response?.data?.error?.message || e.message;
          console.warn(`[test-message] ${_model} falló: ${lastErr}`);
          break; // pasar al modelo de fallback
        }
      }
    }
    if (!parsed) {
      // Mensaje accionable en vez de "sin respuesta": el panel lo muestra tal cual.
      // MAX_TOKENS + texto VACÍO = firma clásica de los modelos con "thinking": se comen todo el
      // presupuesto de salida razonando y no llegan a escribir nada. No tiene que ver con el
      // tamaño del catálogo (pasa igual con 2 inmuebles). Se resuelve subiendo maxOutputTokens.
      const _why = lastErr ? `Gemini rechazó la llamada: ${lastErr}`
        : (lastFinish === 'MAX_TOKENS' && !lastRaw
            ? 'El modelo consumió todo el presupuesto de tokens en su razonamiento interno y no llegó a escribir la respuesta (MAX_TOKENS con texto vacío). Subí GEMINI_MODEL a uno sin thinking, o el techo de tokens.'
        : (lastFinish === 'MAX_TOKENS' ? 'La respuesta se cortó por largo (MAX_TOKENS).'
        : (!lastRaw ? `El modelo no devolvió texto (finish_reason: ${lastFinish || 'desconocido'}).`
        : 'El modelo respondió pero no en JSON válido.')));
      parsed = { parse_error: true, finish_reason: lastFinish, model: usedModel, error: lastErr || null,
        raw: `${_why}${lastRaw ? '\n\n— Respuesta cruda —\n' + lastRaw.slice(0, 600) : ''}` };
    }

    res.json({ ok: true, response: parsed, finish_reason: lastFinish, model: usedModel });
  } catch (e) {
    console.error('Error en test-message:', e.response?.data || e.message);
    res.status(500).json({ error: 'No se pudo generar respuesta', details: e.response?.data?.error?.message || e.message });
  }
});

// =====================================================================
// CLONAR CONFIG (v0.9.7 Pieza 2)
// Copia la config completa (5 tablas) de un tenant origen a un tenant destino.
// Uso: cuando se crea un tenant nuevo, clonar la de SG Bolivia (tenant 1) como
// plantilla editable. El tenant destino NO debe tener config previa (si tiene,
// se rechaza salvo ?overwrite=true).
// =====================================================================
router.post('/admin/bot/clone-config', requireTenantSession, async (req, res) => {
  // v0.9.8 SEGURIDAD: clonar config entre tenants es SOLO super-admin.
  // Un cliente no puede clonar config hacia/desde otros tenants.
  if (req.isSuperAdmin !== true) {
    return res.status(403).json({ error: 'Solo el administrador puede clonar configuraciones entre cuentas.' });
  }
  const fromTenant = Number(req.body?.from_tenant_id) || 1; // default: clonar de SG Bolivia
  const toTenant = Number(req.body?.to_tenant_id);
  const overwrite = req.body?.overwrite === true;

  if (!Number.isInteger(toTenant) || toTenant < 1) {
    return res.status(400).json({ error: 'to_tenant_id requerido (entero > 0)' });
  }
  if (toTenant === fromTenant) {
    return res.status(400).json({ error: 'to_tenant_id no puede ser igual a from_tenant_id' });
  }

  const client = await db.pool.connect();
  try {
    // Validar que el tenant destino existe
    const tRes = await client.query('SELECT id, name FROM tenants WHERE id = $1', [toTenant]);
    if (tRes.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: `Tenant destino ${toTenant} no existe` });
    }

    // Validar que el destino no tenga config (a menos que overwrite)
    const existing = await client.query('SELECT 1 FROM bot_prompt_base WHERE tenant_id = $1', [toTenant]);
    if (existing.rows.length > 0 && !overwrite) {
      client.release();
      return res.status(409).json({
        error: `Tenant ${toTenant} ya tiene config. Usá overwrite:true para sobrescribir.`,
      });
    }

    await client.query('BEGIN');

    // Si overwrite, limpiar config previa del destino (en orden por las FKs)
    if (overwrite) {
      await client.query('DELETE FROM bot_proof_points WHERE tenant_id = $1', [toTenant]);
      await client.query('DELETE FROM bot_verticals WHERE tenant_id = $1', [toTenant]);
      await client.query('DELETE FROM bot_pricing_plans WHERE tenant_id = $1', [toTenant]);
      await client.query('DELETE FROM bot_global_config WHERE tenant_id = $1', [toTenant]);
      await client.query('DELETE FROM bot_prompt_base WHERE tenant_id = $1', [toTenant]);
    }

    // 1. prompt_base (1 fila)
    await client.query(`
      INSERT INTO bot_prompt_base (tenant_id, content, version, updated_at)
      SELECT $1, content, 1, NOW() FROM bot_prompt_base WHERE tenant_id = $2
    `, [toTenant, fromTenant]);

    // 2. verticals (deben ir antes que proof_points por la FK)
    await client.query(`
      INSERT INTO bot_verticals (tenant_id, vertical_id, display_name, tagline, ideal_client, problem_solved, features, keywords, differentiator, sort_order, active, created_at, updated_at)
      SELECT $1, vertical_id, display_name, tagline, ideal_client, problem_solved, features, keywords, differentiator, sort_order, active, NOW(), NOW()
      FROM bot_verticals WHERE tenant_id = $2
    `, [toTenant, fromTenant]);

    // 3. proof_points (referencian verticals del mismo tenant)
    await client.query(`
      INSERT INTO bot_proof_points (tenant_id, vertical_id, client_name, client_location, description, active, created_at, updated_at)
      SELECT $1, vertical_id, client_name, client_location, description, active, NOW(), NOW()
      FROM bot_proof_points WHERE tenant_id = $2
    `, [toTenant, fromTenant]);

    // 4. pricing_plans
    await client.query(`
      INSERT INTO bot_pricing_plans (tenant_id, plan_id, display_name, monthly_bs, target_description, includes, excludes, max_users, max_branches, support_hours, sort_order, recommended, active, created_at, updated_at)
      SELECT $1, plan_id, display_name, monthly_bs, target_description, includes, excludes, max_users, max_branches, support_hours, sort_order, recommended, active, NOW(), NOW()
      FROM bot_pricing_plans WHERE tenant_id = $2
    `, [toTenant, fromTenant]);

    // 5. global_config
    await client.query(`
      INSERT INTO bot_global_config (tenant_id, config_key, config_value, description, data_type, updated_at)
      SELECT $1, config_key, config_value, description, data_type, NOW()
      FROM bot_global_config WHERE tenant_id = $2
    `, [toTenant, fromTenant]);

    await client.query('COMMIT');

    // Invalidar cache del tenant destino e informar conteos
    promptBuilder.invalidateCache(toTenant);
    const counts = {};
    for (const t of ['bot_prompt_base', 'bot_verticals', 'bot_proof_points', 'bot_pricing_plans', 'bot_global_config']) {
      const r = await db.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE tenant_id = $1`, [toTenant]);
      counts[t] = r.rows[0].n;
    }

    client.release();
    res.json({
      ok: true,
      message: `Config clonada de tenant ${fromTenant} a tenant ${toTenant} (${tRes.rows[0].name})`,
      counts,
    });
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    console.error('Error clonando config:', e);
    res.status(500).json({ error: 'No se pudo clonar la config', details: e.message });
  }
});

// =====================================================================
// CONSUMO DE IA (v0.9.8) — para cobros por uso
// =====================================================================

/**
 * n8n reporta el consumo de tokens de cada respuesta de Gemini.
 * Protegido con el secret de n8n (no admin token).
 *
 * Body esperado (lo arma n8n con el usageMetadata de Gemini):
 *   {
 *     phone: "591...",            // opcional pero recomendado (resuelve el tenant)
 *     tenant_id: 1,               // opcional; si no viene, se resuelve por phone
 *     model: "gemini-2.5-flash",  // opcional
 *     prompt_tokens: 1234,        // usageMetadata.promptTokenCount
 *     output_tokens: 567,         // usageMetadata.candidatesTokenCount
 *     total_tokens: 1801          // usageMetadata.totalTokenCount
 *   }
 */
router.post('/bot/usage', requireN8nSecret, async (req, res) => {
  try {
    const b = req.body || {};
    let tenantId = Number(b.tenant_id) || null;
    const phone = b.phone || null;

    // Si no vino tenant_id, resolverlo por el phone (igual que el system-prompt)
    if (!tenantId && phone) {
      try {
        const tenant = await resolveTenantByPhone(phone);
        if (tenant) tenantId = tenant.id;
      } catch (e) {
        console.warn('[bot/usage] no se pudo resolver tenant por phone:', e.message);
      }
    }
    if (!tenantId) tenantId = 1; // fallback SG Bolivia

    const promptTokens = Number(b.prompt_tokens) || 0;
    const outputTokens = Number(b.output_tokens) || 0;
    // total: usar el que mande, o calcularlo
    const totalTokens = Number(b.total_tokens) || (promptTokens + outputTokens);

    await db.query(
      `INSERT INTO ai_usage (tenant_id, phone, model, prompt_tokens, output_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, phone, b.model || null, promptTokens, outputTokens, totalTokens]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[bot/usage] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * Lectura del consumo para el panel.
 *  - Super-admin (audit.): ve TODOS los tenants. Puede filtrar ?tenant_id=N.
 *  - Cliente (app.): ve solo SU tenant (forzado).
 * Filtro de período: ?month=YYYY-MM  (si no viene, devuelve total histórico + el mes actual).
 *
 * Devuelve, por tenant: conversaciones, mensajes in/out/total, tokens in/out/total.
 */
router.get('/admin/usage', requireTenantSession, async (req, res) => {
  try {
    // Determinar scope de tenant (seguridad: cliente solo el suyo)
    let tenantFilterId = null; // null = todos (solo super-admin)
    if (req.isSuperAdmin === false && req.tenantId) {
      tenantFilterId = Number(req.tenantId);            // cliente: forzado a su tenant
    } else if (req.query.tenant_id) {
      tenantFilterId = Number(req.query.tenant_id);     // super-admin filtrando uno
    }

    // Período: ?month=YYYY-MM → rango [inicio de mes, inicio del mes siguiente)
    const month = (req.query.month || '').trim(); // ej "2026-05"

    // 1) Lista de tenants (para nombres)
    const tenantsRes = await db.query(
      tenantFilterId
        ? `SELECT id, name, active FROM tenants WHERE id = $1 ORDER BY id`
        : `SELECT id, name, active FROM tenants ORDER BY id`,
      tenantFilterId ? [tenantFilterId] : []
    );

    // 2) Mensajes por tenant y dirección (vía conversations)
    //    Construyo el filtro de mes sobre messages.created_at
    let msgDateClause = '';
    const msgParams = [];
    let pIdx = 1;
    const tFilterMsg = tenantFilterId ? ` AND c.tenant_id = $${pIdx++}` : '';
    if (tenantFilterId) msgParams.push(tenantFilterId);
    if (/^\d{4}-\d{2}$/.test(month)) {
      msgDateClause = ` AND m.created_at >= $${pIdx}::date AND m.created_at < ($${pIdx + 1}::date + interval '1 month')`;
      msgParams.push(`${month}-01`, `${month}-01`);
      pIdx += 2;
    }
    const msgRes = await db.query(
      `SELECT c.tenant_id,
              COUNT(*) FILTER (WHERE m.direction = 'incoming') AS msgs_in,
              COUNT(*) FILTER (WHERE m.direction = 'outgoing') AS msgs_out,
              COUNT(*)                                          AS msgs_total
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE 1=1 ${tFilterMsg} ${msgDateClause}
       GROUP BY c.tenant_id`,
      msgParams
    );

    // 3) Conversaciones por tenant (con actividad en el período si hay filtro)
    let convDateClause = '';
    const convParams = [];
    let cIdx = 1;
    const tFilterConv = tenantFilterId ? ` AND tenant_id = $${cIdx++}` : '';
    if (tenantFilterId) convParams.push(tenantFilterId);
    if (/^\d{4}-\d{2}$/.test(month)) {
      convDateClause = ` AND last_message_at >= $${cIdx}::date AND last_message_at < ($${cIdx + 1}::date + interval '1 month')`;
      convParams.push(`${month}-01`, `${month}-01`);
      cIdx += 2;
    }
    const convRes = await db.query(
      `SELECT tenant_id, COUNT(*) AS conversations
       FROM conversations
       WHERE 1=1 ${tFilterConv} ${convDateClause}
       GROUP BY tenant_id`,
      convParams
    );

    // 4) Tokens por tenant (de ai_usage)
    let tokDateClause = '';
    const tokParams = [];
    let kIdx = 1;
    const tFilterTok = tenantFilterId ? ` AND tenant_id = $${kIdx++}` : '';
    if (tenantFilterId) tokParams.push(tenantFilterId);
    if (/^\d{4}-\d{2}$/.test(month)) {
      tokDateClause = ` AND created_at >= $${kIdx}::date AND created_at < ($${kIdx + 1}::date + interval '1 month')`;
      tokParams.push(`${month}-01`, `${month}-01`);
      kIdx += 2;
    }
    const tokRes = await db.query(
      `SELECT tenant_id,
              COALESCE(SUM(prompt_tokens),0) AS tokens_in,
              COALESCE(SUM(output_tokens),0) AS tokens_out,
              COALESCE(SUM(total_tokens),0)  AS tokens_total,
              COUNT(*)                        AS ai_calls
       FROM ai_usage
       WHERE 1=1 ${tFilterTok} ${tokDateClause}
       GROUP BY tenant_id`,
      tokParams
    );

    // Mapear todo por tenant_id
    const byTenant = {};
    for (const t of tenantsRes.rows) {
      byTenant[t.id] = {
        tenant_id: t.id,
        name: t.name,
        active: t.active,
        conversations: 0,
        msgs_in: 0, msgs_out: 0, msgs_total: 0,
        tokens_in: 0, tokens_out: 0, tokens_total: 0,
        ai_calls: 0,
      };
    }
    function ensure(id) {
      if (!byTenant[id]) byTenant[id] = { tenant_id: id, name: `Tenant ${id}`, active: null, conversations: 0, msgs_in: 0, msgs_out: 0, msgs_total: 0, tokens_in: 0, tokens_out: 0, tokens_total: 0, ai_calls: 0 };
      return byTenant[id];
    }
    for (const r of msgRes.rows) { const o = ensure(r.tenant_id); o.msgs_in = Number(r.msgs_in); o.msgs_out = Number(r.msgs_out); o.msgs_total = Number(r.msgs_total); }
    for (const r of convRes.rows) { ensure(r.tenant_id).conversations = Number(r.conversations); }
    for (const r of tokRes.rows) { const o = ensure(r.tenant_id); o.tokens_in = Number(r.tokens_in); o.tokens_out = Number(r.tokens_out); o.tokens_total = Number(r.tokens_total); o.ai_calls = Number(r.ai_calls); }

    const rows = Object.values(byTenant).sort((a, b) => a.tenant_id - b.tenant_id);

    res.json({
      month: /^\d{4}-\d{2}$/.test(month) ? month : null,
      is_super_admin: req.isSuperAdmin === true,
      tenants: rows,
    });
  } catch (e) {
    console.error('[admin/usage] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
