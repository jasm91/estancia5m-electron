/**
 * comment-reply-ai.js — v0.9.568/569
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPUESTA A COMENTARIOS DE FB/IG GENERADA POR IA (Gemini directo, sin n8n).
 *
 * Antes (v0.9.566/567) la respuesta pública era UN texto fijo por tenant: se
 * repetía literal en cada comentario, lo que se lee como bot y no responde nada.
 * Acá se genera con contexto real:
 *   · negocio (nombre, rubro/modo activo, tono y nombre del bot)
 *   · perfil general del bot (bot_global_config → horarios, dirección, envíos…)
 *   · texto del POST comentado (Graph API, best-effort, cacheado)
 *   · el comentario en sí y quién lo escribió
 *   · las últimas respuestas públicas del tenant → para NO repetir la misma frase
 *
 * Devuelve DOS textos en una sola llamada (mismo costo de tokens):
 *   publica  → lo que se publica sobre el comentario (si el switch está ON)
 *   privado  → el DM que abre la conversación (reemplaza el saludo fijo)
 *
 * Guardarraíles duros (van en el prompt Y en el sanitizado):
 *   · NUNCA inventar precios, stock, plazos, promos ni políticas.
 *   · NUNCA pedir datos personales en público.
 *   · Sin links, sin markdown, 1 emoji máximo, ≤ 220 caracteres.
 *   · Reclamo → disculpa breve + se hace cargo + avisa que escribió por privado.
 *   · Spam / insulto / bot → publica = null (no se responde en público).
 *
 * Todo es best-effort: si no hay GEMINI_API_KEY, si el tenant tiene la IA
 * apagada o si Gemini falla, devuelve null y el webhook usa los textos fijos
 * de siempre (cero regresión).
 */
const db = require('./db');
const axios = require('axios');

const _GEM_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const _GEM_FALLBACK = process.env.GEMINI_MODEL_FALLBACK_BACKEND || 'gemini-flash-latest';

const CTX_TTL_MS = 5 * 60 * 1000;   // contexto del negocio
const POST_TTL_MS = 30 * 60 * 1000; // texto del post (casi nunca cambia)
const _ctxCache = new Map();
const _postCache = new Map();

function _cacheGet(map, key, ttl) {
  const hit = map.get(key);
  if (hit && (Date.now() - hit.t) < ttl) return hit.v;
  return undefined;
}
function _cacheSet(map, key, v) {
  map.set(key, { t: Date.now(), v });
  if (map.size > 500) { const k = map.keys().next().value; map.delete(k); }
}

/** Columnas nuevas (idempotente). Se llama al boot desde server.js. */
async function ensureSchema() {
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_enabled boolean NOT NULL DEFAULT false`).catch(() => {});
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_text text`).catch(() => {});
  // v0.9.568 — 'ai' (default) = la IA redacta cada respuesta · 'fixed' = texto fijo de siempre
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_mode text NOT NULL DEFAULT 'ai'`).catch(() => {});
  await db.query(`ALTER TABLE channel_comments ADD COLUMN IF NOT EXISTS reply_text TEXT`).catch(() => {});
  // v0.9.569 — último error de Meta al publicar (para avisarle al dueño en el panel
  // en vez de fallar en silencio, como pasó con pages_manage_engagement).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_error text`).catch(() => {});
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_error_at timestamptz`).catch(() => {});
}

/** ¿El error de Meta es "falta el permiso" (no un problema del texto)? */
function isPermissionError(msg) {
  return /#200|#10\b|pages_manage_engagement|pages_read_user_content|pages_read_engagement|App Review|not available|permiss/i.test(String(msg || ''));
}

/** Traduce el error crudo de Meta a algo que el dueño entienda y pueda accionar. */
function explainMetaError(msg, channel) {
  const raw = String(msg || '').slice(0, 300);
  if (isPermissionError(raw)) {
    return (channel === 'instagram'
      ? 'Meta todavía no le dio a la app el permiso para responder comentarios de Instagram en público (instagram_manage_comments).'
      : 'A la conexión de esta página le falta el permiso de Meta para publicar respuestas en los comentarios (pages_manage_engagement + pages_read_engagement).')
      + ' El mensaje privado sí se envió. Agregá esos permisos en la configuración de Facebook Login de la app y reconectá la página en Config → Canales.'
      + ` [Meta: ${raw}]`;
  }
  return `Meta rechazó la respuesta pública. [Meta: ${raw}]`;
}

const MODE_LABEL = {
  realestate_bot_enabled: 'venta y alquiler de inmuebles',
  inventory_bot_enabled: 'venta de artículos con catálogo y stock',
  software_bot_enabled: 'venta de software / sistema por suscripción',
  services_bot_enabled: 'servicios con reserva de turnos',
  salud_bot_enabled: 'servicios de salud con turnos',
  belleza_bot_enabled: 'servicios de belleza y estética con turnos',
  restaurante_bot_enabled: 'restaurante / pedidos de comida',
  vehiculos_bot_enabled: 'venta de vehículos',
  arquitectura_bot_enabled: 'estudio de arquitectura y proyectos',
};

/** Contexto del negocio (cacheado 5 min por tenant). */
async function _businessContext(tenantId) {
  const hit = _cacheGet(_ctxCache, tenantId, CTX_TTL_MS);
  if (hit !== undefined) return hit;
  const ctx = { name: '', botName: 'Aitana', tone: null, modes: [], profile: [] };
  try {
    const t = await db.query(`SELECT name,
        to_jsonb(tenants) ->> 'bot_name' AS bot_name,
        to_jsonb(tenants) ->> 'bot_tone' AS bot_tone,
        to_jsonb(tenants) AS j
      FROM tenants WHERE id = $1`, [tenantId]);
    const row = t.rows[0];
    if (row) {
      ctx.name = row.name || '';
      ctx.botName = row.bot_name || 'Aitana';
      ctx.tone = row.bot_tone || null;
      const j = row.j || {};
      for (const k of Object.keys(MODE_LABEL)) {
        if (String(j[k]) === 'true') ctx.modes.push(MODE_LABEL[k]);
      }
    }
  } catch (e) { /* tenant sin columnas nuevas → contexto mínimo */ }
  try {
    // Perfil general que cargó el dueño (horarios, dirección, envíos, formas de pago…)
    const g = await db.query(
      `SELECT config_key, config_value FROM bot_global_config
        WHERE tenant_id = $1 AND COALESCE(config_value,'') <> '' LIMIT 14`, [tenantId]);
    ctx.profile = g.rows.map(r => `${r.config_key}: ${String(r.config_value).replace(/\s+/g, ' ').slice(0, 140)}`);
  } catch (e) { /* sin perfil general */ }
  _cacheSet(_ctxCache, tenantId, ctx);
  return ctx;
}

/** Texto del post comentado (FB: message · IG: caption). Best-effort. */
async function _postText(channel, postId, token) {
  if (!postId || !token) return '';
  const key = `${channel}:${postId}`;
  const hit = _cacheGet(_postCache, key, POST_TTL_MS);
  if (hit !== undefined) return hit;
  let txt = '';
  try {
    const fields = channel === 'instagram' ? 'caption' : 'message,story';
    const r = await axios.get(`https://graph.facebook.com/v21.0/${encodeURIComponent(String(postId))}`,
      { params: { fields, access_token: token }, timeout: 8000 });
    txt = String(r.data?.caption || r.data?.message || r.data?.story || '').replace(/\s+/g, ' ').slice(0, 500);
  } catch (e) { txt = ''; }
  _cacheSet(_postCache, key, txt);
  return txt;
}

/** Últimas respuestas públicas del tenant → antirrepetición. */
async function _recentReplies(tenantId) {
  try {
    const r = await db.query(
      `SELECT reply_text FROM channel_comments
        WHERE tenant_id = $1 AND COALESCE(reply_text,'') <> ''
        ORDER BY id DESC LIMIT 6`, [tenantId]);
    return r.rows.map(x => String(x.reply_text).replace(/\s+/g, ' ').slice(0, 160)).filter(Boolean);
  } catch (e) { return []; }
}

const TONE_LINE = {
  cercano: 'Tono cálido y cercano, tuteando con naturalidad.',
  profesional: 'Tono profesional y prolijo: serio, claro y amable, sin informalidades.',
  vendedor: 'Tono proactivo, orientado a que la persona siga la charla por privado, sin ser insistente.',
};

/** Limpieza dura de lo que devuelve el modelo antes de publicarlo. */
function _sanitize(s, max) {
  if (!s) return null;
  let out = String(s)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/gi, '')          // sin links en público
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[*_#`>]/g, '')                  // sin markdown
    .replace(/\s+/g, ' ')
    .trim();
  if (!out || out.length < 3) return null;
  if (/^(null|none|n\/a|skip)$/i.test(out)) return null;
  if (out.length > max) out = out.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

/**
 * Genera las dos respuestas. Devuelve null si no se pudo (→ fallback fijo).
 * @returns {Promise<{publica: string|null, privado: string|null, tipo: string}|null>}
 */
async function generate({ tenantId, channel, commentText, fromName, postId, token, styleHint, wantPublic }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  // Master switch de IA del tenant (mismo gate que el bot)
  try {
    const g = await db.query('SELECT COALESCE(ai_enabled, TRUE) AS on FROM tenants WHERE id = $1', [tenantId]);
    if (g.rows[0] && g.rows[0].on === false) return null;
  } catch (e) { /* columna inexistente → sigue */ }

  const comment = String(commentText || '').replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!comment) return null;

  const [ctx, post, prev] = await Promise.all([
    _businessContext(tenantId),
    _postText(channel, postId, token),
    _recentReplies(tenantId),
  ]);

  const red = channel === 'instagram' ? 'Instagram' : 'Facebook';
  const prompt = `Sos ${ctx.botName}, quien atiende las redes de "${ctx.name || 'el negocio'}" en Bolivia.
Alguien dejó un COMENTARIO PÚBLICO en un post de ${red} y tenés que redactar DOS textos.

NEGOCIO
- Rubro: ${ctx.modes.length ? ctx.modes.join(' + ') : 'venta y atención al cliente'}
- ${TONE_LINE[ctx.tone] || 'Tono cálido y cercano, tuteando con naturalidad.'}
${ctx.profile.length ? '- Datos cargados por el dueño (ÚNICA fuente de datos duros):\n  ' + ctx.profile.join('\n  ') : '- No hay datos duros cargados: no des ninguno.'}

POST COMENTADO
${post || '(no disponible)'}

COMENTARIO DE ${fromName ? fromName.toUpperCase() : 'UN SEGUIDOR'}
"${comment}"
${styleHint ? `\nINDICACIÓN DEL DUEÑO PARA LA RESPUESTA PÚBLICA (respetala):\n"${String(styleHint).slice(0, 200)}"` : ''}
${prev.length ? `\nYA RESPONDISTE ESTO EN COMENTARIOS ANTERIORES — NO repitas estas frases ni su estructura:\n- ${prev.join('\n- ')}` : ''}

DEVOLVÉ SOLO ESTE JSON (sin markdown):
{"tipo":"consulta|reclamo|elogio|spam","publica":"...","privado":"..."}

REGLAS DE "publica" (la lee CUALQUIERA, queda en tu página):
1. Máximo 220 caracteres, 1 o 2 frases, español boliviano natural. Máximo 1 emoji. Sin links, sin hashtags, sin markdown.
2. RESPONDÉ de verdad lo que preguntó, pero SOLO con lo que está arriba. Si el dato NO está (precio, stock, talles, plazo, promo, política), NO lo inventes: decí en una frase que se lo pasás por privado.
3. Si "tipo" es reclamo: disculpate corto y sincero, hacete cargo, sin excusas ni discutir, y avisá que ya le escribiste por privado para resolverlo.
4. Si "tipo" es elogio: agradecé breve y personal, sin vender nada.
5. Si "tipo" es spam, publicidad de terceros, insulto o provocación: poné "publica": null.
6. NO pidas teléfono, correo, dirección ni ningún dato personal en público.
7. NO empieces siempre igual: variá el arranque respecto de las frases anteriores que te pasé. Nada de plantillas.
8. Usá el nombre de la persona solo si suena natural.

REGLAS DE "privado" (primer mensaje del chat, arranca la conversación):
9. Máximo 320 caracteres. Mencioná lo que comentó (concreto, no "vi tu comentario" a secas) y hacé UNA sola pregunta que avance la venta o la solución.
10. Mismas reglas de no inventar datos. Sin links.`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.85, topP: 0.95, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
  };

  let data = null, usedModel = _GEM_MODEL;
  for (const model of [_GEM_MODEL, _GEM_FALLBACK]) {
    try {
      const r = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        body, { timeout: 20000 });
      data = r.data; usedModel = model; break;
    } catch (e) {
      console.warn(`[comment-ai] ${model} falló:`, e.response?.data?.error?.message || e.message);
    }
  }
  if (!data) return null;

  // Consumo → ai_usage (billing por tenant, igual que el resto del backend)
  try {
    const u = data.usageMetadata || {};
    await db.query(
      `INSERT INTO ai_usage (tenant_id, model, prompt_tokens, output_tokens, total_tokens) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, usedModel, Number(u.promptTokenCount) || 0, Number(u.candidatesTokenCount) || 0,
       Number(u.totalTokenCount) || 0]
    );
  } catch (e) { /* log no bloqueante */ }

  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed;
  try { parsed = JSON.parse(m[0]); } catch (e) { return null; }

  const tipo = String(parsed.tipo || 'consulta').toLowerCase();
  const out = {
    tipo,
    publica: tipo === 'spam' ? null : _sanitize(parsed.publica, 240),
    privado: _sanitize(parsed.privado, 340),
  };
  if (!wantPublic) out.publica = null;
  if (!out.publica && !out.privado) return null;
  return out;
}

module.exports = { ensureSchema, generate, isPermissionError, explainMetaError, _sanitize };
