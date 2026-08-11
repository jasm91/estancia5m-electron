/**
 * Endpoints internos:
 *   - n8n: enviar mensajes, crear leads, descargar media de Meta
 *   - Panel admin: ver conversaciones, mensajes, leads, cambiar modo
 */

// v0.9.354 — modelo Gemini vigente (Google retiró gemini-2.5-flash el 9-jul-2026 con 404 intermitente y gemini-1.5 está muerto). Configurable por env sin redeploy.
const _GEM_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const _GEM_FALLBACK = process.env.GEMINI_MODEL_FALLBACK_BACKEND || 'gemini-flash-latest';

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const meta = require('./meta');
const r2 = require('./r2');
const agenda = require('./agenda'); // v0.9.514 — reglas de la agenda (fuente única)
const vehiclePdfImport = require('./vehicle-pdf-import'); // v0.9.410 — importador de ficha PDF (Nissan)
const multer = require('multer');
const { resolveTenantByPhone, getTenantMetaCtx, getConversationMetaCtx, invalidateLineCtxCache, invalidatePhoneNumberIdCache } = require('./tenant-resolver'); // v0.9.13 multi-línea
const { decryptSafe } = require('./crypto'); // v0.9.9 plantillas
const { requireTenantSession, requireRole } = require('./auth'); // v0.9.8 multi-tenant auth · v0.9.12 roles
const supportTickets = require('./support-tickets'); // v0.9.113 mesa de soporte (BPO)

// Multer: archivos en memoria (no en disco), límite 25 MB para soportar videos cortos
// v0.9.45 (auditoría A-2): fileFilter — bloquea tipos ejecutables en el navegador.
// R2 sirve los archivos con el Content-Type subido: un HTML/SVG/JS "disfrazado de
// imagen" sería XSS almacenado al abrir la URL directa.
const BLOCKED_UPLOAD_TYPES = /text\/html|application\/xhtml|image\/svg|javascript|application\/x-/i;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },  // 25 MB
  fileFilter: (req, file, cb) => {
    const mt = String(file.mimetype || '');
    const name = String(file.originalname || '');
    if (BLOCKED_UPLOAD_TYPES.test(mt) || /\.(html?|svg|js|mjs|php|sh|exe)$/i.test(name)) {
      return cb(new Error(`Tipo de archivo no permitido: ${mt || name}`));
    }
    cb(null, true);
  },
});

// v0.9.264 — validación de tamaño por tipo (límites de WhatsApp/Meta). Las imágenes se comprimen
// solas (image-tools.js); video/audio/documentos que excedan el límite se RECHAZAN con un mensaje
// claro. Se usa como middleware DESPUÉS de multer en cada ruta de subida.
const { mediaLimitError } = require('./media-limits');
function metaMediaGuard(req, res, next) {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) files.push(...req.files);
  else if (req.files && typeof req.files === 'object') for (const k of Object.keys(req.files)) files.push(...(req.files[k] || []));
  for (const f of files) {
    const msg = mediaLimitError(f.mimetype, f.size, f.originalname);
    if (msg) return res.status(422).json({ error: msg });
  }
  next();
}

const N8N_SHARED_SECRET = process.env.N8N_SHARED_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

const router = express.Router();

// =============================================================
// Middlewares
// =============================================================

// v0.9.44 (auditoría C-2): comparación de secretos en tiempo constante.
// `!==` permite timing attacks; timingSafeEqual exige buffers del mismo largo,
// por eso se comparan hashes SHA-256 (largo fijo) de ambos valores.
const nodeCrypto = require('crypto');
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ha = nodeCrypto.createHash('sha256').update(a).digest();
  const hb = nodeCrypto.createHash('sha256').update(b).digest();
  return nodeCrypto.timingSafeEqual(ha, hb);
}

function requireN8nSecret(req, res, next) {
  const provided = req.headers['x-crm-secret'];
  if (!N8N_SHARED_SECRET || !safeEqual(String(provided || ''), N8N_SHARED_SECRET)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function requireAdminToken(req, res, next) {
  // Acepta token en header o query string (para el panel)
  const token = req.headers['x-admin-token'] || req.query.token;
  if (!ADMIN_TOKEN || !safeEqual(String(token || ''), ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ============ v0.9.180 — AUDITORÍA AUTOMÁTICA ============
// Registra TODA acción que ESCRIBE datos (POST/PATCH/PUT/DELETE) con tenant, usuario,
// endpoint, recurso (heurístico del path) y un resumen del body (secretos redactados).
// 100% defensivo: corre en res.on('finish') con try/catch → NUNCA tira ni bloquea la request.
const AUDIT_SKIP = /\/(audit-logs|push\/|presence|health|version|assistant\/ask)/i;
const AUDIT_REDACT = /pass|password|token|secret|api_?key|authorization|p256dh|vapid/i;
function _auditSummary(body) {
  try {
    if (!body || typeof body !== 'object') return null;
    const out = {}; let n = 0;
    for (const k of Object.keys(body)) {
      if (n >= 14) break;
      if (AUDIT_REDACT.test(k)) { out[k] = '***'; n++; continue; }
      let v = body[k];
      if (v && typeof v === 'object') v = Array.isArray(v) ? `[${v.length} items]` : '{…}';
      else v = String(v == null ? '' : v).slice(0, 120);
      out[k] = v; n++;
    }
    return JSON.stringify(out).slice(0, 1000);
  } catch (e) { return null; }
}
function _auditResource(path) {
  try {
    const m = String(path || '').replace(/^\/api/, '').match(/^\/(?:admin|bot)\/([a-z0-9_-]+)/i);
    return m ? m[1].toLowerCase().replace(/-/g, '_') : null;
  } catch (e) { return null; }
}
router.use((req, res, next) => {
  const method = req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (AUDIT_SKIP.test(req.path || '')) return next();
  const bodySummary = _auditSummary(req.body); // capturar antes de que el handler lo modifique
  res.on('finish', () => {
    try {
      if (res.statusCode >= 400) return; // solo acciones exitosas
      const isAdmin = !!(req.headers['x-admin-token'] && ADMIN_TOKEN);
      const tenantId = req.tenantId || null;
      if (!tenantId && !isAdmin) return; // no identificable → no se loguea
      const userName = req.userName || req.userEmail || (isAdmin && !req.userId ? 'SuperAdmin' : null);
      db.query(
        `INSERT INTO audit_logs (tenant_id, user_id, user_name, method, path, resource, action, summary, status_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, req.userId || null, userName, method, (req.originalUrl || req.path || '').slice(0, 300),
         _auditResource(req.path), ({ POST: 'create', PATCH: 'update', PUT: 'update', DELETE: 'delete' })[method] || method.toLowerCase(),
         bodySummary, res.statusCode]
      ).catch(() => {});
    } catch (e) { /* nunca romper la request por la auditoría */ }
  });
  next();
});

// GET /api/admin/audit-logs — consulta de auditoría (super-admin). Filtros: tenant_id, user_id,
// resource, action, q (texto), from, to, limit.
router.get('/admin/audit-logs', requireAdminToken, async (req, res) => {
  try {
    const where = ['1=1']; const vals = []; const P = () => '$' + vals.length;
    if (req.query.tenant_id) { vals.push(parseInt(req.query.tenant_id, 10) || 0); where.push('a.tenant_id = ' + P()); }
    if (req.query.user_id) { vals.push(parseInt(req.query.user_id, 10) || 0); where.push('a.user_id = ' + P()); }
    if (req.query.resource) { vals.push(String(req.query.resource).toLowerCase()); where.push('a.resource = ' + P()); }
    if (req.query.action) { vals.push(String(req.query.action).toLowerCase()); where.push('a.action = ' + P()); }
    if (req.query.q) { vals.push('%' + String(req.query.q).slice(0, 80) + '%'); where.push('(a.path ILIKE ' + P() + ' OR a.summary ILIKE ' + P() + ' OR a.user_name ILIKE ' + P() + ')'); }
    if (req.query.from) { vals.push(req.query.from); where.push('a.created_at >= ' + P() + '::timestamptz'); }
    if (req.query.to) { vals.push(req.query.to); where.push('a.created_at <= ' + P() + '::timestamptz'); }
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 200));
    const r = await db.query(
      `SELECT a.id, a.tenant_id, a.user_id, COALESCE(u.display_name, a.user_name) AS user_display,
              a.method, a.path, a.resource, a.action, a.summary, a.status_code, a.created_at, t.name AS tenant_name
         FROM audit_logs a LEFT JOIN tenant_users u ON u.id = a.user_id LEFT JOIN tenants t ON t.id = a.tenant_id
        WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ${limit}`, vals);
    res.json({ ok: true, logs: r.rows });
  } catch (e) {
    if (/audit_logs|does not exist|column/i.test(e.message)) return res.json({ ok: true, logs: [], need_migration: true });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// v0.9.520 — DIAGNÓSTICO "¿por qué la IA no contestó?" (super-admin/soporte)
// Se pega un número (con o sin +591) y devuelve, por cada conversación que
// coincide, el motivo EXACTO por el que Aitana respondió o se quedó callada:
// master switch, IA por línea/canal, alcance (all/ads_only), origen-anuncio,
// modo humano explícito, etc. Replica la MISMA lógica del webhook para que el
// veredicto sea idéntico a lo que decide el bot en vivo.
// ============================================================
router.get('/admin/diag/why-silent', requireAdminToken, async (req, res) => {
  try {
    const raw = String(req.query.phone || '').trim();
    const digits = raw.replace(/[^0-9]/g, '');
    if (digits.length < 6) return res.status(400).json({ ok: false, error: 'Pasá un número válido (ej: 59177303552 o 77303552)' });
    // últimos 8 dígitos = número boliviano local; matcheamos por sufijo para
    // tolerar que lo peguen con o sin 591.
    const suffix = digits.slice(-8);
    const tenantId = parseInt(req.query.tenant_id, 10) || null;

    const params = [suffix];
    let tclause = '';
    if (tenantId) { params.push(tenantId); tclause = ` AND c.tenant_id = $${params.length}`; }

    const r = await db.query(
      `SELECT to_jsonb(c) AS j,
              t.name AS tenant_name,
              COALESCE(t.ai_enabled, TRUE) AS tenant_ai_enabled,
              to_jsonb(t) ->> 'ai_scope' AS tenant_scope,
              tl.label AS line_label,
              tl.ai_enabled AS line_ai_enabled_raw,
              to_jsonb(tl) ->> 'ai_scope' AS line_scope,
              (SELECT reason FROM handover_requests hr
                 WHERE hr.conversation_id = c.id
                   AND hr.reason IN ('admin_takeover','returned_to_bot','client_requested_human')
                 ORDER BY hr.id DESC LIMIT 1) AS last_handover,
              (SELECT MAX(m.created_at) FROM messages m
                 WHERE m.conversation_id = c.id AND m.direction = 'in') AS last_in_at
         FROM conversations c
         JOIN tenants t ON t.id = c.tenant_id
         LEFT JOIN tenant_lines tl ON tl.id = c.line_id
        WHERE regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE '%' || $1${tclause}
        ORDER BY c.updated_at DESC NULLS LAST
        LIMIT 20`, params);

    const chan = (c) => (c.channel ? String(c.channel).toLowerCase() : 'whatsapp');

    const out = r.rows.map((row) => {
      const c = row.j || {};
      const scope = (row.line_scope === 'ads_only' || row.line_scope === 'all')
        ? row.line_scope
        : (row.tenant_scope === 'ads_only' ? 'ads_only' : 'all');
      const masterOn = row.tenant_ai_enabled !== false;
      const lineOn = row.line_ai_enabled_raw !== false; // NULL => TRUE
      const channel = chan(c);
      const fromAds = c.ai_origin === 'ads' || c.ai_origin === 'campaign'
        || !!c.referral || !!c.campaign_ref;
      const explicitHuman = !!row.last_handover && row.last_handover !== 'returned_to_bot';

      // Veredicto en el MISMO orden que evalúa el webhook.
      let answered = null, reason = '', fix = '';
      if (!masterOn) {
        answered = false;
        reason = 'IA en pausa por el MASTER SWITCH del tenant (tenants.ai_enabled = false).';
        fix = 'Prendé el master switch de la IA para este cliente.';
      } else if (!lineOn) {
        answered = false;
        reason = 'La IA está APAGADA en esta línea de WhatsApp (tenant_lines.ai_enabled = false).';
        fix = 'Activá la IA en esa línea.';
      } else if (scope === 'ads_only' && !fromAds) {
        answered = false;
        reason = 'La línea está en alcance SOLO-ANUNCIOS (ads_only) y este chat NO se detectó como originado en un anuncio (no llegó referral / ctwa_clid ni campaign_ref). → “humano silencioso”.';
        fix = 'Si este chat SÍ vino de un anuncio, es una falla de detección (típico en coexistence): extender la reactivación a otras señales. Si querés que conteste a todos, cambiá el alcance de la línea a “all”.';
      } else if (c.mode === 'human' && explicitHuman) {
        answered = false;
        reason = `El chat está en modo HUMANO explícito (handover: ${row.last_handover}). El bot no pisa a un agente que tomó el control.`;
        fix = 'Devolvé el chat a la IA desde el panel si querés que Aitana siga.';
      } else if (c.mode === 'human') {
        answered = false;
        reason = 'El chat está en modo HUMANO (sin handover explícito registrado). No se despacha al bot.';
        fix = 'Pasalo a modo bot si corresponde.';
      } else {
        answered = true;
        reason = scope === 'ads_only'
          ? 'Detectado como lead de ANUNCIO en una línea ads_only → Aitana responde.'
          : 'Alcance “all” y modo bot → Aitana responde a este chat.';
      }

      return {
        conversation_id: c.id,
        tenant_id: c.tenant_id,
        tenant: row.tenant_name,
        phone: c.phone,
        contact_name: c.contact_name || null,
        line_id: c.line_id || null,
        line: row.line_label || null,
        channel,
        mode: c.mode,
        status: c.status,
        ai_scope: scope,
        master_switch_on: masterOn,
        line_ai_on: lineOn,
        ai_origin: c.ai_origin || null,
        referral: c.referral || null,
        campaign_ref: c.campaign_ref || null,
        ad_property_id: c.ad_property_id || null,
        detected_from_ad: fromAds,
        explicit_human_takeover: explicitHuman,
        last_inbound_at: row.last_in_at || null,
        updated_at: c.updated_at || null,
        answered_by_bot: answered,
        reason,
        fix,
      };
    });

    res.json({ ok: true, query: raw, matched: out.length, conversations: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/audit-logs/export — CSV (super-admin).
router.get('/admin/audit-logs/export', requireAdminToken, async (req, res) => {
  try {
    const where = ['1=1']; const vals = []; const P = () => '$' + vals.length;
    if (req.query.tenant_id) { vals.push(parseInt(req.query.tenant_id, 10) || 0); where.push('a.tenant_id = ' + P()); }
    if (req.query.from) { vals.push(req.query.from); where.push('a.created_at >= ' + P() + '::timestamptz'); }
    if (req.query.to) { vals.push(req.query.to); where.push('a.created_at <= ' + P() + '::timestamptz'); }
    const r = await db.query(
      `SELECT a.created_at, a.tenant_id, COALESCE(u.display_name, a.user_name) AS usuario, a.action, a.resource, a.method, a.path, a.status_code, a.summary
         FROM audit_logs a LEFT JOIN tenant_users u ON u.id = a.user_id WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT 5000`, vals);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const head = ['fecha', 'tenant', 'usuario', 'accion', 'recurso', 'metodo', 'path', 'status', 'resumen'];
    const lines = [head.join(',')].concat(r.rows.map(x => [x.created_at, x.tenant_id, x.usuario, x.action, x.resource, x.method, x.path, x.status_code, x.summary].map(esc).join(',')));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="audit-logs.csv"');
    res.send('﻿' + lines.join('\n'));
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
// ============ FIN AUDITORÍA ============

// ============ v0.9.181 — SNAPSHOTS (respaldos por tenant) ============
// Vuelca TODAS las tablas con columna tenant_id (datos operativos del tenant) a un JSON,
// gzip, guardado en la DB (privado). No incluye logs/snapshots/suscripciones push.
const SNAPSHOT_SKIP_TABLES = new Set(['audit_logs', 'db_snapshots', 'push_subscriptions']);
async function _dumpTenant(tenantId) {
  const tc = await db.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='tenant_id' ORDER BY table_name`);
  const tables = tc.rows.map(r => r.table_name).filter(t => !SNAPSHOT_SKIP_TABLES.has(t));
  const data = {}; let rows = 0;
  for (const t of tables) {
    try {
      const r = await db.query(`SELECT * FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
      data[t] = r.rows; rows += r.rows.length;
    } catch (e) { /* tabla problemática → omitir, no romper el snapshot */ }
  }
  return { version: 1, tenant_id: tenantId, created_at: new Date().toISOString(), tables: Object.keys(data), data, rows };
}
async function _createSnapshot(tenantId, trigger, note, createdBy) {
  const zlib = require('zlib');
  const dump = await _dumpTenant(tenantId);
  const json = Buffer.from(JSON.stringify(dump));
  const gz = zlib.gzipSync(json);
  const ins = await db.query(
    `INSERT INTO db_snapshots (tenant_id, trigger, note, data_gz, size_bytes, tables_count, rows_count, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [tenantId, trigger || 'manual', note || null, gz, json.length, dump.tables.length, dump.rows, createdBy || null]);
  // v0.9.219 — retención CONFIGURABLE por tenant (tenants.snapshot_retention, default 6). Al pasar
  // del límite se borra el más viejo (rota). Defensivo: si la columna no existe todavía, usa 6.
  const _retq = await db.query(`SELECT COALESCE((to_jsonb(tenants)->>'snapshot_retention')::int, 6) AS n FROM tenants WHERE id = $1`, [tenantId]).catch(() => ({ rows: [] }));
  const _keep = Math.min(Math.max(Number(_retq.rows[0] && _retq.rows[0].n) || 6, 1), 50);
  await db.query(
    `DELETE FROM db_snapshots WHERE tenant_id = $1 AND id NOT IN
       (SELECT id FROM db_snapshots WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2)`, [tenantId, _keep]).catch(() => {});
  return { id: ins.rows[0].id, created_at: ins.rows[0].created_at, size_bytes: json.length, gz_bytes: gz.length, tables: dump.tables.length, rows: dump.rows };
}

// POST /api/admin/snapshots/create?tenant_id=ID — snapshot manual (super-admin).
router.post('/admin/snapshots/create', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.query.tenant_id, 10);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
  try {
    const s = await _createSnapshot(tenantId, 'manual', (req.body && req.body.note) || 'consola admin', 'SuperAdmin');
    res.json({ ok: true, id: s.id, size_kb: Math.round(s.gz_bytes / 1024), tables: s.tables, rows: s.rows });
  } catch (e) {
    if (/db_snapshots/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración de snapshots (deploy pendiente).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/snapshots?tenant_id=ID — lista (sin el blob).
router.get('/admin/snapshots', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.query.tenant_id, 10);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
  try {
    const r = await db.query(
      `SELECT id, trigger, note, size_bytes, tables_count, rows_count, created_by, created_at
         FROM db_snapshots WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
    res.json({ ok: true, snapshots: r.rows });
  } catch (e) {
    if (/db_snapshots|does not exist|column/i.test(e.message)) return res.json({ ok: true, snapshots: [], need_migration: true });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/snapshots/:id/download?tenant_id=ID — descarga el JSON.
router.get('/admin/snapshots/:id/download', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.query.tenant_id, 10);
  const id = parseInt(req.params.id, 10);
  if (!tenantId || !id) return res.status(400).json({ ok: false, error: 'tenant_id e id requeridos' });
  try {
    const r = await db.query(`SELECT data_gz FROM db_snapshots WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'snapshot no encontrado' });
    const zlib = require('zlib');
    const json = zlib.gunzipSync(r.rows[0].data_gz);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="snapshot-t${tenantId}-${id}.json"`);
    res.send(json);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// DELETE /api/admin/snapshots/:id?tenant_id=ID
router.delete('/admin/snapshots/:id', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.query.tenant_id, 10);
  const id = parseInt(req.params.id, 10);
  if (!tenantId || !id) return res.status(400).json({ ok: false, error: 'tenant_id e id requeridos' });
  try {
    const r = await db.query(`DELETE FROM db_snapshots WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId]);
    const rem = await db.query(`SELECT COUNT(*)::int AS n FROM db_snapshots WHERE tenant_id = $1`, [tenantId]);
    res.json({ ok: !!r.rows[0], remaining: rem.rows[0].n });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/admin/snapshots/:id/restore?tenant_id=ID — RESTAURA (destructivo). Body: { confirm: <nombre del tenant> }.
// Antes de pisar nada hace un snapshot de seguridad; restaura en TRANSACCIÓN (todo o nada),
// borrando/insertando en orden de dependencias de FK (padres antes que hijos). Sin superusuario.
router.post('/admin/snapshots/:id/restore', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.query.tenant_id, 10);
  const id = parseInt(req.params.id, 10);
  const confirm = String((req.body && req.body.confirm) || '').trim();
  if (!tenantId || !id) return res.status(400).json({ ok: false, error: 'tenant_id e id requeridos' });
  try {
    const tn = await db.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
    if (!tn.rows[0]) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
    const tenantName = String(tn.rows[0].name || '').trim();
    if (!confirm || confirm.toLowerCase() !== tenantName.toLowerCase()) {
      return res.status(400).json({ ok: false, error: `Para confirmar, escribí el nombre exacto del negocio: "${tenantName}"` });
    }
    const sn = await db.query('SELECT data_gz FROM db_snapshots WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!sn.rows[0]) return res.status(404).json({ ok: false, error: 'snapshot no encontrado' });
    const zlib = require('zlib');
    let dump;
    try { dump = JSON.parse(zlib.gunzipSync(sn.rows[0].data_gz).toString('utf8')); } catch (e) { return res.status(400).json({ ok: false, error: 'snapshot corrupto' }); }
    if (!dump || !dump.data) return res.status(400).json({ ok: false, error: 'snapshot sin datos' });

    // snapshot de SEGURIDAD antes de tocar nada (para poder volver atrás).
    try { await _createSnapshot(tenantId, 'pre_restore', 'respaldo automático antes de restaurar #' + id, 'SuperAdmin'); } catch (e) {}

    // sólo tablas que existen hoy en el schema (y no las excluidas).
    const existing = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    const existSet = new Set(existing.rows.map(r => r.table_name));
    const tables = Object.keys(dump.data).filter(t => existSet.has(t) && !SNAPSHOT_SKIP_TABLES.has(t));

    // orden por dependencias de FK: padres (referenciados) antes que hijos.
    const fk = await db.query(`
      SELECT tc.table_name AS child, ccu.table_name AS parent
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
       WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`).catch(() => ({ rows: [] }));
    const parents = new Map(); tables.forEach(t => parents.set(t, new Set()));
    fk.rows.forEach(e => { if (parents.has(e.child) && tables.includes(e.parent) && e.parent !== e.child) parents.get(e.child).add(e.parent); });
    const order = []; const done = new Set(); let progress = true;
    while (order.length < tables.length && progress) {
      progress = false;
      for (const t of tables) {
        if (done.has(t)) continue;
        if ([...parents.get(t)].every(p => done.has(p))) { order.push(t); done.add(t); progress = true; }
      }
    }
    tables.forEach(t => { if (!done.has(t)) order.push(t); }); // ciclos: best-effort

    const _ser = (val, dt) => {
      if (val === null || val === undefined) return null;
      if (dt === 'jsonb' || dt === 'json') return JSON.stringify(val);
      if (dt === 'bytea') return (val && val.type === 'Buffer' && Array.isArray(val.data)) ? Buffer.from(val.data) : val;
      return val;
    };

    const client = await db.getClient();
    let restoredRows = 0;
    try {
      await client.query('BEGIN');
      // borrar en orden inverso (hijos antes que padres)
      for (const t of order.slice().reverse()) await client.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
      // insertar en orden (padres antes que hijos)
      for (const t of order) {
        const ct = await client.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t]);
        const colTypes = new Map(ct.rows.map(r => [r.column_name, r.data_type]));
        for (const row of (dump.data[t] || [])) {
          const cols = Object.keys(row).filter(c => colTypes.has(c));
          if (!cols.length) continue;
          const vals = cols.map(c => _ser(row[c], colTypes.get(c)));
          const colList = cols.map(c => `"${c}"`).join(',');
          const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
          await client.query(`INSERT INTO "${t}" (${colList}) VALUES (${ph})`, vals);
          restoredRows++;
        }
        if (colTypes.has('id')) {
          await client.query(`SELECT setval(pg_get_serial_sequence('"${t}"','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM "${t}"),1))`).catch(() => {});
        }
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return res.status(500).json({ ok: false, error: 'El restore falló y se revirtió (datos intactos): ' + e.message });
    }
    client.release();
    res.json({ ok: true, tables: order.length, rows: restoredRows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cron de snapshots diarios: ~06:00 (inicio) y ~22:00 (fin), hora Bolivia (UTC-4). Best-effort.
let _snapLast = { start: null, end: null };
async function _runDailySnapshots(trigger) {
  try {
    const ts = await db.query('SELECT id FROM tenants').catch(() => ({ rows: [] }));
    for (const row of ts.rows) { try { await _createSnapshot(row.id, trigger, 'automático (' + trigger + ')', 'cron'); } catch (e) {} }
    console.log(`📸 [snapshots] ${trigger}: ${ts.rows.length} tenant(s)`);
  } catch (e) { console.warn('[snapshots] cron falló:', e.message); }
}
setInterval(() => {
  try {
    const loc = new Date(Date.now() + (-240) * 60000); // Bolivia
    const hh = loc.getUTCHours(); const day = loc.toISOString().slice(0, 10);
    if (hh === 6 && _snapLast.start !== day) { _snapLast.start = day; _runDailySnapshots('daily_start'); }
    if (hh === 22 && _snapLast.end !== day) { _snapLast.end = day; _runDailySnapshots('daily_end'); }
  } catch (e) {}
}, 20 * 60 * 1000);
// ============ FIN SNAPSHOTS ============

// =============================================================
// v0.9.8 — Helper de aislamiento por tenant (fail-safe)
// Úsalo en endpoints protegidos con requireTenantSession.
//   - super-admin (req.isSuperAdmin) → sin filtro (ve todo)
//   - tenant (req.tenantId)          → AND <col> = $N
// `col` permite calificar la columna en queries con JOIN (ej. 'c.tenant_id').
// =============================================================
function tenantFilter(req, paramIndex, col = 'tenant_id') {
  if (req.isSuperAdmin) return { clause: '', params: [] };
  if (!req.tenantId) {
    // Fail-safe: si no es super-admin y no hay tenantId, no devolver NADA.
    // (no debería pasar porque requireTenantSession lo garantiza)
    return { clause: ' AND 1=0', params: [] };
  }
  return { clause: ` AND ${col} = $${paramIndex}`, params: [req.tenantId] };
}

// =============================================================
// v0.9.14 — Visibilidad por LÍNEA para agentes con asignación.
//   null  → sin restricción (owner/supervisor/super-admin, o agente sin filas)
//   array → el agente solo ve conversaciones de esas líneas (o sin línea)
// =============================================================
async function getAgentLineIds(req) {
  if (req.isSuperAdmin || !req.userId || req.userRole !== 'agent') return null;
  try {
    const r = await db.query('SELECT line_id FROM tenant_user_lines WHERE user_id = $1', [req.userId]);
    if (r.rows.length === 0) return null; // sin asignación = ve todas
    return r.rows.map(x => x.line_id);
  } catch (e) {
    return null; // tabla no migrada → sin restricción
  }
}

// Chequeo puntual para endpoints de UNA conversación (404 si no le toca)
function agentCanSeeConversation(agentLines, conversation) {
  if (!agentLines) return true;
  if (!conversation.line_id) return true; // sin línea (legacy) = visible
  return agentLines.includes(conversation.line_id);
}

// v0.9.29: alcance por ETAPA del usuario (venta/post-venta).
// 'todas' (default) o rol owner/supervisor → null = sin restricción.
async function getAgentStageScope(req) {
  if (req.isSuperAdmin || !req.userId || req.userRole !== 'agent') return null;
  try {
    const r = await db.query('SELECT stage_scope FROM tenant_users WHERE id = $1', [req.userId]);
    const s = r.rows[0] && r.rows[0].stage_scope;
    return (s === 'venta' || s === 'postventa') ? s : null;
  } catch (e) {
    return null; // columna no migrada → sin restricción
  }
}

// Una conversación sin stage cuenta como 'venta' (default de la migración v0.9.26)
function agentCanSeeStage(stageScope, conversation) {
  if (!stageScope) return true;
  return (conversation.stage || 'venta') === stageScope;
}

// v0.9.285: alcance por CANAL del agente (whatsapp/messenger/instagram/telegram).
//   null  → sin restricción (owner/supervisor/super-admin, o agente sin channel_scope)
//   array → el agente solo ve conversaciones de esos canales
async function getAgentChannelScope(req) {
  if (req.isSuperAdmin || !req.userId || req.userRole !== 'agent') return null;
  try {
    const r = await db.query('SELECT channel_scope FROM tenant_users WHERE id = $1', [req.userId]);
    const sc = r.rows[0] && r.rows[0].channel_scope;
    if (!Array.isArray(sc) || sc.length === 0) return null; // sin asignación = ve todos
    return sc.map(x => String(x).toLowerCase());
  } catch (e) {
    return null; // columna no migrada → sin restricción
  }
}
// Una conversación sin channel (legacy) cuenta como 'whatsapp'.
function agentCanSeeChannel(channelScope, conversation) {
  if (!channelScope) return true;
  return channelScope.includes(conversation.channel || 'whatsapp');
}

// =============================================================
// Helper: leer credenciales demo DEL TENANT.
// v0.9.30b FIX: antes no filtraba por tenant_id (LIMIT 1 sobre todas las
// orgs) → el bundle de un tenant podía mandar las credenciales de OTRO.
// =============================================================
async function getDemoCredentialsBlock(tenantId) {
  try {
    const tid = Number(tenantId) || 1;
    const r = await db.query(
      `SELECT config_value FROM bot_global_config
       WHERE config_key = 'demo_credentials_block' AND tenant_id = $1 LIMIT 1`,
      [tid]
    );
    return r.rows[0]?.config_value || '';
  } catch (e) {
    console.warn('No se pudo leer demo_credentials_block:', e.message);
    return '';
  }
}

// =============================================================
// Helper: enviar un asset tipo "link" (3 mensajes) y persistirlos.
// Devuelve { success, error?, messages: [row, ...] }.
// `senderType` es 'human' o 'bot' para guardar en messages.
// =============================================================
async function sendLinkAssetBundle({ conversation, asset, senderType, overrideCaption, ctx = null }) {
  const credentialsBlock = await getDemoCredentialsBlock(conversation.tenant_id); // v0.9.30b: por tenant
  const captionToSend = (overrideCaption && overrideCaption.trim())
    ? overrideCaption.trim()
    : (asset.caption || '');

  const bundle = await meta.sendLinkBundle(
    conversation.phone,
    captionToSend,
    asset.url,
    credentialsBlock,
    ctx
  );

  // Persistimos un row por cada parte que efectivamente se envió.
  const inserted = [];
  const persistPart = async (part, body) => {
    if (!part) return; // parte omitida (texto vacío)
    const status = part.success ? 'sent' : 'failed';
    const r = await db.query(
      `INSERT INTO messages
       (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
       VALUES ($1, $2, 'outgoing', $3, 'text', $4, $5, $6)
       RETURNING *`,
      [conversation.id, part.wa_message_id, senderType, body, status, part.error || null]
    );
    inserted.push(r.rows[0]);
  };

  await persistPart(bundle.parts.caption, captionToSend);
  await persistPart(bundle.parts.url, asset.url);
  await persistPart(bundle.parts.credentials, credentialsBlock);

  await db.query(
    'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
    [conversation.id]
  );
  await db.query(
    'UPDATE media_assets SET send_count = send_count + 1 WHERE id = $1',
    [asset.id]
  );

  return { success: bundle.success, error: bundle.error, messages: inserted };
}

// =============================================================
// v0.7.8 P2 — sendMediaAssetBundle
// Envía un video/imagen/documento envuelto en texto: intro + media + follow-up.
// Soluciona el problema observado en producción donde clientes recibían
// el media sin caption ni texto introductorio y respondían "no me llegó nada".
// Devuelve { success, error?, messages: [row, ...] }.
// =============================================================
async function sendMediaAssetBundle({ conversation, asset, senderType, overrideCaption, ctx = null }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Caption final: el overrideCaption del cliente prevalece, sino el asset.caption,
  // sino un fallback genérico por tipo.
  const cleanOverride = (overrideCaption || '').trim();
  const cleanAssetCap = (asset.caption || '').trim();
  const intro = cleanOverride || cleanAssetCap ||
    (asset.type === 'video' ? 'Te paso el video 👇' :
     asset.type === 'image' ? 'Te paso una captura 👇' :
     asset.type === 'document' ? 'Te paso el documento 👇' :
     'Te paso esto 👇');

  const followUp = asset.type === 'document'
    ? '¿Pudiste descargarlo? Cualquier duda me decís.'
    : '¿Pudiste verlo? ¿Qué te pareció? Si tenés dudas, me decís.';

  const inserted = [];

  // 1) Intro
  const introResult = await meta.sendText(conversation.phone, intro, false, ctx);
  await db.query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
     VALUES ($1, $2, 'outgoing', $3, 'text', $4, $5, $6) RETURNING id`,
    [conversation.id, introResult.wa_message_id, senderType, intro,
     introResult.success ? 'sent' : 'failed', introResult.error || null]
  );
  inserted.push({ kind: 'intro', success: introResult.success });
  if (!introResult.success) {
    return { success: false, error: introResult.error, messages: inserted };
  }
  await sleep(600);

  // 2) Media
  let mediaResult;
  if (asset.type === 'video') {
    mediaResult = await meta.sendVideo(conversation.phone, asset.url, null, ctx);
  } else if (asset.type === 'image') {
    mediaResult = await meta.sendImage(conversation.phone, asset.url, null, ctx);
  } else if (asset.type === 'document') {
    const filename = asset.url.split('/').pop() || 'documento';
    mediaResult = await meta.sendDocument(conversation.phone, asset.url, filename, null, ctx);
  } else if (asset.type === 'audio') {
    mediaResult = await meta.sendAudio(conversation.phone, asset.url, ctx);
  } else {
    return { success: false, error: 'Tipo de asset no soportado en bundle', messages: inserted };
  }
  await db.query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
     VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, $7, $8)`,
    [conversation.id, mediaResult.wa_message_id, senderType, asset.type, null, asset.url,
     mediaResult.success ? 'sent' : 'failed', mediaResult.error || null]
  );
  inserted.push({ kind: 'media', success: mediaResult.success });
  let mediaDelivered = mediaResult.success;
  if (!mediaResult.success) {
    // v0.9.121 — FALLBACK A LINK: si WhatsApp no pudo entregar el media (típico en
    // VIDEOS de varios MB: Meta va a buscar el archivo al link de R2 y le timeoutea/
    // throttlea — las imágenes chicas sí entran), mandamos el enlace como texto para
    // que el cliente igual lo pueda abrir y ver. Así nunca queda sin recibir nada.
    const tipo = asset.type === 'video' ? 'el video'
      : asset.type === 'image' ? 'la imagen'
      : asset.type === 'document' ? 'el documento' : 'el archivo';
    const linkMsg = `Acá te dejo ${tipo} por si no se ve en el chat 👇\n${asset.url}`;
    const linkResult = await meta.sendText(conversation.phone, linkMsg, false, ctx);
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
       VALUES ($1, $2, 'outgoing', $3, 'text', $4, $5, $6)`,
      [conversation.id, linkResult.wa_message_id, senderType, linkMsg,
       linkResult.success ? 'sent' : 'failed', linkResult.error || null]
    );
    inserted.push({ kind: 'media_link_fallback', success: linkResult.success });
    mediaDelivered = linkResult.success;
    console.warn(`⚠️  Media ${asset.type} (asset ${asset.id}) falló en WhatsApp (${mediaResult.error}); se envió el link como fallback.`);
  }
  if (!mediaDelivered) {
    return { success: false, error: mediaResult.error, messages: inserted };
  }
  await sleep(900);

  // 3) Follow-up
  const followResult = await meta.sendText(conversation.phone, followUp, false, ctx);
  await db.query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
     VALUES ($1, $2, 'outgoing', $3, 'text', $4, $5, $6)`,
    [conversation.id, followResult.wa_message_id, senderType, followUp,
     followResult.success ? 'sent' : 'failed', followResult.error || null]
  );
  inserted.push({ kind: 'follow_up', success: followResult.success });

  // Actualizar conversation + send_count
  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
  await db.query('UPDATE media_assets SET send_count = send_count + 1 WHERE id = $1', [asset.id]);

  return { success: true, messages: inserted };
}

// =============================================================
// Endpoints para n8n
// =============================================================

/**
 * POST /api/whatsapp/send
 * Envía mensaje al cliente (texto, video, imagen, documento, audio).
 *
 * Body: {
 *   phone: "59175665729",
 *   text?: "...",                 // si es texto
 *   asset_id?: "demo_crm_90s",    // si es media (busca en media_assets)
 *   sender_type: "bot" | "human" | "system"
 * }
 */
// v0.9.131 — OMNICANAL: responder por Instagram/Messenger (Send API de la página)
// en vez de WhatsApp. Se usa SOLO cuando conversation.channel != 'whatsapp'.
async function _getChannelCtx(tenantId, channel) {
  const r = await db.query(
    `SELECT page_id, ig_id, page_token_enc FROM tenant_channels WHERE tenant_id = $1 AND channel = $2 AND active = TRUE LIMIT 1`,
    [tenantId, channel]
  ).catch(() => ({ rows: [] }));
  if (!r.rows[0]) return null;
  const token = decryptSafe(r.rows[0].page_token_enc);
  if (!token) return null;
  return { pageId: r.rows[0].page_id, igId: r.rows[0].ig_id, token };
}
async function sendBotReplyViaChannel(conversation, body, res, senderType = 'bot') {
  const cc = await _getChannelCtx(conversation.tenant_id, conversation.channel);
  if (!cc) return res.status(503).json({ error: `Canal ${conversation.channel} no conectado para el tenant ${conversation.tenant_id}` });
  const recipient = conversation.channel_user_id;
  const sent = [];
  // v0.9.281 — Telegram: enviar por la Bot API (texto + asset). El resto (Messenger/IG) sigue abajo.
  if (conversation.channel === 'telegram') {
    const tg = require('./telegram');
    // v0.9.282 — Telegram Business: si el chat pertenece a la cuenta personal del dueño,
    // respondemos CON business_connection_id → el cliente ve al dueño, no al bot.
    let bizConnId = conversation.tg_business_connection_id;
    if (bizConnId === undefined) {
      const _bc = await db.query('SELECT tg_business_connection_id FROM conversations WHERE id = $1', [conversation.id]).catch(() => ({ rows: [] }));
      bizConnId = _bc.rows[0] && _bc.rows[0].tg_business_connection_id;
    }
    bizConnId = bizConnId || null;
    if (body.text && String(body.text).trim()) {
      const r = await tg.sendMessage(cc.token, recipient, String(body.text), bizConnId);
      await db.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, type, body, status, error_message) VALUES ($1,'outgoing',$2,'text',$3,$4,$5)`,
        [conversation.id, senderType, body.text, r.success ? 'sent' : 'failed', r.error || null]);
      sent.push({ kind: 'text', success: r.success });
    }
    if (body.asset_id) {
      const a = await db.query(
        `SELECT type, url, caption FROM media_assets WHERE asset_id = $1 AND (tenant_id = $2 OR ($2 = 1 AND tenant_id IS NULL)) AND active = TRUE LIMIT 1`,
        [body.asset_id, conversation.tenant_id]).catch(() => ({ rows: [] }));
      const asset = a.rows[0];
      if (asset && asset.url) {
        const r = asset.type === 'image'
          ? await tg.sendPhoto(cc.token, recipient, asset.url, asset.caption || undefined, bizConnId)
          : await tg.sendMessage(cc.token, recipient, `${asset.caption ? asset.caption + '\n' : ''}${asset.url}`, bizConnId);
        await db.query(
          `INSERT INTO messages (conversation_id, direction, sender_type, type, body, media_url, status, error_message) VALUES ($1,'outgoing',$2,$3,$4,$5,$6,$7)`,
          [conversation.id, senderType, asset.type === 'image' ? 'image' : 'text', asset.caption || '', asset.url, r.success ? 'sent' : 'failed', r.error || null]);
        sent.push({ kind: 'asset', success: r.success });
      }
    }
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});
    return res.json({ ok: true, channel: 'telegram', sent });
  }
  if (body.text && String(body.text).trim()) {
    const r = await meta.sendMessengerText(cc.pageId, recipient, String(body.text), cc.token);
    await db.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, type, body, status, error_message) VALUES ($1,'outgoing',$2,'text',$3,$4,$5)`,
      [conversation.id, senderType, body.text, r.success ? 'sent' : 'failed', r.error || null]
    );
    sent.push({ kind: 'text', success: r.success });
  }
  if (body.asset_id) {
    const a = await db.query(
      `SELECT type, url, caption FROM media_assets WHERE asset_id = $1 AND (tenant_id = $2 OR ($2 = 1 AND tenant_id IS NULL)) AND active = TRUE LIMIT 1`,
      [body.asset_id, conversation.tenant_id]
    ).catch(() => ({ rows: [] }));
    const asset = a.rows[0];
    if (asset && asset.url) {
      const r = asset.type === 'image'
        ? await meta.sendMessengerImage(cc.pageId, recipient, asset.url, cc.token)
        : await meta.sendMessengerText(cc.pageId, recipient, `${asset.caption ? asset.caption + '\n' : ''}${asset.url}`, cc.token);
      await db.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, type, body, media_url, status, error_message) VALUES ($1,'outgoing',$2,$3,$4,$5,$6,$7)`,
        [conversation.id, senderType, asset.type === 'image' ? 'image' : 'text', asset.caption || '', asset.url, r.success ? 'sent' : 'failed', r.error || null]
      );
      sent.push({ kind: 'asset', success: r.success });
    }
  }
  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});
  return res.json({ ok: true, channel: conversation.channel, sent });
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.9.190 — MATCH FLEXIBLE de fotos por etiqueta (ambiente/variante).
// PROBLEMA: el matching anterior era `label.toLowerCase().includes(req)` — rígido y
// unidireccional. Si el cliente/Aitana pedía "baños" (plural) no encontraba la
// etiqueta "Baño" (singular) → no había match → se mandaba la FICHA (foto de
// portada = "Fachada"). Resultado: "manda fotos equivocadas".
// AHORA: normaliza (minúsculas, sin acentos), tolera singular/plural, compara por
// PALABRAS en ambas direcciones y mapea SINÓNIMOS de inmuebles (garaje≈parqueo,
// cuarto≈dormitorio, etc.). Devuelve TODAS las fotos que matchean para poder mandar
// varias (ej. "baños" → "Baño" + "Baño Suite").
function _normPhoto(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function _singPhoto(w) { return (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w; }
function _photoTokens(s) { return _normPhoto(s).split(' ').filter(Boolean).map(_singPhoto); }
// grupos de sinónimos → un "concepto" canónico (ya en singular y sin acentos)
const _PHOTO_CONCEPTS = [
  ['bano', ['bano', 'toilet', 'sanitario', 'wc', 'ducha', 'hidromasaje', 'lavabo']],
  ['cocina', ['cocina', 'kitchen', 'cocineta']],
  ['parqueo', ['parqueo', 'garaje', 'garage', 'cochera', 'estacionamiento', 'parking']],
  ['sala', ['sala', 'living', 'estar', 'salon', 'recibidor']],
  ['dormitorio', ['dormitorio', 'cuarto', 'habitacion', 'recamara', 'dorm', 'alcoba']],
  ['comedor', ['comedor']],
  ['fachada', ['fachada', 'frente', 'exterior', 'edificio']],
  ['balcon', ['balcon', 'terraza', 'patio']],
  ['ropero', ['ropero', 'closet', 'armario', 'vestidor', 'walkin']],
  ['lavanderia', ['lavanderia', 'lavadero']],
];
function _conceptPhoto(tok) {
  for (const [c, words] of _PHOTO_CONCEPTS) {
    if (words.some(w => tok === w || (tok.length >= 3 && (tok.startsWith(w) || w.startsWith(tok))))) return c;
  }
  return tok;
}
function _labelMatchesReq(label, req) {
  const L = _normPhoto(label), R = _normPhoto(req);
  if (!L || !R) return false;
  if (L === R || L.includes(R) || R.includes(L)) return true;       // substring en cualquier dirección
  const lc = _photoTokens(label).map(_conceptPhoto);
  const rc = _photoTokens(req).filter(w => w.length >= 3).map(_conceptPhoto);
  // Si el pedido nombra un AMBIENTE conocido (baño, cocina, parqueo…), matcheamos SOLO por
  // ese ambiente → así "baño de la master suite" no arrastra "Gradas a la master suite"
  // (calificativos como master/suite no deben disparar match). Si el pedido no nombra
  // ningún ambiente conocido (etiqueta arbitraria tipo "Dependencia"), caemos al overlap.
  const known = rc.filter(c => _PHOTO_CONCEPTS.some(([k]) => k === c));
  if (known.length) return known.some(c => lc.includes(c));
  return rc.some(r => lc.includes(r));                               // overlap de conceptos (sinónimos/plural)
}
// devuelve TODAS las urls cuyo label matchea, en el orden original del catálogo
function _matchPhotosByLabel(imgs, labels, req) {
  return imgs.filter(u => _labelMatchesReq(labels[u] || '', req));
}
// Manda la(s) foto(s) puntual(es) pedida(s) por photo_label/photo_index.
//  · devuelve null  → NO se pidió foto puntual (el caller sigue a la ficha completa)
//  · devuelve {sent:'..._photo'}      → mandó la(s) foto(s) que matchearon
//  · devuelve {sent:'photo_not_found'} → se pidió pero no hubo match: NO se manda la
//    ficha (evita la "foto equivocada"); Aitana ya ofrece alternativas por prompt.
async function _sendSpecificPhotos(req, opt) {
  const { phone, ctx, conversation, sender_type, imgs, labels, emoji, title, sentType, text } = opt;
  const reqLabel = String(req.body.photo_label || '').trim();
  const reqIndex = req.body.photo_index != null ? parseInt(req.body.photo_index) : null;
  if ((!reqLabel && reqIndex == null) || !imgs.length) return null;  // no se pidió foto puntual
  // v0.9.236 — "todas/todo/all" = mandar TODA la galería. El prompt le dice a Aitana que use
  // photo_label "todas" para mostrar todo, pero antes el backend lo trataba como una etiqueta
  // puntual → no matcheaba ninguna → mandaba SOLO el texto ("Aquí tienes todas las fotos") sin
  // fotos. Ahora se reconoce y se mandan todas (cap 10 para no inundar).
  if (reqLabel && /^(todas?|todos?|all|todas\s+las\s+fotos|(ver|mostr[aá]r?(me)?|env[ií]ar?(me)?)\s+todas?)$/i.test(reqLabel)) {
    const sendAll = imgs.slice(0, 10);
    let firstA = null;
    for (let i = 0; i < sendAll.length; i++) {
      const u = sendAll[i];
      const cap = (i === 0 && text && text.trim()) ? text : `${emoji} *${title}*${labels[u] ? ` — ${labels[u]}` : ''}`;
      const rp = await meta.sendImage(phone, u, cap, ctx);
      if (i === 0) firstA = rp;
      await db.query(
        `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
         VALUES ($1,$2,'outgoing',$3,'image',$4,$5,$6,$7)`,
        [conversation.id, rp.wa_message_id, sender_type, cap, u, rp.success ? 'sent' : 'failed', rp.error]
      ).catch(() => {});
    }
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});
    return { ok: !!(firstA && firstA.success), sent: sentType, count: sendAll.length, all: true };
  }
  let matched = reqLabel ? _matchPhotosByLabel(imgs, labels, reqLabel) : [];
  if (!matched.length && reqIndex != null && imgs[reqIndex]) matched = [imgs[reqIndex]];
  if (!matched.length) {
    // Pidió foto puntual y NO hubo match → NO mandamos la ficha (era el bug: mandaba la
    // portada/Fachada). El texto de Aitana viaja como caption en esta misma llamada, así
    // que si lo hay lo mandamos como TEXTO para que el cliente igual reciba respuesta.
    if (text && text.trim()) {
      const rt = await meta.sendText(phone, text, true, ctx);
      await db.query(
        `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
         VALUES ($1,$2,'outgoing',$3,'text',$4,$5,$6)`,
        [conversation.id, rt.wa_message_id, sender_type, text, rt.success ? 'sent' : 'failed', rt.error]
      ).catch(() => {});
      await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});
    }
    return { ok: true, sent: 'photo_not_found', requested: reqLabel || reqIndex };
  }
  const send = matched.slice(0, 4);  // tope: si pidió "fotos" en plural manda hasta 4
  let first = null;
  for (let i = 0; i < send.length; i++) {
    const u = send[i];
    const cap = (i === 0 && text && text.trim()) ? text : `${emoji} *${title}*${labels[u] ? ` — ${labels[u]}` : ''}`;
    const rp = await meta.sendImage(phone, u, cap, ctx);
    if (i === 0) first = rp;
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
       VALUES ($1,$2,'outgoing',$3,'image',$4,$5,$6,$7)`,
      [conversation.id, rp.wa_message_id, sender_type, cap, u, rp.success ? 'sent' : 'failed', rp.error]
    ).catch(() => {});
  }
  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});
  return { ok: !!(first && first.success), sent: sentType, count: send.length, labels: send.map(u => labels[u] || null) };
}

// =====================================================================
// v0.9.342 — BOTONES DE AITANA (la IA decide, prompt-only, SIN cambio n8n).
// El bot puede terminar su texto con el marcador `[botones: Op1 | Op2 | Op3]`
// (instrucción en bot-prompt-builder). Acá se parsea: en WhatsApp se envía como
// mensaje interactivo (máx 3 botones, títulos ≤20 chars); en el resto de los
// canales — o si el turno además manda una ficha — se degrada a opciones
// numeradas dentro del texto. El botón tocado vuelve por el webhook como
// button_reply y ya se procesa como texto normal (title → body).
// =====================================================================
// v0.9.344 — también `[lista: A | B | ... ]` → LIST MESSAGE (menú desplegable, hasta 10 filas)
// para elecciones entre muchas opciones (lotes, propiedades, horarios). Si la IA pone 4+
// opciones en [botones:], se auto-convierte en lista (mejor que recortar a 3).
function parseBotButtons(text) {
  if (!text) return null;
  const m = String(text).match(/\n?\s*\[\s*(botones|buttons|lista|list)\s*:\s*([^\]]+)\]\s*$/i);
  if (!m) return null;
  const tag = m[1].toLowerCase();
  const titles = m[2].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const body = String(text).slice(0, m.index).trim();
  if (titles.length < 2 || !body) return null; // 1 opción no es un menú; sin cuerpo no se manda
  const kind = (/^list/.test(tag) || titles.length > 3) ? 'list' : 'buttons';
  return {
    kind,
    body,
    buttons: titles.map((t, i) => ({ id: `bot:${i + 1}`, title: t.slice(0, kind === 'list' ? 24 : 20) })),
    degraded: body + '\n\n' + titles.map((t, i) => `${i + 1}) ${t}`).join('\n'),
  };
}

let _geminiDegradedAlertAt = 0; // v0.9.354: cooldown de la alerta "Gemini degradado"
// ── v0.9.372 — TYPING HUMANIZADO ─────────────────────────────────────────────
// El bot "escribe como persona": la respuesta larga sale en 1-3 BURBUJAS, cada una
// precedida de "escribiendo…" durante un tiempo PROPORCIONAL a su largo (con jitter
// aleatorio) y con pausas entre burbujas → en el celular se ve: escribiendo… (para)
// escribiendo… mensaje. Antes, el typing del webhook duraba lo que tardara Gemini,
// sin correlación con el volumen del texto (pedido de José 10-jul).
// Solo aplica a TEXTO PURO del bot por WhatsApp (fichas/botones/docs siguen igual).
// Corre en BACKGROUND: a n8n se le responde al instante (su timeout es 10s).
const _HUMANIZE_ON = process.env.HUMANIZE_TYPING !== '0'; // kill-switch global
function _hSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function _hJitter(ms, lo = 0.8, hi = 1.3) { return Math.round(ms * (lo + Math.random() * (hi - lo))); }
function _splitHumanBubbles(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.length < 130) return [t];
  let parts = t.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && t.length > 230) {
    // v0.9.413 — NO cortar la burbuja DENTRO de un número (115.000, 48.900, 3.5): el punto de miles/decimal
    // no es fin de oración. Protegemos el punto entre dígitos, partimos, y lo restauramos.
    const _PH = '';
    const _S = String.fromCharCode(1);
    const _guard = t.replace(/(\d)\.(\d)/g, '$1' + _S + '$2');
    const sentences = (_guard.match(/[^.!?…\n]+[.!?…]+["')\]]*\s*|[^.!?…\n]+$/g) || [_guard]).map((s) => s.split(_S).join('.'));
    if (sentences.length >= 2) {
      const mid = Math.ceil(sentences.length / 2);
      parts = [sentences.slice(0, mid).join('').trim(), sentences.slice(mid).join('').trim()].filter(Boolean);
    }
  }
  if (parts.length > 3) parts = [parts[0], parts[1], parts.slice(2).join('\n\n')];
  return parts;
}
async function _tenantHumanizeOn(tenantId) {
  if (!_HUMANIZE_ON) return false;
  try {
    const r = await db.query(`SELECT COALESCE((to_jsonb(tenants) ->> 'humanize_typing')::boolean, TRUE) AS on FROM tenants WHERE id = $1`, [tenantId]);
    return r.rows[0] ? r.rows[0].on !== false : true;
  } catch (e) { return true; }
}
// v0.9.397 — master switch de botones interactivos (default ON). OFF = Aitana pregunta en texto natural.
async function _tenantButtonsOn(tenantId) {
  try {
    const r = await db.query(`SELECT COALESCE((to_jsonb(tenants) ->> 'bot_buttons_enabled')::boolean, TRUE) AS on FROM tenants WHERE id = $1`, [tenantId]);
    return r.rows[0] ? r.rows[0].on !== false : true;
  } catch (e) { return true; }
}
// v0.9.377 — reply-quote: último mensaje entrante del cliente (para que la FICHA salga citándolo).
async function _lastInboundWaId(conversationId) {
  try {
    const r = await db.query(
      `SELECT wa_message_id FROM messages WHERE conversation_id = $1 AND direction = 'incoming' AND wa_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [conversationId]);
    return r.rows[0] ? r.rows[0].wa_message_id : null;
  } catch (e) { return null; }
}

// Envía las burbujas con ritmo humano. Se llama SIN await (fire-and-forget con catch).
async function _sendHumanized({ conversation, phone, ctx, bubbles, senderType }) {
  // el "escribiendo…" se re-dispara re-marcando leído el último inbound (mismo mecanismo v0.9.279)
  let lastInboundId = null;
  try {
    const r = await db.query(
      `SELECT wa_message_id FROM messages WHERE conversation_id = $1 AND direction = 'incoming' AND wa_message_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [conversation.id]);
    lastInboundId = r.rows[0] ? r.rows[0].wa_message_id : null;
  } catch (e) { /* sin typing, igual salen las burbujas con pausas */ }
  let budgetMs = 14000; // techo TOTAL de teatro por respuesta (no hacer esperar de más)
  for (let i = 0; i < bubbles.length; i++) {
    const b = bubbles[i];
    // tiempo de "tipeo": base + proporcional al largo, con jitter; la 1ª burbuja es más ágil
    // (el cliente ya vio "escribiendo…" mientras pensaba el bot — v0.9.279).
    let typeMs = _hJitter((i === 0 ? 500 : 1100) + b.length * 32);
    typeMs = Math.min(typeMs, i === 0 ? 2500 : 6500, budgetMs);
    if (lastInboundId && typeMs > 700) meta.sendTypingIndicator(lastInboundId, ctx).catch(() => {});
    await _hSleep(typeMs);
    budgetMs -= typeMs;
    const r = await meta.sendText(phone, b, true, ctx);
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
       VALUES ($1, $2, 'outgoing', $3, 'text', $4, $5, $6)`,
      [conversation.id, r.wa_message_id, senderType, b, r.success ? 'sent' : 'failed', r.error || null]
    ).catch((e) => console.warn('[humanize] insert falló:', e.message));
    if (!r.success) { console.warn('[humanize] burbuja falló, corto la secuencia:', r.error); break; }
    if (i < bubbles.length - 1 && budgetMs > 800) {
      const pauseMs = Math.min(_hJitter(1200, 0.7, 1.6), budgetMs); // la "pausa" natural entre burbujas
      await _hSleep(pauseMs);
      budgetMs -= pauseMs;
    }
  }
  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});
}

router.post('/whatsapp/send', requireN8nSecret, async (req, res) => {
  // v0.9.403 — RED DE SEGURIDAD ficha de inventario/servicio: si n8n reenvía el marcador CRUDO del bot
  // (inventory_to_send / service_to_send / property_to_send) en vez del id resuelto, lo aceptamos igual.
  // El nodo "Enviar Asset" de n8n históricamente solo mapeaba property_to_send→property_id (por eso la
  // ficha de un ARTÍCULO/VEHÍCULO se anunciaba pero no se enviaba). Este alias cubre ese caso sin tocar n8n.
  const { conversation_id, asset_id, sender_type = 'bot' } = req.body;
  let inventory_id = req.body.inventory_id || req.body.inventory_to_send || null; // v0.9.408: let → la red de seguridad de ficha puede resolverlo
  let property_id = req.body.property_id || req.body.property_to_send || null; // v0.9.417: let → red de seguridad de ficha puede resolverlo (inmuebles)
  const service_id = req.body.service_id || req.body.service_to_send || null;
  let text = req.body.text;
  let phone = req.body.phone; // v0.9.67: se re-asigna al phone de la conversación resuelta

  if (!phone && !conversation_id) return res.status(400).json({ error: 'phone o conversation_id requerido' });
  if (!text && !asset_id && !inventory_id && !property_id && !service_id) return res.status(400).json({ error: 'text, asset_id, inventory_id, property_id or service_id required' });

  // v0.9.67 (P0 auditoría 12-jun): el tenant ya NO se adivina por phone con
  // fallback a tenant 1 (cross-tenant: la respuesta de una org podía salir por
  // la línea de otra, y un phone desconocido creaba conversación en tenant 1).
  // Camino preferido: n8n devuelve conversation_id (el dispatch SIEMPRE lo
  // mandó en payload.conversation.id). Compat: si falta, se resuelve por phone
  // SOLO contra una conversación EXISTENTE — nunca se crea ni se cae a tenant 1.
  let conversation = null;
  if (conversation_id) {
    const cr = await db.query('SELECT * FROM conversations WHERE id = $1', [parseInt(conversation_id)]);
    if (!cr.rows.length) return res.status(404).json({ error: 'conversation_id desconocido' });
    conversation = cr.rows[0];
    if (phone && String(conversation.phone) !== String(phone)) {
      console.error(`🚨 [/whatsapp/send] phone=${phone} no coincide con conversation ${conversation.id} (${conversation.phone}) — rechazado`);
      return res.status(409).json({ error: 'phone no coincide con la conversación' });
    }
  } else {
    let tenant = null;
    try { tenant = await resolveTenantByPhone(phone); } catch (e) {
      console.error('[/whatsapp/send] resolveTenantByPhone error:', e.message);
    }
    if (!tenant) {
      console.warn(`⚠️  [/whatsapp/send] phone=${phone} sin conversación previa — rechazado (mandar conversation_id)`);
      return res.status(404).json({ error: 'Sin conversación previa para ese phone; incluí conversation_id' });
    }
    const cr = await db.query('SELECT * FROM conversations WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [tenant.id, phone]);
    if (!cr.rows.length) return res.status(404).json({ error: 'Conversación no encontrada' });
    conversation = cr.rows[0];
  }
  const tenantId = conversation.tenant_id;
  // v0.9.302 — el BOT puede CERRAR el ticket de soporte cuando resolvió la consulta (KB/FAQ).
  if (req.body.close_ticket === true || req.body.close_ticket === 'true') {
    try {
      const _at = await db.query(
        `SELECT id FROM support_tickets WHERE conversation_id = $1 AND status = ANY($2) ORDER BY id DESC LIMIT 1`,
        [conversation.id, supportTickets.ACTIVE]);
      if (_at.rows[0]) {
        await supportTickets.transitionStatus({ ticketId: _at.rows[0].id, tenantId, toStatus: 'resolved', actorKind: 'bot' });
        console.log(`🎧 [bot] ticket ${_at.rows[0].id} RESUELTO por el bot (close_ticket) — conv ${conversation.id}`);
      }
    } catch (e) { console.warn('close_ticket (bot) no aplicado:', e.message); }
  }
  // v0.9.315 — ROBUSTEZ: si el bot marcó call_now, disparamos el aviso desde el PATH DE RESPUESTA
  // (siempre corre; no depende del gate ¿Calificado? ni del early-return de postventa). Anti-spam 30 min evita doble.
  if (req.body.reason === 'call_now') {
    notifyCallRequest({ conversation, conversationId: conversation.id, contactName: conversation.contact_name || conversation.phone, phone: conversation.phone, summary: null, vertical: conversation.vertical })
      .catch((e) => console.error('⚠️  notifyCallRequest (send) falló:', e.message));
  }
  // v0.9.354 — ALERTA "GEMINI DEGRADADO": si el bot manda el texto de degradación de n8n
  // (Parse Respuesta lo emite cuando Gemini falla — caso real 9-jul: Google retiró
  // gemini-2.5-flash con 404 y el bot quedó en modo loro sin que nadie lo viera),
  // avisamos a José. Cooldown 30 min. El mensaje al cliente se envía igual.
  if (sender_type === 'bot' && text && text.includes('Un asesor te contactará en unos minutos para atenderte personalmente')) {
    if (Date.now() - _geminiDegradedAlertAt > 30 * 60 * 1000) {
      _geminiDegradedAlertAt = Date.now();
      try {
        const _wh = require('./webhook');
        _wh.notifyOwnerBotDown(`Aitana está respondiendo con el TEXTO DE DEGRADACIÓN ("un asesor te contactará…") — Gemini está fallando en n8n (modelo retirado, API key o cuota). Conv ${conversation.id} (tenant ${conversation.tenant_id}). Revisá la última ejecución del workflow.`)
          .catch((e) => console.warn('[gemini-degraded] alerta falló:', e.message));
      } catch (e) { console.warn('[gemini-degraded] no se pudo cargar webhook.notifyOwnerBotDown:', e.message); }
    }
  }
  // v0.9.408 — RED DE SEGURIDAD "FICHA SÍ O SÍ": Gemini a veces ANUNCIA la ficha en el texto
  // ("acá te paso la ficha con la foto 👇") pero NO emite inventory_to_send → el cliente ve la
  // promesa y nunca la foto (queda pésimo en una demo, ej. NIBOL/Nissan). Si llega SOLO texto
  // (sin ningún id de asset), el texto anuncia claramente un envío, y el tenant vende autos/artículos,
  // resolvemos el ítem por el modelo del search_profile (o por el nombre del catálogo que aparezca en
  // el texto) y seteamos inventory_id → REUSA el bloque `if (inventory_id)` de abajo (manda foto +
  // caption = ese mismo texto). Best-effort: ante cualquier duda no hace nada y sigue como texto.
  if (sender_type === 'bot' && text && !asset_id && !inventory_id && !property_id && !service_id) {
    try {
      // v0.9.464 — + folleto/brochure/pdf/dossier: caso real 29-jul (demo C21): el bot dijo
      // "te paso el FOLLETO de preventa" y el trigger no reconocía esa palabra → promesa sin envío.
      const _announceFicha = /(\bac[áa]\b|\baqu[íi]\b|\bte\s+(?:paso|mando|comparto|env[íi]o|muestro|dejo|presento)\b|\bmir[áa]\b|\bten[ée]s\b)/i.test(text)
        && /(\bficha\b|\bfotos?\b|\bim[áa]gen(?:es)?\b|\bcat[áa]logo\b|\bfolletos?\b|\bbrochure\b|\bd[oó]ssier\b|\bpdf\b|\bte\s+(?:presento|muestro)\b)/i.test(text);
      if (_announceFicha) {
        const _mr = await db.query(
          `SELECT COALESCE((to_jsonb(t)->>'inventory_bot_enabled')::boolean,false) AS inv,
                  COALESCE((to_jsonb(t)->>'vehiculos_bot_enabled')::boolean,false) AS veh,
                  COALESCE((to_jsonb(t)->>'realestate_bot_enabled')::boolean,false) AS re
             FROM tenants t WHERE id = $1`, [tenantId]).catch(() => ({ rows: [{}] }));
        const _mode = _mr.rows[0] || {};
        if (_mode.inv || _mode.veh) {
          const _invT = await botCatalogTable(tenantId, 'inventory').catch(() => 'inventory_items');
          const _sp = (conversation.search_profile && typeof conversation.search_profile === 'object') ? conversation.search_profile : {};
          const _attr = (_sp.attributes && typeof _sp.attributes === 'object') ? _sp.attributes : {};
          const _hints = [_attr.modelo, _attr.model, _attr.marca].filter(Boolean).map((h) => String(h).trim()).filter((h) => h.length >= 2);
          let _pick = null;
          for (const h of _hints) {
            const q = await db.query(
              `SELECT id, image_urls, image_url FROM ${_invT}
                WHERE tenant_id = $1 AND active = TRUE AND name ILIKE $2
                ORDER BY LENGTH(name) ASC LIMIT 1`, [tenantId, '%' + h + '%']).catch(() => ({ rows: [] }));
            if (q.rows[0]) { _pick = q.rows[0]; break; }
          }
          // fallback: el nombre de algún ítem del catálogo aparece textual en el mensaje del bot
          if (!_pick) {
            const _all = await db.query(
              `SELECT id, name, image_urls, image_url FROM ${_invT} WHERE tenant_id = $1 AND active = TRUE`, [tenantId]).catch(() => ({ rows: [] }));
            const _low = ' ' + text.toLowerCase() + ' ';
            for (const it of _all.rows) {
              const _nm = String(it.name || '').toLowerCase().replace(/^nissan\s+/, '').trim();
              if (_nm.length >= 3 && _low.includes(_nm)) { _pick = it; break; }
            }
          }
          if (_pick) {
            // no re-mandar la MISMA foto si ya salió hace poco (evita spam si el bot re-anuncia la ficha)
            const _img0 = (Array.isArray(_pick.image_urls) && _pick.image_urls.length) ? _pick.image_urls[0] : (_pick.image_url || null);
            let _dupe = { rows: [] };
            if (_img0) _dupe = await db.query(
              `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'outgoing'
                 AND type = 'image' AND media_url = $2 AND created_at > NOW() - INTERVAL '30 minutes' LIMIT 1`,
              [conversation.id, _img0]).catch(() => ({ rows: [] }));
            if (_dupe.rows.length === 0) {
              inventory_id = _pick.id; // ← el bloque `if (inventory_id)` de abajo manda foto + caption(este texto)
              console.log(`🛟 [ficha-safety-net] bot anunció ficha sin id → auto-envío inventory ${_pick.id} (conv ${conversation.id}, tenant ${tenantId})`);
            }
          }
        } else if (_mode.re) {
          // v0.9.417 — mismo salvavidas para INMUEBLES (el bug era: el bot anuncia la ficha, a veces por
          // NOTA DE VOZ, sin property_to_send → no llegaba nada). Resolvemos la propiedad por el título que
          // aparezca en el texto, o por el mejor match del search_profile (matcher: respeta zona/tipo/presupuesto/moneda).
          try {
            const _spr = (conversation.search_profile && typeof conversation.search_profile === 'object') ? conversation.search_profile : {};
            const _allp = await db.query(`SELECT * FROM properties WHERE tenant_id = $1 AND active = TRUE AND COALESCE(status,'disponible') = 'disponible'`, [tenantId]).catch(() => ({ rows: [] }));
            let _pp = null;
            const _lowp = ' ' + text.toLowerCase() + ' ';
            // v0.9.418 — PRIORIDAD 1: matchear por el PRECIO que el bot nombró en su texto (respeta lo que dijo;
            // antes el matcher fuzzy mandaba OTRA propiedad → "dice casa 511.000 / envía monoambiente 556.104").
            // Solo dispara si EXACTAMENTE una propiedad calza con un precio del texto (no adivina en comparaciones).
            try {
              const _nums = (text.match(/\d[\d.,]{2,}/g) || []).map((n) => parseInt(String(n).replace(/[.,]/g, ''), 10)).filter((n) => Number.isFinite(n) && n >= 1000);
              if (_nums.length) {
                const _numSet = new Set(_nums);
                const _hits = _allp.rows.filter((pr) => { const _pv = Math.round(Number(pr.price)); return Number.isFinite(_pv) && _pv > 0 && _numSet.has(_pv); });
                if (_hits.length === 1) _pp = _hits[0];
              }
            } catch (e) { /* sin match por precio → sigue por título/score */ }
            // v0.9.464 — PRIORIDAD 1.5: la conversación nació de un anuncio ya matcheado al catálogo
            // (ads-match guardó ad_property_id). Si el bot promete el folleto en esa conversación,
            // esa ES la propiedad — no hace falta adivinar por título ni score.
            if (!_pp && conversation.ad_property_id) {
              _pp = _allp.rows.find((pr) => Number(pr.id) === Number(conversation.ad_property_id)) || null;
            }
            // PRIORIDAD 2: el título de la propiedad aparece textual en el mensaje
            if (!_pp) for (const pr of _allp.rows) { const _tt = String(pr.title || '').toLowerCase().trim(); if (_tt.length >= 8 && _lowp.includes(_tt.slice(0, 22))) { _pp = pr; break; } }
            if (!_pp && _allp.rows.length) {
              try {
                const { scoreCatalogItem, getUsdToBsRate } = require('./catalog-matcher');
                const _rt = await getUsdToBsRate(db).catch(() => null);
                const _sc = _allp.rows.map((pr) => ({ pr, s: scoreCatalogItem(_spr, pr, 'property', { usdToBs: _rt }) })).filter((x) => x.s && !x.s.over_budget && x.s.score > 0).sort((a, b) => b.s.score - a.s.score);
                if (_sc[0]) _pp = _sc[0].pr;
              } catch (e) { /* matcher no disponible → sin auto-envío */ }
            }
            if (_pp) {
              const _pimg = (Array.isArray(_pp.image_urls) && _pp.image_urls.length) ? _pp.image_urls[0] : null;
              let _pdup = { rows: [] };
              if (_pimg) _pdup = await db.query(`SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'outgoing' AND type = 'image' AND media_url = $2 AND created_at > NOW() - INTERVAL '30 minutes' LIMIT 1`, [conversation.id, _pimg]).catch(() => ({ rows: [] }));
              if (_pdup.rows.length === 0) { property_id = _pp.id; console.log(`🛟 [ficha-safety-net] inmueble ${_pp.id} auto-enviado (conv ${conversation.id})`); }
            }
          } catch (e) { /* best-effort */ }
        }
      }
    } catch (e) { console.warn('[ficha-safety-net] falló (best-effort, sigue como texto):', e.message); }
  }
  // v0.9.342 — botones de Aitana: parsear el marcador ANTES del dispatch por canal.
  // Solo queda "interactivo" el caso WhatsApp + texto puro; todo lo demás degrada a numeradas.
  let _botBtns = parseBotButtons(text);
  if (_botBtns && (asset_id || inventory_id || property_id || service_id)) {
    text = _botBtns.degraded; // vino junto a una ficha (la IA no debería): el texto igual muestra las opciones
    req.body.text = text;
    _botBtns = null;
  }
  // v0.9.397 — MASTER SWITCH de botones OFF (Config → General): degradar a TEXTO (sin botones ni listas).
  // v0.9.398 — usa `.degraded` (pregunta + opciones NUMERADAS) y NO `.body` (que perdía las opciones →
  //            "¿cuál preferís?" sin mostrar los horarios). Red de seguridad por si un prompt cacheado (30s)
  //            todavía emitió el marcador; en régimen el prompt ya le dice a Aitana que liste en texto natural.
  if (_botBtns && !(await _tenantButtonsOn(tenantId))) {
    text = _botBtns.degraded; req.body.text = text; _botBtns = null;
  }
  // v0.9.131 — OMNICANAL: si la conversación es de IG/Messenger, se responde por el
  // Send API de la página (no por WhatsApp). El camino de WhatsApp de abajo no se toca.
  if (conversation.channel && conversation.channel !== 'whatsapp') {
    if (_botBtns) { req.body.text = _botBtns.degraded; } // botones nativos son de WhatsApp; acá van numeradas
    return sendBotReplyViaChannel(conversation, req.body, res, sender_type);
  }
  phone = conversation.phone; // el envío sale SIEMPRE al phone de la conversación resuelta
  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]).catch(() => {});

  // v0.9.13: ctx Meta por la LÍNEA de la conversación (multi-línea). Si la
  // conversación no tiene línea, cae al ctx por tenant (v0.9.6); tenant 1 sin
  // token propio → null → credenciales globales = comportamiento legacy.
  const ctx = await getConversationMetaCtx(conversation);

  // v0.9.49: Aitana envía un SERVICIO — ficha (precio/unidad, duración,
  // capacidad, características, horarios, link de reserva), foto puntual por
  // photo_label y PDFs solo a pedido. Mismo contrato que productos/inmuebles.
  if (service_id) {
    const _svcT = await botCatalogTable(tenantId, 'service');
    const sr = await db.query(`SELECT * FROM ${_svcT} WHERE id = $1 AND tenant_id = $2 AND active = TRUE`, [parseInt(service_id), tenantId]).catch(() => ({ rows: [] }));
    if (sr.rows.length === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    const s = sr.rows[0];
    const imgs = Array.isArray(s.image_urls) ? s.image_urls : [];
    const labels = (s.image_labels && typeof s.image_labels === 'object') ? s.image_labels : {};

    const wantDocs = req.body.send_docs === true || req.body.send_docs === 'true';
    if (wantDocs) {
      const sdocs = Array.isArray(s.file_urls) ? s.file_urls : [];
      if (sdocs.length) {
        const capD = (text && text.trim()) ? text : `📎 *${s.name}* — te mando la información completa:`;
        const rd = await meta.sendText(phone, capD, true, ctx);
        for (const d of sdocs.slice(0, 5)) { try { await meta.sendDocument(phone, d.url, d.name || 'documento.pdf', '', ctx); } catch (e) {} }
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'document',$4,$5,$6,$7)`,
          [conversation.id, rd.wa_message_id, sender_type, capD, sdocs[0].url || null, rd.success ? 'sent' : 'failed', rd.error]
        );
        return res.json({ ok: rd.success, sent: 'service_docs', count: Math.min(sdocs.length, 5) });
      }
    }

    // v0.9.190: foto puntual con MATCH FLEXIBLE (ver _sendSpecificPhotos). Si se pidió
    // photo_label/photo_index, manda solo esa(s) foto(s); si no hubo match NO cae a la ficha.
    {
      const _ph = await _sendSpecificPhotos(req, { phone, ctx, conversation, sender_type, imgs, labels, emoji: '🛎️', title: s.name, sentType: 'service_photo', text });
      if (_ph) return res.json(_ph);
    }

    // ficha completa (incluye link de reserva: propio del servicio o Cal de la org)
    let calUrl = null;
    try { const t = await db.query('SELECT calcom_event_url FROM tenants WHERE id = $1', [tenantId]); calUrl = (t.rows[0]?.calcom_event_url || '').trim() || null; } catch (e) {}
    const cap = (text && text.trim()) ? text : _serviceCaption(s, calUrl);
    const _quoteId = sender_type === 'bot' ? await _lastInboundWaId(conversation.id) : null; // v0.9.377 reply-quote
    const r = imgs.length ? await meta.sendImage(phone, imgs[0], cap, ctx, _quoteId) : await meta.sendText(phone, cap, true, ctx, _quoteId);
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
       VALUES ($1,$2,'outgoing',$3,$4,$5,$6,$7,$8)`,
      [conversation.id, r.wa_message_id, sender_type, imgs.length ? 'image' : 'text', cap, imgs[0] || null, r.success ? 'sent' : 'failed', r.error]
    );
    // v0.9.150: registrar también las fotos extra enviadas a WhatsApp (sync inbox↔WA)
    for (let k = 1; k < Math.min(imgs.length, 5); k++) {
      try {
        const rk = await meta.sendImage(phone, imgs[k], labels[imgs[k]] || '', ctx);
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'image',$4,$5,$6,$7)`,
          [conversation.id, rk.wa_message_id, sender_type, labels[imgs[k]] || '', imgs[k], rk.success ? 'sent' : 'failed', rk.error]
        );
      } catch (e) {}
    }
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
    if (!r.success) return res.status(422).json({ success: false, error: r.error });
    return res.json({ success: true, wa_message_id: r.wa_message_id });
  }

  // v0.9.22: Aitana envía un ARTÍCULO de inventario (NUNCA stock)
  // v0.9.42: ficha completa (marca/categoría/características), multi-foto con
  // etiquetas, foto puntual por photo_label/photo_index y PDFs solo a pedido
  // (send_docs) — mismo contrato que inmuebles.
  if (inventory_id) {
    const _invT = await botCatalogTable(tenantId, 'inventory');
    const ir = await db.query(`SELECT * FROM ${_invT} WHERE id = $1 AND tenant_id = $2 AND active = TRUE`, [parseInt(inventory_id), tenantId]).catch(() => ({ rows: [] }));
    if (ir.rows.length === 0) return res.status(404).json({ error: 'Artículo no encontrado' });
    const it = ir.rows[0];
    let imgs = (Array.isArray(it.image_urls) && it.image_urls.length) ? it.image_urls : (it.image_url ? [it.image_url] : []); // v0.9.411: let → dedupe puede vaciarlo
    const labels = (it.image_labels && typeof it.image_labels === 'object') ? it.image_labels : {};

    // PDFs (catálogo/ficha técnica) SOLO cuando el cliente los pide
    const wantDocs = req.body.send_docs === true || req.body.send_docs === 'true';
    if (wantDocs) {
      const idocs = Array.isArray(it.file_urls) ? it.file_urls : [];
      if (idocs.length) {
        const capD = (text && text.trim()) ? text : `📎 *${it.name}* — te mando la documentación completa:`;
        const rd = await meta.sendText(phone, capD, true, ctx);
        for (const d of idocs.slice(0, 5)) { try { await meta.sendDocument(phone, d.url, d.name || 'documento.pdf', '', ctx); } catch (e) {} }
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'document',$4,$5,$6,$7)`,
          [conversation.id, rd.wa_message_id, sender_type, capD, idocs[0].url || null, rd.success ? 'sent' : 'failed', rd.error]
        );
        return res.json({ ok: rd.success, sent: 'inventory_docs', count: Math.min(idocs.length, 5) });
      }
      // sin documentos → cae a la ficha normal
    }

    // FOTO ESPECÍFICA — "muéstrame el rojo", "verlo de atrás"
    // v0.9.190: foto puntual con MATCH FLEXIBLE (ver _sendSpecificPhotos).
    {
      const _ph = await _sendSpecificPhotos(req, { phone, ctx, conversation, sender_type, imgs, labels, emoji: '📦', title: it.name, sentType: 'inventory_photo', text });
      if (_ph) return res.json(_ph);
    }

    // v0.9.411 — ANTI DOBLE-FOTO: si la MISMA foto de este ítem ya salió a esta conversación hace
    // <2 min (típico: la red de seguridad v0.9.408 la mandó en el mensaje de "te paso la ficha 👇" y
    // ahora llega el marcador inventory_to_send con la ficha real → el cliente veía la foto 2 veces),
    // NO reenviamos la imagen: mandamos la ficha como TEXTO (especificaciones), sin duplicar la foto.
    if (imgs.length) {
      try {
        const _dup = await db.query(
          `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'outgoing'
             AND type = 'image' AND media_url = $2 AND created_at > NOW() - INTERVAL '2 minutes' LIMIT 1`,
          [conversation.id, imgs[0]]);
        if (_dup.rows.length) { imgs = []; console.log(`🧹 [anti-doble-foto] ${it.name}: foto ya enviada <2min → ficha va como texto (conv ${conversation.id})`); }
      } catch (e) { /* best-effort: ante error, se manda normal */ }
    }
    // Ficha completa: primera foto con todo el detalle; extras con su etiqueta
    const cap = (text && text.trim()) ? text : _inventoryCaption(it);
    const _quoteId = sender_type === 'bot' ? await _lastInboundWaId(conversation.id) : null; // v0.9.377 reply-quote
    const r = imgs.length ? await meta.sendImage(phone, imgs[0], cap, ctx, _quoteId) : await meta.sendText(phone, cap, true, ctx, _quoteId);
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
       VALUES ($1,$2,'outgoing',$3,$4,$5,$6,$7,$8)`,
      [conversation.id, r.wa_message_id, sender_type, imgs.length ? 'image' : 'text', cap, imgs[0] || null, r.success ? 'sent' : 'failed', r.error]
    );
    // v0.9.150: registrar también las fotos extra enviadas a WhatsApp (sync inbox↔WA)
    for (let k = 1; k < Math.min(imgs.length, 5); k++) {
      try {
        const rk = await meta.sendImage(phone, imgs[k], labels[imgs[k]] || '', ctx);
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'image',$4,$5,$6,$7)`,
          [conversation.id, rk.wa_message_id, sender_type, labels[imgs[k]] || '', imgs[k], rk.success ? 'sent' : 'failed', rk.error]
        );
      } catch (e) {}
    }
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
    if (!r.success) return res.status(422).json({ success: false, error: r.error });
    return res.json({ success: true, wa_message_id: r.wa_message_id });
  }

  // v0.9.22: Aitana envía un INMUEBLE — ficha completa (fotos + datos + precio)
  if (property_id) {
    const pr = await db.query('SELECT * FROM properties WHERE id = $1 AND tenant_id = $2 AND active = TRUE', [parseInt(property_id), tenantId]).catch(() => ({ rows: [] }));
    if (pr.rows.length === 0) return res.status(404).json({ error: 'Inmueble no encontrado' });
    const p = pr.rows[0];
    // v0.9.419/468 — ANTI-DOBLE-FICHA: si la MISMA ficha de esta propiedad ya salió hace <90s, no la
    // reenviamos. Pasaba cuando n8n mandaba property_to_send Y la red de seguridad (safety-net) también
    // resolvía la propiedad por su cuenta → 2-3 tarjetas repetidas (caso ADS: safety-net + property_to_send).
    // v0.9.468: además del header "🏠 *título*", deduplicamos por la FOTO PRINCIPAL — porque cuando un
    // envío usa caption conversacional (sin header) el chequeo por texto no lo veía, y el segundo envío
    // salía igual. La foto es la misma en ambos → la cazamos seguro. NO aplica a photo_label (foto puntual
    // a pedido, sí puede repetirse) ni al envío manual del panel.
    const _pImgs0 = (Array.isArray(p.image_urls) ? p.image_urls : []);
    const _pFeat0 = (p.image_featured && typeof p.image_featured === 'object') ? p.image_featured : {};
    const _pMainImg = (_pImgs0.filter(u => _pFeat0[u])[0]) || _pImgs0[0] || null;
    const _isPointPhoto = !!(req.body.photo_label || req.body.photo_index != null); // foto puntual → no dedupe
    if (sender_type === 'bot' && !_isPointPhoto) {
      try {
        const _escLike = (x) => String(x).slice(0, 40).replace(/([%_\\])/g, '\\$1');
        const _fichaKey = '%🏠 *' + _escLike(p.title) + '%';
        const _dupF = await db.query(
          `SELECT 1 FROM messages WHERE conversation_id = $1 AND direction = 'outgoing'
             AND created_at > NOW() - INTERVAL '90 seconds'
             AND ( body LIKE $2 ESCAPE '\\' ${_pMainImg ? 'OR media_url = $3' : ''} ) LIMIT 1`,
          _pMainImg ? [conversation.id, _fichaKey, _pMainImg] : [conversation.id, _fichaKey]).catch(() => ({ rows: [] }));
        if (_dupF.rows.length) {
          console.log(`🛡️ [anti-doble-ficha] inmueble ${p.id} ya enviado <90s → skip (conv ${conversation.id})`);
          return res.json({ ok: true, skipped: 'duplicate_property_ficha' });
        }
      } catch (e) { /* best-effort: si falla, sigue y envía normal */ }
    }
    const opLabel = { venta: 'En venta', alquiler: 'En alquiler', anticretico: 'Anticrético' }[p.operation] || p.operation;
    const specs = [];
    if (p.area_m2 != null) specs.push(`${Number(p.area_m2).toLocaleString('es-BO')} m²`);
    if (p.bedrooms != null) specs.push(`${p.bedrooms} dorm`);
    if (p.bathrooms != null) specs.push(`${p.bathrooms} baños`);
    if (p.garages != null) specs.push(`${p.garages} garaje${p.garages === 1 ? '' : 's'}`);
    // v0.9.417 — precio en su moneda + equivalente en la otra (tasa BCB), para que el cliente no convierta.
    let priceLine = '';
    if (p.price != null) {
      const _cur = p.currency || 'USD';
      priceLine = `\n💵 ${_cur} ${Number(p.price).toLocaleString('es-BO')}`;
      try {
        const { getUsdToBsRate } = require('./catalog-matcher');
        const _r = await getUsdToBsRate(db);
        if (_r && _r > 0) {
          if (/bs/i.test(_cur)) priceLine += ` (≈ USD ${Math.round(Number(p.price) / _r).toLocaleString('es-BO')})`;
          else if (/usd/i.test(_cur)) priceLine += ` (≈ Bs ${Math.round(Number(p.price) * _r).toLocaleString('es-BO')})`;
        }
      } catch (e) { /* sin tasa → solo moneda original */ }
    }
    const imgs = Array.isArray(p.image_urls) ? p.image_urls : [];
    const labels = (p.image_labels && typeof p.image_labels === 'object') ? p.image_labels : {};

    // v0.9.37: DOCUMENTOS SOLO A PEDIDO — el PDF es el catálogo/brochure
    // completo; va únicamente cuando el cliente lo pide (send_docs: true).
    const wantDocs = req.body.send_docs === true || req.body.send_docs === 'true';
    if (wantDocs) {
      const pdocsReq = Array.isArray(p.file_urls) ? p.file_urls : [];
      if (pdocsReq.length) {
        const capD = (text && text.trim()) ? text : `📎 *${p.title}* — te mando la documentación completa:`;
        const rd = await meta.sendText(phone, capD, true, ctx);
        for (const d of pdocsReq.slice(0, 5)) { try { await meta.sendDocument(phone, d.url, d.name || 'documento.pdf', '', ctx); } catch (e) {} }
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'document',$4,$5,$6,$7)`,
          [conversation.id, rd.wa_message_id, sender_type, capD, pdocsReq[0].url || null, rd.success ? 'sent' : 'failed', rd.error]
        );
        return res.json({ ok: rd.success, sent: 'property_docs', count: Math.min(pdocsReq.length, 5) });
      }
      // sin documentos → cae a la ficha normal
    }

    // v0.9.35: FOTO ESPECÍFICA por ambiente — "muéstrame el baño/la sala".
    // El bot manda photo_label (o photo_index); si matchea, va SOLO esa foto.
    // v0.9.190: foto puntual con MATCH FLEXIBLE (ver _sendSpecificPhotos). "baños" ahora
    // matchea "Baño"/"Baño Suite" y manda AMBAS; si no hubo match NO manda la Fachada.
    {
      const _ph = await _sendSpecificPhotos(req, { phone, ctx, conversation, sender_type, imgs, labels, emoji: '🏠', title: p.title, sentType: 'property_photo', text });
      if (_ph) return res.json(_ph);
    }

    // v0.9.33: la ficha incluye el link de mapa si existe.
    // v0.9.184: WhatsApp limita el caption de una IMAGEN a ~1024 chars → una descripción larga
    // dejaba el envío "no entregado". Si la ficha excede, mandamos la foto con caption CORTO
    // (datos clave) y la descripción completa como TEXTO aparte (los textos admiten ~4096).
    // v0.9.394 — FICHA ESTRELLA con AUDIO: el "anuncio" (text) sale como NOTA DE VOZ; la ficha
    // (datos + fotos) sigue igual. Si el audio salió, blanqueamos text para no repetirlo como caption.
    if (sender_type === 'bot' && text && text.trim()) {
      const _vf = await require('./voice-moments').sendVoiceMoment('ficha', { tenantId, conversationId: conversation.id, lineId: conversation.line_id || null, phone, text, ctx });
      if (_vf.sent) text = null;
    }
    // v0.9.465 — disponibilidad texto libre en la ficha (solo si el dueño la cargó; vacío = no se menciona)
    const _availLine = (p.availability && String(p.availability).trim()) ? `🟢 Disponibilidad: ${String(p.availability).trim()}` : null;
    // v0.9.480 — PROYECTOS: si el inmueble tiene tipologías cargadas, la ficha las lista en el
    // MISMO mensaje (una línea por formato, con su "desde" y su disponibilidad). Sin formatos el
    // bloque queda vacío y la ficha sale exactamente igual que antes.
    let _fmts = p.formats;
    if (typeof _fmts === 'string') { try { _fmts = JSON.parse(_fmts); } catch (_) { _fmts = null; } }
    const _fmtBlock = (Array.isArray(_fmts) && _fmts.length)
      ? '\n\n🧩 *Formatos disponibles:*\n' + _fmts.slice(0, 12).map((f) => {
          const bits = [f.m2 ? `${f.m2}m²` : null, f.dorm ? `${f.dorm} dorm` : null].filter(Boolean).join(' · ');
          return '• ' + [f.label, bits || null].filter(Boolean).join(' · ')
            + (f.price_from ? ` — desde ${f.price_from}` : '')
            + (f.availability ? ` (${f.availability})` : '');
        }).join('\n')
      : '';
    // v0.9.570 — PROMOCIONES TEMPORALES: el bloque trae SOLO las vigentes hoy (la vigencia la
    // calcula promos.js con la fecha de Bolivia). Sin promos activas devuelve '' y la ficha sale
    // exactamente igual que antes. Viaja pegado a los formatos para pasar por el mismo ajuste
    // de caption: si hay que recortar, se recorta el TEXTO, nunca la promo.
    const _promos = require('./promos');
    const _promoBlock = _promos.fichaBlock(p.promotions);
    const _extraBlock = _fmtBlock + _promoBlock;
    const _headerBase = [`🏠 *${p.title}* — ${opLabel}`, p.zone ? `📍 ${p.zone}` : null, specs.length ? `📐 ${specs.join(' · ')}` : null, priceLine || null, _availLine, p.maps_url ? `🗺️ Ubicación: ${p.maps_url}` : null].filter(Boolean).join('\n');
    const _header = _headerBase + _extraBlock;
    // v0.9.468 — LA FICHA ES UNA FOTO + LA DESCRIPCIÓN, NADA MÁS (pedido de José).
    // Problema que resuelve: los MISMOS datos salían 2-3 veces (saludo conversacional como caption +
    // header con specs/precio + descripción) porque (a) n8n usaba el texto del bot como caption y
    // (b) el header repite lo que la descripción ya dice. Ahora:
    //  • El saludo conversacional del bot NO se usa como caption de la ficha.
    //  • Si el inmueble tiene una DESCRIPCIÓN de verdad, ELLA es la ficha (ya trae zona, m², precio…):
    //    foto + descripción, en UN solo mensaje. No se antepone el header (repetiría todo).
    //  • Si la descripción es pobre/vacía (típico de fichas C21 sin redactar), la ficha es el HEADER
    //    con los datos clave (specs, precio, disponibilidad, mapa) — para que nunca salga una foto sola.
    // WhatsApp corta el caption de una imagen en ~1024 chars: si no entra, va foto + un único texto.
    const _desc = (p.description && String(p.description).trim()) ? String(p.description).trim() : '';
    const _hasRichDesc = _desc.length >= 120;
    let cap, _overflow = null;
    if (_hasRichDesc) {
      // Agregamos el link de Maps al final SOLO si entra (la descripción no suele traerlo).
      // Umbral 1000 (no 1024): margen porque los emojis cuentan distinto en WhatsApp.
      const _mapsLine = (p.maps_url && (_desc.length + String(p.maps_url).length + 8) <= 1000) ? `\n🗺️ ${p.maps_url}` : '';
      const _fitCap = (p.ficha_caption && String(p.ficha_caption).trim()) ? String(p.ficha_caption).trim() : '';
      // v0.9.480: los formatos van pegados a la descripción si entran en el mismo caption.
      if ((_desc.length + _extraBlock.length) <= 1000) { cap = _desc + _extraBlock + _mapsLine; }
      // v0.9.469 — descripción muy larga: usamos la versión que adecuó la IA (entra en 1 mensaje, sin perder datos).
      // v0.9.480 — en un PROYECTO los formatos son lo más valioso de la ficha: se anexan SIEMPRE.
      // Si no entran junto al texto condensado, se recorta el TEXTO (no la lista de tipologías).
      else if (_fitCap) { cap = _fitTo(_fitCap, _extraBlock, 1024); }
      // Sin versión IA (no configurada o falló): foto + datos clave (+ formatos) y la descripción como texto aparte.
      else { cap = _fitTo(_headerBase, _extraBlock, 1000) || `🏠 *${p.title}*`; _overflow = _desc; }
    } else {
      const _body = _headerBase + (_desc ? `\n\n${_desc}` : '') + _extraBlock;
      if (_body.length <= 1024) { cap = _body; }
      else { cap = _fitTo(_headerBase, _extraBlock, 1000) || `🏠 *${p.title}*`; _overflow = _desc || null; }
    }
    // v0.9.229 — la ficha manda SOLO el SET DESTACADO: las fotos que el dueño marcó "ficha"
    // (image_featured). Si ninguna está marcada → solo la foto principal (imgs[0]). El resto de
    // la galería va a PEDIDO ("muéstrame la cocina"). Antes mandaba las primeras 5 = bombardeo.
    const _feat = (p.image_featured && typeof p.image_featured === 'object') ? p.image_featured : {};
    const _fichaImgs = imgs.filter(u => _feat[u]);
    const fichaSet = (_fichaImgs.length ? _fichaImgs : (imgs.length ? [imgs[0]] : [])).slice(0, 6);
    const _quoteId = sender_type === 'bot' ? await _lastInboundWaId(conversation.id) : null; // v0.9.377 reply-quote
    const r = fichaSet.length ? await meta.sendImage(phone, fichaSet[0], cap, ctx, _quoteId) : await meta.sendText(phone, _full, true, ctx, _quoteId);
    await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
       VALUES ($1,$2,'outgoing',$3,$4,$5,$6,$7,$8)`,
      [conversation.id, r.wa_message_id, sender_type, fichaSet.length ? 'image' : 'text', cap, fichaSet[0] || null, r.success ? 'sent' : 'failed', r.error]
    );
    // v0.9.184: descripción larga como mensaje de TEXTO aparte (cuando no entró en el caption).
    if (_overflow && fichaSet.length) {
      try {
        const rt = await meta.sendText(phone, _overflow, true, ctx);
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'text',$4,$5,$6)`,
          [conversation.id, rt.wa_message_id, sender_type, _overflow, rt.success ? 'sent' : 'failed', rt.error]);
      } catch (e) {}
    }
    // v0.9.150/229: las demás fotos DESTACADAS (después de la 1ª) van con su etiqueta como
    // caption Y se REGISTRAN en `messages` (el inbox del CRM = lo que recibe el cliente).
    for (let k = 1; k < fichaSet.length; k++) {
      try {
        const rk = await meta.sendImage(phone, fichaSet[k], labels[fichaSet[k]] || '', ctx);
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
           VALUES ($1,$2,'outgoing',$3,'image',$4,$5,$6,$7)`,
          [conversation.id, rk.wa_message_id, sender_type, labels[fichaSet[k]] || '', fichaSet[k], rk.success ? 'sent' : 'failed', rk.error]
        );
      } catch (e) {}
    }
    // v0.9.570 — ARTE DE LA PROMO vigente como mensaje aparte (después de la ficha). Se manda
    // así, y no como foto de la ficha, por dos razones: la foto del inmueble es la que vende el
    // producto, y separado el cliente puede reenviar solo el arte de la promo. Best-effort: si
    // falla el envío del arte, la ficha ya salió y no se rompe nada.
    try {
      const _promoImgs = _promos.activeImages(p.promotions);
      if (_promoImgs.length && fichaSet.length) {
        const _pcap = _promos.imageCaption(p.promotions);
        for (let k = 0; k < Math.min(_promoImgs.length, 2); k++) {
          const rp = await meta.sendImage(phone, _promoImgs[k], k === 0 ? _pcap : '', ctx);
          await db.query(
            `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
             VALUES ($1,$2,'outgoing',$3,'image',$4,$5,$6,$7)`,
            [conversation.id, rp.wa_message_id, sender_type, k === 0 ? _pcap : '', _promoImgs[k], rp.success ? 'sent' : 'failed', rp.error]
          );
        }
      }
    } catch (e) { console.warn('[promo] arte no enviado:', e.message); }
    // v0.9.37: documentos SOLO a pedido (send_docs) — ya no van con la ficha
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
    if (!r.success) return res.status(422).json({ success: false, error: r.error });
    return res.json({ success: true, wa_message_id: r.wa_message_id });
  }

  let result;
  let messageType = 'text';
  let mediaUrl = null;
  let bodyToStore = text || null;

  if (asset_id) {
    // Buscar el asset
    // v0.9.72 (auditoría P2): scoping por tenant — antes cualquier asset_id de
    // CUALQUIER org era enviable (IDOR). Regla = la misma del dispatch:
    // assets del propio tenant (tenant 1 ve además los legacy NULL).
    const assetRes = await db.query(
      `SELECT * FROM media_assets WHERE asset_id = $1 AND active = true
        AND (tenant_id = $2 OR ($2 = 1 AND tenant_id IS NULL))`,
      [asset_id, tenantId]
    );
    if (assetRes.rows.length === 0) {
      return res.status(404).json({ error: `Asset ${asset_id} no encontrado` });
    }
    const asset = assetRes.rows[0];

    // === Link bundle: 3 mensajes (caption + url + credenciales) ===
    if (asset.type === 'link') {
      const bundle = await sendLinkAssetBundle({
        conversation,
        asset,
        senderType: sender_type,
        overrideCaption: text,
        ctx,
      });
      if (!bundle.success) {
        return res.status(422).json({ success: false, error: bundle.error, messages: bundle.messages });
      }
      return res.json({ success: true, messages: bundle.messages });
    }

    // === v0.7.8 P2: media bundle (intro + media + follow-up) ===
    if (['video', 'image', 'document', 'audio'].includes(asset.type)) {
      const bundle = await sendMediaAssetBundle({
        conversation,
        asset,
        senderType: sender_type,
        overrideCaption: text,
        ctx,
      });
      if (!bundle.success) {
        return res.status(422).json({ success: false, error: bundle.error, messages: bundle.messages });
      }
      return res.json({ success: true, messages: bundle.messages });
    }

    return res.status(400).json({ error: 'Tipo de asset no soportado: ' + asset.type });
  } else if (_botBtns) {
    // v0.9.342/344 — Mensaje de texto con BOTONES (hasta 3) o LISTA (hasta 10) según el marcador de la IA.
    result = _botBtns.kind === 'list'
      ? await meta.sendInteractiveList(phone, _botBtns.body, 'Ver opciones', _botBtns.buttons, ctx)
      : await meta.sendInteractiveButtons(phone, _botBtns.body, _botBtns.buttons, ctx);
    if (result.success) {
      bodyToStore = _botBtns.body + '\n' + _botBtns.buttons.map((b) => `▫️ ${b.title}`).join(' · '); // legible en el panel
    } else {
      // Fallback defensivo: si Meta rechaza el interactivo, va texto plano con opciones numeradas.
      console.warn(`[bot-${_botBtns.kind}] interactivo falló, fallback a texto:`, result.error);
      result = await meta.sendText(phone, _botBtns.degraded, true, ctx);
      bodyToStore = _botBtns.degraded;
    }
  } else {
    // v0.9.396 — LA IA DECIDE: si Aitana marcó el mensaje con [voz] (para impulsar la venta) y el toggle
    // ai_decides está activo, ese mensaje sale como NOTA DE VOZ. El marcador SIEMPRE se saca del texto.
    if (sender_type === 'bot' && /^\s*\[voz\]/i.test(text || '')) {
      text = String(text).replace(/^\s*\[voz\]\s*/i, '');
      req.body.text = text;
      // v0.9.456 — CANDADO (caso real batería Maxiking): la IA marca [voz] en mensajes que ANUNCIAN
      // una ficha/foto ("te paso la ficha 👇") violando su regla → salía SOLO el audio y el cliente
      // quedaba esperando una foto que nunca llega. Si el texto anuncia un envío, NO se convierte acá:
      // sigue el camino normal (texto + ficha de n8n; el momento 'ficha' de abajo lo vozifica bien).
      const _annVoz = /👇|te (paso|comparto|presento|env[ií]o|mando|muestro) (la|el|los|las)? ?(ficha|foto|imagen|informaci[oó]n|detalle|propiedad|opci[oó]n)/i.test(text || '');
      if (!_annVoz) {
        const _va = await require('./voice-moments').sendVoiceMoment('ai_decides', { tenantId, conversationId: conversation.id, lineId: conversation.line_id || null, phone, text, ctx });
        if (_va.sent) return res.json({ success: true, voice: true, moment: 'ai_decides', wa_message_id: _va.wa_message_id });
      }
    }
    // v0.9.394 — SALUDO INICIAL como NOTA DE VOZ (solo el primer saliente de la conversación, si está activo).
    // Best-effort: si no corresponde (no es el primero / apagado / falla), sigue el camino de texto de siempre.
    if (sender_type === 'bot') {
      const _vg = await require('./voice-moments').sendVoiceMoment('greeting', { tenantId, conversationId: conversation.id, lineId: conversation.line_id || null, phone, text, ctx, firstOnly: true });
      if (_vg.sent) return res.json({ success: true, voice: true, moment: 'greeting', wa_message_id: _vg.wa_message_id });
    }
    // Mensaje de texto puro
    // v0.9.372 — TYPING HUMANIZADO: si es el BOT y el tenant lo tiene activo, el texto
    // sale en burbujas con "escribiendo…" + pausas aleatorias, EN BACKGROUND (a n8n se
    // le responde ya). El INSERT en messages lo hace la secuencia, burbuja por burbuja.
    // v0.9.374 — NO humanizar el turno que ANUNCIA una ficha: n8n envía el asset justo
    // después del texto; si el texto se demora en burbujas, la ficha llega ANTES y el
    // "👇" queda apuntando a algo que ya pasó (visto en la prueba en vivo del 372).
    const _announcesAsset = /👇|te (paso|comparto|presento|env[ií]o|mando|muestro) (la|el|los|las)? ?(ficha|foto|imagen|informaci[oó]n|detalle|propiedad|opci[oó]n)/i.test(text || ''); // v0.9.456: + foto/imagen/muestro
    // v0.9.395 — FICHA ESTRELLA con AUDIO: n8n manda el ANUNCIO ("te paso la ficha 👇") como un mensaje de
    // texto separado (sin property_id) justo antes de la ficha. Si el momento 'ficha' está activo, ese anuncio
    // sale como NOTA DE VOZ (la ficha con datos+fotos llega después como imagen/texto, sin tocar). Best-effort.
    if (sender_type === 'bot' && _announcesAsset) {
      const _vfa = await require('./voice-moments').sendVoiceMoment('ficha', { tenantId, conversationId: conversation.id, lineId: conversation.line_id || null, phone, text, ctx });
      if (_vfa.sent) return res.json({ success: true, voice: true, moment: 'ficha', wa_message_id: _vfa.wa_message_id });
    }
    if (sender_type === 'bot' && !_announcesAsset && await _tenantHumanizeOn(tenantId)) {
      const bubbles = _splitHumanBubbles(text);
      if (bubbles.length) {
        _sendHumanized({ conversation, phone, ctx, bubbles, senderType: sender_type })
          .catch((e) => console.error('[humanize] secuencia falló:', e.message));
        return res.json({ success: true, humanized: true, bubbles: bubbles.length, conversation_id: conversation.id });
      }
    }
    result = await meta.sendText(phone, text, true, ctx);
  }

  // Guardar mensaje en BD (siempre, exitoso o no)
  await db.query(
    `INSERT INTO messages
     (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message)
     VALUES ($1, $2, 'outgoing', $3, $4, $5, $6, $7, $8)`,
    [
      conversation.id,
      result.wa_message_id,
      sender_type,
      messageType,
      bodyToStore,
      mediaUrl,
      result.success ? 'sent' : 'failed',
      result.error,
    ]
  );

  await db.query(
    'UPDATE conversations SET last_message_at = NOW() WHERE id = $1',
    [conversation.id]
  );

  if (!result.success) {
    return res.status(422).json({
      success: false,
      error: result.error,
      conversation_id: conversation.id,
    });
  }

  res.json({
    success: true,
    conversation_id: conversation.id,
    wa_message_id: result.wa_message_id,
  });
});

/**
 * POST /api/whatsapp/lead
 * n8n llama aquí cuando califica una conversación como lead caliente, O
 * cuando detecta que hay que escalar inmediatamente sin calificación.
 *
 * Body: {
 *   phone, name?, email?, company?,
 *   vertical, bant, spin, score, summary,
 *   take_over: true,    // si true, pasa la conversación a modo humano
 *   escalate_now: false,// v0.7.11: si true, fuerza el handover aunque no esté calificado
 *   reason: string      // v0.7.11: motivo del handover (ej: "escalation_unknown_vertical")
 * }
 */
// v0.9.348 — limpia nulls/vacíos de un search_profile entrante (shallow + attributes).
// Motivo: Gemini manda "location": null en los turnos donde el cliente no repite la zona,
// y el merge jsonb (`||`) pisaba el valor YA capturado → search_profile.location siempre
// terminaba null (el heatmap de zonas quedaba vacío). null nunca debe borrar un dato sabido.
function _spStripNulls(sp) {
  if (!sp || typeof sp !== 'object' || Array.isArray(sp)) return null;
  const out = {};
  for (const [k, v] of Object.entries(sp)) {
    if (v == null || (typeof v === 'string' && !v.trim())) continue;
    if (k === 'attributes' && typeof v === 'object' && !Array.isArray(v)) {
      const at = {};
      for (const [ak, av] of Object.entries(v)) {
        if (av == null || (typeof av === 'string' && !av.trim())) continue;
        at[ak] = av;
      }
      if (Object.keys(at).length) out.attributes = at;
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// v0.9.369 — STRAIGHT LINE (Belfort): sanitiza el estado `sl` que emite el bot cada turno.
// Estructura canónica: { p, v, e (0-10 enteros), archetype (ready|shopping|curious|dragged),
// threshold (low|medium|high), intel { likes, dislikes, pain, why, ideal, decisive_factor } }.
// Mismo espíritu que _spStripNulls: un null/valor inválido NUNCA borra un dato ya capturado
// (se descarta antes del merge jsonb ||). Devuelve null si no queda nada útil.
const _SL_ARCHETYPES = ['ready', 'shopping', 'curious', 'dragged'];
const _SL_THRESHOLDS = ['low', 'medium', 'high'];
const _SL_INTEL_KEYS = ['likes', 'dislikes', 'pain', 'why', 'ideal', 'decisive_factor'];
function _slClean(sl) {
  if (!sl || typeof sl !== 'object' || Array.isArray(sl)) return null;
  const out = {};
  for (const k of ['p', 'v', 'e']) {
    if (sl[k] == null || sl[k] === '') continue; // null NUNCA se vuelve 0 (pisaría un valor capturado)
    const n = Number(sl[k]);
    if (Number.isFinite(n)) out[k] = Math.max(0, Math.min(10, Math.round(n)));
  }
  const arch = String(sl.archetype || '').trim().toLowerCase();
  if (_SL_ARCHETYPES.includes(arch)) out.archetype = arch;
  const thr = String(sl.threshold || '').trim().toLowerCase();
  if (_SL_THRESHOLDS.includes(thr)) out.threshold = thr;
  if (sl.intel && typeof sl.intel === 'object' && !Array.isArray(sl.intel)) {
    const it = {};
    for (const ik of _SL_INTEL_KEYS) {
      const v = sl.intel[ik];
      if (typeof v === 'string' && v.trim()) it[ik] = v.trim().slice(0, 300);
    }
    if (Object.keys(it).length) out.intel = it;
  }
  return Object.keys(out).length ? out : null;
}

// Merge de sl_state (se usa inline en los UPDATE): shallow para p/v/e/archetype/threshold
// (el turno más nuevo manda) pero `intel` se ACUMULA campo a campo — un `||` plano pisaría
// el objeto intel completo con el del último turno y se perderían respuestas anteriores.
function _slMergedJson(current, incoming) {
  const cur = (current && typeof current === 'object') ? current : {};
  const inc = (incoming && typeof incoming === 'object') ? incoming : {};
  const out = { ...cur, ...inc };
  if (cur.intel || inc.intel) out.intel = { ...(cur.intel || {}), ...(inc.intel || {}) };
  return out;
}

router.post('/whatsapp/lead', requireN8nSecret, async (req, res) => {
  const {
    phone, name, email, company, vertical,
    bant, spin, score, summary,
    search_profile = null,   // v0.9.299 — perfil de búsqueda genérico
    take_over = true,
    escalate_now = false,   // v0.7.11
    reason = null,          // v0.7.11
  } = req.body;

  if (!phone) return res.status(400).json({ error: 'phone required' });

  // v0.9.74 (pedido): separamos "registrar lead + notificar" de "pasar a humano".
  // La CALIFICACIÓN ya NO pasa la conversación a 'human': Aitana sigue atendiendo
  // (cierra la visita con el link de agenda, responde dudas) hasta que un humano
  // tome el control MANUALMENTE desde el panel ("Tomar control"). Así no quedan
  // mensajes del cliente sin responder con la visita a medio agendar.
  // SOLO la escalación explícita (cliente pide una persona / reclamo) hace el
  // handoff automático. El take_over del body de n8n viene hardcodeado en true y
  // por eso NO decide el modo: el modo lo decide únicamente escalate_now.
  // v0.9.114 (pedido de José): el handoff a humano es SOLO MANUAL (botón "Tomar
  // control" del panel). Aitana NUNCA pasa sola a 'human' — ni siquiera ante
  // escalate_now (p.ej. cuando el cliente menciona el nombre del dueño y la IA lo
  // interpreta como "quiere hablar con una persona"). El bot sigue atendiendo.
  // escalate_now se conserva solo para REGISTRAR el handover_request y NOTIFICAR
  // al dueño (que entonces decide tomar el control a mano), sin silenciar al bot.
  const shouldFlipMode = false;                        // handoff = solo manual (botón del panel)
  const shouldTakeOver = take_over || escalate_now;    // registra lead/handover + notifica (igual que antes)

  // v0.9.44 (auditoría C-1): un mismo phone puede existir en VARIOS tenants
  // (UNIQUE es (tenant_id, phone)). Sin orden determinístico se podía pisar el
  // lead de otra organización. Se toma la conversación con actividad más
  // reciente (la que disparó el dispatch a n8n).
  const convRes = await db.query(
    'SELECT * FROM conversations WHERE phone = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1',
    [phone]
  );
  if (convRes.rows.length === 0) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const conv = convRes.rows[0];

  // v0.9.310 — la SOLICITUD DE LLAMADA INMEDIATA debe avisar SIEMPRE, incluso en soporte/postventa
  // (donde /whatsapp/lead hace early-return). Se dispara acá; abajo NO se re-dispara para call_now.
  if (reason === 'call_now') {
    notifyCallRequest({ conversation: conv, conversationId: conv.id, contactName: conv.contact_name || phone, phone, summary, vertical })
      .catch((e) => console.error('⚠️  notifyCallRequest (early) falló:', e.message));
  }

  // v0.9.34: POST-VENTA = atención al cliente, NO se califica.
  // Si el bot igual manda calificación (el modelo a veces insiste), se ignora.
  if ((conv.stage || 'venta') === 'postventa') {
    return res.json({ ok: true, skipped: 'postventa', detail: 'Conversación en post-venta: no se crean leads ni se califica.' });
  }

  // v0.9.305 — el lead HEREDA el perfil de búsqueda ACUMULADO en la conversación (capturado
  // pre-calificación por /progress), fusionado con el que manda el bot en este turno.
  // v0.9.348 — el perfil entrante se LIMPIA de nulls/vacíos antes de mergear: Gemini manda
  // "location": null en turnos donde no la repite y el merge jsonb pisaba el valor ya capturado.
  const _convProfile = (conv.search_profile && typeof conv.search_profile === 'object') ? conv.search_profile : null;
  const _incProfile = _spStripNulls(search_profile);
  let _effProfile = (_convProfile || _incProfile) ? Object.assign({}, _convProfile || {}, _incProfile || {}) : null;
  if (_effProfile && _convProfile && _incProfile && (_convProfile.attributes || _incProfile.attributes)) {
    _effProfile.attributes = Object.assign({}, _convProfile.attributes || {}, _incProfile.attributes || {});
  }

  // Upsert lead
  const leadRes = await db.query(
    `INSERT INTO leads
       (conversation_id, phone, name, email, company, vertical, bant, spin, score, summary, status, tenant_id, search_profile)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'new', $11, $12)
     ON CONFLICT (conversation_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, leads.name),
           email = COALESCE(EXCLUDED.email, leads.email),
           company = COALESCE(EXCLUDED.company, leads.company),
           vertical = COALESCE(EXCLUDED.vertical, leads.vertical),
           bant = COALESCE(EXCLUDED.bant, leads.bant),
           spin = COALESCE(EXCLUDED.spin, leads.spin),
           score = GREATEST(EXCLUDED.score, leads.score),
           summary = COALESCE(EXCLUDED.summary, leads.summary),
           search_profile = CASE
             WHEN EXCLUDED.search_profile IS NOT NULL
             THEN COALESCE(leads.search_profile, '{}'::jsonb) || EXCLUDED.search_profile
             ELSE leads.search_profile
           END,
           tenant_id = EXCLUDED.tenant_id,
           updated_at = NOW()
     RETURNING *`,
    [
      conv.id, phone, name, email, company, vertical,
      bant ? JSON.stringify(bant) : null,
      spin ? JSON.stringify(spin) : null,
      score || 0, summary, conv.tenant_id,
      _effProfile ? JSON.stringify(_effProfile) : null,   // v0.9.305 — perfil acumulado (conv) + turno
    ]
  );

  // v0.9.369 — STRAIGHT LINE: el lead hereda el sl_state ACUMULADO de la conversación
  // (la fuente de verdad — /progress ya viene mergeando turno a turno con intel campo a campo).
  // Best-effort: columnas sin migrar → se ignora.
  try {
    await db.query(
      `UPDATE leads l SET sl_state = c.sl_state
         FROM conversations c
        WHERE c.id = l.conversation_id AND l.conversation_id = $1 AND c.sl_state IS NOT NULL`,
      [conv.id]
    );
  } catch (e) { /* sin migrar → ignorar */ }

  // Actualizar conversación: vertical, score, modo
  await db.query(
    `UPDATE conversations
     SET vertical = COALESCE($1, vertical),
         current_score = GREATEST($2, current_score),
         mode = CASE WHEN $3 THEN 'human' ELSE mode END
     WHERE id = $4`,
    [vertical, score || 0, shouldFlipMode, conv.id]
  );

  // Registrar handover request
  if (shouldTakeOver) {
    // v0.7.11: el motivo refleja si fue calificación o escalación
    const handoverReason = escalate_now
      ? (reason || 'escalate_now')
      : 'qualified_lead';

    await db.query(
      `INSERT INTO handover_requests (conversation_id, reason, triggered_by)
       VALUES ($1, $2, 'bot')`,
      [conv.id, handoverReason]
    );

    // v0.7.11: nota interna auto-generada con el snapshot del lead
    // (al igual que cuando el humano hace el handover desde el panel, P5 de v0.7.8)
    try {
      const lines = [
        shouldFlipMode
          ? `🚨 HANDOVER AUTOMÁTICO por escalación (escalate_now)`
          : `✅ LEAD CALIFICADO — Aitana sigue atendiendo (no se hizo handoff automático). Tomá el control manual desde el panel cuando quieras seguir vos.`,
        reason ? `Motivo: ${reason}` : null,
        `Score: ${score || 0}`,
        vertical ? `Vertical: ${vertical}` : null,
        name ? `Nombre: ${name}` : null,
        company ? `Empresa: ${company}` : null,
        email ? `Email: ${email}` : null,
        summary ? `Resumen del bot: ${summary}` : null,
      ].filter(Boolean);
      await db.query(
        `INSERT INTO conversation_notes (conversation_id, body, author)
         VALUES ($1, $2, 'system_handover')`,
        [conv.id, lines.join('\n')]
      );
    } catch (e) {
      console.warn('No se pudo crear nota de handover (lead endpoint):', e.message);
    }

    // Notificar al dueño por WhatsApp (no bloquea la respuesta)
    // v0.9.310 — call_now YA se avisó arriba (funciona también en soporte) → no re-disparar.
    if (reason !== 'call_now') {
      notifyOwnerOfNewLead({
        conversation: conv, // v0.9.19: para resolver org + línea
        conversationId: conv.id,
        contactName: conv.contact_name || phone,
        phone,
        score: score || 0,
        vertical,
        summary,
        reason,
        escalate_now,  // v0.7.11: pasamos el flag para que el mensaje al dueño sea distinto
      }).catch(e => console.error('⚠️  Notificación al dueño falló:', e.message));
    }
  }

  res.json({ success: true, lead: leadRes.rows[0], handover: shouldTakeOver });
});

/**
 * v0.9.311 — resumen IA de la conversación para el aviso de llamada (best-effort; sin key → null).
 */
async function _summarizeConversationForAlert(conversationId) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !conversationId) return null;
  try {
    const msgs = await db.query(
      `SELECT direction, sender_type, COALESCE(NULLIF(body, ''), NULLIF(media_caption, ''), NULLIF(transcription, ''), '[' || type || ']') AS text
         FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 18`, [conversationId]);
    if (!msgs.rows.length) return null;
    const transcript = msgs.rows.reverse().map((m) => {
      const who = m.direction === 'incoming' ? 'CLIENTE' : (m.sender_type === 'human' ? 'ASESOR' : 'AITANA');
      return `${who}: ${String(m.text || '').slice(0, 300)}`;
    }).join('\n').slice(0, 5000);
    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: `Resumí esta conversación de WhatsApp en 2-3 líneas para un asesor que va a LLAMAR al cliente enseguida. Enfocate en qué necesita/quiere el cliente, qué se habló y por qué pide la llamada. Español, directo, sin saludos ni encabezados.\n\n${transcript}` }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 220, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
    const t = (gr.data && gr.data.candidates && gr.data.candidates[0] && gr.data.candidates[0].content && gr.data.candidates[0].content.parts && gr.data.candidates[0].content.parts[0] && gr.data.candidates[0].content.parts[0].text || '').trim();
    return t ? t.slice(0, 700) : null;
  } catch (e) { console.warn('[call_request] resumen IA falló:', (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message); return null; }
}

/**
 * v0.9.303 — SOLICITUD DE LLAMADA INMEDIATA (evento propio, configurable POR LÍNEA).
 * El cliente pidió que lo llamen YA (el bot marca reason='call_now'). Manda push a los
 * roles definidos para la LÍNEA de la conversación + WhatsApp a un número específico
 * (mensaje normal <24h; plantilla aprobada si está fuera de la ventana). Best-effort.
 */
async function notifyCallRequest({ conversation, conversationId, contactName, phone, summary, vertical }) {
  const tenantId = (conversation && conversation.tenant_id) || 1;
  const lineId = (conversation && conversation.line_id != null) ? conversation.line_id : null;

  const recent = await db.query(
    `SELECT 1 FROM handover_requests WHERE conversation_id = $1 AND created_at > NOW() - INTERVAL '30 minutes' AND notified_owner = TRUE LIMIT 1`,
    [conversationId]).catch(() => ({ rows: [] }));
  if (recent.rows.length > 0) { console.log(`ℹ️  [call_request] conv ${conversationId} ya notificada, omito`); return; }

  const notifyPrefs = require('./notify-prefs');
  let cfg = { push_roles: ['owner', 'supervisor'], whatsapp: true, phone: '' };
  try { cfg = notifyPrefs.resolveCallRequest(await notifyPrefs.getNotifPrefs(tenantId), lineId); } catch (e) { /* defaults */ }

  // PUSH a los roles configurados (por línea)
  try {
    const pushNotifier = require('./push-notifier');
    if (pushNotifier.isConfigured() && cfg.push_roles && cfg.push_roles.length) {
      pushNotifier.broadcast({
        title: `📞 ${contactName || phone} pide LLAMADA INMEDIATA`,
        body: `Tocá para abrir el chat y llamar${vertical ? ' · ' + vertical : ''}`,
        url: `/panel/?conv=${encodeURIComponent(phone)}`,
        conversation_phone: phone,
      }, tenantId, { roles: cfg.push_roles }).catch((e) => console.warn('[call_request] push falló:', e.message));
    }
  } catch (e) { /* best-effort */ }

  // WhatsApp a un número específico (fallback: alert_phone de la org)
  if (cfg.whatsapp) {
    let target = (cfg.phone && cfg.phone.trim()) || null;
    if (!target) {
      try { const t = await db.query('SELECT alert_phone FROM tenants WHERE id = $1', [tenantId]); target = t.rows[0] ? (t.rows[0].alert_phone || null) : null; } catch (e) { /* sin alert_phone */ }
      if (!target && tenantId === 1) target = process.env.OWNER_PHONE || null;
    }
    if (target) {
      const meta = require('./meta');
      const ctx = await getConversationMetaCtx(conversation || { tenant_id: tenantId });
      const digits = String(phone || '').replace(/[^0-9]/g, '');
      // v0.9.311 — resumen IA de la charla para que el asesor llame con contexto (fallback: summary del bot).
      let _resumen = (summary && String(summary).trim() && !/solicita una llamada/i.test(String(summary))) ? String(summary).trim() : '';
      try { const _ai = await _summarizeConversationForAlert(conversationId); if (_ai) _resumen = _ai; } catch (e) {}
      const _panelBase = process.env.PANEL_PUBLIC_URL || 'https://app.sg-ventas.com/panel/';
      const _panelUrl = `${_panelBase}${_panelBase.includes('?') ? '&' : '?'}conv=${encodeURIComponent(phone)}`;
      const text = `📞 *SOLICITUD DE LLAMADA INMEDIATA*\n\nEl cliente pidió que lo llamen YA.\n\nCliente: ${contactName || phone}\nTeléfono: ${phone}${vertical ? '\nVertical: ' + vertical : ''}\n\n📝 Resumen: ${_resumen || 'Cliente solicita una llamada inmediata.'}\n\n🖥️ Abrir en el CRM:\n${_panelUrl}\n\n📞 Llamar por WhatsApp: https://wa.me/${digits}`;
      const tplName = (cfg.template && cfg.template.trim()) || process.env.CALL_ALERT_TEMPLATE_NAME || 'solicitud_llamada';
      const _comps = [{ type: 'body', parameters: [
        { type: 'text', text: String(contactName || phone) },
        { type: 'text', text: String(phone) },
      ] }];
      // v0.9.325 — regla de 24h: si el destinatario mandó inbound <24h → texto libre; si no → plantilla.
      const _within = await notifyPrefs.recipientWithin24h(tenantId, target).catch(() => false);
      if (_within) {
        let result = null;
        try { result = await meta.sendText(target, text, true, ctx); } catch (e) { result = { success: false, error: e.message }; }
        if (result && result.success === false && /re-?engagement|131047|24/i.test(String(result.error || ''))) {
          try { const tr = await meta.sendTemplate(target, tplName, 'es', _comps, ctx); if (!tr.success) console.warn(`⚠️  [call_request] plantilla ${tplName} falló:`, tr.error); } catch (e) { console.warn('⚠️  [call_request] fallback plantilla:', e.message); }
        }
      } else {
        try { const tr = await meta.sendTemplate(target, tplName, 'es', _comps, ctx); if (!tr.success) console.warn(`⚠️  [call_request] plantilla ${tplName} falló:`, tr.error); } catch (e) { console.warn('⚠️  [call_request] plantilla falló:', e.message); }
      }
    }
  }

  // v0.9.310 — marcador anti-spam: dejamos un handover_request notificado (así el chequeo de 30 min
  // funciona también en soporte, donde no se crea handover_request por el early-return de postventa).
  await db.query(
    `INSERT INTO handover_requests (conversation_id, reason, triggered_by, notified_owner, notified_at) VALUES ($1, 'call_now', 'bot', TRUE, NOW())`,
    [conversationId]).catch(() => {});
}

/**
 * Notifica al dueño (José) por WhatsApp cuando hay un lead calificado.
 * v0.8.2: 3 templates según reason:
 *   - call_now           → 🔴 URGENTE, cliente quiere llamada AHORA
 *   - qualified_lead     → 🚨 normal, lead calificado para handover
 *   - escalation_*       → 🚨 escalación inmediata (rubro fuera, complaint, etc.)
 * No bloquea el flujo — si falla, solo se loguea.
 */
async function notifyOwnerOfNewLead({ conversation, conversationId, contactName, phone, score, vertical, summary, reason, escalate_now }) {
  // v0.9.303 — "llamada inmediata" es un EVENTO PROPIO (call_request), configurable POR LÍNEA.
  if (reason === 'call_now') {
    return notifyCallRequest({ conversation, conversationId, contactName, phone, summary, vertical })
      .catch((e) => console.error('⚠️  notifyCallRequest falló:', e.message));
  }
  // v0.9.19 — multi-tenant: el destinatario es el alert_phone de la ORG del
  // lead (configurable por el owner). Fallback legacy: tenant 1 → OWNER_PHONE.
  const tenantId = (conversation && conversation.tenant_id) || 1;
  let alertPhone = null;
  try {
    const t = await db.query('SELECT alert_phone FROM tenants WHERE id = $1', [tenantId]);
    alertPhone = t.rows[0] ? (t.rows[0].alert_phone || null) : null;
  } catch (e) { /* migración v0.9.19 pendiente → fallback */ }
  if (!alertPhone && tenantId === 1) alertPhone = process.env.OWNER_PHONE || null;

  // Anti-spam: no notificar más de 1 vez cada 30 minutos por la misma conversación
  const recent = await db.query(
    `SELECT 1 FROM handover_requests 
     WHERE conversation_id = $1 
       AND created_at > NOW() - INTERVAL '30 minutes'
       AND notified_owner = TRUE
     LIMIT 1`,
    [conversationId]
  ).catch(() => ({ rows: [] }));

  if (recent.rows.length > 0) {
    console.log(`ℹ️  Conversación ${conversationId} ya notificada recientemente, omitiendo`);
    return;
  }

  // v0.9.192 — preferencias del evento 'hot_lead' (qué roles reciben push + si va WhatsApp).
  let _hotEv = { push_roles: ['owner', 'supervisor'], whatsapp: true };
  try { const _np = require('./notify-prefs'); _hotEv = _np.resolveHotLead(await _np.getNotifPrefs(tenantId), conversation && conversation.line_id) || _hotEv; } catch (e) {}
  // v0.9.336 — override por línea del número de alertas (si la línea definió uno propio)
  if (_hotEv.phone && String(_hotEv.phone).trim()) alertPhone = String(_hotEv.phone).trim();

  // v0.9.369 — STRAIGHT LINE: etiqueta accionable para el equipo (dieces + arquetipo).
  // Se lee de la conversación (acumulado); best-effort.
  let _slTag = '';
  try {
    const _slq = await db.query(`SELECT (to_jsonb(conversations) -> 'sl_state') AS s FROM conversations WHERE id = $1`, [conversationId]);
    const _s = _slq.rows[0] && _slq.rows[0].s;
    if (_s && typeof _s === 'object') {
      const _arch = { ready: '🔥 LISTO PARA COMPRAR', shopping: '🛒 comprará en 3-6 meses', curious: '👀 curioseando', dragged: '🧊 sin intención' }[_s.archetype] || null;
      const _pve = ['p', 'v', 'e'].filter(k => _s[k] != null).map(k => k.toUpperCase() + _s[k]).join(' ');
      _slTag = [_pve || null, _arch].filter(Boolean).join(' · ');
    }
  } catch (e) { /* sin migrar → sin etiqueta */ }

  // v0.9.20 — PUSH al equipo de la org (PWA celular/desktop). Va aunque la org
  // no tenga alert_phone. v0.9.192: dirigido SOLO a los roles configurados.
  try {
    const pushNotifier = require('./push-notifier');
    if (pushNotifier.isConfigured() && _hotEv.push_roles.length) {
      const pushTitle = reason === 'call_now'
        ? `🔴 ${contactName || phone} pide LLAMADA YA`
        : `🚨 Lead calificado: ${contactName || phone}`;
      pushNotifier.broadcast({
        title: pushTitle,
        body: `Score ${score || 0}/100${vertical ? ' · ' + vertical : ''}${_slTag ? ' · ' + _slTag : ''} — tocá para abrir el chat`,
        url: `/panel/?conv=${encodeURIComponent(phone)}`,
        conversation_phone: phone,
      }, tenantId, { roles: _hotEv.push_roles }).catch(e => console.warn('[alerts] push falló:', e.message));
    }
  } catch (e) { /* push es best-effort */ }

  // v0.9.192: el WhatsApp al alert_phone ahora es OPCIONAL (toggle por evento). Si está
  // apagado (o no hay alert_phone), ya mandamos el push y cerramos acá.
  if (!alertPhone || !_hotEv.whatsapp) {
    console.log(`ℹ️  [alerts] tenant ${tenantId} — push enviado${alertPhone ? ' (WhatsApp hot_lead desactivado)' : ' (sin alert_phone)'}`);
    await db.query(
      `UPDATE handover_requests SET notified_owner = TRUE, notified_at = NOW()
       WHERE conversation_id = $1 AND created_at > NOW() - INTERVAL '5 minutes'`,
      [conversationId]
    ).catch(() => {});
    return;
  }

  const verticalLabel = vertical || 'sin definir';
  // v0.9.19: link SIN token — cada uno entra con SU sesión y cae en la conversación
  const panelBase = process.env.PANEL_PUBLIC_URL || 'https://app.sg-ventas.com/panel/';
  const panelUrl = `${panelBase}${panelBase.includes('?') ? '&' : '?'}conv=${encodeURIComponent(phone)}`;

  let header, urgencyTag, callToAction;
  if (reason === 'call_now') {
    header = '🔴 *LLAMADA EN CALIENTE solicitada*';
    urgencyTag = '⏰ Cliente espera tu llamada AHORA';
    callToAction = `Llamar por WhatsApp: https://wa.me/${phone.replace(/[^0-9]/g, '')}`;
  } else if (escalate_now) {
    header = '🚨 *Escalación inmediata*';
    urgencyTag = `Motivo: ${reason || 'no especificado'}`;
    callToAction = `Abrir conversación:\n${panelUrl}`;
  } else {
    header = '🚨 *Lead calificado*';
    urgencyTag = `Score: ${score}/100${_slTag ? `\n📈 SL: ${_slTag}` : ''}`;
    callToAction = `Abrir conversación:\n${panelUrl}`;
  }

  const text = `${header}

Cliente: ${contactName}
Teléfono: ${phone}
Vertical: ${verticalLabel}
${urgencyTag}

${summary || '(sin resumen)'}

${callToAction}`;

  // v0.9.19: enviar POR LA LÍNEA de la org (ctx por conversación; fallback tenant→global)
  const meta = require('./meta');
  const ctx = await getConversationMetaCtx(conversation || { tenant_id: tenantId });
  const _tplName = (_hotEv.template && _hotEv.template.trim()) || process.env.ALERT_TEMPLATE_NAME || 'nuevo_lead_calificado';
  const _comps = [{ type: 'body', parameters: [
    { type: 'text', text: String(contactName || phone) },
    { type: 'text', text: String(score || 0) },
    { type: 'text', text: String(phone) },
  ]}];
  // v0.9.325 — regla de 24h: destinatario con inbound <24h → texto; si no → plantilla (3 vars).
  const _within = await require('./notify-prefs').recipientWithin24h(tenantId, alertPhone).catch(() => false);
  let result = null;
  if (_within) {
    result = await meta.sendText(alertPhone, text, true, ctx);
    if (result && result.success === false && /re-?engagement|131047|24/i.test(String(result.error || ''))) {
      try { const tr = await meta.sendTemplate(alertPhone, _tplName, 'es', _comps, ctx); if (!tr.success) console.warn(`⚠️ [alerts] plantilla ${_tplName} falló:`, tr.error); } catch (e) { console.warn('⚠️ [alerts] fallback plantilla:', e.message); }
    }
  } else {
    try { const tr = await meta.sendTemplate(alertPhone, _tplName, 'es', _comps, ctx); if (!tr.success) console.warn(`⚠️ [alerts] plantilla ${_tplName} falló:`, tr.error); } catch (e) { console.warn('⚠️ [alerts] plantilla falló:', e.message); }
  }

  await db.query(
    `UPDATE handover_requests 
     SET notified_owner = TRUE, notified_at = NOW()
     WHERE conversation_id = $1 
       AND created_at > NOW() - INTERVAL '5 minutes'`,
    [conversationId]
  ).catch(e => console.error('No se pudo marcar como notificado:', e.message));

  console.log(`✅ [alerts] Notificación enviada (tenant=${tenantId}, dest=${alertPhone}, reason=${reason || 'qualified_lead'}, conv=${conversationId})`);
}

/**
 * PATCH /api/whatsapp/conversation/:phone/progress
 * n8n actualiza el progreso BANT/SPIN sin necesariamente crear lead.
 */
router.patch('/whatsapp/conversation/:phone/progress', requireN8nSecret, async (req, res) => {
  const { phone } = req.params;
  const { bant_progress, spin_progress, current_score, vertical, search_profile, sl = null } = req.body;

  // v0.9.5: capturar score anterior para detectar "cruce" hacia >=85
  // v0.9.44 (auditoría C-1): un phone puede existir en varios tenants — se opera
  // SOLO sobre la conversación con actividad más reciente (la del dispatch),
  // y el UPDATE va por id (no por phone, que pisaba todas las coincidencias).
  const before = await db.query(`SELECT id, tenant_id, current_score, stage, (to_jsonb(conversations) -> 'sl_state') AS sl_state FROM conversations WHERE phone = $1 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [phone]);
  if (before.rows.length === 0) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const prevScore = before.rows[0].current_score || 0;

  // v0.9.34: en POST-VENTA no se actualiza score/BANT/SPIN (es atención, no venta)
  if ((before.rows[0].stage || 'venta') === 'postventa') {
    return res.json({ ok: true, skipped: 'postventa' });
  }

  const result = await db.query(
    `UPDATE conversations SET
       bant_progress = COALESCE($1, bant_progress),
       spin_progress = COALESCE($2, spin_progress),
       current_score = COALESCE($3, current_score),
       vertical = COALESCE($4, vertical)
     WHERE id = $5
     RETURNING *`,
    [
      bant_progress ? JSON.stringify(bant_progress) : null,
      spin_progress ? JSON.stringify(spin_progress) : null,
      current_score, vertical, before.rows[0].id,
    ]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }

  // v0.9.305 — acumular el PERFIL DE BÚSQUEDA en la conversación (pre-calificación), best-effort.
  // v0.9.348 — se limpian los nulls/vacíos ANTES del merge: un "location": null de un turno
  // posterior pisaba la zona ya capturada (por eso el heatmap de zonas salía vacío).
  const _spClean = _spStripNulls(search_profile);
  if (_spClean) {
    await db.query(
      `UPDATE conversations SET search_profile = COALESCE(search_profile, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify(_spClean), before.rows[0].id]
    ).catch(() => { /* columna sin migrar → ignorar */ });
  }

  // v0.9.369 — STRAIGHT LINE: acumular el estado SL (tres dieces + arquetipo + umbral + intel)
  // en la conversación, con merge en JS (intel campo a campo) y SYNC EN VIVO al lead si existe.
  // Best-effort: nunca rompe el hot path del bot.
  let _slMerged = null;
  const _slIncoming = _slClean(sl);
  if (_slIncoming) {
    try {
      _slMerged = _slMergedJson(before.rows[0].sl_state, _slIncoming);
      await db.query(
        `UPDATE conversations SET sl_state = $1::jsonb WHERE id = $2`,
        [JSON.stringify(_slMerged), before.rows[0].id]
      );
      await db.query(
        `UPDATE leads SET sl_state = $1::jsonb, updated_at = NOW() WHERE conversation_id = $2`,
        [JSON.stringify(_slMerged), before.rows[0].id]
      );
    } catch (e) { /* columna sin migrar → ignorar */ }
  }

  // v0.9.5: si el score cruzó el umbral 85 (de <85 a >=85), crear tarea automática
  //         "Llamar al lead caliente en 30 min". Solo se crea 1 vez por conversación
  //         (verificamos que no haya ya una task auto_created='call' pendiente).
  const newScore = result.rows[0].current_score || 0;
  const convId = result.rows[0].id;

  // v0.9.352 — SINCRONIZAR EL LEAD EN VIVO (si ya existe). Antes, el lead que ve el vendedor
  // (perfil de búsqueda, BANT y score) solo se actualizaba cuando n8n llamaba a /whatsapp/lead
  // en la calificación, por eso quedaba rezagado respecto de la conversación durante el chat.
  // Best-effort: si falla NO rompe el hot path del bot; GREATEST conserva el score pico (nunca
  // lo baja); solo afecta leads YA creados (no crea leads nuevos).
  try {
    await db.query(
      `UPDATE leads SET
         search_profile = CASE WHEN $2::jsonb IS NOT NULL
           THEN COALESCE(search_profile, '{}'::jsonb) || $2::jsonb ELSE search_profile END,
         bant = COALESCE($3, bant),
         score = GREATEST(COALESCE(score, 0), COALESCE($4, 0)),
         updated_at = NOW()
       WHERE conversation_id = $1`,
      [convId, _spClean ? JSON.stringify(_spClean) : null, bant_progress ? JSON.stringify(bant_progress) : null, newScore]
    ).catch(() => {});
  } catch (e) { /* best-effort: el lead puede no existir todavía o faltar la columna */ }
  if (prevScore < 85 && newScore >= 85) {
    try {
      const existing = await db.query(`
        SELECT id FROM tasks
         WHERE conversation_id = $1
           AND auto_created = true
           AND task_type = 'call'
           AND status IN ('pending', 'snoozed')
         LIMIT 1
      `, [convId]);

      if (existing.rows.length === 0) {
        const contactName = result.rows[0].contact_name || phone;
        // v0.9.44 (auditoría C-1): tenant de la conversación, NO 1 hardcodeado
        // (las tareas de leads calientes de otros tenants caían en SG Bolivia)
        await db.query(`
          INSERT INTO tasks (
            tenant_id, conversation_id, title, description,
            due_at, task_type, priority, auto_created
          ) VALUES (
            $4, $1, $2, $3,
            NOW() + INTERVAL '30 minutes', 'call', 'high', true
          )
        `, [
          convId,
          `Llamar a ${contactName}`,
          `Lead caliente (score ${newScore}). Aitana calificó hace 30 min — momento óptimo para llamada de cierre.`,
          result.rows[0].tenant_id || before.rows[0].tenant_id || 1, // v0.9.44
        ]);
        console.log(`📅 Tarea auto-creada: llamar a ${contactName} (score ${newScore})`);
      }
    } catch (err) {
      // No-fail: si la creación de tarea falla, no debe romper el flujo del bot
      console.error('⚠️  No se pudo crear tarea automática:', err.message);
    }
  }

  res.json({ success: true, conversation: result.rows[0] });
});

/**
 * GET /api/whatsapp/media/:mediaId
 * n8n llama aquí para descargar audio/imagen que mandó el cliente.
 * Devuelve base64 + mime para que Gemini lo procese.
 */
router.get('/whatsapp/media/:mediaId', requireN8nSecret, async (req, res) => {
  const { mediaId } = req.params;
  // v0.9.67: ?conversation_id= permite bajar el media con el token de la
  // línea/tenant correcto (tenants con token propio). Sin param = global (legacy).
  let ctx = null;
  if (req.query.conversation_id) {
    try {
      const cr = await db.query('SELECT id, tenant_id, line_id FROM conversations WHERE id = $1', [parseInt(req.query.conversation_id)]);
      if (cr.rows.length) ctx = await getConversationMetaCtx(cr.rows[0]);
    } catch (e) { /* ctx global */ }
  }
  const result = await meta.downloadMedia(mediaId, ctx);

  if (!result) {
    return res.status(404).json({ error: 'Media no encontrado o falló descarga' });
  }

  res.json({
    success: true,
    mime_type: result.mimeType,
    size_bytes: result.sizeBytes,
    base64: result.buffer.toString('base64'),
  });
});

/**
 * GET /api/whatsapp/media-assets
 * Catálogo de assets disponibles (para n8n y panel)
 */
router.get('/whatsapp/media-assets', requireTenantSession, async (req, res) => {
  // v0.9.27: FIX — este endpoint devolvía los assets de TODOS los tenants y
  // sin auth (el leak de v0.9.22d se arregló en el dispatch, pero no acá).
  // Ahora: sesión requerida + solo los assets del tenant (NULL = legacy tenant 1).
  const tenantId = req.isSuperAdmin
    ? (Number(req.query.tenant_id) || 1)
    : req.tenantId;
  const result = await db.query(
    `SELECT * FROM media_assets
     WHERE active = true AND (tenant_id = $1 OR ($1 = 1 AND tenant_id IS NULL))
     ORDER BY vertical, asset_id`,
    [tenantId]
  );
  res.json({ data: result.rows });
});

// =============================================================
// Endpoints para el panel admin
// =============================================================

/**
 * GET /api/admin/conversations
 * Lista de conversaciones con info resumida.
 */
router.get('/admin/conversations', requireTenantSession, requirePerm('nav_inbox'), async (req, res) => {
  const { mode, status = 'open', search } = req.query;

  let query = `
    SELECT
      c.*,
      l.name AS lead_name,
      l.score AS lead_score,
      l.status AS lead_status,
      l.vertical AS lead_vertical,
      (SELECT body FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC LIMIT 1) AS last_body,
      (SELECT type FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC LIMIT 1) AS last_type,
      tl.label AS line_label,
      EXISTS (SELECT 1 FROM appointments a WHERE a.conversation_id = c.id AND a.status IN ('pending','scheduled')) AS has_appt,
      tk.ticket_status,
      (vc.id IS NOT NULL) AS is_vip
    FROM conversations c
    LEFT JOIN leads l ON l.conversation_id = c.id
    LEFT JOIN tenant_lines tl ON tl.id = c.line_id
    LEFT JOIN LATERAL (
      SELECT status AS ticket_status FROM support_tickets st
      WHERE st.conversation_id = c.id ORDER BY st.id DESC LIMIT 1
    ) tk ON TRUE
    LEFT JOIN vip_contacts vc ON vc.tenant_id = c.tenant_id AND vc.phone = regexp_replace(c.phone, '[^0-9]', '', 'g')
    WHERE c.status = $1
  `;
  const params = [status];
  let i = 2;

  if (mode) {
    query += ` AND c.mode = $${i}`;
    params.push(mode);
    i++;
  }
  if (search) {
    query += ` AND (c.phone ILIKE $${i} OR c.contact_name ILIKE $${i})`;
    params.push(`%${search}%`);
    i++;
  }

  // v0.9.457 — FILTRO POR LÍNEA server-side. Antes NO existía: el panel se traía
  // las 100 conversaciones más recientes del tenant y filtraba en el cliente, así
  // que una línea con conversaciones viejas (o con muchas de otra línea por delante)
  // se veía VACÍA aunque tuviera tráfico. Ahora el LIMIT 100 se aplica ya filtrado.
  // Las conversaciones sin línea (line_id NULL: anteriores al multi-línea o traídas
  // por el historial de coexistencia) cuentan como de la línea POR DEFECTO, que es
  // donde el dueño las espera; si no, desaparecían de todas las vistas por línea.
  const _lineId = parseInt(req.query.line_id, 10);
  if (Number.isFinite(_lineId)) {
    query += ` AND (c.line_id = $${i} OR (c.line_id IS NULL AND EXISTS (
                 SELECT 1 FROM tenant_lines dl WHERE dl.id = $${i} AND dl.is_default = TRUE)))`;
    params.push(_lineId);
    i++;
  }

  // v0.9.309 — filtro por estado del TICKET (mesa de soporte). El panel lo manda solo con BPO on.
  const _ts = req.query.ticket_status;
  if (_ts === 'active') query += " AND tk.ticket_status IN ('open','in_progress','pending','escalated')";
  else if (_ts === 'resolved') query += " AND tk.ticket_status = 'resolved'";
  else if (_ts === 'closed') query += " AND tk.ticket_status = 'closed'";

  // v0.9.8: aislamiento por tenant
  const tf = tenantFilter(req, i, 'c.tenant_id');
  query += tf.clause;
  params.push(...tf.params);
  i += tf.params.length;

  // v0.9.14: agente con líneas asignadas → solo esas (o sin línea)
  const agentLines = await getAgentLineIds(req);
  if (agentLines) {
    query += ' AND (c.line_id = ANY($' + i + '::int[]) OR c.line_id IS NULL)';
    params.push(agentLines);
    i++;
  }

  // v0.9.29: agente con etapa asignada → solo conversaciones de esa etapa
  const stageScope = await getAgentStageScope(req);
  if (stageScope) {
    query += ` AND COALESCE(c.stage, 'venta') = $${i}`;
    params.push(stageScope);
    i++;
  }

  // v0.9.285: agente con canales asignados → solo esos canales
  const chanScope = await getAgentChannelScope(req);
  if (chanScope) {
    query += ` AND COALESCE(c.channel, 'whatsapp') = ANY($${i}::text[])`;
    params.push(chanScope);
    i++;
  }

  // v0.9.188: las conversaciones con cita activa (pendiente/agendada) suben arriba del inbox.
  // v0.9.251: las FIJADAS (prioritized_at, p.ej. al tomar una cita) van PRIMERO, arriba de todo.
  query += ' ORDER BY is_vip DESC, (c.prioritized_at IS NOT NULL) DESC, c.prioritized_at DESC NULLS LAST, has_appt DESC, c.last_message_at DESC NULLS LAST LIMIT 100';

  const result = await db.query(query, params);
  // v0.9.309 — flag de mesa de soporte: el panel muestra el filtro por estado SOLO si está on.
  let _supportOn = false;
  try {
    const _tid = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
    if (_tid) { const _se = await db.query('SELECT COALESCE(support_enabled, FALSE) AS on FROM tenants WHERE id = $1', [_tid]); _supportOn = !!(_se.rows[0] && _se.rows[0].on); }
  } catch (e) { /* columna sin migrar → false */ }
  res.json({ data: result.rows, support_enabled: _supportOn });
});

/**
 * GET /api/admin/conversations/activity
 * Endpoint liviano para polling: solo devuelve [{phone, last_message_at, mode, unread_count}]
 */
router.get('/admin/conversations/activity', requireTenantSession, async (req, res) => {
  const tf = tenantFilter(req, 1);
  let q = `SELECT id, phone, channel, last_message_at, mode, unread_count, status,
     EXISTS (SELECT 1 FROM vip_contacts v WHERE v.tenant_id = conversations.tenant_id AND v.phone = regexp_replace(conversations.phone, '[^0-9]', '', 'g')) AS is_vip
     FROM conversations WHERE status = 'open'${tf.clause}`;
  const params = [...tf.params];
  // v0.9.14: visibilidad por línea para agentes asignados
  const agentLines = await getAgentLineIds(req);
  if (agentLines) {
    q += ' AND (line_id = ANY($' + (params.length + 1) + '::int[]) OR line_id IS NULL)';
    params.push(agentLines);
  }
  // v0.9.29: visibilidad por etapa para agentes asignados
  const actStageScope = await getAgentStageScope(req);
  if (actStageScope) {
    q += ` AND COALESCE(stage, 'venta') = $${params.length + 1}`;
    params.push(actStageScope);
  }
  // v0.9.285: visibilidad por canal
  const actChanScope = await getAgentChannelScope(req);
  if (actChanScope) {
    q += ` AND COALESCE(channel, 'whatsapp') = ANY($${params.length + 1}::text[])`;
    params.push(actChanScope);
  }
  q += ' ORDER BY last_message_at DESC NULLS LAST LIMIT 200';
  const result = await db.query(q, params);
  res.json({ data: result.rows });
});

/**
 * GET /api/admin/conversations/:phone/messages
 * Historial completo de una conversación. Resetea unread_count.
 * Acepta ?since=<id> para traer solo mensajes nuevos (incremental polling).
 */
router.get('/admin/conversations/:phone/messages', requireTenantSession, async (req, res) => {
  const { phone } = req.params;
  const sinceId = req.query.since ? parseInt(req.query.since) : null;

  // v0.9.8: la conversación debe pertenecer al tenant (si no, 404)
  // v0.9.134 OMNICANAL: las conversaciones de IG/Messenger no tienen teléfono.
  // El panel las identifica con la key "id:<n>" → resolvemos por c.id en ese caso.
  const tf = tenantFilter(req, 2, 'c.tenant_id');
  const _idMatch = /^id:(\d+)$/.exec(phone);
  const convRes = await db.query(
    `SELECT c.*, l.id AS lead_id, l.name AS lead_name, l.score AS lead_score,
            l.bant, l.spin, l.summary, l.status AS lead_status, l.vertical AS lead_vertical,
            (EXISTS (SELECT 1 FROM vip_contacts v WHERE v.tenant_id = c.tenant_id AND v.phone = regexp_replace(c.phone, '[^0-9]', '', 'g'))) AS is_vip
     FROM conversations c
     LEFT JOIN leads l ON l.conversation_id = c.id
     WHERE ${_idMatch ? 'c.id' : 'c.phone'} = $1${tf.clause}
     ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`,
    [_idMatch ? parseInt(_idMatch[1], 10) : phone, ...tf.params]
  );

  if (convRes.rows.length === 0) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const conversation = convRes.rows[0];

  // v0.9.14: agente restringido por línea → 404
  const agentLinesMsg = await getAgentLineIds(req);
  if (!agentCanSeeConversation(agentLinesMsg, conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  // v0.9.29: agente restringido por etapa → 404
  if (!agentCanSeeStage(await getAgentStageScope(req), conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  // v0.9.285: agente restringido por canal → 404
  if (!agentCanSeeChannel(await getAgentChannelScope(req), conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }

  // v0.9.12: LEFT JOIN tenant_users → nombre de quién mandó cada mensaje humano
  let msgsQuery = `SELECT m.id, m.direction, m.sender_type, m.type, m.body, m.transcription,
            m.media_id, m.media_url, m.media_mime_type, m.media_caption, m.status, m.error_message, m.created_at,
            m.sent_by_user_id, u.display_name AS sent_by_name
     FROM messages m
     LEFT JOIN tenant_users u ON u.id = m.sent_by_user_id
     WHERE m.conversation_id = $1`;
  const msgsParams = [conversation.id];
  if (sinceId) {
    msgsQuery += ` AND m.id > $2`;
    msgsParams.push(sinceId);
  }
  msgsQuery += ` ORDER BY m.created_at ASC`;

  const msgsRes = await db.query(msgsQuery, msgsParams);

  // Resetear unread solo en cargas completas (no en polling incremental)
  if (!sinceId) {
    await db.query(
      'UPDATE conversations SET unread_count = 0 WHERE id = $1',
      [conversation.id]
    );

    // v0.9.532 — TRANSCRIPCIÓN DIFERIDA de audio: los chats humanos no se transcriben al llegar
    // (ahorro de IA). Al abrir el chat, transcribimos acá las notas de voz que quedaron pendientes.
    // Solo en carga completa (no en polling) y una sola vez por audio (guard transcription IS NULL).
    try {
      const _pending = msgsRes.rows.filter(m => m.type === 'audio' && m.media_url && !m.transcription);
      if (_pending.length) {
        const _wh = require('./webhook');
        if (typeof _wh.transcribeAudioMessage === 'function') {
          await Promise.allSettled(_pending.slice(0, 15).map(async (m) => {
            const txt = await _wh.transcribeAudioMessage(m, {
              tenantId: conversation.tenant_id, conversationId: conversation.id, phone: conversation.phone,
            });
            if (txt) m.transcription = txt; // reflejar en la respuesta de este mismo request
          }));
        }
      }
    } catch (e) { console.warn('[lazy-transcribe] hook falló (no bloqueante):', e.message); }
  }

  res.json({ conversation, messages: msgsRes.rows });
});

/**
 * PATCH /api/admin/conversations/:phone/mode
 * Cambiar modo bot ↔ humano desde el panel
 */
router.patch('/admin/conversations/:phone/mode', requireTenantSession, async (req, res) => {
  const { phone } = req.params;
  const { mode } = req.body;

  if (!['bot', 'human'].includes(mode)) {
    return res.status(400).json({ error: 'mode debe ser "bot" o "human"' });
  }

  // v0.9.8: solo puede modificar conversaciones de su tenant
  // v0.9.135: IG/Messenger sin teléfono → key id:<n>
  const tf = tenantFilter(req, 3);
  const _idMode = /^id:(\d+)$/.exec(phone);
  const result = await db.query(
    `UPDATE conversations SET mode = $1
      WHERE id = (SELECT id FROM conversations WHERE ${_idMode ? 'id' : 'phone'} = $2${tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1)
      RETURNING *`,
    [mode, _idMode ? parseInt(_idMode[1], 10) : phone, ...tf.params]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'No encontrada' });
  }
  const conv = result.rows[0];

  // Registrar handover
  await db.query(
    `INSERT INTO handover_requests (conversation_id, reason, triggered_by)
     VALUES ($1, $2, 'admin')`,
    [conv.id, mode === 'human' ? 'admin_takeover' : 'returned_to_bot']
  );

  // v0.7.8 P5 — Al pasar a humano, generar nota automática con el contexto
  // capturado por el bot, para que el humano sepa qué pasó sin leer todo.
  if (mode === 'human') {
    try {
      const leadRes = await db.query('SELECT * FROM leads WHERE conversation_id = $1', [conv.id]);
      const lead = leadRes.rows[0] || {};
      const bant = lead.bant_progress || {};
      const spin = lead.spin_progress || {};
      const lines = [
        `🤖 HANDOVER AUTOMÁTICO desde modo bot`,
        `Score actual: ${conv.current_score || 0}`,
        conv.entry_context ? `Canal: detectado por template de entrada` : null,
        lead.vertical ? `Vertical: ${lead.vertical}` : null,
        lead.contact_name ? `Nombre: ${lead.contact_name}` : null,
        lead.company ? `Empresa: ${lead.company}` : null,
        lead.email ? `Email: ${lead.email}` : null,
        lead.summary ? `Resumen del bot: ${lead.summary}` : null,
        Object.keys(spin).length > 0 ? `SPIN capturado: ${JSON.stringify(spin)}` : null,
        Object.keys(bant).length > 0 ? `BANT capturado: ${JSON.stringify(bant)}` : null,
      ].filter(Boolean);
      const noteBody = lines.join('\n');
      if (noteBody.trim()) {
        await db.query(
          `INSERT INTO conversation_notes (conversation_id, body, author)
           VALUES ($1, $2, 'system_handover')`,
          [conv.id, noteBody]
        );
      }
    } catch (e) {
      console.warn('No se pudo crear nota de handover automática:', e.message);
    }
  }

  res.json({ success: true, conversation: conv });
});

/**
 * POST /api/admin/conversations/:phone/reset-context — v0.9.26
 * Aitana "olvida" todo: el dispatch a n8n deja de mandar el historial anterior
 * (context_reset_at), y se reinician BANT/SPIN/score/entry_context/vertical/search_profile
 * en la conversación y en el lead (v0.9.352: también el perfil de búsqueda). Los mensajes del panel NO se tocan.
 * Solo owner/supervisor.
 */
router.post('/admin/conversations/:phone/reset-context', requireTenantSession, requirePerm('reset_context'), async (req, res) => {
  const { phone } = req.params;
  const tf = tenantFilter(req, 2);
  try {
    const result = await db.query(
      `UPDATE conversations
       SET context_reset_at = NOW(),
           bant_progress = '{}'::jsonb,
           spin_progress = '{}'::jsonb,
           current_score = 0,
           search_profile = '{}'::jsonb,
           sl_state = NULL,
           stage = 'venta',
           plane = 'venta',
           entry_context = NULL,
           vertical = NULL
       WHERE id = (SELECT id FROM conversations WHERE ${(/^id:(\d+)$/.exec(phone)) ? 'id' : 'phone'} = $1${tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1)
       RETURNING id, phone, context_reset_at, stage`,
      [(/^id:(\d+)$/.exec(phone)) ? parseInt(phone.slice(3), 10) : phone, ...tf.params]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrada' });
    const conv = result.rows[0];

    // Reset del lead asociado (si existe). Guardado aparte: columnas del lead
    // pueden variar; si falla, el reset de conversación ya quedó.
    try {
      await db.query(
        `UPDATE leads SET score = 0, status = 'new', bant = '{}'::jsonb, spin = '{}'::jsonb, summary = NULL, search_profile = '{}'::jsonb, sl_state = NULL
         WHERE conversation_id = $1`,
        [conv.id]
      );
    } catch (e) {
      console.warn('reset-context: no se pudo resetear el lead (ignorando):', e.message);
    }

    // Nota interna para trazabilidad
    try {
      await db.query(
        `INSERT INTO conversation_notes (conversation_id, body, author)
         VALUES ($1, $2, 'system_reset')`,
        [conv.id, `🧹 Contexto reseteado: Aitana arranca de cero con este contacto (historial previo, BANT/SPIN, score, contexto de entrada y perfil de búsqueda olvidados).`]
      );
    } catch (e) { /* sin notas no pasa nada */ }

    res.json({ ok: true, conversation: conv });
  } catch (e) {
    if (/context_reset_at/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.26' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/conversations/:phone/stage — v0.9.26
 * Etapa de la conversación: 'venta' | 'postventa'. Cualquier rol del tenant.
 */
router.patch('/admin/conversations/:phone/stage', requireTenantSession, async (req, res) => {
  const { phone } = req.params;
  const stage = String(req.body.stage || '');
  if (!['venta', 'postventa'].includes(stage)) {
    return res.status(400).json({ error: 'stage debe ser "venta" o "postventa"' });
  }
  const tf = tenantFilter(req, 3);
  try {
    const result = await db.query(
      `UPDATE conversations SET stage = $1
        WHERE id = (SELECT id FROM conversations WHERE ${(/^id:(\d+)$/.exec(phone)) ? 'id' : 'phone'} = $2${tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1)
        RETURNING id, phone, stage`,
      [stage, (/^id:(\d+)$/.exec(phone)) ? parseInt(phone.slice(3), 10) : phone, ...tf.params]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No encontrada' });
    res.json({ ok: true, conversation: result.rows[0] });
  } catch (e) {
    if (/stage/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.26' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/conversations/:phone/send
 * Enviar mensaje desde el panel (TÚ respondiendo manualmente).
 */
router.post('/admin/conversations/:phone/send', requireTenantSession, async (req, res) => {
  let { phone } = req.params; // v0.9.466: let — con key id:<n> se normaliza al teléfono real
  const { text, asset_id, inventory_id, property_id } = req.body;

  // Reusa el endpoint de send forzando sender_type=human
  // pero como vendedor llamando desde el panel
  if (!text && !asset_id && !inventory_id && !property_id) return res.status(400).json({ error: 'text, asset_id, inventory_id o property_id requerido' });

  // v0.9.8: la conversación debe ser del tenant
  const _tf = tenantFilter(req, 2, 'tenant_id');
  const _idM = /^id:(\d+)$/.exec(phone); // v0.9.135: IG/Messenger sin teléfono → key id:<n>
  const convRes = await db.query(`SELECT * FROM conversations WHERE ${_idM ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idM ? parseInt(_idM[1], 10) : phone, ..._tf.params]);
  if (convRes.rows.length === 0) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  const conversation = convRes.rows[0];
  if (_idM && conversation.phone) phone = conversation.phone; // v0.9.466 — key id:<n> → teléfono real para meta.send*

  // v0.9.14: agente restringido por línea → 404
  const agentLinesSend = await getAgentLineIds(req);
  if (!agentCanSeeConversation(agentLinesSend, conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  // v0.9.29: agente restringido por etapa → 404
  if (!agentCanSeeStage(await getAgentStageScope(req), conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  // v0.9.285: agente restringido por canal → 404
  if (!agentCanSeeChannel(await getAgentChannelScope(req), conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }

  // v0.9.114 — Mesa de soporte: registrar la 1ª respuesta humana (idempotente).
  // Solo si la convo es de soporte; recordFirstResponse no hace nada si no hay
  // ticket vivo sin primera respuesta. Defensivo (no rompe el envío).
  if (conversation.plane === 'soporte') {
    try { await supportTickets.recordFirstResponse({ tenantId: conversation.tenant_id, conversationId: conversation.id, actorUserId: req.userId || null }); } catch (e) {}
  }

  // v0.9.135 OMNICANAL: respuesta humana por IG/Messenger → ruteo por el Send API
  // de la página (no WhatsApp). Devuelve {success, message} igual que el panel espera.
  if (conversation.channel && conversation.channel !== 'whatsapp') {
    if (inventory_id || property_id) return res.status(400).json({ error: 'Enviar fichas de inventario/inmueble por IG/Messenger todavía no está soportado.' });
    const cc = await _getChannelCtx(conversation.tenant_id, conversation.channel);
    if (!cc) return res.status(503).json({ error: `Canal ${conversation.channel} no conectado` });
    const recipient = conversation.channel_user_id;
    if (asset_id) {
      const a = await db.query(`SELECT type, url, caption FROM media_assets WHERE asset_id = $1 AND (tenant_id = $2 OR ($2 = 1 AND tenant_id IS NULL)) AND active = TRUE LIMIT 1`, [asset_id, conversation.tenant_id]).catch(() => ({ rows: [] }));
      const asset = a.rows[0];
      if (!asset || !asset.url) return res.status(404).json({ error: 'Asset no encontrado' });
      const mtype = asset.type === 'image' ? 'image' : 'text';
      const r = mtype === 'image'
        ? await meta.sendMessengerImage(cc.pageId, recipient, asset.url, cc.token)
        : await meta.sendMessengerText(cc.pageId, recipient, `${asset.caption ? asset.caption + '\n' : ''}${asset.url}`, cc.token);
      const insA = await db.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, type, body, media_url, status, error_message, sent_by_user_id)
         VALUES ($1,'outgoing','human',$2,$3,$4,$5,$6,$7) RETURNING *`,
        [conversation.id, mtype, asset.caption || '', asset.url, r.success ? 'sent' : 'failed', r.error || null, req.userId || null]
      );
      await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
      if (!r.success) return res.status(422).json({ success: false, error: r.error });
      return res.json({ success: true, message: insA.rows[0] });
    }
    const r = await meta.sendMessengerText(cc.pageId, recipient, String(text || ''), cc.token);
    const insT = await db.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, type, body, status, error_message, sent_by_user_id)
       VALUES ($1,'outgoing','human','text',$2,$3,$4,$5) RETURNING *`,
      [conversation.id, text || '', r.success ? 'sent' : 'failed', r.error || null, req.userId || null]
    );
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
    if (!r.success) return res.status(422).json({ success: false, error: r.error });
    return res.json({ success: true, message: insT.rows[0] });
  }

  // v0.9.13: ctx Meta por la línea de la conversación (fallback: tenant → global)
  const ctx = await getConversationMetaCtx(conversation);

  // v0.9.460 — el visto azul del último mensaje del cliente se pone AL RESPONDER el humano
  // (antes el webhook lo marcaba solo con recibir; ver webhook.js). Fire-and-forget, non-fatal.
  try {
    const _readId = await _lastInboundWaId(conversation.id);
    if (_readId) meta.markAsRead(_readId, ctx).catch(() => {});
  } catch (e) { /* sin visto azul, el envío sigue */ }

  // v0.9.21: enviar un artículo de inventario (NUNCA stock). Reusa la línea.
  // v0.9.42: ficha completa (marca/categoría/características) + multi-foto con
  // etiqueta como caption — igual que la ficha de inmuebles.
  if (inventory_id) {
    const _invT2 = await botCatalogTable(conversation.tenant_id, 'inventory');
    const invRes = await db.query(
      `SELECT * FROM ${_invT2} WHERE id = $1 AND tenant_id = $2 AND active = TRUE`,
      [parseInt(inventory_id), conversation.tenant_id]
    );
    if (invRes.rows.length === 0) return res.status(404).json({ error: 'Artículo no encontrado' });
    const it = invRes.rows[0];
    const imgs = (Array.isArray(it.image_urls) && it.image_urls.length) ? it.image_urls : (it.image_url ? [it.image_url] : []);
    const iLabels = (it.image_labels && typeof it.image_labels === 'object') ? it.image_labels : {};
    const caption = (text && text.trim()) ? text : _inventoryCaption(it);
    let invResult;
    if (imgs.length) {
      invResult = await meta.sendImage(phone, imgs[0], caption, ctx);
      for (let k = 1; k < Math.min(imgs.length, 5); k++) {
        try { await meta.sendImage(phone, imgs[k], iLabels[imgs[k]] || '', ctx); } catch (e) {}
      }
    } else {
      invResult = await meta.sendText(phone, caption, true, ctx);
    }
    const insInv = await db.query(
      `INSERT INTO messages
       (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message, sent_by_user_id)
       VALUES ($1, $2, 'outgoing', 'human', $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [conversation.id, invResult.wa_message_id, imgs.length ? 'image' : 'text', caption, imgs[0] || null,
       invResult.success ? 'sent' : 'failed', invResult.error, req.userId || null]
    );
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
    if (!invResult.success) return res.status(422).json({ success: false, error: invResult.error });
    return res.json({ success: true, wa_message_id: invResult.wa_message_id, message: insInv.rows[0] });
  }

  // v0.9.22: enviar un INMUEBLE — ficha completa (fotos + datos + precio).
  if (property_id) {
    const pr = await db.query('SELECT * FROM properties WHERE id = $1 AND tenant_id = $2 AND active = TRUE', [parseInt(property_id), conversation.tenant_id]);
    if (pr.rows.length === 0) return res.status(404).json({ error: 'Inmueble no encontrado' });
    const p = pr.rows[0];
    const opLabel = { venta: 'En venta', alquiler: 'En alquiler', anticretico: 'Anticrético' }[p.operation] || p.operation;
    const specs = [];
    if (p.area_m2 != null) specs.push(`${Number(p.area_m2).toLocaleString('es-BO')} m²`);
    if (p.bedrooms != null) specs.push(`${p.bedrooms} dorm`);
    if (p.bathrooms != null) specs.push(`${p.bathrooms} baños`);
    if (p.garages != null) specs.push(`${p.garages} garaje${p.garages === 1 ? '' : 's'}`);
    const priceLine = (p.price != null) ? `\n💵 ${p.currency || 'USD'} ${Number(p.price).toLocaleString('es-BO')}` : '';
    const caption = (text && text.trim()) ? text : [
      `🏠 *${p.title}* — ${opLabel}`,
      p.zone ? `📍 ${p.zone}` : null,
      specs.length ? `📐 ${specs.join(' · ')}` : null,
      priceLine || null,
      p.maps_url ? `🗺️ Ubicación: ${p.maps_url}` : null, // v0.9.33
      p.description ? `\n${p.description}` : null,
    ].filter(Boolean).join('\n');

    const imgs = Array.isArray(p.image_urls) ? p.image_urls : [];
    const pLabels = (p.image_labels && typeof p.image_labels === 'object') ? p.image_labels : {}; // v0.9.35
    let firstResult = null;
    if (imgs.length === 0) {
      firstResult = await meta.sendText(phone, caption, true, ctx);
    } else {
      // Primera foto con la ficha completa; el resto como fotos sueltas (hasta 5)
      firstResult = await meta.sendImage(phone, imgs[0], caption, ctx);
      for (let k = 1; k < Math.min(imgs.length, 5); k++) {
        try { await meta.sendImage(phone, imgs[k], pLabels[imgs[k]] || '', ctx); } catch (e) {} // v0.9.35: etiqueta como caption
      }
    }
    // v0.9.37: los documentos YA NO van con cada ficha — solo a pedido
    // (send_docs: true). El PDF es el catálogo completo, no parte del pitch.
    const insP = await db.query(
      `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message, sent_by_user_id)
       VALUES ($1, $2, 'outgoing', 'human', $3, $4, $5, $6, $7, $8) RETURNING *`,
      [conversation.id, firstResult.wa_message_id, imgs.length ? 'image' : 'text', caption, imgs[0] || null,
       firstResult.success ? 'sent' : 'failed', firstResult.error, req.userId || null]
    );
    await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
    if (!firstResult.success) return res.status(422).json({ success: false, error: firstResult.error });
    return res.json({ success: true, wa_message_id: firstResult.wa_message_id, message: insP.rows[0] });
  }

  let result;
  let messageType = 'text';
  let mediaUrl = null;
  let bodyToStore = text;

  if (asset_id) {
    // v0.9.72 (auditoría P2): scoping por tenant (asset de la org de la conversación)
    const assetRes = await db.query(
      `SELECT * FROM media_assets WHERE asset_id = $1 AND active = true
        AND (tenant_id = $2 OR ($2 = 1 AND tenant_id IS NULL))`,
      [asset_id, conversation.tenant_id]
    );
    if (assetRes.rows.length === 0) return res.status(404).json({ error: 'Asset no encontrado' });
    const asset = assetRes.rows[0];

    // === Link bundle: 3 mensajes (caption + url + credenciales) ===
    if (asset.type === 'link') {
      const bundle = await sendLinkAssetBundle({
        conversation,
        asset,
        senderType: 'human',
        overrideCaption: text, // si el usuario escribió algo, usa ESO como caption
        ctx,
      });
      if (!bundle.success) {
        return res.status(422).json({ success: false, error: bundle.error, messages: bundle.messages });
      }
      return res.json({ success: true, messages: bundle.messages, message: bundle.messages[bundle.messages.length - 1] });
    }

    mediaUrl = asset.url;
    messageType = asset.type;
    bodyToStore = text || asset.caption;

    if (asset.type === 'video') result = await meta.sendVideo(phone, asset.url, bodyToStore, ctx);
    else if (asset.type === 'image') result = await meta.sendImage(phone, asset.url, bodyToStore, ctx);
    else if (asset.type === 'document') {
      const filename = asset.url.split('/').pop() || 'documento';
      result = await meta.sendDocument(phone, asset.url, filename, bodyToStore, ctx);
    } else if (asset.type === 'audio') result = await meta.sendAudio(phone, asset.url, ctx);
  } else {
    result = await meta.sendText(phone, text, true, ctx);
  }

  const insertRes = await db.query(
    `INSERT INTO messages
     (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, status, error_message, sent_by_user_id)
     VALUES ($1, $2, 'outgoing', 'human', $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [conversation.id, result.wa_message_id, messageType, bodyToStore, mediaUrl,
     result.success ? 'sent' : 'failed', result.error, req.userId || null]
  );

  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);

  if (!result.success) return res.status(422).json({ success: false, error: result.error });

  res.json({ success: true, wa_message_id: result.wa_message_id, message: insertRes.rows[0] });
});

// ─────────────────────────────────────────────────────────────────
// v0.9.9 — Plantillas de WhatsApp (listar + enviar)
// ─────────────────────────────────────────────────────────────────

// Credenciales para LISTAR plantillas (WABA id + token). tenant 1 = env.
async function getTemplateCreds(tenantId) {
  if (!tenantId || tenantId === 1) {
    return { wabaId: process.env.META_WABA_ID, accessToken: process.env.META_ACCESS_TOKEN };
  }
  try {
    const r = await db.query(
      'SELECT waba_id, meta_token_enc FROM tenants WHERE id = $1 AND active = TRUE LIMIT 1',
      [tenantId]
    );
    if (!r.rows.length) return { wabaId: null, accessToken: null };
    const { waba_id, meta_token_enc } = r.rows[0];
    let token = meta_token_enc ? decryptSafe(meta_token_enc) : null;
    let wabaId = waba_id || null;
    // v0.9.457: si el tenant no guarda token/waba propios, MIRAR SUS LÍNEAS antes de
    // caer al global. Antes se devolvía el par (waba global, token global) de SG
    // Bolivia para un tenant ajeno: Meta rechazaba la consulta y la pantalla de
    // plantillas salía vacía o con error de permisos.
    if (!token || !wabaId) {
      try {
        const l = await db.query(
          `SELECT waba_id, meta_token_enc FROM tenant_lines
            WHERE tenant_id = $1 AND active = TRUE
            ORDER BY is_default DESC, created_at ASC`,
          [tenantId]
        );
        for (const row of l.rows) {
          if (!token && row.meta_token_enc) token = decryptSafe(row.meta_token_enc);
          if (!wabaId && row.waba_id) wabaId = row.waba_id;
          if (token && wabaId) break;
        }
      } catch (e) { /* noop */ }
    }
    // v0.9.457 🔴 FUGA ENTRE ORGANIZACIONES. Acá antes había
    //   wabaId: waba_id || process.env.META_WABA_ID,
    //   accessToken: token || process.env.META_ACCESS_TOKEN,
    // o sea que un tenant SIN credenciales propias se llevaba la WABA Y EL TOKEN
    // GLOBALES de SG Bolivia. Consecuencias reales, no teóricas:
    //   · GET /admin/templates le mostraba a ESE tenant las plantillas de SG Bolivia;
    //   · POST /admin/templates/create le CREABA la plantilla dentro de la WABA de
    //     SG Bolivia — o sea una escritura cruzada entre organizaciones.
    // El guard de más abajo (`if (!wabaId || !accessToken)`) estaba pensado para
    // fallar cerrado, pero el fallback global lo dejaba sin efecto. Y el par mixto
    // (WABA global + token del tenant) daba justo el "missing permissions" que este
    // release vino a eliminar. Ahora falla cerrado: sin credenciales propias, null.
    // El tenant 1 sigue usando el env por el early-return de arriba (es el nuestro).
    if (!wabaId || !token) {
      console.warn(`⚠️ [templates] tenant ${tenantId} sin credenciales propias de Meta (waba=${!!wabaId} token=${!!token}) — NO se cae al global`);
      return { wabaId: null, accessToken: null };
    }
    return { wabaId, accessToken: token };
  } catch (e) {
    console.error('getTemplateCreds error:', e.message);
    return { wabaId: null, accessToken: null };
  }
}

/**
 * GET /api/admin/templates  — lista plantillas (solo APPROVED por defecto; ?all=1 = todas)
 */
router.get('/admin/templates', requireTenantSession, async (req, res) => {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : req.tenantId;
  const { wabaId, accessToken } = await getTemplateCreds(tenantId);
  if (!wabaId || !accessToken) {
    return res.status(400).json({ error: 'Faltan credenciales de WhatsApp (WABA id o token) para este tenant.' });
  }
  const out = await meta.getMessageTemplates(wabaId, accessToken);
  if (!out.success) return res.status(502).json({ error: out.error || 'No se pudieron leer las plantillas.' });

  const showAll = req.query.all === '1';
  const templates = (out.templates || [])
    .filter(t => showAll || t.status === 'APPROVED')
    .map(t => ({ name: t.name, language: t.language, category: t.category, status: t.status, components: t.components || [] }));
  res.json({ templates });
});

/**
 * POST /api/admin/templates/create
 * Crea una plantilla y la envía a aprobación de Meta (equivalente al curl post_tpl).
 * Body: {
 *   name,                 // minúsculas + guiones bajos (ej. reenganche_suave)
 *   language,             // ej. 'es'
 *   category,             // 'MARKETING' | 'UTILITY'
 *   body_text,            // texto del cuerpo, con {{1}}, {{2}}... para variables
 *   examples: ['Juan']    // un valor de ejemplo por cada variable, en orden
 * }
 * Devuelve: { ok, id, status, category } (status suele ser 'PENDING').
 */
const TEMPLATE_NAME_RE = /^[a-z0-9_]{1,512}$/;
router.post('/admin/templates/create', requireTenantSession, requirePerm('campaigns'), async (req, res) => {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : req.tenantId;
  let { name, language, category, body_text, examples } = req.body || {};

  // --- validación ---
  name = String(name || '').trim().toLowerCase();
  language = String(language || 'es').trim();
  category = String(category || '').trim().toUpperCase();
  body_text = String(body_text || '').trim();

  if (!TEMPLATE_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'El nombre solo admite minúsculas, números y guiones bajos (ej. reenganche_suave).' });
  }
  if (!['MARKETING', 'UTILITY'].includes(category)) {
    return res.status(400).json({ error: 'category debe ser MARKETING o UTILITY.' });
  }
  if (!body_text) {
    return res.status(400).json({ error: 'El cuerpo del mensaje no puede estar vacío.' });
  }

  // Contar variables {{1}}, {{2}}... y verificar que sean correlativas desde 1
  const found = [...body_text.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
  const maxVar = found.length ? Math.max(...found) : 0;
  for (let i = 1; i <= maxVar; i++) {
    if (!found.includes(i)) {
      return res.status(400).json({ error: `Falta la variable {{${i}}}. Las variables deben ir en orden: {{1}}, {{2}}, ...` });
    }
  }
  const exampleArr = Array.isArray(examples) ? examples.map(v => String(v ?? '').trim()) : [];
  if (maxVar > 0) {
    if (exampleArr.length !== maxVar || exampleArr.some(v => !v)) {
      return res.status(400).json({ error: `Necesito un ejemplo para cada variable (${maxVar} en total). Meta los exige para aprobar.` });
    }
  }

  // --- credenciales del tenant ---
  const { wabaId, accessToken } = await getTemplateCreds(tenantId);
  if (!wabaId || !accessToken) {
    return res.status(400).json({ error: 'Faltan credenciales de WhatsApp (WABA id o token) para este tenant.' });
  }

  // --- armar el componente BODY (con example.body_text si hay variables) ---
  const bodyComponent = { type: 'BODY', text: body_text };
  if (maxVar > 0) bodyComponent.example = { body_text: [exampleArr] };

  const templateDef = {
    name,
    language,
    category,
    components: [bodyComponent],
  };

  const out = await meta.createMessageTemplate(wabaId, accessToken, templateDef);
  if (!out.success) {
    return res.status(502).json({ error: out.error || 'Meta rechazó la creación de la plantilla.' });
  }
  res.json({ ok: true, id: out.id, status: out.status, category: out.category });
});

/**
 * POST /api/admin/conversations/:phone/send-template
 * Body: { template_name, language, category?, variables?: [], preview_text? }
 */
router.post('/admin/conversations/:phone/send-template', requireTenantSession, async (req, res) => {
  let { phone } = req.params; // v0.9.466: let — con key id:<n> se normaliza al teléfono real
  const { template_name, language, category, variables, preview_text } = req.body || {};
  if (!template_name || !language) {
    return res.status(400).json({ error: 'template_name y language son requeridos.' });
  }

  const _tf = tenantFilter(req, 2, 'tenant_id');
  const _idMk = /^id:(\d+)$/.exec(phone); // v0.9.466 — key id:<n> o teléfono (más reciente)
  const convRes = await db.query(`SELECT * FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : phone, ..._tf.params]);
  if (convRes.rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada' });
  const conversation = convRes.rows[0];
  if (_idMk && conversation.phone) phone = conversation.phone; // v0.9.466 — key id:<n> → teléfono real para meta.send*

  const ctx = await getConversationMetaCtx(conversation); // v0.9.13 por línea

  const vars = Array.isArray(variables) ? variables.filter(v => v !== undefined && v !== null) : [];
  const components = vars.length
    ? [{ type: 'body', parameters: vars.map(v => ({ type: 'text', text: String(v) })) }]
    : [];

  const result = await meta.sendTemplate(phone, template_name, language, components, ctx);

  const bodyToStore = (preview_text && String(preview_text).trim())
    ? String(preview_text)
    : `[Plantilla: ${template_name}]${vars.length ? ' · ' + vars.join(' | ') : ''}`;

  const insertRes = await db.query(
    `INSERT INTO messages
     (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
     VALUES ($1, $2, 'outgoing', 'human', 'template', $3, $4, $5)
     RETURNING *`,
    [conversation.id, result.wa_message_id, bodyToStore, result.success ? 'sent' : 'failed', result.error]
  );

  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);

  try {
    await db.query(
      `INSERT INTO template_sends
       (tenant_id, conversation_id, phone, template_name, language, category, wa_message_id, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [conversation.tenant_id, conversation.id, phone, template_name, language,
       category || null, result.wa_message_id, result.success ? 'sent' : 'failed', result.error]
    );
  } catch (e) {
    console.error('template_sends log error:', e.message);
  }

  if (!result.success) return res.status(422).json({ success: false, error: result.error });
  res.json({ success: true, wa_message_id: result.wa_message_id, message: insertRes.rows[0] });
});

// ─────────────────────────────────────────────────────────────────
// v0.9.9 Capa 2 — Envío masivo de plantillas (campañas, background)
// ─────────────────────────────────────────────────────────────────

const BROADCAST_MAX = 1000;

// v0.9.46: normaliza un teléfono a solo dígitos (E.164 sin +). Acepta basura del CSV.
function normalizePhone(p) {
  const digits = String(p || '').replace(/[^\d]/g, '');
  return digits.length >= 7 ? digits : null;
}

// Resuelve destinatarios según la audiencia elegida.
// v0.9.46: excluye opt-out SIEMPRE; el modo 'manual' (lista pegada/CSV) hace
// upsert de conversaciones para poder mandarle plantilla a números que NUNCA
// escribieron (caso típico de outbound) y soporta variables por fila.
async function resolveBroadcastAudience(tenantId, isSuperAdmin, audience) {
  const a = audience || {};
  const tId = (!isSuperAdmin) ? tenantId : (a.tenant_id ? Number(a.tenant_id) : tenantId);

  // ── MANUAL / CSV: filas con { phone, name?, vars?[] } ───────────────
  if (a.type === 'manual') {
    let rows = [];
    if (Array.isArray(a.rows) && a.rows.length) {
      rows = a.rows;
    } else if (Array.isArray(a.phones)) {
      rows = a.phones.map(p => ({ phone: p }));
    }
    // de-dup por teléfono normalizado
    const seen = new Set();
    const clean = [];
    for (const row of rows) {
      const phone = normalizePhone(row.phone);
      if (!phone || seen.has(phone)) continue;
      seen.add(phone);
      clean.push({ phone, name: row.name || null, vars: Array.isArray(row.vars) ? row.vars : null });
    }
    if (!clean.length) return [];
    // excluir opt-out
    const opt = await db.query('SELECT phone FROM campaign_optout WHERE tenant_id = $1', [tId]).catch(() => ({ rows: [] }));
    const blocked = new Set(opt.rows.map(r => r.phone));
    // v0.9.466 — conversaciones por línea: las campañas salen por la LÍNEA PRINCIPAL del
    // tenant (getTenantMetaCtx), así que la conversación nace clavada a esa línea — la
    // respuesta del cliente entra por el mismo número → misma conversación → el flag
    // ai_origin 'campaign' (v0.9.442) sobrevive y el bot la atiende aunque el alcance
    // sea solo-ads. Sin línea default (legacy mono-línea) → bucket sin línea, consistente
    // con cómo resuelve el webhook en ese caso.
    let _campLineId = null;
    try {
      const _dl = await db.query(`SELECT id FROM tenant_lines WHERE tenant_id = $1 AND active = TRUE ORDER BY is_default DESC NULLS LAST, id ASC LIMIT 1`, [tId]);
      _campLineId = _dl.rows[0] ? _dl.rows[0].id : null;
    } catch (e) { /* tenant_lines no migrada → null */ }
    const out = [];
    for (const row of clean.slice(0, BROADCAST_MAX)) {
      if (blocked.has(row.phone)) continue;
      // upsert conversación (no toca last_message_at de las ya existentes)
      const up = await db.query(
        `INSERT INTO conversations (tenant_id, phone, mode, status, contact_name, line_id)
         VALUES ($1, $2, 'bot', 'open', $3, $4)
         ON CONFLICT (tenant_id, phone, COALESCE(line_id, 0)) DO UPDATE SET contact_name = COALESCE(conversations.contact_name, EXCLUDED.contact_name)
         RETURNING id, phone, contact_name, tenant_id`,
        [tId, row.phone, row.name, _campLineId]
      ).catch(() => ({ rows: [] }));
      if (up.rows[0]) {
        // v0.9.442 — la conversación nace de una CAMPAÑA del negocio: en alcance
        // "solo anuncios" el bot SÍ debe atender la respuesta (envío deliberado).
        // COALESCE: si ya era 'organic' (contacto personal), se respeta y sigue humano.
        db.query(`UPDATE conversations SET ai_origin = COALESCE(ai_origin, 'campaign') WHERE id = $1`, [up.rows[0].id]).catch(() => {});
        out.push({ ...up.rows[0], _vars: row.vars });
      }
    }
    return out;
  }

  // ── SEGMENTOS sobre conversaciones existentes ───────────────────────
  const where = [];
  const params = [];
  let pi = 1;
  where.push(`tenant_id = $${pi++}`); params.push(tId);
  where.push(`status <> 'archived'`);

  if (a.type === 'inactive') {
    const days = Number(a.days) || 3;
    where.push(`(last_message_at IS NULL OR last_message_at < NOW() - ($${pi++} * INTERVAL '1 day'))`);
    params.push(days);
  } else if (a.type === 'score') {
    const min = Number(a.min_score) || 0;
    where.push(`current_score >= $${pi++}`); params.push(min);
  } // 'all' => sin filtro extra

  if (a.vertical) { where.push(`vertical = $${pi++}`); params.push(a.vertical); }
  // v0.9.46: excluir SIEMPRE los opt-out del tenant
  where.push(`phone NOT IN (SELECT phone FROM campaign_optout WHERE tenant_id = $1)`);

  const sql = `SELECT id, phone, contact_name, tenant_id FROM conversations
               WHERE ${where.join(' AND ')}
               ORDER BY last_message_at DESC NULLS LAST
               LIMIT ${BROADCAST_MAX}`;
  const r = await db.query(sql, params);
  return r.rows;
}

// v0.9.52: ¿el error de Meta es recuperable? (rate limit / transitorio → reintentar;
// número inválido / frequency cap de Meta / plantilla rechazada → NO insistir)
// v0.9.68 (auditoría 12-jun P1#6): timeout/errores de red YA NO se reintentan —
// el resultado es DESCONOCIDO (Meta pudo aceptar el envío después de que
// cortamos) y reintentar significaba que el cliente recibía la plantilla 2-3
// veces. Solo se reintenta cuando Meta RESPONDIÓ con un rechazo transitorio
// explícito (429/rate limit/5xx), donde sabemos que NO se envió.
function _isRetriableSendError(err) {
  const e = String(err || '');
  if (/131049|not a valid whatsapp|invalid|recipient|131026|template.*(paused|disabled|rejected)/i.test(e)) return false;
  if (/timeout|timed out|network|ECONN|EAI_AGAIN|socket/i.test(e)) return false;
  return /429|rate|limit|too many|5\d\d|internal|temporar|unavailable/i.test(e);
}

// Corre la campaña en background (no se await-ea desde el handler).
// v0.9.52: + 2 pasadas de REINTENTO (60s entre pasadas) para fallidos recuperables.
async function runBroadcast(campaignId, tenantId, recipients, opts) {
  const { template_name, language, category, var_mapping, delay_ms } = opts;
  const ctx = await getTenantMetaCtx(tenantId);
  // v0.9.444 — estampar QUÉ campaña originó la conversación (para el badge 📨 del chat).
  // Solo en las que nacieron de una campaña (ai_origin='campaign'); no pisa una anterior.
  try {
    const _cn = await db.query('SELECT COALESCE(name, template_name) AS n FROM template_campaigns WHERE id = $1', [campaignId]);
    const _cname = _cn.rows[0] && _cn.rows[0].n;
    const _ids = (recipients || []).map((r) => r.id).filter(Boolean);
    if (_cname && _ids.length) {
      await db.query(`UPDATE conversations SET origin_campaign = COALESCE(origin_campaign, $1) WHERE id = ANY($2) AND ai_origin = 'campaign'`, [String(_cname).slice(0, 120), _ids]).catch(() => {});
    }
  } catch (e) { /* best-effort */ }
  const mapping = Array.isArray(var_mapping) ? var_mapping : [];
  const delay = Math.max(0, Math.min(Number(delay_ms) || 300, 3000));
  let sent = 0, failed = 0;
  const failures = []; // v0.9.52: { r, vars, error } para reintentar

  // v0.9.52: base pública para links rastreados (mismo backend)
  const TRACK_BASE = process.env.TRACK_BASE_URL || 'https://app.sg-ventas.com/r/';

  // v0.9.68: si la campaña se cancela mientras corre (botón cancelar o pausa
  // automática por evento de calidad de Meta), el loop se entera y CORTA.
  // Chequeo barato cada 10 envíos.
  let _sinceCheck = 0;
  const _isCancelled = async () => {
    try {
      const s = await db.query('SELECT status FROM template_campaigns WHERE id = $1', [campaignId]);
      return s.rows[0] && s.rows[0].status === 'cancelled';
    } catch (e) { return false; }
  };

  for (const r of recipients) {
    if (++_sinceCheck >= 10) {
      _sinceCheck = 0;
      if (await _isCancelled()) {
        console.error(`🛑 Campaña ${campaignId} CANCELADA mid-run — corto el envío (${sent} ok, ${recipients.length - sent - failed} sin enviar)`);
        return;
      }
    }
    // v0.9.46: si la fila trae sus propias variables (CSV/lista), se usan tal cual;
    // si no, se aplica el mapeo global (name = nombre, value = fijo, link = rastreado).
    let vars;
    if (Array.isArray(r._vars)) {
      vars = r._vars.map(v => v == null ? '' : String(v));
    } else {
      vars = [];
      for (const m of mapping) {
        if (m && m.type === 'name') { vars.push(r.contact_name || (m.fallback || 'Hola')); continue; }
        // v0.9.52: variable 🔗 link rastreado — un código corto por destinatario
        if (m && m.type === 'link' && m.value && /^https?:\/\//i.test(m.value)) {
          try {
            const code = nodeCrypto.randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || nodeCrypto.randomBytes(4).toString('hex');
            await db.query(
              `INSERT INTO tracked_links (code, tenant_id, campaign_id, phone, url) VALUES ($1,$2,$3,$4,$5)`,
              [code, tenantId, campaignId, r.phone, String(m.value)]
            );
            vars.push(TRACK_BASE + code);
          } catch (e) {
            // tabla no migrada u otro error → cae a la URL directa (sin tracking)
            vars.push(String(m.value));
          }
          continue;
        }
        vars.push((m && m.value != null) ? String(m.value) : '');
      }
    }
    const components = vars.length
      ? [{ type: 'body', parameters: vars.map(v => ({ type: 'text', text: String(v) })) }]
      : [];

    let result;
    try {
      result = await meta.sendTemplate(r.phone, template_name, language, components, ctx);
    } catch (e) {
      result = { success: false, wa_message_id: null, error: e.message };
    }

    const preview = `[Plantilla: ${template_name}]${vars.length ? ' · ' + vars.join(' | ') : ''}`;
    try {
      await db.query(
        `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
         VALUES ($1,$2,'outgoing','human','template',$3,$4,$5)`,
        [r.id, result.wa_message_id, preview, result.success ? 'sent' : 'failed', result.error]
      );
      await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [r.id]);
      await db.query(
        `INSERT INTO template_sends (tenant_id, conversation_id, phone, template_name, language, category, campaign_id, wa_message_id, status, error_message)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [tenantId, r.id, r.phone, template_name, language, category || null, campaignId, result.wa_message_id, result.success ? 'sent' : 'failed', result.error]
      );
    } catch (e) { console.error('broadcast log error:', e.message); }

    if (result.success) sent++; else { failed++; failures.push({ r, vars, error: result.error }); }
    try { await db.query('UPDATE template_campaigns SET sent=$1, failed=$2 WHERE id=$3', [sent, failed, campaignId]); } catch (e) {}

    if (delay) await new Promise(r2 => setTimeout(r2, delay));
  }

  // v0.9.52: REINTENTOS — hasta 2 pasadas extra sobre fallidos recuperables,
  // con 60s de espera (deja pasar rate limits transitorios). Si el reintento
  // entra, se actualiza la fila de template_sends y los contadores.
  let retried = 0;
  let pending = failures.filter(f => _isRetriableSendError(f.error));
  for (let pass = 1; pass <= 2 && pending.length; pass++) {
    await new Promise(r2 => setTimeout(r2, 60000));
    // v0.9.68: si la cancelaron durante la espera, no reintentar nada
    if (await _isCancelled()) { console.error(`🛑 Campaña ${campaignId} cancelada — reintentos abortados`); break; }
    console.log(`🔁 Campaña ${campaignId}: reintento ${pass} de ${pending.length} fallido(s)...`);
    const next = [];
    for (const f of pending) {
      // v0.9.68: re-chequear opt-out entre pasadas (pudo responder BAJA hace 60s)
      const od = await db.query('SELECT 1 FROM campaign_optout WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [tenantId, f.r.phone]).catch(() => ({ rows: [] }));
      if (od.rows.length) { console.log(`⛔ Reintento omitido (opt-out): ${f.r.phone}`); continue; }
      const components = f.vars.length
        ? [{ type: 'body', parameters: f.vars.map(v => ({ type: 'text', text: String(v) })) }]
        : [];
      let result;
      try {
        result = await meta.sendTemplate(f.r.phone, template_name, language, components, ctx);
      } catch (e) {
        result = { success: false, wa_message_id: null, error: e.message };
      }
      if (result.success) {
        sent++; failed--; retried++;
        try {
          await db.query(
            `UPDATE template_sends SET status='sent', wa_message_id=$1, error_message=NULL
             WHERE id = (SELECT id FROM template_sends WHERE campaign_id=$2 AND phone=$3 ORDER BY created_at DESC LIMIT 1)`,
            [result.wa_message_id, campaignId, f.r.phone]
          );
          await db.query(
            `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
             VALUES ($1,$2,'outgoing','human','template',$3,'sent',NULL)`,
            [f.r.id, result.wa_message_id, `[Plantilla: ${template_name}] (reintento)`]
          );
          await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [f.r.id]);
        } catch (e) { console.error('retry log error:', e.message); }
      } else if (_isRetriableSendError(result.error)) {
        next.push({ ...f, error: result.error });
      }
      try { await db.query('UPDATE template_campaigns SET sent=$1, failed=$2 WHERE id=$3', [sent, failed, campaignId]); } catch (e) {}
      await new Promise(r2 => setTimeout(r2, Math.max(delay, 500)));
    }
    pending = next;
  }

  try {
    await db.query(`UPDATE template_campaigns SET status='done', finished_at=NOW(), sent=$1, failed=$2 WHERE id=$3`, [sent, failed, campaignId]);
  } catch (e) {}
  console.log(`📣 Campaña ${campaignId}: ${sent} ok, ${failed} fallidas${retried ? `, ${retried} recuperadas en reintentos` : ''}.`);
}

/**
 * POST /api/admin/templates/broadcast
 * dry_run:true => solo devuelve { count, sample } (para previsualizar audiencia).
 * Real => crea campaña, arranca en background, devuelve { campaign_id, total }.
 * Body: { template_name, language, category?, audience, var_mapping?, dry_run?, delay_ms? }
 */
// v0.9.68 (auditoría 12-jun P1#3): saldo de packs = comprados (message_packs.size)
// − enviados (template_sends 'sent'). Hasta ahora el saldo era SOLO informativo
// (KPIs): nunca se aplicaba → campañas ilimitadas gratis con costo Meta propio.
// Tenant 1 (org de la casa) exento. Tablas de billing sin migrar → sin enforcement.
async function getPackBalance(tenantId) {
  if (Number(tenantId) === 1) return Infinity;
  try {
    const b = await db.query(`SELECT COALESCE(SUM(size),0)::int AS n FROM message_packs WHERE tenant_id = $1`, [tenantId]);
    const u = await db.query(`SELECT COUNT(*)::int AS n FROM template_sends WHERE tenant_id = $1 AND status = 'sent' AND campaign_id IS NOT NULL`, [tenantId]);
    return b.rows[0].n - u.rows[0].n;
  } catch (e) {
    return Infinity;
  }
}

router.post('/admin/templates/broadcast', requireTenantSession, requirePerm('campaigns'), async (req, res) => {
  const { template_name, language, category, audience, var_mapping, dry_run, delay_ms, name, scheduled_at } = req.body || {};
  const tenantId = req.isSuperAdmin ? (Number(req.body?.audience?.tenant_id) || 1) : req.tenantId;

  // v0.9.46: dry_run no debe hacer upsert de conversaciones nuevas (solo contar).
  // Para 'manual' contamos las filas válidas y descontamos opt-out sin tocar la DB.
  if (dry_run) {
    if (audience && audience.type === 'manual') {
      const rows = Array.isArray(audience.rows) ? audience.rows
        : (Array.isArray(audience.phones) ? audience.phones.map(p => ({ phone: p })) : []);
      const seen = new Set();
      for (const r of rows) { const ph = normalizePhone(r.phone); if (ph) seen.add(ph); }
      const opt = await db.query('SELECT phone FROM campaign_optout WHERE tenant_id = $1', [tenantId]).catch(() => ({ rows: [] }));
      opt.rows.forEach(o => seen.delete(o.phone));
      const arr = [...seen];
      return res.json({ count: arr.length, sample: arr.slice(0, 10).map(phone => ({ phone, name: null })) });
    }
    const recipients = await resolveBroadcastAudience(tenantId, req.isSuperAdmin, audience);
    return res.json({
      count: recipients.length,
      sample: recipients.slice(0, 10).map(r => ({ phone: r.phone, name: r.contact_name })),
    });
  }

  if (!template_name || !language) return res.status(400).json({ error: 'template_name y language requeridos.' });

  // v0.9.46: PROGRAMACIÓN — si scheduled_at es futuro, se guarda 'scheduled' y la
  // dispara el worker (runDueCampaigns). La audiencia se resuelve al ejecutar,
  // así refleja el estado real en ese momento (y no hace upsert ahora).
  const schedTs = scheduled_at ? new Date(scheduled_at) : null;
  const isScheduled = schedTs && !isNaN(schedTs) && schedTs.getTime() > Date.now() + 30000;
  const campaignId = 'camp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);

  if (isScheduled) {
    await db.query(
      `INSERT INTO template_campaigns (id, tenant_id, name, template_name, language, category, total, status, audience, var_mapping, delay_ms, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,0,'scheduled',$7,$8,$9,$10,$11)`,
      [campaignId, tenantId, name || null, template_name, language, category || null,
       JSON.stringify(audience || {}), JSON.stringify(var_mapping || []), delay_ms || null,
       schedTs.toISOString(), req.isSuperAdmin ? 'admin' : ('tenant:' + tenantId)]
    );
    return res.json({ campaign_id: campaignId, status: 'scheduled', scheduled_at: schedTs.toISOString() });
  }

  const recipients = await resolveBroadcastAudience(tenantId, req.isSuperAdmin, audience);
  if (recipients.length === 0) return res.status(400).json({ error: 'La audiencia no tiene destinatarios.' });
  if (recipients.length > BROADCAST_MAX) {
    return res.status(400).json({ error: `Demasiados destinatarios (${recipients.length}). Máx ${BROADCAST_MAX}; afiná la audiencia.` });
  }

  // v0.9.68: enforcement del saldo de packs (antes solo se mostraba en KPIs)
  const balance = await getPackBalance(tenantId);
  if (recipients.length > balance) {
    return res.status(402).json({ error: `Saldo de mensajes insuficiente: quedan ${Math.max(balance, 0)} y esta campaña necesita ${recipients.length}. Comprá un pack para continuar.` });
  }

  await db.query(
    `INSERT INTO template_campaigns (id, tenant_id, name, template_name, language, category, total, status, audience, var_mapping, delay_ms, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'running',$8,$9,$10,$11)`,
    [campaignId, tenantId, name || null, template_name, language, category || null, recipients.length,
     JSON.stringify(audience || {}), JSON.stringify(var_mapping || []), delay_ms || null,
     req.isSuperAdmin ? 'admin' : ('tenant:' + tenantId)]
  );

  // Background: NO await — responde ya
  runBroadcast(campaignId, tenantId, recipients, { template_name, language, category, var_mapping, delay_ms })
    .catch(e => console.error('runBroadcast fatal:', e.message));

  res.json({ campaign_id: campaignId, total: recipients.length, status: 'running' });
});

// v0.9.46: worker de campañas programadas. Lo llama un setInterval en server.js
// (cada 60s) y también se puede disparar por endpoint. Toma las 'scheduled'
// vencidas, las marca 'running' de forma atómica (evita doble ejecución si hay
// dos instancias) y las corre.
async function runDueCampaigns() {
  let due;
  try {
    due = await db.query(
      `UPDATE template_campaigns
         SET status = 'running'
       WHERE id IN (
         SELECT id FROM template_campaigns
          WHERE status = 'scheduled' AND scheduled_at <= NOW()
          ORDER BY scheduled_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );
  } catch (e) {
    if (!/scheduled_at|does not exist/.test(e.message)) console.error('runDueCampaigns query:', e.message);
    return;
  }
  for (const c of due.rows) {
    try {
      // v0.9.68 (auditoría 12-jun): no correr campañas de tenants suspendidos/read-only
      const tch = await db.query(`SELECT active, read_only FROM tenants WHERE id = $1`, [c.tenant_id]).catch(() => ({ rows: [] }));
      if (!tch.rows[0] || tch.rows[0].active !== true || tch.rows[0].read_only === true) {
        await db.query(`UPDATE template_campaigns SET status='cancelled', finished_at=NOW() WHERE id=$1`, [c.id]);
        console.error(`🚫 Campaña programada ${c.id} CANCELADA: tenant ${c.tenant_id} suspendido o read-only`);
        continue;
      }
      const audience = typeof c.audience === 'string' ? JSON.parse(c.audience || '{}') : (c.audience || {});
      const varMapping = typeof c.var_mapping === 'string' ? JSON.parse(c.var_mapping || '[]') : (c.var_mapping || []);
      const recipients = await resolveBroadcastAudience(c.tenant_id, false, audience);
      if (recipients.length === 0) {
        await db.query(`UPDATE template_campaigns SET status='done', total=0, finished_at=NOW() WHERE id=$1`, [c.id]);
        continue;
      }
      // v0.9.68: enforcement del saldo también en programadas (al momento de correr)
      const balance = await getPackBalance(c.tenant_id);
      if (recipients.length > balance) {
        await db.query(`UPDATE template_campaigns SET status='cancelled', finished_at=NOW() WHERE id=$1`, [c.id]);
        console.error(`🚫 Campaña programada ${c.id} CANCELADA: saldo insuficiente (${Math.max(balance, 0)} < ${recipients.length}) — tenant ${c.tenant_id}`);
        continue;
      }
      await db.query(`UPDATE template_campaigns SET total=$1 WHERE id=$2`, [recipients.length, c.id]);
      console.log(`⏰ Campaña programada ${c.id} arrancando (${recipients.length} dest.)`);
      runBroadcast(c.id, c.tenant_id, recipients, {
        template_name: c.template_name, language: c.language, category: c.category,
        var_mapping: varMapping, delay_ms: c.delay_ms,
      }).catch(e => console.error('runBroadcast(scheduled) fatal:', e.message));
    } catch (e) {
      console.error(`runDueCampaigns ${c.id}:`, e.message);
      await db.query(`UPDATE template_campaigns SET status='scheduled' WHERE id=$1`, [c.id]).catch(() => {});
    }
  }
}

/**
 * GET /api/admin/templates/campaign/:id  — progreso de la campaña (polling).
 */
router.get('/admin/templates/campaign/:id', requireTenantSession, async (req, res) => {
  const _tf = tenantFilter(req, 2, 'tenant_id');
  const r = await db.query(`SELECT * FROM template_campaigns WHERE id = $1${_tf.clause}`, [req.params.id, ..._tf.params]);
  if (!r.rows.length) return res.status(404).json({ error: 'Campaña no encontrada' });
  res.json(r.rows[0]);
});

// =====================================================================
// v0.9.46 — MÓDULO DE CAMPAÑAS (historial, overview, opt-out, programadas)
// =====================================================================

/** GET /api/admin/campaigns — historial de campañas del tenant (máx 100). */
router.get('/admin/campaigns', requireTenantSession, async (req, res) => {
  const _tf = tenantFilter(req, 1, 'tenant_id');
  try {
    const r = await db.query(
      `SELECT id, name, template_name, language, category, total, sent, failed, status,
              audience, scheduled_at, created_at, finished_at
       FROM template_campaigns WHERE 1=1${_tf.clause}
       ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT 100`,
      _tf.params
    );
    res.json({ ok: true, campaigns: r.rows });
  } catch (e) {
    if (/template_campaigns|scheduled_at/.test(e.message)) return res.json({ ok: true, campaigns: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/admin/campaigns/overview — KPIs + saldo de packs del tenant. */
router.get('/admin/campaigns/overview', requireTenantSession, async (req, res) => {
  // Super-admin sin tenant → usa ?tenant_id o cae a 1 (para que el panel no rompa)
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const camp = await db.query(
      `SELECT
         COUNT(*)::int AS total_campaigns,
         COUNT(*) FILTER (WHERE status='scheduled')::int AS scheduled,
         COUNT(*) FILTER (WHERE status='running')::int AS running,
         COALESCE(SUM(sent),0)::int AS sent_total,
         COALESCE(SUM(failed),0)::int AS failed_total,
         COALESCE(SUM(sent) FILTER (WHERE created_at >= date_trunc('month', NOW())),0)::int AS sent_month
       FROM template_campaigns WHERE tenant_id = $1`,
      [tenantId]
    );
    // Saldo de packs: comprados (message_packs.size) − enviados reales (template_sends sent)
    let bought = 0, used = 0;
    try {
      const b = await db.query(`SELECT COALESCE(SUM(size),0)::int AS n FROM message_packs WHERE tenant_id = $1`, [tenantId]);
      bought = b.rows[0].n;
      const u = await db.query(`SELECT COUNT(*)::int AS n FROM template_sends WHERE tenant_id = $1 AND status = 'sent' AND campaign_id IS NOT NULL`, [tenantId]);
      used = u.rows[0].n;
    } catch (e) { /* tablas de billing no migradas → saldo 0 */ }
    // v0.9.52: alerta de calidad de Meta (evento de los últimos 14 días)
    // v0.9.63: SOLO eventos del propio tenant (antes tenant_id NULL se filtraba
    // a todos) y se excluyen los benignos del ciclo de vida (PARTNER_APP_INSTALLED
    // y compañía, que se disparan en cada onboarding y no son alertas).
    let quality_alert = null;
    try {
      // v0.9.250: el banner solo debe alarmar por eventos que REALMENTE afectan la cuenta.
      // Se excluye el audit de coexistencia HISTORY_RECEIVED (field='history' — es la llegada de
      // la sync de historial, NO un evento de calidad) y las RECUPERACIONES (UN*, p.ej. UNFLAGGED =
      // el número se recuperó). Antes HISTORY_RECEIVED pintaba el banner rojo alarmista sin motivo.
      const qa = await db.query(
        `SELECT event, field, phone_number, created_at FROM quality_events
         WHERE tenant_id = $1 AND created_at > NOW() - INTERVAL '14 days'
           AND COALESCE(field, '') <> 'history'
           AND COALESCE(event, '') !~* '^(PARTNER_APP_INSTALLED|PARTNER_ADDED|PARTNER_REMOVED|ACCOUNT_VERIFIED|BUSINESS_VERIFICATION_APPROVED|AD_ACCOUNT_LINKED|WABA_BANNED_REVERSAL|HISTORY_RECEIVED|UN.*)$'
         ORDER BY created_at DESC LIMIT 1`, [tenantId]);
      if (qa.rows[0]) quality_alert = qa.rows[0];
    } catch (e) {}
    res.json({
      ok: true,
      ...camp.rows[0],
      packs_bought: bought,
      packs_used: used,
      packs_balance: Math.max(0, bought - used),
      quality_alert,
    });
  } catch (e) {
    if (/template_campaigns/.test(e.message)) return res.json({ ok: true, total_campaigns: 0, sent_total: 0, sent_month: 0, scheduled: 0, running: 0, packs_bought: 0, packs_used: 0, packs_balance: 0, pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/admin/campaigns/analytics — v0.9.47: métricas por campaña.
 * Por cada campaña: enviados/fallidos (template_sends), entregados/leídos
 * (status del mensaje actualizado por los webhooks de Meta) y RESPUESTAS
 * (mensaje entrante del cliente dentro de las 72h posteriores al envío) —
 * la métrica que importa para vender. */
router.get('/admin/campaigns/analytics', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(`
      SELECT
        ts.campaign_id,
        MIN(ts.created_at) AS started_at,
        MIN(ts.template_name) AS template_name,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE ts.status = 'sent')::int AS sent,
        COUNT(*) FILTER (WHERE ts.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE m.status IN ('delivered','read'))::int AS delivered,
        COUNT(*) FILTER (WHERE m.status = 'read')::int AS read,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM messages mi
          WHERE mi.conversation_id = ts.conversation_id
            AND mi.direction = 'incoming'
            AND mi.created_at > ts.created_at
            AND mi.created_at < ts.created_at + INTERVAL '72 hours'
        ))::int AS replies
      FROM template_sends ts
      LEFT JOIN messages m ON m.wa_message_id = ts.wa_message_id
      WHERE ts.tenant_id = $1 AND ts.campaign_id IS NOT NULL
      GROUP BY ts.campaign_id
      ORDER BY MIN(ts.created_at) DESC
      LIMIT 100
    `, [tenantId]);
    // nombre amigable desde template_campaigns (si la campaña lo tiene)
    const names = {};
    try {
      const n = await db.query(`SELECT id, name FROM template_campaigns WHERE tenant_id = $1 AND name IS NOT NULL`, [tenantId]);
      n.rows.forEach(x => { names[x.id] = x.name; });
    } catch (e) {}
    // v0.9.52: clics de links rastreados por campaña
    const clicksMap = {};
    try {
      const c = await db.query(
        `SELECT campaign_id, COUNT(*)::int AS links, COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS clicked
         FROM tracked_links WHERE tenant_id = $1 AND campaign_id IS NOT NULL GROUP BY campaign_id`, [tenantId]);
      c.rows.forEach(x => { clicksMap[x.campaign_id] = x; });
    } catch (e) {}
    res.json({ ok: true, analytics: r.rows.map(row => ({
      ...row,
      name: names[row.campaign_id] || null,
      links: clicksMap[row.campaign_id]?.links || 0,
      clicks: clicksMap[row.campaign_id]?.clicked || 0,
    })) });
  } catch (e) {
    if (/template_sends/.test(e.message)) return res.json({ ok: true, analytics: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/admin/campaigns/:id/cancel — cancela una campaña programada. */
router.patch('/admin/campaigns/:id/cancel', requireTenantSession, requirePerm('campaigns'), async (req, res) => {
  const _tf = tenantFilter(req, 2, 'tenant_id');
  try {
    const r = await db.query(
      `UPDATE template_campaigns SET status='cancelled', finished_at=NOW()
       WHERE id=$1 AND status='scheduled'${_tf.clause} RETURNING id`,
      [req.params.id, ..._tf.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Campaña no encontrada o ya no está programada' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/optout — lista de exclusión del tenant. */
router.get('/admin/optout', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(
      `SELECT phone, reason, created_at FROM campaign_optout WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1000`,
      [tenantId]
    );
    res.json({ ok: true, optout: r.rows });
  } catch (e) {
    if (/campaign_optout/.test(e.message)) return res.json({ ok: true, optout: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/admin/optout — agrega uno o varios teléfonos a la exclusión. Body: { phones:[], reason? } */
router.post('/admin/optout', requireTenantSession, requirePerm('optout'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.body?.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const raw = Array.isArray(req.body?.phones) ? req.body.phones : (req.body?.phone ? [req.body.phone] : []);
  const reason = String(req.body?.reason || '').trim() || null;
  const phones = [...new Set(raw.map(normalizePhone).filter(Boolean))];
  if (!phones.length) return res.status(400).json({ error: 'Sin teléfonos válidos' });
  try {
    let added = 0;
    for (const phone of phones) {
      const r = await db.query(
        `INSERT INTO campaign_optout (tenant_id, phone, reason, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, phone) DO NOTHING RETURNING id`,
        [tenantId, phone, reason, req.userId ? ('user:' + req.userId) : 'panel']
      );
      if (r.rows.length) added++;
    }
    res.json({ ok: true, added, total: phones.length });
  } catch (e) {
    if (/campaign_optout/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.46' });
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/admin/optout/:phone — saca un teléfono de la exclusión. */
router.delete('/admin/optout/:phone', requireTenantSession, requirePerm('optout'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const phone = normalizePhone(req.params.phone);
  try {
    await db.query(`DELETE FROM campaign_optout WHERE tenant_id = $1 AND phone = $2`, [tenantId, phone]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/templates/send-bulk  — Capa 2: envío masivo de plantilla
 * Body: { template_name, language, category?, recipients: [{ phone, vars?: [], preview_text? }] }
 * Throttle 300ms entre envíos. Tope 50 por request (para listas grandes, dividir).
 */
router.post('/admin/templates/send-bulk', requireTenantSession, requirePerm('campaigns'), async (req, res) => {
  const { template_name, language, category, recipients } = req.body || {};
  if (!template_name || !language) {
    return res.status(400).json({ error: 'template_name y language son requeridos.' });
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients vacío.' });
  }
  const MAX = 50;
  if (recipients.length > MAX) {
    return res.status(400).json({ error: `Máximo ${MAX} destinatarios por envío. Dividí la lista.` });
  }

  // v0.9.68 (auditoría 12-jun P1#3): saldo de packs también en send-bulk (cliente)
  if (req.tenantId) {
    const balance = await getPackBalance(req.tenantId);
    if (recipients.length > balance) {
      return res.status(402).json({ error: `Saldo de mensajes insuficiente: quedan ${Math.max(balance, 0)} y este envío necesita ${recipients.length}. Comprá un pack para continuar.` });
    }
  }

  const campaign_id = 'camp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  let sent = 0, failed = 0;

  for (const r of recipients) {
    const phone = (r && r.phone ? String(r.phone) : '').trim();
    if (!phone) { results.push({ phone, success: false, error: 'phone vacío' }); failed++; continue; }

    const _tf = tenantFilter(req, 2, 'tenant_id');
    const _idMk = /^id:(\d+)$/.exec(phone); // v0.9.466 — key id:<n> o teléfono (más reciente)
  const convRes = await db.query(`SELECT * FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : phone, ..._tf.params]);
    if (convRes.rows.length === 0) { results.push({ phone, success: false, error: 'sin conversación' }); failed++; continue; }
    const conversation = convRes.rows[0];

    // v0.9.68 (auditoría 12-jun P1#4): respetar la lista de exclusión también
    // acá — quien respondió BAJA no recibe más marketing (el broadcast ya lo hacía).
    const optd = await db.query('SELECT 1 FROM campaign_optout WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [conversation.tenant_id, phone]).catch(() => ({ rows: [] }));
    if (optd.rows.length) { results.push({ phone, success: false, error: 'en lista de exclusión (opt-out)' }); failed++; continue; }

    const ctx = await getConversationMetaCtx(conversation); // v0.9.13 por línea

    const vars = Array.isArray(r.vars) ? r.vars.filter((v) => v !== undefined && v !== null) : [];
    const components = vars.length
      ? [{ type: 'body', parameters: vars.map((v) => ({ type: 'text', text: String(v) })) }]
      : [];

    const result = await meta.sendTemplate(phone, template_name, language, components, ctx);
    const bodyToStore = (r.preview_text && String(r.preview_text).trim())
      ? String(r.preview_text)
      : `[Plantilla: ${template_name}]${vars.length ? ' · ' + vars.join(' | ') : ''}`;

    try {
      await db.query(
        `INSERT INTO messages
         (conversation_id, wa_message_id, direction, sender_type, type, body, status, error_message)
         VALUES ($1, $2, 'outgoing', 'human', 'template', $3, $4, $5)`,
        [conversation.id, result.wa_message_id, bodyToStore, result.success ? 'sent' : 'failed', result.error]
      );
      await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);
      await db.query(
        `INSERT INTO template_sends
         (tenant_id, conversation_id, phone, template_name, language, category, campaign_id, wa_message_id, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [conversation.tenant_id, conversation.id, phone, template_name, language,
         category || null, campaign_id, result.wa_message_id, result.success ? 'sent' : 'failed', result.error]
      );
    } catch (e) {
      console.error('send-bulk log error:', e.message);
    }

    if (result.success) sent++; else failed++;
    results.push({ phone, success: result.success, error: result.error });
    await sleep(300); // throttle anti rate-limit
  }

  res.json({ campaign_id, total: recipients.length, sent, failed, results });
});

/**
 * POST /api/admin/conversations/:phone/upload
 * Subir archivo desde el panel y enviarlo por WhatsApp.
 *
 * Espera multipart/form-data con:
 *   - file (binary): el archivo a enviar
 *   - caption (string, opcional): texto que acompaña al media
 *
 * Flujo:
 *   1. Multer recibe el archivo en memoria
 *   2. Detectamos el tipo (image / video / audio / document) según MIME
 *   3. Subimos a R2
 *   4. Enviamos por Meta usando la URL pública de R2
 *   5. Guardamos el mensaje con media_url
 */
router.post('/admin/conversations/:phone/upload', requireTenantSession, upload.single('file'), metaMediaGuard, async (req, res) => {
  let { phone } = req.params; // v0.9.466: let — con key id:<n> se normaliza al teléfono real
  const { caption } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'Archivo requerido en campo "file"' });
  if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado en el servidor' });

  const _tf = tenantFilter(req, 2, 'tenant_id');
  const _idMk = /^id:(\d+)$/.exec(phone); // v0.9.466 — key id:<n> o teléfono (más reciente)
  const convRes = await db.query(`SELECT * FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : phone, ..._tf.params]);
  if (convRes.rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada' });
  const conversation = convRes.rows[0];
  if (_idMk && conversation.phone) phone = conversation.phone; // v0.9.466 — key id:<n> → teléfono real para meta.send*

  // v0.9.29: agente restringido por etapa → 404
  if (!agentCanSeeStage(await getAgentStageScope(req), conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  // v0.9.14: agente restringido por línea → 404
  const agentLinesUp = await getAgentLineIds(req);
  if (!agentCanSeeConversation(agentLinesUp, conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }
  // v0.9.285: agente restringido por canal → 404
  if (!agentCanSeeChannel(await getAgentChannelScope(req), conversation)) {
    return res.status(404).json({ error: 'Conversación no encontrada' });
  }

  // Detectar tipo de mensaje según MIME
  const mime = file.mimetype || 'application/octet-stream';
  let messageType;
  if (mime.startsWith('image/')) messageType = 'image';
  else if (mime.startsWith('video/')) messageType = 'video';
  else if (mime.startsWith('audio/')) messageType = 'audio';
  else messageType = 'document';

  let uploadResult;
  try {
    uploadResult = await r2.upload({
      buffer: file.buffer,
      mimeType: mime,
      prefix: 'outgoing',
      filename: file.originalname,
    });
  } catch (e) {
    console.error('Error subiendo a R2:', e);
    return res.status(500).json({ error: 'No se pudo subir el archivo: ' + e.message });
  }

  const mediaUrl = uploadResult.url;
  const bodyToStore = caption || file.originalname;

  // Enviar por WhatsApp usando la URL pública
  // v0.9.13: FIX — antes mandaba siempre por credenciales globales (sin ctx).
  // Ahora usa la línea de la conversación (fallback: tenant → global).
  const uploadCtx = await getConversationMetaCtx(conversation);
  let metaResult;
  if (messageType === 'image') metaResult = await meta.sendImage(phone, mediaUrl, caption, uploadCtx);
  else if (messageType === 'video') metaResult = await meta.sendVideo(phone, mediaUrl, caption, uploadCtx);
  else if (messageType === 'audio') metaResult = await meta.sendAudio(phone, mediaUrl, uploadCtx);
  else metaResult = await meta.sendDocument(phone, mediaUrl, file.originalname, caption, uploadCtx);

  const insertRes = await db.query(
    `INSERT INTO messages
     (conversation_id, wa_message_id, direction, sender_type, type, body, media_url, media_mime_type, status, error_message, sent_by_user_id)
     VALUES ($1, $2, 'outgoing', 'human', $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [conversation.id, metaResult.wa_message_id, messageType, bodyToStore, mediaUrl, mime,
     metaResult.success ? 'sent' : 'failed', metaResult.error, req.userId || null]
  );

  await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conversation.id]);

  if (!metaResult.success) {
    return res.status(422).json({
      success: false,
      error: metaResult.error,
      // El archivo igual quedó en R2 y registrado, por si querés reintentar
      message: insertRes.rows[0],
    });
  }

  res.json({
    success: true,
    wa_message_id: metaResult.wa_message_id,
    message: insertRes.rows[0],
    url: mediaUrl,
  });
});

// =====================================================================
// NOTAS INTERNAS (Onda 2)
// =====================================================================

/**
 * GET /api/admin/conversations/:phone/notes
 */
router.get('/admin/conversations/:phone/notes', requireTenantSession, async (req, res) => {
  const { phone } = req.params;
  const _tf = tenantFilter(req, 2, 'tenant_id');
  const _idMk = /^id:(\d+)$/.exec(phone); // v0.9.466 — key id:<n> o teléfono (más reciente)
  const convRes = await db.query(`SELECT id FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : phone, ..._tf.params]);
  if (convRes.rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada' });

  const result = await db.query(
    `SELECT * FROM conversation_notes WHERE conversation_id = $1 ORDER BY created_at DESC`,
    [convRes.rows[0].id]
  );
  res.json({ notes: result.rows });
});

/**
 * POST /api/admin/conversations/:phone/notes
 */
router.post('/admin/conversations/:phone/notes', requireTenantSession, async (req, res) => {
  const { phone } = req.params;
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body requerido' });

  const _tf = tenantFilter(req, 2, 'tenant_id');
  const _idMk = /^id:(\d+)$/.exec(phone); // v0.9.466 — key id:<n> o teléfono (más reciente)
  const convRes = await db.query(`SELECT id FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : phone, ..._tf.params]);
  if (convRes.rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada' });

  const result = await db.query(
    `INSERT INTO conversation_notes (conversation_id, body, author) VALUES ($1, $2, $3) RETURNING *`,
    [convRes.rows[0].id, body.trim(), req.userName || (req.userId ? `user:${req.userId}` : null)]
  );
  res.json({ ok: true, note: result.rows[0] });
});

/**
 * DELETE /api/admin/conversations/notes/:id
 */
router.delete('/admin/conversations/notes/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  if (req.isSuperAdmin) {
    await db.query('DELETE FROM conversation_notes WHERE id = $1', [id]);
  } else {
    // v0.9.8: solo borra si la nota pertenece a una conversación del tenant
    await db.query(
      `DELETE FROM conversation_notes
       WHERE id = $1 AND conversation_id IN (SELECT id FROM conversations WHERE tenant_id = $2)`,
      [id, req.tenantId]
    );
  }
  res.json({ ok: true });
});

/**
 * GET /api/admin/conversations/:phone/search?q=texto
 * Busca dentro de los mensajes de UNA conversación.
 */
router.get('/admin/conversations/:phone/search', requireTenantSession, async (req, res) => {
  const { phone } = req.params;
  const { q } = req.query;
  if (!q || !q.trim()) return res.json({ matches: [] });

  const _tf = tenantFilter(req, 2, 'tenant_id');
  const _idMk = /^id:(\d+)$/.exec(phone); // v0.9.466 — key id:<n> o teléfono (más reciente)
  const convRes = await db.query(`SELECT id FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : phone, ..._tf.params]);
  if (convRes.rows.length === 0) return res.status(404).json({ error: 'Conversación no encontrada' });

  const result = await db.query(
    `SELECT id, direction, sender_type, type, body, transcription, media_caption, created_at
     FROM messages
     WHERE conversation_id = $1
       AND (
         body ILIKE $2
         OR transcription ILIKE $2
         OR media_caption ILIKE $2
       )
     ORDER BY created_at DESC LIMIT 50`,
    [convRes.rows[0].id, `%${q.trim()}%`]
  );
  res.json({ matches: result.rows, total: result.rows.length });
});

// =====================================================================
// CRUD ASSETS (Onda 2)
// =====================================================================

/**
 * GET /api/admin/assets
 */
router.get('/admin/assets', requireTenantSession, async (req, res) => {
  const tf = tenantFilter(req, 1);
  const result = await db.query(`SELECT * FROM media_assets WHERE 1=1${tf.clause} ORDER BY type, vertical, asset_id`, tf.params);
  res.json({ assets: result.rows });
});

/**
 * POST /api/admin/assets
 * Subir un nuevo asset al catálogo (multipart/form-data o JSON con URL externa).
 */
router.post('/admin/assets', requireTenantSession, requirePerm('assets'), upload.single('file'), metaMediaGuard, async (req, res) => {
  const { asset_id, vertical, description, caption } = req.body;
  // v0.9.27: modo de venta del asset ('todos' default)
  // v0.9.72: + servicios y rubros de primera clase (salud/belleza/restaurante)
  const saleMode = ['todos', 'software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos'].includes(req.body.sale_mode)
    ? req.body.sale_mode : 'todos'; // v0.9.49: + servicios · v0.9.122: + arquitectura
  let { type } = req.body;
  let url = req.body.url;

  if (!asset_id) return res.status(400).json({ error: 'asset_id requerido' });
  // v0.9.8: el asset pertenece al tenant de la sesión (super-admin → tenant 1 o body)
  const ownerTenant = req.isSuperAdmin ? (Number(req.body.tenant_id) || 1) : req.tenantId;

  // Tipo "link": no hay archivo, sólo URL externa al demo. No tocar R2.
  if (type === 'link') {
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Para type=link se requiere una URL válida (http:// o https://)' });
    }
  }
  // Si viene archivo, subirlo a R2 y detectar type automáticamente del MIME
  else if (req.file) {
    if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });

    // Auto-detectar type si no vino explícito
    if (!type) {
      const mime = req.file.mimetype || '';
      if (mime.startsWith('image/')) type = 'image';
      else if (mime.startsWith('video/')) type = 'video';
      else if (mime.startsWith('audio/')) type = 'audio';
      else type = 'document';
    }

    try {
      const result = await r2.upload({
        buffer: req.file.buffer,
        mimeType: req.file.mimetype,
        prefix: 'assets',
        filename: req.file.originalname,
      });
      url = result.url;
    } catch (e) {
      return res.status(500).json({ error: 'Error subiendo archivo: ' + e.message });
    }
  }

  if (!type) return res.status(400).json({ error: 'type requerido (o subir un archivo para auto-detectar)' });
  if (!url) return res.status(400).json({ error: 'Necesitás un archivo o un campo url' });

  try {
    const result = await db.query(
      `INSERT INTO media_assets (tenant_id, asset_id, type, vertical, description, url, caption, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (tenant_id, asset_id) DO UPDATE
       SET type = EXCLUDED.type,
           vertical = COALESCE(EXCLUDED.vertical, media_assets.vertical),
           description = COALESCE(EXCLUDED.description, media_assets.description),
           url = EXCLUDED.url,
           caption = COALESCE(EXCLUDED.caption, media_assets.caption),
           active = true,
           updated_at = NOW()
       RETURNING *`,
      [ownerTenant, asset_id, type, vertical || null, description || null, url, caption || null]
    );
    // v0.9.27: sale_mode en update aparte (la columna puede no estar migrada;
    // si falla, el asset queda 'todos' = comportamiento anterior)
    try {
      await db.query(
        `UPDATE media_assets SET sale_mode = $1 WHERE tenant_id = $2 AND asset_id = $3`,
        [saleMode, ownerTenant, asset_id]
      );
      result.rows[0].sale_mode = saleMode;
    } catch (e) { /* migración v0.9.27 pendiente */ }
    res.json({ ok: true, asset: result.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/assets/:asset_id
 */
router.patch('/admin/assets/:asset_id', requireTenantSession, requirePerm('assets'), async (req, res) => {
  const { asset_id } = req.params;
  const { description, caption, vertical, active, url } = req.body;
  const tf = tenantFilter(req, 7);
  const result = await db.query(
    `UPDATE media_assets
     SET description = COALESCE($1, description),
         caption = COALESCE($2, caption),
         vertical = COALESCE($3, vertical),
         active = COALESCE($4, active),
         url = COALESCE($5, url)
     WHERE asset_id = $6${tf.clause} RETURNING *`,
    [description, caption, vertical, active, url, asset_id, ...tf.params]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Asset no encontrado' });
  // v0.9.27: sale_mode aparte (columna puede no existir todavía)
  // v0.9.72 FIX: faltaban 'servicios' y los rubros → al editar un asset a esos
  // modos el cambio se descartaba en silencio (rompía "assets por rubro" v0.9.70).
  if (['todos', 'software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos'].includes(req.body.sale_mode)) {
    try {
      const _tf2 = tenantFilter(req, 3);
      const r2u = await db.query(
        `UPDATE media_assets SET sale_mode = $1 WHERE asset_id = $2${_tf2.clause} RETURNING sale_mode`,
        [req.body.sale_mode, asset_id, ..._tf2.params]
      );
      if (r2u.rows[0]) result.rows[0].sale_mode = r2u.rows[0].sale_mode;
    } catch (e) { /* migración v0.9.27 pendiente */ }
  }
  res.json({ ok: true, asset: result.rows[0] });
});

// =====================================================================
// v0.9.424 — VOLCADO MASIVO CON IA ("file dumper")
// POST /admin/assets/bulk-dump — multipart, campo files[] (hasta 20).
// Por archivo: extrae texto (pdf-parse si es PDF) y Gemini decide a qué
// producto del catálogo pertenece. Confianza >= 0.9 → el archivo se AGREGA
// a los docs (file_urls) de ese producto y viaja con su ficha (send_docs).
// Si no llega al umbral → queda como asset general con metadata generada
// por IA y se marca "sin_asignar" en la respuesta para revisión manual.
// =====================================================================
router.post('/admin/assets/bulk-dump', requireTenantSession, requirePerm('assets'), upload.array('files', 20), metaMediaGuard, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'IA no configurada (falta GEMINI_API_KEY)' });
  if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
  const files = req.files || [];
  if (!files.length) return res.status(400).json({ error: 'Subí al menos un archivo (campo files)' });
  const tenantId = req.isSuperAdmin ? (Number(req.body.tenant_id) || 1) : req.tenantId;
  const CONF_MIN = 0.9;

  // Candidatos: inventario del modo ACTIVO (v0.9.452: vehiculos/restaurante tienen tabla propia) + inmuebles del tenant.
  const cands = [];
  const _dumpInvT = await botCatalogTable(tenantId, 'inventory').catch(() => 'inventory_items');
  try {
    const r = await db.query(
      `SELECT id, name, brand, to_jsonb(${_dumpInvT}) ->> 'model' AS model, code FROM ${_dumpInvT}
       WHERE (tenant_id = $1 OR ($1 = 1 AND tenant_id IS NULL)) AND active = true
       ORDER BY id DESC LIMIT 300`, [tenantId]);
    r.rows.forEach(x => cands.push({ kind: 'inventory', id: x.id, label: ([x.brand, x.model].filter(Boolean).join(' ') || x.name || ('ítem ' + x.id)) + (x.code ? ` (${x.code})` : '') }));
  } catch (e) { /* tabla puede faltar en tenants viejos */ }
  try {
    const r = await db.query(
      `SELECT id, title, zone, type FROM properties
       WHERE (tenant_id = $1 OR ($1 = 1 AND tenant_id IS NULL)) AND active = true
       ORDER BY id DESC LIMIT 300`, [tenantId]);
    r.rows.forEach(x => cands.push({ kind: 'property', id: x.id, label: [x.title, x.type, x.zone].filter(Boolean).join(' · ') || ('inmueble ' + x.id) }));
  } catch (e) {}

  const catList = cands.map((c, i) => `${i + 1}. [${c.kind}:${c.id}] ${c.label}`).join('\n') || '(catálogo vacío)';
  const axios = require('axios');
  const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
  const sysPrompt = 'Sos un clasificador de archivos comerciales para un CRM en Bolivia. Te doy el nombre de un archivo, un extracto de su contenido y el catálogo de productos del negocio. Decidí si el archivo corresponde a UN producto específico del catálogo. Sé ESTRICTO con la confianza: 0.95+ solo si el modelo/título coincide inequívocamente; si dudás entre dos productos o el archivo es genérico (catálogo general, lista de precios, promo), la confianza debe ser menor a 0.9. Respondé SOLO un JSON válido: {"match": "inventory:ID" | "property:ID" | null, "confidence": 0.0, "asset_id": "slug_corto_snake_case", "description": "qué es el archivo, 1 línea", "caption": "texto breve para acompañar el envío por WhatsApp, con 1 emoji"}';

  const results = [];
  for (const f of files) {
    const fname = f.originalname || 'archivo';
    let excerpt = '';
    if ((f.mimetype || '').includes('pdf')) {
      try {
        const pdfParse = require('pdf-parse/lib/pdf-parse.js');
        const pd = await pdfParse(f.buffer, { max: 4 });
        excerpt = String(pd.text || '').replace(/\s+/g, ' ').slice(0, 2500);
      } catch (e) { /* PDF escaneado o corrupto: seguimos con el nombre solo */ }
    }
    let ai = null;
    try {
      const gr = await axios.post(gUrl, {
        contents: [{ parts: [{ text: `ARCHIVO: ${fname}\nEXTRACTO:\n${excerpt || '(sin texto extraíble)'}\n\nCATÁLOGO:\n${catList}\n\nJSON:` }] }],
        systemInstruction: { parts: [{ text: sysPrompt }] },
        generationConfig: { temperature: 0, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
      }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
      const raw = (((((gr.data || {}).candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '';
      ai = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) { ai = null; }

    const conf = (ai && Number(ai.confidence)) || 0;
    let target = null;
    if (ai && ai.match && conf >= CONF_MIN) {
      const m = String(ai.match).match(/^(inventory|property):(\d+)$/);
      if (m) target = cands.find(c => c.kind === m[1] && String(c.id) === m[2]) || null;
    }

    try {
      if (target) {
        // ── Asignado: subir a R2 y AGREGAR a file_urls del producto ──
        const prefix = target.kind === 'inventory' ? (_dumpInvT === 'catalog_vehiculos' ? 'vehiculos/docs' : _dumpInvT === 'catalog_restaurante' ? 'restaurante/docs' : 'inventory/docs') : 'properties/docs'; // v0.9.452
        const up = await r2.upload({ buffer: f.buffer, mimeType: f.mimetype, prefix, filename: fname });
        const table = target.kind === 'inventory' ? _dumpInvT : 'properties';
        await db.query(
          `UPDATE ${table}
           SET file_urls = (COALESCE(file_urls, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('url', $1::text, 'name', $2::text)))
           WHERE id = $3 AND (tenant_id = $4 OR ($4 = 1 AND tenant_id IS NULL))`,
          [up.url, fname, target.id, tenantId]);
        results.push({ file: fname, status: 'asignado', kind: target.kind, item_id: target.id, item: target.label, confidence: conf });
      } else {
        // ── Sin asignar: asset general con metadata IA, para revisión manual ──
        const mime = f.mimetype || '';
        const type = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document';
        const slugBase = ((ai && ai.asset_id ? String(ai.asset_id) : fname.replace(/\.[^.]+$/, ''))
          .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50)) || ('archivo_' + Date.now());
        const up = await r2.upload({ buffer: f.buffer, mimeType: f.mimetype, prefix: 'assets', filename: fname });
        const ins = await db.query(
          `INSERT INTO media_assets (tenant_id, asset_id, type, vertical, description, url, caption, active)
           VALUES ($1, $2, $3, NULL, $4, $5, $6, true)
           ON CONFLICT (tenant_id, asset_id) DO UPDATE SET url = EXCLUDED.url, type = EXCLUDED.type, active = true, updated_at = NOW()
           RETURNING asset_id`,
          [tenantId, slugBase, type, (ai && ai.description) || fname, up.url, (ai && ai.caption) || null]);
        results.push({ file: fname, status: 'sin_asignar', asset_id: ins.rows[0].asset_id, confidence: conf, suggestion: (ai && ai.match) || null });
      }
    } catch (e) {
      results.push({ file: fname, status: 'error', error: e.message });
    }
  }

  const asignados = results.filter(r => r.status === 'asignado').length;
  const pendientes = results.filter(r => r.status === 'sin_asignar').length;
  const errores = results.filter(r => r.status === 'error').length;
  res.json({ ok: true, results, summary: { asignados, pendientes, errores, total: files.length } });
});

/**
 * DELETE /api/admin/assets/:asset_id
 * Por defecto: soft delete (active = false)
 * Con ?permanent=true: hard delete + eliminar archivo de R2
 */
router.delete('/admin/assets/:asset_id', requireTenantSession, requirePerm('assets'), async (req, res) => {
  const { asset_id } = req.params;
  const permanent = req.query.permanent === 'true';

  if (!permanent) {
    // Soft delete (comportamiento original)
    const tf = tenantFilter(req, 2);
    const result = await db.query(
      `UPDATE media_assets SET active = false WHERE asset_id = $1${tf.clause} RETURNING asset_id`,
      [asset_id, ...tf.params]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Asset no encontrado' });
    return res.json({ ok: true, mode: 'soft' });
  }

  // Hard delete: borrar archivo de R2 + registro de la DB
  try {
    // 1. Buscar la URL del asset para extraer la key de R2
    const _tf1 = tenantFilter(req, 2);
    const lookup = await db.query(
      `SELECT asset_id, url FROM media_assets WHERE asset_id = $1${_tf1.clause}`,
      [asset_id, ..._tf1.params]
    );
    if (lookup.rows.length === 0) {
      return res.status(404).json({ error: 'Asset no encontrado' });
    }
    const url = lookup.rows[0].url;

    // 2. Si tiene URL de R2, intentar borrar el archivo físico
    let r2Deleted = false;
    if (url && r2.isConfigured()) {
      const key = r2.extractKeyFromUrl(url);
      if (key) {
        r2Deleted = await r2.deleteObject(key);
        if (!r2Deleted) {
          console.warn(`⚠️  No se pudo borrar de R2: ${key} (continuamos con DB)`);
        } else {
          console.log(`🗑  Borrado de R2: ${key}`);
        }
      }
    }

    // 3. Borrar registro de la DB
    const _tf2 = tenantFilter(req, 2);
    const del = await db.query(
      `DELETE FROM media_assets WHERE asset_id = $1${_tf2.clause} RETURNING asset_id`,
      [asset_id, ..._tf2.params]
    );

    res.json({
      ok: true,
      mode: 'hard',
      asset_id,
      r2_deleted: r2Deleted,
      db_deleted: del.rows.length > 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/export/conversations
 * Exporta conversaciones completas en JSON para análisis externo.
 *
 * Query params:
 *   - from: ISO date (default: hace 30 días)
 *   - to: ISO date (default: ahora)
 *   - anonymize: 'true' para reemplazar teléfonos por cliente_N
 *   - include_notes: 'true' (default) para incluir notas internas
 *
 * Devuelve un objeto con:
 *   - meta: rango de fechas, totales, generado_at
 *   - conversations: array de conversaciones con mensajes anidados
 */
router.get('/admin/export/conversations', requireTenantSession, requireRole('owner','supervisor'), async (req, res) => {
  const { from, to, anonymize, include_notes } = req.query;
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const toDate = to ? new Date(to) : new Date();
  const doAnonymize = anonymize === 'true';
  const withNotes = include_notes !== 'false';

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'Fechas inválidas (usar ISO format)' });
  }

  try {
    // 1. Conversaciones del rango con sus leads
    // v0.9.8: filtro de tenant ($3 si aplica). El OR de fechas va entre paréntesis.
    const _tf = tenantFilter(req, 3, 'c.tenant_id');
    const convsRes = await db.query(`
      SELECT
        c.id, c.phone, c.contact_name, c.mode, c.status,
        c.current_score, c.unread_count, c.created_at, c.last_message_at,
        l.name AS lead_name, l.score AS lead_score, l.status AS lead_status,
        l.vertical AS lead_vertical, l.email AS lead_email, l.company AS lead_company,
        l.bant AS lead_bant, l.spin AS lead_spin,
        l.summary AS lead_summary, l.notes AS lead_notes
      FROM conversations c
      LEFT JOIN leads l ON l.conversation_id = c.id
      WHERE (c.created_at BETWEEN $1 AND $2
         OR c.last_message_at BETWEEN $1 AND $2)${_tf.clause}
      ORDER BY c.last_message_at DESC NULLS LAST
    `, [fromDate, toDate, ..._tf.params]);

    if (convsRes.rows.length === 0) {
      return res.json({
        meta: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
          generated_at: new Date().toISOString(),
          total_conversations: 0,
          total_messages: 0,
        },
        conversations: [],
      });
    }

    const convIds = convsRes.rows.map(c => c.id);

    // 2. Mensajes de esas conversaciones
    const msgsRes = await db.query(`
      SELECT
        id, conversation_id, direction, sender_type, type,
        body, transcription, media_caption, media_url,
        status, created_at
      FROM messages
      WHERE conversation_id = ANY($1::int[])
      ORDER BY conversation_id, created_at
    `, [convIds]);

    // 3. Notas (opcional)
    let notes = [];
    if (withNotes) {
      const notesRes = await db.query(`
        SELECT id, conversation_id, body, author, created_at
        FROM conversation_notes
        WHERE conversation_id = ANY($1::int[])
        ORDER BY conversation_id, created_at
      `, [convIds]);
      notes = notesRes.rows;
    }

    // Helper para anonimizar
    let anonMap = new Map();
    let anonCounter = 0;
    const anonPhone = (phone) => {
      if (!doAnonymize) return phone;
      if (!anonMap.has(phone)) {
        anonCounter++;
        anonMap.set(phone, `cliente_${anonCounter}`);
      }
      return anonMap.get(phone);
    };
    const anonName = (name, phone) => {
      if (!doAnonymize) return name;
      return name ? `Contacto_${anonCounter}` : null;
    };

    // 4. Armar JSON anidado
    const conversations = convsRes.rows.map(c => {
      const phoneAnon = anonPhone(c.phone);
      const conv = {
        id: c.id,
        phone: phoneAnon,
        contact_name: anonName(c.contact_name, c.phone),
        mode: c.mode,
        status: c.status,
        current_score: c.current_score,
        created_at: c.created_at,
        last_message_at: c.last_message_at,
        lead: c.lead_name ? {
          name: doAnonymize ? `Contacto_${anonCounter}` : c.lead_name,
          email: doAnonymize ? (c.lead_email ? '[REDACTED]' : null) : c.lead_email,
          company: doAnonymize ? (c.lead_company ? '[REDACTED]' : null) : c.lead_company,
          score: c.lead_score,
          status: c.lead_status,
          vertical: c.lead_vertical,
          bant: c.lead_bant,
          spin: c.lead_spin,
          summary: c.lead_summary,
          notes: c.lead_notes,
        } : null,
        messages: msgsRes.rows
          .filter(m => m.conversation_id === c.id)
          .map(m => ({
            id: m.id,
            direction: m.direction,
            sender_type: m.sender_type,
            type: m.type,
            body: m.body,
            transcription: m.transcription,
            media_caption: m.media_caption,
            // En anonymize, removemos URLs de media (privacidad de los archivos)
            media_url: doAnonymize ? (m.media_url ? '[REDACTED]' : null) : m.media_url,
            status: m.status,
            created_at: m.created_at,
          })),
        notes: withNotes
          ? notes.filter(n => n.conversation_id === c.id).map(n => ({
              body: n.body,
              author: n.author,
              created_at: n.created_at,
            }))
          : undefined,
      };
      return conv;
    });

    res.json({
      meta: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        generated_at: new Date().toISOString(),
        total_conversations: conversations.length,
        total_messages: msgsRes.rows.length,
        anonymized: doAnonymize,
        includes_notes: withNotes,
      },
      conversations,
    });
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/leads
 * Lista de leads calificados.
 */
router.get('/admin/leads', requireTenantSession, async (req, res) => {
  const { status, vertical } = req.query;

  let query = `
    SELECT l.*, c.phone, c.contact_name, c.last_message_at, c.unread_count,
           (SELECT a.status FROM appointments a
              WHERE a.conversation_id = c.id AND a.status IN ('pending','scheduled')
              ORDER BY (a.status = 'scheduled') DESC, a.starts_at ASC LIMIT 1) AS appt_status,
           (SELECT a.starts_at FROM appointments a
              WHERE a.conversation_id = c.id AND a.status IN ('pending','scheduled')
              ORDER BY (a.status = 'scheduled') DESC, a.starts_at ASC LIMIT 1) AS appt_starts_at
    FROM leads l
    JOIN conversations c ON c.id = l.conversation_id
    WHERE 1=1
  `;
  const params = [];
  let i = 1;

  if (status) {
    query += ` AND l.status = $${i}`;
    params.push(status);
    i++;
  }
  if (vertical) {
    query += ` AND l.vertical = $${i}`;
    params.push(vertical);
    i++;
  }
  // v0.9.474: filtro opcional por LÍNEA (line_id entero validado ⇒ injection-safe inline)
  if (/^\d+$/.test(String(req.query.line_id == null ? '' : req.query.line_id))) {
    query += ` AND c.line_id = ${parseInt(req.query.line_id, 10)}`;
  }
  // v0.9.489 — ALCANCE POR LÍNEA del agente. Misma regla que el inbox (v0.9.14):
  // sin filas en tenant_user_lines ve todo; owner/supervisor/super-admin nunca se
  // filtran. Las conversaciones sin línea quedan visibles (legacy), igual que en
  // agentCanSeeConversation() — si no, un agente asignado perdería de vista los
  // leads históricos que todavía no tienen line_id.
  {
    const _al = await getAgentLineIds(req);
    if (_al && _al.length) query += ` AND (c.line_id IS NULL OR c.line_id IN (${_al.map(n => parseInt(n, 10)).filter(Number.isFinite).join(',') || '-1'}))`;
    else if (_al) query += ` AND c.line_id IS NULL`;
  }

  // v0.9.8: aislamiento por tenant — por la conversación (fuente de verdad)
  const tf = tenantFilter(req, i, 'c.tenant_id');
  query += tf.clause;
  params.push(...tf.params);

  query += ' ORDER BY l.score DESC, l.created_at DESC LIMIT 100';

  const result = await db.query(query, params);
  res.json({ data: result.rows });
});

// =============================================================
// v0.9.301 — MATCHER: coincidencias del CATÁLOGO con el perfil de búsqueda del lead.
// Genérico: scorea properties (inmuebles) e inventory_items (productos/vehículos) contra
// leads.search_profile. Solo cuenta criterios que el perfil ESPECIFICA (matched/applicable).
// =============================================================
const { scoreCatalogItem: _scoreCatalogItem, getUsdToBsRate: _getUsdToBsRate } = require('./catalog-matcher'); // v0.9.304 scorer compartido · v0.9.338 candado de presupuesto

router.get('/admin/leads/:id/matches', requireTenantSession, async (req, res) => {
  try {
    const tf = tenantFilter(req, 2, 'c.tenant_id');
    const lr = await db.query(
      `SELECT l.id, l.search_profile, l.vertical, c.tenant_id
         FROM leads l JOIN conversations c ON c.id = l.conversation_id
        WHERE l.id = $1${tf.clause}`, [req.params.id, ...tf.params]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Lead no encontrado' });
    const sp = (lr.rows[0].search_profile && typeof lr.rows[0].search_profile === 'object') ? lr.rows[0].search_profile : null;
    if (!sp) return res.json({ ok: true, matches: [], reason: 'sin_perfil' });
    const tenantId = lr.rows[0].tenant_id;
    const tf2 = await db.query('SELECT realestate_bot_enabled, inventory_bot_enabled, vehiculos_bot_enabled FROM tenants WHERE id = $1', [tenantId]).catch(() => ({ rows: [{}] }));
    const flags = tf2.rows[0] || {};
    const items = [];
    const _mOpts = { usdToBs: await _getUsdToBsRate(db) }; // v0.9.338 — candado de presupuesto Bs↔USD
    if (flags.realestate_bot_enabled) {
      const pr = await db.query('SELECT * FROM properties WHERE tenant_id = $1 AND active = TRUE ORDER BY updated_at DESC LIMIT 120', [tenantId]).catch(() => ({ rows: [] }));
      pr.rows.forEach((it) => items.push(_scoreCatalogItem(sp, it, 'property', _mOpts)));
    }
    if (flags.inventory_bot_enabled || flags.vehiculos_bot_enabled) {
      const _mInvT = flags.vehiculos_bot_enabled ? 'catalog_vehiculos' : 'inventory_items'; // v0.9.452: vehiculos con tabla propia
      const iv = await db.query(`SELECT * FROM ${_mInvT} WHERE tenant_id = $1 AND active = TRUE ORDER BY updated_at DESC LIMIT 120`, [tenantId]).catch(() => ({ rows: [] }));
      iv.rows.forEach((it) => items.push(_scoreCatalogItem(sp, it, 'inventory', _mOpts)));
    }
    const matches = items.filter((m) => m && m.score > 0).sort((a, b) => b.score - a.score).slice(0, 6);
    res.json({ ok: true, matches, profile: sp });
  } catch (e) {
    if (/search_profile|does not exist/.test(e.message)) return res.status(503).json({ error: 'Falta la migración del perfil de búsqueda (v0.9.299)' });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.387 — BORRADOR IA para escribirle al ASESOR asignado (facilitación C21). Arma un mensaje de WhatsApp
// del facilitador (este negocio) al colega dueño de la propiedad, resumiendo lo que busca el cliente
// (search_profile + summary + intel del lead) — para que el usuario no tenga que re-escribir todo.
// Devuelve SOLO el texto; el panel lo abre con wa.me?text= (queda en borrador, NO se envía). IA con
// fallback a plantilla (siempre responde algo). NO incluye datos personales del cliente.
router.post('/admin/leads/:id/agent-message', requireTenantSession, async (req, res) => {
  try {
    const tf = tenantFilter(req, 2, 'c.tenant_id');
    const lr = await db.query(
      `SELECT l.id, l.search_profile, l.summary, l.sl_state, c.tenant_id
         FROM leads l JOIN conversations c ON c.id = l.conversation_id
        WHERE l.id = $1${tf.clause}`, [req.params.id, ...tf.params]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Lead no encontrado' });
    const lead = lr.rows[0];
    const tenantId = lead.tenant_id;
    const propId = parseInt(req.body && req.body.property_id, 10);
    let prop = null;
    if (Number.isFinite(propId)) {
      const pr = await db.query(
        'SELECT title, zone, type, operation, price, currency, code, bedrooms, assigned_agent_name FROM properties WHERE id = $1 AND tenant_id = $2',
        [propId, tenantId]
      ).catch(() => ({ rows: [] }));
      prop = pr.rows[0] || null;
    }
    let biz = '';
    try { const t = await db.query('SELECT name FROM tenants WHERE id = $1', [tenantId]); biz = (t.rows[0] && t.rows[0].name) || ''; } catch (e) { /* opcional */ }

    const sp = (lead.search_profile && typeof lead.search_profile === 'object') ? lead.search_profile : {};
    const sl = (lead.sl_state && typeof lead.sl_state === 'object') ? lead.sl_state : {};
    const intel = (sl.intel && typeof sl.intel === 'object') ? sl.intel : {};
    const attrs = (sp.attributes && typeof sp.attributes === 'object') ? sp.attributes : {};
    const budget = (() => {
      const mn = sp.budget_min, mx = sp.budget_max, cur = sp.currency || '';
      if (mn && mx) return `${cur} ${mn}–${mx}`.trim();
      if (mx) return `hasta ${cur} ${mx}`.trim();
      if (mn) return `desde ${cur} ${mn}`.trim();
      return '';
    })();
    const facts = [];
    if (sp.operation) facts.push(`operación: ${sp.operation}`);
    if (sp.location || sp.zone) facts.push(`zona buscada: ${sp.location || sp.zone}`);
    const tipo = attrs.tipo || attrs.type || sp.type;
    if (tipo) facts.push(`tipo: ${tipo}`);
    const dorm = attrs.dormitorios || attrs.bedrooms || sp.bedrooms;
    if (dorm) facts.push(`${dorm} dormitorios`);
    if (budget) facts.push(`presupuesto: ${budget}`);
    if (intel.decisive_factor) facts.push(`factor decisivo: ${intel.decisive_factor}`);
    if (intel.ideal) facts.push(`ideal para el cliente: ${intel.ideal}`);
    if (sp.notes) facts.push(`notas: ${sp.notes}`);
    if (lead.summary) facts.push(`resumen de la charla: ${lead.summary}`);

    const agentFirst = (prop && prop.assigned_agent_name) ? String(prop.assigned_agent_name).split(' ')[0] : '';
    const propLine = prop ? `${prop.title}${prop.zone ? ` (${prop.zone})` : ''}${prop.price != null ? ` — ${prop.currency || ''} ${prop.price}` : ''}`.trim() : '';

    // Plantilla de respaldo (siempre válida, sin IA).
    const tmpl = [
      `Hola${agentFirst ? ` ${agentFirst}` : ''}, te escribo de ${biz || 'la inmobiliaria'}.`,
      prop ? `Tengo un cliente interesado en tu propiedad *${propLine}*.` : 'Tengo un cliente buscando una propiedad y tu ficha podría encajar.',
      facts.length ? `Lo que busca: ${facts.slice(0, 6).join(' · ')}.` : '',
      '¿Coordinamos para mostrársela o conversar la operación? Gracias.',
    ].filter(Boolean).join('\n\n');

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || !facts.length) return res.json({ ok: true, message: tmpl, ai: false });

    const systemPrompt = `Sos el asistente de un asesor inmobiliario en Bolivia. Escribís un mensaje de WhatsApp BREVE y profesional que ese asesor le envía a OTRO asesor colega que tiene asignada una propiedad, para avisarle que tiene un cliente interesado y coordinar. Usá SOLO los datos que te doy; NO inventes precio, nombre del cliente ni datos que no estén. NO incluyas datos personales/contacto del cliente. Español neutro, cálido y directo, máximo ~70 palabras. WhatsApp usa *asteriscos* para negrita (nada de markdown pesado). Cerrá proponiendo coordinar. Devolvé SOLO el texto del mensaje.`;
    const userPrompt = `Negocio que escribe: ${biz || '(inmobiliaria)'}\nAsesor colega (destinatario): ${(prop && prop.assigned_agent_name) || '(sin nombre)'}\nPropiedad del colega: ${propLine || '(sin datos)'}\n\nLo que busca mi cliente:\n${facts.join('\n')}\n\nEscribí el mensaje de WhatsApp:`;

    try {
      const axios = require('axios');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
      const gr = await axios.post(url, {
        contents: [{ parts: [{ text: userPrompt }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
        generationConfig: { temperature: 0.7, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
      }, { timeout: 20000, headers: { 'Content-Type': 'application/json' } });
      const text = (gr.data && gr.data.candidates && gr.data.candidates[0] && gr.data.candidates[0].content && gr.data.candidates[0].content.parts && gr.data.candidates[0].content.parts[0] && gr.data.candidates[0].content.parts[0].text || '').trim();
      return res.json({ ok: true, message: text || tmpl, ai: !!text });
    } catch (e) {
      return res.json({ ok: true, message: tmpl, ai: false }); // fallback: la plantilla siempre sale
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// v0.9.390 — TEST de NOTA DE VOZ: manda un audio de prueba a un número para validar el pipeline
// ElevenLabs TTS → ffmpeg (OGG/Opus) → WhatsApp. Owner/supervisor. Se llama desde la consola del panel.
// =============================================================
// v0.9.391 — NOTAS DE VOZ (ElevenLabs): config por tenant + voz por LÍNEA.
// El master switch y los toggles por momento deciden CUÁNDO Aitana manda audio
// (los dispara el backend en webhook.js, no la IA). Cada línea puede tener su
// propia voz, elegida por NOMBRE desde el panel. La API key vive SOLO en el
// entorno (ELEVENLABS_API_KEY) — acá nunca se expone ni se guarda.
function _vnConfig(row) {
  const c = (row && row.voice_notes_config) || {};
  return {
    enabled: !!c.enabled,
    greeting: !!c.greeting,          // saludo inicial
    appointment: !!c.appointment,    // confirmación de cita
    ficha: !!c.ficha,                // presentar la ficha estrella
    reactivation: !!c.reactivation,  // reactivación de lead frío (nurturing)
    ai_decides: !!c.ai_decides,      // v0.9.396 — la IA decide (marca [voz]) cuando ayuda a cerrar
    default_voice_id: c.default_voice_id || null,
    model: c.model || null,
  };
}

// Resuelve la voz efectiva para una línea: voz de la línea → voz por defecto del tenant → env.
async function resolveVoiceForLine(tenantId, lineId) {
  let voiceId = null, model = null;
  try {
    const tr = await db.query('SELECT voice_notes_config FROM tenants WHERE id = $1', [tenantId]);
    const cfg = _vnConfig(tr.rows[0]);
    model = cfg.model || null;
    voiceId = cfg.default_voice_id || null;
    if (lineId) {
      const lr = await db.query('SELECT voice_id FROM tenant_lines WHERE id = $1 AND tenant_id = $2', [lineId, tenantId]);
      if (lr.rows[0] && lr.rows[0].voice_id) voiceId = lr.rows[0].voice_id;
    }
  } catch (e) { /* columnas nuevas sin migrar → cae al env */ }
  voiceId = voiceId || process.env.ELEVEN_VOICE_ID || null;
  return { voiceId, model };
}

// GET config de notas de voz + líneas (con su voz) + estado del entorno.
router.get('/admin/voice-notes/config', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = req.tenantId;
  try {
    const tr = await db.query('SELECT voice_notes_config FROM tenants WHERE id = $1', [tenantId]);
    const config = _vnConfig(tr.rows[0]);
    let lines = [];
    try {
      const lr = await db.query(
        `SELECT id, label, display_phone, voice_id, is_default
           FROM tenant_lines WHERE tenant_id = $1 AND COALESCE(active, TRUE) = TRUE
          ORDER BY is_default DESC, id ASC`, [tenantId]);
      lines = lr.rows;
    } catch (e) { /* multi-línea puede no estar migrada */ }
    res.json({ ok: true, config, lines, has_key: !!process.env.ELEVENLABS_API_KEY, has_env_voice: !!process.env.ELEVEN_VOICE_ID });
  } catch (e) {
    if (/voice_notes_config/.test(e.message)) {
      return res.json({ ok: true, config: _vnConfig(null), lines: [], has_key: !!process.env.ELEVENLABS_API_KEY, has_env_voice: !!process.env.ELEVEN_VOICE_ID, pending_migration: true });
    }
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET voces de la cuenta de ElevenLabs (para elegir por NOMBRE). Cache 5 min por proceso.
let _vnVoicesCache = { at: 0, data: null };
router.get('/admin/voice-notes/voices', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ ok: false, error: 'Falta ELEVENLABS_API_KEY en el entorno (Railway).' });
  try {
    if (_vnVoicesCache.data && (Date.now() - _vnVoicesCache.at) < 5 * 60 * 1000) {
      return res.json({ ok: true, voices: _vnVoicesCache.data, cached: true });
    }
    const axios = require('axios');
    const r = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }, timeout: 15000,
    });
    const voices = ((r.data && r.data.voices) || []).map((v) => ({
      voice_id: v.voice_id, name: v.name, category: v.category || null,
      preview_url: v.preview_url || null,
      language: (v.labels && (v.labels.language || v.labels.accent)) || null,
    }));
    _vnVoicesCache = { at: Date.now(), data: voices };
    res.json({ ok: true, voices });
  } catch (e) {
    const detail = e.response && e.response.data && e.response.data.detail;
    res.status(502).json({ ok: false, error: (detail && (detail.message || detail)) || e.message });
  }
});

// PUT config (master + toggles por momento + voz por defecto + modelo). Shallow-merge.
router.put('/admin/voice-notes/config', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = req.tenantId;
  const b = req.body || {};
  try {
    const cur = (await db.query('SELECT voice_notes_config FROM tenants WHERE id = $1', [tenantId])).rows[0];
    const merged = _vnConfig(cur);
    ['enabled', 'greeting', 'appointment', 'ficha', 'reactivation', 'ai_decides'].forEach((k) => { if (k in b) merged[k] = !!b[k]; });
    if ('default_voice_id' in b) merged.default_voice_id = b.default_voice_id ? String(b.default_voice_id).trim() : null;
    if ('model' in b) merged.model = b.model ? String(b.model).trim() : null;
    await db.query('UPDATE tenants SET voice_notes_config = $1 WHERE id = $2', [JSON.stringify(merged), tenantId]);
    res.json({ ok: true, config: merged });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// PUT voz de una línea (voice_id, o null/"" para heredar la del tenant).
// v0.9.549 — MODO DE VENTA POR LÍNEA. NULL/'' = hereda el modo del tenant (comportamiento actual).
router.get('/admin/lines-sale-modes', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  try {
    const r = await db.query(`SELECT id, COALESCE(to_jsonb(tenant_lines)->>'label', display_phone, 'Línea '||id) AS name, to_jsonb(tenant_lines)->>'sale_mode' AS sale_mode FROM tenant_lines WHERE tenant_id=$1 AND active IS NOT FALSE ORDER BY id`, [tenantId]);
    // v0.9.551 — el selector SOLO ofrece los modos que el super-admin dejó visibles para este
    // tenant (mode_visibility, modelo solo-ocultar: sin registro = visible). Evita errores.
    let allowed = ['software', 'articulos', 'inmuebles', 'vehiculos', 'restaurante', 'servicios', 'salud', 'belleza', 'arquitectura'];
    try {
      const mv = await db.query(`SELECT to_jsonb(tenants)->'mode_visibility' AS mv FROM tenants WHERE id=$1`, [tenantId]);
      const vis = (mv.rows[0] && mv.rows[0].mv) || null;
      if (vis && typeof vis === 'object') allowed = allowed.filter(m => vis[m] !== false);
    } catch (e) { /* sin columna → todos visibles */ }
    res.json({ ok: true, lines: r.rows, allowed_modes: allowed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/admin/lines/:id/sale-mode', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = invTenant(req);
  const id = parseInt(req.params.id, 10);
  const VALID = ['software', 'articulos', 'inmuebles', 'vehiculos', 'restaurante', 'servicios', 'salud', 'belleza', 'arquitectura'];
  const m = String((req.body && req.body.sale_mode) || '').trim().toLowerCase();
  const val = VALID.includes(m) ? m : null;
  try {
    const r = await db.query(`UPDATE tenant_lines SET sale_mode=$3 WHERE id=$1 AND tenant_id=$2 RETURNING id`, [id, tenantId, val]);
    if (!r.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    console.log(`🧭 [line-mode] tenant ${tenantId} línea ${id} → ${val || '(hereda)'}`);
    res.json({ ok: true, sale_mode: val });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/admin/lines/:id/voice', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = req.tenantId;
  const lineId = parseInt(req.params.id, 10);
  if (!lineId) return res.status(400).json({ ok: false, error: 'línea inválida' });
  const voiceId = req.body && req.body.voice_id ? String(req.body.voice_id).trim() : null;
  try {
    const r = await db.query('UPDATE tenant_lines SET voice_id = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, voice_id', [voiceId, lineId, tenantId]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'línea no encontrada' });
    invalidateLineCtxCache(lineId);
    res.json({ ok: true, line: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST prueba de nota de voz. Acepta line_id opcional → usa la voz de esa línea y sale por ese número.
router.post('/admin/voice-note/test', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const b = req.body || {};
  const phone = String(b.phone || '').replace(/[^0-9]/g, '');
  const text = String(b.text || '').trim();
  const lineId = b.line_id ? parseInt(b.line_id, 10) : null;
  if (!phone) return res.status(400).json({ ok: false, error: 'phone requerido' });
  if (!text) return res.status(400).json({ ok: false, error: 'text requerido' });
  if (!process.env.ELEVENLABS_API_KEY) {
    return res.status(503).json({ ok: false, error: 'Falta ELEVENLABS_API_KEY en el entorno (Railway).' });
  }
  try {
    const tenantId = req.tenantId;
    const { voiceId: resolvedVoice, model } = await resolveVoiceForLine(tenantId, lineId);
    // voice_id opcional = probar una voz ad-hoc (antes de guardarla). Si no viene, resuelve por línea/default/env.
    const voiceId = (b.voice_id ? String(b.voice_id).trim() : null) || resolvedVoice;
    if (!voiceId) return res.status(503).json({ ok: false, error: 'No hay voz configurada. Elegí una voz por defecto (o por línea) en Config → Notas de voz, o seteá ELEVEN_VOICE_ID.' });
    // ctx: si se eligió una línea, salir por ESA línea; si no, por la conversación existente o el tenant.
    let conversation = null;
    try { const cr = await db.query('SELECT * FROM conversations WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [tenantId, phone]); conversation = cr.rows[0] || null; } catch (e) { /* opcional */ }
    const ctxSeed = lineId ? { tenant_id: tenantId, line_id: lineId } : (conversation || { tenant_id: tenantId });
    const ctx = await getConversationMetaCtx(ctxSeed);
    const r = await meta.sendVoiceNote(phone, text, ctx, { voiceId, model: model || undefined, recordingDelay: false }); // prueba del panel: sin retardo de "grabación" (feedback inmediato)
    if (!r || !r.success) return res.status(502).json({ ok: false, error: (r && r.error) || 'falló el envío de la nota de voz', detail: r });
    // v0.9.392 — registrar caracteres sintetizados para el billing de ElevenLabs (voice_usage)
    try { await db.query('INSERT INTO voice_usage (tenant_id, chars, kind) VALUES ($1, $2, $3)', [tenantId, (text || '').length, 'test']); } catch (e) { /* tabla sin migrar → ignora */ }
    res.json({ ok: true, wa_message_id: r.wa_message_id });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// =============================================================
// v0.9.302 — BASE DE CONOCIMIENTO (FAQ), reutilizable en TODOS los modos.
// El bot responde estas preguntas sin escalar; cada entrada puede llevar medios
// (imágenes/videos/links) en media JSONB [{type,url,label}]. CRUD + import masivo.
// =============================================================
function _kbTenant(req) { return (typeof resolveOrgTenantId === 'function') ? resolveOrgTenantId(req) : (req.tenantId || (req.isSuperAdmin ? 1 : null)); }
function _kbCleanMedia(m) {
  if (!Array.isArray(m)) return null;
  const out = m.map((x) => {
    if (!x || typeof x !== 'object') return null;
    const url = String(x.url || '').trim(); if (!url) return null;
    let type = String(x.type || '').toLowerCase();
    if (!['image', 'video', 'link'].includes(type)) type = /\.(jpg|jpeg|png|gif|webp)$/i.test(url) ? 'image' : (/\.(mp4|mov|webm|m4v)$/i.test(url) ? 'video' : 'link');
    return { type, url, label: x.label ? String(x.label).slice(0, 120) : null };
  }).filter(Boolean);
  return out.length ? out : null;
}
function _kbMediaFromUrls(s) { if (!s) return null; const parts = String(s).split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean); return _kbCleanMedia(parts.map((u) => ({ url: u }))); }

router.get('/admin/kb', requireTenantSession, async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query('SELECT * FROM knowledge_base WHERE tenant_id = $1 ORDER BY sort_order ASC, id ASC', [tenantId]);
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    if (/knowledge_base/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.302 (knowledge_base)' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/kb', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = _kbTenant(req);
  const b = req.body || {};
  if (!b.question || !b.answer) return res.status(400).json({ error: 'question y answer requeridos' });
  try {
    const mm = _kbCleanMedia(b.media);
    const r = await db.query(
      `INSERT INTO knowledge_base (tenant_id, question, answer, media, tags, active, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE), COALESCE((SELECT MAX(sort_order) + 1 FROM knowledge_base WHERE tenant_id = $1), 0))
       RETURNING *`,
      [tenantId, String(b.question).slice(0, 600), String(b.answer).slice(0, 4000), mm ? JSON.stringify(mm) : null, b.tags ? String(b.tags).slice(0, 200) : null, (b.active === false ? false : true)]);
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/admin/kb/:id', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = _kbTenant(req);
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  if (b.question != null) { sets.push(`question = $${i++}`); vals.push(String(b.question).slice(0, 600)); }
  if (b.answer != null) { sets.push(`answer = $${i++}`); vals.push(String(b.answer).slice(0, 4000)); }
  if ('media' in b) { sets.push(`media = $${i++}`); const mm = _kbCleanMedia(b.media); vals.push(mm ? JSON.stringify(mm) : null); }
  if ('tags' in b) { sets.push(`tags = $${i++}`); vals.push(b.tags ? String(b.tags).slice(0, 200) : null); }
  if (typeof b.active === 'boolean') { sets.push(`active = $${i++}`); vals.push(b.active); }
  if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' });
  sets.push('updated_at = NOW()');
  vals.push(req.params.id, tenantId);
  try {
    const r = await db.query(`UPDATE knowledge_base SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`, vals);
    if (!r.rows.length) return res.status(404).json({ error: 'no encontrado' });
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/admin/kb/:id', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = _kbTenant(req);
  try {
    const r = await db.query('DELETE FROM knowledge_base WHERE id = $1 AND tenant_id = $2 RETURNING id', [req.params.id, tenantId]);
    if (!r.rows.length) return res.status(404).json({ error: 'no encontrado' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/kb/import', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = _kbTenant(req);
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: 'rows (array) requerido' });
  if (rows.length > 500) return res.status(400).json({ error: 'máximo 500 filas por importación' });
  let inserted = 0;
  try {
    const base = await db.query('SELECT COALESCE(MAX(sort_order), 0) AS m FROM knowledge_base WHERE tenant_id = $1', [tenantId]);
    let so = Number(base.rows[0].m) || 0;
    for (const row of rows) {
      const q = row && (row.question || row.q || row.pregunta);
      const a = row && (row.answer || row.a || row.respuesta);
      if (!q || !a) continue;
      const media = _kbCleanMedia(row.media) || _kbMediaFromUrls(row.urls || row.url || row.media_url);
      so += 1;
      await db.query('INSERT INTO knowledge_base (tenant_id, question, answer, media, tags, active, sort_order) VALUES ($1, $2, $3, $4, $5, TRUE, $6)',
        [tenantId, String(q).slice(0, 600), String(a).slice(0, 4000), media ? JSON.stringify(media) : null, row.tags ? String(row.tags).slice(0, 200) : null, so]);
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (e) { res.status(500).json({ error: e.message, inserted }); }
});

// v0.9.304 — config del NURTURING por comportamiento (OPT-IN por tenant).
router.get('/admin/nurture-config', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = _kbTenant(req);
  try {
    const r = await db.query('SELECT COALESCE(nurture_enabled, FALSE) AS enabled, COALESCE(nurture_min_score, 60) AS min_score, COALESCE(nurture_cooldown_days, 3) AS cooldown_days, nurture_template FROM tenants WHERE id = $1', [tenantId]);
    res.json({ ok: true, config: r.rows[0] || { enabled: false, min_score: 60, cooldown_days: 3, nurture_template: null } });
  } catch (e) {
    if (/nurture_enabled/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.304 (nurturing)' });
    res.status(500).json({ error: e.message });
  }
});
router.patch('/admin/nurture-config', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = _kbTenant(req);
  const b = req.body || {};
  const enabled = b.enabled === true || b.enabled === 'true';
  const minScore = Math.max(0, Math.min(100, parseInt(b.min_score, 10) || 60));
  const cooldown = Math.max(0, Math.min(60, parseInt(b.cooldown_days, 10) || 3));
  const tpl = (typeof b.template === 'string' && b.template.trim()) ? b.template.trim().slice(0, 120) : null;
  try {
    await db.query('UPDATE tenants SET nurture_enabled = $1, nurture_min_score = $2, nurture_cooldown_days = $3, nurture_template = $4 WHERE id = $5', [enabled, minScore, cooldown, tpl, tenantId]);
    res.json({ ok: true });
  } catch (e) {
    if (/nurture_enabled/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.304 (nurturing)' });
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.316 — CLIENTES VIP: números tageados para atención prioritaria.
// El chat sube al tope del inbox (badge ⭐) y al escribir dispara aviso al
// equipo (push + WhatsApp por línea). Fuente de verdad: vip_contacts.
// =====================================================================
function _vipNorm(p) { const d = String(p || '').replace(/[^0-9]/g, ''); return d.length >= 7 ? d : null; }

router.get('/admin/vip', requireTenantSession, async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'sin tenant' });
  try {
    const r = await db.query('SELECT id, phone, label, created_at FROM vip_contacts WHERE tenant_id = $1 ORDER BY created_at DESC', [tenantId]);
    res.json({ ok: true, data: r.rows });
  } catch (e) {
    if (/vip_contacts/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración v0.9.316 (VIP)' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/vip', requireTenantSession, async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'sin tenant' });
  const phone = _vipNorm(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'teléfono inválido' });
  const label = (req.body && typeof req.body.label === 'string' && req.body.label.trim()) ? req.body.label.trim().slice(0, 120) : null;
  try {
    await db.query(
      `INSERT INTO vip_contacts (tenant_id, phone, label, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, phone) DO UPDATE SET label = COALESCE(EXCLUDED.label, vip_contacts.label)`,
      [tenantId, phone, label, req.userId || null]);
    res.json({ ok: true, phone });
  } catch (e) {
    if (/vip_contacts/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración v0.9.316 (VIP)' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post('/admin/vip/remove', requireTenantSession, async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'sin tenant' });
  const phone = _vipNorm(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ ok: false, error: 'teléfono inválido' });
  try {
    await db.query('DELETE FROM vip_contacts WHERE tenant_id = $1 AND phone = $2', [tenantId, phone]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.post('/admin/vip/import', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'sin tenant' });
  const raw = (req.body && req.body.text) || '';
  const lines = String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let added = 0, skipped = 0;
  for (const ln of lines) {
    const parts = ln.split(/\t|,|;/).map((x) => x.trim());
    const phone = _vipNorm(parts[0]);
    if (!phone) { skipped++; continue; }
    const label = parts[1] ? parts[1].slice(0, 120) : null;
    try {
      await db.query(
        `INSERT INTO vip_contacts (tenant_id, phone, label, created_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, phone) DO UPDATE SET label = COALESCE(EXCLUDED.label, vip_contacts.label)`,
        [tenantId, phone, label, req.userId || null]);
      added++;
    } catch (e) { skipped++; }
  }
  res.json({ ok: true, added, skipped });
});

// v0.9.306 — COPY DE AVISOS CON IA: genera la descripción de un ítem del catálogo con Gemini.
// v0.9.469 — CONDENSA la descripción larga a un caption que entre en WhatsApp (≤~900 chars),
// conservando los datos esenciales. Se usa al guardar un inmueble cuya descripción no entraría en
// un caption de imagen. Best-effort: si la IA no está o falla, devuelve null y la ficha cae al
// comportamiento de 2 mensajes (foto + descripción como texto) — sin perder nada.
const _FICHA_CAPTION_MAX = 900;
async function generateFichaCaption(fields = {}, description, bizName) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const desc = String(description || '').trim();
  if (desc.length <= 1000) return null; // ya entra tal cual → no hace falta condensar
  const datos = [];
  const add = (l, v) => { if (v != null && String(v).trim() !== '') datos.push(`${l}: ${String(v).trim()}`); };
  add('Título', fields.title); add('Operación', fields.operation); add('Zona', fields.zone);
  const specs = [fields.area_m2 ? fields.area_m2 + ' m²' : null, fields.bedrooms != null ? fields.bedrooms + ' dorm' : null, fields.bathrooms != null ? fields.bathrooms + ' baños' : null, fields.garages != null ? fields.garages + ' parqueos' : null].filter(Boolean).join(' · ');
  if (specs) datos.push('Características: ' + specs);
  if (fields.price != null && String(fields.price).trim() !== '') add('Precio', `${fields.currency || 'USD'} ${fields.price}`);
  add('Disponibilidad', fields.availability);
  const systemPrompt = `Sos redactor de avisos inmobiliarios para WhatsApp en Bolivia. Te doy la descripción COMPLETA de un inmueble y sus datos clave. Devolvé una versión CONDENSADA que entre en un caption de WhatsApp: MÁXIMO ${_FICHA_CAPTION_MAX} caracteres. Español neutro, tono cálido y profesional, 1 a 3 emojis pertinentes. REGLAS CRÍTICAS: conservá SIEMPRE los datos esenciales que aparezcan (precio, superficie, dormitorios/baños/parqueos, zona/ubicación, formas de pago, monto y condiciones de reserva, fecha de entrega y los diferenciales de venta). Podés acortar la redacción y sacar relleno, pero NO borres ningún dato concreto ni inventes nada que no esté en el texto. Devolvé SOLO el texto del aviso, sin comillas ni markdown.`;
  const userPrompt = `Datos clave:\n${datos.join('\n')}${bizName ? `\n(Negocio: ${bizName})` : ''}\n\nDescripción completa:\n${desc}\n\nVersión condensada (≤${_FICHA_CAPTION_MAX} caracteres, sin perder datos):`;
  try {
    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.5, maxOutputTokens: 600, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 25000, headers: { 'Content-Type': 'application/json' } });
    let out = (gr.data && gr.data.candidates && gr.data.candidates[0] && gr.data.candidates[0].content && gr.data.candidates[0].content.parts && gr.data.candidates[0].content.parts[0] && gr.data.candidates[0].content.parts[0].text || '').trim();
    if (!out) return null;
    if (out.length > 1024) out = out.slice(0, 1010).trim(); // safety dura bajo el límite real de WhatsApp
    return out;
  } catch (e) { console.warn('[ficha-caption IA] falló (best-effort):', e.message); return null; }
}

// v0.9.469 — regenerar a mano la versión ficha (botón "🔄 Adecuar para WhatsApp" del editor).
router.post('/admin/properties/:id/fit-caption', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const pr = await db.query(
      `SELECT title, operation, zone, area_m2, bedrooms, bathrooms, garages, price, currency, description,
              to_jsonb(properties) ->> 'availability' AS availability
         FROM properties WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (pr.rows.length === 0) return res.status(404).json({ error: 'Inmueble no encontrado' });
    const p = pr.rows[0];
    if (String(p.description || '').trim().length <= 1000) {
      await db.query('UPDATE properties SET ficha_caption = NULL WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
      return res.json({ ok: true, ficha_caption: null, note: 'La descripción ya entra en un caption; no hace falta condensarla.' });
    }
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'IA no configurada (falta GEMINI_API_KEY)' });
    const _fc = await generateFichaCaption(p, p.description, null);
    if (!_fc) return res.status(502).json({ error: 'La IA no devolvió una versión válida. Reintentá.' });
    await db.query('UPDATE properties SET ficha_caption = $1 WHERE id = $2 AND tenant_id = $3', [_fc, id, tenantId]);
    res.json({ ok: true, ficha_caption: _fc, chars: _fc.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/ai/listing-copy', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'IA no configurada (falta GEMINI_API_KEY)' });
  const b = req.body || {};
  const kind = b.kind === 'inventory' ? 'inventory' : 'property';
  const fields = [];
  const add = (label, v) => { if (v != null && String(v).trim() !== '') fields.push(`${label}: ${String(v).trim()}`); };
  if (kind === 'property') {
    add('Título', b.title); add('Operación', b.operation); add('Tipo', b.type); add('Zona', b.zone);
    if (b.price != null && String(b.price).trim() !== '') add('Precio', `${b.currency || ''} ${b.price}`.trim());
    add('Dormitorios', b.bedrooms); add('Baños', b.bathrooms); add('Garajes/parqueos', b.garages);
  } else {
    add('Producto', b.name); add('Marca', b.brand); add('Categoría', b.category);
    if (b.price != null && String(b.price).trim() !== '') add('Precio', `${b.currency || ''} ${b.price}`.trim());
  }
  add('Datos extra', b.notes);
  if (!fields.length) return res.status(400).json({ error: 'Faltan datos del ítem para generar la descripción.' });
  const tone = (typeof b.tone === 'string' && b.tone.trim()) ? b.tone.trim().slice(0, 60) : 'cálido y profesional';

  let biz = '';
  try { const t = await db.query('SELECT name FROM tenants WHERE id = $1', [req.tenantId || 1]); biz = t.rows[0] ? t.rows[0].name : ''; } catch (e) { /* opcional */ }

  const systemPrompt = `Sos redactor publicitario experto en avisos de venta para WhatsApp y redes en Bolivia. Escribís descripciones atractivas, claras y HONESTAS: solo usás los datos que te dan, NO inventás precio, medidas ni características que no aparezcan. Español neutro, tono ${tone}. Máximo ~90 palabras, 1 a 3 emojis pertinentes, sin markdown pesado. Cerrá invitando a consultar. Devolvé SOLO el texto del aviso.`;
  const userPrompt = `Datos del ${kind === 'property' ? 'inmueble' : 'producto'}${biz ? ` (negocio: ${biz})` : ''}:\n${fields.join('\n')}\n\nEscribí la descripción del aviso:`;

  const axios = require('axios');
  const model = _GEM_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.85, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
    const text = (gr.data && gr.data.candidates && gr.data.candidates[0] && gr.data.candidates[0].content && gr.data.candidates[0].content.parts && gr.data.candidates[0].content.parts[0] && gr.data.candidates[0].content.parts[0].text || '').trim();
    if (!text) return res.status(502).json({ error: 'La IA no devolvió texto.' });
    res.json({ ok: true, text: text.slice(0, 1500) });
  } catch (e) {
    res.status(502).json({ error: (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message });
  }
});

/**
 * PATCH /api/admin/leads/:id
 * Actualizar status / notes de un lead.
 */
router.patch('/admin/leads/:id', requireTenantSession, async (req, res) => {
  const { id } = req.params;
  const { status, notes } = req.body;

  // v0.9.8: solo leads del tenant
  const tf = tenantFilter(req, 4, 'tenant_id');
  const result = await db.query(
    `UPDATE leads SET
       status = COALESCE($1, status),
       notes = COALESCE($2, notes)
     WHERE id = $3${tf.clause} RETURNING *`,
    [status, notes, id, ...tf.params]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Lead no encontrado' });
  // v0.9.251 — al marcar la oportunidad GANADA o PERDIDA, la conversación pasa a ARCHIVADA
  // y se DESPINEA (deja de estar fijada arriba del inbox). Cierra el ciclo del chat prioritario.
  const _lead = result.rows[0];
  if ((status === 'won' || status === 'lost') && _lead.conversation_id) {
    await db.query(
      `UPDATE conversations SET status = 'archived', archived_at = NOW(), prioritized_at = NULL, updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`, [_lead.conversation_id, _lead.tenant_id]).catch(() => {});
  }
  res.json({ success: true, lead: _lead });
});

// =============================================================
// v0.9.155 — MASTER SWITCH de IA (owner-only).
// Interruptor global por tenant que activa/desactiva TODAS las respuestas
// de Aitana. Con ai_enabled=FALSE el webhook sigue guardando los entrantes
// pero NO dispatcha al bot (los humanos responden igual desde el panel).
// =============================================================
/**
 * GET /api/admin/ai-master → { ok, ai_enabled }
 * Cualquier usuario de la sesión puede leer el estado (para reflejarlo en la UI).
 */
router.get('/admin/ai-master', requireTenantSession, async (req, res) => {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : req.tenantId;
  try {
    const r = await db.query('SELECT COALESCE(ai_enabled, TRUE) AS ai_enabled FROM tenants WHERE id = $1', [tenantId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Tenant no encontrado' });
    // v0.9.285 — estado de IA por LÍNEA y por CANAL (defensivo si faltan las columnas)
    let lines = [], channels = [];
    try {
      const lr = await db.query("SELECT id, COALESCE(label, meta_phone_number_id, ('Línea '||id)) AS label, COALESCE(ai_enabled, TRUE) AS ai_enabled, to_jsonb(tenant_lines) ->> 'ai_scope' AS ai_scope FROM tenant_lines WHERE tenant_id = $1 AND COALESCE(active, TRUE) = TRUE ORDER BY id", [tenantId]);
      lines = lr.rows.map(x => ({ id: x.id, label: x.label, ai_enabled: x.ai_enabled !== false, ai_scope: x.ai_scope || null })); // v0.9.439
    } catch (e) { /* sin columna/tabla → vacío */ }
    try {
      const cr = await db.query("SELECT channel, COALESCE(ai_enabled, TRUE) AS ai_enabled FROM tenant_channels WHERE tenant_id = $1 AND active = TRUE ORDER BY channel", [tenantId]);
      const seen = {};
      for (const x of cr.rows) { const c = x.channel; seen[c] = (seen[c] === undefined) ? (x.ai_enabled !== false) : (seen[c] && x.ai_enabled !== false); }
      channels = Object.keys(seen).map(c => ({ channel: c, ai_enabled: seen[c] }));
    } catch (e) { /* sin columna/tabla → vacío */ }
    let aiScope = 'all'; // v0.9.439
    try { const sr = await db.query(`SELECT to_jsonb(tenants) ->> 'ai_scope' AS s FROM tenants WHERE id = $1`, [tenantId]); if (sr.rows[0] && sr.rows[0].s === 'ads_only') aiScope = 'ads_only'; } catch (e) {}
    res.json({ ok: true, ai_enabled: r.rows[0].ai_enabled !== false, ai_scope: aiScope, lines, channels });
  } catch (e) {
    res.json({ ok: true, ai_enabled: true, lines: [], channels: [] });
  }
});

/**
 * PATCH /api/admin/ai-master  (owner-only)
 * Body: { enabled: bool } → UPDATE tenants SET ai_enabled.
 */
router.patch('/admin/ai-master', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : req.tenantId;
  // v0.9.439 — también acepta { scope: 'all' | 'ads_only' } (alcance de la IA, sin tocar enabled)
  if ((req.body || {}).scope !== undefined) {
    const scope = String(req.body.scope) === 'ads_only' ? 'ads_only' : 'all';
    try {
      await db.query(`UPDATE tenants SET ai_scope = $1 WHERE id = $2`, [scope, tenantId]);
      console.log(`📣 [ai-master] tenant ${tenantId} → alcance IA: ${scope}`);
      return res.json({ ok: true, ai_scope: scope });
    } catch (e) {
      if (/ai_scope/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.439 (ai_scope) — redeployá el backend' });
      return res.status(500).json({ error: e.message });
    }
  }
  const enabled = req.body && req.body.enabled === true;
  if (typeof (req.body || {}).enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled debe ser boolean' });
  }
  try {
    const r = await db.query('UPDATE tenants SET ai_enabled = $1 WHERE id = $2 RETURNING COALESCE(ai_enabled, TRUE) AS ai_enabled', [enabled, tenantId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Tenant no encontrado' });
    console.log(`🤖 [ai-master] tenant ${tenantId} → IA ${enabled ? 'ACTIVA' : 'EN PAUSA'}`);
    res.json({ ok: true, ai_enabled: r.rows[0].ai_enabled !== false });
  } catch (e) {
    console.error('PATCH /admin/ai-master error:', e.message);
    res.status(500).json({ error: 'No se pudo actualizar el master switch de IA' });
  }
});

/**
 * PATCH /api/admin/ai-line  (owner-only) — pausa/activa la IA de UNA línea de WhatsApp.
 */
router.patch('/admin/ai-line', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : req.tenantId;
  const lineId = Number((req.body || {}).line_id);
  // v0.9.439 — también acepta { line_id, scope: 'all' | 'ads_only' | null } (null = heredar del master)
  if ((req.body || {}).scope !== undefined) {
    if (!lineId) return res.status(400).json({ error: 'line_id requerido' });
    const scope = req.body.scope == null ? null : (String(req.body.scope) === 'ads_only' ? 'ads_only' : 'all');
    try {
      const r2 = await db.query('UPDATE tenant_lines SET ai_scope = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id', [scope, lineId, tenantId]);
      if (r2.rows.length === 0) return res.status(404).json({ error: 'Línea no encontrada' });
      console.log(`📣 [ai-line] tenant ${tenantId} línea ${lineId} → alcance IA: ${scope || 'heredar'}`);
      return res.json({ ok: true, line_id: lineId, ai_scope: scope });
    } catch (e) {
      if (/ai_scope/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.439 (ai_scope) — redeployá el backend' });
      return res.status(500).json({ error: e.message });
    }
  }
  const enabled = (req.body || {}).enabled;
  if (!lineId || typeof enabled !== 'boolean') return res.status(400).json({ error: 'line_id + enabled requeridos' });
  try {
    const r = await db.query('UPDATE tenant_lines SET ai_enabled = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id', [enabled, lineId, tenantId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Línea no encontrada' });
    console.log(`🤖 [ai-line] tenant ${tenantId} línea ${lineId} → IA ${enabled ? 'ACTIVA' : 'PAUSA'}`);
    res.json({ ok: true, line_id: lineId, ai_enabled: enabled });
  } catch (e) {
    if (/ai_enabled/.test(e.message)) return res.status(503).json({ error: 'Falta migración v0.9.285 (ai_enabled por línea)' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/ai-channel  (owner-only) — pausa/activa la IA de un canal (messenger/instagram/telegram).
 */
router.patch('/admin/ai-channel', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : req.tenantId;
  const channel = String((req.body || {}).channel || '').toLowerCase();
  const enabled = (req.body || {}).enabled;
  if (!['messenger', 'instagram', 'telegram'].includes(channel) || typeof enabled !== 'boolean') return res.status(400).json({ error: 'channel + enabled requeridos' });
  try {
    const r = await db.query('UPDATE tenant_channels SET ai_enabled = $1 WHERE tenant_id = $2 AND channel = $3 RETURNING id', [enabled, tenantId, channel]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Canal no conectado' });
    console.log(`🤖 [ai-channel] tenant ${tenantId} canal ${channel} → IA ${enabled ? 'ACTIVA' : 'PAUSA'}`);
    res.json({ ok: true, channel, ai_enabled: enabled });
  } catch (e) {
    if (/ai_enabled/.test(e.message)) return res.status(503).json({ error: 'Falta migración v0.9.285 (ai_enabled por canal)' });
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/stats
 * KPIs simples para el panel.
 */
router.get('/admin/stats', requireTenantSession, async (req, res) => {
  // v0.9.8: filtro por tenant en cada subquery. Super-admin → sin filtro.
  // v0.9.69 (auditoría 12-jun P1#14): los contadores de conversaciones aplican
  // el MISMO scope de agente (línea/etapa) que la lista — antes el header decía
  // "N abiertas" (total del tenant) con la lista del agente vacía.
  const t = req.isSuperAdmin ? '' : ' AND tenant_id = $1';
  const params = req.isSuperAdmin ? [] : [req.tenantId];
  let convScope = '';
  const agentLines = await getAgentLineIds(req);
  if (agentLines) {
    params.push(agentLines);
    convScope += ` AND (line_id = ANY($${params.length}::int[]) OR line_id IS NULL)`;
  }
  const stageScope = await getAgentStageScope(req);
  if (stageScope) {
    params.push(stageScope);
    convScope += ` AND COALESCE(stage, 'venta') = $${params.length}`;
  }
  const chanScope = await getAgentChannelScope(req);
  if (chanScope) {
    params.push(chanScope);
    convScope += ` AND COALESCE(channel, 'whatsapp') = ANY($${params.length}::text[])`;
  }
  const stats = await db.query(`
    SELECT
      (SELECT COUNT(*) FROM conversations WHERE status = 'open'${t}${convScope}) AS open_conversations,
      (SELECT COUNT(*) FROM conversations WHERE mode = 'human' AND status = 'open'${t}${convScope}) AS in_human,
      (SELECT COUNT(*) FROM conversations WHERE mode = 'bot' AND status = 'open'${t}${convScope}) AS in_bot,
      (SELECT COUNT(*) FROM leads WHERE status = 'new'${t}) AS new_leads,
      (SELECT COUNT(*) FROM leads WHERE status = 'won'${t}) AS won_leads,
      (SELECT COUNT(*) FROM messages WHERE created_at > NOW() - INTERVAL '24 hours'${t}) AS messages_24h
  `, params);
  res.json(stats.rows[0]);
});

/**
 * GET /api/admin/stats/dashboard?days=30
 * Analytics completo para el dashboard del panel.
 * v0.9.1: añade embudo, distribución por vertical, hora del día, tendencia diaria,
 *         tiempo de respuesta y abandono.
 *
 * Query params: days (default 30, valores típicos: 7, 30, 90)
 */
/**
 * GET /api/admin/stats/sellers?days=30 — v0.9.16
 * Métricas por VENDEDOR (atribución vía messages.sent_by_user_id, v0.9.12+).
 * Visibilidad: owner/supervisor/super-admin ven a todo el equipo;
 * un agente SOLO se ve a sí mismo (gating en servidor, no en UI).
 */
// v0.9.345 — TOP TEMAS: agregado de los topics que el clasificador IA asigna a las
// conversaciones (qué vienen a buscar/consultar los clientes). ?days=30 (7/30/90).
router.get('/admin/stats/topics', requireTenantSession, async (req, res) => {
  try {
    const tenantId = req.isSuperAdmin ? (parseInt(req.query.tenant_id) || null) : req.tenantId;
    if (!tenantId) return res.json({ ok: true, topics: [], total: 0 });
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
    const _ln = /^\d+$/.test(String(req.query.line_id == null ? '' : req.query.line_id)) ? ` AND line_id = ${parseInt(req.query.line_id, 10)}` : ''; // v0.9.474
    const r = await db.query(`
      SELECT topic, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE plane = 'soporte')::int AS n_soporte
        FROM (SELECT unnest(topics) AS topic, plane FROM conversations
               WHERE tenant_id = $1 AND topics IS NOT NULL
                 AND last_message_at > NOW() - make_interval(days => $2)${_ln}) x
       GROUP BY topic ORDER BY n DESC LIMIT 25`, [tenantId, days]);
    const tot = await db.query(
      `SELECT COUNT(*)::int AS n FROM conversations
        WHERE tenant_id = $1 AND topics IS NOT NULL AND last_message_at > NOW() - make_interval(days => $2)${_ln}`,
      [tenantId, days]);
    res.json({ ok: true, topics: r.rows, total: (tot.rows[0] && tot.rows[0].n) || 0, days });
  } catch (e) {
    if (/topics/.test(e.message)) return res.json({ ok: true, topics: [], total: 0, pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.369 — STRAIGHT LINE: distribución de arquetipos de comprador + promedio de los
// tres dieces (P/V/E) sobre las conversaciones con sl_state del período. La distribución
// de arquetipos ES la salud del pipeline (Belfort: ~20% ready, ~30% shopping, ~30%
// curious, ~20% dragged — desvíos fuertes indican problema de captación o de guion).
router.get('/admin/stats/straight-line', requireTenantSession, async (req, res) => {
  try {
    const tenantId = req.isSuperAdmin ? (parseInt(req.query.tenant_id) || null) : req.tenantId;
    if (!tenantId) return res.json({ ok: true, total: 0, archetypes: {}, avgs: {} });
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const _ln = /^\d+$/.test(String(req.query.line_id == null ? '' : req.query.line_id)) ? ` AND line_id = ${parseInt(req.query.line_id, 10)}` : ''; // v0.9.474
    const q = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE sl_state ->> 'archetype' = 'ready')::int AS ready,
         COUNT(*) FILTER (WHERE sl_state ->> 'archetype' = 'shopping')::int AS shopping,
         COUNT(*) FILTER (WHERE sl_state ->> 'archetype' = 'curious')::int AS curious,
         COUNT(*) FILTER (WHERE sl_state ->> 'archetype' = 'dragged')::int AS dragged,
         COUNT(*) FILTER (WHERE sl_state ->> 'archetype' IS NULL)::int AS unknown,
         ROUND(AVG((sl_state ->> 'p')::numeric), 1) AS avg_p,
         ROUND(AVG((sl_state ->> 'v')::numeric), 1) AS avg_v,
         ROUND(AVG((sl_state ->> 'e')::numeric), 1) AS avg_e
       FROM conversations
       WHERE tenant_id = $1 AND sl_state IS NOT NULL
         AND last_message_at > NOW() - make_interval(days => $2::int)${_ln}`,
      [tenantId, days]
    );
    const r = q.rows[0] || {};
    res.json({
      ok: true,
      total: r.total || 0,
      archetypes: { ready: r.ready || 0, shopping: r.shopping || 0, curious: r.curious || 0, dragged: r.dragged || 0, unknown: r.unknown || 0 },
      avgs: { p: r.avg_p != null ? Number(r.avg_p) : null, v: r.avg_v != null ? Number(r.avg_v) : null, e: r.avg_e != null ? Number(r.avg_e) : null },
    });
  } catch (e) {
    if (/sl_state/.test(e.message)) return res.json({ ok: true, total: 0, archetypes: {}, avgs: {}, pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.346 — Zonas más pedidas (demanda): agrega el `location` que el bot captura en el
// search_profile de cada conversación (v0.9.305) y lo cruza contra las zonas del catálogo
// activo → el dueño ve DÓNDE busca la gente y dónde NO tiene oferta (dato de captación).
router.get('/admin/stats/zones', requireTenantSession, async (req, res) => {
  try {
    const tenantId = req.isSuperAdmin ? (parseInt(req.query.tenant_id) || null) : req.tenantId;
    if (!tenantId) return res.json({ ok: true, zones: [], total: 0 });
    const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
    const _ln = /^\d+$/.test(String(req.query.line_id == null ? '' : req.query.line_id)) ? ` AND line_id = ${parseInt(req.query.line_id, 10)}` : ''; // v0.9.474
    // Normaliza: minúsculas, sin acentos, sin prefijos "zona/z." — agrupa "Equipetrol",
    // "zona equipetrol" y "Equipétrol" en una sola fila (muestra la forma más frecuente).
    const r = await db.query(`
      WITH locs AS (
        SELECT TRIM(REGEXP_REPLACE(LOWER(UNACCENT(loc)), '^(zona|zn\\.?|z\\.)\\s+', '')) AS zkey,
               TRIM(loc) AS zraw
          FROM (SELECT search_profile ->> 'location' AS loc FROM conversations
                 WHERE tenant_id = $1 AND search_profile ->> 'location' IS NOT NULL
                   AND TRIM(search_profile ->> 'location') <> ''
                   AND last_message_at > NOW() - make_interval(days => $2)${_ln}) c
         WHERE LENGTH(TRIM(loc)) BETWEEN 2 AND 60
      )
      SELECT zkey, MODE() WITHIN GROUP (ORDER BY zraw) AS zone, COUNT(*)::int AS n
        FROM locs GROUP BY zkey ORDER BY n DESC LIMIT 30`, [tenantId, days]);
    // Zonas con oferta activa en el catálogo (para marcar demanda SIN oferta).
    let catZones = [];
    try {
      const cz = await db.query(
        `SELECT DISTINCT TRIM(LOWER(UNACCENT(zone))) AS z FROM properties
          WHERE tenant_id = $1 AND active = TRUE AND status = 'disponible' AND zone IS NOT NULL AND TRIM(zone) <> ''`,
        [tenantId]);
      catZones = cz.rows.map((x) => x.z);
    } catch (e) { /* sin tabla properties → sin cruce */ }
    const zones = r.rows.map((row) => ({
      zone: row.zone, n: row.n,
      in_catalog: catZones.some((cz) => cz.includes(row.zkey) || row.zkey.includes(cz)),
    }));
    const total = zones.reduce((a, z) => a + z.n, 0);
    res.json({ ok: true, zones, total, days, has_catalog: catZones.length > 0 });
  } catch (e) {
    // UNACCENT puede no existir → reintento sin extensión (agrupa menos fino pero funciona)
    if (/unaccent/i.test(e.message)) {
      try {
        const tenantId = req.isSuperAdmin ? (parseInt(req.query.tenant_id) || null) : req.tenantId;
        const days = Math.min(Math.max(parseInt(req.query.days) || 90, 1), 365);
        const _ln = /^\d+$/.test(String(req.query.line_id == null ? '' : req.query.line_id)) ? ` AND line_id = ${parseInt(req.query.line_id, 10)}` : ''; // v0.9.474
        const r = await db.query(`
          SELECT TRIM(LOWER(search_profile ->> 'location')) AS zone, COUNT(*)::int AS n
            FROM conversations
           WHERE tenant_id = $1 AND search_profile ->> 'location' IS NOT NULL AND TRIM(search_profile ->> 'location') <> ''
             AND last_message_at > NOW() - make_interval(days => $2)${_ln}
           GROUP BY 1 ORDER BY n DESC LIMIT 30`, [tenantId, days]);
        const zones = r.rows.map((row) => ({ zone: row.zone, n: row.n, in_catalog: null }));
        return res.json({ ok: true, zones, total: zones.reduce((a, z) => a + z.n, 0), days, has_catalog: false });
      } catch (e2) { return res.status(500).json({ error: e2.message }); }
    }
    if (/search_profile/.test(e.message)) return res.json({ ok: true, zones: [], total: 0, pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/stats/sellers', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);
  const isAgent = req.userRole === 'agent' && req.userId;

  const params = [tenantId, String(days)];
  let userIdx = null;
  if (isAgent) { params.push(req.userId); userIdx = params.length; }

  // v0.9.30: filtro opcional por etapa (COALESCE: sin stage = 'venta').
  const stage = ['venta', 'postventa'].includes(String(req.query.stage)) ? String(req.query.stage) : null;
  let stageIdx = null;
  if (stage) { params.push(stage); stageIdx = params.length; }

  // v0.9.200 — ATRIBUCIÓN HÍBRIDA. Antes TODAS las columnas se atribuían por
  // `sent_by_user_id` (mensajes enviados a mano desde el panel). Como Aitana (bot)
  // manda todo (sent_by_user_id = NULL), los vendedores salían SIEMPRE en cero.
  // Ahora se separa:
  //   • MSGS / 1ª respuesta / sparkline 7d = esfuerzo MANUAL del asesor (sent_by_user_id).
  //   • Conversaciones / leads / ganados   = por ASIGNACIÓN (conversations.assigned_to),
  //     aunque haya respondido el bot. Refleja la productividad real en el modelo
  //     bot-driven + pool de citas.
  const userFilterU = isAgent ? ` AND u.id = $${userIdx}` : '';               // base (tenant_users u)
  const mUserFilter = isAgent ? ` AND m.sent_by_user_id = $${userIdx}` : '';  // queries por mensaje
  const stMsg = stage ? ` AND EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.conversation_id AND COALESCE(sc.stage, 'venta') = $${stageIdx})` : '';
  const cUserFilter = isAgent ? ` AND c.assigned_to = $${userIdx}` : '';      // query por asignación (conversations c)
  const cStage = stage ? ` AND COALESCE(c.stage, 'venta') = $${stageIdx}` : '';

  try {
    // 1. Base: usuarios + MSGS (mensajes enviados a mano desde el panel)
    const base = await db.query(
      `SELECT u.id, COALESCE(u.display_name, u.email, 'Usuario ' || u.id) AS name, u.role, u.active,
              COUNT(m.id)::int AS messages_sent
       FROM tenant_users u
       LEFT JOIN messages m ON m.sent_by_user_id = u.id
         AND m.direction = 'outgoing'
         AND m.created_at > NOW() - ($2 || ' days')::interval${stMsg}
       WHERE u.tenant_id = $1 AND NOT COALESCE((to_jsonb(u) ->> 'hidden_from_tenant')::boolean, FALSE)${userFilterU}
       GROUP BY u.id
       ORDER BY name ASC`,
      params
    );

    // 2. Por ASIGNACIÓN: conversaciones asignadas al vendedor + leads en ellas + ganados
    //    (acotado a conversaciones activas en el período por last_message_at)
    const assigned = await db.query(
      `SELECT c.assigned_to AS uid,
              COUNT(DISTINCT c.id)::int AS conversations_assigned,
              COUNT(DISTINCT l.id)::int AS leads_assigned,
              (COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'won'))::int AS leads_won
       FROM conversations c
       JOIN tenant_users u ON u.id = c.assigned_to AND u.tenant_id = $1
       LEFT JOIN leads l ON l.conversation_id = c.id
       WHERE c.tenant_id = $1 AND c.assigned_to IS NOT NULL
         AND c.last_message_at > NOW() - ($2 || ' days')::interval${cUserFilter}${cStage}
       GROUP BY c.assigned_to`,
      params
    );

    // 3. Tiempo de PRIMERA respuesta MANUAL (primer outgoing humano tras cada incoming; cap 24h)
    const reply = await db.query(
      `SELECT m.sent_by_user_id AS uid,
              ROUND(AVG(LEAST(EXTRACT(EPOCH FROM (m.created_at - prev.created_at)) / 60, 1440))::numeric, 1) AS avg_first_reply_min,
              COUNT(*)::int AS replies_measured
       FROM messages m
       JOIN tenant_users u ON u.id = m.sent_by_user_id AND u.tenant_id = $1
       JOIN LATERAL (
         SELECT p.created_at FROM messages p
         WHERE p.conversation_id = m.conversation_id AND p.direction = 'incoming' AND p.created_at < m.created_at
         ORDER BY p.created_at DESC LIMIT 1
       ) prev ON TRUE
       WHERE m.direction = 'outgoing' AND m.sent_by_user_id IS NOT NULL
         AND m.created_at > NOW() - ($2 || ' days')::interval${mUserFilter}${stMsg}
         AND NOT EXISTS (
           SELECT 1 FROM messages b
           WHERE b.conversation_id = m.conversation_id AND b.direction = 'outgoing'
             AND b.created_at > prev.created_at AND b.created_at < m.created_at
         )
       GROUP BY m.sent_by_user_id`,
      params
    );

    // 4. Sparkline últimos 7 días = mensajes MANUALES por día. Params propios.
    const weekParams = isAgent ? [tenantId, req.userId] : [tenantId];
    const weekFilter = isAgent ? ' AND m.sent_by_user_id = $2' : '';
    let weekStage = '';
    if (stage) { // v0.9.30
      weekParams.push(stage);
      weekStage = ` AND EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.conversation_id AND COALESCE(sc.stage, 'venta') = $${weekParams.length})`;
    }
    const week = await db.query(
      `SELECT m.sent_by_user_id AS uid,
              TO_CHAR(m.created_at AT TIME ZONE 'America/La_Paz', 'YYYY-MM-DD') AS d,
              COUNT(*)::int AS n
       FROM messages m
       JOIN tenant_users u ON u.id = m.sent_by_user_id AND u.tenant_id = $1
       WHERE m.direction = 'outgoing' AND m.created_at > NOW() - INTERVAL '7 days'${weekFilter}${weekStage}
       GROUP BY m.sent_by_user_id, d`,
      weekParams
    );

    const assignedMap = Object.fromEntries(assigned.rows.map(r => [r.uid, r]));
    const replyMap = Object.fromEntries(reply.rows.map(r => [r.uid, r]));
    const weekMap = {};
    for (const r of week.rows) {
      (weekMap[r.uid] = weekMap[r.uid] || {})[r.d] = r.n;
    }

    const sellers = base.rows.map(u => ({
      user_id: u.id,
      name: u.name,
      role: u.role,
      active: u.active,
      messages_sent: u.messages_sent,                                                       // MANUAL
      conversations_touched: assignedMap[u.id] ? assignedMap[u.id].conversations_assigned : 0, // ASIGNACIÓN
      avg_first_reply_min: replyMap[u.id] ? Number(replyMap[u.id].avg_first_reply_min) : null, // MANUAL
      replies_measured: replyMap[u.id] ? replyMap[u.id].replies_measured : 0,
      leads_touched: assignedMap[u.id] ? assignedMap[u.id].leads_assigned : 0,               // ASIGNACIÓN
      leads_won: assignedMap[u.id] ? assignedMap[u.id].leads_won : 0,                        // ASIGNACIÓN
      by_day_7: weekMap[u.id] || {},                                                          // MANUAL
    }));
    // orden por productividad: leads asignados › conversaciones › mensajes › nombre
    sellers.sort((a, b) =>
      b.leads_touched - a.leads_touched ||
      b.conversations_touched - a.conversations_touched ||
      b.messages_sent - a.messages_sent ||
      String(a.name).localeCompare(String(b.name))
    );

    res.json({ ok: true, days, stage: stage || 'todas', restricted: !!isAgent, your_user_id: req.userId || null, sellers });
  } catch (e) {
    if (/sent_by_user_id|tenant_users|assigned_to|last_message_at/.test(e.message)) {
      return res.json({ ok: true, days, restricted: false, sellers: [], pending_migration: true });
    }
    console.error('❌ [stats/sellers] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.259 — DASHBOARD MACRO POR LÍNEA: vista de alto nivel de cada línea (conversaciones, leads,
// citas, mensajes, conversión) agrupado por conversations.line_id. Scopeado por tenant.
router.get('/admin/stats/by-line', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
  try {
    const lr = await db.query('SELECT id, label, display_phone FROM tenant_lines WHERE tenant_id = $1 ORDER BY is_default DESC NULLS LAST, id ASC', [tenantId]).catch(() => ({ rows: [] }));
    const cv = await db.query(
      `SELECT c.line_id,
              COUNT(DISTINCT c.id) AS conversations,
              COUNT(DISTINCT c.id) FILTER (WHERE c.status = 'open') AS conversations_open,
              COUNT(DISTINCT l.id) AS leads,
              COUNT(DISTINCT l.id) FILTER (WHERE COALESCE(l.score,0) >= 70) AS leads_qualified,
              COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'won') AS leads_won,
              COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'lost') AS leads_lost
         FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id
        WHERE c.tenant_id = $1 GROUP BY c.line_id`, [tenantId]);
    const ap = await db.query(
      `SELECT c.line_id,
              COUNT(*) FILTER (WHERE a.status = 'pending') AS appts_pending,
              COUNT(*) FILTER (WHERE a.status = 'scheduled') AS appts_scheduled,
              COUNT(*) FILTER (WHERE a.status = 'completed') AS appts_completed
         FROM appointments a JOIN conversations c ON c.id = a.conversation_id
        WHERE c.tenant_id = $1 GROUP BY c.line_id`, [tenantId]).catch(() => ({ rows: [] }));
    const ms = await db.query(
      `SELECT c.line_id,
              COUNT(*) FILTER (WHERE m.direction = 'incoming') AS msgs_in,
              COUNT(*) FILTER (WHERE m.direction = 'outgoing') AS msgs_out
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.tenant_id = $1 AND m.created_at > NOW() - ($2 || ' days')::interval
        GROUP BY c.line_id`, [tenantId, String(days)]).catch(() => ({ rows: [] }));
    const byId = (rows) => { const o = {}; for (const r of rows) o[r.line_id == null ? 'null' : String(r.line_id)] = r; return o; };
    const cvm = byId(cv.rows), apm = byId(ap.rows), msm = byId(ms.rows);
    const _n = (v) => Number(v || 0);
    const build = (key, label, phone) => {
      const c = cvm[key] || {}, a = apm[key] || {}, m = msm[key] || {};
      const leads = _n(c.leads), won = _n(c.leads_won);
      return {
        line_id: key === 'null' ? null : Number(key), label, display_phone: phone,
        conversations: _n(c.conversations), conversations_open: _n(c.conversations_open),
        leads, leads_qualified: _n(c.leads_qualified), leads_won: won, leads_lost: _n(c.leads_lost),
        appts_pending: _n(a.appts_pending), appts_scheduled: _n(a.appts_scheduled), appts_completed: _n(a.appts_completed),
        msgs_in: _n(m.msgs_in), msgs_out: _n(m.msgs_out),
        conv_rate: leads > 0 ? Math.round((won / leads) * 100) : 0,
      };
    };
    const lines = lr.rows.map(l => build(String(l.id), l.label || ('Línea ' + l.id), l.display_phone || null));
    if (cvm['null'] || apm['null'] || msm['null']) lines.push(build('null', 'Sin línea', null));
    res.json({ ok: true, days, lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/stats/ads — v0.9.474 — ANUNCIOS Click-to-WhatsApp (CTWA)
 * De qué anuncios y plataformas (Facebook / Instagram) están llegando los contactos.
 * Fuente: conversations.referral (jsonb que Meta manda en el primer mensaje del ad) +
 * ad_property_id (inmueble matcheado). Respeta days / stage / line_id.
 */
router.get('/admin/stats/ads', requireTenantSession, async (req, res) => {
  try {
    const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
    if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const since = `${days} days`;
    const stage = ['venta', 'postventa'].includes(String(req.query.stage)) ? String(req.query.stage) : null;
    // line_id validado (entero) ⇒ injection-safe inline
    const _lidRaw = req.query.line_id;
    const _lid = /^\d+$/.test(String(_lidRaw == null ? '' : _lidRaw)) ? parseInt(_lidRaw, 10) : null;
    const params = [since, tenantId];
    let stageClause = '';
    if (stage) { params.push(stage); stageClause = ` AND COALESCE(c.stage, 'venta') = $${params.length}`; }
    const lineClause = _lid != null ? ` AND c.line_id = ${_lid}` : '';

    // total de conversaciones del período (para el % que viene de anuncios)
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS total FROM conversations c
        WHERE c.tenant_id = $2 AND c.created_at > NOW() - $1::interval${stageClause}${lineClause}`, params);

    // agregado por anuncio (los campos del referral que manda Meta en CTWA)
    const adRes = await db.query(
      `SELECT
         c.referral->>'source_type' AS source_type,
         c.referral->>'source_id'   AS source_id,
         c.referral->>'source_url'  AS source_url,
         c.referral->>'headline'    AS headline,
         c.referral->>'body'        AS body,
         c.referral->>'media_type'  AS media_type,
         c.ad_property_id           AS ad_property_id,
         COUNT(DISTINCT c.id)::int  AS conversations,
         COUNT(DISTINCT l.id) FILTER (WHERE COALESCE(l.score,0) >= 70)::int AS qualified,
         COUNT(DISTINCT l.id) FILTER (WHERE l.status = 'won')::int           AS won,
         COUNT(DISTINCT ap.id)::int AS appointments
       FROM conversations c
       LEFT JOIN leads l ON l.conversation_id = c.id
       LEFT JOIN appointments ap ON ap.conversation_id = c.id
       WHERE c.tenant_id = $2 AND c.referral IS NOT NULL
         AND c.created_at > NOW() - $1::interval${stageClause}${lineClause}
       GROUP BY 1,2,3,4,5,6,7
       ORDER BY conversations DESC
       LIMIT 100`, params);

    // títulos de inmuebles matcheados (ad_property_id)
    const propIds = [...new Set(adRes.rows.map(r => r.ad_property_id).filter(Boolean))];
    const propMap = {};
    if (propIds.length) {
      const pr = await db.query(`SELECT id, title FROM properties WHERE tenant_id = $1 AND id = ANY($2::int[])`, [tenantId, propIds]).catch(() => ({ rows: [] }));
      pr.rows.forEach(p => { propMap[p.id] = p.title; });
    }

    // plataforma inferida del source_url (Meta no manda un campo "plataforma" limpio)
    const platformOf = (url, stype) => {
      const u = String(url || '').toLowerCase();
      if (u.includes('instagram') || u.includes('ig.me') || u.includes('/ig/')) return 'Instagram';
      if (u.includes('facebook') || u.includes('fb.') || u.includes('fb.me')) return 'Facebook';
      return stype === 'post' ? 'Publicación' : 'Meta (sin URL)';
    };

    const ads = adRes.rows.map(r => {
      const platform = platformOf(r.source_url, r.source_type);
      const label = (r.headline && r.headline.trim()) || (r.body && r.body.trim())
        || (r.source_id ? ('Anuncio ' + r.source_id) : (r.source_url || 'Anuncio sin título'));
      return {
        label: String(label).slice(0, 120),
        platform,
        source_type: r.source_type || null,   // 'ad' | 'post'
        source_url: r.source_url || null,
        media_type: r.media_type || null,      // 'image' | 'video'
        conversations: r.conversations,
        qualified: r.qualified, won: r.won, appointments: r.appointments,
        property_title: r.ad_property_id ? (propMap[r.ad_property_id] || null) : null,
      };
    });

    // resumen por plataforma
    const byPlat = {}; let adTotal = 0;
    ads.forEach(a => { byPlat[a.platform] = (byPlat[a.platform] || 0) + a.conversations; adTotal += a.conversations; });
    const by_platform = Object.entries(byPlat)
      .map(([platform, conversations]) => ({ platform, conversations }))
      .sort((a, b) => b.conversations - a.conversations);

    res.json({
      ok: true, days,
      total_conversations: totalRes.rows[0].total,
      ad_conversations: adTotal,
      ads, by_platform,
    });
  } catch (e) {
    console.error('❌ /admin/stats/ads:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/stats/dashboard', requireTenantSession, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days, 10) || 30));
    const since = `${days} days`;

    // v0.9.8: aislamiento por tenant. Si es super-admin, sin filtro.
    // Las clauses usan $2 (el tenant_id) cuando aplica; qp = params base.
    const TID = req.isSuperAdmin ? null : req.tenantId;
    const qp = TID ? [since, TID] : [since];
    // Fragmentos condicionales para distintos contextos de tabla:
    const fC = TID ? ' AND tenant_id = $2' : '';        // tabla sin alias
    const fCc = TID ? ' AND c.tenant_id = $2' : '';      // conversations c

    // v0.9.30: filtro opcional por etapa (?stage=venta|postventa).
    // COALESCE: conversaciones pre-v0.9.26 sin stage cuentan como 'venta'.
    const stage = ['venta', 'postventa'].includes(String(req.query.stage)) ? String(req.query.stage) : null;
    if (stage) qp.push(stage);
    const SIDX = qp.length; // índice del parámetro stage (si hay)
    const stF  = stage ? ` AND COALESCE(stage, 'venta') = $${SIDX}` : '';   // conversations sin alias
    const stFc = stage ? ` AND COALESCE(c.stage, 'venta') = $${SIDX}` : ''; // conversations c
    // tablas con conversation_id (messages / leads / appointments)
    const stFx = stage ? ` AND EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = conversation_id AND COALESCE(sc.stage, 'venta') = $${SIDX})` : '';
    const stFm = stage ? ` AND EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.conversation_id AND COALESCE(sc.stage, 'venta') = $${SIDX})` : '';

    // v0.9.473: filtro opcional por LÍNEA (?line_id=N). line_id es un entero validado
    // (parseInt) ⇒ es INJECTION-SAFE inlinearlo como literal, y así evitamos el juego de
    // índices $ entre los distintos arrays de params (qp, qp2, service, response_time).
    // messages NO tiene line_id ⇒ se filtra vía conversations (EXISTS por conversation_id).
    const _lineIdRaw = req.query.line_id;
    const line_id = /^\d+$/.test(String(_lineIdRaw == null ? '' : _lineIdRaw)) ? parseInt(_lineIdRaw, 10) : null;
    const lnF  = line_id != null ? ` AND line_id = ${line_id}` : '';                 // conversations sin alias
    const lnFc = line_id != null ? ` AND c.line_id = ${line_id}` : '';                // conversations c
    const lnFx = line_id != null ? ` AND EXISTS (SELECT 1 FROM conversations lc WHERE lc.id = conversation_id AND lc.line_id = ${line_id})` : ''; // tablas con conversation_id
    const lnFm = line_id != null ? ` AND EXISTS (SELECT 1 FROM conversations lc WHERE lc.id = m.conversation_id AND lc.line_id = ${line_id})` : ''; // messages m

    // ── Totales (1 query con CTEs) ─────────────────────────────────
    const totalsRes = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM conversations
           WHERE created_at > NOW() - $1::interval${fC}${stF}${lnF}) AS conversations_new,
        (SELECT COUNT(*) FROM messages
           WHERE created_at > NOW() - $1::interval${fC}${stFx}${lnFx}) AS messages_total,
        (SELECT COUNT(*) FROM leads
           WHERE created_at > NOW() - $1::interval AND score >= 70${fC}${stFx}${lnFx}) AS leads_qualified,
        (SELECT COUNT(*) FROM appointments
           WHERE created_at > NOW() - $1::interval${fC}${stFx}${lnFx}) AS appointments_scheduled
    `, qp);

    // ── Embudo ─────────────────────────────────────────────────────
    const funnelRes = await db.query(`
      WITH conv_in_period AS (
        SELECT c.id, c.current_score
        FROM conversations c
        WHERE c.created_at > NOW() - $1::interval${fCc}${stFc}${lnFc}
      ),
      conv_with_replies AS (
        SELECT c.id
        FROM conv_in_period c
        JOIN messages m ON m.conversation_id = c.id AND m.sender_type = 'client'
        GROUP BY c.id
        HAVING COUNT(*) >= 2
      )
      SELECT
        (SELECT COUNT(*) FROM conv_in_period) AS incoming,
        (SELECT COUNT(*) FROM conv_with_replies) AS engaged,
        (SELECT COUNT(*) FROM conv_in_period WHERE current_score >= 70) AS qualified,
        (SELECT COUNT(*) FROM conv_in_period WHERE current_score >= 85) AS hot,
        (SELECT COUNT(*) FROM appointments
           WHERE created_at > NOW() - $1::interval${fC}${stFx}${lnFx}) AS appointments,
        (SELECT COUNT(*) FROM leads
           WHERE created_at > NOW() - $1::interval AND status = 'won'${fC}${stFx}${lnFx}) AS won
    `, qp);

    // ── v0.9.493 — LEADS POR ESTADO ────────────────────────────────
    // El embudo de arriba mide el recorrido AUTOMÁTICO (score, citas). Esto es
    // distinto: es el pipeline COMERCIAL, el estado que el equipo mueve a mano en
    // Leads (nuevo → contactado → calificado → propuesta → ganado/perdido).
    // Un lead sin status cuenta como 'new' (default de la tabla).
    const leadsByStatusRes = await db.query(`
      SELECT COALESCE(NULLIF(TRIM(status), ''), 'new') AS status, COUNT(*)::int AS n
        FROM leads
       WHERE created_at > NOW() - $1::interval${fC}${stFx}${lnFx}
       GROUP BY 1
    `, qp);

    // ── Distribución por vertical ──────────────────────────────────
    // Usa COALESCE para mostrar 'sin-detectar' en lugar de null
    const byVerticalRes = await db.query(`
      SELECT
        COALESCE(l.vertical, c.vertical, 'sin-detectar') AS vertical,
        COUNT(DISTINCT c.id) AS count,
        ROUND(AVG(c.current_score))::int AS avg_score,
        COUNT(DISTINCT CASE WHEN c.current_score >= 70 THEN c.id END) AS qualified
      FROM conversations c
      LEFT JOIN leads l ON l.conversation_id = c.id
      WHERE c.created_at > NOW() - $1::interval${fCc}${stFc}${lnFc}
      GROUP BY COALESCE(l.vertical, c.vertical, 'sin-detectar')
      ORDER BY count DESC
    `, qp);

    // ── Mensajes recibidos por hora del día (0-23) ─────────────────
    const byHourRes = await db.query(`
      SELECT
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/La_Paz')::int AS hour,
        COUNT(*)::int AS count
      FROM messages
      WHERE sender_type = 'client'
        AND created_at > NOW() - $1::interval${fC}${stFx}${lnFx}
      GROUP BY hour
      ORDER BY hour
    `, qp);

    // ── Conversaciones nuevas por día (últimos N días) ─────────────
    const byDayRes = await db.query(`
      SELECT
        DATE(created_at AT TIME ZONE 'America/La_Paz') AS day,
        COUNT(*)::int AS count
      FROM conversations
      WHERE created_at > NOW() - $1::interval${fC}${stF}${lnF}
      GROUP BY day
      ORDER BY day
    `, qp);

    // ── Tiempo de respuesta del bot ───────────────────────────────
    const responseTimeRes = await db.query(`
      WITH bot_responses AS (
        SELECT
          m.created_at AS bot_at,
          (
            SELECT m2.created_at FROM messages m2
            WHERE m2.conversation_id = m.conversation_id
              AND m2.sender_type = 'client'
              AND m2.created_at < m.created_at
            ORDER BY m2.created_at DESC LIMIT 1
          ) AS client_at
        FROM messages m
        WHERE m.sender_type = 'bot'
          AND m.created_at > NOW() - $1::interval${TID ? ' AND m.tenant_id = $2' : ''}${stFm}${lnFm}
      )
      SELECT
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (bot_at - client_at))
        ))::int AS median_seconds,
        ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (bot_at - client_at))
        ))::int AS p90_seconds
      FROM bot_responses
      WHERE client_at IS NOT NULL
        AND EXTRACT(EPOCH FROM (bot_at - client_at)) BETWEEN 0 AND 3600
    `, qp);

    // ── Abandono por largo de conversación ─────────────────────────
    const abandonmentRes = await db.query(`
      WITH client_msg_counts AS (
        SELECT c.id, COUNT(m.id) FILTER (WHERE m.sender_type = 'client') AS cm
        FROM conversations c
        LEFT JOIN messages m ON m.conversation_id = c.id
        WHERE c.created_at > NOW() - $1::interval${fCc}${stFc}${lnFc}
        GROUP BY c.id
      )
      SELECT
        COUNT(*) FILTER (WHERE cm BETWEEN 1 AND 2)::int AS very_short,
        COUNT(*) FILTER (WHERE cm BETWEEN 3 AND 5)::int AS short,
        COUNT(*) FILTER (WHERE cm BETWEEN 6 AND 10)::int AS medium,
        COUNT(*) FILTER (WHERE cm > 10)::int AS long
      FROM client_msg_counts
    `, qp);

    // ── Top assets más enviados ──────────────────────────────────
    const topAssetsRes = await db.query(`
      SELECT
        COALESCE(media_caption, type) AS label,
        COUNT(*)::int AS send_count
      FROM messages
      WHERE sender_type = 'bot'
        AND (media_url IS NOT NULL OR type != 'text')
        AND created_at > NOW() - $1::interval${fC}${stFx}${lnFx}
      GROUP BY label
      ORDER BY send_count DESC
      LIMIT 10
    `, qp);

    // ── v0.9.34: métricas de SERVICIO para post-venta ──────────────
    // Post-venta es atención al cliente: lo que importa es la ACTIVIDAD del
    // período (las conversaciones se crearon hace tiempo), no el embudo.
    let service = null;
    if (stage === 'postventa') {
      const svcRes = await db.query(`
        SELECT
          COUNT(DISTINCT m.conversation_id) FILTER (WHERE m.direction = 'incoming')::int AS clients_attended,
          COUNT(*) FILTER (WHERE m.direction = 'incoming')::int AS messages_in,
          COUNT(*) FILTER (WHERE m.direction = 'outgoing' AND m.sender_type = 'bot')::int AS bot_replies,
          COUNT(*) FILTER (WHERE m.direction = 'outgoing' AND m.sender_type = 'human')::int AS human_replies
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.created_at > NOW() - $1::interval${TID ? ' AND m.tenant_id = $2' : ''}${lnFm}
          AND COALESCE(c.stage, 'venta') = 'postventa'
      `, TID ? [since, TID] : [since]);
      service = svcRes.rows[0];
    }

    // ── v0.9.30: comparativo Venta vs Post-venta (siempre, sin filtro) ──
    let byStage = [];
    try {
      const qp2 = TID ? [since, TID] : [since];
      // v0.9.34: por ACTIVIDAD (last_message_at), no por creación — las convs
      // de post-venta son viejas y con created_at daban siempre 0.
      const byStageRes = await db.query(`
        SELECT COALESCE(stage, 'venta') AS stage,
               COUNT(*)::int AS conversations_new,
               COUNT(*) FILTER (WHERE current_score >= 70)::int AS qualified,
               COUNT(*) FILTER (WHERE status = 'open')::int AS open_now
        FROM conversations
        WHERE last_message_at > NOW() - $1::interval${fC}${lnF}
        GROUP BY 1
      `, qp2);
      byStage = byStageRes.rows;
    } catch (e) { /* columna stage no migrada → sin comparativo */ }

    res.json({
      period: { days, since_iso: new Date(Date.now() - days * 86400000).toISOString() },
      stage: stage || 'todas', // v0.9.30: eco del filtro aplicado
      line_id: line_id, // v0.9.473: eco del filtro por línea (null = todas)
      by_stage: byStage,
      service, // v0.9.34: solo cuando stage=postventa
      totals: totalsRes.rows[0],
      funnel: funnelRes.rows[0],
      leads_by_status: leadsByStatusRes.rows, // v0.9.493 — pipeline comercial
      by_vertical: byVerticalRes.rows,
      by_hour: byHourRes.rows,
      by_day: byDayRes.rows,
      response_time: responseTimeRes.rows[0] || { median_seconds: null, p90_seconds: null },
      abandonment: abandonmentRes.rows[0],
      top_assets: topAssetsRes.rows,
    });
  } catch (err) {
    console.error('❌ Error en /admin/stats/dashboard:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// =====================================================================
// WEB PUSH (PWA notifications)
// =====================================================================

const pushNotifier = require('./push-notifier');

/**
 * GET /api/push/vapid-public-key
 * Devuelve la clave pública VAPID para que el navegador pueda suscribirse.
 * NO requiere admin token (debe ser accesible desde el cliente).
 */
router.get('/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push no configurado' });
  res.json({ key });
});

/**
 * POST /api/push/subscribe
 * Registra una suscripción nueva del navegador.
 * Body: { endpoint, keys: { p256dh, auth } }
 */
router.post('/push/subscribe', requireTenantSession, async (req, res) => {
  // v0.9.19: cualquier usuario del tenant se suscribe; queda atada a SU org
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Suscripción incompleta' });
  }
  const tenantId = req.tenantId || 1; // super-admin → tenant 1
  try {
    try {
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, tenant_id, user_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             user_id = EXCLUDED.user_id,
             last_used_at = NOW()`,
        [endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null, tenantId, req.userId || null]
      );
    } catch (e1) {
      // Esquema viejo (sin tenant_id / índice viejo) → insert legacy
      await db.query(
        `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (endpoint) DO UPDATE
         SET p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             last_used_at = NOW()`,
        [endpoint, keys.p256dh, keys.auth, req.headers['user-agent'] || null]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/push/unsubscribe
 * Borra una suscripción.
 */
// v0.9.44 (auditoría C-3): auth moderna (antes: token admin global legacy)
// v0.9.67 (auditoría 12-jun): scoped por tenant — antes cualquier sesión podía
// borrar la suscripción de otra org conociendo el endpoint.
router.post('/push/unsubscribe', requireTenantSession, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'endpoint requerido' });
  if (req.isSuperAdmin) {
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
  } else {
    await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND tenant_id = $2', [endpoint, req.tenantId]);
  }
  res.json({ ok: true });
});

/**
 * POST /api/push/test
 * Envía una notificación de prueba a todos los dispositivos suscriptos.
 * Útil para verificar el setup.
 */
// v0.9.44 (auditoría C-3): auth moderna (antes: token admin global legacy)
// v0.9.67 (auditoría 12-jun): el test va SOLO a los dispositivos del propio tenant.
router.post('/push/test', requireTenantSession, async (req, res) => {
  if (!pushNotifier.isConfigured()) {
    return res.status(503).json({ error: 'Push no configurado en el servidor' });
  }
  const result = await pushNotifier.broadcast({
    title: '🔔 Test de SG Ventas',
    body: 'Las notificaciones push están funcionando.',
    url: '/panel/',
  }, req.tenantId || null);
  res.json({ ok: true, ...result });
});

// ============================================================
// v0.9.192 — Preferencias de NOTIFICACIÓN por rol (Config → 🔔 Notificaciones)
// Por evento: qué roles reciben el push + si va también por WhatsApp (al alert_phone).
// ============================================================
const notifPrefs = require('./notify-prefs');

// GET — devuelve prefs (merge con defaults) + metadata para armar la UI.
router.get('/admin/notification-prefs', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  try {
    const tenantId = req.tenantId || (req.isSuperAdmin ? 1 : null);
    const prefs = await notifPrefs.getNotifPrefs(tenantId);
    // v0.9.546 — 'sale_completed' (Venta realizada) SOLO se muestra si el modo Artículos está activo
    let _events = notifPrefs.EVENTS;
    try {
      const f = await db.query(`SELECT COALESCE(to_jsonb(tenants)->>'inventory_bot_enabled','false')::boolean AS inv FROM tenants WHERE id=$1`, [tenantId]);
      if (!(f.rows[0] && f.rows[0].inv)) _events = _events.filter(e => e !== 'sale_completed');
    } catch (e) { /* columna sin migrar → mostrar todo */ }
    res.json({ ok: true, prefs, events: _events, team_events: [...notifPrefs.TEAM_EVENTS], roles: notifPrefs.VALID_ROLES });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH — guarda prefs (solo el dueño define). Body: { prefs: {...} }
router.patch('/admin/notification-prefs', requireTenantSession, requireRole('owner'), async (req, res) => {
  try {
    const tenantId = req.tenantId || (req.isSuperAdmin ? 1 : null);
    if (!tenantId) return res.status(400).json({ ok: false, error: 'Sin tenant' });
    const clean = notifPrefs.sanitizePrefs(req.body && req.body.prefs);
    await db.query(
      `INSERT INTO notification_prefs (tenant_id, prefs, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = NOW()`,
      [tenantId, JSON.stringify(clean)]);
    res.json({ ok: true, prefs: clean });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================================
// SPRINT 3 — Panel Super-Admin
// Endpoints multi-tenant: gestión de tenants
// Agregado: 25-may-2026
// ============================================================
//
// Pegar este bloque ANTES de `module.exports = router;` al final de api.js
//
// Todos los endpoints usan el `requireAdminToken` ya existente en este archivo.
// Quedan bajo el prefijo `/api/admin` por el `app.use('/api', api)` de server.js.
//
// Endpoints expuestos:
//   GET    /api/admin/tenants                    → lista de tenants con stats
//   GET    /api/admin/tenants/:id                → detalle de tenant
//   PATCH  /api/admin/tenants/:id                → editar campos editables
//   GET    /api/admin/tenants/:id/conversations  → conversaciones paginadas 50/pág
// ============================================================

// Lista de tenants con stats agregadas (conversation count + last message)
// v0.9.111 — funnel del Embedded Signup de FB (super-admin). Sesiones que
// arrancaron y NO tienen tenant todavía (completitud derivada del número).
router.get('/admin/onboarding-attempts', requireAdminToken, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT f.session_id, f.stage, f.waba_id, f.phone_number_id, f.business_name,
              f.phone_display, f.coexistence, f.launched_at, f.updated_at,
              COALESCE(to_jsonb(f) ->> 'ip', NULL)          AS ip,
              COALESCE(to_jsonb(f) ->> 'user_agent', NULL)  AS user_agent,
              COALESCE(to_jsonb(f) ->> 'referrer', NULL)    AS referrer,
              COALESCE(to_jsonb(f) ->> 'lang', NULL)        AS lang,
              COALESCE(to_jsonb(f) ->> 'landing_url', NULL) AS landing_url,
              COALESCE(to_jsonb(f) ->> 'geo_country', NULL) AS geo_country,
              COALESCE(to_jsonb(f) ->> 'geo_city', NULL)    AS geo_city,
              COALESCE(to_jsonb(f) ->> 'geo_region', NULL)  AS geo_region,
              COALESCE(to_jsonb(f) ->> 'geo_isp', NULL)     AS geo_isp
         FROM onboarding_funnel f
        WHERE (f.phone_number_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM tenant_lines tl WHERE tl.meta_phone_number_id = f.phone_number_id
                 UNION SELECT 1 FROM tenants t WHERE t.meta_phone_number_id = f.phone_number_id
               ))
        ORDER BY f.updated_at DESC
        LIMIT 100`
    );
    res.json({ ok: true, attempts: r.rows, count: r.rows.length });
  } catch (e) {
    if (/onboarding_funnel/.test(e.message)) return res.json({ ok: true, attempts: [], count: 0, need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

router.get('/admin/tenants', requireAdminToken, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT
        t.id,
        t.slug,
        t.name,
        t.plan,
        t.active,
        t.billing_status,
        t.read_only,
        t.meta_phone_number_id,
        t.waba_id,
        t.meta_business_portfolio_id,
        t.meta_onboarding_completed_at,
        t.webhook_subscribed,
        t.created_at,
        t.meta_health,
        t.meta_health_at,
        COALESCE(c.conv_count, 0)::int AS conversations_count,
        c.last_message_at
      FROM tenants t
      LEFT JOIN (
        SELECT
          tenant_id,
          COUNT(*) AS conv_count,
          MAX(last_message_at) AS last_message_at
        FROM conversations
        GROUP BY tenant_id
      ) c ON c.tenant_id = t.id
      ORDER BY t.id ASC
    `);

    res.json({ ok: true, tenants: result.rows });
  } catch (err) {
    console.error('[admin/tenants] error:', err);
    res.status(500).json({ ok: false, error: 'internal_error', detail: err.message });
  }
});

// GET /api/admin/productivity — v0.9.539 (super-admin): productividad de Aitana por tenant en
// los últimos N días (default 7): leads CALIFICADOS generados (score>=70, misma regla que Reportes)
// y CITAS agendadas. Sirve para ver qué tenants están sacándole más jugo al bot.
// ?days=7 (1..90). Auth: X-Admin-Token.
router.get('/admin/productivity', requireAdminToken, async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (!Number.isFinite(days) || days < 1) days = 7;
    if (days > 90) days = 90;
    const interval = `${days} days`;
    const result = await db.query(`
      SELECT
        t.id, t.name, t.active, t.billing_status,
        COALESCE(l.leads_qualified, 0)::int   AS leads_qualified,
        COALESCE(a.appointments, 0)::int      AS appointments,
        COALESCE(cv.conversations_new, 0)::int AS conversations_new
      FROM tenants t
      LEFT JOIN (
        SELECT tenant_id, COUNT(*) AS leads_qualified
        FROM leads
        WHERE created_at > NOW() - $1::interval AND score >= 70
        GROUP BY tenant_id
      ) l ON l.tenant_id = t.id
      LEFT JOIN (
        SELECT tenant_id, COUNT(*) AS appointments
        FROM appointments
        WHERE created_at > NOW() - $1::interval
        GROUP BY tenant_id
      ) a ON a.tenant_id = t.id
      LEFT JOIN (
        SELECT tenant_id, COUNT(*) AS conversations_new
        FROM conversations
        WHERE created_at > NOW() - $1::interval
        GROUP BY tenant_id
      ) cv ON cv.tenant_id = t.id
      WHERE t.active = TRUE
      ORDER BY leads_qualified DESC, appointments DESC, conversations_new DESC, t.id ASC
    `, [interval]);
    const rows = result.rows;
    const totals = rows.reduce((acc, r) => {
      acc.leads_qualified += r.leads_qualified;
      acc.appointments += r.appointments;
      acc.conversations_new += r.conversations_new;
      return acc;
    }, { leads_qualified: 0, appointments: 0, conversations_new: 0 });
    res.json({ ok: true, days, generated_at: new Date().toISOString(), totals, tenants: rows });
  } catch (err) {
    console.error('[admin/productivity] error:', err);
    res.status(500).json({ ok: false, error: 'internal_error', detail: err.message });
  }
});

// ============================================================
// v0.9.559 — INTELIGENCIA DE NEGOCIOS (super-admin): resumen mensual
// teórico vs real vs costos + gestión de personal y costos manuales.
// ============================================================
router.get('/admin/bi/summary', requireAdminToken, async (req, res) => {
  try { res.json(await require('./biz-intel').summary(req.query.months, req.query.gran)); }
  catch (e) { console.error('[admin/bi] summary:', e); res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/admin/bi/conversion', requireAdminToken, async (req, res) => {
  try { res.json(await require('./biz-intel').conversion(req.query.days, req.query.tenant_id)); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/admin/bi/staff', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    const r = await db.query(`SELECT * FROM biz_staff ORDER BY (end_month IS NOT NULL), id`);
    res.json({ staff: r.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/admin/bi/staff', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    const { name, role, salary_bs, load_factor, start_month, notes } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name requerido' });
    if (!/^\d{4}-\d{2}$/.test(String(start_month || ''))) return res.status(400).json({ error: 'start_month YYYY-MM requerido' });
    const r = await db.query(
      `INSERT INTO biz_staff (name, role, salary_bs, load_factor, start_month, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [String(name).trim().slice(0, 80), String(role || '').slice(0, 60) || null, Number(salary_bs) || 0, Number(load_factor) || 1.30, start_month, String(notes || '').slice(0, 200) || null]);
    res.json({ ok: true, staff: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.put('/admin/bi/staff/:id', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: 'id inválido' });
    const b = req.body || {}; const sets = []; const params = []; let i = 1;
    for (const [k, cast] of [['name', String], ['role', String], ['salary_bs', Number], ['load_factor', Number], ['start_month', String], ['end_month', (v) => v === null ? null : String(v)], ['notes', String]]) {
      if (b[k] !== undefined) { sets.push(`${k} = $${i++}`); params.push(b[k] === null ? null : cast(b[k])); }
    }
    if (!sets.length) return res.status(400).json({ error: 'nada que actualizar' });
    params.push(id);
    const r = await db.query(`UPDATE biz_staff SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
    res.json({ ok: true, staff: r.rows[0] || null });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/admin/bi/staff/:id', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    await db.query(`DELETE FROM biz_staff WHERE id = $1`, [parseInt(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.get('/admin/bi/costs', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    const m = String(req.query.month || '');
    const r = /^\d{4}-\d{2}$/.test(m)
      ? await db.query(`SELECT * FROM biz_costs WHERE month = $1 ORDER BY id DESC`, [m])
      : await db.query(`SELECT * FROM biz_costs ORDER BY month DESC, id DESC LIMIT 200`);
    res.json({ costs: r.rows });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.post('/admin/bi/costs', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    const { month, category, concept, amount_bs, notes } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return res.status(400).json({ error: 'month YYYY-MM requerido' });
    const CATS = ['infra', 'marketing', 'personal_temporal', 'comisiones', 'ia_extra', 'otros'];
    if (!CATS.includes(String(category))) return res.status(400).json({ error: 'category inválida: ' + CATS.join('|') });
    const r = await db.query(`INSERT INTO biz_costs (month, category, concept, amount_bs, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [month, category, String(concept || '').slice(0, 120) || null, Number(amount_bs) || 0, String(notes || '').slice(0, 200) || null]);
    res.json({ ok: true, cost: r.rows[0] });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
router.delete('/admin/bi/costs/:id', requireAdminToken, async (req, res) => {
  try {
    await require('./biz-intel').ensureSchema();
    await db.query(`DELETE FROM biz_costs WHERE id = $1`, [parseInt(req.params.id) || 0]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Detalle de tenant (sin exponer access_token, solo si está configurado)
// v0.9.519 — ENTRAR COMO SOPORTE. El super-admin genera una sesión REAL del tenant
// (mismo JWT que usa el dueño) para entrar a su panel y resolver un problema, sin
// tener que crear un usuario de soporte en cada organización. La sesión:
//   · se marca support:true en el token (queda en la auditoría como soporte, no como
//     el dueño), y
//   · dura poco (2h) — no queda una sesión abierta para siempre.
// Gateado por requireAdminToken (solo super-admin). Es impersonación: por eso el TTL
// corto y la marca. El front la abre en app.sg-ventas.com/panel/?s=<token>.
router.post('/admin/tenants/:id/support-session', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
  try {
    const t = await db.query('SELECT id, slug, name, (to_jsonb(tenants) ->> \'fb_user_id\') AS fb_user_id FROM tenants WHERE id = $1', [id]);
    if (!t.rows[0]) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
    const { issueSession } = require('./auth');
    const token = issueSession(t.rows[0], null, { support: true });
    const base = _publicBase(); // app.sg-ventas.com
    console.log(`🛟 [support-session] super-admin entró como soporte al tenant ${id} (${t.rows[0].name})`);
    res.json({ ok: true, token, tenant_name: t.rows[0].name, panel_url: `${base}/panel/?s=${encodeURIComponent(token)}` });
  } catch (e) {
    console.error('❌ [support-session]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/admin/tenants/:id', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
  }

  try {
    const result = await db.query(`
      SELECT
        t.id,
        t.slug,
        t.name,
        t.plan,
        t.active,
        t.billing_status,
        to_char(t.trial_ends_at, 'YYYY-MM-DD') AS trial_ends_at, -- v0.9.529
        t.read_only,
        t.meta_phone_number_id,
        t.waba_id,
        t.meta_business_portfolio_id,
        t.meta_solution_id,
        t.meta_onboarding_completed_at,
        t.meta_access_token_expires_at,
        t.webhook_subscribed,
        COALESCE(t.support_enabled, false) AS support_enabled,
        (t.meta_token_enc IS NOT NULL) AS has_meta_access_token,
        t.created_at,
        t.meta_health,
        t.meta_health_at,
        COALESCE((to_jsonb(t) ->> 'c21_import_enabled')::boolean, false) AS c21_import_enabled,
        COALESCE((to_jsonb(t) ->> 'c21_agents_enabled')::boolean, false) AS c21_agents_enabled,
        COALESCE((to_jsonb(t) ->> 'snapshot_retention')::int, 6) AS snapshot_retention,
        COALESCE(c.conv_count, 0)::int AS conversations_count,
        c.last_message_at
      FROM tenants t
      LEFT JOIN (
        SELECT
          tenant_id,
          COUNT(*) AS conv_count,
          MAX(last_message_at) AS last_message_at
        FROM conversations
        WHERE tenant_id = $1
        GROUP BY tenant_id
      ) c ON c.tenant_id = t.id
      WHERE t.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'tenant_not_found' });
    }

    // v0.9.276 — HEALTH CHECK en vivo al abrir el detalle: validamos la línea contra Meta para mostrar
    // el estado REAL (🟢/🔴), no el falso "token configurado". Best-effort: si el chequeo falla, se
    // queda con el último valor guardado (t.meta_health de la propia fila).
    const _t = result.rows[0];
    try {
      const _h = await checkTenantMetaHealth(id);
      _t.meta_health = _h.status;
      _t.meta_health_at = new Date().toISOString();
      if (_h.verified_name) _t.meta_health_verified_name = _h.verified_name;
      if (_h.display_phone_number) _t.meta_health_display_phone = _h.display_phone_number;
    } catch (_) { /* deja el valor guardado */ }

    res.json({ ok: true, tenant: _t });
  } catch (err) {
    console.error('[admin/tenants/:id] error:', err);
    res.status(500).json({ ok: false, error: 'internal_error', detail: err.message });
  }
});

// PATCH: editar campos del tenant (validación estricta)
router.patch('/admin/tenants/:id', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
  }

  // v0.9.61: + fb_user_id — permite al super-admin vincular a mano la cuenta de
  // Facebook del dueño con su tenant cuando el auto-match del login no alcanza
  // (el fb_user_id real viene en el body del 403 NO_TENANT del login).
  const EDITABLE_FIELDS = new Set(['name', 'plan', 'active', 'billing_status', 'read_only', 'fb_user_id', 'snapshot_retention', 'trial_ends_at']); // v0.9.529 — trial_ends_at editable
  const VALID_PLANS = new Set(['free', 'basic', 'pro', 'enterprise', 'inicial', 'empresa']);
  const VALID_BILLING_STATUSES = new Set(['active', 'suspended', 'past_due', 'cancelled', 'trial']);

  const body = req.body || {};
  const updates = {};

  for (const [key, value] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;

    if (key === 'fb_user_id' && value !== null && !/^\d{5,25}$/.test(String(value))) {
      return res.status(400).json({ ok: false, error: 'invalid_fb_user_id', detail: 'numérico (5-25 dígitos) o null' });
    }
    if (key === 'plan' && !VALID_PLANS.has(value)) {
      return res.status(400).json({ ok: false, error: 'invalid_plan', detail: `Allowed: ${[...VALID_PLANS].join(', ')}` });
    }
    if (key === 'billing_status' && !VALID_BILLING_STATUSES.has(value)) {
      return res.status(400).json({ ok: false, error: 'invalid_billing_status', detail: `Allowed: ${[...VALID_BILLING_STATUSES].join(', ')}` });
    }
    if (key === 'active' && typeof value !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_active', detail: 'must be boolean' });
    }
    if (key === 'read_only' && typeof value !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'invalid_read_only', detail: 'must be boolean' });
    }
    if (key === 'name' && (typeof value !== 'string' || value.trim().length === 0)) {
      return res.status(400).json({ ok: false, error: 'invalid_name' });
    }
    if (key === 'snapshot_retention') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 50) {
        return res.status(400).json({ ok: false, error: 'invalid_snapshot_retention', detail: 'entero entre 1 y 50' });
      }
    }
    // v0.9.529 — fecha de fin del trial. null = trial indefinido (el cron trial→pago
    // lo ignora porque exige trial_ends_at IS NOT NULL). Una fecha futura extiende el trial.
    if (key === 'trial_ends_at') {
      if (value !== null && value !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        return res.status(400).json({ ok: false, error: 'invalid_trial_ends_at', detail: 'fecha YYYY-MM-DD o null' });
      }
    }

    updates[key] = (key === 'trial_ends_at' && value === '') ? null : value;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ ok: false, error: 'no_editable_fields_provided' });
  }

  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${i++}`);
    values.push(value);
  }
  values.push(id);

  // v0.9.268 — para el push de "cuenta activada": leer el billing_status ANTERIOR antes de actualizar.
  let _prevBillingStatus = null;
  if (updates.billing_status !== undefined) {
    try { const _pr = await db.query('SELECT billing_status FROM tenants WHERE id = $1', [id]); _prevBillingStatus = _pr.rows[0] && _pr.rows[0].billing_status; } catch (e) {}
  }

  try {
    const result = await db.query(`
      UPDATE tenants
      SET ${setClauses.join(', ')}
      WHERE id = $${i}
      RETURNING
        id, slug, name, plan, active, billing_status, read_only,
        meta_phone_number_id, waba_id, meta_business_portfolio_id,
        meta_onboarding_completed_at, webhook_subscribed, created_at, fb_user_id
    `, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'tenant_not_found' });
    }

    // Audit log best-effort (no bloquea si la tabla no existe)
    try {
      await db.query(`
        INSERT INTO audit_logs (tenant_id, action, details, created_at)
        VALUES ($1, $2, $3, NOW())
      `, [id, 'admin.tenant.update', JSON.stringify(updates)]);
    } catch (auditErr) {
      console.warn('[admin/tenants/:id] audit log failed (non-blocking):', auditErr.message);
    }

    // v0.9.268 — al pasar a ACTIVO (desde trial u otro estado): push recordatorio al DUEÑO de que
    // a fin de mes se cobra el plan fijo + el consumo de IA del mes, consultable en "Mi plan".
    if (updates.billing_status === 'active' && _prevBillingStatus !== 'active') {
      // v0.9.274 — al activar (a mano o por cron): fijar la fecha de corte si no la tiene → no cobrar desde
      // el alta (incluiría el trial). Y liberar el crédito de referido si la cuenta fue referida.
      try { await db.query(`UPDATE tenants SET billing_anchor_at = COALESCE(billing_anchor_at, NOW()) WHERE id = $1`, [id]); } catch (e) { console.warn('[activación] anchor:', e.message); }
      try { await db.query(`UPDATE referral_credits SET status = 'earned', earned_at = NOW() WHERE referred_tenant_id = $1 AND status = 'pending'`, [id]); } catch (e) {}
      // aviso factorizado en notifyTenantActivated (mismo que usa el cron trial→pago).
      notifyTenantActivated(id).catch(() => {});
    }

    res.json({ ok: true, tenant: result.rows[0], updated_fields: Object.keys(updates) });
  } catch (err) {
    console.error('[admin/tenants/:id PATCH] error:', err);
    res.status(500).json({ ok: false, error: 'internal_error', detail: err.message });
  }
});

// Conversaciones del tenant (paginado 50/pág, búsqueda opcional ?q=)
router.get('/admin/tenants/:id/conversations', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, error: 'invalid_tenant_id' });
  }

  const PAGE_SIZE = 50;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * PAGE_SIZE;
  const q = (req.query.q || '').trim();

  try {
    const tCheck = await db.query('SELECT id, slug, name FROM tenants WHERE id = $1', [id]);
    if (tCheck.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'tenant_not_found' });
    }

    let whereClause = 'WHERE tenant_id = $1';
    const params = [id];
    if (q) {
      whereClause += ` AND (phone ILIKE $2 OR COALESCE(contact_name, '') ILIKE $2)`;
      params.push(`%${q}%`);
    }

    const countResult = await db.query(
      `SELECT COUNT(*)::int AS total FROM conversations ${whereClause}`,
      params
    );
    const total = countResult.rows[0].total;

    const dataParams = [...params, PAGE_SIZE, offset];
    const dataResult = await db.query(`
      SELECT
        id,
        phone,
        contact_name,
        mode,
        vertical,
        status,
        campaign_ref,
        last_message_at,
        unread_count,
        created_at
      FROM conversations
      ${whereClause}
      ORDER BY last_message_at DESC NULLS LAST, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}
    `, dataParams);

    res.json({
      ok: true,
      tenant: tCheck.rows[0],
      conversations: dataResult.rows,
      pagination: {
        page,
        page_size: PAGE_SIZE,
        total,
        total_pages: Math.ceil(total / PAGE_SIZE),
        has_more: offset + dataResult.rows.length < total,
      },
    });
  } catch (err) {
    console.error('[admin/tenants/:id/conversations] error:', err);
    res.status(500).json({ ok: false, error: 'internal_error', detail: err.message });
  }
});

// ============================================================
// FIN SPRINT 3 — Panel Super-Admin
// ============================================================

// ============================================================
// v0.8.2 — Cal.com webhook + agenda admin endpoints
// ============================================================

/**
 * POST /api/calendar/calcom-webhook
 *
 * Recibe eventos de Cal.com cuando un cliente agenda, cancela o reprograma una demo.
 *
 * Cal.com firma el body con HMAC-SHA256 usando el secret que pusiste al crear
 * el webhook en Cal.com. Header: X-Cal-Signature-256.
 *
 * Eventos soportados:
 *   - BOOKING_CREATED       → INSERT appointment + notify owner
 *   - BOOKING_CANCELLED     → UPDATE status='cancelled' + notify
 *   - BOOKING_RESCHEDULED   → UPDATE starts_at/ends_at + notify
 *
 * Variable env requerida (single-tenant fallback):
 *   CALCOM_WEBHOOK_SECRET — el secret de Cal.com Settings → Developer → Webhooks
 *
 * Nota: usa req.rawBody que server.js ya captura globalmente vía verify hook
 * de express.json (mismo mecanismo que verifica firma de Meta webhook).
 *
 * Multi-tenant (futuro): leer tenants.calcom_webhook_secret. Hoy single-tenant tenant 1.
 */
router.post('/calendar/calcom-webhook', async (req, res) => {
  try {
    // 1. rawBody está disponible gracias al verify de express.json en server.js
    const rawBody = req.rawBody;
    if (!rawBody || typeof rawBody !== 'string') {
      console.error('❌ calcom-webhook: req.rawBody no está disponible');
      return res.status(400).json({ error: 'Missing raw body' });
    }

    // 2. Verificar firma HMAC
    const signature = req.headers['x-cal-signature-256'];
    const secret = process.env.CALCOM_WEBHOOK_SECRET;

    if (!secret) {
      console.error('❌ CALCOM_WEBHOOK_SECRET no configurado en env');
      return res.status(500).json({ error: 'Server not configured' });
    }

    if (!signature) {
      console.warn('⚠️  calcom-webhook sin firma — rechazando');
      return res.status(401).json({ error: 'Missing signature' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody, 'utf8')
      .digest('hex');

    // timing-safe comparison
    const sigBuf = Buffer.from(signature, 'utf8');
    const expBuf = Buffer.from(expectedSignature, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      console.warn('⚠️  calcom-webhook firma inválida — rechazando');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 3. Body ya parseado por express.json
    const event = req.body;
    if (!event || typeof event !== 'object') {
      console.error('❌ calcom-webhook: body no es objeto');
      return res.status(400).json({ error: 'Invalid body' });
    }

    const triggerEvent = event.triggerEvent || event.event;
    const payload = event.payload || {};

    console.log(`📅 Cal.com webhook recibido: ${triggerEvent}`);

    // Datos comunes del payload
    const externalId = String(payload.bookingId || payload.id || '');
    const externalUid = payload.uid || null;
    const startsAt = payload.startTime || payload.start || null;
    const endsAt = payload.endTime || payload.end || null;
    const meetUrl = payload.metadata?.videoCallUrl || payload.location || null;
    const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
    const primaryAttendee = attendees[0] || {};
    const attendeeName = primaryAttendee.name || payload.responses?.name?.value || 'Sin nombre';
    const attendeeEmail = primaryAttendee.email || payload.responses?.email?.value || null;
    const attendeePhone = payload.responses?.phone?.value || payload.responses?.smsReminderNumber?.value || null;
    const attendeeTimezone = primaryAttendee.timeZone || payload.attendees?.[0]?.timeZone || null;
    const eventTypeSlug = payload.eventType?.slug || payload.type || null;

    // tenant_id: single-tenant por ahora = 1. Multi-tenant futuro: lookup por eventType.userId
    const tenantId = 1;

    // 4. Intentar matchear con conversación existente (por phone)
    let conversationId = null;
    let leadId = null;
    if (attendeePhone) {
      const normPhone = attendeePhone.replace(/[^0-9]/g, '');
      const convRes = await db.query(
        `SELECT id, tenant_id FROM conversations 
         WHERE tenant_id = $1 
           AND REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', '') = $2
         ORDER BY updated_at DESC LIMIT 1`,
        [tenantId, normPhone]
      ).catch(() => ({ rows: [] }));
      if (convRes.rows.length > 0) {
        conversationId = convRes.rows[0].id;
        const leadRes = await db.query(
          `SELECT id FROM leads WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`,
          [conversationId]
        ).catch(() => ({ rows: [] }));
        leadId = leadRes.rows[0]?.id || null;
      }
    }

    // 5. Manejar según el evento
    if (triggerEvent === 'BOOKING_CREATED') {
      await db.query(
        `INSERT INTO appointments
          (tenant_id, conversation_id, lead_id, external_id, external_uid, provider,
           event_type_slug, attendee_name, attendee_email, attendee_phone, attendee_timezone,
           starts_at, ends_at, meet_url, status, raw_payload)
         VALUES ($1, $2, $3, $4, $5, 'calcom', $6, $7, $8, $9, $10, $11, $12, $13, 'scheduled', $14)
         ON CONFLICT (external_id) DO UPDATE SET
           starts_at = EXCLUDED.starts_at,
           ends_at = EXCLUDED.ends_at,
           meet_url = EXCLUDED.meet_url,
           status = 'scheduled',
           updated_at = NOW(),
           raw_payload = EXCLUDED.raw_payload`,
        [
          tenantId, conversationId, leadId, externalId, externalUid,
          eventTypeSlug, attendeeName, attendeeEmail, attendeePhone, attendeeTimezone,
          startsAt, endsAt, meetUrl, JSON.stringify(event),
        ]
      );

      console.log(`✅ Appointment creado: ${externalId} (${attendeeName})`);

      // Notificar al dueño con template específico
      await notifyOwnerOfAppointment({
        action: 'created',
        conversationId,
        attendeeName,
        attendeePhone,
        attendeeEmail,
        startsAt,
        meetUrl,
      }).catch(e => console.error('notifyOwner appointment_created falló:', e.message));

    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      await db.query(
        `UPDATE appointments
         SET status = 'cancelled',
             cancellation_reason = $1,
             updated_at = NOW(),
             raw_payload = $2
         WHERE external_id = $3`,
        [payload.cancellationReason || payload.responses?.cancelReason || null, JSON.stringify(event), externalId]
      );
      console.log(`🚫 Appointment cancelado: ${externalId}`);

      await notifyOwnerOfAppointment({
        action: 'cancelled',
        conversationId,
        attendeeName,
        attendeePhone,
        startsAt,
        cancellationReason: payload.cancellationReason || null,
      }).catch(e => console.error('notifyOwner appointment_cancelled falló:', e.message));

    } else if (triggerEvent === 'BOOKING_RESCHEDULED') {
      await db.query(
        `UPDATE appointments
         SET starts_at = $1,
             ends_at = $2,
             status = 'rescheduled',
             updated_at = NOW(),
             raw_payload = $3
         WHERE external_id = $4`,
        [startsAt, endsAt, JSON.stringify(event), externalId]
      );
      console.log(`🔄 Appointment reprogramado: ${externalId}`);

      await notifyOwnerOfAppointment({
        action: 'rescheduled',
        conversationId,
        attendeeName,
        attendeePhone,
        startsAt,
        meetUrl,
      }).catch(e => console.error('notifyOwner appointment_rescheduled falló:', e.message));

    } else {
      console.log(`ℹ️  calcom-webhook: evento no manejado ${triggerEvent}`);
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Error en calcom-webhook:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * Notifica al dueño cuando hay un appointment creado/cancelado/reprogramado.
 * Tiene su propio anti-spam (5 min) y templates específicos.
 */
async function notifyOwnerOfAppointment({ action, conversationId, attendeeName, attendeePhone, attendeeEmail, startsAt, meetUrl, cancellationReason }) {
  const ownerPhone = process.env.OWNER_PHONE;
  if (!ownerPhone) {
    console.log('ℹ️  OWNER_PHONE no configurado, no se envía notificación de appointment');
    return;
  }

  // Formatear fecha en GMT-4 (Bolivia)
  let formattedDate = '';
  try {
    const d = new Date(startsAt);
    formattedDate = d.toLocaleString('es-BO', {
      timeZone: 'America/La_Paz',
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
  } catch (e) {
    formattedDate = String(startsAt);
  }

  // v0.9.67 (auditoría 12-jun P1#7): el deep-link YA NO lleva el ADMIN_TOKEN.
  // Antes viajaba en texto plano por WhatsApp en cada demo (quedaba en el
  // historial del chat y en servidores de Meta). El dueño entra con su sesión
  // y el link ?conv= abre el chat (mismo patrón que notifyOwnerOfNewLead).
  const panelUrl = process.env.PANEL_BASE_URL || 'https://app.sg-ventas.com/panel/';
  const phoneSafe = attendeePhone ? attendeePhone.replace(/[^0-9]/g, '') : null;

  let text;
  if (action === 'created') {
    text = `📅 *Demo agendada*

Cliente: ${attendeeName}
${attendeeEmail ? `Email: ${attendeeEmail}\n` : ''}${attendeePhone ? `Teléfono: ${attendeePhone}\n` : ''}
🗓 ${formattedDate} (Bolivia)
${meetUrl ? `\n🔗 ${meetUrl}` : ''}
${phoneSafe ? `\nConversación: ${panelUrl}?conv=${phoneSafe}` : ''}`;
  } else if (action === 'cancelled') {
    text = `🚫 *Demo cancelada*

Cliente: ${attendeeName}
🗓 era para: ${formattedDate}
${cancellationReason ? `\nMotivo: ${cancellationReason}` : ''}
${phoneSafe ? `\nContactar: https://wa.me/${phoneSafe}` : ''}`;
  } else if (action === 'rescheduled') {
    text = `🔄 *Demo reprogramada*

Cliente: ${attendeeName}
🗓 nueva fecha: ${formattedDate} (Bolivia)
${meetUrl ? `\n🔗 ${meetUrl}` : ''}`;
  } else {
    return;
  }

  try {
    await meta.sendText(ownerPhone, text);
    console.log(`✅ Notificación de appointment (${action}) enviada al dueño`);
  } catch (e) {
    console.error(`❌ No se pudo notificar appointment ${action}:`, e.message);
  }
}

/**
 * GET /api/admin/appointments
 * Lista appointments con paginación. Para el panel super-admin.
 */
router.get('/admin/appointments', requireTenantSession, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const status = req.query.status || null;

    // v0.9.8: build WHERE con status opcional + tenant opcional
    const conds = [];
    const params = [];
    let idx = 1;
    if (status) { conds.push(`a.status = $${idx++}`); params.push(status); }
    if (!req.isSuperAdmin) { conds.push(`a.tenant_id = $${idx++}`); params.push(req.tenantId); }
    // v0.9.489 — alcance por línea del agente (mismo criterio que el inbox y los leads)
    {
      const _al = await getAgentLineIds(req);
      if (_al) {
        const _ids = _al.map(n => parseInt(n, 10)).filter(Number.isFinite);
        conds.push(_ids.length
          ? `(c.id IS NULL OR c.line_id IS NULL OR c.line_id IN (${_ids.join(',')}))`
          : `(c.id IS NULL OR c.line_id IS NULL)`);
      }
    }
    // v0.9.489 — filtro explícito por línea (selector del panel)
    if (/^\d+$/.test(String(req.query.line_id == null ? '' : req.query.line_id))) {
      conds.push(`c.line_id = ${parseInt(req.query.line_id, 10)}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(limit); const limitParamIdx = `$${idx++}`;
    params.push(offset); const offsetParamIdx = `$${idx++}`;

    const result = await db.query(
      `SELECT a.*, c.contact_name, c.phone as conv_phone
       FROM appointments a
       LEFT JOIN conversations c ON c.id = a.conversation_id
       ${where}
       ORDER BY a.starts_at DESC
       LIMIT ${limitParamIdx} OFFSET ${offsetParamIdx}`,
      params
    );

    res.json({ appointments: result.rows, limit, offset });
  } catch (err) {
    console.error('❌ Error en /admin/appointments:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * GET /api/admin/conversations/:id/appointments
 * Lista appointments asociados a una conversación. Para mostrar en el panel.
 */
router.get('/admin/conversations/:id/appointments', requireTenantSession, async (req, res) => {
  try {
    const convId = parseInt(req.params.id, 10);
    if (Number.isNaN(convId)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }
    const tf = tenantFilter(req, 2);
    const result = await db.query(
      `SELECT * FROM appointments
       WHERE conversation_id = $1${tf.clause}
       ORDER BY starts_at DESC`,
      [convId, ...tf.params]
    );
    res.json({ appointments: result.rows });
  } catch (err) {
    console.error('❌ Error en /admin/conversations/:id/appointments:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// ============================================================
// FIN v0.8.2 — Cal.com webhook
// ============================================================

// ============================================================
// v0.9.0 — Archivar conversaciones
// ============================================================

/**
 * POST /api/admin/conversations/:phone/archive
 * Archiva manualmente una conversación (la oculta de la vista principal).
 * No borra nada: setea status='archived' + archived_at=NOW().
 */
router.post('/admin/conversations/:phone/archive', requireTenantSession, async (req, res) => {
  try {
    const { phone } = req.params;
    const tf = tenantFilter(req, 2);
    const result = await db.query(
      `UPDATE conversations
         SET status = 'archived', archived_at = NOW(), updated_at = NOW()
       WHERE id = (SELECT id FROM conversations WHERE ${(/^id:(\d+)$/.exec(phone)) ? 'id' : 'phone'} = $1${tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1)
       RETURNING phone, status, archived_at`,
      [(/^id:(\d+)$/.exec(phone)) ? parseInt(phone.slice(3), 10) : phone, ...tf.params]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    res.json({ ok: true, conversation: result.rows[0] });
  } catch (err) {
    console.error('❌ Error en /archive:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * POST /api/admin/conversations/:phone/unarchive
 * Desarchiva manualmente: vuelve a status='open'.
 */
router.post('/admin/conversations/:phone/unarchive', requireTenantSession, async (req, res) => {
  try {
    const { phone } = req.params;
    const tf = tenantFilter(req, 2);
    const result = await db.query(
      `UPDATE conversations
         SET status = 'open', archived_at = NULL, updated_at = NOW()
       WHERE id = (SELECT id FROM conversations WHERE ${(/^id:(\d+)$/.exec(phone)) ? 'id' : 'phone'} = $1${tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1)
       RETURNING phone, status, archived_at`,
      [(/^id:(\d+)$/.exec(phone)) ? parseInt(phone.slice(3), 10) : phone, ...tf.params]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }
    res.json({ ok: true, conversation: result.rows[0] });
  } catch (err) {
    console.error('❌ Error en /unarchive:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/**
 * POST /api/admin/conversations/auto-archive
 * Auto-archiva conversaciones 'open' sin actividad por más de N días (default 3).
 * Pensado para que n8n lo llame 1x al día (cron). Acepta token admin O secreto n8n.
 * Body opcional: { days: 3 }
 * NO archiva conversaciones en mode='human' (alguien las está atendiendo activamente).
 */
// v0.9.44 (auditoría C-4): auth moderna + days acotado + interval type-safe.
// Sigue siendo global (cron de n8n archiva TODOS los tenants — comportamiento buscado),
// pero ya no con el token legacy de query string.
router.post('/admin/conversations/auto-archive', requireTenantSession, async (req, res) => {
  try {
    let days = parseInt(req.body?.days, 10) || 3;
    if (!Number.isFinite(days) || days < 1) days = 1;
    if (days > 90) days = 90;
    // Cliente (JWT): solo archiva SU tenant. Super-admin: todos.
    const tf = tenantFilter(req, 2, 'tenant_id');
    const result = await db.query(
      `UPDATE conversations
         SET status = 'archived', archived_at = NOW(), updated_at = NOW()
       WHERE status = 'open'
         AND mode = 'bot'
         AND last_message_at < NOW() - ($1 * INTERVAL '1 day')${tf.clause}
       RETURNING phone`,
      [days, ...tf.params]
    );
    console.log(`🗄️  Auto-archivado: ${result.rows.length} conversaciones inactivas > ${days} días`);
    res.json({ ok: true, archived_count: result.rows.length, days });
  } catch (err) {
    console.error('❌ Error en /auto-archive:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// ============================================================
// v0.9.5 — Tasks / recordatorios
// ============================================================

/**
 * GET /api/admin/tasks?filter=today|overdue|upcoming|done|all|pending
 */
router.get('/admin/tasks', requireTenantSession, async (req, res) => {
  try {
    const filter = req.query.filter || 'pending';
    // v0.9.8: tenant de la sesión. Super-admin ve todos (sin filtro de tenant).
    const isSA = req.isSuperAdmin;
    const params = [];
    const conds = [];
    if (!isSA) { params.push(req.tenantId); conds.push(`t.tenant_id = $${params.length}`); }

    // v0.9.43: alcance por rol — el AGENTE solo ve su bandeja (tareas asignadas
    // a él o creadas por él). Owner/supervisor ven todas las de la org.
    // Lecturas vía to_jsonb → tolerante si la migración v0.9.43 no corrió aún.
    if (req.userRole === 'agent' && req.userId) {
      params.push(req.userId);
      conds.push(`((to_jsonb(t) ->> 'assigned_to')::int = $${params.length} OR (to_jsonb(t) ->> 'created_by')::int = $${params.length})`);
    }

    // v0.9.43: filtro de asignación — me | unassigned | <userId> | (vacío = todas)
    const assignee = String(req.query.assignee || '').trim();
    if (assignee === 'me' && req.userId) {
      params.push(req.userId);
      conds.push(`(to_jsonb(t) ->> 'assigned_to')::int = $${params.length}`);
    } else if (assignee === 'unassigned') {
      conds.push(`(to_jsonb(t) ->> 'assigned_to') IS NULL`);
    } else if (/^\d+$/.test(assignee)) {
      params.push(parseInt(assignee));
      conds.push(`(to_jsonb(t) ->> 'assigned_to')::int = $${params.length}`);
    }

    let order = 't.due_at ASC NULLS LAST';
    if (filter === 'today') {
      // v0.9.337: "Hoy" incluye las ATRASADAS — es lo urgente y antes quedaba invisible
      // (el badge rojo del rail marcaba tareas que la vista default no mostraba).
      conds.push(`t.status IN ('pending','in_progress') AND t.due_at < (NOW()::date + INTERVAL '1 day')`);
    } else if (filter === 'overdue') {
      conds.push(`t.status IN ('pending','in_progress') AND t.due_at < NOW()`);
    } else if (filter === 'upcoming') {
      conds.push(`t.status IN ('pending','in_progress') AND (t.due_at >= NOW() OR t.due_at IS NULL)`);
    } else if (filter === 'done') {
      conds.push(`t.status = 'done'`);
      order = 't.completed_at DESC NULLS LAST';
    } else if (filter === 'board') {
      // v0.9.43: Kanban/Gantt — activas + completadas de los últimos 14 días
      conds.push(`(t.status IN ('pending','in_progress') OR (t.status = 'done' AND t.completed_at >= NOW() - INTERVAL '14 days'))`);
      order = `CASE t.status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, t.due_at ASC NULLS LAST`;
    } else if (filter === 'all') {
      order = "CASE t.status WHEN 'in_progress' THEN 0 WHEN 'pending' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END, t.due_at ASC NULLS LAST";
    } else { // 'pending' (default): todo lo activo
      conds.push(`t.status IN ('pending','in_progress')`);
    }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const result = await db.query(`
      SELECT
        t.*,
        (to_jsonb(t) ->> 'assigned_to')::int AS assigned_to,
        (to_jsonb(t) ->> 'created_by')::int  AS created_by,
        to_jsonb(t) ->> 'start_at'           AS start_at,
        au.display_name AS assignee_name,
        cu.display_name AS creator_name,
        c.phone AS conversation_phone,
        c.contact_name AS conversation_contact,
        c.current_score AS conversation_score,
        l.name AS lead_name,
        l.vertical AS lead_vertical
      FROM tasks t
      LEFT JOIN tenant_users au ON au.id = (to_jsonb(t) ->> 'assigned_to')::int
      LEFT JOIN tenant_users cu ON cu.id = (to_jsonb(t) ->> 'created_by')::int
      LEFT JOIN conversations c ON c.id = t.conversation_id
      LEFT JOIN leads l ON l.id = t.lead_id
      ${where}
      ORDER BY ${order}
      LIMIT 300
    `, params);

    res.json({ tasks: result.rows, filter, your_user_id: req.userId || null, your_role: req.userRole || null });
  } catch (err) {
    console.error('❌ Error en GET /admin/tasks:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/** GET /api/admin/tasks/counts → para badge en el header */
router.get('/admin/tasks/counts', requireTenantSession, async (req, res) => {
  try {
    const tf = tenantFilter(req, 1);
    // v0.9.43: "mine" = bandeja personal (asignadas a mí, activas) para el badge 📥
    const uidIdx = tf.params.length + 1;
    const r = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_at < NOW())::int AS overdue,
        COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_at >= NOW()::date AND due_at < (NOW()::date + INTERVAL '1 day'))::int AS today,
        COUNT(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS total_pending,
        COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND (to_jsonb(tasks) ->> 'assigned_to')::int = $${uidIdx})::int AS mine
      FROM tasks WHERE 1=1${tf.clause}
    `, [...tf.params, req.userId || 0]);
    res.json({ ...r.rows[0], your_user_id: req.userId || null, your_role: req.userRole || null });
  } catch (err) {
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/** GET /api/admin/conversations/:phone/tasks → para sección dentro del modal */
router.get('/admin/conversations/:phone/tasks', requireTenantSession, async (req, res) => {
  try {
    const _tf = tenantFilter(req, 2, 'tenant_id');
    const _idMk = /^id:(\d+)$/.exec(req.params.phone); // v0.9.466
    const conv = await db.query(`SELECT id FROM conversations WHERE ${_idMk ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk ? parseInt(_idMk[1], 10) : req.params.phone, ..._tf.params]);
    if (conv.rows.length === 0) return res.json({ tasks: [] });
    // v0.9.44 (auditoría F4): mismo alcance por rol que GET /admin/tasks —
    // el agente solo ve tareas asignadas a él o creadas por él.
    const tParams = [conv.rows[0].id];
    let agentCond = '';
    if (req.userRole === 'agent' && req.userId) {
      tParams.push(req.userId);
      agentCond = ` AND ((to_jsonb(tasks) ->> 'assigned_to')::int = $2 OR (to_jsonb(tasks) ->> 'created_by')::int = $2)`;
    }
    const result = await db.query(`
      SELECT * FROM tasks
       WHERE conversation_id = $1${agentCond}
       ORDER BY
         CASE status WHEN 'pending' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END,
         due_at ASC
       LIMIT 50
    `, tParams);
    res.json({ tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/** POST /api/admin/tasks → crear tarea (v0.9.43: + assigned_to, start_at; due_at opcional) */
router.post('/admin/tasks', requireTenantSession, async (req, res) => {
  try {
    const { title, description, due_at, start_at, task_type, priority, conversation_phone, lead_id } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: 'title es requerido' });
    }
    // v0.9.8: el tenant dueño de la tarea. Super-admin debe especificar o cae a 1.
    const ownerTenant = req.isSuperAdmin ? (Number(req.body.tenant_id) || 1) : req.tenantId;

    // v0.9.43: asignación. El AGENTE solo puede asignarse a sí mismo; owner y
    // supervisor asignan a cualquiera de la org (se valida pertenencia).
    let assignedTo = (req.body.assigned_to != null && String(req.body.assigned_to).trim() !== '')
      ? parseInt(req.body.assigned_to) : null;
    if (req.userRole === 'agent') assignedTo = req.userId || null;
    if (assignedTo && !req.isSuperAdmin) {
      const chk = await db.query('SELECT id FROM tenant_users WHERE id = $1 AND tenant_id = $2 AND active = TRUE', [assignedTo, ownerTenant]);
      if (!chk.rows[0]) return res.status(400).json({ error: 'El usuario asignado no pertenece a la organización' });
    }

    let conversationId = null;
    if (conversation_phone) {
      const _tf = req.isSuperAdmin ? { clause: '', params: [] } : { clause: ' AND tenant_id = $2', params: [ownerTenant] };
      const _idMk2 = /^id:(\d+)$/.exec(String(conversation_phone || '')); // v0.9.466
      const conv = await db.query(`SELECT id FROM conversations WHERE ${_idMk2 ? 'id' : 'phone'} = $1${_tf.clause} ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [_idMk2 ? parseInt(_idMk2[1], 10) : conversation_phone, ..._tf.params]);
      if (conv.rows[0]) conversationId = conv.rows[0].id;
    }
    const result = await db.query(`
      INSERT INTO tasks (tenant_id, conversation_id, lead_id, title, description, due_at, start_at, task_type, priority, auto_created, assigned_to, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $11)
      RETURNING *
    `, [
      ownerTenant,
      conversationId,
      lead_id || null,
      String(title).trim(),
      description?.trim() || null,
      due_at || null,
      start_at || null,
      task_type || 'other',
      priority || 'normal',
      assignedTo,
      req.userId || null,
    ]);
    res.json({ ok: true, task: result.rows[0] });
  } catch (err) {
    if (/assigned_to|created_by|start_at/.test(err.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.43 (deploy-latest.sh)' });
    console.error('❌ Error en POST /admin/tasks:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/** PATCH /api/admin/tasks/:id → action: complete | snooze | cancel | edit | status | assign
 * v0.9.43: status (kanban: pending|in_progress|done|cancelled), assign (owner/supervisor),
 * edit acepta assigned_to y start_at. El AGENTE solo modifica tareas suyas. */
router.patch('/admin/tasks/:id', requireTenantSession, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, snooze_minutes, title, description, due_at, priority, task_type } = req.body;
    let q, params;

    // v0.9.8: fragmento de tenant que se anexa al WHERE id=$1. El tenant va
    // como ÚLTIMO parámetro de cada variante (índice = params.length+1).
    const tagTenant = (baseParams) => {
      if (req.isSuperAdmin) return { frag: '', params: baseParams };
      return { frag: ` AND tenant_id = $${baseParams.length + 1}`, params: [...baseParams, req.tenantId] };
    };
    // v0.9.43: el agente solo toca lo suyo (asignada a él o creada por él)
    const tagAgent = (t) => {
      if (req.userRole !== 'agent' || !req.userId) return t;
      const idx = t.params.length + 1;
      return { frag: t.frag + ` AND (assigned_to = $${idx} OR created_by = $${idx})`, params: [...t.params, req.userId] };
    };

    // v0.9.43: validar usuario asignado (pertenece a la org y está activo)
    const validateAssignee = async (val) => {
      const at = (val === null || String(val).trim() === '') ? null : parseInt(val);
      if (at && !req.isSuperAdmin) {
        const chk = await db.query('SELECT id FROM tenant_users WHERE id = $1 AND tenant_id = $2 AND active = TRUE', [at, req.tenantId]);
        if (!chk.rows[0]) throw Object.assign(new Error('El usuario asignado no pertenece a la organización'), { statusCode: 400 });
      }
      return at;
    };

    if (action === 'complete') {
      const t = tagAgent(tagTenant([id]));
      q = `UPDATE tasks SET status='done', completed_at=NOW(), updated_at=NOW() WHERE id=$1${t.frag} RETURNING *`;
      params = t.params;
    } else if (action === 'cancel') {
      const t = tagAgent(tagTenant([id]));
      q = `UPDATE tasks SET status='cancelled', updated_at=NOW() WHERE id=$1${t.frag} RETURNING *`;
      params = t.params;
    } else if (action === 'status') {
      // v0.9.43: drag & drop del kanban
      const st = String(req.body.status || '').trim();
      if (!['pending', 'in_progress', 'done', 'cancelled'].includes(st)) {
        return res.status(400).json({ error: 'status inválido (pending|in_progress|done|cancelled)' });
      }
      const t = tagAgent(tagTenant([id, st]));
      q = `UPDATE tasks
             SET status = $2::text,
                 completed_at = CASE WHEN $2::text = 'done' THEN NOW() ELSE NULL END,
                 updated_at = NOW()
           WHERE id = $1${t.frag} RETURNING *`;
      params = t.params;
    } else if (action === 'assign') {
      // v0.9.43/v0.9.55: reasignar — según permiso tasks_assign (default owner/supervisor)
      if (!req.isSuperAdmin && !(await roleHasPerm(req.tenantId, req.userRole, 'tasks_assign'))) {
        return res.status(403).json({ error: 'No tenés permiso para reasignar tareas' });
      }
      const at = await validateAssignee(req.body.assigned_to ?? null);
      const t = tagTenant([id, at]);
      q = `UPDATE tasks SET assigned_to = $2, updated_at = NOW() WHERE id = $1${t.frag} RETURNING *`;
      params = t.params;
    } else if (action === 'snooze') {
      const mins = parseInt(snooze_minutes, 10) || 60;
      const t = tagAgent(tagTenant([id, String(mins)]));
      q = `UPDATE tasks
             SET due_at = COALESCE(due_at, NOW()) + ($2 || ' minutes')::interval,
                 status = CASE WHEN status = 'done' THEN 'pending' ELSE status END,
                 notified_push = false,
                 updated_at = NOW()
           WHERE id = $1${t.frag} RETURNING *`;
      params = t.params;
    } else if (action === 'edit') {
      // v0.9.43: SETs dinámicos — permite limpiar fechas ('' → NULL) y reasignar
      const sets = ['updated_at = NOW()'];
      const ps = [id];
      const add = (frag, val) => { ps.push(val); sets.push(frag.replace('?', `$${ps.length}`)); };
      if (title !== undefined && String(title).trim()) add('title = ?', String(title).trim());
      if (description !== undefined) add('description = ?', String(description || '').trim() || null);
      if (due_at !== undefined) { add('due_at = ?', due_at || null); sets.push('notified_push = false'); }
      if (req.body.start_at !== undefined) add('start_at = ?', req.body.start_at || null);
      if (priority !== undefined && priority) add('priority = ?', priority);
      if (task_type !== undefined && task_type) add('task_type = ?', task_type);
      if (req.body.assigned_to !== undefined && (req.isSuperAdmin || await roleHasPerm(req.tenantId, req.userRole, 'tasks_assign'))) {
        add('assigned_to = ?', await validateAssignee(req.body.assigned_to));
      }
      if (sets.length === 1) return res.status(400).json({ error: 'Nada para actualizar' });
      let frag = '';
      if (!req.isSuperAdmin) { ps.push(req.tenantId); frag += ` AND tenant_id = $${ps.length}`; }
      if (req.userRole === 'agent' && req.userId) { ps.push(req.userId); frag += ` AND (assigned_to = $${ps.length} OR created_by = $${ps.length})`; }
      q = `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1${frag} RETURNING *`;
      params = ps;
    } else {
      return res.status(400).json({ error: 'action requerida (complete|snooze|cancel|edit|status|assign)' });
    }
    const result = await db.query(q, params);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Task no encontrada (o sin permiso sobre ella)' });
    res.json({ ok: true, task: result.rows[0] });
  } catch (err) {
    if (err.statusCode === 400) return res.status(400).json({ error: err.message });
    if (/assigned_to|created_by|start_at/.test(err.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.43 (deploy-latest.sh)' });
    console.error('❌ Error en PATCH /admin/tasks/:id:', err);
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

/** DELETE /api/admin/tasks/:id */
router.delete('/admin/tasks/:id', requireTenantSession, async (req, res) => {
  try {
    const tf = tenantFilter(req, 2);
    const params = [req.params.id, ...tf.params];
    let frag = tf.clause;
    // v0.9.72 (auditoría): el agente solo borra LO SUYO (asignada o creada por
    // él) — el resto de acciones ya lo restringían, el DELETE quedó afuera.
    if (req.userRole === 'agent' && req.userId) {
      params.push(req.userId);
      frag += ` AND (assigned_to = $${params.length} OR created_by = $${params.length})`;
    }
    const r = await db.query(`DELETE FROM tasks WHERE id = $1${frag} RETURNING id`, params);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Task no encontrada (o sin permiso sobre ella)' });
    res.json({ ok: true });
  } catch (err) {
    if (/assigned_to|created_by/.test(err.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.43' });
    res.status(500).json({ error: 'Internal error', detail: err.message });
  }
});

// =====================================================================
// v0.9.21 — INVENTARIO (catálogo de artículos por organización)
// Gestión: owner/supervisor. Consulta/envío: todos los roles.
// =====================================================================

function invTenant(req) {
  return req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
}

// =====================================================================
// v0.9.55 — PERMISOS GRANULARES POR ROL
// =====================================================================
// Capacidades delegables y su default (= comportamiento histórico).
// owner siempre tiene TODO; estos defaults aplican a supervisor/agent.
// v0.9.194 — Catálogo de permisos. Dos grupos:
//  · SECCIONES (nav_*): qué pantallas ve el rol (gobierna la visibilidad del panel).
//  · ACCIONES: qué puede hacer (lo enforce requirePerm en los endpoints).
// El permiso efectivo de un usuario = override de usuario › override de rol › default.
const PERMISSIONS = {
  // ── Secciones / navegación ──
  nav_inbox:        { label: 'Ver Inbox / Conversaciones', default: ['owner', 'supervisor', 'agent'], group: 'Secciones' }, // v0.9.474 — apagar = usuario "solo visualización" sin acceso a chats
  nav_leads:        { label: 'Ver Leads',                 default: ['owner', 'supervisor', 'agent'], group: 'Secciones' },
  nav_reservations: { label: 'Ver Reservas',              default: ['owner', 'supervisor', 'agent'], group: 'Secciones' },
  nav_pending:      { label: 'Ver Citas por tomar',       default: ['owner', 'supervisor', 'agent'], group: 'Secciones' },
  nav_tasks:        { label: 'Ver Tareas',                default: ['owner', 'supervisor', 'agent'], group: 'Secciones' },
  nav_campaigns:    { label: 'Ver Campañas',              default: ['owner', 'supervisor'],          group: 'Secciones' },
  nav_followups:    { label: 'Ver Follow-ups',            default: ['owner', 'supervisor'],          group: 'Secciones' },
  nav_reports:      { label: 'Ver Reportes / Analytics',  default: ['owner', 'supervisor'],          group: 'Secciones' },
  nav_config:       { label: 'Ver Configuración de Aitana', default: ['owner', 'supervisor'],        group: 'Secciones' },
  // ── Acciones ──
  catalog:       { label: 'Gestionar catálogos (productos, inmuebles, servicios)', default: ['owner', 'supervisor'], group: 'Acciones' },
  assets:        { label: 'Gestionar assets multimedia',                            default: ['owner', 'supervisor'], group: 'Acciones' },
  campaigns:     { label: 'Crear y enviar campañas / plantillas',                   default: ['owner', 'supervisor'], group: 'Acciones' },
  optout:        { label: 'Editar la lista de exclusión',                           default: ['owner', 'supervisor'], group: 'Acciones' },
  export:        { label: 'Exportar conversaciones',                                default: ['owner', 'supervisor'], group: 'Acciones' },
  reset_context: { label: 'Resetear el contexto de Aitana',                         default: ['owner', 'supervisor'], group: 'Acciones' },
  tasks_assign:  { label: 'Asignar tareas a otros del equipo',                      default: ['owner', 'supervisor'], group: 'Acciones' },
  support_handle:{ label: 'Mesa de soporte: tomar y resolver tickets',              default: ['owner', 'supervisor', 'agent'], group: 'Acciones' },
  support_assign:{ label: 'Mesa de soporte: asignar / transferir tickets de otros', default: ['owner', 'supervisor'], group: 'Acciones' },
};
const ROLES_EDITABLE = ['supervisor', 'agent']; // owner no se edita (siempre todo)

// Cache de overrides por tenant (TTL corto; se invalida al guardar)
const _permCache = new Map();
const PERM_TTL = 30000;
async function getTenantPermOverrides(tenantId) {
  const c = _permCache.get(tenantId);
  if (c && (Date.now() - c.at) < PERM_TTL) return c.map;
  const map = {};
  try {
    const r = await db.query('SELECT role, permission, allowed FROM role_permissions WHERE tenant_id = $1', [tenantId]);
    for (const row of r.rows) { map[`${row.role}:${row.permission}`] = row.allowed; }
  } catch (e) { /* tabla no migrada → solo defaults */ }
  _permCache.set(tenantId, { at: Date.now(), map });
  return map;
}
function invalidatePermCache(tenantId) { _permCache.delete(tenantId); }

// v0.9.194 — overrides POR USUARIO (ganan al rol). Cache aparte.
const _userPermCache = new Map();
async function getUserPermOverrides(tenantId, userId) {
  if (!userId) return {};
  const key = `${tenantId}:${userId}`;
  const c = _userPermCache.get(key);
  if (c && (Date.now() - c.at) < PERM_TTL) return c.map;
  const map = {};
  try {
    const r = await db.query('SELECT permission, allowed FROM user_permissions WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    for (const row of r.rows) map[row.permission] = row.allowed;
  } catch (e) { /* tabla no migrada → sin overrides */ }
  _userPermCache.set(key, { at: Date.now(), map });
  return map;
}
function invalidateUserPermCache(tenantId, userId) {
  if (userId) { _userPermCache.delete(`${tenantId}:${userId}`); return; }
  for (const k of [..._userPermCache.keys()]) if (k.startsWith(`${tenantId}:`)) _userPermCache.delete(k);
}

// Permiso efectivo de un USUARIO: override de usuario › override de rol › default. Owner = todo.
async function userHasPerm(tenantId, userId, role, permKey) {
  if (role === 'owner' || role === 'superadmin') return true;
  if (!PERMISSIONS[permKey]) return false;
  const uo = await getUserPermOverrides(tenantId, userId);
  if (permKey in uo) return uo[permKey];
  return roleHasPerm(tenantId, role, permKey);
}

// ¿este rol tiene el permiso? (override del tenant gana al default)
async function roleHasPerm(tenantId, role, permKey) {
  if (role === 'owner' || role === 'superadmin') return true;
  const def = PERMISSIONS[permKey];
  if (!def) return false;
  const ov = await getTenantPermOverrides(tenantId);
  const k = `${role}:${permKey}`;
  if (k in ov) return ov[k];
  return def.default.includes(role);
}

// Middleware: exige un permiso. Super-admin pasa. Owner pasa. El resto según matriz.
function requirePerm(permKey) {
  return async (req, res, next) => {
    try {
      if (req.isSuperAdmin || req.userRole === 'owner') return next();
      const tenantId = req.tenantId;
      if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
      if (await userHasPerm(tenantId, req.userId, req.userRole, permKey)) return next();
      return res.status(403).json({ error: 'No tenés permisos para esta acción', code: 'FORBIDDEN_PERM', permission: permKey, your_role: req.userRole || null });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  };
}

/** GET /api/admin/role-permissions — matriz efectiva del tenant (owner/supervisor la ven). */
router.get('/admin/role-permissions', requireTenantSession, async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const ov = await getTenantPermOverrides(tenantId);
    const matrix = {};
    for (const role of ROLES_EDITABLE) {
      matrix[role] = {};
      for (const [key, def] of Object.entries(PERMISSIONS)) {
        const k = `${role}:${key}`;
        matrix[role][key] = (k in ov) ? ov[k] : def.default.includes(role);
      }
    }
    res.json({
      ok: true,
      permissions: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.label])),
      groups: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.group || 'Acciones'])),
      roles: ROLES_EDITABLE,
      matrix,
      your_role: req.userRole || null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/my-permissions — permisos EFECTIVOS del usuario logueado (gatea el panel). */
router.get('/admin/my-permissions', requireTenantSession, async (req, res) => {
  try {
    const tenantId = req.tenantId || (req.isSuperAdmin ? 1 : null);
    const role = req.isSuperAdmin ? 'owner' : (req.userRole || 'owner');
    const perms = {};
    for (const key of Object.keys(PERMISSIONS)) {
      perms[key] = (role === 'owner' || role === 'superadmin') ? true : await userHasPerm(tenantId, req.userId, role, key);
    }
    // v0.9.300 — overrides de visibilidad del tenant (setea el super-admin). Viajan para
    // TODOS los roles, incluido owner, para que el panel pueda ocultar aun al Dueño.
    let overrides = null;
    try {
      const _ov = await db.query('SELECT ui_overrides FROM tenants WHERE id = $1', [tenantId]);
      overrides = (_ov.rows[0] && _ov.rows[0].ui_overrides) || null;
    } catch (_e) { /* columna sin migrar → sin overrides */ }
    res.json({ ok: true, role, perms, overrides });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** GET /api/admin/tenants/:id/ui-overrides — overrides de visibilidad del panel (SOLO super-admin). */
router.get('/admin/tenants/:id/ui-overrides', requireTenantSession, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'solo super-admin' });
  try {
    const r = await db.query('SELECT ui_overrides FROM tenants WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'tenant no encontrado' });
    res.json({ ok: true, overrides: r.rows[0].ui_overrides || {} });
  } catch (e) {
    if (/ui_overrides/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.300 (ui_overrides)' });
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/admin/tenants/:id/ui-overrides — setear overrides (SOLO super-admin, modelo solo-ocultar). */
router.patch('/admin/tenants/:id/ui-overrides', requireTenantSession, async (req, res) => {
  if (!req.isSuperAdmin) return res.status(403).json({ error: 'solo super-admin' });
  const body = (req.body && typeof req.body.overrides === 'object' && req.body.overrides) ? req.body.overrides : null;
  if (!body) return res.status(400).json({ error: 'overrides (objeto) requerido' });
  // Modelo "solo ocultar": persistimos únicamente las claves con valor === false; el resto se descarta.
  const clean = {};
  for (const k of Object.keys(body)) { if (body[k] === false) clean[k] = false; }
  try {
    const r = await db.query('UPDATE tenants SET ui_overrides = $1 WHERE id = $2 RETURNING id', [JSON.stringify(clean), req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'tenant no encontrado' });
    res.json({ ok: true, overrides: clean });
  } catch (e) {
    if (/ui_overrides/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.300 (ui_overrides)' });
    res.status(500).json({ error: e.message });
  }
});

/** GET /api/admin/user-permissions — usuarios del equipo (≠owner) con rol, overrides y permisos efectivos. */
router.get('/admin/user-permissions', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const u = await db.query(`SELECT id, display_name, email, role FROM tenant_users WHERE tenant_id = $1 AND role <> 'owner' AND NOT COALESCE((to_jsonb(tenant_users) ->> 'hidden_from_tenant')::boolean, FALSE) ORDER BY role, display_name`, [tenantId]);
    const out = [];
    for (const row of u.rows) {
      const ov = await getUserPermOverrides(tenantId, row.id);
      const eff = {};
      for (const key of Object.keys(PERMISSIONS)) eff[key] = await userHasPerm(tenantId, row.id, row.role, key);
      out.push({ id: row.id, name: row.display_name || row.email, role: row.role, overrides: ov, effective: eff });
    }
    res.json({
      ok: true, users: out,
      permissions: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.label])),
      groups: Object.fromEntries(Object.entries(PERMISSIONS).map(([k, v]) => [k, v.group || 'Acciones'])),
    });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

/** PUT /api/admin/user-permissions — override por usuario. Solo OWNER. Body: { user_id, permission, allowed|null }. */
router.put('/admin/user-permissions', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const userId = parseInt(req.body && req.body.user_id, 10);
  const { permission, allowed } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'user_id requerido' });
  if (!PERMISSIONS[permission]) return res.status(400).json({ error: 'permiso inválido' });
  try {
    const ur = await db.query('SELECT role FROM tenant_users WHERE id=$1 AND tenant_id=$2', [userId, tenantId]);
    if (!ur.rows[0]) return res.status(404).json({ error: 'usuario no encontrado' });
    if (ur.rows[0].role === 'owner') return res.status(400).json({ error: 'el dueño tiene todos los permisos (no se edita)' });
    if (allowed === null || allowed === undefined || allowed === 'null') {
      await db.query('DELETE FROM user_permissions WHERE tenant_id=$1 AND user_id=$2 AND permission=$3', [tenantId, userId, permission]);
    } else {
      const on = allowed === true || allowed === 'true';
      await db.query(
        `INSERT INTO user_permissions (tenant_id, user_id, permission, allowed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, user_id, permission) DO UPDATE SET allowed=EXCLUDED.allowed, updated_at=NOW()`,
        [tenantId, userId, permission, on]);
    }
    invalidateUserPermCache(tenantId, userId);
    res.json({ ok: true });
  } catch (e) {
    if (/user_permissions/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.194 (user_permissions)' });
    res.status(500).json({ error: e.message });
  }
});

/** PUT /api/admin/role-permissions — guarda overrides. Solo OWNER. Body: { role, permission, allowed }. */
router.put('/admin/role-permissions', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const { role, permission, allowed } = req.body || {};
  if (!ROLES_EDITABLE.includes(role)) return res.status(400).json({ error: 'rol inválido (supervisor|agent)' });
  if (!PERMISSIONS[permission]) return res.status(400).json({ error: 'permiso inválido' });
  const on = allowed === true || allowed === 'true';
  try {
    // Si el valor coincide con el default, borramos el override (matriz limpia)
    const isDefault = PERMISSIONS[permission].default.includes(role) === on;
    if (isDefault) {
      await db.query('DELETE FROM role_permissions WHERE tenant_id=$1 AND role=$2 AND permission=$3', [tenantId, role, permission]);
    } else {
      await db.query(
        `INSERT INTO role_permissions (tenant_id, role, permission, allowed) VALUES ($1,$2,$3,$4)
         ON CONFLICT (tenant_id, role, permission) DO UPDATE SET allowed=EXCLUDED.allowed, updated_at=NOW()`,
        [tenantId, role, permission, on]
      );
    }
    invalidatePermCache(tenantId);
    res.json({ ok: true });
  } catch (e) {
    if (/role_permissions/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.55' });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.42: subir PDFs (catálogo/ficha técnica) de un producto a R2.
// Devuelve [{url, name}] para anexar a file_urls. (Espejo de _uploadPropertyDocs.)
// ── v0.9.87 · separación física por modo de venta ───────────────────────
// Cada modo escribe/lee en SU tabla y sube assets a SU prefijo R2. El panel
// indica el modo con ?mode= ; sin él = modo base → 100% compatible con lo previo.
const CATALOG_MODES = {
  servicios:    { table: 'services',             prefix: 'services',     docs: 'services/docs' },
  salud:        { table: 'catalog_salud',        prefix: 'salud',        docs: 'salud/docs' },
  belleza:      { table: 'catalog_belleza',      prefix: 'belleza',      docs: 'belleza/docs' },
  arquitectura: { table: 'catalog_arquitectura', prefix: 'arquitectura', docs: 'arquitectura/docs' }, // v0.9.452
  articulos:    { table: 'inventory_items',      prefix: 'inventory',    docs: 'inventory/docs' },
  restaurante:  { table: 'catalog_restaurante',  prefix: 'restaurante',  docs: 'restaurante/docs' },
  vehiculos:    { table: 'catalog_vehiculos',    prefix: 'vehiculos',    docs: 'vehiculos/docs' }, // v0.9.452
};
// catalogo service-shaped: servicios | salud | belleza | arquitectura (default servicios)
function svcCat(req) {
  const m = req && req.query && req.query.mode;
  return (m === 'salud' || m === 'belleza' || m === 'arquitectura') ? CATALOG_MODES[m] : CATALOG_MODES.servicios;
}
// catalogo inventory-shaped: articulos | restaurante | vehiculos (default articulos)
function invCat(req) {
  const m = req && req.query && req.query.mode;
  return (m === 'restaurante' || m === 'vehiculos') ? CATALOG_MODES[m] : CATALOG_MODES.articulos;
}
// v0.9.87 bot-side: tabla por el modo ACTIVO del tenant (no por query)
async function botCatalogTable(tenantId, shape) {
  let mode = 'software';
  try { const r = await db.query('SELECT active_prompt_mode FROM tenants WHERE id = $1', [tenantId]); mode = (r.rows[0] && r.rows[0].active_prompt_mode) || 'software'; } catch (e) {}
  if (shape === 'service') return mode === 'salud' ? 'catalog_salud' : mode === 'belleza' ? 'catalog_belleza' : mode === 'arquitectura' ? 'catalog_arquitectura' : 'services'; // v0.9.452: + arquitectura
  return mode === 'restaurante' ? 'catalog_restaurante' : mode === 'vehiculos' ? 'catalog_vehiculos' : 'inventory_items'; // v0.9.452: + vehiculos
}
// ──────────────────────────────────────────────
async function _uploadInventoryDocs(files, prefix) {
  const out = [];
  for (const file of files || []) {
    const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: prefix || 'inventory/docs', filename: file.originalname });
    out.push({ url: up.url, name: file.originalname || 'documento.pdf' });
  }
  return out;
}

// v0.9.42: ficha de producto — nombre, marca/categoría, precio, características y descripción.
// NUNCA incluye stock (Aitana no revela cantidades).
function _inventoryCaption(it) {
  const priceLine = (it.price != null) ? `💵 ${it.currency || 'Bs'} ${Number(it.price).toLocaleString('es-BO')}` : null;
  const feats = String(it.features || '').split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8);
  const featsBlock = feats.length ? feats.map(f => `• ${f.replace(/^[-•*]\s*/, '')}`).join('\n') : null;
  // v0.9.400 — ficha de VEHÍCULO si el ítem tiene campos de auto; si no, ficha de producto genérica.
  const isVehicle = !!(it.model || it.body_type || it.model_year || it.fuel || it.transmission || (it.km != null && it.km !== ''));
  if (isVehicle) {
    const titleBits = [it.brand, it.model].filter(Boolean).join(' ') || it.name;
    const cond = it.condition ? (/usad/i.test(it.condition) ? 'Usado' : (/0\s*km|nuevo/i.test(it.condition) ? '0km' : it.condition)) : null;
    const specBits = [
      it.body_type,
      cond,
      (it.km != null && String(it.km).trim() !== '') ? `${Number(it.km).toLocaleString('es-BO')} km` : null,
      it.transmission,
      it.fuel,
    ].filter(Boolean).join(' · ');
    return [
      `🚗 *${titleBits}${it.model_year ? ' ' + it.model_year : ''}*${it.version ? ` — ${it.version}` : ''}`,
      specBits ? `📋 ${specBits}` : null,
      priceLine,
      featsBlock,
      it.description ? `\n${it.description}` : null,
    ].filter(Boolean).join('\n');
  }
  const metaLine = [it.brand, it.category].filter(Boolean).join(' · ');
  return [
    `📦 *${it.name}*${metaLine ? ` — ${metaLine}` : ''}`,
    priceLine,
    featsBlock,
    it.description ? `\n${it.description}` : null,
  ].filter(Boolean).join('\n');
}

// v0.9.400 — parsea los campos de vehículo del body (Concesionaria). Todos opcionales; NULL si no vienen.
// Devuelve specs ya como STRING JSON (para $::jsonb) o null.
function _parseVehicleFields(body) {
  body = body || {};
  const s = (k) => { const v = String(body[k] == null ? '' : body[k]).trim(); return v || null; };
  const n = (k) => { const v = String(body[k] == null ? '' : body[k]).trim(); return (v !== '' && !isNaN(Number(v))) ? parseInt(v, 10) : null; };
  let specs = null;
  try { if (body.specs && String(body.specs).trim()) specs = (typeof body.specs === 'string') ? JSON.stringify(JSON.parse(body.specs)) : JSON.stringify(body.specs); } catch (e) { specs = null; }
  return {
    model: s('model'), model_year: n('model_year'), km: n('km'),
    body_type: s('body_type'), fuel: s('fuel'), transmission: s('transmission'),
    condition: s('condition'), version: s('version'), specs,
  };
}

/** GET /api/admin/inventory — lista artículos. ?all=1 incluye inactivos. ?q= busca. */
router.get('/admin/inventory', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const all = req.query.all === '1';
    const q = String(req.query.q || '').trim();
    const params = [tenantId];
    let where = 'tenant_id = $1';
    if (!all) where += ' AND active = TRUE';
    if (q) { params.push(`%${q}%`); where += ` AND (name ILIKE $${params.length} OR code ILIKE $${params.length})`; }
    // v0.9.42: columnas nuevas leídas vía to_jsonb → tolerante si la migración
    // todavía no corrió (devuelven NULL/default en vez de romper el SELECT).
    const r = await db.query(
      `SELECT id, code, name, stock, description, image_url, price, currency, active, updated_at,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'image_urls',   '[]'::jsonb) AS image_urls,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'image_labels', '{}'::jsonb) AS image_labels,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'file_urls',    '[]'::jsonb) AS file_urls,
              to_jsonb(${invCat(req).table}) ->> 'brand'    AS brand,
              to_jsonb(${invCat(req).table}) ->> 'category' AS category,
              to_jsonb(${invCat(req).table}) ->> 'subcategory' AS subcategory,
              to_jsonb(${invCat(req).table}) ->> 'features' AS features,
              to_jsonb(${invCat(req).table}) ->> 'model'        AS model,
              (to_jsonb(${invCat(req).table}) ->> 'model_year')::int AS model_year,
              (to_jsonb(${invCat(req).table}) ->> 'km')::int         AS km,
              to_jsonb(${invCat(req).table}) ->> 'body_type'    AS body_type,
              to_jsonb(${invCat(req).table}) ->> 'fuel'         AS fuel,
              to_jsonb(${invCat(req).table}) ->> 'transmission' AS transmission,
              to_jsonb(${invCat(req).table}) ->> 'condition'    AS condition,
              to_jsonb(${invCat(req).table}) ->> 'version'      AS version,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'specs', 'null'::jsonb) AS specs
       FROM ${invCat(req).table} WHERE ${where} ORDER BY active DESC, LOWER(name) ASC LIMIT 500`,
      params
    );
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    if (/inventory_items/.test(e.message)) return res.json({ ok: true, items: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.453 — IMPORTADOR DE CATÁLOGOS PDF (IA) para catálogos inventory-shaped.
// Paso 1: POST /admin/inventory/parse-catalog (multipart 'pdf') → pdf-parse + Gemini
//         extraen los artículos con categoría/subcategoría → preview (NO escribe nada).
// Paso 2: POST /admin/inventory/import-items {items, dry_run} → UPSERT por código en la
//         tabla del modo (?mode= vía invCat). No pisa price/stock existentes con null.
// =====================================================================
router.post('/admin/inventory/parse-catalog', requireTenantSession, requirePerm('catalog'), upload.single('pdf'), async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'IA no configurada (falta GEMINI_API_KEY)' });
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'PDF requerido (campo "pdf")' });
  try {
    let text = '';
    try {
      const pdfParse = require('pdf-parse/lib/pdf-parse.js');
      const pd = await pdfParse(req.file.buffer);
      text = String(pd.text || '').replace(/[ \t]+/g, ' ').trim();
    } catch (e) { return res.status(400).json({ error: 'No se pudo leer el PDF: ' + e.message }); }
    if (text.length < 80) return res.status(400).json({ error: 'El PDF no tiene texto extraíble (puede ser escaneado). Probá con el PDF original del catálogo.' });

    // Chunks de ~22k chars con solape (catálogos largos) — Gemini devuelve un array por chunk y se mergea por nombre.
    const CH = 22000, OV = 600;
    const chunks = [];
    for (let i = 0; i < text.length; i += (CH - OV)) { chunks.push(text.slice(i, i + CH)); if (chunks.length >= 8) break; }

    const axios = require('axios');
    const gUrl = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    const sysPrompt = 'Sos un extractor de catálogos comerciales para un CRM en Bolivia. Te doy el TEXTO de un catálogo de productos (puede ser un fragmento). Extraé CADA producto/modelo como un objeto. Agrupá por MODELO (no repitas un modelo por cada talla/medida/color: las medidas, tallas y colores van como líneas dentro de "features"). Respondé SOLO un array JSON válido, sin markdown: [{"code": "SKU o código del catálogo, o null", "name": "nombre comercial del producto", "brand": "marca o null", "category": "categoría general (ej: Colchones, Ropa de cama, Calzados)", "subcategory": "línea o sub-familia (ej: Línea Espuma, Cubrecamas) o null", "description": "2-4 frases de venta en español boliviano, fieles al catálogo, sin inventar", "features": "características UNA por línea separadas con \\n (sensación, materiales, medidas/tallas disponibles, colores, garantía)", "price": numero o null si el catálogo no trae precio, "currency": "Bs" | "USD" | null}]. NO inventes precios ni datos que no estén en el texto. Si un dato no está, usá null.';

    const seen = new Map();
    let chunksOk = 0;
    for (const ck of chunks) {
      try {
        const gr = await axios.post(gUrl, {
          contents: [{ parts: [{ text: `TEXTO DEL CATÁLOGO:\n${ck}\n\nJSON:` }] }],
          systemInstruction: { parts: [{ text: sysPrompt }] },
          generationConfig: { temperature: 0, maxOutputTokens: 8000, thinkingConfig: { thinkingBudget: 0 } },
        }, { timeout: 90000, headers: { 'Content-Type': 'application/json' } });
        const raw = (((((gr.data || {}).candidates || [])[0] || {}).content || {}).parts || [{}])[0].text || '';
        let arr = [];
        try { arr = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch (e) { const m = raw.match(/\[[\s\S]*\]/); if (m) { try { arr = JSON.parse(m[0]); } catch (e2) {} } }
        if (!Array.isArray(arr)) continue;
        chunksOk++;
        for (const it of arr) {
          if (!it || !String(it.name || '').trim()) continue;
          const key = String(it.name).trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
          const prev = seen.get(key);
          if (!prev) seen.set(key, it);
          else { // merge: el que tenga más datos gana campo a campo
            for (const f of ['code', 'brand', 'category', 'subcategory', 'description', 'features', 'price', 'currency']) {
              if ((prev[f] == null || prev[f] === '') && it[f] != null && it[f] !== '') prev[f] = it[f];
            }
          }
        }
      } catch (e) { /* chunk fallido → seguimos con el resto */ }
    }
    if (!chunksOk) return res.status(502).json({ error: 'La IA no pudo estructurar el catálogo. Reintentá en unos segundos.' });

    const slug = (s) => String(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const items = Array.from(seen.values()).map((it) => ({
      code: String(it.code || '').trim() || slug(it.name),
      name: String(it.name).trim().slice(0, 200),
      brand: it.brand ? String(it.brand).trim() : null,
      category: it.category ? String(it.category).trim() : null,
      subcategory: it.subcategory ? String(it.subcategory).trim() : null,
      description: it.description ? String(it.description).trim() : null,
      features: it.features ? String(it.features).trim() : null,
      price: (it.price != null && !isNaN(Number(it.price)) && Number(it.price) > 0) ? Number(it.price) : null,
      currency: (it.currency === 'USD') ? 'USD' : 'Bs',
    })).slice(0, 300);
    res.json({ ok: true, items, chunks: chunks.length, chunks_ok: chunksOk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/inventory/import-items', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const items = Array.isArray(req.body && req.body.items) ? req.body.items : [];
  const dryRun = !!(req.body && req.body.dry_run);
  if (!items.length) return res.status(400).json({ error: 'items requerido (array)' });
  if (items.length > 500) return res.status(400).json({ error: 'Máximo 500 ítems por corrida' });
  const table = invCat(req).table;
  try {
    const ex = await db.query(`SELECT LOWER(code) AS code FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    const existing = new Set(ex.rows.map((r) => r.code));
    let inserted = 0, updated = 0, invalid = 0;
    const errors = [];
    for (const raw of items) {
      const code = String((raw && raw.code) || '').trim();
      const name = String((raw && raw.name) || '').trim();
      if (!code || !name) { invalid++; continue; }
      const vals = {
        description: raw.description ? String(raw.description).trim() : null,
        brand: raw.brand ? String(raw.brand).trim() : null,
        category: raw.category ? String(raw.category).trim() : null,
        subcategory: raw.subcategory ? String(raw.subcategory).trim() : null,
        features: raw.features ? String(raw.features).trim() : null,
        price: (raw.price != null && !isNaN(Number(raw.price))) ? Number(raw.price) : null,
        currency: (raw.currency === 'USD') ? 'USD' : 'Bs',
        stock: Number.isFinite(parseInt(raw.stock)) ? parseInt(raw.stock) : 100,
      };
      try {
        if (existing.has(code.toLowerCase())) {
          if (!dryRun) await db.query(
            `UPDATE ${table} SET name=$1, description=$2, brand=$3, category=$4, subcategory=$5, features=$6,
                    price=COALESCE($7, price), currency=$8, active=TRUE, updated_at=NOW()
             WHERE tenant_id=$9 AND LOWER(code)=LOWER($10)`,
            [name, vals.description, vals.brand, vals.category, vals.subcategory, vals.features, vals.price, vals.currency, tenantId, code]);
          updated++;
        } else {
          if (!dryRun) await db.query(
            `INSERT INTO ${table} (tenant_id, code, name, stock, description, brand, category, subcategory, features, price, currency, active, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE,$12)`,
            [tenantId, code, name, vals.stock, vals.description, vals.brand, vals.category, vals.subcategory, vals.features, vals.price, vals.currency, req.userId || null]);
          existing.add(code.toLowerCase());
          inserted++;
        }
      } catch (e) { errors.push({ code, error: e.message }); }
    }
    res.json({ ok: true, dry_run: dryRun, inserted, updated, invalid, error_count: errors.length, errors: errors.slice(0, 5) });
  } catch (e) {
    if (/subcategory/.test(e.message)) return res.status(503).json({ error: 'Falta deployar v0.9.453 (columna subcategory)' });
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/admin/inventory — crear con fotos etiquetadas (hasta 20) + PDFs (hasta 5). owner/supervisor. */
// v0.9.42: mismo patrón que inmuebles. Acepta también el campo legacy 'image'
// (single) por si un panel viejo cacheado sigue mandándolo.
// =====================================================================
// v0.9.328 — SINCRONIZAR CATÁLOGO DE WHATSAPP COMMERCE → inventory_items (modo Artículos).
// Trae los productos del catálogo del negocio (Graph) y los upsertea por `code` (retailer_id).
// Requiere el permiso catalog_management en el token del tenant.
// =====================================================================
function _catParseMoney(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^0-9.,]/g, '').replace(/,/g, ''));
  return isFinite(n) ? n : null;
}
function _catCurrency(priceStr, currencyField) {
  if (currencyField && String(currencyField).trim()) return String(currencyField).trim().toUpperCase().slice(0, 6);
  const m = String(priceStr || '').match(/[A-Z]{3}/);
  if (m) return m[0];
  if (/\$/.test(String(priceStr || ''))) return 'USD';
  return 'USD';
}

router.get('/admin/catalog/wa-status', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'sin tenant' });
  try {
    const t = await db.query('SELECT wa_catalog_id, wa_catalog_synced_at, meta_token_enc, waba_id FROM tenants WHERE id = $1', [tenantId]);
    const row = t.rows[0] || {};
    let discovered = [];
    if (row.meta_token_enc && row.waba_id) {
      try {
        const token = decryptSafe(row.meta_token_enc);
        const r = await meta.getWabaCatalogs(row.waba_id, token);
        if (r.success) discovered = (r.catalogs || []).map((c) => ({ id: c.id, name: c.name, count: c.product_count }));
      } catch (e) { /* descubrimiento best-effort */ }
    }
    res.json({ ok: true, catalog_id: row.wa_catalog_id || '', synced_at: row.wa_catalog_synced_at || null, has_token: !!row.meta_token_enc, discovered });
  } catch (e) {
    if (/wa_catalog_id/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.328 (catálogo WhatsApp)' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/catalog/wa-sync', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = _kbTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'sin tenant' });
  try {
    const t = await db.query('SELECT wa_catalog_id, meta_token_enc, waba_id FROM tenants WHERE id = $1', [tenantId]);
    const row = t.rows[0] || {};
    if (!row.meta_token_enc) return res.status(400).json({ ok: false, error: 'Este negocio no tiene un token de Meta configurado. Conectá WhatsApp primero.' });
    const token = decryptSafe(row.meta_token_enc);
    let catalogId = (req.body && String(req.body.catalog_id || '').trim()) || row.wa_catalog_id || '';
    if (!catalogId && row.waba_id) {
      const d = await meta.getWabaCatalogs(row.waba_id, token);
      if (d.success && d.catalogs.length) catalogId = String(d.catalogs[0].id);
    }
    if (!catalogId) return res.status(400).json({ ok: false, error: 'No encontré un catálogo de WhatsApp. Pegá el ID del catálogo (Commerce Manager) o conectalo a tu número.' });
    const pr = await meta.getCatalogProducts(catalogId, token);
    if (!pr.success) {
      const perm = /permission|catalog_management|OAuth|#10\b|#200\b|#100\b/i.test(String(pr.error));
      return res.status(502).json({ ok: false, error: perm
        ? 'Meta rechazó el acceso al catálogo: falta el permiso catalog_management en el token (App Review) o el catálogo no está compartido con la app.'
        : ('No se pudo leer el catálogo: ' + pr.error) });
    }
    let created = 0, updated = 0, skipped = 0;
    for (const p of pr.products) {
      const code = String(p.retailer_id || p.id || '').trim().slice(0, 120);
      const name = String(p.name || '').trim().slice(0, 300);
      if (!code || !name) { skipped++; continue; }
      const price = _catParseMoney(p.price);
      const currency = _catCurrency(p.price, p.currency);
      const desc = p.description ? String(p.description).slice(0, 2000) : null;
      const brand = p.brand ? String(p.brand).slice(0, 120) : null;
      const category = (p.product_type || p.category) ? String(p.product_type || p.category).slice(0, 120) : null;
      const active = String(p.availability || 'in stock').toLowerCase().indexOf('out') === -1;
      const img0 = p.image_url ? String(p.image_url) : null;
      const imgsJson = img0 ? JSON.stringify([img0]) : null;
      try {
        const up = await db.query(
          `UPDATE inventory_items SET name=$1, description=$2, price=$3, currency=$4, brand=$5, category=$6, active=$7,
                  image_url = COALESCE($8, image_url), image_urls = COALESCE($9::jsonb, image_urls)
            WHERE tenant_id=$10 AND code=$11`,
          [name, desc, price, currency, brand, category, active, img0, imgsJson, tenantId, code]);
        if (up.rowCount > 0) { updated++; continue; }
        await db.query(
          `INSERT INTO inventory_items (tenant_id, code, name, stock, description, image_url, image_urls, image_labels, file_urls, brand, category, price, currency, active)
           VALUES ($1,$2,$3,100,$4,$5,$6::jsonb,'{}'::jsonb,'[]'::jsonb,$7,$8,$9,$10,$11)`,
          [tenantId, code, name, desc, img0, (imgsJson || '[]'), brand, category, price, currency, active]);
        created++;
      } catch (e) { skipped++; }
    }
    await db.query(`UPDATE tenants SET wa_catalog_id = $1, wa_catalog_synced_at = NOW() WHERE id = $2`, [catalogId, tenantId]).catch(() => {});
    res.json({ ok: true, catalog_id: catalogId, total: pr.products.length, created, updated, skipped });
  } catch (e) {
    if (/wa_catalog_id/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.328 (catálogo WhatsApp)' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.9.410 — IMPORTAR VEHÍCULO DESDE FICHA TÉCNICA PDF (formato Nissan "Esto es Nissan").
// Parsea las specs (modelo/motor/potencia/torque/transmisión/tracción/combustible/plazas → features)
// y extrae la foto hero si el PDF trae JPEG (los JPEG2000 caen a carga manual). NO crea el ítem:
// devuelve un BORRADOR que el panel usa para pre-llenar el form de alta; el usuario pone el PRECIO
// (los PDF no lo traen) y confirma con "Crear artículo".
router.post('/admin/inventory/parse-pdf', requireTenantSession, requirePerm('catalog'), upload.single('pdf'), async (req, res) => {
  if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'PDF requerido (campo "pdf")' });
  try {
    let text = '';
    try {
      const pdfParse = require('pdf-parse/lib/pdf-parse.js'); // lib directa: evita el wrapper "debug" del index
      const data = await pdfParse(req.file.buffer);
      text = data.text || '';
    } catch (e) {
      return res.status(422).json({ error: 'No se pudo leer el PDF: ' + e.message });
    }
    const draft = vehiclePdfImport.parseNissanText(text);
    if (!draft.model) return res.status(422).json({ error: 'No parece una ficha técnica Nissan (no encontré el modelo). Podés cargar el vehículo a mano.' });
    // código sugerido (el usuario puede cambiarlo)
    draft.code = 'NIS-' + String(draft.model).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + (draft.model_year || new Date().getFullYear());
    // hero JPEG → R2 (JPEG2000 → null → carga manual)
    let image_url = null, image_note = null;
    const hero = vehiclePdfImport.extractHeroJpeg(req.file.buffer);
    if (hero && r2 && r2.isConfigured && r2.isConfigured()) {
      try {
        const up = await r2.upload({ buffer: hero, mimeType: 'image/jpeg', prefix: invCat(req).prefix, filename: String(draft.model || 'vehiculo').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-ficha.jpg' });
        image_url = up.url;
      } catch (e) { image_note = 'Extraje la foto pero no se pudo subir; agregá la hero a mano.'; }
    } else if (!hero) {
      image_note = 'La foto de este PDF viene en un formato que no se puede extraer automáticamente. Agregá la hero a mano.';
    }
    res.json({ ok: true, draft, image_url, image_note, matched: draft._matched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/inventory', requireTenantSession, requirePerm('catalog'), upload.fields([{ name: 'images', maxCount: 20 }, { name: 'docs', maxCount: 5 }, { name: 'image', maxCount: 1 }]), metaMediaGuard, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const code = String(req.body.code || '').trim();
  const name = String(req.body.name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  const stock = parseInt(req.body.stock);
  const price = (req.body.price !== undefined && String(req.body.price).trim() !== '') ? Number(req.body.price) : null;
  const currency = String(req.body.currency || 'Bs').trim() || 'Bs';
  const brand = String(req.body.brand || '').trim() || null;
  const category = String(req.body.category || '').trim() || null;
  const subcategory = String(req.body.subcategory || '').trim() || null; // v0.9.453
  const features = String(req.body.features || '').trim() || null;
  // v0.9.400 — campos de vehículo (Concesionaria). Todos opcionales; NULL en los otros rubros.
  const _v = _parseVehicleFields(req.body);
  if (!code || !name) return res.status(400).json({ error: 'code y name requeridos' });
  if (price !== null && (isNaN(price) || price < 0)) return res.status(400).json({ error: 'precio inválido' });
  try {
    const imgFiles = ((req.files && req.files.images) || []).concat((req.files && req.files.image) || []);
    const docFiles = (req.files && req.files.docs) || [];
    // etiquetas de las fotos nuevas, en el MISMO orden que los archivos
    let labelsNew = [];
    try { labelsNew = JSON.parse(req.body.image_labels_new || '[]'); } catch (e) {}
    if (!Array.isArray(labelsNew)) labelsNew = [];
    const labelsMap = {};
    const urls = [];
    if (String(req.body.image_url || '').trim()) urls.push(String(req.body.image_url).trim()); // compat: URL directa
    let docs = [];
    if (imgFiles.length || docFiles.length) {
      if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
      for (let fi = 0; fi < imgFiles.length; fi++) {
        const file = imgFiles[fi];
        const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: invCat(req).prefix, filename: file.originalname });
        urls.push(up.url);
        const lbl = String(labelsNew[fi] || '').trim();
        if (lbl) labelsMap[up.url] = lbl;
      }
      docs = await _uploadInventoryDocs(docFiles, invCat(req).docs);
    }
    const ins = await db.query(
      `INSERT INTO ${invCat(req).table} (tenant_id, code, name, stock, description, image_url, image_urls, image_labels, file_urls, brand, category, subcategory, features, price, currency, created_by, model, model_year, km, body_type, fuel, transmission, condition, version, specs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb)
       RETURNING *`,
      [tenantId, code, name, Number.isFinite(stock) ? stock : 100, description, urls[0] || null,
       JSON.stringify(urls), JSON.stringify(labelsMap), JSON.stringify(docs), brand, category, subcategory, features, price, currency, req.userId || null,
       _v.model, _v.model_year, _v.km, _v.body_type, _v.fuel, _v.transmission, _v.condition, _v.version, _v.specs]
    );
    res.status(201).json({ ok: true, item: ins.rows[0] });
  } catch (e) {
    if (/idx_inventory_code/.test(e.message)) return res.status(409).json({ error: `Ya existe un artículo con el código ${code}` });
    if (/image_urls|image_labels|file_urls|brand|category|features/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.42 (deploy-latest.sh)' });
    if (/inventory_items/.test(e.message) && /does not exist/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.21' });
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/admin/inventory/:id — editar; fotos/docs nuevos se AGREGAN, la lista editada permite QUITAR. owner/supervisor. */
// v0.9.42: mismo patrón que inmuebles v0.9.35 — image_urls (JSON) lista editada,
// image_labels (JSON) mapa completo, images+image_labels_new agregan, docs agregan,
// file_urls (JSON) reemplaza. image_url (legacy) se mantiene = primera foto.
router.patch('/admin/inventory/:id', requireTenantSession, requirePerm('catalog'), upload.fields([{ name: 'images', maxCount: 20 }, { name: 'docs', maxCount: 5 }, { name: 'image', maxCount: 1 }]), metaMediaGuard, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    // tolerante: columnas v0.9.42 pueden no existir todavía
    const cur = await db.query(
      `SELECT image_url,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'image_urls',   '[]'::jsonb) AS image_urls,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'image_labels', '{}'::jsonb) AS image_labels,
              COALESCE(to_jsonb(${invCat(req).table}) -> 'file_urls',    '[]'::jsonb) AS file_urls
       FROM ${invCat(req).table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Artículo no encontrado' });

    const sets = [];
    const params = [];
    let i = 1;
    const b = req.body || {};
    if (b.code !== undefined)        { sets.push(`code = $${i++}`);        params.push(String(b.code).trim()); }
    if (b.name !== undefined)        { sets.push(`name = $${i++}`);        params.push(String(b.name).trim()); }
    if (b.stock !== undefined)       { sets.push(`stock = $${i++}`);       params.push(parseInt(b.stock) || 0); }
    if (b.description !== undefined) { sets.push(`description = $${i++}`); params.push(String(b.description).trim() || null); }
    if (b.price !== undefined)       { sets.push(`price = $${i++}`);       params.push(String(b.price).trim() === '' ? null : Number(b.price)); }
    if (b.currency !== undefined)    { sets.push(`currency = $${i++}`);    params.push(String(b.currency).trim() || 'Bs'); }
    if (b.brand !== undefined)       { sets.push(`brand = $${i++}`);       params.push(String(b.brand).trim() || null); }
    if (b.category !== undefined)    { sets.push(`category = $${i++}`);    params.push(String(b.category).trim() || null); }
    if (b.subcategory !== undefined) { sets.push(`subcategory = $${i++}`); params.push(String(b.subcategory).trim() || null); } // v0.9.453
    if (b.features !== undefined)    { sets.push(`features = $${i++}`);    params.push(String(b.features).trim() || null); }
    // v0.9.400 — campos de vehículo (Concesionaria)
    if (b.model !== undefined)        { sets.push(`model = $${i++}`);        params.push(String(b.model).trim() || null); }
    if (b.model_year !== undefined)   { sets.push(`model_year = $${i++}`);   params.push(String(b.model_year).trim() === '' ? null : (parseInt(b.model_year) || null)); }
    if (b.km !== undefined)           { sets.push(`km = $${i++}`);           params.push(String(b.km).trim() === '' ? null : (parseInt(b.km) || null)); }
    if (b.body_type !== undefined)    { sets.push(`body_type = $${i++}`);    params.push(String(b.body_type).trim() || null); }
    if (b.fuel !== undefined)         { sets.push(`fuel = $${i++}`);         params.push(String(b.fuel).trim() || null); }
    if (b.transmission !== undefined) { sets.push(`transmission = $${i++}`); params.push(String(b.transmission).trim() || null); }
    if (b.condition !== undefined)    { sets.push(`condition = $${i++}`);    params.push(String(b.condition).trim() || null); }
    if (b.version !== undefined)      { sets.push(`version = $${i++}`);      params.push(String(b.version).trim() || null); }
    if (b.specs !== undefined)        { let _sp = null; try { if (String(b.specs).trim()) _sp = (typeof b.specs === 'string') ? JSON.stringify(JSON.parse(b.specs)) : JSON.stringify(b.specs); } catch (e) {} sets.push(`specs = $${i++}::jsonb`); params.push(_sp); }
    if (b.active !== undefined)      { sets.push(`active = $${i++}`);      params.push(b.active === true || b.active === 'true'); }

    const imgFiles = ((req.files && req.files.images) || []).concat((req.files && req.files.image) || []);
    const docFiles = (req.files && req.files.docs) || [];
    let labelsFull = null;
    if (b.image_labels !== undefined) {
      try { labelsFull = JSON.parse(b.image_labels); } catch (e) {}
      if (!labelsFull || typeof labelsFull !== 'object' || Array.isArray(labelsFull)) labelsFull = {};
    }
    let labelsNew = [];
    try { labelsNew = JSON.parse(b.image_labels_new || '[]'); } catch (e) {}
    if (!Array.isArray(labelsNew)) labelsNew = [];

    // Fotos: UN solo SET de image_urls (+ image_url legacy sincronizada)
    if (b.image_urls !== undefined || imgFiles.length || b.image_url !== undefined) {
      let merged;
      if (b.image_urls !== undefined) {
        merged = [];
        try { const arr = JSON.parse(b.image_urls); if (Array.isArray(arr)) merged = arr; } catch (e) {}
      } else if (b.image_url !== undefined && !imgFiles.length) {
        // compat vieja: setear foto única → reemplaza la lista
        const u = String(b.image_url).trim();
        merged = u ? [u] : [];
      } else {
        const existing = cur.rows[0].image_urls || [];
        merged = Array.isArray(existing) ? existing.slice() : [];
      }
      if (imgFiles.length) {
        if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
        const newLabels = {};
        for (let fi = 0; fi < imgFiles.length; fi++) {
          const file = imgFiles[fi];
          const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: invCat(req).prefix, filename: file.originalname });
          merged.push(up.url);
          const lbl = String(labelsNew[fi] || '').trim();
          if (lbl) newLabels[up.url] = lbl;
        }
        if (Object.keys(newLabels).length) {
          const base = labelsFull !== null ? labelsFull : (cur.rows[0].image_labels || {});
          labelsFull = Object.assign({}, base, newLabels);
        }
      }
      sets.push(`image_urls = $${i++}`); params.push(JSON.stringify(merged.slice(0, 20)));
      sets.push(`image_url = $${i++}`);  params.push(merged[0] || null);
    }
    if (labelsFull) { sets.push(`image_labels = $${i++}`); params.push(JSON.stringify(labelsFull)); }

    // Docs: base editada (file_urls JSON) o existente; los subidos se AGREGAN.
    // UN solo SET aunque vengan lista + archivos juntos.
    let docsBase = null;
    if (b.file_urls !== undefined) {
      docsBase = [];
      try { const arr = JSON.parse(b.file_urls); if (Array.isArray(arr)) docsBase = arr; } catch (e) {}
    }
    if (docFiles.length) {
      if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
      if (docsBase === null) {
        const ex = cur.rows[0].file_urls;
        docsBase = Array.isArray(ex) ? ex.slice() : [];
      }
      docsBase = docsBase.concat(await _uploadInventoryDocs(docFiles, invCat(req).docs)).slice(0, 10);
    }
    if (docsBase !== null) { sets.push(`file_urls = $${i++}`); params.push(JSON.stringify(docsBase)); }

    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    sets.push(`updated_at = NOW()`);
    params.push(id, tenantId);
    const r = await db.query(
      `UPDATE ${invCat(req).table} SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING id, code, name, stock, description, image_url, image_urls, image_labels, file_urls, brand, category, features, price, currency, active, updated_at`,
      params
    );
    res.json({ ok: true, item: r.rows[0] });
  } catch (e) {
    if (/idx_inventory_code/.test(e.message)) return res.status(409).json({ error: 'Ya existe un artículo con ese código' });
    if (/image_urls|image_labels|file_urls|brand|category|features/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.42 (deploy-latest.sh)' });
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/admin/inventory/:id — owner/supervisor. */
router.delete('/admin/inventory/:id', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await db.query(`DELETE FROM ${invCat(req).table} WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Artículo no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/inventory/clear-all — v0.9.544: VACIAR el catálogo completo del modo actual
// (?mode=articulos|restaurante|vehiculos) del tenant. Para descartar un catálogo entero (ej.
// dejar de vender colchones) sin borrar de a uno. El panel pide doble confirmación; acá exigimos
// confirm:true. Borra SOLO la tabla del catálogo — conversaciones y mensajes no se tocan.
router.post('/admin/inventory/clear-all', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'Falta confirmación (confirm: true)' });
  try {
    const r = await db.query(`DELETE FROM ${invCat(req).table} WHERE tenant_id = $1`, [tenantId]);
    console.log(`🗑️ [inventory/clear-all] tenant ${tenantId}: ${r.rowCount} artículo(s) borrados de ${invCat(req).table}`);
    res.json({ ok: true, deleted: r.rowCount || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.49 — SERVICIOS (4to modo: reservas de espacios y servicios)
// Gestión: owner/supervisor. Consulta/envío: todos.
// =====================================================================

const SVC_PRICE_UNITS = ['por hora', 'por sesión', 'por día', 'por persona', 'precio fijo'];

// Ficha de servicio: nombre, categoría, precio+unidad, duración/capacidad,
// características, horarios y link de reserva.
function _serviceCaption(s, calUrl) {
  const priceLine = (s.price != null) ? `💵 ${s.currency || 'Bs'} ${Number(s.price).toLocaleString('es-BO')} ${s.price_unit || ''}`.trim() : null;
  const det = [];
  if (s.duration_minutes) det.push(`⏱ ${s.duration_minutes} min`);
  if (s.capacity) det.push(`👥 hasta ${s.capacity} personas`);
  const feats = String(s.features || '').split('\n').map(x => x.trim()).filter(Boolean).slice(0, 8);
  const booking = s.booking_url || calUrl || null;
  return [
    `🛎️ *${s.name}*${s.category ? ` — ${s.category}` : ''}`,
    priceLine,
    det.length ? det.join(' · ') : null,
    feats.length ? feats.map(f => `• ${f.replace(/^[-•*]\s*/, '')}`).join('\n') : null,
    s.schedule_notes ? `🗓 ${s.schedule_notes}` : null,
    booking ? `📅 Reservá acá: ${booking}` : null,
    s.description ? `\n${s.description}` : null,
  ].filter(Boolean).join('\n');
}

async function _uploadServiceDocs(files, prefix) {
  const out = [];
  for (const file of files || []) {
    const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: prefix || 'services/docs', filename: file.originalname });
    out.push({ url: up.url, name: file.originalname || 'documento.pdf' });
  }
  return out;
}

/** GET /api/admin/services — lista. ?all=1 inactivos. ?q= busca. */
router.get('/admin/services', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const all = req.query.all === '1';
    const q = String(req.query.q || '').trim();
    const params = [tenantId];
    let where = 'tenant_id = $1';
    if (!all) where += ' AND active = TRUE';
    if (q) { params.push(`%${q}%`); where += ` AND (name ILIKE $${params.length} OR category ILIKE $${params.length})`; }
    const r = await db.query(
      `SELECT id, code, name, category, description, price, currency, price_unit, duration_minutes,
              capacity, features, schedule_notes, booking_url, image_urls, image_labels, file_urls, active, updated_at
       FROM ${svcCat(req).table} WHERE ${where} ORDER BY active DESC, LOWER(name) ASC LIMIT 500`,
      params
    );
    res.json({ ok: true, services: r.rows });
  } catch (e) {
    if (/relation "services"/.test(e.message)) return res.json({ ok: true, services: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/admin/services — crear con fotos etiquetadas (20) + PDFs (5). owner/supervisor. */
router.post('/admin/services', requireTenantSession, requirePerm('catalog'), upload.fields([{ name: 'images', maxCount: 20 }, { name: 'docs', maxCount: 5 }]), metaMediaGuard, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name requerido' });
  try {
    const imgFiles = (req.files && req.files.images) || [];
    const docFiles = (req.files && req.files.docs) || [];
    let labelsNew = [];
    try { labelsNew = JSON.parse(b.image_labels_new || '[]'); } catch (e) {}
    if (!Array.isArray(labelsNew)) labelsNew = [];
    const labelsMap = {};
    const urls = [];
    let docs = [];
    if (imgFiles.length || docFiles.length) {
      if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
      for (let fi = 0; fi < imgFiles.length; fi++) {
        const file = imgFiles[fi];
        const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: svcCat(req).prefix, filename: file.originalname });
        urls.push(up.url);
        const lbl = String(labelsNew[fi] || '').trim();
        if (lbl) labelsMap[up.url] = lbl;
      }
      docs = await _uploadServiceDocs(docFiles, svcCat(req).docs);
    }
    const ins = await db.query(
      `INSERT INTO ${svcCat(req).table} (tenant_id, code, name, category, description, price, currency, price_unit, duration_minutes, capacity, features, schedule_notes, booking_url, image_urls, image_labels, file_urls, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [tenantId,
       String(b.code || '').trim() || null,
       name,
       String(b.category || '').trim() || null,
       String(b.description || '').trim() || null,
       (b.price !== undefined && String(b.price).trim() !== '') ? Number(b.price) : null,
       String(b.currency || 'Bs').trim() || 'Bs',
       SVC_PRICE_UNITS.includes(b.price_unit) ? b.price_unit : 'por sesión',
       (b.duration_minutes && parseInt(b.duration_minutes)) || null,
       (b.capacity && parseInt(b.capacity)) || null,
       String(b.features || '').trim() || null,
       String(b.schedule_notes || '').trim() || null,
       (String(b.booking_url || '').trim() && /^https?:\/\//i.test(b.booking_url)) ? String(b.booking_url).trim() : null,
       JSON.stringify(urls), JSON.stringify(labelsMap), JSON.stringify(docs), req.userId || null]
    );
    res.status(201).json({ ok: true, service: ins.rows[0] });
  } catch (e) {
    if (/relation "services"/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.49 (deploy-latest.sh)' });
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/admin/services/:id — editar; fotos/docs nuevos se AGREGAN; lista editada permite QUITAR. */
router.patch('/admin/services/:id', requireTenantSession, requirePerm('catalog'), upload.fields([{ name: 'images', maxCount: 20 }, { name: 'docs', maxCount: 5 }]), metaMediaGuard, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const cur = await db.query(`SELECT image_urls, image_labels, file_urls FROM ${svcCat(req).table} WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Servicio no encontrado' });

    const b = req.body || {};
    const sets = [];
    const params = [];
    let i = 1;
    const add = (col, val) => { sets.push(`${col} = $${i++}`); params.push(val); };
    if (b.code !== undefined) add('code', String(b.code).trim() || null);
    if (b.name !== undefined && String(b.name).trim()) add('name', String(b.name).trim());
    if (b.category !== undefined) add('category', String(b.category).trim() || null);
    if (b.description !== undefined) add('description', String(b.description).trim() || null);
    if (b.price !== undefined) add('price', String(b.price).trim() === '' ? null : Number(b.price));
    if (b.currency !== undefined) add('currency', String(b.currency).trim() || 'Bs');
    if (b.price_unit !== undefined) add('price_unit', SVC_PRICE_UNITS.includes(b.price_unit) ? b.price_unit : 'por sesión');
    if (b.duration_minutes !== undefined) add('duration_minutes', String(b.duration_minutes).trim() === '' ? null : parseInt(b.duration_minutes) || null);
    if (b.capacity !== undefined) add('capacity', String(b.capacity).trim() === '' ? null : parseInt(b.capacity) || null);
    if (b.features !== undefined) add('features', String(b.features).trim() || null);
    if (b.schedule_notes !== undefined) add('schedule_notes', String(b.schedule_notes).trim() || null);
    if (b.booking_url !== undefined) add('booking_url', (String(b.booking_url || '').trim() && /^https?:\/\//i.test(b.booking_url)) ? String(b.booking_url).trim() : null);
    if (b.active !== undefined) add('active', b.active === true || b.active === 'true');

    const imgFiles = (req.files && req.files.images) || [];
    const docFiles = (req.files && req.files.docs) || [];
    let labelsFull = null;
    if (b.image_labels !== undefined) {
      try { labelsFull = JSON.parse(b.image_labels); } catch (e) {}
      if (!labelsFull || typeof labelsFull !== 'object' || Array.isArray(labelsFull)) labelsFull = {};
    }
    let labelsNew = [];
    try { labelsNew = JSON.parse(b.image_labels_new || '[]'); } catch (e) {}
    if (!Array.isArray(labelsNew)) labelsNew = [];

    if (b.image_urls !== undefined || imgFiles.length) {
      let merged;
      if (b.image_urls !== undefined) {
        merged = [];
        try { const arr = JSON.parse(b.image_urls); if (Array.isArray(arr)) merged = arr; } catch (e) {}
      } else {
        const existing = cur.rows[0].image_urls || [];
        merged = Array.isArray(existing) ? existing.slice() : [];
      }
      if (imgFiles.length) {
        if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
        const newLabels = {};
        for (let fi = 0; fi < imgFiles.length; fi++) {
          const file = imgFiles[fi];
          const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: svcCat(req).prefix, filename: file.originalname });
          merged.push(up.url);
          const lbl = String(labelsNew[fi] || '').trim();
          if (lbl) newLabels[up.url] = lbl;
        }
        if (Object.keys(newLabels).length) {
          const base = labelsFull !== null ? labelsFull : (cur.rows[0].image_labels || {});
          labelsFull = Object.assign({}, base, newLabels);
        }
      }
      add('image_urls', JSON.stringify(merged.slice(0, 20)));
    }
    if (labelsFull) add('image_labels', JSON.stringify(labelsFull));

    let docsBase = null;
    if (b.file_urls !== undefined) {
      docsBase = [];
      try { const arr = JSON.parse(b.file_urls); if (Array.isArray(arr)) docsBase = arr; } catch (e) {}
    }
    if (docFiles.length) {
      if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
      if (docsBase === null) {
        const ex = cur.rows[0].file_urls;
        docsBase = Array.isArray(ex) ? ex.slice() : [];
      }
      docsBase = docsBase.concat(await _uploadServiceDocs(docFiles, svcCat(req).docs)).slice(0, 10);
    }
    if (docsBase !== null) add('file_urls', JSON.stringify(docsBase));

    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    sets.push('updated_at = NOW()');
    params.push(id, tenantId);
    const r = await db.query(
      `UPDATE ${svcCat(req).table} SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
      params
    );
    res.json({ ok: true, service: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/admin/services/:id — owner/supervisor. */
router.delete('/admin/services/:id', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await db.query(`DELETE FROM ${svcCat(req).table} WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Servicio no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.22 — INMUEBLES (propiedades por organización)
// Gestión: owner/supervisor. Consulta/envío: todos.
// =====================================================================

const PROP_OPS = ['venta', 'alquiler', 'anticretico'];
const PROP_TYPES = ['casa', 'departamento', 'terreno', 'local', 'oficina', 'otro'];
const PROP_STATUS = ['disponible', 'reservado', 'vendido'];

// v0.9.458 — nombre de asesor NORMALIZADO, para comparar y para agrupar.
// El nombre se scrapea del HTML de la ficha de 21Online, así que llega sucio de
// tres formas distintas y cada una rompe el filtro en silencio (el asesor ve un
// catálogo vacío y cree que el sistema está roto):
//   · espacio duro U+00A0 — lo que queda de un &nbsp; sin decodificar. El \s de
//     Postgres NO lo cubre (verificado), por eso el translate va primero.
//   · espacios internos de más — trim() recorta las puntas, no el medio.
//   · mayúsculas inconsistentes entre una ficha y otra.
// _CLEAN deja el nombre presentable; _NORM es la llave para comparar/agrupar.
const _AGENT_COL = `to_jsonb(properties) ->> 'assigned_agent_name'`;
const _AGENT_CLEAN = (expr) => `regexp_replace(trim(translate(COALESCE(${expr}, ''), chr(160), ' ')), '\\s+', ' ', 'g')`;
const _AGENT_NORM = (expr) => `lower(${_AGENT_CLEAN(expr)})`;

/** GET /api/admin/properties — lista. ?all=1 inactivos. ?q= busca. */
// v0.9.340 — link de la FICHA PÚBLICA de una propiedad (mini-landing compartible).
// La firma la genera server.js (app.locals.fichaSign, HMAC — sin tokens en DB).
router.get('/admin/properties/:id/share-link', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const id = parseInt(req.params.id);
    const pr = await db.query('SELECT id, active FROM properties WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!pr.rows.length) return res.status(404).json({ error: 'Propiedad no encontrada' });
    const sign = req.app && req.app.locals && req.app.locals.fichaSign;
    if (typeof sign !== 'function') return res.status(500).json({ error: 'Firma no disponible' });
    const base = process.env.PUBLIC_BASE_URL || 'https://app.sg-ventas.com';
    res.json({ ok: true, url: `${base}/ficha/${id}-${sign(id)}`, active: pr.rows[0].active !== false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/properties', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const all = req.query.all === '1';
    const q = String(req.query.q || '').trim();
    const params = [tenantId];
    let where = 'tenant_id = $1';
    // v0.9.513 — ?drafts=1 → SOLO los inactivos. Tiene que filtrarse acá, en SQL:
    // el ORDER BY manda `active DESC` y el LIMIT es 500, así que en un catálogo de
    // miles los borradores caen fuera de la página y filtrar en el cliente no
    // alcanza: no llegan nunca al navegador.
    if (req.query.drafts === '1') where += ' AND active = FALSE';
    else if (!all) where += ' AND active = TRUE';
    if (q) { params.push(`%${q}%`); where += ` AND (title ILIKE $${params.length} OR zone ILIKE $${params.length} OR code ILIKE $${params.length})`; }
    // v0.9.445 — filtro por CARPETA ('__none' = sin carpeta) y por destacadas
    const _cat = String(req.query.category || '').trim();
    if (_cat === '__none') where += ` AND (to_jsonb(properties) ->> 'category') IS NULL`;
    else if (_cat) { params.push(_cat); where += ` AND to_jsonb(properties) ->> 'category' = $${params.length}`; }
    if (String(req.query.featured || '') === '1') where += ` AND COALESCE((to_jsonb(properties) ->> 'featured')::boolean, false) = TRUE`;
    // v0.9.446 — filtros por características (m², dormitorios, baños, precio, operación)
    const _op = String(req.query.op || '').trim();
    if (PROP_OPS.includes(_op)) { params.push(_op); where += ` AND operation = $${params.length}`; }
    const _bed = parseInt(req.query.bed_min); if (Number.isFinite(_bed) && _bed > 0) { params.push(_bed); where += ` AND bedrooms >= $${params.length}`; }
    const _bath = parseInt(req.query.bath_min); if (Number.isFinite(_bath) && _bath > 0) { params.push(_bath); where += ` AND bathrooms >= $${params.length}`; }
    const _m2 = Number(req.query.m2_min); if (Number.isFinite(_m2) && _m2 > 0) { params.push(_m2); where += ` AND area_m2 >= $${params.length}`; }
    const _pmax = Number(req.query.price_max); if (Number.isFinite(_pmax) && _pmax > 0) { params.push(_pmax); where += ` AND price <= $${params.length}`; }
    // v0.9.488 — precio MÍNIMO + MONEDA. Sin el filtro de moneda un rango de precios
    // mezcla Bs y USD en la misma comparación numérica y el resultado no significa
    // nada (Bs 100.000 y $us 100.000 no son lo mismo). Van juntos a propósito.
    const _pmin = Number(req.query.price_min); if (Number.isFinite(_pmin) && _pmin > 0) { params.push(_pmin); where += ` AND price >= $${params.length}`; }
    const _cur = String(req.query.currency || '').trim().toUpperCase();
    if (_cur === 'USD' || _cur === 'BS') {
      // Filas sin moneda cargada cuentan como USD (mismo default que muestra el panel).
      params.push(_cur);
      where += ` AND UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'USD')) = $${params.length}`;
    }
    const _zone = String(req.query.zone || '').trim(); // v0.9.450 — zona
    if (_zone) { params.push(_zone); where += ` AND zone = $${params.length}`; }
    const _st = String(req.query.state || '').trim(); // v0.9.451 — departamento
    if (_st) { params.push(_st); where += ` AND to_jsonb(properties) ->> 'state' = $${params.length}`; }
    // v0.9.458 — filtro por ASESOR captador. Es filtro de VISTA: el catálogo en
    // la base sigue completo (el bot puede seguir ofreciendo lo de un colega y
    // no se pierde el co-broke), esto solo recorta lo que ve el panel.
    // '__none' = las que todavía no tienen asesor identificado (el backfill las
    // va llenando de a poco, ver /admin/properties-categories → advisors_pending).
    // to_jsonb en vez de la columna pelada: tolerante a tenants sin migrar.
    const _agent = String(req.query.agent || '').trim().replace(/\s+/g, ' ');
    if (_agent === '__none') {
      where += ` AND ${_AGENT_CLEAN(_AGENT_COL)} = ''`;
    } else if (_agent) {
      params.push(_agent);
      where += ` AND ${_AGENT_NORM(_AGENT_COL)} = ${_AGENT_NORM(`$${params.length}`)}`;
    }
    // v0.9.42 FIX: el modal de edición lee de esta lista — sin image_labels,
    // maps_url y file_urls acá, cada guardado los PISABA con vacío (el save
    // siempre manda image_labels y maps_url). to_jsonb = tolerante a columnas
    // aún no migradas.
    const r = await db.query(
      `SELECT id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages,
              price, currency, status, description, image_urls, active, updated_at,
              COALESCE(to_jsonb(properties) -> 'image_labels', '{}'::jsonb) AS image_labels,
              COALESCE(to_jsonb(properties) -> 'image_featured', '{}'::jsonb) AS image_featured,
              to_jsonb(properties) ->> 'maps_url' AS maps_url,
              COALESCE(to_jsonb(properties) -> 'file_urls', '[]'::jsonb) AS file_urls,
              to_jsonb(properties) ->> 'assigned_agent_name' AS assigned_agent_name,
              to_jsonb(properties) -> 'visible_lines' AS visible_lines,
              to_jsonb(properties) ->> 'category' AS category,
              to_jsonb(properties) ->> 'availability' AS availability,
              to_jsonb(properties) ->> 'ficha_caption' AS ficha_caption,
              to_jsonb(properties) -> 'formats' AS formats,
              COALESCE(to_jsonb(properties) -> 'promotions', '[]'::jsonb) AS promotions,
              to_jsonb(properties) ->> 'source' AS source,
              COALESCE((to_jsonb(properties) ->> 'featured')::boolean, false) AS featured
       FROM properties WHERE ${where} ORDER BY active DESC, COALESCE((to_jsonb(properties) ->> 'featured')::boolean, false) DESC, updated_at DESC LIMIT 500`,
      params
    );
    res.json({ ok: true, properties: r.rows });
  } catch (e) {
    if (/properties/.test(e.message)) return res.json({ ok: true, properties: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.258 — visibilidad de un inmueble por línea. Devuelve INTEGER[] o null (= todas las líneas).
// Acepta un array JSON o un array ya parseado. Vacío → null (todas, e incluye líneas futuras).
function _parseVisibleLines(raw) {
  if (raw == null || raw === '') return null;
  let v = raw;
  if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch (e) { return null; } }
  if (!Array.isArray(v)) return null;
  const f = v.map(Number).filter(n => Number.isInteger(n) && n > 0);
  return f.length ? f : null;
}
/**
 * v0.9.480 — Arma "texto + bloque" respetando un límite, recortando SOLO el texto.
 * En un proyecto, la lista de tipologías es lo que el cliente necesita: si algo se corta,
 * se corta la prosa, nunca los formatos. Si el bloque solo ya no entra, se devuelve recortado.
 */
function _fitTo(text, block, limit) {
  const t = String(text || ''), b = String(block || '');
  if (!b) return t.slice(0, limit);
  if (b.length >= limit) return b.slice(0, limit);
  const room = limit - b.length;
  return (t.length <= room ? t : t.slice(0, Math.max(0, room - 1)).trimEnd() + '…') + b;
}

/**
 * v0.9.480 — PROYECTOS: normaliza los formatos/tipologías de un inmueble.
 * Entra un array (o su JSON) de {label, m2, dorm, price_from, availability} y sale un string
 * JSONB listo para guardar, o null si no hay nada útil (→ inmueble normal, sin proyecto).
 * Se sanea todo: strings recortados, tope de 30 formatos, y se descartan filas sin etiqueta.
 */
function _normFormats(v) {
  let arr = v;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (_) { return null; } }
  if (!Array.isArray(arr)) return null;
  const S = (x, n) => { const s = String(x == null ? '' : x).trim().replace(/\s+/g, ' ').slice(0, n); return s || null; };
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const label = S(it.label, 80);
    if (!label) continue; // sin nombre de tipología no sirve
    out.push({
      label,
      m2: S(it.m2, 20),
      dorm: S(it.dorm, 20),
      price_from: S(it.price_from, 40),
      availability: S(it.availability, 60),
    });
    if (out.length >= 30) break;
  }
  return out.length ? JSON.stringify(out) : null;
}

function _propFields(b) {
  const out = {};
  if (b.code !== undefined) out.code = String(b.code).trim() || null;
  if (b.title !== undefined) out.title = String(b.title).trim();
  if (b.operation !== undefined) out.operation = PROP_OPS.includes(b.operation) ? b.operation : 'venta';
  if (b.type !== undefined) out.type = PROP_TYPES.includes(b.type) ? b.type : 'otro';
  if (b.zone !== undefined) out.zone = String(b.zone).trim() || null;
  if (b.area_m2 !== undefined) out.area_m2 = String(b.area_m2).trim() === '' ? null : Number(b.area_m2);
  if (b.bedrooms !== undefined) out.bedrooms = String(b.bedrooms).trim() === '' ? null : parseInt(b.bedrooms);
  if (b.bathrooms !== undefined) out.bathrooms = String(b.bathrooms).trim() === '' ? null : parseInt(b.bathrooms);
  if (b.garages !== undefined) out.garages = String(b.garages).trim() === '' ? null : parseInt(b.garages);
  if (b.price !== undefined) out.price = String(b.price).trim() === '' ? null : Number(b.price);
  if (b.currency !== undefined) out.currency = String(b.currency).trim() || 'USD';
  if (b.status !== undefined) out.status = PROP_STATUS.includes(b.status) ? b.status : 'disponible';
  if (b.description !== undefined) out.description = String(b.description).trim() || null;
  if (b.assigned_agent_name !== undefined) out.assigned_agent_name = String(b.assigned_agent_name).trim() || null; // v0.9.384 — asesor asignado (editable manual)
  if (b.availability !== undefined) out.availability = String(b.availability).trim().replace(/\s+/g, ' ').slice(0, 160) || null; // v0.9.465 — disponibilidad texto libre (vacío = disponible)
  if (b.category !== undefined) out.category = String(b.category).trim().slice(0, 60) || null; // v0.9.445 — carpeta
  if (b.featured !== undefined) out.featured = b.featured === true || b.featured === 'true'; // v0.9.445 — destacada
  // v0.9.33: link de mapa (Google Maps u otro)
  if (b.maps_url !== undefined) {
    const m = String(b.maps_url || '').trim();
    out.maps_url = m && /^https?:\/\//i.test(m) ? m : null;
  }
  return out;
}

// v0.9.33: subir documentos (PDFs/planos) de una propiedad a R2.
// Devuelve array [{url, name}] para anexar a file_urls.
async function _uploadPropertyDocs(files) {
  const out = [];
  for (const file of files || []) {
    const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: 'properties/docs', filename: file.originalname });
    out.push({ url: up.url, name: file.originalname || 'documento.pdf' });
  }
  return out;
}

/** POST /api/admin/properties — crear (imágenes múltiples a R2). owner/supervisor. */
router.post('/admin/properties', requireTenantSession, requirePerm('catalog'), upload.fields([{ name: 'images', maxCount: 20 }, { name: 'docs', maxCount: 5 }]), metaMediaGuard, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const f = _propFields(req.body || {});
  if (!f.title) return res.status(400).json({ error: 'title requerido' });
  try {
    // v0.9.33: req.files es objeto {images: [], docs: []} (upload.fields)
    const imgFiles = (req.files && req.files.images) || [];
    const docFiles = (req.files && req.files.docs) || [];
    // v0.9.35: etiquetas por foto, en el MISMO orden que los archivos subidos
    let labelsNew = [];
    try { labelsNew = JSON.parse(req.body.image_labels_new || '[]'); } catch (e) {}
    if (!Array.isArray(labelsNew)) labelsNew = [];
    const labelsMap = {};
    let urls = [];
    let docs = [];
    if (imgFiles.length || docFiles.length) {
      if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
      for (let fi = 0; fi < imgFiles.length; fi++) {
        const file = imgFiles[fi];
        const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: 'properties', filename: file.originalname });
        urls.push(up.url);
        const lbl = String(labelsNew[fi] || '').trim();
        if (lbl) labelsMap[up.url] = lbl;
      }
      docs = await _uploadPropertyDocs(docFiles);
    }
    const _visLines = _parseVisibleLines(req.body.visible_lines); // v0.9.258: null = todas las líneas
    // v0.9.469 — si la descripción no entra en un caption de WhatsApp, la IA genera la versión ficha.
    const _fcNew = await generateFichaCaption(f, f.description, null).catch(() => null);
    const ins = await db.query(
      `INSERT INTO properties (tenant_id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description, image_urls, image_labels, maps_url, file_urls, created_by, visible_lines, availability, ficha_caption, formats)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       RETURNING id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description, image_urls, image_labels, maps_url, file_urls, active, updated_at`,
      [tenantId, f.code || null, f.title, f.operation || 'venta', f.type || 'casa', f.zone || null, f.area_m2 ?? null,
       f.bedrooms ?? null, f.bathrooms ?? null, f.garages ?? null, f.price ?? null, f.currency || 'USD',
       f.status || 'disponible', f.description || null, JSON.stringify(urls), JSON.stringify(labelsMap), f.maps_url || null, JSON.stringify(docs), req.userId || null, _visLines, f.availability ?? null, _fcNew,
       _normFormats(f.formats)] // v0.9.480
    );
    res.status(201).json({ ok: true, property: ins.rows[0] });
  } catch (e) {
    if (/image_labels/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.35' });
    if (/maps_url|file_urls/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.33' });
    if (/properties/.test(e.message) && /does not exist/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.22' });
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/admin/properties-categorize — v0.9.447: AUTO-CLASIFICAR las propiedades sin carpeta.
 * Palabras clave sobre título+descripción (fallback: el type). Solo toca category IS NULL →
 * lo movido a mano jamás se pisa, y el sync C21 después refina con el subtipo oficial del feed
 * (category no queda en manual_fields, así que el dato real de 21Online tiene la última palabra). */
router.post('/admin/properties-categorize', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const _norm = (x) => String(x || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const RULES = [
    ['Agrícola / Ganadera', /ganader|agricol|agropec|hectare|estancia|hacienda|potrero/],
    ['Quinta / Campestre', /quinta|campestre|cabana|caba\u00f1a|granja/],
    ['Casa en condominio', /casa.{0,25}condominio|condominio.{0,15}(cerrado|privado)/],
    ['Penthouse', /penthouse/],
    ['Departamento', /departamento|depto|monoambiente|duplex|studio|suite/],
    ['Depósito / Galpón', /galpon|deposito|tinglado|barraca|nave industrial/],
    ['Terreno / Lote', /terreno|lote|loteamiento|parcela|urbanizacion|macrolote/],
    ['Local comercial', /local comercial|local en|tienda|salon comercial|comercial/],
    ['Oficina', /oficina/],
    ['Edificio', /edificio/],
    ['Hotel', /hotel|hostal|motel|resort/],
    ['Casa', /casa|chalet|vivienda|residencia/],
  ];
  const TYPE_FALLBACK = { casa: 'Casa', departamento: 'Departamento', terreno: 'Terreno / Lote', local: 'Local comercial', oficina: 'Oficina' };
  try {
    const r = await db.query(
      `SELECT id, title, description, type FROM properties
       WHERE tenant_id = $1 AND active = TRUE AND (to_jsonb(properties) ->> 'category') IS NULL LIMIT 20000`, [tenantId]);
    const buckets = new Map();
    for (const p of r.rows) {
      const hay = _norm(p.title) + ' ' + _norm(String(p.description || '').slice(0, 300));
      let cat = null;
      for (const [name, re] of RULES) { if (re.test(hay)) { cat = name; break; } }
      if (!cat) cat = TYPE_FALLBACK[String(p.type || '').toLowerCase()] || null;
      if (cat) { if (!buckets.has(cat)) buckets.set(cat, []); buckets.get(cat).push(p.id); }
    }
    let updated = 0; const out = {};
    for (const [cat, ids] of buckets) {
      const u = await db.query(`UPDATE properties SET category = $1 WHERE tenant_id = $2 AND id = ANY($3) AND (to_jsonb(properties) ->> 'category') IS NULL`, [cat, tenantId, ids]);
      updated += u.rowCount || 0; out[cat] = u.rowCount || 0;
    }
    console.log(`📁 [auto-categorize] tenant ${tenantId}: ${updated}/${r.rows.length} clasificadas`, JSON.stringify(out));
    res.json({ ok: true, examined: r.rows.length, updated, by_category: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/properties/categories — v0.9.445: carpetas con conteo (activas). */
router.get('/admin/properties-categories', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(
      `SELECT COALESCE(to_jsonb(properties) ->> 'category', '__none') AS category, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE COALESCE((to_jsonb(properties) ->> 'featured')::boolean, false)) ::int AS destacadas
       FROM properties WHERE tenant_id = $1 AND active = TRUE
       GROUP BY 1 ORDER BY n DESC`, [tenantId]);
    const total = r.rows.reduce((a, x) => a + x.n, 0);
    const featured = r.rows.reduce((a, x) => a + x.destacadas, 0);
    // v0.9.450 — zonas/ciudades con conteo (para el filtro)
    let zones = [], states = [];
    try {
      const z = await db.query(`SELECT zone, COUNT(*)::int AS n FROM properties WHERE tenant_id = $1 AND active = TRUE AND zone IS NOT NULL AND zone <> '' GROUP BY zone ORDER BY n DESC LIMIT 80`, [tenantId]);
      zones = z.rows;
    } catch (e) {}
    try {
      const st = await db.query(`SELECT to_jsonb(properties) ->> 'state' AS state, COUNT(*)::int AS n FROM properties WHERE tenant_id = $1 AND active = TRUE AND (to_jsonb(properties) ->> 'state') IS NOT NULL GROUP BY 1 ORDER BY n DESC LIMIT 12`, [tenantId]);
      states = st.rows;
    } catch (e) {}
    // v0.9.458 — asesores captadores con conteo + cuántas propiedades siguen
    // SIN asesor identificado. Lo segundo importa tanto como lo primero: el
    // asesor no viene en el feed, se saca scrapeando cada ficha de a ~800 por
    // corrida, así que recién sincronizado casi todo está en null. Si el panel
    // prende "solo mías" sin mirar esto, el asesor abre el catálogo, ve tres
    // propiedades y cree que se rompió. Va acá (y no en /admin/c21-sync-config)
    // porque esa ruta es requireRole('owner') y un agente no puede leerla.
    let advisors = [], advisors_pending = 0;
    try {
      // Agrupa por nombre NORMALIZADO (minúsculas, espacios colapsados) y muestra
      // la grafía más frecuente: si no, el mismo asesor aparece dos veces en el
      // desplegable con el conteo partido a la mitad.
      const ad = await db.query(
        `SELECT mode() WITHIN GROUP (ORDER BY nm) AS name, COUNT(*)::int AS n
           FROM (SELECT ${_AGENT_CLEAN(_AGENT_COL)} AS nm
                   FROM properties
                  WHERE tenant_id = $1 AND active = TRUE
                    AND ${_AGENT_CLEAN(_AGENT_COL)} <> '') s
          GROUP BY lower(nm) ORDER BY n DESC, 1 ASC LIMIT 120`, [tenantId]);
      advisors = ad.rows;
    } catch (e) {}
    try {
      const pd = await db.query(
        `SELECT COUNT(*)::int AS n FROM properties
          WHERE tenant_id = $1 AND active = TRUE
            AND COALESCE(to_jsonb(properties) ->> 'source', '') = 'c21'
            AND ${_AGENT_CLEAN(_AGENT_COL)} = ''`, [tenantId]);
      advisors_pending = pd.rows[0].n;
    } catch (e) {}
    // v0.9.513 — BORRADORES (active = FALSE). Va acá y no se cuenta en el panel a
    // propósito: el listado trae LIMIT 500 ordenado por `active DESC`, así que en
    // un catálogo grande los inactivos quedan al final y NUNCA entran en la página.
    // Un tenant con 5.400 inmuebles no veía jamás sus borradores.
    let drafts = 0, drafts_claude = 0;
    try {
      const dr = await db.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE COALESCE(to_jsonb(properties) ->> 'source', '') = 'claude')::int AS claude
           FROM properties WHERE tenant_id = $1 AND active = FALSE`, [tenantId]);
      drafts = dr.rows[0].n; drafts_claude = dr.rows[0].claude;
    } catch (e) {}
    res.json({ ok: true, total, featured, drafts, drafts_claude, zones, states, advisors, advisors_pending, categories: r.rows.map((x) => ({ category: x.category === '__none' ? null : x.category, n: x.n })) });
  } catch (e) { res.json({ ok: true, total: 0, featured: 0, advisors: [], advisors_pending: 0, categories: [] }); }
});

/** PATCH /api/admin/properties/:id — editar; imágenes y docs nuevos se AGREGAN. owner/supervisor. */
router.patch('/admin/properties/:id', requireTenantSession, requirePerm('catalog'), upload.fields([{ name: 'images', maxCount: 20 }, { name: 'docs', maxCount: 5 }]), metaMediaGuard, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    // v0.9.35: image_labels leído de forma tolerante (columna puede no existir aún)
    const cur = await db.query(
      `SELECT image_urls, COALESCE(to_jsonb(properties) -> 'image_labels', '{}'::jsonb) AS image_labels,
              title, operation, zone, area_m2, bedrooms, bathrooms, garages, price, currency,
              to_jsonb(properties) ->> 'availability' AS availability
       FROM properties WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Inmueble no encontrado' });

    const f = _propFields(req.body || {});
    const sets = [];
    const params = [];
    let i = 1;
    for (const [k, v] of Object.entries(f)) { sets.push(`${k} = $${i++}`); params.push(v); }
    // v0.9.469 — si cambió la descripción: regenerar (o limpiar) la versión ficha para WhatsApp.
    // Solo cuando la descripción nueva es larga (no entra en un caption); si se acortó, se limpia.
    if (f.description !== undefined) {
      const _newDesc = String(f.description || '').trim();
      if (_newDesc.length > 1000) {
        const _merged = { ...cur.rows[0], ...f }; // datos actuales + los que vengan en el PATCH
        const _fc = await generateFichaCaption(_merged, _newDesc, null).catch(() => null);
        sets.push(`ficha_caption = $${i++}`); params.push(_fc);
      } else {
        sets.push(`ficha_caption = NULL`); // descripción corta → la ficha usa la descripción directa
      }
    }
    if (req.body.active !== undefined) { sets.push(`active = $${i++}`); params.push(req.body.active === true || req.body.active === 'true'); }
    // v0.9.480 — formatos/tipologías del proyecto (array JSONB). Mandar [] los borra.
    if (req.body.formats !== undefined) { sets.push(`formats = $${i++}`); params.push(_normFormats(req.body.formats)); }
    // v0.9.570 — promociones temporales (se sanitizan en promos.js: título obligatorio,
    // fechas YYYY-MM-DD o null, imágenes solo https, topes de cantidad).
    if (req.body.promotions !== undefined) {
      try { await require('./promos').ensureSchema(); } catch (e) { /* best-effort */ }
      const _pr = require('./promos').parse(req.body.promotions);
      sets.push(`promotions = $${i++}`); params.push(_pr.length ? JSON.stringify(_pr) : null);
    }
    // v0.9.33: req.files ahora es objeto {images, docs} (upload.fields)
    const imgFiles = (req.files && req.files.images) || [];
    const docFiles = (req.files && req.files.docs) || [];
    // v0.9.35: imágenes y etiquetas en UN solo SET cada una (evita doble
    // asignación SQL cuando vienen lista editada + archivos nuevos juntos).
    // - image_urls (JSON): lista editada (permite QUITAR fotos)
    // - image_labels (JSON): mapa completo {url: label} editado
    // - images (files) + image_labels_new (JSON array, mismo orden): se AGREGAN
    let labelsFull = null;
    if (req.body.image_labels !== undefined) {
      try { labelsFull = JSON.parse(req.body.image_labels); } catch (e) {}
      if (!labelsFull || typeof labelsFull !== 'object' || Array.isArray(labelsFull)) labelsFull = {};
    }
    let labelsNew = [];
    try { labelsNew = JSON.parse(req.body.image_labels_new || '[]'); } catch (e) {}
    if (!Array.isArray(labelsNew)) labelsNew = [];

    if (req.body.image_urls !== undefined || imgFiles.length) {
      let merged;
      if (req.body.image_urls !== undefined) {
        merged = [];
        try { const arr = JSON.parse(req.body.image_urls); if (Array.isArray(arr)) merged = arr; } catch (e) {}
      } else {
        const existing = cur.rows[0].image_urls || [];
        merged = Array.isArray(existing) ? existing.slice() : [];
      }
      if (imgFiles.length) {
        if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
        const newLabels = {};
        for (let fi = 0; fi < imgFiles.length; fi++) {
          const file = imgFiles[fi];
          const up = await r2.upload({ buffer: file.buffer, mimeType: file.mimetype, prefix: 'properties', filename: file.originalname });
          merged.push(up.url);
          const lbl = String(labelsNew[fi] || '').trim();
          if (lbl) newLabels[up.url] = lbl;
        }
        if (Object.keys(newLabels).length) {
          // base: mapa editado del panel, o el existente en DB (no pisar etiquetas viejas)
          const base = labelsFull !== null ? labelsFull : (cur.rows[0].image_labels || {});
          labelsFull = Object.assign({}, base, newLabels);
        }
      }
      sets.push(`image_urls = $${i++}`); params.push(JSON.stringify(merged));
    }
    if (labelsFull) {
      sets.push(`image_labels = $${i++}`); params.push(JSON.stringify(labelsFull));
    }
    // v0.9.229 — set DESTACADO (fotos que van con la ficha). Reemplazo total (mapa url→true).
    if (req.body.image_featured !== undefined) {
      let feat = {};
      try { const f = JSON.parse(req.body.image_featured); if (f && typeof f === 'object' && !Array.isArray(f)) feat = f; } catch (e) {}
      sets.push(`image_featured = $${i++}`); params.push(JSON.stringify(feat));
    }
    // v0.9.33: documentos — reemplazo total (file_urls JSON) o agregar subidos
    if (req.body.file_urls !== undefined) {
      let arr = [];
      try { arr = JSON.parse(req.body.file_urls); } catch (e) {}
      sets.push(`file_urls = $${i++}`); params.push(JSON.stringify(Array.isArray(arr) ? arr : []));
    }
    if (docFiles.length) {
      if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
      let curDocs = [];
      try {
        const cd = await db.query('SELECT file_urls FROM properties WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
        curDocs = Array.isArray(cd.rows[0]?.file_urls) ? cd.rows[0].file_urls.slice() : [];
      } catch (e) { /* columna no migrada → se intenta igual abajo */ }
      const newDocs = await _uploadPropertyDocs(docFiles);
      sets.push(`file_urls = $${i++}`); params.push(JSON.stringify(curDocs.concat(newDocs)));
    }
    // v0.9.258: visibilidad por línea (null = todas las líneas)
    if (req.body.visible_lines !== undefined) { sets.push(`visible_lines = $${i++}`); params.push(_parseVisibleLines(req.body.visible_lines)); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    sets.push('updated_at = NOW()');
    params.push(id, tenantId);
    const r = await db.query(
      `UPDATE properties SET ${sets.join(', ')}${req.body.category !== undefined ? `, manual_fields = CASE WHEN COALESCE(manual_fields,'[]'::jsonb) ? 'category' THEN manual_fields ELSE COALESCE(manual_fields,'[]'::jsonb) || '["category"]'::jsonb END` : ''} WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description, image_urls, image_labels, maps_url, file_urls, active, updated_at`,
      params
    );
    res.json({ ok: true, property: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/admin/properties/:id — owner/supervisor. */
/**
 * POST /api/admin/properties/:id/promo-image — v0.9.570
 * Sube UNA imagen de promoción a R2 y devuelve su URL. El panel la guarda dentro del
 * JSON de la promo (properties.promotions[].images), y r2-refs la cuenta como
 * referenciada para que el cron de mantenimiento NO la borre como huérfana.
 */
router.post('/admin/properties/:id/promo-image', requireTenantSession, requirePerm('catalog'), upload.single('image'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const own = await db.query('SELECT id FROM properties WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!own.rows.length) return res.status(404).json({ error: 'Inmueble no encontrado' });
    if (!req.file) return res.status(400).json({ error: 'Falta la imagen' });
    if (!/^image\//.test(req.file.mimetype || '')) return res.status(400).json({ error: 'El archivo debe ser una imagen' });
    if (!r2.isConfigured()) return res.status(500).json({ error: 'R2 no configurado' });
    const up = await r2.upload({ buffer: req.file.buffer, mimeType: req.file.mimetype, prefix: 'promos', filename: req.file.originalname });
    res.json({ ok: true, url: up.url });
  } catch (e) {
    console.error('[promo-image]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/admin/properties/:id', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const r = await db.query('DELETE FROM properties WHERE id = $1 AND tenant_id = $2 RETURNING id', [id, tenantId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Inmueble no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.277 — IMPORTADOR MASIVO de inmuebles desde Excel de Century 21.
// El super-admin sube el .xls (se parsea en el navegador con SheetJS → filas crudas keyed por header),
// las filas llegan acá, se MAPEAN al esquema `properties`, se DEDUPLICAN por `code` (id de C21) y se
// insertan en bloque. Soporta dry-run (análisis previo sin tocar la DB). Sin fotos (el Excel no trae).
// =====================================================================

// Diccionarios C21 → CRM (subtipo/operación). Lo que no matchea cae a 'otro'/'venta'.
const C21_TYPE_MAP = { terreno: 'terreno', departamento: 'departamento', depto: 'departamento', casa: 'casa', local: 'local', oficina: 'oficina', edificio: 'otro', otro: 'otro' };
const C21_OP_MAP = { venta: 'venta', renta: 'alquiler', alquiler: 'alquiler', anticretico: 'anticretico', 'anticrético': 'anticretico' };

function _c21cap(s) { s = String(s == null ? '' : s).trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
// v0.9.338 — sanitiza encoding roto del Excel: rachas de 2+ "?" (mojibake) fuera; un "?" solo
// (pregunta legítima) se respeta. También colapsa espacios y limpia guiones huérfanos al borde.
function _c21clean(s) {
  return String(s == null ? '' : s)
    .replace(/�+/g, '')      // U+FFFD (replacement char)
    .replace(/\?{2,}/g, '')       // rachas de "??" del encoding roto
    .replace(/[ \t]{2,}/g, ' ')   // colapsa espacios SIN tocar saltos de línea (el título sale de la 1ra línea)
    .replace(/[ \t]*[–-][ \t]*$/, '')
    .trim();
}
function _c21num(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
function _c21int(v) { const n = _c21num(v); return n == null ? null : Math.round(n); }

// Mapea UNA fila cruda del Excel C21 a un objeto de `properties`. Tolerante a columnas faltantes.
function _mapC21ToProperty(row, opts) {
  opts = opts || {};
  const g = (k) => { const v = row ? row[k] : null; return v == null ? '' : _c21clean(String(v)); }; // v0.9.338: sanitiza mojibake al entrar
  const subtipo = g('subtipoPropiedad').toLowerCase();
  const municipio = g('municipio');
  // v0.9.346: las líneas "Precio: $us. 93.000.-" del Excel se descartan de entrada — el precio
  // vive en el campo `price` (fuente única); en la descripción duplicaba/contradecía la ficha.
  const desc = g('descripcion').split(/\r?\n/).filter((l) => !/^\s*precio(\s+de\s+\S+)?\s*[:.]/i.test(l.trim())).join('\n').trim(); // v0.9.348: también "Precio de alquiler:/de venta:"
  const calle = g('calle'), numero = g('numero');

  // title: 1ra línea de la descripción (sirve de título comercial), tope 90; fallback "[Subtipo] en [zona]".
  let title = (desc.split(/\r?\n/)[0] || '').trim();
  if (title.length > 90) title = title.slice(0, 87).trim() + '…';
  if (!title) title = `${_c21cap(subtipo) || 'Inmueble'}${municipio ? ' en ' + municipio : ''}`;

  // área: construido (m2C) si hay, si no el del terreno (m2T).
  const m2c = _c21num(g('m2C')), m2t = _c21num(g('m2T'));
  const area = (m2c && m2c > 0) ? m2c : (m2t && m2t > 0 ? m2t : null);

  // maps_url desde lat/long.
  const lat = _c21num(g('latitud')), lng = _c21num(g('longitud'));
  const maps_url = (lat != null && lng != null) ? `https://www.google.com/maps?q=${lat},${lng}` : null;

  // descripción: la de C21 + dirección si aporta algo nuevo.
  let description = desc || null;
  const dir = [calle, numero].filter(Boolean).join(' ').trim();
  if (dir && description && !description.toLowerCase().includes(calle.toLowerCase().slice(0, 12))) description += `\n\n📍 ${dir}`;
  else if (dir && !description) description = `📍 ${dir}`;

  const code = g('clave') || g('id') || null;
  // v0.9.425 — fotos por URL (extracción 21Online): acepta `fotos` (array de URLs) o columnas foto1..foto5.
  let image_urls = [];
  if (Array.isArray(row && row.fotos)) image_urls = row.fotos.filter((u) => /^https?:\/\//i.test(String(u)));
  else for (const k of ['foto1', 'foto2', 'foto3', 'foto4', 'foto5']) { const u = g(k); if (/^https?:\/\//i.test(u)) image_urls.push(u); }
  image_urls = image_urls.slice(0, 10);
  // v0.9.384 — asesor asignado: el Excel C21 lo trae en nombre + apellidoP + apellidoM
  // (ojo: los apellidos suelen venir como iniciales, ej. "Lorena O H"). Title-case por palabra.
  const assigned_agent_name = [g('nombre'), g('apellidoP'), g('apellidoM')]
    .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    .split(' ').map((w) => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w).join(' ') || null;
  return {
    code,
    title,
    operation: C21_OP_MAP[g('tipoOperacion').toLowerCase()] || 'venta',
    type: C21_TYPE_MAP[subtipo] || 'otro',
    zone: municipio || null,
    area_m2: area,
    bedrooms: _c21int(g('recamaras')),
    bathrooms: _c21int(g('banios')),
    garages: _c21int(g('estacionamientos')),
    price: _c21num(g('precio')),
    currency: opts.currency || 'Bs',
    status: 'disponible',
    description,
    maps_url,
    assigned_agent_name,
    image_urls, // v0.9.425 — fotos por URL
    image_url: image_urls[0] || null,
    active: opts.active !== false,
  };
}
router._mapC21ToProperty = _mapC21ToProperty; // export para test unitario

// v0.9.278 — acepta DOS orígenes: (a) super-admin (X-Admin-Token) con tenant_id en el body → importa a
// cualquier tenant; (b) el TENANT desde su panel (JWT) → importa SOLO a lo suyo y solo si el super-admin
// le habilitó c21_import_enabled. El tenant NUNCA puede elegir otro tenant_id (se ignora el del body).
router.post('/admin/properties/import', requireTenantSession, async (req, res) => {
  const b = req.body || {};
  let tenantId;
  if (req.isSuperAdmin) {
    tenantId = parseInt(b.tenant_id, 10);
  } else {
    tenantId = req.tenantId; // su propio tenant, del JWT
    try {
      const g = await db.query('SELECT COALESCE(c21_import_enabled, false) AS on FROM tenants WHERE id = $1', [tenantId]);
      if (!g.rows.length || !g.rows[0].on) return res.status(403).json({ ok: false, error: 'La carga masiva no está habilitada para tu cuenta. Pedísela a SG Ventas.' });
    } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
  }
  if (!Number.isFinite(tenantId) || tenantId <= 0) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
  const rows = Array.isArray(b.rows) ? b.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ ok: false, error: 'No hay filas para importar.' });
  if (rows.length > 2000) return res.status(400).json({ ok: false, error: 'Máximo 2000 filas por importación.' });
  const currency = (String(b.currency || 'Bs').trim() || 'Bs').slice(0, 8);
  const active = b.active !== false;
  const dryRun = !!b.dry_run;
  const replaceAll = !!b.replace_all; // v0.9.385 — reemplazo total (borra todo el catálogo y carga solo el Excel)

  try {
    const t = await db.query('SELECT id, name FROM tenants WHERE id = $1', [tenantId]);
    if (!t.rows.length) return res.status(404).json({ ok: false, error: 'El tenant no existe.' });
    const tenantName = t.rows[0].name;

    // Dedup: codes ya cargados en este tenant.
    const existing = new Set(
      (await db.query('SELECT code FROM properties WHERE tenant_id = $1 AND code IS NOT NULL', [tenantId]))
        .rows.map(r => String(r.code))
    );
    // v0.9.385 — total actual (incluye los cargados a mano sin código): lo que se borraría en un reemplazo total.
    const currentCount = (await db.query('SELECT COUNT(*)::int AS n FROM properties WHERE tenant_id = $1', [tenantId])).rows[0].n;

    const mapped = [], skipped = [], invalid = [], seen = new Set();
    const backfill = [];             // v0.9.384 — inmuebles ya cargados: backfilleamos el asesor asignado
    const agentNames = new Set();    // v0.9.384 — asesores detectados → siembran el directorio c21_agents
    for (let i = 0; i < rows.length; i++) {
      const p = _mapC21ToProperty(rows[i], { currency, active });
      if (!p.title) { invalid.push({ row: i + 1, reason: 'sin título' }); continue; }
      if (p.assigned_agent_name) agentNames.add(p.assigned_agent_name);
      const key = p.code ? String(p.code) : null;
      if (!replaceAll && key && existing.has(key)) { skipped.push({ row: i + 1, code: key, reason: 'ya existe en el CRM' }); if (p.assigned_agent_name) backfill.push({ code: key, agent: p.assigned_agent_name }); continue; }
      if (key && seen.has(key)) { skipped.push({ row: i + 1, code: key, reason: 'duplicado en el archivo' }); continue; }
      if (key) seen.add(key);
      mapped.push(p);
    }

    if (dryRun) {
      return res.json({
        ok: true, dry_run: true, tenant: tenantName, currency, active,
        total: rows.length, to_import: mapped.length, duplicates: skipped.length, invalid: invalid.length,
        replace_all: replaceAll, will_delete: replaceAll ? currentCount : 0, // v0.9.385 — reemplazo total
        agents_detected: agentNames.size, // v0.9.384
        sample: mapped.slice(0, 8).map(p => ({ code: p.code, title: p.title, type: p.type, operation: p.operation, zone: p.zone, area_m2: p.area_m2, bedrooms: p.bedrooms, bathrooms: p.bathrooms, price: p.price, currency: p.currency, assigned_agent_name: p.assigned_agent_name })),
        skipped_sample: skipped.slice(0, 5),
      });
    }

    // v0.9.385 — REEMPLAZO TOTAL: borra TODO el catálogo del tenant y carga solo lo del Excel, en una
    // transacción atómica. Si algo falla, ROLLBACK completo → el catálogo queda intacto (no se pierde nada).
    // El panel exige confirmación explícita (se pierden fotos y los inmuebles cargados a mano).
    if (replaceAll) {
      const client = await db.getClient();
      let deleted = 0, insertedR = 0; const errorsR = [];
      try {
        await client.query('BEGIN');
        const del = await client.query('DELETE FROM properties WHERE tenant_id = $1', [tenantId]);
        deleted = del.rowCount || 0;
        for (const p of mapped) {
          try {
            await client.query('SAVEPOINT sp');
            await client.query(
              `INSERT INTO properties (tenant_id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description, image_urls, maps_url, visible_lines, assigned_agent_name, active, created_by)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,NULL,$17,$18,NULL)`,
              [tenantId, p.code, p.title, p.operation, p.type, p.zone, p.area_m2, p.bedrooms, p.bathrooms, p.garages, p.price, p.currency, p.status, p.description, JSON.stringify(p.image_urls || []), p.maps_url, p.assigned_agent_name, p.active]
            );
            await client.query('RELEASE SAVEPOINT sp');
            insertedR++;
          } catch (e) { await client.query('ROLLBACK TO SAVEPOINT sp').catch(() => {}); errorsR.push({ code: p.code, error: e.message }); }
        }
        await client.query('COMMIT');
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        client.release();
        console.error('[import-c21 REPLACE]', e);
        return res.status(500).json({ ok: false, error: 'Reemplazo cancelado, no se borró nada (rollback): ' + e.message });
      }
      client.release();
      // Directorio de asesores (fuera de la transacción; best-effort).
      let agentsSeededR = 0;
      for (const name of agentNames) {
        try { const ins = await db.query(`INSERT INTO c21_agents (tenant_id, name) VALUES ($1, $2) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`, [tenantId, name]); agentsSeededR += ins.rowCount || 0; } catch (e) { /* best-effort */ }
      }
      console.log(`🏠 [import-c21 REPLACE] tenant ${tenantId} (${tenantName}): -${deleted} borradas · +${insertedR} cargadas · ${agentNames.size} asesores (${agentsSeededR} nuevos) · ${errorsR.length} err`);
      return res.json({ ok: true, tenant: tenantName, replaced: true, deleted, inserted: insertedR, invalid: invalid.length, agents_detected: agentNames.size, agents_new: agentsSeededR, error_count: errorsR.length, errors: errorsR.slice(0, 10) });
    }

    let inserted = 0; const errors = [];
    for (const p of mapped) {
      try {
        await db.query(
          `INSERT INTO properties (tenant_id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description, image_urls, maps_url, visible_lines, assigned_agent_name, active, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,NULL,$17,$18,NULL)`,
          [tenantId, p.code, p.title, p.operation, p.type, p.zone, p.area_m2, p.bedrooms, p.bathrooms, p.garages, p.price, p.currency, p.status, p.description, JSON.stringify(p.image_urls || []), p.maps_url, p.assigned_agent_name, p.active]
        );
        inserted++;
      } catch (e) { errors.push({ code: p.code, error: e.message }); }
    }
    // v0.9.384 — backfill del asesor en inmuebles YA cargados (solo si aún no tienen uno; no pisa ediciones manuales).
    let backfilled = 0;
    for (const b of backfill) {
      try {
        const u = await db.query(
          `UPDATE properties SET assigned_agent_name = $1 WHERE tenant_id = $2 AND code = $3 AND (assigned_agent_name IS NULL OR assigned_agent_name = '')`,
          [b.agent, tenantId, b.code]
        );
        backfilled += u.rowCount || 0;
      } catch (e) { /* best-effort */ }
    }
    // v0.9.384 — siembra del DIRECTORIO de asesores: cada asesor detectado se agrega (phone queda null
    // hasta que el equipo lo cargue). No pisa un asesor/teléfono ya existente.
    let agentsSeeded = 0;
    for (const name of agentNames) {
      try {
        const ins = await db.query(
          `INSERT INTO c21_agents (tenant_id, name) VALUES ($1, $2) ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
          [tenantId, name]
        );
        agentsSeeded += ins.rowCount || 0;
      } catch (e) { /* directorio best-effort (puede faltar la migración) */ }
    }
    console.log(`🏠 [import-c21] tenant ${tenantId} (${tenantName}): ${inserted} insertadas · ${backfilled} backfill asesor · ${skipped.length} dup · ${agentNames.size} asesores (${agentsSeeded} nuevos) · ${errors.length} err`);
    res.json({ ok: true, tenant: tenantName, inserted, backfilled, skipped: skipped.length, invalid: invalid.length, agents_detected: agentNames.size, agents_new: agentsSeeded, error_count: errors.length, errors: errors.slice(0, 10) });
  } catch (e) {
    console.error('[import-c21]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.9.384 — DIRECTORIO de asesores C21 (facilitación). El Excel trae el NOMBRE del asesor pero no su
// WhatsApp; el número se carga acá una vez por asesor y se resuelve al mostrar (sin re-importar).
// GET: fusiona el directorio con los asesores presentes en properties (para que la lista esté completa
// aunque el número aún no se haya cargado). INTERNO: nunca se le manda al cliente.
router.get('/admin/c21-agents', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const dir = await db.query('SELECT name, phone FROM c21_agents WHERE tenant_id = $1', [tenantId]);
    const props = await db.query(
      `SELECT DISTINCT assigned_agent_name AS name FROM properties WHERE tenant_id = $1 AND assigned_agent_name IS NOT NULL AND assigned_agent_name <> ''`,
      [tenantId]
    ).catch(() => ({ rows: [] }));
    const map = new Map();
    dir.rows.forEach((r) => map.set(String(r.name).toLowerCase(), { name: r.name, phone: r.phone || null }));
    props.rows.forEach((r) => { const k = String(r.name).toLowerCase(); if (!map.has(k)) map.set(k, { name: r.name, phone: null }); });
    const agents = [...map.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ ok: true, agents });
  } catch (e) {
    if (/c21_agents|assigned_agent_name|does not exist/.test(e.message)) return res.json({ ok: true, agents: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.384 — guarda/actualiza el WhatsApp de un asesor del directorio (upsert por nombre).
router.put('/admin/c21-agents', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ ok: false, error: 'name requerido' });
  // Normalizamos a solo dígitos (para wa.me). Vacío = borrar el número (queda solo el nombre).
  let phone = b.phone == null ? '' : String(b.phone).replace(/[^0-9]/g, '');
  if (/^[67]\d{7}$/.test(phone)) phone = '591' + phone; // móvil boliviano sin código país → wa.me
  phone = phone || null;
  try {
    await db.query(
      `INSERT INTO c21_agents (tenant_id, name, phone, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET phone = EXCLUDED.phone, updated_at = now()`,
      [tenantId, name, phone]
    );
    res.json({ ok: true, name, phone });
  } catch (e) {
    if (/c21_agents/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración v0.9.384 (c21_agents).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.9.278 — el SUPER-ADMIN habilita/deshabilita la "Carga masiva Formato C21" en el panel del tenant.
// Solo super-admin (X-Admin-Token). El botón aparece/desaparece en Inmuebles según este flag.
router.put('/admin/c21-import/enabled', requireAdminToken, async (req, res) => {
  const tenantId = parseInt((req.body && req.body.tenant_id) || req.query.tenant_id, 10);
  if (!Number.isFinite(tenantId) || tenantId <= 0) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
  const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
  try {
    const r = await db.query('UPDATE tenants SET c21_import_enabled = $2 WHERE id = $1 RETURNING id', [tenantId, enabled]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'tenant no existe' });
    res.json({ ok: true, c21_import_enabled: enabled });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// v0.9.386 — el SUPER-ADMIN prende/apaga el botón "👥 Asesores C21" del panel del tenant (c21_agents_enabled).
// Mismo patrón que c21-import/enabled. Solo super-admin (X-Admin-Token).
router.put('/admin/c21-agents/enabled', requireAdminToken, async (req, res) => {
  const tenantId = parseInt((req.body && req.body.tenant_id) || req.query.tenant_id, 10);
  if (!Number.isFinite(tenantId) || tenantId <= 0) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
  const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
  try {
    const r = await db.query('UPDATE tenants SET c21_agents_enabled = $2 WHERE id = $1 RETURNING id', [tenantId, enabled]);
    if (!r.rows.length) return res.status(404).json({ ok: false, error: 'tenant no existe' });
    res.json({ ok: true, c21_agents_enabled: enabled });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// =====================================================================
// v0.9.22 — RESERVAS (Cal.com API v2)
// =====================================================================

/** GET /api/admin/reservations — próximas reservas desde Cal.com. Todos los roles. */
router.get('/admin/reservations', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  try {
    // v0.9.165: citas in-house (agendador propio) — son la base del calendario ahora.
    // v0.9.173: el DUEÑO ve TODA la agenda del negocio; cada vendedor ve la suya.
    const _ownerView = (req.userRole === 'owner') || req.isSuperAdmin;
    const _inhouse = _ownerView
      ? await _fetchInhouseTenant(tenantId, req.query.from || null, req.query.to || null)
      : await _fetchInhouse(req.userId, req.query.from || null, req.query.to || null);
    // v0.9.202: sumar las citas PENDIENTES de asignar (pool "por tomar") — del tenant entero,
    // sin dueño — para que se vean en el calendario (en otro color) y nadie las pierda de vista.
    const _pending = await _fetchInhousePending(tenantId, req.query.from || null, req.query.to || null, await getAgentLineIds(req)); // v0.9.489 — pool por tomar acotado a la línea del agente
    const _inhouseAll = _pending.length ? _pending.concat(_inhouse) : _inhouse;
    // v0.9.173: si el usuario ya activó su agenda propia, el calendario sale 100% del
    // agendador propio (las citas reales). Cal quedó atrás → no se mezcla más.
    let _inhouseActive = false;
    if (req.userId) {
      const _ua = await db.query('SELECT booking_enabled FROM tenant_users WHERE id = $1', [req.userId]).catch(() => ({ rows: [] }));
      _inhouseActive = !!(_ua.rows[0] && _ua.rows[0].booking_enabled);
    }
    if (_inhouseActive) return res.json({ ok: true, configured: true, source: 'inhouse', bookings: _inhouseAll });
    // v0.9.163: la API key de Cal es POR USUARIO. Se usa la del usuario logueado;
    // si todavía no conectó su Cal, fallback a la del tenant (compatibilidad).
    let enc = null;
    if (req.userId) {
      const u = await db.query('SELECT cal_api_key FROM tenant_users WHERE id = $1', [req.userId]).catch(() => ({ rows: [] }));
      enc = u.rows[0] && u.rows[0].cal_api_key;
    }
    if (!enc) {
      const t = await db.query('SELECT cal_api_key FROM tenants WHERE id = $1', [tenantId]);
      enc = t.rows[0] && t.rows[0].cal_api_key;
    }
    if (!enc) return res.json({ ok: true, configured: true, bookings: _inhouseAll });
    const apiKey = decryptSafe(enc);
    if (!apiKey) return res.status(500).json({ error: 'No se pudo leer la API key de Cal' });

    const axios = require('axios');
    // v0.9.90: rango de fechas para la vista calendario (afterStart/beforeEnd de Cal v2).
    const _from = String(req.query.from || '').trim();
    const _to = String(req.query.to || '').trim();
    const _params = (_from && _to) ? { afterStart: _from, beforeEnd: _to, take: 100 } : { status: 'upcoming' };
    const r = await axios.get('https://api.cal.com/v2/bookings', {
      params: _params,
      headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': '2024-08-13' },
      timeout: 15000,
    });
    const raw = r.data?.data || r.data?.bookings || [];
    let bookings = (Array.isArray(raw) ? raw : []).slice(0, 200).map(b => ({
      id: b.uid || b.id,
      title: b.title || b.eventType?.title || 'Reserva',
      start: b.start || b.startTime,
      end: b.end || b.endTime,
      status: b.status,
      attendee: (b.attendees && b.attendees[0]) ? (b.attendees[0].name || b.attendees[0].email) : (b.responses?.name?.value || null),
      attendee_email: (b.attendees && b.attendees[0]) ? b.attendees[0].email : null,
      meeting_url: b.metadata?.videoCallUrl || (typeof b.location === 'string' && b.location.startsWith('http') ? b.location : null) || null,
    }));
    if (_from && _to) {
      const _lo = new Date(_from).getTime(), _hi = new Date(_to).getTime();
      bookings = bookings.filter(b => { const s = b.start ? new Date(b.start).getTime() : NaN; return !isNaN(s) && s >= _lo && s <= _hi; });
    }
    res.json({ ok: true, configured: true, bookings: _inhouseAll.concat(bookings) });
  } catch (e) {
    // v0.9.23b: no devolver 502 (parece caída del servidor). 200 con error legible.
    const msg = e.response?.status === 401 ? 'API key de Cal inválida o sin permisos' : (e.response?.data?.error?.message || e.message);
    res.json({ ok: false, configured: true, bookings: [], error: `Cal.com: ${msg}` });
  }
});

// v0.9.163 — Cal.com POR USUARIO. Cada usuario logueado conecta SU propia cuenta de Cal
// (su key cifrada + su link de agendado). GET = estado; PATCH = guardar/desconectar.
router.get('/admin/me/cal', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.json({ ok: true, configured: false, event_url: '' });
  try {
    const r = await db.query('SELECT cal_api_key, calcom_event_url FROM tenant_users WHERE id = $1', [req.userId]);
    const row = r.rows[0] || {};
    res.json({ ok: true, configured: !!row.cal_api_key, event_url: row.calcom_event_url || '' });
  } catch (e) {
    if (/cal_api_key|calcom_event_url/.test(e.message)) return res.json({ ok: true, configured: false, event_url: '', need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/admin/me/cal', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.status(400).json({ error: 'Sesión sin usuario' });
  const { cal_api_key, calcom_event_url } = req.body || {};
  const sets = [], vals = [];
  if (typeof cal_api_key === 'string' && cal_api_key.trim()) {
    // Verificar la key contra Cal.com ANTES de guardar (igual que el flujo de tenant).
    const axios = require('axios');
    try {
      await axios.get('https://api.cal.com/v2/me', { headers: { Authorization: `Bearer ${cal_api_key.trim()}`, 'cal-api-version': '2024-08-13' }, timeout: 12000 });
    } catch (e) {
      const code = e.response?.status;
      if (code === 401 || code === 403) return res.status(422).json({ error: 'La API key de Cal no es válida (rechazada por Cal.com).' });
      return res.status(503).json({ error: 'No se pudo verificar con Cal.com (¿caído?). Reintentá.' });
    }
    const { encrypt } = require('./crypto');
    vals.push(encrypt(cal_api_key.trim())); sets.push(`cal_api_key = $${vals.length}`);
  } else if (cal_api_key === '' || cal_api_key === null) {
    sets.push('cal_api_key = NULL'); // desconectar
  }
  if (typeof calcom_event_url === 'string') {
    const url = calcom_event_url.trim();
    vals.push(url || null); sets.push(`calcom_event_url = $${vals.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' });
  vals.push(req.userId);
  try {
    await db.query(`UPDATE tenant_users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    res.json({ ok: true });
  } catch (e) {
    if (/cal_api_key|calcom_event_url/.test(e.message)) return res.status(503).json({ error: 'Falta la migración de Cal por usuario (deploy pendiente).' });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.458 — QUÉ ASESOR DE C21 SOY. Preferencia por usuario, no del tenant:
// en una oficina C21 el catálogo es compartido y cada quien quiere abrir el
// panel viendo lo suyo. Guarda el NOMBRE tal cual lo escribe 21Online en la
// ficha (properties.assigned_agent_name), que es la única llave que tenemos:
// el ID del perfil público no aparece por ningún lado en el back-office, y el
// teléfono del perfil público es el del pie de página del sitio, no el del
// asesor (verificado: el mismo número está en la home de c21.com.bo).
router.get('/admin/me/c21-agent', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  // super-admin mirando un tenant: no tiene fila en tenant_users, no hay qué guardar
  if (!req.userId) return res.json({ ok: true, agent_name: '', matched: 0, is_super: true });
  try {
    const r = await db.query('SELECT c21_agent_name FROM tenant_users WHERE id = $1', [req.userId]);
    const name = (r.rows[0] || {}).c21_agent_name || '';
    let matched = 0;
    if (name && tenantId) {
      const m = await db.query(
        `SELECT COUNT(*)::int AS n FROM properties
          WHERE tenant_id = $1 AND active = TRUE
            AND ${_AGENT_NORM(_AGENT_COL)} = ${_AGENT_NORM('$2')}`,
        [tenantId, name]).catch(() => ({ rows: [{ n: 0 }] }));
      matched = m.rows[0].n;
    }
    res.json({ ok: true, agent_name: name, matched });
  } catch (e) {
    if (/c21_agent_name/.test(e.message)) return res.json({ ok: true, agent_name: '', matched: 0, need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

router.put('/admin/me/c21-agent', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.status(400).json({ error: 'Sesión sin usuario (super-admin): esta preferencia es de cada usuario del panel.' });
  const tenantId = invTenant(req);
  const raw = (req.body && typeof req.body.agent_name === 'string') ? req.body.agent_name : '';
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, 160);
  try {
    await db.query('UPDATE tenant_users SET c21_agent_name = $1 WHERE id = $2', [name || null, req.userId]);
    // Devolvemos cuántas propiedades le calzan HOY. Si es 0 no rechazamos el
    // guardado —el backfill de asesores todavía puede estar corriendo— pero el
    // panel necesita el número para avisar en vez de mostrar un catálogo vacío.
    let matched = 0;
    if (name && tenantId) {
      const m = await db.query(
        `SELECT COUNT(*)::int AS n FROM properties
          WHERE tenant_id = $1 AND active = TRUE
            AND ${_AGENT_NORM(_AGENT_COL)} = ${_AGENT_NORM('$2')}`,
        [tenantId, name]).catch(() => ({ rows: [{ n: 0 }] }));
      matched = m.rows[0].n;
    }
    res.json({ ok: true, agent_name: name, matched });
  } catch (e) {
    if (/c21_agent_name/.test(e.message)) return res.status(503).json({ error: 'Falta la migración de asesor por usuario (deploy pendiente).' });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.164 — AGENDA DEL EQUIPO (solo dueño): agrega las reservas de Cal de TODOS los
// vendedores del tenant para ver de un vistazo quién agendó citas y quién no, con KPIs.
router.get('/admin/team-reservations', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const period = (req.query.period === 'month') ? 'month' : 'week';
  const now = new Date();
  let from, to;
  if (period === 'week') {
    // v0.9.205: ventana MÓVIL (hoy 00:00 → +7 días) en vez de lunes-a-lunes. Antes una cita a
    // 2 días pero "la otra semana" (ej. sáb 20 → la cita el mar 24) quedaba oculta y el vendedor
    // figuraba "sin citas" pese a tenerlas. Ahora muestra lo que viene en los próximos 7 días.
    from = new Date(now); from.setHours(0, 0, 0, 0);
    to = new Date(from); to.setDate(from.getDate() + 7);
  } else {
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }
  const fromIso = from.toISOString(), toIso = to.toISOString();
  const lo = from.getTime(), hi = to.getTime();
  try {
    const us = await db.query(
      'SELECT id, display_name, email, cal_api_key, booking_enabled FROM tenant_users WHERE tenant_id = $1 AND NOT COALESCE((to_jsonb(tenant_users) ->> \'hidden_from_tenant\')::boolean, FALSE) ORDER BY LOWER(COALESCE(display_name, email))',
      [tenantId]
    );
    const axios = require('axios');
    const users = await Promise.all(us.rows.map(async (u) => {
      const name = u.display_name || u.email || ('Usuario ' + u.id);
      // v0.9.165: citas in-house (agendador propio) del vendedor en el rango.
      const inhouse = await _fetchInhouse(u.id, fromIso, toIso);
      let cal = [], calError;
      if (u.cal_api_key) {
        const apiKey = decryptSafe(u.cal_api_key);
        if (apiKey) {
          try {
            const r = await axios.get('https://api.cal.com/v2/bookings', {
              params: { afterStart: fromIso, beforeEnd: toIso, take: 100 },
              headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': '2024-08-13' },
              timeout: 15000,
            });
            const raw = r.data?.data || r.data?.bookings || [];
            cal = (Array.isArray(raw) ? raw : []).map(b => ({
              id: b.uid || b.id,
              title: b.title || b.eventType?.title || 'Reserva',
              start: b.start || b.startTime,
              status: b.status,
              attendee: (b.attendees && b.attendees[0]) ? (b.attendees[0].name || b.attendees[0].email) : (b.responses?.name?.value || null),
            })).filter(b => {
              if (b.status && /cancel/i.test(String(b.status))) return false;
              const s = b.start ? new Date(b.start).getTime() : NaN;
              return !isNaN(s) && s >= lo && s < hi;
            });
          } catch (e) { calError = 'Cal: ' + (e.response?.status === 401 ? 'key inválida' : (e.response?.data?.error?.message || e.message)); }
        }
      }
      const bookings = inhouse.concat(cal).sort((a, b) => new Date(a.start) - new Date(b.start));
      const configured = !!u.booking_enabled || !!u.cal_api_key;
      return { user_id: u.id, name, configured, count: bookings.length, bookings: bookings.slice(0, 50), error: calError };
    }));
    const configured = users.filter(u => u.configured);
    const kpis = {
      total_appts: users.reduce((s, u) => s + (u.count || 0), 0),
      sellers_total: users.length,
      sellers_configured: configured.length,
      with_appts: configured.filter(u => u.count > 0).length,
      without_appts: configured.filter(u => u.count === 0).length,
      not_configured: users.filter(u => !u.configured).length,
    };
    res.json({ ok: true, period, range: { from: fromIso, to: toIso }, users, kpis });
  } catch (e) {
    if (/cal_api_key|tenant_users/.test(e.message)) return res.json({ ok: true, period, users: [], kpis: {}, need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// ============ v0.9.165 — AGENDADOR PROPIO (citas sin Cal.com) ============
// Cada vendedor define su disponibilidad y tiene un link público /agendar/:token.
// El lead elige un slot libre y la cita se guarda en `appointments` (provider 'inhouse').
function _publicBase() { return process.env.PUBLIC_BASE_URL || 'https://app.sg-ventas.com'; }

// Genera slots candidatos (ISO UTC) para los próximos `days` días según la disponibilidad.
// Bolivia = UTC-4 sin horario de verano → offset fijo (tz_offset_min = local - UTC, default -240).
// v0.9.514 — DEPRECADO como fuente de verdad. El cálculo real vive en agenda.js
// (una sola implementación para el link público, el bot y el panel). Esta función
// queda solo como envoltorio síncrono para los pocos usos que no pueden esperar
// a la config; si podés, usá agenda.generarSlots directamente.
function _genSlots(u, days) {
  const offsetMin = Number.isFinite(+u.tz_offset_min) ? +u.tz_offset_min : -240;
  const slotMin = Math.max(10, Number(u.slot_minutes) || 30);
  const availDays = String(u.avail_days || '1,2,3,4,5').split(',').map(s => parseInt(s, 10)).filter(n => n >= 1 && n <= 7);
  const [sh, sm] = String(u.avail_start || '09:00').split(':').map(Number);
  const [eh, em] = String(u.avail_end || '18:00').split(':').map(Number);
  const startMo = (sh || 0) * 60 + (sm || 0), endMo = (eh || 0) * 60 + (em || 0);
  // v0.9.166: pausa diaria (almuerzo) — minutos del día a excluir todos los días.
  let bsMo = null, beMo = null;
  if (u.break_start && u.break_end && /^\d{1,2}:\d{2}$/.test(u.break_start) && /^\d{1,2}:\d{2}$/.test(u.break_end)) {
    const [bh, bm] = String(u.break_start).split(':').map(Number), [xh, xm] = String(u.break_end).split(':').map(Number);
    bsMo = bh * 60 + bm; beMo = xh * 60 + xm;
  }
  const nowUtc = Date.now();
  const localNow = new Date(nowUtc + offsetMin * 60000); // sus campos UTC == hora local de pared
  const out = [];
  for (let d = 0; d < (days || 14); d++) {
    const probe = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + d));
    let dow = probe.getUTCDay(); dow = dow === 0 ? 7 : dow;
    if (!availDays.includes(dow)) continue;
    for (let m = startMo; m + slotMin <= endMo; m += slotMin) {
      const localMs = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(), 0, m, 0);
      const utcMs = localMs - offsetMin * 60000;
      if (utcMs <= nowUtc + 30 * 60000) continue; // mínimo 30 min de anticipación
      if (bsMo != null && m < beMo && m + slotMin > bsMo) continue; // pausa diaria
      out.push(new Date(utcMs).toISOString());
    }
  }
  return { slots: out, slotMin };
}

async function _userByToken(token) {
  if (!token) return null;
  const r = await db.query(
    `SELECT tu.*, t.name AS business_name FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
       WHERE tu.booking_token = $1 AND tu.booking_enabled = TRUE`, [token]);
  return r.rows[0] || null;
}

// Citas in-house de un vendedor (para el calendario y la agenda del equipo).
async function _fetchInhouse(userId, from, to) {
  if (!userId) return [];
  try {
    const params = [userId]; let range = `AND starts_at > NOW() - INTERVAL '1 hour'`;
    if (from && to) { params.push(from, to); range = `AND starts_at >= $2 AND starts_at < $3`; }
    const r = await db.query(
      `SELECT id, attendee_name, attendee_phone, starts_at, ends_at, status FROM appointments
        WHERE user_id = $1 AND provider = 'inhouse' AND status NOT IN ('cancelled','no_show','pending') ${range}
        ORDER BY starts_at ASC LIMIT 300`, params);
    return r.rows.map(a => ({ id: 'inh-' + a.id, title: a.attendee_name || 'Cita', start: a.starts_at, end: a.ends_at, status: a.status, attendee: a.attendee_name, attendee_email: null, attendee_phone: a.attendee_phone, source: 'inhouse' }));
  } catch (e) { return []; }
}

// v0.9.173: TODA la agenda in-house del negocio (para que el dueño la vea completa en
// Reservas). Igual que _fetchInhouse pero por tenant + nombre del vendedor en el título.
async function _fetchInhouseTenant(tenantId, from, to) {
  if (!tenantId) return [];
  try {
    const params = [tenantId]; let range = `AND a.starts_at > NOW() - INTERVAL '1 hour'`;
    if (from && to) { params.push(from, to); range = `AND a.starts_at >= $2 AND a.starts_at < $3`; }
    const r = await db.query(
      `SELECT a.id, a.attendee_name, a.attendee_phone, a.starts_at, a.ends_at, a.status, u.display_name AS seller
         FROM appointments a LEFT JOIN tenant_users u ON u.id = a.user_id
        WHERE a.tenant_id = $1 AND a.provider = 'inhouse' AND a.status NOT IN ('cancelled','no_show','pending') ${range}
        ORDER BY a.starts_at ASC LIMIT 500`, params);
    return r.rows.map(a => ({ id: 'inh-' + a.id, title: a.attendee_name || 'Cita', start: a.starts_at, end: a.ends_at, status: a.status, attendee: a.attendee_name, attendee_email: null, attendee_phone: a.attendee_phone, seller: a.seller || null, source: 'inhouse' }));
  } catch (e) { return []; }
}

// v0.9.202: citas PENDIENTES de asignar (pool "por tomar"). user_id NULL, status 'pending'.
// Son del tenant entero (cualquier asesor puede tomarlas) → se muestran en el calendario de
// todos, en otro color, para que el pendiente salte a la vista. flag pending:true.
// v0.9.489 — agentLines: null = sin restricción; array = solo esas líneas (+ las citas
// sin conversación o sin línea, que no pertenecen a ninguna y si no quedarían huérfanas).
async function _fetchInhousePending(tenantId, from, to, agentLines) {
  if (!tenantId) return [];
  try {
    const params = [tenantId]; let range = `AND a.starts_at > NOW() - INTERVAL '1 hour'`;
    if (from && to) { params.push(from, to); range = `AND a.starts_at >= $2 AND a.starts_at < $3`; }
    let lnF = '';
    if (agentLines) {
      const ids = agentLines.map(n => parseInt(n, 10)).filter(Number.isFinite);
      lnF = ids.length
        ? ` AND (c.id IS NULL OR c.line_id IS NULL OR c.line_id IN (${ids.join(',')}))`
        : ` AND (c.id IS NULL OR c.line_id IS NULL)`;
    }
    const r = await db.query(
      `SELECT a.id, a.attendee_name, a.attendee_phone, a.starts_at, a.ends_at, c.phone AS conv_phone
         FROM appointments a LEFT JOIN conversations c ON c.id = a.conversation_id
        WHERE a.tenant_id = $1 AND a.provider = 'inhouse' AND a.status = 'pending' ${range}${lnF}
        ORDER BY a.starts_at ASC LIMIT 200`, params);
    return r.rows.map(a => ({ id: 'inh-' + a.id, title: a.attendee_name || 'Cliente', start: a.starts_at, end: a.ends_at, status: 'pending', pending: true, attendee: a.attendee_name, attendee_email: null, attendee_phone: a.attendee_phone || a.conv_phone || null, seller: null, source: 'inhouse' }));
  } catch (e) { return []; }
}

// v0.9.166: bloqueos puntuales (ausencias/vacaciones) del vendedor.
async function _fetchBlocks(userId) {
  if (!userId) return [];
  try {
    const r = await db.query(`SELECT id, starts_at, ends_at, reason FROM user_time_blocks WHERE user_id = $1 AND ends_at > NOW() - INTERVAL '1 hour' ORDER BY starts_at ASC`, [userId]);
    return r.rows;
  } catch (e) { return []; }
}
function _slotBlocked(slotMs, blocks) {
  for (const b of blocks) { const s = new Date(b.starts_at).getTime(), e = new Date(b.ends_at).getTime(); if (slotMs >= s && slotMs < e) return true; }
  return false;
}

// GET /api/admin/me/availability — disponibilidad + link del usuario logueado.
router.get('/admin/me/availability', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.json({ ok: true, availability: {} });
  try {
    const r = await db.query(
      `SELECT booking_token, booking_enabled, avail_days, avail_start, avail_end, slot_minutes, tz_offset_min, break_start, break_end, booking_contact_phone FROM tenant_users WHERE id = $1`, [req.userId]);
    const u = r.rows[0] || {};
    const blocks = await _fetchBlocks(req.userId);
    res.json({ ok: true, availability: u, blocks, booking_url: u.booking_token ? `${_publicBase()}/agendar/${u.booking_token}` : null });
  } catch (e) {
    if (/booking_token|avail_/.test(e.message)) return res.json({ ok: true, availability: {}, need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/admin/me/availability — guardar disponibilidad + activar (genera token la 1ra vez).
router.patch('/admin/me/availability', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.status(400).json({ error: 'Sesión sin usuario' });
  const b = req.body || {};
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.avail_days != null) add('avail_days', String(b.avail_days).replace(/[^0-9,]/g, '') || '1,2,3,4,5');
  if (b.avail_start != null && /^\d{1,2}:\d{2}$/.test(b.avail_start)) add('avail_start', b.avail_start);
  if (b.avail_end != null && /^\d{1,2}:\d{2}$/.test(b.avail_end)) add('avail_end', b.avail_end);
  if (b.slot_minutes != null) add('slot_minutes', Math.min(240, Math.max(10, parseInt(b.slot_minutes, 10) || 30)));
  if (b.tz_offset_min != null) add('tz_offset_min', parseInt(b.tz_offset_min, 10) || -240);
  if (b.break_start !== undefined) add('break_start', (b.break_start && /^\d{1,2}:\d{2}$/.test(b.break_start)) ? b.break_start : null);
  if (b.break_end !== undefined) add('break_end', (b.break_end && /^\d{1,2}:\d{2}$/.test(b.break_end)) ? b.break_end : null);
  if (b.booking_enabled != null) add('booking_enabled', !!b.booking_enabled);
  // v0.9.173: teléfono de contacto que Aitana le pasa al cliente al confirmar la cita.
  if (b.booking_contact_phone !== undefined) add('booking_contact_phone', String(b.booking_contact_phone || '').slice(0, 40).trim() || null);
  try {
    const cur = await db.query('SELECT booking_token FROM tenant_users WHERE id = $1', [req.userId]);
    if (!cur.rows[0] || !cur.rows[0].booking_token) add('booking_token', require('crypto').randomBytes(9).toString('hex'));
    if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' });
    vals.push(req.userId);
    await db.query(`UPDATE tenant_users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    const r = await db.query('SELECT booking_token FROM tenant_users WHERE id = $1', [req.userId]);
    res.json({ ok: true, booking_url: r.rows[0] && r.rows[0].booking_token ? `${_publicBase()}/agendar/${r.rows[0].booking_token}` : null });
  } catch (e) {
    if (/booking_token|avail_/.test(e.message)) return res.status(503).json({ error: 'Falta la migración del agendador (deploy pendiente).' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/me/blocks — bloquear una fecha/hora (ausencia/vacaciones). Body:
// { date 'YYYY-MM-DD', all_day, from 'HH:MM', to 'HH:MM', reason }.
router.post('/admin/me/blocks', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.status(400).json({ error: 'Sesión sin usuario' });
  const b = req.body || {};
  const date = String(b.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Elegí una fecha válida' });
  try {
    const ur = await db.query('SELECT tenant_id, tz_offset_min FROM tenant_users WHERE id = $1', [req.userId]);
    const u = ur.rows[0]; if (!u) return res.status(404).json({ error: 'usuario' });
    const off = Number.isFinite(+u.tz_offset_min) ? +u.tz_offset_min : -240;
    const [Y, M, D] = date.split('-').map(Number);
    let fromMo = 0, toMo = 24 * 60;
    if (!b.all_day) {
      if (!/^\d{1,2}:\d{2}$/.test(b.from || '') || !/^\d{1,2}:\d{2}$/.test(b.to || '')) return res.status(400).json({ error: 'Poné desde y hasta (o marcá todo el día)' });
      const [fh, fm] = String(b.from).split(':').map(Number), [th, tm] = String(b.to).split(':').map(Number);
      fromMo = fh * 60 + fm; toMo = th * 60 + tm;
      if (toMo <= fromMo) return res.status(400).json({ error: 'El "hasta" debe ser mayor que el "desde"' });
    }
    const startUtc = Date.UTC(Y, M - 1, D, 0, fromMo) - off * 60000;
    const endUtc = Date.UTC(Y, M - 1, D, 0, toMo) - off * 60000;
    const ins = await db.query(
      `INSERT INTO user_time_blocks (tenant_id, user_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,$5) RETURNING id, starts_at, ends_at, reason`,
      [u.tenant_id, req.userId, new Date(startUtc).toISOString(), new Date(endUtc).toISOString(), String(b.reason || '').slice(0, 120) || null]);
    res.json({ ok: true, block: ins.rows[0] });
  } catch (e) {
    if (/user_time_blocks/.test(e.message)) return res.status(503).json({ error: 'Falta la migración del agendador (deploy pendiente).' });
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/me/blocks/:id — quitar un bloqueo propio.
router.delete('/admin/me/blocks/:id', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.status(400).json({ error: 'Sesión sin usuario' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    await db.query('DELETE FROM user_time_blocks WHERE id = $1 AND user_id = $2', [id, req.userId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/public/booking/:token — público (sin login): vendedor + negocio + slots libres.
router.get('/public/booking/:token', async (req, res) => {
  try {
    const u = await _userByToken(String(req.params.token || ''));
    if (!u) return res.status(404).json({ error: 'Link de agenda no válido o desactivado.' });
    const { slots, slotMin } = _genSlots(u, 14);
    const booked = await db.query(
      `SELECT starts_at FROM appointments WHERE user_id = $1 AND status NOT IN ('cancelled','no_show') AND starts_at > NOW() - INTERVAL '1 hour'`,
      [u.id]).catch(() => ({ rows: [] }));
    const blocks = await _fetchBlocks(u.id);
    const taken = booked.rows.map(r => new Date(r.starts_at).getTime());
    const free = slots.filter(iso => { const s = new Date(iso).getTime(); if (_slotBlocked(s, blocks)) return false; return !taken.some(t => Math.abs(t - s) < slotMin * 60000); });
    res.json({ ok: true, seller: u.display_name || 'Asesor', business: u.business_name || 'Agenda', slot_minutes: slotMin, tz_offset_min: Number(u.tz_offset_min) || -240, slots: free });
  } catch (e) {
    if (/booking_token|avail_|appointments/.test(e.message)) return res.status(503).json({ error: 'Agenda no disponible (deploy pendiente).' });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/public/booking/:token — público: el lead reserva un slot { name, phone, start(ISO) }.
router.post('/public/booking/:token', async (req, res) => {
  try {
    const u = await _userByToken(String(req.params.token || ''));
    if (!u) return res.status(404).json({ error: 'Link de agenda no válido o desactivado.' });
    const name = String(req.body && req.body.name || '').trim();
    const phone = String(req.body && req.body.phone || '').trim();
    const startMs = Date.parse(String(req.body && req.body.start || ''));
    if (!name) return res.status(400).json({ error: 'Poné tu nombre' });
    if (!startMs || startMs < Date.now()) return res.status(400).json({ error: 'Elegí un horario válido' });
    // v0.9.514 — una sola validación para los tres caminos de alta (ver agenda.js).
    // Antes acá se comparaba solo la hora de INICIO contra las citas existentes, así
    // que una visita de 90 minutos no tapaba los slots siguientes.
    // v0.9.523 — config por línea: el link público es por-asesor, así que si el asesor
    // tiene una sola línea usamos su config; si no, el default del tenant.
    const _line = await agenda.lineIdOfUser(u.id);
    const _cfg = await agenda.getConfig(u.tenant_id, _line);
    const _chk = agenda.puedeReservar({
      startIso: new Date(startMs).toISOString(), user: u, cfg: _cfg,
      citas: (await agenda.citasDe(u.id, _cfg.max_days_ahead)).concat(await agenda.citasPendientesDelTenant(u.tenant_id, _cfg.max_days_ahead)),
      bloqueos: await _fetchBlocks(u.id),
      businessHours: await agenda.businessHoursDe(u.tenant_id, _line),
    });
    if (!_chk.ok) return res.status(409).json({ error: _chk.error });
    const slotMin = _chk.slotMin;
    // v0.9.167: si el teléfono coincide con una conversación del tenant, enlazar la cita
    // (habilita el recordatorio por WhatsApp + le da contexto al vendedor).
    let convId = null, leadId = null;
    const digits = phone.replace(/\D/g, '');
    if (digits.length >= 7) {
      const cm = await db.query(
        `SELECT c.id, l.id AS lead_id FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id
          WHERE c.tenant_id = $1 AND regexp_replace(COALESCE(c.phone,''), '\\D', '', 'g') LIKE '%' || $2
          ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`,
        [u.tenant_id, digits.slice(-8)]).catch(() => ({ rows: [] }));
      if (cm.rows[0]) { convId = cm.rows[0].id; leadId = cm.rows[0].lead_id; }
    }
    const ins = await db.query(
      `INSERT INTO appointments (tenant_id, user_id, conversation_id, lead_id, provider, attendee_name, attendee_phone, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4,'inhouse',$5,$6,$7,$8,'scheduled') RETURNING id`,
      [u.tenant_id, u.id, convId, leadId, name.slice(0, 200), phone.slice(0, 64) || null, new Date(startMs).toISOString(), new Date(startMs + slotMin * 60000).toISOString()]);
    console.log(`📅 [agenda] cita #${ins.rows[0].id} con ${u.display_name} (tenant ${u.tenant_id})`);
    res.json({ ok: true, id: ins.rows[0].id, seller: u.display_name, start: new Date(startMs).toISOString() });
  } catch (e) {
    if (/appointments|booking_token/.test(e.message)) return res.status(503).json({ error: 'Agenda no disponible (deploy pendiente).' });
    res.status(500).json({ error: e.message });
  }
});
// POST /api/bot/software-sale — v0.9.528: Aitana (modo software) vende el sistema de
// Inventario. n8n llama acá con { tenant_id, phone, biz_name, admin_name, admin_email, plan }
// cuando el cliente eligió plan; se genera el QR Baneco y se le manda. El alta de la cuenta
// se dispara sola al confirmarse el pago (worker en server.js). Ver software-sales.js.
router.post('/bot/software-sale', requireAdminOrN8n, (req, res) => require('./software-sales').handleSale(req, res));

// POST /api/bot/create-task — v0.9.541: Aitana (modo secretaria/asistente) captura un PENDIENTE y
// lo deja como Tarea en el CRM. La emite el bot vía n8n cuando alguien deja un pedido/encargo para
// el equipo. Body: { tenant_id, phone, title, description?, priority?(low|normal|high) }. Se asigna
// al asesor de la conversación (o queda sin asignar). Auth: X-CRM-Secret (n8n) o X-Admin-Token.
router.post('/bot/create-task', requireAdminOrN8n, async (req, res) => {
  const tenantId = Number(req.body && req.body.tenant_id) || 1;
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  const title = String((req.body && req.body.title) || '').trim();
  const description = String((req.body && req.body.description) || '').trim() || null;
  const prioIn = String((req.body && req.body.priority) || '').trim().toLowerCase();
  const priority = ['low', 'normal', 'high'].includes(prioIn) ? prioIn : 'normal';
  if (!title) {
    return res.json({ ok: true, ready: false, missing: ['title'], message: 'Decime en una frase qué necesitás que anote y lo dejo registrado.' });
  }
  try {
    // v0.9.541 — SOLO CANAL TELEGRAM (secretaria). Resolvemos la conversación y su canal;
    // si no es telegram, no creamos nada (sin pisar la respuesta del bot en otros canales).
    let convId = null, leadId = null, assignedTo = null, channel = null;
    if (phone) {
      const c = await db.query(
        `SELECT c.id, c.assigned_to, c.channel, l.id AS lead_id
           FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id
          WHERE c.tenant_id = $1 AND regexp_replace(COALESCE(c.phone,''),'\\D','','g') LIKE '%' || $2
          ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`, [tenantId, phone.slice(-8)]).catch(() => ({ rows: [] }));
      if (c.rows[0]) { convId = c.rows[0].id; leadId = c.rows[0].lead_id; assignedTo = c.rows[0].assigned_to || null; channel = c.rows[0].channel || null; }
    }
    if (channel !== 'telegram') {
      console.log(`↩️  [bot/create-task] omitido: canal "${channel || 'desconocido'}" (la captura de pendientes es solo de Telegram)`);
      return res.json({ ok: true, ready: false, skipped: 'not_telegram' });
    }
    // Se anota como pendiente GENÉRICO en Tareas, marcado como Telegram para no mezclarse con WhatsApp.
    const finalTitle = ('📩 Pendiente (Telegram): ' + title).slice(0, 200);
    const finalDesc = ('Encargo recibido por Telegram.' + (description ? '\n\n' + description : '')).slice(0, 2000);
    const ins = await db.query(
      `INSERT INTO tasks (tenant_id, conversation_id, lead_id, title, description, task_type, priority, auto_created, assigned_to)
       VALUES ($1, $2, $3, $4, $5, 'other', $6, true, $7) RETURNING id`,
      [tenantId, convId, leadId, finalTitle, finalDesc, priority, assignedTo]);
    console.log(`📝 [bot/create-task] pendiente (Telegram) creado (tenant ${tenantId}, conv ${convId || '-'}, prio ${priority}): "${title.slice(0, 60)}"`);
    return res.json({ ok: true, ready: true, task_id: ins.rows[0].id, message: 'Listo, ya lo dejé anotado ✅. Apenas puedan te responden. ¿Algo más que quieras dejar registrado?' });
  } catch (e) {
    console.error('[bot/create-task]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════
// v0.9.545 — INTEGRACIÓN TOTAL con el sistema de Inventario (modo Artículos).
// El dueño vincula su cuenta (email+password una vez, no se guarda la clave);
// Aitana vende con catálogo/stock vivos y registra ventas reales allá.
// SOLO modo artículos: inmuebles/retail/vehículos locales no pasan por acá.
// ═════════════════════════════════════════════════════════════════════
router.post('/admin/inventario/link', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña de Inventario son requeridos' });
  try {
    const il = require('./inventario-link');
    if (!il.invSecret()) return res.status(503).json({ error: 'Falta INVENTARIO_INTEGRATION_SECRET en el servidor' });
    const resp = await fetch(il.invUrl() + '/api/integration/resolve-tenant', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': il.invSecret() },
      body: JSON.stringify({ email, password }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.status === 404) return res.status(503).json({ error: 'Inventario todavía no publica /resolve-tenant (ver handoff Tarea 1)' });
    if (!resp.ok || !data.ok) return res.status(401).json({ error: (data && data.error) || 'Credenciales inválidas' });
    const branch = (data.branches && data.branches[0] && data.branches[0].name) || null;
    await db.query(`UPDATE tenants SET inv_link_tenant_id=$2, inv_link_name=$3, inv_link_branch=$4, inv_link_branches=$5::jsonb, inv_link_at=NOW() WHERE id=$1`,
      [tenantId, data.tenant_id, data.tenant_name || null, branch, JSON.stringify(data.branches || [])]);
    il.bustLink(tenantId);
    console.log(`🔗 [inv-link] tenant ${tenantId} vinculado a Inventario tenant ${data.tenant_id} (${data.tenant_name})`);
    res.json({ ok: true, name: data.tenant_name, inv_tenant_id: data.tenant_id, branches: data.branches || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// v0.9.548 — cambiar la sucursal por defecto de los pedidos del bot (los ENVÍOS descuentan de acá)
router.post('/admin/inventario/branch', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  const branch = String((req.body && req.body.branch) || '').trim().slice(0, 80);
  if (!branch) return res.status(400).json({ error: 'branch requerido' });
  try {
    await db.query(`UPDATE tenants SET inv_link_branch=$2 WHERE id=$1`, [tenantId, branch]);
    require('./inventario-link').bustLink(tenantId);
    console.log(`🏬 [inv-link] tenant ${tenantId}: sucursal del bot → "${branch}"`);
    res.json({ ok: true, branch });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admin/inventario/unlink', requireTenantSession, requirePerm('catalog'), async (req, res) => {
  const tenantId = invTenant(req);
  try {
    await db.query(`UPDATE tenants SET inv_link_tenant_id=NULL, inv_link_name=NULL, inv_link_branch=NULL, inv_link_at=NULL WHERE id=$1`, [tenantId]);
    require('./inventario-link').bustLink(tenantId);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// v0.9.546 — catálogo vivo para el PANEL (con cantidades: es el dueño mirando su negocio)
router.get('/admin/inventario/live-catalog', requireTenantSession, async (req, res) => {
  try {
    const items = await require('./inventario-link').panelCatalog(invTenant(req));
    if (!items) return res.json({ ok: false, linked: false, items: [] });
    res.json({ ok: true, items });
  } catch (e) { res.json({ ok: false, items: [], error: e.message }); }
});
router.get('/admin/inventario/status', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req);
  try {
    const il = require('./inventario-link');
    const link = await il.getLink(tenantId);
    if (!link) return res.json({ linked: false });
    const admins = await il.getAdmins(tenantId);
    const branches = await il.getBranches(tenantId).catch(() => []);
    res.json({ linked: true, name: link.name, inv_tenant_id: link.inv_tenant_id, branch: link.branch, branches, admins });
  } catch (e) { res.json({ linked: false, error: e.message }); }
});

// Acciones del bot (n8n) — todas gateadas por el vínculo; sin vínculo devuelven skipped.
router.post('/bot/inventario/search', requireAdminOrN8n, async (req, res) => {
  try {
    const r = await require('./inventario-link').searchProducts(Number(req.body.tenant_id) || 1, String(req.body.q || ''));
    res.json(r || { ok: false, skipped: 'not_linked' });
  } catch (e) { res.json({ message: 'No pude consultar el catálogo ahora mismo, dame un momento y volvé a preguntarme. 🙏' }); }
});
router.post('/bot/inventario/order', requireAdminOrN8n, async (req, res) => {
  try {
    const il = require('./inventario-link');
    const tenantId = Number(req.body.tenant_id) || 1;
    const admin = await il.adminFor(tenantId, req.body.phone);
    if (admin && admin.can_transact === false) return res.json({ message: 'Tu número no tiene habilitado registrar ventas — pedile al dueño que te active el permiso desde Inventario.' });
    const r = await il.registerSale(tenantId, { phone: req.body.phone, customer_name: req.body.customer_name, items: req.body.items, branch: req.body.branch, admin: !!admin });
    res.json(r || { ok: false, skipped: 'not_linked' });
  } catch (e) { res.json({ message: 'No pude registrar el pedido ahora mismo 🙏. Intentalo de nuevo en un momento.' }); }
});
router.post('/bot/inventario/balance', requireAdminOrN8n, async (req, res) => {
  try {
    const r = await require('./inventario-link').customerBalance(Number(req.body.tenant_id) || 1, { phone: req.body.phone, name: req.body.name });
    res.json(r || { ok: false, skipped: 'not_linked' });
  } catch (e) { res.json({ message: 'No pude consultar el saldo ahora mismo. Probá en un momento. 🙏' }); }
});
router.post('/bot/inventario/admin-summary', requireAdminOrN8n, async (req, res) => {
  try {
    const il = require('./inventario-link');
    const tenantId = Number(req.body.tenant_id) || 1;
    if (!(await il.adminFor(tenantId, req.body.phone))) return res.json({ message: 'Esa información es solo para administradores del negocio. 😉' });
    const r = await il.adminSummary(tenantId, { date: req.body.date });
    res.json(r || { ok: false, skipped: 'not_linked' });
  } catch (e) { res.json({ message: 'No pude traer el resumen ahora. Probá en un momento.' }); }
});
router.post('/bot/inventario/admin-lowstock', requireAdminOrN8n, async (req, res) => {
  try {
    const il = require('./inventario-link');
    const tenantId = Number(req.body.tenant_id) || 1;
    if (!(await il.adminFor(tenantId, req.body.phone))) return res.json({ message: 'Esa información es solo para administradores del negocio. 😉' });
    const r = await il.adminLowStock(tenantId);
    res.json(r || { ok: false, skipped: 'not_linked' });
  } catch (e) { res.json({ message: 'No pude traer el stock bajo ahora. Probá en un momento.' }); }
});

// GET /api/admin/software/inventario-plans — v0.9.537: el panel (pestaña Planes) muestra en
// SOLO LECTURA los planes reales que define Inventario, así el dueño ve el catálogo que Aitana
// vende y cobra, sin confundirse con la tabla local. Si Inventario no responde → source:'local'.
router.get('/admin/software/inventario-plans', requireTenantSession, async (req, res) => {
  try {
    const plans = await require('./software-sales').getInvPlans();
    res.json({ ok: true, source: (plans && plans.length) ? 'inventario' : 'local', plans: plans || [] });
  } catch (e) {
    res.json({ ok: false, source: 'local', plans: [], error: e.message });
  }
});

// POST /api/bot/book-appointment — AGENDAR DIRECTO DESDE EL CHAT (lo llama n8n cuando Aitana
// decide reservar). Body: { tenant_id, phone, start }. start = 'YYYY-MM-DDTHH:MM' (hora local)
// o ISO con zona. Resuelve el vendedor (asignado → dueño), valida disponibilidad y reserva;
// si no está libre devuelve alternativas + el link para que el cliente elija.
router.post('/bot/book-appointment', requireAdminOrN8n, async (req, res) => {
  // v0.9.175 — MODELO POOL: Aitana NO agenda directo a un vendedor. Crea una cita PENDIENTE
  // (sin dueño) con la hora pedida y notifica al equipo; cualquier asesor la "toma" (o el
  // dueño la asigna) desde el panel y coordina con el cliente.
  const tenantId = Number(req.body && req.body.tenant_id) || 1;
  const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
  const startRaw = String((req.body && req.body.start) || '').trim();
  const off = -240; // negocio en Bolivia (UTC-4)
  let slotMin = 30; // se reemplaza abajo por la duración configurada de la agenda
  const _fmtLocal = (iso) => {
    const d = new Date(new Date(iso).getTime() + off * 60000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  };
  try {
    // resolver conversación / lead / nombre del contacto (para mostrar quién pidió la visita)
    let convId = null, leadId = null, contactName = null;
    if (phone) {
      const c = await db.query(
        `SELECT c.id, c.contact_name, l.id AS lead_id
           FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id
          WHERE c.tenant_id = $1 AND regexp_replace(COALESCE(c.phone,''),'\\D','','g') LIKE '%' || $2
          ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`, [tenantId, phone.slice(-8)]).catch(() => ({ rows: [] }));
      if (c.rows[0]) { convId = c.rows[0].id; leadId = c.rows[0].lead_id; contactName = c.rows[0].contact_name; }
    }
    // hora pedida (YYYY-MM-DDTHH:MM local o ISO). Si no hay hora válida, la pedimos.
    let startMs = NaN;
    const m = startRaw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
    if (m) startMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 60000;
    else if (startRaw) startMs = Date.parse(startRaw);
    if (isNaN(startMs)) {
      return res.json({ ok: true, booked: false, reason: 'falta_hora', message: '¿Qué día y a qué hora te quedaría bien la visita? Así dejo tu solicitud lista para que un asesor te confirme 🙂' });
    }
    const startIso = new Date(startMs).toISOString();
    // dedupe: si ya hay una solicitud pendiente de esta conversación a esa hora, no duplicar.
    if (convId) {
      const dup = await db.query(
        `SELECT id FROM appointments WHERE conversation_id = $1 AND status = 'pending'
           AND ABS(EXTRACT(EPOCH FROM (starts_at - $2::timestamptz))) < 1800 LIMIT 1`,
        [convId, startIso]).catch(() => ({ rows: [] }));
      if (dup.rows[0]) {
        // v0.9.359 — message: null EN EL DEDUPE. Antes devolvía "Ya tengo anotada tu solicitud…"
        // y n8n PISABA la respuesta de Gemini con ese texto → si el cliente preguntaba otra cosa
        // (caso real MERCALOTES: "¿me pasás la ubicación y una foto?") y Gemini re-emitía
        // "agendar" de la cita ya existente, el cliente recibía la confirmación repetida en vez
        // de su respuesta. Con message:null, n8n conserva la respuesta original del bot.
        return res.json({ ok: true, booked: false, reason: 'ya_pendiente', message: null });
      }
    }
    // v0.9.360 — REPROGRAMACIÓN: si el cliente agenda un horario NUEVO teniendo otra solicitud
    // pendiente SIN TOMAR, la anterior se cancela sola (caso real MERCALOTES: "mejor el sábado"
    // dejaba DOS pendientes en Por tomar y el asesor podía confirmar la equivocada). Solo se
    // cancelan las pending futuras sin dueño ni claim — si un asesor ya la tomó, no se toca.
    if (convId) {
      await db.query(
        `UPDATE appointments SET status = 'cancelled', cancellation_reason = 'Reprogramada por el cliente desde el chat', updated_at = NOW()
          WHERE conversation_id = $1 AND status = 'pending' AND user_id IS NULL AND claimed_at IS NULL AND starts_at > NOW()`,
        [convId]).catch((e) => console.warn('[book-appointment] cancelar previas falló:', e.message));
    }
    // v0.9.514 — VALIDACIÓN DE LA AGENDA. Antes este camino no verificaba NADA: ni
    // choque de horario, ni día hábil, ni horario de atención. Dos clientes distintos
    // podían quedar a la misma hora y Aitana aceptaba un domingo a las 3 de la mañana.
    // Se valida contra la agenda del asesor asignado (o la del negocio si no hay).
    try {
      const _u = await agenda.agendaDeReferencia(tenantId, convId);
      if (_u) {
        // v0.9.523 — reglas + horarios de atención de la LÍNEA de esta conversación
        // (override) o del default del tenant.
        const _line = await agenda.lineIdOfConversation(convId);
        const _cfg = await agenda.getConfig(tenantId, _line);
        slotMin = Math.max(5, Number(_u.slot_minutes) || _cfg.slot_minutes || 30);
        const _chk = agenda.puedeReservar({
          startIso, user: _u, cfg: _cfg,
          citas: (await agenda.citasDe(_u.id, _cfg.max_days_ahead)).concat(await agenda.citasPendientesDelTenant(tenantId, _cfg.max_days_ahead)),
          bloqueos: await _fetchBlocks(_u.id),
          businessHours: await agenda.businessHoursDe(tenantId, _line),
        });
        if (!_chk.ok) {
          // Se devuelven alternativas para que Aitana proponga en vez de solo negar.
          const _libres = agenda.generarSlots({
            user: _u, cfg: _cfg,
            citas: (await agenda.citasDe(_u.id, _cfg.max_days_ahead)).concat(await agenda.citasPendientesDelTenant(tenantId, _cfg.max_days_ahead)),
            bloqueos: await _fetchBlocks(_u.id),
            businessHours: await agenda.businessHoursDe(tenantId, _line),
          }).slots.slice(0, 3).map(_fmtLocal);
          console.log(`📅 [book-appointment] tenant ${tenantId}: RECHAZADA ${startIso} — ${_chk.error}`);
          return res.json({
            ok: true, booked: false, reason: 'horario_no_disponible',
            message: _libres.length
              ? `Ese horario no me queda libre. Te puedo ofrecer: ${_libres.join(', ')}. ¿Cuál te sirve?`
              : _chk.error,
            alternativas: _libres,
          });
        }
      }
    } catch (e) { console.warn('[book-appointment] validación de agenda:', e.message); }
    // crear la cita PENDIENTE (sin dueño todavía)
    const ins = await db.query(
      `INSERT INTO appointments (tenant_id, user_id, conversation_id, lead_id, provider, attendee_name, attendee_phone, starts_at, ends_at, status)
       VALUES ($1, NULL, $2, $3, 'inhouse', $4, $5, $6, $7, 'pending') RETURNING id`,
      [tenantId, convId, leadId, contactName || null, phone || null, startIso, new Date(startMs + slotMin * 60000).toISOString()]);
    // notificar al equipo (v0.9.192: push dirigido por rol + WhatsApp opcional)
    try {
      const _np = require('./notify-prefs');
      const _plId = (await db.query('SELECT line_id FROM conversations WHERE id = $1', [convId]).catch(() => ({ rows: [] }))).rows[0]?.line_id || null;
      const _ev = _np.resolvePendingAppointment(await _np.getNotifPrefs(tenantId), _plId); // v0.9.336 override por línea
      const pushNotifier = require('./push-notifier');
      if (pushNotifier.isConfigured() && _ev.push_roles.length) {
        // v0.9.252: "cita por tomar" es un aviso para TODO el equipo → mandamos a TODAS las
        // suscripciones del tenant (sin filtrar por rol). Antes, si la suscripción del asesor
        // quedaba con user_id NULL, el filtro por rol NO la alcanzaba y el push no llegaba.
        pushNotifier.broadcast({
          title: '📅 Nueva cita por tomar',
          body: `${contactName || phone || 'Un cliente'} pidió visita para el ${_fmtLocal(startIso)} — tocá para tomarla`,
          url: `/panel/?reservas=pendientes`,
          // v0.9.255: a propósito SIN conversation_phone. Con el SW NUEVO manda el tag único de abajo;
          // con el SW VIEJO (aún no actualizado en el device) cae al tag genérico 'sg-ventas-notif',
          // que NO choca con las notifs del chat (esas usan el teléfono como tag y la pisaban). Así la
          // notif de "cita por tomar" se ve sí o sí, sin depender de que el dispositivo actualice el SW.
          tag: 'appt-' + ins.rows[0].id,
        }, tenantId)
          .then(_r => console.log(`📲 [bot-book] push cita-por-tomar (tenant ${tenantId}): enviados ${(_r && _r.sent) || 0}, fallidos ${(_r && _r.failed) || 0}`))
          .catch(e => console.warn('[bot-book] push err:', e.message));
      } else {
        console.log(`📲 [bot-book] push cita-por-tomar OMITIDO (tenant ${tenantId}): configured=${pushNotifier.isConfigured()} roles=[${(_ev.push_roles || []).join(',')}]`);
      }
      if (_ev.whatsapp) {
        const t = await db.query('SELECT alert_phone FROM tenants WHERE id = $1', [tenantId]).catch(() => ({ rows: [] }));
        const ap = (_ev.phone && String(_ev.phone).trim()) ? String(_ev.phone).trim() : (t.rows[0] && t.rows[0].alert_phone);
        if (ap) {
          const meta = require('./meta');
          const ctx = await getConversationMetaCtx({ tenant_id: tenantId });
          const base = process.env.PANEL_PUBLIC_URL || 'https://app.sg-ventas.com/panel/';
          await meta.sendText(ap, `📅 *Nueva cita por tomar*\n\n${contactName || phone || 'Un cliente'} pidió visita para el ${_fmtLocal(startIso)}.\nTomala en el panel:\n${base}${base.includes('?') ? '&' : '?'}reservas=pendientes`, true, ctx).catch(() => {});
        }
      }
    } catch (e) { /* notif best-effort */ }
    console.log(`📅 [bot-book] cita PENDIENTE #${ins.rows[0].id} (tenant ${tenantId}) ${_fmtLocal(startIso)}`);
    const _apptMsg = `¡Perfecto! ✅ Anoté tu solicitud de visita para el ${_fmtLocal(startIso)} hs. En breve uno de nuestros asesores te confirma y coordina los detalles. ¡Gracias! 🙌`;
    // v0.9.394 — CONFIRMACIÓN DE CITA con AUDIO (aditivo: n8n manda el texto y acá va la nota de voz cálida). Best-effort.
    if (convId && phone) {
      try {
        const _cr = await db.query('SELECT * FROM conversations WHERE id = $1', [convId]);
        const _conv = _cr.rows[0];
        if (_conv) {
          const _cctx = await getConversationMetaCtx(_conv);
          require('./voice-moments').sendVoiceMoment('appointment', { tenantId, conversationId: convId, lineId: _conv.line_id || null, phone, text: _apptMsg, ctx: _cctx }).catch(() => {});
        }
      } catch (e) { /* best-effort */ }
    }
    return res.json({ ok: true, booked: true, pending: true, id: ins.rows[0].id, message: _apptMsg });
  } catch (e) {
    if (/appointments/.test(e.message)) return res.status(503).json({ ok: false, error: 'agenda no disponible (deploy pendiente)' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/admin/pending-appointments — POOL de citas por tomar (sin dueño) del tenant.
router.get('/admin/pending-appointments', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  try {
    // v0.9.489 — el pool "por tomar" también respeta el alcance por línea del agente.
    // Una cita sin conversación (cargada a mano) no tiene línea: se deja visible para
    // que no quede huérfana en el pool y nadie la tome.
    let _lnF = '';
    const _al = await getAgentLineIds(req);
    if (_al) {
      const _ids = _al.map(n => parseInt(n, 10)).filter(Number.isFinite);
      _lnF = _ids.length
        ? ` AND (c.id IS NULL OR c.line_id IS NULL OR c.line_id IN (${_ids.join(',')}))`
        : ` AND (c.id IS NULL OR c.line_id IS NULL)`;
    }
    const r = await db.query(
      `SELECT a.id, a.attendee_name, a.attendee_phone, a.starts_at, a.ends_at, a.conversation_id, a.created_at, c.phone AS conv_phone
         FROM appointments a LEFT JOIN conversations c ON c.id = a.conversation_id
        WHERE a.tenant_id = $1 AND a.status = 'pending'${_lnF}
        ORDER BY a.starts_at ASC LIMIT 200`, [tenantId]);
    res.json({ ok: true, count: r.rows.length, pending: r.rows });
  } catch (e) {
    if (/appointments/.test(e.message)) return res.json({ ok: true, count: 0, pending: [], need_migration: true });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.9.192 — formateo fecha/hora local Bolivia (UTC-4) a nivel de módulo (el _fmtLocal
// de book-appointment es un closure local; este sirve para los pushes fuera de ese handler).
function _fmtLocalBO(iso) {
  try {
    const d = new Date(new Date(iso).getTime() + (-240) * 60000);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  } catch (e) { return ''; }
}

// POST /api/admin/appointments — v0.9.202: CITA MANUAL creada por el vendedor en SU PROPIO
// calendario. Cada uno agenda en el suyo (user_id = req.userId), status 'scheduled'.
// Override manual: NO valida disponibilidad (deja cualquier hora), pero avisa si choca con
// otra cita suya (409 → el front confirma y reenvía con force:true). Enlaza conv/lead por
// teléfono (habilita recordatorio + contexto). Nota opcional → appointment_notes.
router.post('/admin/appointments', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const userId = req.userId;
  if (!userId) return res.status(400).json({ ok: false, error: 'Sesión sin usuario' });
  const name = String((req.body && req.body.name) || '').trim();
  const phoneRaw = String((req.body && req.body.phone) || '').trim();
  const startRaw = String((req.body && req.body.start) || '').trim();
  const durMin = Math.min(Math.max(parseInt(req.body && req.body.duration_min, 10) || 30, 5), 480);
  const note = String((req.body && req.body.notes) || '').trim();
  const force = !!(req.body && req.body.force);
  if (!name) return res.status(400).json({ ok: false, error: 'Poné el nombre del contacto' });
  // hora: ISO con zona, o 'YYYY-MM-DDTHH:MM' local (negocio en Bolivia, UTC-4)
  const off = -240;
  let startMs = NaN;
  const m = startRaw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (m && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(startRaw)) startMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - off * 60000;
  else if (startRaw) startMs = Date.parse(startRaw);
  if (isNaN(startMs)) return res.status(400).json({ ok: false, error: 'Elegí fecha y hora válidas' });
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + durMin * 60000).toISOString();
  try {
    // choque: otra cita del MISMO usuario que se solapa (a menos que mande force)
    if (!force) {
      const clash = await db.query(
        `SELECT id, starts_at FROM appointments
           WHERE user_id = $1 AND tenant_id = $2 AND status NOT IN ('cancelled','no_show')
             AND starts_at < $4::timestamptz AND ends_at > $3::timestamptz
           ORDER BY starts_at ASC LIMIT 1`,
        [userId, tenantId, startIso, endIso]).catch(() => ({ rows: [] }));
      if (clash.rows.length) {
        // 200 (no 409) a propósito: así el helper api() del panel devuelve el body (no muestra
        // toast de error) y el front puede ofrecer "crear igual" reenviando con force:true.
        return res.json({ ok: false, conflict: true, error: 'Ya tenés una cita que se cruza con ese horario.' });
      }
    }
    // enlazar conversación / lead por teléfono (recordatorio por WhatsApp + contexto)
    let convId = null, leadId = null;
    const digits = phoneRaw.replace(/\D/g, '');
    if (digits.length >= 7) {
      const cm = await db.query(
        `SELECT c.id, l.id AS lead_id FROM conversations c LEFT JOIN leads l ON l.conversation_id = c.id
          WHERE c.tenant_id = $1 AND regexp_replace(COALESCE(c.phone,''),'\\D','','g') LIKE '%' || $2
          ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`,
        [tenantId, digits.slice(-8)]).catch(() => ({ rows: [] }));
      if (cm.rows[0]) { convId = cm.rows[0].id; leadId = cm.rows[0].lead_id; }
    }
    const ins = await db.query(
      `INSERT INTO appointments (tenant_id, user_id, conversation_id, lead_id, provider, attendee_name, attendee_phone, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4,'inhouse',$5,$6,$7,$8,'scheduled') RETURNING id`,
      [tenantId, userId, convId, leadId, name.slice(0, 200), phoneRaw.slice(0, 64) || null, startIso, endIso]);
    const apptId = ins.rows[0].id;
    if (note) {
      await db.query(
        `INSERT INTO appointment_notes (tenant_id, appointment_id, user_id, body) VALUES ($1,$2,$3,$4)`,
        [tenantId, apptId, userId, note.slice(0, 2000)]).catch(() => {});
    }
    console.log(`📅 [agenda manual] cita #${apptId} creada por user ${userId} (tenant ${tenantId}) para ${startIso}`);
    res.json({ ok: true, id: apptId, start: startIso });
  } catch (e) {
    if (/appointments|appointment_notes|column|relation/.test(e.message)) return res.status(503).json({ ok: false, error: 'Agenda no disponible (deploy pendiente).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.9.202 — Al TOMAR/ASIGNAR una cita: (1) confirmar al CLIENTE por WhatsApp con el nombre y
// teléfono del asesor en formato wa.me (contacto directo en el momento) y dejarlo en el chat;
// (2) push al asesor con el resumen del cliente. Best-effort: cualquier fallo se loguea, no rompe.
async function _notifyAppointmentAssigned(tenantId, apptId, sellerUserId) {
  try {
    const q = await db.query(
      `SELECT a.starts_at, a.attendee_name, a.attendee_phone,
              c.id AS conv_id, c.phone AS conv_phone, c.line_id, c.contact_name,
              l.score AS lead_score, COALESCE(l.vertical, c.vertical) AS vertical,
              u.display_name AS seller, u.booking_contact_phone AS seller_phone, u.role AS seller_role,
              COALESCE(u.tz_offset_min, -240) AS tz
         FROM appointments a
         LEFT JOIN conversations c ON c.id = a.conversation_id
         LEFT JOIN leads l ON l.conversation_id = c.id
         LEFT JOIN tenant_users u ON u.id = $3
        WHERE a.id = $1 AND a.tenant_id = $2`, [apptId, tenantId, sellerUserId]);
    const a = q.rows[0];
    if (!a) return;
    const clientPhone = a.conv_phone || a.attendee_phone;
    const tz = Number(a.tz) || -240;
    const local = a.starts_at ? new Date(new Date(a.starts_at).getTime() + tz * 60000) : null;
    const _d = local ? `${String(local.getUTCDate()).padStart(2, '0')}/${String(local.getUTCMonth() + 1).padStart(2, '0')}` : '';
    const _h = local ? `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}` : '';
    const firstName = String(a.attendee_name || a.contact_name || '').trim().split(/\s+/)[0] || '';

    // (1) WhatsApp de confirmación al CLIENTE con contacto directo del asesor (wa.me)
    if (clientPhone && a.line_id) {
      const sellerName = a.seller || 'tu asesor';
      const sellerDigits = String(a.seller_phone || '').replace(/\D/g, '');
      let msg = `¡Listo${firstName ? ', ' + firstName : ''}! 🎉 Tomamos tu solicitud de visita`;
      if (_d) msg += ` para el ${_d}${_h ? ' a las ' + _h + ' hs' : ''}`;
      msg += `. *${sellerName}* se va a contactar con vos en breve para coordinar los detalles.`;
      if (sellerDigits.length >= 8) msg += `\n\nO si querés, escribile directo por WhatsApp 👉 https://wa.me/${sellerDigits}`;
      msg += `\n\n¡Gracias! 🙌`;
      try {
        const ctx = await getConversationMetaCtx({ line_id: a.line_id, tenant_id: tenantId });
        const r = await meta.sendText(clientPhone, msg, true, ctx);
        if (r && r.success && a.conv_id) {
          await db.query(
            `INSERT INTO messages (conversation_id, direction, sender_type, type, body, status)
             VALUES ($1,'outgoing','bot','text',$2,'sent')`, [a.conv_id, msg]).catch(() => {});
          await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [a.conv_id]).catch(() => {});
        } else if (!(r && r.success)) {
          console.warn(`[appt-assign] WA al cliente falló (cita ${apptId}): ${(r && r.error) || 'sin detalle'}`);
        }
      } catch (e) { console.warn('[appt-assign] WA al cliente:', e.message); }
    }

    // (2) push al asesor con el resumen del cliente
    try {
      const ev = (await require('./notify-prefs').getNotifPrefs(tenantId)).appointment_assigned;
      const pushNotifier = require('./push-notifier');
      if (pushNotifier.isConfigured() && ev.push_roles.length && a.seller_role && ev.push_roles.includes(a.seller_role)) {
        const bits = [];
        if (a.lead_score != null) bits.push('★' + a.lead_score);
        if (a.vertical) bits.push(a.vertical);
        if (clientPhone) bits.push('📞 ' + clientPhone);
        pushNotifier.broadcast({
          title: '✅ Cita confirmada — ' + (a.attendee_name || a.contact_name || clientPhone || 'Cliente'),
          body: `${_d ? _d + ' ' + _h + ' hs · ' : ''}${bits.join(' · ')} — tocá para ver el chat`,
          url: clientPhone ? `/panel/?conv=${encodeURIComponent(clientPhone)}` : `/panel/?reservas=pendientes`,
          conversation_phone: clientPhone || undefined,
          tag: 'appt-assigned-' + apptId, // v0.9.254: tag único → no se colapsa con las notifs del chat
        }, tenantId, { userIds: [sellerUserId] }).catch(() => {});
      }
    } catch (e) { /* push best-effort */ }
  } catch (e) { console.error('[appt-assign] notify error:', e.message); }
}

// POST /api/admin/appointments/:id/claim — un usuario TOMA una cita pendiente (se la asigna a sí mismo).
router.post('/admin/appointments/:id/claim', requireTenantSession, async (req, res) => {
  if (!req.userId) return res.status(400).json({ ok: false, error: 'Sesión sin usuario' });
  const tenantId = invTenant(req) || req.tenantId || 1;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'id inválido' });
  try {
    const r = await db.query(
      `UPDATE appointments SET user_id = $1, status = 'scheduled', claimed_at = NOW()
        WHERE id = $2 AND tenant_id = $3 AND status = 'pending' RETURNING id, conversation_id`,
      [req.userId, id, tenantId]);
    if (!r.rows[0]) return res.json({ ok: false, taken: true, error: 'Esa cita ya fue tomada por otra persona.' });
    // v0.9.188: al TOMAR la cita, asignar la conversación al agente (aparece en su filtro "Yo").
    // v0.9.251: además FIJAR la conversación (prioritized_at) → sube al tope del inbox del asesor
    // hasta que la oportunidad se marque ganada/perdida. status='open' por si estaba archivada.
    if (r.rows[0].conversation_id) {
      await db.query(`UPDATE conversations SET assigned_to = $1, prioritized_at = NOW(), status = 'open', updated_at = NOW() WHERE id = $2 AND tenant_id = $3`, [req.userId, r.rows[0].conversation_id, tenantId]).catch(() => {});
    }
    // v0.9.202: confirmar al CLIENTE por WhatsApp (nombre + tel del asesor, wa.me) + push al asesor. Best-effort.
    _notifyAppointmentAssigned(tenantId, r.rows[0].id, req.userId).catch(() => {});
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    if (/appointments|claimed_at/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración del pool (deploy pendiente).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/appointments/:id/assign — el DUEÑO/supervisor asigna una cita pendiente a un usuario.
router.post('/admin/appointments/:id/assign', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const id = parseInt(req.params.id, 10);
  const targetId = parseInt(req.body && req.body.user_id, 10);
  if (!id || !targetId) return res.status(400).json({ ok: false, error: 'id y user_id requeridos' });
  try {
    const u = await db.query('SELECT id, display_name, role FROM tenant_users WHERE id = $1 AND tenant_id = $2', [targetId, tenantId]);
    if (!u.rows[0]) return res.status(404).json({ ok: false, error: 'usuario no encontrado en la organización' });
    const r = await db.query(
      `UPDATE appointments SET user_id = $1, status = 'scheduled', claimed_at = NOW()
        WHERE id = $2 AND tenant_id = $3 AND status = 'pending'
        RETURNING id, conversation_id, attendee_name, attendee_phone, starts_at`,
      [targetId, id, tenantId]);
    if (!r.rows[0]) return res.json({ ok: false, taken: true, error: 'Esa cita ya fue tomada o asignada.' });
    // v0.9.188: al ASIGNAR la cita, asignar la conversación a ese usuario (aparece en su filtro "Yo").
    // v0.9.251: + FIJAR la conversación (prioritized_at) en el inbox del asesor asignado.
    if (r.rows[0].conversation_id) {
      await db.query(`UPDATE conversations SET assigned_to = $1, prioritized_at = NOW(), status = 'open', updated_at = NOW() WHERE id = $2 AND tenant_id = $3`, [targetId, r.rows[0].conversation_id, tenantId]).catch(() => {});
    }
    // v0.9.202: confirmar al CLIENTE por WhatsApp (nombre + tel del asesor en wa.me) + push al
    // asesor con el resumen del cliente. Reemplaza el push simple de v0.9.192. Best-effort.
    _notifyAppointmentAssigned(tenantId, r.rows[0].id, targetId).catch(() => {});
    res.json({ ok: true, id: r.rows[0].id, assigned_to: u.rows[0].display_name });
  } catch (e) {
    if (/appointments|claimed_at/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración del pool (deploy pendiente).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});
// ============ v0.9.177 — CITA EDITABLE (detalle, estado, notas, imágenes) ============

// GET /api/admin/appointments/:id — detalle completo de una cita (contacto + notas + imágenes).
router.get('/admin/appointments/:id', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'id inválido' });
  try {
    const a = await db.query(
      `SELECT a.*, u.display_name AS seller, c.phone AS conv_phone, c.contact_name AS conv_name, c.id AS conv_id,
              c.current_score AS conv_score, l.summary AS lead_summary, l.score AS lead_score, l.vertical AS lead_vertical
         FROM appointments a
         LEFT JOIN tenant_users u ON u.id = a.user_id
         LEFT JOIN conversations c ON c.id = a.conversation_id
         LEFT JOIN leads l ON l.conversation_id = c.id
        WHERE a.id = $1 AND a.tenant_id = $2`, [id, tenantId]);
    if (!a.rows[0]) return res.status(404).json({ ok: false, error: 'cita no encontrada' });
    const notes = await db.query(
      `SELECT n.id, n.body, n.created_at, u.display_name AS author
         FROM appointment_notes n LEFT JOIN tenant_users u ON u.id = n.user_id
        WHERE n.appointment_id = $1 ORDER BY n.created_at ASC`, [id]).catch(() => ({ rows: [] }));
    const ap = a.rows[0];
    res.json({
      ok: true,
      appointment: {
        id: ap.id, status: ap.status, starts_at: ap.starts_at, ends_at: ap.ends_at,
        attendee_name: ap.attendee_name || ap.conv_name || null,
        attendee_phone: ap.attendee_phone || ap.conv_phone || null,
        seller: ap.seller || null, user_id: ap.user_id || null, conversation_id: ap.conv_id || null,
        images: Array.isArray(ap.images) ? ap.images : [],
        summary: ap.lead_summary || null,
        score: (ap.lead_score != null ? ap.lead_score : (ap.conv_score != null ? ap.conv_score : null)),
        vertical: ap.lead_vertical || null,
      },
      notes: notes.rows,
    });
  } catch (e) {
    if (/appointment/.test(e.message)) return res.status(503).json({ ok: false, error: 'agenda no disponible (deploy pendiente)' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// PATCH /api/admin/appointments/:id — cambiar estado (Pendiente/Asignada/Realizada/...) o reagendar.
router.patch('/admin/appointments/:id', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok: false, error: 'id inválido' });
  const b = req.body || {};
  const sets = [], vals = [];
  const add = (c, v) => { vals.push(v); sets.push(`${c} = $${vals.length}`); };
  const STATUSES = ['pending', 'scheduled', 'completed', 'cancelled', 'no_show'];
  if (b.status && STATUSES.includes(b.status)) add('status', b.status);
  // v0.9.514 — al reagendar se CONSERVA la duración original. Antes se forzaban 30
  // minutos siempre: una visita de 90 se convertía en una de 30 con solo moverla de
  // hora, y el hueco liberado se ofrecía a otro cliente.
  let _reagendar = null;
  if (b.starts_at) { const t = Date.parse(b.starts_at); if (!isNaN(t)) { _reagendar = t; add('starts_at', new Date(t).toISOString()); } }
  if (!sets.length) return res.status(400).json({ ok: false, error: 'nada para actualizar' });
  try {
    if (_reagendar != null) {
      const prev = await db.query(`SELECT starts_at, ends_at FROM appointments WHERE id = $1 AND tenant_id = $2`, [id, tenantId]).catch(() => ({ rows: [] }));
      let durMs = 30 * 60000;
      if (prev.rows[0] && prev.rows[0].ends_at && prev.rows[0].starts_at) {
        const d = new Date(prev.rows[0].ends_at).getTime() - new Date(prev.rows[0].starts_at).getTime();
        if (d > 0 && d <= 8 * 3600000) durMs = d;
      }
      add('ends_at', new Date(_reagendar + durMs).toISOString());
    }
  } catch (e) { /* si falla, sigue sin tocar ends_at */ }
  vals.push(id, tenantId);
  try {
    const r = await db.query(`UPDATE appointments SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length} RETURNING id, status`, vals);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'cita no encontrada' });
    res.json({ ok: true, id: r.rows[0].id, status: r.rows[0].status });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// POST /api/admin/appointments/:id/notes — agregar una nota al historial de la cita.
router.post('/admin/appointments/:id/notes', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const id = parseInt(req.params.id, 10);
  const body = String((req.body && req.body.body) || '').trim();
  if (!id || !body) return res.status(400).json({ ok: false, error: 'falta la nota' });
  try {
    const ins = await db.query(
      `INSERT INTO appointment_notes (tenant_id, appointment_id, user_id, body) VALUES ($1,$2,$3,$4)
       RETURNING id, body, created_at`, [tenantId, id, req.userId || null, body.slice(0, 2000)]);
    const au = req.userId ? await db.query('SELECT display_name FROM tenant_users WHERE id = $1', [req.userId]).catch(() => ({ rows: [] })) : { rows: [] };
    res.json({ ok: true, note: { ...ins.rows[0], author: (au.rows[0] && au.rows[0].display_name) || null } });
  } catch (e) {
    if (/appointment_notes/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración (deploy pendiente).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/admin/appointments/:id/images — subir una foto de la visita (dataURL base64) → R2.
router.post('/admin/appointments/:id/images', requireTenantSession, async (req, res) => {
  const tenantId = invTenant(req) || req.tenantId || 1;
  const id = parseInt(req.params.id, 10);
  const data = String((req.body && req.body.data) || '');
  if (!id || !data) return res.status(400).json({ ok: false, error: 'falta la imagen' });
  if (!r2.isConfigured()) return res.status(500).json({ ok: false, error: 'R2 no configurado en el servidor' });
  const m = data.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ ok: false, error: 'formato de imagen inválido' });
  try {
    const buffer = Buffer.from(m[2], 'base64');
    if (buffer.length > 8 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'La imagen supera los 8MB' });
    const ext = (m[1].split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'jpg';
    const up = await r2.upload({ buffer, mimeType: m[1], prefix: 'appointments', filename: `visita-${id}-${Date.now()}.${ext}` });
    // v0.9.185: guardar la imagen como objeto {url, at, lat, lng}. El GPS (opcional) sirve para
    // verificar que el vendedor estuvo en el lugar al tomar la foto de la visita.
    const _lat = (req.body && req.body.lat != null) ? Number(req.body.lat) : null;
    const _lng = (req.body && req.body.lng != null) ? Number(req.body.lng) : null;
    const _img = { url: up.url, at: new Date().toISOString() };
    if (Number.isFinite(_lat) && Number.isFinite(_lng)) { _img.lat = _lat; _img.lng = _lng; }
    const r = await db.query(
      `UPDATE appointments SET images = COALESCE(images, '[]'::jsonb) || $1::jsonb WHERE id = $2 AND tenant_id = $3 RETURNING images`,
      [JSON.stringify([_img]), id, tenantId]);
    if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'cita no encontrada' });
    res.json({ ok: true, url: up.url, image: _img, images: r.rows[0].images });
  } catch (e) {
    if (/images|appointments/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta la migración (deploy pendiente).' });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============ FIN AGENDADOR PROPIO ============

// =====================================================================
// v0.9.17 — BRANDING por organización (nombre + logo del WhatsApp Business)
// La foto sale del perfil de WhatsApp Business del número (Meta), que solo
// el dueño controla (desde su app WhatsApp Business / Meta Business).
// La URL de Meta es temporal → cache in-memory con TTL 12h.
// =====================================================================

const brandingCache = new Map(); // tenantId → { data, exp }
const BRANDING_TTL_MS = 12 * 3600 * 1000;

async function fetchBranding(tenantId) {
  const t = await db.query(
    'SELECT id, slug, name, meta_phone_number_id, meta_token_enc FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (t.rows.length === 0) return null;
  const row = t.rows[0];
  let pictureUrl = null;
  try {
    const pnid = row.meta_phone_number_id || process.env.META_PHONE_NUMBER_ID;
    if (pnid) {
      // v0.9.457: EN CAPAS. Antes, si el token estaba guardado en la LÍNEA y no en
      // el tenant, se preguntaba con el global y la org se quedaba sin logo.
      const { result: prof } = await callMetaWithTenantTokens(tenantId, row.meta_token_enc,
        (token) => meta.getBusinessProfile(pnid, token));
      pictureUrl = prof?.profile_picture_url || null;
    }
  } catch (e) {
    console.warn('[branding] sin foto de perfil:', e.response?.data?.error?.message || e.message);
  }
  return { ok: true, name: row.name, slug: row.slug, picture_url: pictureUrl };
}

/** GET /api/admin/org/branding — nombre + logo. TODOS los roles (lo muestra el sidebar). */
router.get('/admin/org/branding', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : 1);
  try {
    const hit = brandingCache.get(tenantId);
    if (hit && Date.now() < hit.exp) return res.json(hit.data);
    const data = await fetchBranding(tenantId);
    if (!data) return res.status(404).json({ error: 'Organización no encontrada' });
    brandingCache.set(tenantId, { data, exp: Date.now() + BRANDING_TTL_MS });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** POST /api/admin/org/branding/refresh — re-sincroniza YA desde Meta (solo owner). */
router.post('/admin/org/branding/refresh', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : 1);
  try {
    brandingCache.delete(tenantId);
    const data = await fetchBranding(tenantId);
    if (!data) return res.status(404).json({ error: 'Organización no encontrada' });
    brandingCache.set(tenantId, { data, exp: Date.now() + BRANDING_TTL_MS });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.15 — RESPUESTAS RÁPIDAS (atajos del composer; texto y/o asset)
// =====================================================================

const QR_SHORTCUT_RE = /^[a-z0-9_-]{2,30}$/i;

// v0.9.18 — alcance: owner_user_id NULL = de la ORG · valor = PERSONAL del usuario.
// ¿Puede este request administrar esta respuesta?
function canManageQr(req, row) {
  if (req.isSuperAdmin) return true;
  if (row.owner_user_id) {
    // personal: su dueño, o el owner de la org
    return req.userId === row.owner_user_id || req.userRole === 'owner';
  }
  // de la org: owner/supervisor
  return req.userRole === 'owner' || req.userRole === 'supervisor';
}

/** GET /api/admin/quick-replies — org + las personales del usuario. ?all=1 incluye inactivas. */
router.get('/admin/quick-replies', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const all = req.query.all === '1';
    const params = [tenantId];
    let scope = 'qr.owner_user_id IS NULL';
    if (req.userId) { params.push(req.userId); scope = '(qr.owner_user_id IS NULL OR qr.owner_user_id = $2)'; }
    const r = await db.query(
      `SELECT qr.id, qr.shortcut, qr.title, qr.body, qr.asset_id, qr.active, qr.created_at,
              qr.owner_user_id, (qr.owner_user_id IS NOT NULL) AS is_personal,
              ma.type AS asset_type, ma.description AS asset_description
       FROM quick_replies qr
       LEFT JOIN media_assets ma ON ma.asset_id = qr.asset_id AND (ma.tenant_id = qr.tenant_id OR ma.tenant_id IS NULL)
       WHERE qr.tenant_id = $1 AND ${scope} ${all ? '' : 'AND qr.active = TRUE'}
       ORDER BY (qr.owner_user_id IS NOT NULL) DESC, LOWER(qr.shortcut) ASC`,
      params
    );
    res.json({ ok: true, quick_replies: r.rows, your_user_id: req.userId || null, your_role: req.userRole || null });
  } catch (e) {
    if (/owner_user_id/.test(e.message)) {
      // migración v0.9.18 pendiente → comportamiento v0.9.15 (solo org)
      try {
        const r = await db.query(
          `SELECT qr.id, qr.shortcut, qr.title, qr.body, qr.asset_id, qr.active, qr.created_at,
                  NULL AS owner_user_id, FALSE AS is_personal,
                  ma.type AS asset_type, ma.description AS asset_description
           FROM quick_replies qr
           LEFT JOIN media_assets ma ON ma.asset_id = qr.asset_id
           WHERE qr.tenant_id = $1 ${req.query.all === '1' ? '' : 'AND qr.active = TRUE'}
           ORDER BY LOWER(qr.shortcut) ASC`,
          [tenantId]
        );
        return res.json({ ok: true, quick_replies: r.rows, your_user_id: req.userId || null, your_role: req.userRole || null, pending_migration: true });
      } catch (e2) { /* cae al manejo de abajo */ }
    }
    if (/quick_replies/.test(e.message)) return res.json({ ok: true, quick_replies: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/quick-replies — crear.
 * Body: { shortcut, title?, body?, asset_id?, scope? ('org'|'personal') }
 * Agente → SIEMPRE personal. Owner/supervisor → org por defecto, personal si lo piden.
 */
router.post('/admin/quick-replies', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const shortcut = String(req.body.shortcut || '').trim().toLowerCase();
  const title = String(req.body.title || '').trim() || null;
  const body = (req.body.body !== undefined && String(req.body.body).trim()) ? String(req.body.body).trim() : null;
  const assetId = String(req.body.asset_id || '').trim() || null;

  // Alcance según rol
  const isManager = req.isSuperAdmin || req.userRole === 'owner' || req.userRole === 'supervisor';
  let ownerUserId = null;
  if (!isManager) {
    if (!req.userId) return res.status(403).json({ error: 'Tu sesión no permite crear respuestas (relogueate)' });
    ownerUserId = req.userId; // agente: personal forzado
  } else if (req.body.scope === 'personal') {
    if (!req.userId) return res.status(400).json({ error: 'El super-admin no tiene respuestas personales' });
    ownerUserId = req.userId;
  }

  if (!shortcut) return res.status(400).json({ error: 'shortcut requerido' });
  if (!QR_SHORTCUT_RE.test(shortcut)) return res.status(400).json({ error: 'shortcut inválido: 2-30 caracteres, letras/números/guiones, sin espacios' });
  if (!body && !assetId) return res.status(400).json({ error: 'La respuesta necesita texto (body) o un asset' });

  try {
    if (assetId) {
      // v0.9.72 (auditoría P2): el asset debe ser de la org (o legacy de tenant 1)
      const _tfA = tenantFilter(req, 2);
      const a = await db.query(`SELECT asset_id FROM media_assets WHERE asset_id = $1 AND active = TRUE${_tfA.clause}`, [assetId, ..._tfA.params]);
      if (a.rows.length === 0) return res.status(404).json({ error: 'Asset no encontrado o inactivo' });
    }
    const ins = await db.query(
      `INSERT INTO quick_replies (tenant_id, shortcut, title, body, asset_id, created_by, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, shortcut, title, body, asset_id, active, created_at, owner_user_id, (owner_user_id IS NOT NULL) AS is_personal`,
      [tenantId, shortcut, title, body, assetId, req.userId || null, ownerUserId]
    );
    res.status(201).json({ ok: true, quick_reply: ins.rows[0] });
  } catch (e) {
    if (/idx_quick_replies_shortcut/.test(e.message)) return res.status(409).json({ error: `Ya tenés una respuesta con el atajo /${shortcut} en ese alcance` });
    if (/owner_user_id/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.18' });
    if (/quick_replies/.test(e.message) && /does not exist/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.15' });
    res.status(500).json({ error: e.message });
  }
});

/** PATCH /api/admin/quick-replies/:id — editar (org: owner/supervisor · personal: su dueño u owner). */
router.patch('/admin/quick-replies/:id', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  const { shortcut, title, body, asset_id, active } = req.body || {};

  if (shortcut !== undefined && !QR_SHORTCUT_RE.test(String(shortcut).trim().toLowerCase())) {
    return res.status(400).json({ error: 'shortcut inválido' });
  }
  try {
    const cur = await db.query('SELECT id, owner_user_id FROM quick_replies WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Respuesta rápida no encontrada' });
    if (!canManageQr(req, cur.rows[0])) return res.status(403).json({ error: 'No podés editar esta respuesta', code: 'FORBIDDEN_QR' });

    const sets = [];
    const params = [];
    let i = 1;
    if (shortcut !== undefined) { sets.push(`shortcut = $${i++}`); params.push(String(shortcut).trim().toLowerCase()); }
    if (title !== undefined)    { sets.push(`title = $${i++}`);    params.push(String(title).trim() || null); }
    if (body !== undefined)     { sets.push(`body = $${i++}`);     params.push(String(body).trim() || null); }
    if (asset_id !== undefined) { sets.push(`asset_id = $${i++}`); params.push(String(asset_id).trim() || null); }
    if (active !== undefined)   { sets.push(`active = $${i++}`);   params.push(!!active); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
    params.push(id, tenantId);
    const r = await db.query(
      `UPDATE quick_replies SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING id, shortcut, title, body, asset_id, active, owner_user_id, (owner_user_id IS NOT NULL) AS is_personal`,
      params
    );
    res.json({ ok: true, quick_reply: r.rows[0] });
  } catch (e) {
    if (/idx_quick_replies_shortcut/.test(e.message)) return res.status(409).json({ error: 'Ya existe una respuesta con ese atajo en ese alcance' });
    res.status(500).json({ error: e.message });
  }
});

/** DELETE /api/admin/quick-replies/:id — borrar (mismas reglas que editar). */
router.delete('/admin/quick-replies/:id', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id inválido' });
  try {
    const cur = await db.query('SELECT id, owner_user_id FROM quick_replies WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Respuesta rápida no encontrada' });
    if (!canManageQr(req, cur.rows[0])) return res.status(403).json({ error: 'No podés borrar esta respuesta', code: 'FORBIDDEN_QR' });
    await db.query('DELETE FROM quick_replies WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.13 — LÍNEAS (multi-línea por organización)
// Cada línea = un número de WhatsApp ruteado a esta org. La conversación
// recuerda su línea y se responde SIEMPRE por la misma.
// =====================================================================

const { encrypt: encryptToken } = require('./crypto');

// ---------------------------------------------------------------------
// v0.9.457 — PROVISIONING REAL DE LÍNEAS
// Antes, POST /admin/lines era un INSERT pelado: la fila quedaba creada y
// el panel la mostraba, pero Meta NUNCA se enteraba — la WABA sin
// subscribed_apps, el número sin registrar en Cloud API y sin pedido de
// historial. Resultado: los mensajes a esa línea no llegaban al webhook
// (o llegaban y webhook.js los descartaba) y el inbox salía vacío.
// Estos helpers hacen el mismo trabajo que /lines/connect-facebook pero
// reusando el token que la org YA tiene (mismo portafolio / misma WABA).
// ---------------------------------------------------------------------

/**
 * Tokens candidatos de la org, en orden de preferencia:
 * explícito → token del tenant (onboarding) → línea default → otras
 * líneas → token global del env. Deduplicado, [{ token, source }].
 */
async function resolveTenantTokens(tenantId, explicitToken) {
  const out = [];
  const seen = new Set();
  const push = (token, source) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push({ token, source });
  };
  push(explicitToken, 'body');
  try {
    const t = await db.query('SELECT meta_token_enc FROM tenants WHERE id = $1', [tenantId]);
    if (t.rows[0] && t.rows[0].meta_token_enc) push(decryptSafe(t.rows[0].meta_token_enc), 'tenant');
  } catch (e) { /* noop */ }
  try {
    const l = await db.query(
      `SELECT meta_token_enc, is_default FROM tenant_lines
       WHERE tenant_id = $1 AND meta_token_enc IS NOT NULL AND active = true
       ORDER BY is_default DESC, created_at ASC`,
      [tenantId]
    );
    for (const row of l.rows) push(decryptSafe(row.meta_token_enc), row.is_default ? 'line:default' : 'line');
  } catch (e) { /* noop */ }
  push(process.env.META_ACCESS_TOKEN, 'env');
  return out;
}

/**
 * v0.9.457 — consulta un phone_number_id a Meta probando los tokens del tenant EN CAPAS.
 *
 * Bug que arregla (visto en los logs del 27-jul): las consultas hacían
 *   const token = line.meta_token_enc ? decrypt(...) : process.env.META_ACCESS_TOKEN
 * o sea: si la LÍNEA no tenía token propio, saltaba directo al token GLOBAL (el de
 * SG Bolivia) — sin pasar por el token del TENANT ni por el de sus otras líneas.
 * Meta entonces responde "Object with ID '...' does not exist, cannot be loaded due
 * to missing permissions", que se lee como "el número no existe" cuando en realidad
 * es "preguntaste con el token equivocado". Eso ensuciaba el diagnóstico y, peor,
 * el health check marcaba líneas sanas como 'disconnected' y disparaba alertas falsas.
 *
 * Devuelve { info, token_source } — info null si NINGÚN token del tenant lo reconoce,
 * que recién ahí sí significa que el número no está accesible.
 */
async function probePhoneNumberInfo(tenantId, phoneNumberId, lineTokenEnc) {
  if (!phoneNumberId) return { info: null, token_source: null, tried: 0 };
  const tokens = [];
  const seen = new Set();
  if (lineTokenEnc) {
    const t = decryptSafe(lineTokenEnc);
    if (t) { tokens.push({ token: t, source: 'line' }); seen.add(t); }
  }
  try {
    for (const t of await resolveTenantTokens(tenantId, null)) {
      if (!seen.has(t.token)) { tokens.push(t); seen.add(t.token); }
    }
  } catch (e) { /* noop */ }
  for (const { token, source } of tokens) {
    try {
      const info = await meta.getPhoneNumberInfo(String(phoneNumberId), token);
      if (info) return { info, token_source: source, tried: tokens.length };
    } catch (e) { /* probamos el siguiente */ }
  }
  return { info: null, token_source: null, tried: tokens.length };
}

/**
 * v0.9.457 — MISMO BUG, TODOS LOS ENDPOINTS DE LÍNEA.
 *
 * Ejecuta una llamada a Meta probando los tokens de la org EN CAPAS
 * (token de la línea → token del tenant → tokens de las otras líneas → global
 * del env) y devuelve el primer resultado bueno.
 *
 * El patrón que reemplaza estaba copiado en media docena de endpoints:
 *   const token = line.meta_token_enc ? decryptSafe(...) : process.env.META_ACCESS_TOKEN
 * O sea: si la LÍNEA no guardaba token propio — que es el caso normal cuando se
 * agrega una línea de la misma WABA y hereda el del tenant — la llamada salía
 * con el token GLOBAL de SG Bolivia, que no tiene permiso sobre los números de
 * otro tenant. Meta contesta "Object with ID '...' does not exist, cannot be
 * loaded due to missing permissions" y el endpoint fallaba con un error que
 * PARECE "el número no existe" cuando en realidad es "preguntaste como quien no
 * es". Afectaba register, sync-history (× línea y × tenant), reconnect,
 * disconnect-hard y branding.
 *
 * Si TODOS los tokens fallan se relanza el error del PRIMERO (el más específico),
 * porque el último suele ser el rechazo genérico del token global y tapa la causa real.
 *
 * OJO con el reintento: solo se pasa al siguiente token si el error HUELE A PERMISO.
 * Si Meta devuelve un error de negocio —el caso real es el PIN equivocado en
 * /register, error 133005— reintentar con los otros tokens no arregla nada y sí
 * hace daño: son 3-5 intentos fallidos de registro contra Meta por UN click, y Meta
 * bloquea temporalmente el registro del número tras varios PIN malos. Un error de
 * negocio corta la cadena y sale tal cual.
 */
function _esErrorDeToken(e) {
  const err = e && e.response && e.response.data && e.response.data.error;
  if (!err) return true; // sin cuerpo de Meta (red, timeout, 5xx) → probar el siguiente no cuesta nada
  const code = Number(err.code);
  const sub = Number(err.error_subcode);
  if ([190, 200, 10, 803, 3, 2500].includes(code)) return true; // token inválido / sin permiso / objeto no visible
  if (code === 100 && (sub === 33 || /does not exist|missing permissions|Unsupported get request/i.test(err.message || ''))) return true;
  return false; // error de negocio (PIN equivocado, número ya registrado, etc.)
}

async function callMetaWithTenantTokens(tenantId, lineTokenEnc, fn) {
  const tokens = [];
  const seen = new Set();
  if (lineTokenEnc) {
    const t = decryptSafe(lineTokenEnc);
    if (t) { tokens.push({ token: t, source: 'line' }); seen.add(t); }
  }
  try {
    for (const t of await resolveTenantTokens(tenantId, null)) {
      if (!seen.has(t.token)) { tokens.push(t); seen.add(t.token); }
    }
  } catch (e) { /* noop */ }
  if (!tokens.length) {
    const err = new Error('La organización no tiene ningún token de Meta utilizable');
    err.noToken = true;
    throw err;
  }
  let firstErr = null;
  for (const { token, source } of tokens) {
    try {
      const result = await fn(token, source);
      return { result, token, token_source: source, tried: tokens.length };
    } catch (e) {
      if (!firstErr) firstErr = e;
      if (!_esErrorDeToken(e)) { e.tokenLadderStopped = true; throw e; } // error de negocio: no insistir
    }
  }
  if (firstErr) firstErr.triedTokens = tokens.length;
  throw firstErr || new Error('Ningún token de la organización pudo completar la operación');
}

/**
 * WABAs donde puede vivir el número: la explícita → la del tenant → las de
 * sus líneas → las que el propio token declara (granular_scopes).
 */
async function resolveWabaCandidates(tenantId, explicitWaba, token) {
  const out = [];
  const seen = new Set();
  const push = (w) => {
    const s = String(w || '').trim();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  push(explicitWaba);
  try {
    const t = await db.query('SELECT waba_id FROM tenants WHERE id = $1', [tenantId]);
    if (t.rows[0]) push(t.rows[0].waba_id);
  } catch (e) { /* noop */ }
  try {
    const l = await db.query(
      'SELECT DISTINCT waba_id FROM tenant_lines WHERE tenant_id = $1 AND waba_id IS NOT NULL',
      [tenantId]
    );
    for (const row of l.rows) push(row.waba_id);
  } catch (e) { /* noop */ }
  if (token) {
    // v0.9.457 — el portafolio primero en cobertura, después en orden: si el token
    // es de negocio, sus WABAs no aparecen en los granular_scopes del debug_token.
    try {
      for (const w of await meta.getPortfolioWABAs(token)) push(w);
    } catch (e) { /* noop */ }
    try {
      const dbg = await meta.debugFacebookToken(token);
      for (const w of meta.extractWABAIdsFromDebug(dbg)) push(w);
    } catch (e) { /* noop */ }
  }
  return out;
}

/**
 * Verifica que el pnid exista en alguna WABA alcanzable con algún token de
 * la org y deja la línea REALMENTE conectada:
 *   subscribed_apps (webhook) → register (Cloud API) → smb_app_data (historial).
 * Nunca lanza: devuelve el parte de lo que se pudo hacer + warnings.
 */
async function provisionMetaLine({ tenantId, pnid, explicitToken, explicitWaba, wantHistory = true }) {
  const result = {
    verified: false,
    waba_id: explicitWaba || null,
    display_phone: null,
    verified_name: null,
    token: null,
    token_source: null,
    webhook_subscribed: false,
    registered: false,
    history_requested: false,
    pin: null,
    warnings: [],
  };

  const tokens = await resolveTenantTokens(tenantId, explicitToken);
  if (!tokens.length) {
    result.warnings.push('La organización no tiene ningún token de Meta guardado. Conectá la línea con el botón de Facebook o pegá el token.');
    return result;
  }

  // 1. Buscar el número: por cada token, en cada WABA candidata (anti-spoof:
  //    solo aceptamos números que el token realmente administra).
  outer:
  for (const { token, source } of tokens) {
    const wabas = await resolveWabaCandidates(tenantId, explicitWaba, token);
    for (const waba of wabas) {
      let phones;
      try {
        phones = await meta.getPhoneNumbers(waba, token);
      } catch (e) {
        continue; // ese token no ve esa WABA
      }
      const match = phones.find(p => String(p.id) === String(pnid));
      if (match) {
        result.verified = true;
        result.waba_id = String(waba);
        result.display_phone = match.display_phone_number || null;
        result.verified_name = match.verified_name || null;
        result.token = token;
        result.token_source = source;
        break outer;
      }
    }
  }
  if (!result.verified) {
    result.warnings.push('No encontramos ese número en las WhatsApp Business Accounts de la organización. Revisá el phone_number_id (es el ID de Meta, no el teléfono) o conectá la línea con el botón de Facebook.');
    return result;
  }

  // 2. Webhook — SIN ESTO LOS MENSAJES NUNCA LLEGAN.
  try {
    await meta.subscribeWABA(result.waba_id, result.token);
    result.webhook_subscribed = true;
    console.log(`✅ [lines/provision] WABA ${result.waba_id} suscrita al webhook (tenant ${tenantId})`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    result.warnings.push(`No se pudo suscribir la WABA al webhook: ${msg}`);
    console.warn(`⚠️ [lines/provision] subscribeWABA falló: ${msg}`);
  }

  // 3. Registro en Cloud API (warn-only: coexistence ya viene registrado y un
  //    número con verificación en dos pasos previa exige SU pin).
  try {
    const pin = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
    await meta.registerPhoneNumber(String(pnid), result.token, pin);
    result.registered = true;
    result.pin = pin;
    console.log(`✅ [lines/provision] Número ${result.display_phone || pnid} REGISTRADO en Cloud API`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    result.warnings.push(`No se pudo registrar el número en Cloud API: ${msg}`);
    console.warn(`⚠️ [lines/provision] register falló: ${msg}`);
  }

  // 4. Historial + contactos (coexistence). Best-effort: si el número no es
  //    de coexistencia Meta responde error y no pasa nada.
  if (wantHistory) {
    try {
      const sync = await meta.requestCoexistenceSync(String(pnid), result.token);
      result.history_requested = true;
      console.log(`✅ [lines/provision] Historial solicitado para ${result.display_phone || pnid}: ${JSON.stringify(sync).slice(0, 200)}`);
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      result.warnings.push(`No se pudo pedir el historial: ${msg} (esperable si el número no es de coexistencia)`);
      console.warn(`⚠️ [lines/provision] requestCoexistenceSync falló: ${msg}`);
    }
  }

  return result;
}

/**
 * GET /api/admin/lines — lista las líneas de la organización (sin tokens).
 * Cualquier usuario del tenant (el inbox necesita los labels para el filtro).
 */
router.get('/admin/lines', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido (super-admin: ?tenant_id=)' });
  try {
    const r = await db.query(
      `SELECT id, meta_phone_number_id, display_phone, label, waba_id, active, is_default,
              meta_token_enc IS NOT NULL AS has_own_token, created_at,
              (SELECT COUNT(*)::int FROM conversations c WHERE c.line_id = tenant_lines.id) AS conversations_count
       FROM tenant_lines WHERE tenant_id = $1
       ORDER BY is_default DESC, created_at ASC`,
      [tenantId]
    );
    // v0.9.489 — un agente asignado a líneas solo ve ESAS en los selectores. Antes el
    // combo listaba todas y elegir una ajena devolvía cero resultados sin explicar por qué.
    // Owner/supervisor/super-admin no se filtran (getAgentLineIds devuelve null).
    const _al = await getAgentLineIds(req);
    const lines = _al ? r.rows.filter(l => _al.includes(l.id)) : r.rows;
    res.json({ ok: true, lines });
  } catch (e) {
    if (/tenant_lines/.test(e.message)) return res.json({ ok: true, lines: [], pending_migration: true });
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines — el owner agrega una línea.
 * Body: { meta_phone_number_id, label?, display_phone?, waba_id?, meta_token?, force? }
 * meta_token opcional: si la línea es de la MISMA WABA, hereda el token
 * del tenant (o el global) y no hace falta pasarlo.
 *
 * v0.9.457: ya NO es un INSERT pelado. Verifica el número contra Meta y
 * deja la línea conectada de verdad (webhook + registro + historial). Si no
 * se puede verificar, responde 422 con el diagnóstico en vez de crear una
 * línea muerta; `force: true` la crea igual (escape hatch manual).
 */
router.post('/admin/lines', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const pnid = String(req.body.meta_phone_number_id || '').trim();
  let label = String(req.body.label || '').trim();
  let displayPhone = String(req.body.display_phone || '').trim() || null;
  let wabaId = String(req.body.waba_id || '').trim() || null;
  const metaToken = req.body.meta_token ? String(req.body.meta_token).trim() : null;
  const force = req.body.force === true || req.body.force === 'true';

  if (!pnid) return res.status(400).json({ error: 'meta_phone_number_id requerido' });
  if (!/^\d{6,20}$/.test(pnid)) return res.status(400).json({ error: 'meta_phone_number_id inválido (solo dígitos, es el ID de Meta, no el número de teléfono)' });

  try {
    const dupe = await db.query(
      'SELECT tenant_id FROM tenant_lines WHERE meta_phone_number_id = $1 UNION SELECT id FROM tenants WHERE meta_phone_number_id = $1 AND id != $2',
      [pnid, tenantId]
    );
    if (dupe.rows.length > 0) return res.status(409).json({ error: 'Ese número ya está registrado en una organización' });

    // 1. Conectar de verdad con Meta ANTES de insertar.
    const prov = await provisionMetaLine({
      tenantId, pnid, explicitToken: metaToken, explicitWaba: wabaId,
      wantHistory: req.body.skip_history !== true,
    });

    if (!prov.verified && !force) {
      return res.status(422).json({
        error: prov.warnings[0] || 'No se pudo verificar el número con Meta',
        warnings: prov.warnings,
        can_force: true,
        hint: 'Si estás seguro del phone_number_id, reintentá con force: true — pero la línea quedará sin webhook y NO recibirá mensajes hasta repararla.',
      });
    }

    // 2. Datos reales de Meta ganan sobre los tipeados a mano.
    if (prov.display_phone) displayPhone = prov.display_phone;
    if (prov.waba_id) wabaId = prov.waba_id;
    if (!label) label = prov.verified_name || displayPhone || `Línea ${pnid.slice(-4)}`;

    // 3. Guardamos el token que efectivamente funcionó, salvo que sea el
    //    global del env (ese ya se hereda solo) o el propio del tenant.
    const ownToken = metaToken || (prov.token && prov.token_source !== 'env' && prov.token_source !== 'tenant' ? prov.token : null);
    const tokenEnc = ownToken ? encryptToken(ownToken) : null;

    const ins = await db.query(
      `INSERT INTO tenant_lines (tenant_id, meta_phone_number_id, display_phone, label, waba_id, meta_token_enc, pin_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, meta_phone_number_id, display_phone, label, waba_id, active, is_default, created_at`,
      [tenantId, pnid, displayPhone, label, wabaId, tokenEnc, prov.pin ? encryptToken(prov.pin) : null]
    );
    invalidatePhoneNumberIdCache();
    invalidateLineCtxCache();
    console.log(`✅ [lines] Línea agregada: tenant ${tenantId} → ${displayPhone || pnid} (webhook=${prov.webhook_subscribed} registrada=${prov.registered} historial=${prov.history_requested})`);

    res.status(201).json({
      ok: true,
      line: ins.rows[0],
      verified: prov.verified,
      webhook_subscribed: prov.webhook_subscribed,
      registered: prov.registered,
      history_requested: prov.history_requested,
      warnings: prov.warnings,
    });
  } catch (e) {
    if (/tenant_lines_meta_phone_number_id|unique/i.test(e.message)) {
      return res.status(409).json({ error: 'Ese número ya está registrado' });
    }
    console.error('❌ [lines] error agregando línea:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/:id/repair — v0.9.457
 * Re-ejecuta el provisioning sobre una línea YA creada. Sirve para las
 * líneas que se agregaron a mano antes de este fix y quedaron mudas
 * (sin webhook, sin registrar, sin historial). Idempotente.
 */
router.post('/admin/lines/:id/repair', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  try {
    const r = await db.query(
      'SELECT id, tenant_id, meta_phone_number_id, display_phone, label, waba_id FROM tenant_lines WHERE id = $1',
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const line = r.rows[0];
    if (!req.isSuperAdmin && Number(line.tenant_id) !== Number(tenantId)) {
      return res.status(403).json({ error: 'Esa línea no es de tu organización' });
    }

    const prov = await provisionMetaLine({
      tenantId: line.tenant_id,
      pnid: line.meta_phone_number_id,
      explicitToken: req.body?.meta_token ? String(req.body.meta_token).trim() : null,
      explicitWaba: line.waba_id,
      wantHistory: req.body?.skip_history !== true,
    });

    if (prov.verified) {
      // v0.9.457: guardar TAMBIÉN el token que funcionó (como hace POST /admin/lines).
      // Antes la reparación lo descartaba: si el operador pegaba un token a mano, la
      // reparación decía "ok" y no guardaba nada, así que el siguiente register /
      // sync-history / branding volvía a fallar. Y si el que sirvió era el de otra
      // línea, cada request posterior tenía que recorrer la escalera entera de nuevo
      // (varias llamadas a Graph por token). No se guarda si vino del env o del tenant:
      // esos ya se heredan solos.
      const ownToken = (req.body?.meta_token ? String(req.body.meta_token).trim() : null)
        || (prov.token && prov.token_source !== 'env' && prov.token_source !== 'tenant' ? prov.token : null);
      await db.query(
        `UPDATE tenant_lines SET
           waba_id = COALESCE($1, waba_id),
           display_phone = COALESCE($2, display_phone),
           pin_enc = COALESCE($3, pin_enc),
           meta_token_enc = COALESCE($4, meta_token_enc)
         WHERE id = $5`,
        [prov.waba_id, prov.display_phone, prov.pin ? encryptToken(prov.pin) : null,
         ownToken ? encryptToken(ownToken) : null, id]
      );
      invalidatePhoneNumberIdCache();
      invalidateLineCtxCache();
    }
    console.log(`🔧 [lines/repair] línea ${id} (${line.label}) → verificada=${prov.verified} webhook=${prov.webhook_subscribed} registrada=${prov.registered} historial=${prov.history_requested}`);

    res.json({
      ok: prov.verified,
      line_id: id,
      verified: prov.verified,
      waba_id: prov.waba_id,
      display_phone: prov.display_phone,
      webhook_subscribed: prov.webhook_subscribed,
      registered: prov.registered,
      history_requested: prov.history_requested,
      warnings: prov.warnings,
    });
  } catch (e) {
    console.error('❌ [lines/repair] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/lines/available — v0.9.457 (punto 3 de José)
 * Enumera los números del portafolio que el token de la org ya administra,
 * marcando cuáles están conectados. Con esto el panel ofrece "agregar" de
 * un click en vez de pedir el phone_number_id a mano.
 */
router.get('/admin/lines/available', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const tokens = await resolveTenantTokens(tenantId, null);
    if (!tokens.length) {
      return res.json({ ok: true, numbers: [], no_token: true, message: 'La organización no tiene token de Meta guardado. Conectá con el botón de Facebook.' });
    }

    // pnids ya tomados (en esta org o en cualquier otra)
    const taken = new Map();
    const tk = await db.query(
      `SELECT meta_phone_number_id AS pnid, tenant_id FROM tenant_lines WHERE meta_phone_number_id IS NOT NULL
       UNION SELECT meta_phone_number_id AS pnid, id AS tenant_id FROM tenants WHERE meta_phone_number_id IS NOT NULL`
    );
    for (const row of tk.rows) taken.set(String(row.pnid), Number(row.tenant_id));

    const seenPnid = new Set();
    const numbers = [];
    const errors = [];
    for (const { token, source } of tokens) {
      const wabas = await resolveWabaCandidates(tenantId, null, token);
      for (const waba of wabas) {
        let phones;
        try {
          phones = await meta.getPhoneNumbers(waba, token);
        } catch (e) {
          errors.push({ waba_id: waba, token_source: source, error: e.response?.data?.error?.message || e.message });
          continue;
        }
        for (const p of phones) {
          const pnid = String(p.id);
          if (seenPnid.has(pnid)) continue;
          seenPnid.add(pnid);
          const owner = taken.has(pnid) ? taken.get(pnid) : null;
          numbers.push({
            meta_phone_number_id: pnid,
            display_phone: p.display_phone_number || null,
            verified_name: p.verified_name || null,
            quality_rating: p.quality_rating || null,
            status: p.status || null,
            waba_id: String(waba),
            connected: owner !== null,
            connected_here: owner !== null && Number(owner) === Number(tenantId),
          });
        }
      }
    }
    numbers.sort((a, b) => (a.connected === b.connected ? 0 : a.connected ? 1 : -1));
    res.json({ ok: true, numbers, errors: errors.length ? errors : undefined });
  } catch (e) {
    console.error('❌ [lines/available] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/connect-facebook — v0.9.14
 * El owner conecta una línea vía Meta Embedded Signup (popup del panel).
 * Body: { code, waba_id, phone_number_id }  (del evento WA_EMBEDDED_SIGNUP)
 *
 * Mismo flujo que el onboarding pero sobre la org EXISTENTE:
 *   code → token propio de esa WABA → validar que el número pertenece al
 *   token → suscribir WABA al webhook → crear tenant_line con token encriptado.
 */
router.post('/admin/lines/connect-facebook', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  // v0.9.69 (auditoría 12-jun P1#11): rate limit — dispara exchange + llamadas a Meta
  {
    const { rateLimitOk } = require('./auth');
    if (!rateLimitOk('connect-fb:' + tenantId, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Demasiados intentos de conexión. Esperá unos minutos.' });
    }
  }
  const { code, waba_id, phone_number_id } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code requerido' });
  if (!waba_id || !phone_number_id) {
    return res.status(400).json({ error: 'waba_id y phone_number_id requeridos (no llegó el evento WA_EMBEDDED_SIGNUP; reintentá)' });
  }
  if (!process.env.ENCRYPTION_KEY) {
    return res.status(503).json({ error: 'Servidor no configurado (falta ENCRYPTION_KEY)' });
  }

  try {
    // 1. Duplicados: en líneas o como número principal de OTRA org
    const dupe = await db.query(
      `SELECT tenant_id AS tid FROM tenant_lines WHERE meta_phone_number_id = $1
       UNION SELECT id AS tid FROM tenants WHERE meta_phone_number_id = $1`,
      [phone_number_id]
    );
    if (dupe.rows.length > 0) {
      const mine = dupe.rows.some(r => Number(r.tid) === Number(tenantId));
      return res.status(409).json({ error: mine ? 'Ese número ya es una línea de tu organización' : 'Ese número ya está conectado en otra organización' });
    }

    // 2. Exchange code → access_token (token de ESA WABA)
    let tokenData;
    try {
      tokenData = await meta.exchangeCodeForToken(code);
    } catch (e) {
      console.error('❌ [lines/connect-fb] exchange falló:', e.response?.data || e.message);
      return res.status(400).json({ error: 'No se pudo validar con Meta', detail: e.response?.data?.error?.message || e.message });
    }
    const accessToken = tokenData.access_token;
    if (!accessToken) return res.status(400).json({ error: 'Meta no devolvió token' });

    // 3. Validar que el número pertenece a la WABA del token (anti-spoof)
    //    + obtener el display phone de paso
    let displayPhone = null;
    let verifiedName = null;
    try {
      const phones = await meta.getPhoneNumbers(waba_id, accessToken);
      const match = phones.find(p => String(p.id) === String(phone_number_id));
      if (!match) {
        return res.status(403).json({ error: 'El número no pertenece a la WABA autorizada' });
      }
      displayPhone = match.display_phone_number || null;
      verifiedName = match.verified_name || null;
    } catch (e) {
      console.error('❌ [lines/connect-fb] getPhoneNumbers falló:', e.response?.data || e.message);
      return res.status(400).json({ error: 'No se pudo verificar el número con Meta', detail: e.response?.data?.error?.message || e.message });
    }

    // 4. Suscribir la WABA al webhook (warn-only, igual que onboarding)
    let webhookSubscribed = false;
    try {
      await meta.subscribeWABA(waba_id, accessToken);
      webhookSubscribed = true;
      console.log(`✅ [lines/connect-fb] WABA ${waba_id} suscrita al webhook`);
    } catch (e) {
      console.warn('⚠️ [lines/connect-fb] No se pudo suscribir WABA:', e.response?.data?.error?.message || e.message);
    }

    // 5. Crear la línea con token propio encriptado
    const label = verifiedName || displayPhone || `Línea ${phone_number_id.slice(-4)}`;
    const ins = await db.query(
      `INSERT INTO tenant_lines (tenant_id, meta_phone_number_id, display_phone, label, waba_id, meta_token_enc)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, meta_phone_number_id, display_phone, label, waba_id, active, is_default, created_at`,
      [tenantId, String(phone_number_id), displayPhone, label, String(waba_id), encryptToken(accessToken)]
    );
    invalidatePhoneNumberIdCache();
    invalidateLineCtxCache();
    console.log(`✅ [lines/connect-fb] Línea creada: tenant ${tenantId} → ${displayPhone || phone_number_id}`);

    // v0.9.63: registrar el número en Cloud API (sin esto queda "Pendiente"
    // en el WhatsApp Manager). Warn-only: coexistence ya viene registrado y
    // un número con PIN de dos pasos previo requiere registro manual.
    let registered = false;
    try {
      const pin = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
      await meta.registerPhoneNumber(String(phone_number_id), accessToken, pin);
      await db.query(`UPDATE tenant_lines SET pin_enc = $1 WHERE id = $2`, [encryptToken(pin), ins.rows[0].id]);
      registered = true;
      console.log(`✅ [lines/connect-fb] Número ${displayPhone || phone_number_id} REGISTRADO en Cloud API`);
    } catch (e) {
      console.warn(`⚠️ [lines/connect-fb] No se pudo registrar el número (no bloqueante): ${e.response?.data?.error?.message || e.message}`);
    }

    res.status(201).json({ ok: true, line: ins.rows[0], webhook_subscribed: webhookSubscribed, registered });
  } catch (e) {
    if (/unique/i.test(e.message)) return res.status(409).json({ error: 'Ese número ya está registrado' });
    console.error('❌ [lines/connect-fb] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/:id/register — v0.9.63 (solo super-admin)
 * Registra (o re-registra) el número de una línea en Cloud API.
 * Body opcional: { pin: "123456" } — si el número ya tenía verificación en
 * dos pasos, hay que pasar ESE pin (o resetearlo desde el WhatsApp Manager).
 * Sin body: reusa el pin guardado o genera uno nuevo (queda cifrado).
 */
/**
 * GET /api/admin/lines/preflight-probe — SUPER-ADMIN. Sonda de campos de Meta.
 *
 * Paso previo al pre-flight de conexión: antes de construir chequeos sobre campos
 * como name_status o code_verification_status, hay que saber cuáles devuelve Meta
 * DE VERDAD con nuestra app y nuestro nivel de acceso. Con Standard Access, Graph
 * omite varios campos en silencio —200 OK, sin el campo y sin error—, así que
 * asumirlos es la forma de que el pre-flight falle en la cuenta de un cliente.
 *
 * Uso:  /api/admin/lines/preflight-probe?tenant_id=14
 *   o:  /api/admin/lines/preflight-probe?waba_id=...&line_id=...
 *
 * No escribe nada ni toca ninguna línea: solo lee y reporta.
 */
router.get('/admin/lines/preflight-probe', requireAdminToken, async (req, res) => {
  try {
    const tenantId = parseInt(req.query.tenant_id, 10) || null;
    const lineId = parseInt(req.query.line_id, 10) || null;
    let wabaId = String(req.query.waba_id || '').trim() || null;
    let tokenEnc = null, tId = tenantId;

    if (lineId) {
      const r = await db.query(`SELECT tenant_id, waba_id, meta_token_enc FROM tenant_lines WHERE id = $1`, [lineId]);
      if (!r.rows[0]) return res.status(404).json({ error: 'línea no encontrada' });
      tId = r.rows[0].tenant_id; tokenEnc = r.rows[0].meta_token_enc;
      wabaId = wabaId || r.rows[0].waba_id;
    } else if (tenantId) {
      const r = await db.query(
        `SELECT waba_id, meta_token_enc FROM tenant_lines
          WHERE tenant_id = $1 AND waba_id IS NOT NULL
          ORDER BY (meta_token_enc IS NOT NULL) DESC, id ASC LIMIT 1`, [tenantId]);
      if (r.rows[0]) { tokenEnc = r.rows[0].meta_token_enc; wabaId = wabaId || r.rows[0].waba_id; }
    }
    // Misma escalera de tokens que usa el alta: así la sonda mide lo que el flujo real ve.
    const tokens = await resolveTenantTokens(tId, tokenEnc);
    if (!tokens.length) return res.status(400).json({ error: 'No hay ningún token de Meta disponible para ese tenant. Conectá al menos una línea primero.' });

    // Si no salió de la DB, se descubre igual que en el alta: WABA del tenant, de sus
    // líneas, y por último el portafolio del token. Así la sonda sirve también en un
    // tenant al que nunca se le guardó el waba_id.
    if (!wabaId) {
      try {
        const cands = await resolveWabaCandidates(tId, null, tokens[0].token);
        if (cands && cands.length) wabaId = String(cands[0]);
      } catch (e) { /* sigue al error de abajo */ }
    }
    if (!wabaId) {
      return res.status(400).json({
        error: 'No encontré ninguna WhatsApp Business Account para sondear.',
        hint: 'Pasá ?waba_id=... a mano, o ?line_id=... de una línea que veas conectada en el super-admin.',
      });
    }

    let probe = null, tokenUsado = null, errores = [];
    for (const t of tokens) {
      try {
        const out = await meta.probeOnboardingFields(wabaId, t.token);
        if (out && (out.numeros.length || (out.waba && Object.keys(out.waba.disponibles).length))) { probe = out; tokenUsado = t.source || 'token'; break; }
        errores.push({ origen: t.source || 'token', nota: 'respondió vacío' });
      } catch (e) {
        errores.push({ origen: t.source || 'token', error: e.response?.data?.error?.message || e.message });
      }
    }
    if (!probe) return res.status(502).json({ error: 'Ningún token pudo leer esa WABA', intentos: errores });

    // Resumen legible: qué campos sirven para el pre-flight y cuáles no.
    const primer = probe.numeros[0];
    const resumen = primer ? {
      campos_del_numero_disponibles: Object.keys(primer.probe.disponibles),
      campos_del_numero_omitidos: primer.probe.ausentes,
      campos_del_numero_con_error: Object.keys(primer.probe.errores),
    } : { nota: 'La WABA no devolvió números.' };
    resumen.campos_de_la_waba_disponibles = probe.waba ? Object.keys(probe.waba.disponibles) : [];
    resumen.campos_de_la_waba_omitidos = probe.waba ? probe.waba.ausentes : [];

    console.log(`🔬 [preflight-probe] tenant ${tId} waba ${wabaId} · token=${tokenUsado} · números=${probe.numeros.length} · campos ok=${(resumen.campos_del_numero_disponibles || []).length}`);
    res.json({ ok: true, tenant_id: tId, token_usado: tokenUsado, resumen, probe });
  } catch (e) {
    console.error('❌ [preflight-probe]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/admin/lines/:id/register', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  try {
    const r = await db.query(
      `SELECT id, tenant_id, meta_phone_number_id, display_phone, meta_token_enc, pin_enc
       FROM tenant_lines WHERE id = $1`, [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const line = r.rows[0];

    let pin = req.body?.pin ? String(req.body.pin).trim() : null;
    if (!pin && line.pin_enc) pin = decryptSafe(line.pin_enc);
    if (!pin) pin = String(require('crypto').randomInt(0, 1000000)).padStart(6, '0');
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'El pin debe ser de 6 dígitos' });

    // v0.9.457: EN CAPAS (línea → tenant → otras líneas → global). Antes, una
    // línea sin token propio se registraba con el token global y Meta la rechazaba.
    const { result: out } = await callMetaWithTenantTokens(line.tenant_id, line.meta_token_enc,
      (token) => meta.registerPhoneNumber(String(line.meta_phone_number_id), token, pin));
    await db.query(`UPDATE tenant_lines SET pin_enc = $1 WHERE id = $2`, [encryptToken(pin), id]);
    console.log(`✅ [lines/register] Línea ${id} (tenant ${line.tenant_id}, ${line.display_phone || line.meta_phone_number_id}) registrada en Cloud API`);
    res.json({ ok: true, registered: true, result: out });
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    console.error('❌ [lines/register] error:', detail);
    res.status(400).json({
      error: 'No se pudo registrar el número',
      detail,
      hint: 'Si el número ya tenía PIN de dos pasos, mandalo en {"pin":"XXXXXX"} o resetealo en WhatsApp Manager → Números de teléfono → ⚙️.',
    });
  }
});

/**
 * POST /api/admin/lines/:id/disconnect — v0.9.280 (solo super-admin) — SUAVE
 * Pausa la línea: active = FALSE. El bot deja de responder al instante (el ruteo
 * filtra active). NO toca Meta ni el token ⇒ 100% reversible con /reconnect.
 */
router.post('/admin/lines/:id/disconnect', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  try {
    const r = await db.query(
      `UPDATE tenant_lines SET active = FALSE
         WHERE id = $1
       RETURNING id, tenant_id, active, display_phone, meta_phone_number_id`, [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const l = r.rows[0];
    console.log(`🔌 [lines/disconnect] Línea ${id} (tenant ${l.tenant_id}, ${l.display_phone || l.meta_phone_number_id}) PAUSADA (active=FALSE)`);
    res.json({ ok: true, id: l.id, active: l.active });
  } catch (e) {
    console.error('❌ [lines/disconnect] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/lines/:id/billing — v0.9.525 (solo super-admin).
 * Marca/desmarca una línea como NO facturable (billing_excluded). Una línea excluida
 * no cobra su price_per_line ni su setup; el cupo de usuarios no cambia.
 * Body: { billing_excluded: true|false }
 */
router.patch('/admin/lines/:id/billing', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  if (typeof req.body.billing_excluded !== 'boolean') return res.status(400).json({ error: 'billing_excluded (bool) requerido' });
  try {
    await db.query('ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS billing_excluded BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
    const r = await db.query(
      `UPDATE tenant_lines SET billing_excluded = $1 WHERE id = $2
       RETURNING id, tenant_id, billing_excluded`, [req.body.billing_excluded === true, id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    console.log(`💸 [lines/billing] Línea ${id} (tenant ${r.rows[0].tenant_id}) billing_excluded=${r.rows[0].billing_excluded}`);
    res.json({ ok: true, id: r.rows[0].id, billing_excluded: r.rows[0].billing_excluded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/:id/disconnect-hard — v0.9.280 (solo super-admin) — DEFINITIVA
 * active = FALSE + des-suscribe el WABA en Meta (deja de enviar webhooks).
 * GUARDAS: no des-suscribe el WABA global (META_WABA_ID) ni uno compartido por otra
 * línea activa → en esos casos cae a suave y lo informa. NO borra la fila.
 */
router.post('/admin/lines/:id/disconnect-hard', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  try {
    const lr = await db.query(
      `SELECT tl.id, tl.tenant_id, tl.waba_id AS line_waba, tl.meta_token_enc,
              tl.display_phone, tl.meta_phone_number_id, t.waba_id AS tenant_waba
         FROM tenant_lines tl JOIN tenants t ON t.id = tl.tenant_id
        WHERE tl.id = $1`, [id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const line = lr.rows[0];

    await db.query(`UPDATE tenant_lines SET active = FALSE WHERE id = $1`, [id]);

    const effWaba = line.line_waba || line.tenant_waba || null;
    const GLOBAL_WABA = process.env.META_WABA_ID || null;
    let unsubscribed = false, reason;

    if (!effWaba) {
      reason = 'la línea no tiene WABA propio (usa el global) → solo se pausó (suave)';
    } else if (GLOBAL_WABA && String(effWaba) === String(GLOBAL_WABA)) {
      reason = 'es el WABA global de SG Bolivia → NO se des-suscribe (cortaría a todos). Solo se pausó (suave)';
    } else {
      const others = await db.query(
        `SELECT COUNT(*)::int AS n FROM tenant_lines
          WHERE active = TRUE AND id <> $1
            AND COALESCE(waba_id, (SELECT waba_id FROM tenants WHERE id = tenant_lines.tenant_id)) = $2`,
        [id, String(effWaba)]);
      if (others.rows[0].n > 0) {
        reason = `otras ${others.rows[0].n} línea(s) activa(s) comparten este WABA → NO se des-suscribe. Solo se pausó (suave)`;
      } else {
        try {
          // v0.9.457: EN CAPAS — antes se des-suscribía (o se intentaba) con el token global.
          await callMetaWithTenantTokens(line.tenant_id, line.meta_token_enc,
            (token) => meta.unsubscribeWABA(String(effWaba), token));
          unsubscribed = true;
          reason = 'WABA des-suscrito de la app en Meta (dejará de enviar webhooks)';
        } catch (e) {
          reason = 'no se pudo des-suscribir en Meta (' + (e.response?.data?.error?.message || e.message) + ') — quedó pausada (suave)';
          console.warn('⚠️ [lines/disconnect-hard]', reason);
        }
      }
    }
    console.log(`🔌 [lines/disconnect-hard] Línea ${id} (tenant ${line.tenant_id}, ${line.display_phone || line.meta_phone_number_id}) — active=FALSE; unsubscribed=${unsubscribed} (${reason})`);
    res.json({ ok: true, id, active: false, unsubscribed, detail: reason });
  } catch (e) {
    console.error('❌ [lines/disconnect-hard] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/:id/reconnect — v0.9.280 (solo super-admin)
 * active = TRUE + re-suscribe el WABA (best-effort, idempotente → cubre la
 * reconexión tanto de la suave como de la definitiva).
 */
router.post('/admin/lines/:id/reconnect', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  try {
    const lr = await db.query(
      `SELECT tl.id, tl.tenant_id, tl.waba_id AS line_waba, tl.meta_token_enc,
              tl.display_phone, tl.meta_phone_number_id, t.waba_id AS tenant_waba
         FROM tenant_lines tl JOIN tenants t ON t.id = tl.tenant_id
        WHERE tl.id = $1`, [id]);
    if (!lr.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const line = lr.rows[0];
    await db.query(`UPDATE tenant_lines SET active = TRUE WHERE id = $1`, [id]);

    let resubscribed = false;
    const effWaba = line.line_waba || line.tenant_waba || null;
    if (effWaba) {
      try {
        // v0.9.457: EN CAPAS — antes, una línea sin token propio se re-suscribía con
        // el token global y Meta la rechazaba: la línea volvía a active=TRUE pero SIN webhook.
        await callMetaWithTenantTokens(line.tenant_id, line.meta_token_enc,
          (token) => meta.subscribeWABA(String(effWaba), token));
        resubscribed = true;
      } catch (e) {
        console.warn('⚠️ [lines/reconnect] re-subscribe (warn-only):', e.response?.data?.error?.message || e.message);
      }
    }
    console.log(`🔌 [lines/reconnect] Línea ${id} (tenant ${line.tenant_id}) RECONECTADA (active=TRUE; resubscribed=${resubscribed})`);
    res.json({ ok: true, id, active: true, resubscribed });
  } catch (e) {
    console.error('❌ [lines/reconnect] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/backfill-null — v0.9.475 (solo super-admin)
 * Atribuye a una LÍNEA las conversaciones históricas del tenant que quedaron con line_id NULL
 * (entraron por la vía legacy, antes de registrar la línea en tenant_lines). Los mensajes
 * heredan la línea vía la conversación, así que con esto el bloque "Sin línea" desaparece y el
 * filtro por línea pasa a incluir el historial.
 *   body/query: { tenant_id, line_id? }
 *     - line_id explícito → asigna a esa línea (debe ser una línea activa del tenant).
 *     - sin line_id → si el tenant tiene UNA sola línea activa, la usa; si tiene varias, 409 + lista.
 *   dry_run=1 → solo cuenta, no escribe.
 */
router.post('/admin/lines/backfill-null', requireAdminToken, async (req, res) => {
  try {
    const tenantId = parseInt((req.body && req.body.tenant_id) != null ? req.body.tenant_id : req.query.tenant_id, 10);
    if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'tenant_id requerido' });
    const dryRun = String((req.body && req.body.dry_run) || req.query.dry_run || '') === '1';
    let target = (req.body && req.body.line_id != null) ? parseInt(req.body.line_id, 10)
      : (req.query.line_id ? parseInt(req.query.line_id, 10) : null);

    const lr = await db.query(
      'SELECT id, label, display_phone FROM tenant_lines WHERE tenant_id = $1 AND active = TRUE ORDER BY is_default DESC NULLS LAST, id ASC',
      [tenantId]);
    const lines = lr.rows;

    if (target == null) {
      if (lines.length === 1) target = lines[0].id;
      else if (lines.length === 0) return res.status(409).json({ error: 'El tenant no tiene líneas activas; no hay a dónde asignar.' });
      else return res.status(409).json({ error: 'El tenant tiene varias líneas activas; especificá line_id de destino.', lines });
    } else if (!lines.some(l => Number(l.id) === Number(target))) {
      return res.status(400).json({ error: 'line_id no pertenece a una línea activa de este tenant', lines });
    }

    const cnt = await db.query('SELECT COUNT(*)::int AS n FROM conversations WHERE tenant_id = $1 AND line_id IS NULL', [tenantId]);
    const nNull = cnt.rows[0].n;
    if (dryRun) return res.json({ ok: true, dry_run: true, tenant_id: tenantId, line_id: target, would_update: nNull, lines });

    const upd = await db.query('UPDATE conversations SET line_id = $2 WHERE tenant_id = $1 AND line_id IS NULL', [tenantId, target]);
    console.log(`🧩 [backfill-null] tenant ${tenantId}: ${upd.rowCount} conversaciones sin línea → línea ${target}`);
    res.json({ ok: true, tenant_id: tenantId, line_id: target, updated: upd.rowCount, was_null: nNull });
  } catch (e) {
    console.error('❌ [backfill-null]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/lines/:id/sync-history — v0.9.225 (solo super-admin)
 * Le PIDE a Meta el HISTORIAL de coexistence (backfill de chats hasta ~6 meses) +
 * contactos para una línea YA conectada. Meta NO lo manda solo: hay que solicitarlo
 * con POST /{phone_number_id}/smb_app_data sync_type=history. Útil para líneas
 * onboardeadas antes de v0.9.225 (donde el pedido no se hacía y el webhook 'history'
 * nunca llegaba). Meta envía el webhook 'history' en los minutos siguientes
 * (lo recibe webhook.js → 🕓 EVENTO history RECIBIDO → quality_events).
 */
router.post('/admin/lines/:id/sync-history', requireAdminToken, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'line id inválido' });
  try {
    const r = await db.query(
      `SELECT id, tenant_id, meta_phone_number_id, display_phone, meta_token_enc
       FROM tenant_lines WHERE id = $1`, [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Línea no encontrada' });
    const line = r.rows[0];
    if (!line.meta_phone_number_id) return res.status(400).json({ error: 'La línea no tiene phone_number_id' });

    // v0.9.457: EN CAPAS. Este es EL endpoint para traer el historial de una línea
    // que quedó muda, así que con el token equivocado el síntoma era exactamente
    // el que reportó José: se pide el historial, Meta dice "no existe", no llega nada.
    const { result: out } = await callMetaWithTenantTokens(line.tenant_id, line.meta_token_enc,
      (token) => meta.requestCoexistenceSync(String(line.meta_phone_number_id), token));
    console.log(`🕓 [lines/sync-history] Solicitado history+contactos para línea ${id} (tenant ${line.tenant_id}, ${line.display_phone || line.meta_phone_number_id}) — Meta debería mandar el webhook 'history' en breve`);
    res.json({ ok: true, requested: true, result: out });
  } catch (e) {
    const detail = e.response?.data?.error?.message || e.message;
    console.error('❌ [lines/sync-history] error:', detail);
    res.status(400).json({ error: 'No se pudo solicitar el historial', detail });
  }
});

/**
 * POST /api/admin/tenants/:id/sync-history — v0.9.238 (solo super-admin)
 * Atajo: pide el historial de coexistence para TODAS las líneas del tenant de una vez
 * (el line id no siempre está a mano; el tenant id sí). Llama requestCoexistenceSync por línea.
 */
router.post('/admin/tenants/:id/sync-history', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'tenant id inválido' });
  try {
    const r = await db.query(
      `SELECT id, meta_phone_number_id, display_phone, meta_token_enc
       FROM tenant_lines WHERE tenant_id = $1 AND meta_phone_number_id IS NOT NULL`, [tenantId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'El tenant no tiene líneas con phone_number_id' });
    const results = [];
    for (const line of r.rows) {
      const _label = line.display_phone || line.meta_phone_number_id;
      try {
        // v0.9.457: EN CAPAS (ver callMetaWithTenantTokens).
        await callMetaWithTenantTokens(tenantId, line.meta_token_enc,
          (token) => meta.requestCoexistenceSync(String(line.meta_phone_number_id), token));
        results.push({ line_id: line.id, phone: _label, ok: true });
        console.log(`🕓 [tenants/sync-history] Solicitado history para línea ${line.id} (tenant ${tenantId}, ${_label})`);
      } catch (e) {
        results.push({ line_id: line.id, phone: _label, ok: false, error: e.response?.data?.error?.message || e.message });
      }
    }
    const okCount = results.filter(x => x.ok).length;
    res.json({ ok: okCount > 0, requested: okCount, total: results.length, results });
  } catch (e) {
    res.status(400).json({ error: 'No se pudo solicitar el historial', detail: e.response?.data?.error?.message || e.message });
  }
});

/**
 * GET /api/admin/tenants/:id/line-info — v0.9.240 (solo super-admin)
 * Trae el NÚMERO real (display_phone_number) + verified_name de cada línea del tenant,
 * consultándolo a Meta por su phone_number_id. La DB a veces guarda solo el nombre.
 */
router.get('/admin/tenants/:id/line-info', requireAdminToken, async (req, res) => {
  const tenantId = parseInt(req.params.id, 10);
  if (!Number.isFinite(tenantId)) return res.status(400).json({ error: 'tenant id inválido' });
  try {
    const r = await db.query(
      `SELECT id, meta_phone_number_id, display_phone, meta_token_enc FROM tenant_lines WHERE tenant_id = $1 ORDER BY id`,
      [tenantId]
    );
    const lines = [];
    for (const line of r.rows) {
      let display_phone_number = null, verified_name = null, token_source = null;
      if (line.meta_phone_number_id) {
        // v0.9.457: por CAPAS (línea → tenant → otras líneas → global). Antes saltaba
        // del token de la línea al GLOBAL y Meta contestaba "does not exist" para
        // números perfectamente válidos de otro portafolio.
        const probe = await probePhoneNumberInfo(tenantId, line.meta_phone_number_id, line.meta_token_enc);
        if (probe.info) {
          display_phone_number = probe.info.display_phone_number;
          verified_name = probe.info.verified_name;
          token_source = probe.token_source;
        }
      }
      lines.push({ line_id: line.id, phone_number_id: line.meta_phone_number_id || null, display_phone_number, verified_name, stored: line.display_phone || null, token_source });
    }
    res.json({ ok: true, lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/lines/:id — el owner edita una línea.
 * Body (opcionales): { label, display_phone, active, is_default, meta_token }
 * meta_token: string = setear (encriptado) · "" = borrar (hereda tenant/global)
 */
router.patch('/admin/lines/:id', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const lineId = parseInt(req.params.id);
  if (!lineId) return res.status(400).json({ error: 'id inválido' });

  const { label, display_phone, active, is_default, meta_token } = req.body || {};
  try {
    const cur = await db.query('SELECT id, is_default FROM tenant_lines WHERE id = $1 AND tenant_id = $2', [lineId, tenantId]);
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Línea no encontrada' });

    if (active === false && cur.rows[0].is_default) {
      return res.status(400).json({ error: 'No podés desactivar la línea principal. Marcá otra como principal primero.' });
    }

    // Cambio de default: primero desmarcar la actual (índice único parcial)
    if (is_default === true) {
      await db.query('UPDATE tenant_lines SET is_default = FALSE WHERE tenant_id = $1 AND is_default', [tenantId]);
    }

    const sets = [];
    const params = [];
    let i = 1;
    if (label !== undefined)         { sets.push(`label = $${i++}`);         params.push(String(label).trim()); }
    if (display_phone !== undefined) { sets.push(`display_phone = $${i++}`); params.push(String(display_phone).trim() || null); }
    if (active !== undefined)        { sets.push(`active = $${i++}`);        params.push(!!active); }
    if (is_default === true)         { sets.push(`is_default = TRUE`); }
    if (meta_token !== undefined) {
      sets.push(`meta_token_enc = $${i++}`);
      params.push(meta_token ? encryptToken(String(meta_token).trim()) : null);
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

    params.push(lineId, tenantId);
    const r = await db.query(
      `UPDATE tenant_lines SET ${sets.join(', ')}
       WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING id, meta_phone_number_id, display_phone, label, waba_id, active, is_default, created_at`,
      params
    );
    invalidatePhoneNumberIdCache();
    invalidateLineCtxCache();
    res.json({ ok: true, line: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * DELETE /api/admin/lines/:id — v0.9.460 (pedido de José: el owner no tenía
 * cómo BORRAR una línea, solo desactivarla). Reglas:
 *   - Nunca la línea principal (marcá otra como principal primero).
 *   - Solo si NO tiene conversaciones (una línea con historia se DESACTIVA,
 *     no se borra — borrar el registro dejaría conversaciones huérfanas).
 * Caso de uso real: líneas agregadas a mano con un phone_number_id
 * equivocado/inexistente (tenant 12: Adriana y Evelin) que quedaron mudas
 * con 0 conversaciones y no se pueden reparar.
 */
router.delete('/admin/lines/:id', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const lineId = parseInt(req.params.id);
  if (!lineId) return res.status(400).json({ error: 'id inválido' });
  try {
    const cur = await db.query(
      `SELECT id, label, is_default,
              (SELECT COUNT(*)::int FROM conversations c WHERE c.line_id = tenant_lines.id) AS conversations_count
       FROM tenant_lines WHERE id = $1 AND tenant_id = $2`,
      [lineId, tenantId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Línea no encontrada' });
    const line = cur.rows[0];
    if (line.is_default) {
      return res.status(400).json({ error: 'No podés borrar la línea principal. Marcá otra como principal primero.' });
    }
    if (line.conversations_count > 0) {
      return res.status(409).json({ error: `Esta línea tiene ${line.conversations_count} conversaciones. Para no perder ese historial, desactivala en vez de borrarla.` });
    }
    await db.query('DELETE FROM tenant_lines WHERE id = $1 AND tenant_id = $2', [lineId, tenantId]);
    invalidatePhoneNumberIdCache();
    invalidateLineCtxCache();
    console.log(`🗑️ [lines] línea ${lineId} ("${line.label || ''}") borrada por el owner (tenant ${tenantId})`);
    res.json({ ok: true, deleted: lineId });
  } catch (e) {
    console.error('❌ [lines] error borrando línea:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.12 — ORGANIZACIÓN Y USUARIOS (multi-usuario por tenant)
// Roles: owner | supervisor | agent. El super-admin pasa todos los gates
// (con ?tenant_id= para apuntar a una org concreta).
// =====================================================================

const bcryptUsers = require('bcryptjs');
const USER_ROLES = ['owner', 'supervisor', 'agent'];

// Resuelve el tenant target: el de la sesión, o ?tenant_id= si super-admin
function resolveOrgTenantId(req) {
  if (req.tenantId) return req.tenantId;
  if (req.isSuperAdmin && req.query.tenant_id) return parseInt(req.query.tenant_id);
  return null;
}

function genInviteCodeApi() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return `org-${s}`;
}

/**
 * GET /api/admin/org — info de la organización + código de invitación.
 * Solo owner (el código permite registrar agentes).
 */
router.get('/admin/org', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido (super-admin: ?tenant_id=)' });
  try {
    let r;
    try {
      r = await db.query(
        `SELECT id, slug, name, invite_code, alert_phone, inventory_bot_enabled,
                software_bot_enabled, realestate_bot_enabled,
                COALESCE(to_jsonb(tenants) ->> 'services_bot_enabled','false')::boolean AS services_bot_enabled,
                (cal_api_key IS NOT NULL) AS has_cal_key,
                calcom_event_url,
                to_jsonb(tenants) -> 'business_hours' AS business_hours,
                to_jsonb(tenants) -> 'agenda_config' AS agenda_config, -- v0.9.514
                to_jsonb(tenants) ->> 'bot_name' AS bot_name,
                to_jsonb(tenants) ->> 'bot_tone' AS bot_tone,
                COALESCE(to_jsonb(tenants) ->> 'onboarding_completed','true')::boolean AS onboarding_completed,
                COALESCE(to_jsonb(tenants) ->> 'salud_bot_enabled','false')::boolean AS salud_bot_enabled,
                COALESCE(to_jsonb(tenants) ->> 'belleza_bot_enabled','false')::boolean AS belleza_bot_enabled,
                COALESCE(to_jsonb(tenants) ->> 'restaurante_bot_enabled','false')::boolean AS restaurante_bot_enabled, COALESCE(to_jsonb(tenants) ->> 'vehiculos_bot_enabled','false')::boolean AS vehiculos_bot_enabled,
                COALESCE(to_jsonb(tenants) ->> 'arquitectura_bot_enabled','false')::boolean AS arquitectura_bot_enabled,
                COALESCE(to_jsonb(tenants) -> 'mode_visibility','{}'::jsonb) AS mode_visibility,
                COALESCE(to_jsonb(tenants) ->> 'support_enabled','false')::boolean AS support_enabled,
                COALESCE(to_jsonb(tenants) ->> 'c21_import_enabled','false')::boolean AS c21_import_enabled,
                COALESCE(to_jsonb(tenants) ->> 'c21_agents_enabled','false')::boolean AS c21_agents_enabled,
                COALESCE(to_jsonb(tenants) ->> 'bot_buttons_enabled','true')::boolean AS bot_buttons_enabled,
                COALESCE(to_jsonb(tenants) ->> 'comment_public_reply_enabled','false')::boolean AS comment_public_reply_enabled,
                to_jsonb(tenants) ->> 'comment_public_reply_text' AS comment_public_reply_text,
                COALESCE(NULLIF(to_jsonb(tenants) ->> 'comment_public_reply_mode',''),'ai') AS comment_public_reply_mode,
                to_jsonb(tenants) ->> 'comment_public_reply_error' AS comment_public_reply_error,
                to_jsonb(tenants) ->> 'comment_public_reply_error_at' AS comment_public_reply_error_at,
                active, created_at FROM tenants WHERE id = $1`,
        [tenantId]
      );
    } catch (e) {
      r = await db.query(
        'SELECT id, slug, name, invite_code, active, created_at FROM tenants WHERE id = $1',
        [tenantId]
      );
    }
    if (r.rows.length === 0) return res.status(404).json({ error: 'Organización no encontrada' });
    res.json({ ok: true, org: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/org — v0.9.19: configurar el número de alertas de la org.
 * Body: { alert_phone }  ("" = desactivar alertas por WhatsApp)
 */
router.patch('/admin/org', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const sets = [];
  const params = [];
  let i = 1;
  if (req.body.alert_phone !== undefined) {
    const raw = String(req.body.alert_phone || '').replace(/[^0-9]/g, '');
    if (raw && (raw.length < 8 || raw.length > 15)) {
      return res.status(400).json({ error: 'Número inválido: usá formato internacional sin + (ej. 59177001196)' });
    }
    sets.push(`alert_phone = $${i++}`); params.push(raw || null);
  }
  if (req.body.comment_public_reply_enabled !== undefined || req.body.comment_public_reply_text !== undefined
      || req.body.comment_public_reply_mode !== undefined) {
    // v0.9.568 — self-heal: si el tenant viene de un deploy viejo, las columnas no existen
    try { await require('./comment-reply-ai').ensureSchema(); } catch (e) { /* best-effort */ }
  }
  if (req.body.comment_public_reply_enabled !== undefined) { // v0.9.566 — respuesta pública a comentarios
    sets.push(`comment_public_reply_enabled = $${i++}`); params.push(!!req.body.comment_public_reply_enabled);
  }
  if (req.body.comment_public_reply_text !== undefined) {
    sets.push(`comment_public_reply_text = $${i++}`); params.push(String(req.body.comment_public_reply_text || '').slice(0, 200) || null);
  }
  if (req.body.comment_public_reply_mode !== undefined) { // v0.9.568 — 'ai' (redacta la IA) | 'fixed' (texto literal)
    const md = String(req.body.comment_public_reply_mode || 'ai').toLowerCase();
    sets.push(`comment_public_reply_mode = $${i++}`); params.push(md === 'fixed' ? 'fixed' : 'ai');
  }
  if (req.body.bot_buttons_enabled !== undefined) { // v0.9.397 — master switch de botones interactivos
    sets.push(`bot_buttons_enabled = $${i++}`); params.push(!!req.body.bot_buttons_enabled);
  }
  // v0.9.28: modos de venta EXCLUYENTES — activar uno apaga los otros dos.
  // (antes v0.9.21/22 permitían combinar; generaba confusión catálogo/persona)
  {
    const MODE_FLAGS = ['software_bot_enabled', 'inventory_bot_enabled', 'realestate_bot_enabled', 'services_bot_enabled', 'salud_bot_enabled', 'belleza_bot_enabled', 'restaurante_bot_enabled', 'vehiculos_bot_enabled', 'arquitectura_bot_enabled']; // v0.9.87: rubros como modos propios (exclusivos) · v0.9.122: + arquitectura · v0.9.224: + vehiculos
    const sentFlags = MODE_FLAGS.filter(f => req.body[f] !== undefined);
    if (sentFlags.length > 0) {
      const turnedOn = sentFlags.find(f => !!req.body[f]) || null;
      if (turnedOn) {
        // Uno se enciende → los tres quedan definidos: solo ese en TRUE
        for (const f of MODE_FLAGS) { sets.push(`${f} = $${i++}`); params.push(f === turnedOn); }
      } else {
        // Solo apagados explícitos
        for (const f of sentFlags) { sets.push(`${f} = $${i++}`); params.push(false); }
      }
    }
  }
  // v0.9.514 — parámetros de la agenda a nivel organización. Se sanitizan en
  // agenda.js (acota rangos y descarta fechas inexistentes), así que acá solo se
  // guarda lo que ya volvió limpio. null/'' borra la config y vuelve a los defaults.
  if (req.body.agenda_config !== undefined) {
    const ac = req.body.agenda_config;
    if (ac === null || ac === '') { sets.push(`agenda_config = $${i++}`); params.push(null); }
    else if (typeof ac === 'object') { sets.push(`agenda_config = $${i++}`); params.push(JSON.stringify(agenda.sanitize(ac))); }
  }
  if (req.body.business_hours !== undefined) { // v0.9.58 — horarios de atención
    const bh = req.body.business_hours;
    if (bh === null || bh === '') {
      sets.push(`business_hours = $${i++}`); params.push(null);
    } else if (typeof bh === 'object') {
      // validación liviana: estructura { tz, days:{...}, note }
      const clean = { tz: String(bh.tz || 'America/La_Paz').slice(0, 40), days: {}, note: String(bh.note || '').slice(0, 200) };
      const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
      for (const d of DAYS) {
        const ranges = Array.isArray(bh.days?.[d]) ? bh.days[d] : [];
        clean.days[d] = ranges
          .filter(rg => rg && /^\d{1,2}:\d{2}$/.test(rg.open) && /^\d{1,2}:\d{2}$/.test(rg.close))
          .slice(0, 3)
          .map(rg => ({ open: rg.open, close: rg.close }));
      }
      sets.push(`business_hours = $${i++}`); params.push(JSON.stringify(clean));
    }
  }
  if (req.body.calcom_event_url !== undefined) { // v0.9.31 — link de agenda que Aitana manda
    const u = String(req.body.calcom_event_url || '').trim();
    if (u && !/^https?:\/\//i.test(u)) {
      return res.status(400).json({ error: 'El link de agenda debe empezar con https:// (ej: https://cal.com/tu-usuario/tu-evento)' });
    }
    sets.push(`calcom_event_url = $${i++}`); params.push(u || null);
  }
  if (req.body.cal_api_key !== undefined) { // v0.9.22 — guardar encriptada ("" = borrar)
    const k = String(req.body.cal_api_key || '').trim();
    // v0.9.30c: encryptToken lanza si ENCRYPTION_KEY está mal seteada en
    // Railway (debe ser 64 hex SIN comillas). Antes explotaba en 500 genérico
    // y el panel igual mostraba "guardada".
    let encK = null;
    if (k) {
      try {
        encK = encryptToken(k);
      } catch (e) {
        return res.status(500).json({
          error: `No se pudo encriptar la API key: ${e.message}. Revisá ENCRYPTION_KEY en Railway (64 chars hex, sin comillas) y redeploy.`,
        });
      }
    }
    sets.push(`cal_api_key = $${i++}`); params.push(encK);
  }
  if (req.body.bot_name !== undefined) { // v0.9.86 — nombre de la IA por tenant (onboarding)
    // El nombre viaja DENTRO del system prompt → sanitizar fuerte para evitar
    // inyección de instrucciones. Solo letras/números/espacios/._- , máx 30.
    let bn = String(req.body.bot_name || '').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    sets.push(`bot_name = $${i++}`); params.push(bn || null); // null = vuelve a "Aitana"
  }
  if (req.body.bot_tone !== undefined) { // v0.9.86 — tono de la marca (onboarding)
    const TONES = ['cercano', 'profesional', 'vendedor'];
    const bt = String(req.body.bot_tone || '').trim().toLowerCase();
    sets.push(`bot_tone = $${i++}`); params.push(TONES.includes(bt) ? bt : null);
  }
  if (req.body.onboarding_completed !== undefined) { // v0.9.86 — flag del wizard de primer login
    sets.push(`onboarding_completed = $${i++}`); params.push(!!req.body.onboarding_completed);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });
  params.push(tenantId);
  try {
    const r = await db.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}
       RETURNING alert_phone, inventory_bot_enabled, software_bot_enabled, realestate_bot_enabled, COALESCE(to_jsonb(tenants) ->> 'services_bot_enabled', 'false')::boolean AS services_bot_enabled, calcom_event_url, (cal_api_key IS NOT NULL) AS has_cal_key, to_jsonb(tenants) -> 'business_hours' AS business_hours, to_jsonb(tenants) ->> 'bot_name' AS bot_name, to_jsonb(tenants) ->> 'bot_tone' AS bot_tone, COALESCE(to_jsonb(tenants) ->> 'onboarding_completed','true')::boolean AS onboarding_completed, COALESCE(to_jsonb(tenants) ->> 'salud_bot_enabled','false')::boolean AS salud_bot_enabled, COALESCE(to_jsonb(tenants) ->> 'belleza_bot_enabled','false')::boolean AS belleza_bot_enabled, COALESCE(to_jsonb(tenants) ->> 'restaurante_bot_enabled','false')::boolean AS restaurante_bot_enabled, COALESCE(to_jsonb(tenants) ->> 'vehiculos_bot_enabled','false')::boolean AS vehiculos_bot_enabled, COALESCE(to_jsonb(tenants) ->> 'arquitectura_bot_enabled','false')::boolean AS arquitectura_bot_enabled, COALESCE(to_jsonb(tenants) -> 'mode_visibility','{}'::jsonb) AS mode_visibility`,
      params
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Organización no encontrada' });
    let row = r.rows[0];
    // v0.9.93: al COMPLETAR el onboarding, el panel del cliente muestra SOLO el modo que
    // eligió (no confundir con modos que no usa). Usa active_prompt_mode (el modo real),
    // NO los flags de engine (services_bot_enabled es compartido por servicios/salud/belleza).
    // Solo dispara en la finalización; no afecta cambios de modo posteriores ni el override
    // de visibilidad del super-admin.
    if (req.body.onboarding_completed === true) {
      const VIS_KEYS = ['software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos'];
      try {
        const mr = await db.query(`SELECT COALESCE(to_jsonb(tenants) ->> 'active_prompt_mode', NULL) AS m, COALESCE(to_jsonb(tenants) -> 'mode_visibility', '{}'::jsonb) AS vis FROM tenants WHERE id = $1`, [tenantId]);
        const active = mr.rows[0] && mr.rows[0].m;
        const curVis = (mr.rows[0] && mr.rows[0].vis && typeof mr.rows[0].vis === 'object') ? mr.rows[0].vis : {};
        if (active && VIS_KEYS.includes(active)) {
          const vis = {}; for (const k of VIS_KEYS) vis[k] = false; vis[active] = true;
          // v0.9.122: preservar la visibilidad de la Mesa de soporte (no es un modo
          // de venta) — que la elección del super-admin sobreviva al onboarding.
          if (curVis.soporte === false) vis.soporte = false;
          const vr = await db.query(
            `UPDATE tenants SET mode_visibility = $1::jsonb WHERE id = $2
             RETURNING COALESCE(to_jsonb(tenants) -> 'mode_visibility', '{}'::jsonb) AS mode_visibility`,
            [JSON.stringify(vis), tenantId]
          );
          row.mode_visibility = vr.rows[0].mode_visibility;
          console.log(`✅ [org] onboarding completado (tenant ${tenantId}): panel muestra solo "${active}"`);
          // v0.9.459 — y ENCENDER EL MOTOR del modo elegido si quedó apagado.
          // El wizard escribe el flag en applyMode(), pero "Saltar"/"hacer después" salta ese
          // paso y llega acá directo con onboarding_completed=true. El tenant quedaba FANTASMA:
          // panel y prompt del modo correcto, pero motor apagado → sin rail de Propiedades,
          // sin botón 🏠 en el composer y sin catálogo en el prompt de Aitana (webhook.js).
          // Solo actúa si NINGÚN motor está prendido: nunca pisa una elección deliberada.
          try {
            const MODE_ENGINE = {
              software: 'software_bot_enabled', articulos: 'inventory_bot_enabled',
              inmuebles: 'realestate_bot_enabled', servicios: 'services_bot_enabled',
              salud: 'salud_bot_enabled', belleza: 'belleza_bot_enabled',
              restaurante: 'restaurante_bot_enabled', vehiculos: 'vehiculos_bot_enabled',
              arquitectura: 'arquitectura_bot_enabled',
            };
            const engineCol = MODE_ENGINE[active];
            if (engineCol) {
              const allOff = Object.values(MODE_ENGINE)
                .map((c) => `COALESCE((to_jsonb(tenants)->>'${c}')::boolean, false)`).join(' OR ');
              const er = await db.query(
                `UPDATE tenants SET ${engineCol} = TRUE WHERE id = $1 AND NOT (${allOff}) RETURNING id`,
                [tenantId]
              );
              if (er.rowCount) {
                row[engineCol] = true;
                console.log(`🔌 [org] motor "${engineCol}" encendido para el tenant ${tenantId} (wizard salteado, modo "${active}")`);
              }
            }
          } catch (e) {
            console.warn('⚠️  [org] no se pudo encender el motor post-onboarding:', e.message);
          }
        }
      } catch (e) {
        console.warn('⚠️  [org] no se pudo fijar mode_visibility post-onboarding:', e.message);
      }
    }
    res.json({ ok: true, ...row });
  } catch (e) {
    if (/alert_phone/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.19' });
    if (/inventory_bot_enabled/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.21' });
    if (/bot_name|bot_tone|onboarding_completed/.test(e.message)) return res.status(503).json({ error: 'Falta correr la migración v0.9.86 (identidad + onboarding)' });
    res.status(500).json({ error: e.message });
  }
});

// ============================================================
// v0.9.523 — REGLAS DE AGENDA + HORARIOS DE ATENCIÓN POR LÍNEA.
// Espeja el patrón de los prompts por línea: default del tenant (tenants.*) +
// override por línea (tenant_lines.*). Owner/supervisor editan el default y
// cualquier línea; un agente edita SOLO las líneas asignadas (tenant_user_lines).
// line_id vacío = el Default del tenant.
// ============================================================
function _cleanBusinessHours(bh) {
  const clean = { tz: String(bh.tz || 'America/La_Paz').slice(0, 40), days: {}, note: String(bh.note || '').slice(0, 200) };
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  for (const d of DAYS) {
    const ranges = Array.isArray(bh.days && bh.days[d]) ? bh.days[d] : [];
    clean.days[d] = ranges
      .filter(rg => rg && /^\d{1,2}:\d{2}$/.test(rg.open) && /^\d{1,2}:\d{2}$/.test(rg.close))
      .slice(0, 3).map(rg => ({ open: rg.open, close: rg.close }));
  }
  return clean;
}
async function _agendaEditableLines(req, tenantId) {
  const full = req.isSuperAdmin || req.userRole === 'owner' || req.userRole === 'supervisor';
  try {
    if (full) {
      const r = await db.query(
        `SELECT id, to_jsonb(tenant_lines) ->> 'label' AS label, to_jsonb(tenant_lines) ->> 'name' AS name
           FROM tenant_lines WHERE tenant_id = $1 ORDER BY id`, [tenantId]);
      return r.rows;
    }
    const r = await db.query(
      `SELECT tl.id, to_jsonb(tl) ->> 'label' AS label, to_jsonb(tl) ->> 'name' AS name
         FROM tenant_lines tl JOIN tenant_user_lines ul ON ul.line_id = tl.id
        WHERE tl.tenant_id = $1 AND ul.user_id = $2 ORDER BY tl.id`, [tenantId, req.userId]);
    return r.rows;
  } catch (e) { return []; }
}
async function _canEditAgendaScope(req, tenantId, lineId) {
  if (req.isSuperAdmin || req.userRole === 'owner' || req.userRole === 'supervisor') return true;
  if (!lineId) return false; // el Default del tenant solo lo toca owner/supervisor
  try {
    const r = await db.query('SELECT 1 FROM tenant_user_lines WHERE user_id = $1 AND line_id = $2 LIMIT 1', [req.userId, lineId]);
    return r.rows.length > 0;
  } catch (e) { return false; }
}

// GET /api/admin/agenda-rules[?line_id=X] — config EFECTIVA del scope (línea override →
// default del tenant), con flags de override y la lista de líneas que este usuario puede editar.
router.get('/admin/agenda-rules', requireTenantSession, async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const lineId = parseInt(req.query.line_id, 10) || null;
  try {
    if (lineId && !(await _canEditAgendaScope(req, tenantId, lineId))) return res.status(403).json({ error: 'No tenés permiso sobre esa línea' });
    const t = await db.query(`SELECT to_jsonb(tenants) -> 'agenda_config' AS ac, to_jsonb(tenants) -> 'business_hours' AS bh FROM tenants WHERE id = $1`, [tenantId]);
    let ac = (t.rows[0] && t.rows[0].ac) || null;
    let bh = (t.rows[0] && t.rows[0].bh) || null;
    let ovAgenda = false, ovBh = false;
    if (lineId) {
      const l = await db.query(`SELECT to_jsonb(tenant_lines) -> 'agenda_config' AS ac, to_jsonb(tenant_lines) -> 'business_hours' AS bh FROM tenant_lines WHERE id = $1 AND tenant_id = $2`, [lineId, tenantId]);
      const lac = l.rows[0] && l.rows[0].ac, lbh = l.rows[0] && l.rows[0].bh;
      if (lac) { ac = lac; ovAgenda = true; }
      if (lbh) { bh = lbh; ovBh = true; }
    }
    res.json({
      ok: true, line_id: lineId, agenda_config: ac, business_hours: bh,
      is_override: { agenda: ovAgenda, business_hours: ovBh },
      editable_lines: await _agendaEditableLines(req, tenantId),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin/agenda-rules[?line_id=X] — guarda agenda_config y/o business_hours en
// la línea (override) o en el tenant (default). Body: { agenda_config?, business_hours? }.
router.patch('/admin/agenda-rules', requireTenantSession, async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const lineId = parseInt(req.query.line_id, 10) || null;
  if (!(await _canEditAgendaScope(req, tenantId, lineId))) return res.status(403).json({ error: 'Sin permiso para este scope' });
  const sets = []; const params = []; let i = 1;
  if (req.body.agenda_config !== undefined) {
    const ac = req.body.agenda_config;
    if (ac === null || ac === '') { sets.push(`agenda_config = $${i++}`); params.push(null); }
    else if (typeof ac === 'object') { sets.push(`agenda_config = $${i++}`); params.push(JSON.stringify(agenda.sanitize(ac))); }
  }
  if (req.body.business_hours !== undefined) {
    const bh = req.body.business_hours;
    if (bh === null || bh === '') { sets.push(`business_hours = $${i++}`); params.push(null); }
    else if (typeof bh === 'object') { sets.push(`business_hours = $${i++}`); params.push(JSON.stringify(_cleanBusinessHours(bh))); }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nada para actualizar' });
  try {
    if (lineId) {
      params.push(lineId); const idP = i++; params.push(tenantId); const tP = i;
      await db.query(`UPDATE tenant_lines SET ${sets.join(', ')} WHERE id = $${idP} AND tenant_id = $${tP}`, params);
    } else {
      params.push(tenantId);
      await db.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}`, params);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/agenda-rules?line_id=X[&which=agenda|business_hours|all] — quita el
// override de la línea (vuelve a heredar el default del tenant).
router.delete('/admin/agenda-rules', requireTenantSession, async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const lineId = parseInt(req.query.line_id, 10) || null;
  if (!lineId) return res.status(400).json({ error: 'Elegí una línea para quitar su override' });
  if (!(await _canEditAgendaScope(req, tenantId, lineId))) return res.status(403).json({ error: 'Sin permiso' });
  const which = String(req.query.which || 'all');
  const sets = [];
  if (which === 'agenda' || which === 'all') sets.push('agenda_config = NULL');
  if (which === 'business_hours' || which === 'all') sets.push('business_hours = NULL');
  if (!sets.length) return res.status(400).json({ error: 'which inválido' });
  try {
    await db.query(`UPDATE tenant_lines SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, [lineId, tenantId]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /api/admin/org/rotate-invite — regenera el código de invitación.
 * Útil si el código se filtró. Los usuarios ya registrados no se ven afectados.
 */
router.post('/admin/org/rotate-invite', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const code = genInviteCodeApi();
    const r = await db.query(
      'UPDATE tenants SET invite_code = $1 WHERE id = $2 RETURNING invite_code',
      [code, tenantId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Organización no encontrada' });
    res.json({ ok: true, invite_code: r.rows[0].invite_code });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/admin/users — lista los usuarios de la organización.
 * owner y supervisor (el supervisor ve el equipo, no lo administra).
 */
router.get('/admin/users', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    let r;
    try {
      // v0.9.14: line_ids = líneas asignadas (vacío = ve todas)
      // v0.9.29: stage_scope con fallback si la columna no existe todavía
      r = await db.query(
        `SELECT u.id, u.email, u.display_name, u.role, u.active, u.fb_user_id IS NOT NULL AS has_facebook,
                u.created_at, u.last_login_at,
                COALESCE(to_jsonb(u) ->> 'stage_scope', 'todas') AS stage_scope,
                COALESCE(to_jsonb(u) -> 'channel_scope', '[]'::jsonb) AS channel_scope,
                COALESCE(to_jsonb(u) ->> 'c21_agent_name', '') AS c21_agent_name,
                COALESCE((SELECT json_agg(ul.line_id) FROM tenant_user_lines ul WHERE ul.user_id = u.id), '[]'::json) AS line_ids
         FROM tenant_users u WHERE u.tenant_id = $1 AND NOT COALESCE((to_jsonb(u) ->> 'hidden_from_tenant')::boolean, FALSE)
         ORDER BY CASE u.role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, u.created_at ASC`,
        [tenantId]
      );
    } catch (e) {
      if (!/tenant_user_lines/.test(e.message)) throw e;
      // migración v0.9.14 pendiente → sin asignaciones
      r = await db.query(
        `SELECT id, email, display_name, role, active, fb_user_id IS NOT NULL AS has_facebook,
                created_at, last_login_at
         FROM tenant_users WHERE tenant_id = $1 AND NOT COALESCE((to_jsonb(tenant_users) ->> 'hidden_from_tenant')::boolean, FALSE)
         ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'supervisor' THEN 1 ELSE 2 END, created_at ASC`,
        [tenantId]
      );
    }
    res.json({ ok: true, users: r.rows, your_user_id: req.userId || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/admin/users — el owner crea un usuario a mano.
 * Body: { email, password, display_name, role? (default agent) }
 */
router.post('/admin/cal/validate', requireTenantSession, requireRole('owner'), async (req, res) => {
  const apiKey = String(req.body.api_key || '').trim();
  if (!apiKey) return res.status(400).json({ ok: false, error: 'api_key requerido' });
  try {
    const axios = require('axios');
    const r = await axios.get('https://api.cal.com/v2/me', {
      headers: { Authorization: `Bearer ${apiKey}`, 'cal-api-version': '2024-08-13' },
      timeout: 15000,
      validateStatus: () => true,
    });
    if (r.status === 200) {
      const u = (r.data && (r.data.data || r.data)) || {};
      return res.json({ ok: true, valid: true, username: u.username || u.name || null, email: u.email || null });
    }
    if (r.status === 401 || r.status === 403) {
      return res.json({ ok: true, valid: false, error: 'La API key no es válida o no tiene permisos.' });
    }
    return res.json({ ok: true, valid: false, error: `Cal.com respondió ${r.status}.` });
  } catch (e) {
    return res.json({ ok: false, valid: false, error: `No se pudo contactar a Cal.com: ${e.message}` });
  }
});

router.post('/admin/users', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.display_name || '').trim();
  const role = String(req.body.role || 'agent');
  if (!email || !password || !displayName) {
    return res.status(400).json({ error: 'email, password y display_name requeridos' });
  }
  // v0.9.524 — el "usuario" puede ser un email O un nombre de usuario simple (ej. "jsaid").
  // El login ya busca por LOWER(email) exacto, así que un usuario sin @ funciona igual.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^[a-z0-9][a-z0-9._-]{2,59}$/.test(email)) {
    return res.status(400).json({ error: 'Usá un email válido o un usuario (mín. 3 · solo letras, números y . _ -)' });
  }
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (!USER_ROLES.includes(role)) return res.status(400).json({ error: `role debe ser uno de: ${USER_ROLES.join(', ')}` });
  try {
    const dupe = await db.query('SELECT id FROM tenant_users WHERE LOWER(email) = $1', [email]);
    if (dupe.rows.length > 0) return res.status(409).json({ error: 'Ese email ya está registrado' });
    const hash = await bcryptUsers.hash(password, 10);
    const ins = await db.query(
      `INSERT INTO tenant_users (tenant_id, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, display_name, role, active, created_at`,
      [tenantId, email, hash, displayName, role]
    );
    res.status(201).json({ ok: true, user: ins.rows[0] });
  } catch (e) {
    if (String(e.message).includes('idx_tenant_users_email')) {
      return res.status(409).json({ error: 'Ese email ya está registrado' });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * PUT /api/admin/users/:id/lines — v0.9.14: asignar líneas a un usuario.
 * Body: { line_ids: [1,2] }  ·  [] = sin asignación = ve TODAS las líneas.
 * Aplica a agentes (owner/supervisor ven todo siempre, se permite guardar igual).
 */
router.put('/admin/users/:id/lines', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const targetId = parseInt(req.params.id);
  if (!targetId) return res.status(400).json({ error: 'id inválido' });
  const lineIds = Array.isArray(req.body.line_ids) ? req.body.line_ids.map(Number).filter(Boolean) : null;
  if (lineIds === null) return res.status(400).json({ error: 'line_ids (array) requerido' });

  try {
    const u = await db.query('SELECT id FROM tenant_users WHERE id = $1 AND tenant_id = $2', [targetId, tenantId]);
    if (u.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    if (lineIds.length > 0) {
      const owned = await db.query(
        'SELECT id FROM tenant_lines WHERE tenant_id = $1 AND id = ANY($2::int[])',
        [tenantId, lineIds]
      );
      if (owned.rows.length !== lineIds.length) {
        return res.status(400).json({ error: 'Alguna línea no pertenece a tu organización' });
      }
    }

    await db.query('BEGIN');
    try {
      await db.query('DELETE FROM tenant_user_lines WHERE user_id = $1', [targetId]);
      for (const lid of lineIds) {
        await db.query('INSERT INTO tenant_user_lines (user_id, line_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [targetId, lid]);
      }
      await db.query('COMMIT');
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
    res.json({ ok: true, line_ids: lineIds });
  } catch (e) {
    if (/tenant_user_lines/.test(e.message)) {
      return res.status(503).json({ error: 'Falta correr la migración v0.9.14 (tenant_user_lines)' });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * PATCH /api/admin/users/:id — el owner edita un usuario.
 * Body (todos opcionales): { display_name, role, active, password }
 * Guard anti-lockout: no podés cambiar tu PROPIO rol ni desactivarte.
 */
// =====================================================================
// v0.9.327 — RESET DE CONTRASEÑA por LINK (el dueño lo genera; el miembro pone su clave).
// Solo para miembros del equipo (los dueños entran con Facebook). Token: hash + expiry 1h + single-use.
// =====================================================================
router.post('/admin/users/:id/reset-link', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const targetId = parseInt(req.params.id, 10);
  if (!targetId) return res.status(400).json({ error: 'id inválido' });
  try {
    const u = await db.query('SELECT id, display_name, email FROM tenant_users WHERE id = $1 AND tenant_id = $2', [targetId, tenantId]);
    if (!u.rows.length) return res.status(404).json({ error: 'Usuario no encontrado en tu equipo' });
    const token = crypto.randomBytes(24).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.query(`UPDATE password_resets SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`, [targetId]).catch(() => {});
    await db.query(
      `INSERT INTO password_resets (user_id, tenant_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour', $4)`,
      [targetId, tenantId, tokenHash, req.userId || null]);
    res.json({ ok: true, link: `${_publicBase()}/reset?token=${token}`, expires_in_min: 60, member: { display_name: u.rows[0].display_name, email: u.rows[0].email } });
  } catch (e) {
    if (/password_resets/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.327 (reset de clave)' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/public/reset-info', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.json({ ok: true, valid: false });
  try {
    const h = crypto.createHash('sha256').update(token).digest('hex');
    const r = await db.query(
      `SELECT u.display_name FROM password_resets pr JOIN tenant_users u ON u.id = pr.user_id
        WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW() LIMIT 1`, [h]);
    if (!r.rows.length) return res.json({ ok: true, valid: false });
    res.json({ ok: true, valid: true, name: r.rows[0].display_name || '' });
  } catch (e) { res.json({ ok: true, valid: false }); }
});

router.post('/public/reset-password', async (req, res) => {
  const token = String((req.body && req.body.token) || '');
  const password = String((req.body && req.body.password) || '');
  if (!token) return res.status(400).json({ ok: false, error: 'Link inválido.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres.' });
  try {
    const h = crypto.createHash('sha256').update(token).digest('hex');
    const r = await db.query(
      `SELECT id, user_id, tenant_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW() LIMIT 1`, [h]);
    if (!r.rows.length) return res.status(400).json({ ok: false, error: 'El link no es válido o ya expiró. Pedile uno nuevo al dueño.' });
    const pr = r.rows[0];
    const hash = await bcryptUsers.hash(password, 10);
    await db.query('UPDATE tenant_users SET password_hash = $1 WHERE id = $2 AND tenant_id = $3', [hash, pr.user_id, pr.tenant_id]);
    await db.query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [pr.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: 'No se pudo actualizar la contraseña.' }); }
});

// =====================================================================
// v0.9.492 — PASO FINAL DEL WIZARD: credenciales para la app móvil.
// El dueño entra al panel con Facebook y por eso no tiene contraseña; la app
// móvil pide email + contraseña. Este endpoint se las pone AL USUARIO QUE YA
// EXISTE (no crea un segundo owner) y, en la misma pasada, deja el usuario de
// soporte de SG en ese tenant — el mecanismo de v0.9.226 (hidden_from_tenant),
// ahora automático en vez de a mano desde el super-admin.
//
// La contraseña de soporte sale de SUPPORT_USER_PASSWORD; sin esa variable usa
// 'soporte123'. Está como env para poder rotarla desde Railway sin tocar código
// ni redeployar — hoy, sin definirla, se comporta exactamente como pediste.
// =====================================================================
const SUPPORT_EMAIL_LOCAL = 'soporte';
function _supportPassword() { return String(process.env.SUPPORT_USER_PASSWORD || 'soporte123'); }

async function _ensureSupportUser(tenantId, domain) {
  // Best-effort: si algo falla, el onboarding del cliente NO se corta por una
  // cuenta interna nuestra. Devuelve el email creado o null.
  try {
    await db.query('ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS hidden_from_tenant BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
    await db.query('ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS billing_excluded BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
    const hash = await bcryptUsers.hash(_supportPassword(), 10);

    // ¿Ya hay soporte en ESTE tenant? → solo se le refresca la contraseña.
    const mine = await db.query(
      `SELECT id, email FROM tenant_users
        WHERE tenant_id = $1 AND COALESCE((to_jsonb(tenant_users) ->> 'hidden_from_tenant')::boolean, FALSE) = TRUE
        ORDER BY id LIMIT 1`, [tenantId]);
    if (mine.rows.length) {
      await db.query('UPDATE tenant_users SET password_hash = $1, active = TRUE WHERE id = $2', [hash, mine.rows[0].id]);
      return mine.rows[0].email;
    }

    // El email es único a nivel global. Dos tenants con el mismo dominio (típico
    // con gmail.com) chocarían, así que el segundo lleva sufijo con su tenant_id.
    let email = `${SUPPORT_EMAIL_LOCAL}@${domain}`;
    const taken = await db.query('SELECT 1 FROM tenant_users WHERE LOWER(email) = $1', [email]);
    if (taken.rows.length) email = `${SUPPORT_EMAIL_LOCAL}+t${tenantId}@${domain}`;

    const ins = await db.query(
      `INSERT INTO tenant_users (tenant_id, email, password_hash, display_name, role, active, hidden_from_tenant, billing_excluded)
       VALUES ($1, $2, $3, 'Soporte SG', 'owner', TRUE, TRUE, TRUE)
       ON CONFLICT DO NOTHING RETURNING email`, [tenantId, email, hash]);
    return ins.rows.length ? ins.rows[0].email : null;
  } catch (e) {
    console.error(`⚠️  [soporte] no se pudo crear el usuario de soporte del tenant ${tenantId}:`, e.message);
    return null;
  }
}

router.post('/admin/onboarding/mobile-user', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ ok: false, error: 'tenant_id requerido' });
  if (!req.userId) return res.status(400).json({ ok: false, error: 'Sesión sin usuario' });
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: 'Escribí un email válido (ej. pepe@tuempresa.com).' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'La contraseña necesita al menos 8 caracteres.' });
  const domain = email.split('@')[1];
  try {
    const dupe = await db.query('SELECT id FROM tenant_users WHERE LOWER(email) = $1 AND id <> $2', [email, req.userId]);
    if (dupe.rows.length) return res.status(409).json({ ok: false, error: 'Ese email ya está en uso en otra cuenta. Probá con otro.' });

    const hash = await bcryptUsers.hash(password, 10);
    const up = await db.query(
      `UPDATE tenant_users SET email = $1, password_hash = $2 WHERE id = $3 AND tenant_id = $4 RETURNING id, email`,
      [email, hash, req.userId, tenantId]);
    if (!up.rows.length) return res.status(404).json({ ok: false, error: 'No se encontró tu usuario en esta organización.' });

    // v0.9.524 — YA NO se crea el usuario de soporte oculto en el onboarding. Ahora el
    // soporte entra por el super-admin con "Entrar como soporte" (sesión temporal support:true,
    // v0.9.519), sin usuarios internos que ensucien la lista del tenant ni la facturación.
    // Se conserva _ensureSupportUser por si hiciera falta a mano, pero no se llama en el alta.

    res.json({ ok: true, email: up.rows[0].email });
  } catch (e) {
    if (/idx_tenant_users_email/.test(String(e.message))) return res.status(409).json({ ok: false, error: 'Ese email ya está en uso en otra cuenta. Probá con otro.' });
    console.error('❌ [onboarding/mobile-user]', e.message);
    res.status(500).json({ ok: false, error: 'No se pudo guardar. Probá de nuevo.' });
  }
});

router.patch('/admin/users/:id', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const targetId = parseInt(req.params.id);
  if (!targetId) return res.status(400).json({ error: 'id inválido' });

  const { display_name, role, active, password, stage_scope, channel_scope, c21_agent_name } = req.body || {};
  const isSelf = req.userId && req.userId === targetId;
  if (isSelf && (role !== undefined || active !== undefined)) {
    return res.status(400).json({ error: 'No podés cambiar tu propio rol ni desactivarte (anti-lockout)' });
  }
  if (role !== undefined && !USER_ROLES.includes(String(role))) {
    return res.status(400).json({ error: `role debe ser uno de: ${USER_ROLES.join(', ')}` });
  }
  // v0.9.29: alcance por etapa (solo restringe a agentes)
  if (stage_scope !== undefined && !['todas', 'venta', 'postventa'].includes(String(stage_scope))) {
    return res.status(400).json({ error: 'stage_scope debe ser: todas, venta o postventa' });
  }
  // v0.9.285: alcance por canal (array; [] o null = todos). Solo restringe a agentes.
  let _chanScopeArr;
  if (channel_scope !== undefined) {
    if (channel_scope === null) { _chanScopeArr = null; }
    else if (Array.isArray(channel_scope)) {
      const _allowed = ['whatsapp', 'messenger', 'instagram', 'telegram'];
      const _clean = Array.from(new Set(channel_scope.map(x => String(x).toLowerCase()).filter(x => _allowed.includes(x))));
      _chanScopeArr = _clean.length ? _clean : null; // vacío = sin restricción
    } else {
      return res.status(400).json({ error: 'channel_scope debe ser un array de canales' });
    }
  }
  if (password !== undefined && String(password).length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }

  try {
    const cur = await db.query(
      'SELECT id, role FROM tenant_users WHERE id = $1 AND tenant_id = $2',
      [targetId, tenantId]
    );
    if (cur.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const sets = [];
    const params = [];
    let i = 1;
    if (display_name !== undefined) { sets.push(`display_name = $${i++}`); params.push(String(display_name).trim()); }
    if (role !== undefined)         { sets.push(`role = $${i++}`);         params.push(String(role)); }
    if (active !== undefined)       { sets.push(`active = $${i++}`);       params.push(!!active); }
    if (stage_scope !== undefined)  { sets.push(`stage_scope = $${i++}`);  params.push(String(stage_scope)); } // v0.9.29
    if (channel_scope !== undefined) { sets.push(`channel_scope = $${i++}`); params.push(_chanScopeArr); } // v0.9.285
    // v0.9.458 — el dueño puede dejar asignado a qué asesor de C21 corresponde
    // cada usuario, así el agente no tiene que elegirlo la primera vez. Es
    // preferencia de vista: no cambia permisos ni lo que el bot puede ofrecer.
    if (c21_agent_name !== undefined) {
      const _ag = String(c21_agent_name || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      sets.push(`c21_agent_name = $${i++}`); params.push(_ag || null);
    }
    if (password !== undefined)     { sets.push(`password_hash = $${i++}`); params.push(await bcryptUsers.hash(String(password), 10)); }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada para actualizar' });

    params.push(targetId, tenantId);
    const r = await db.query(
      `UPDATE tenant_users SET ${sets.join(', ')}
       WHERE id = $${i++} AND tenant_id = $${i}
       RETURNING id, email, display_name, role, active, created_at, last_login_at`,
      params
    );
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    if (String(e.message).includes('idx_tenant_users_email')) {
      return res.status(409).json({ error: 'Ese email ya está en uso' });
    }
    if (/stage_scope/.test(e.message)) {
      return res.status(503).json({ error: 'Falta correr la migración v0.9.29' });
    }
    if (/channel_scope/.test(e.message)) {
      return res.status(503).json({ error: 'Falta correr la migración v0.9.285 (channel_scope)' });
    }
    if (/c21_agent_name/.test(e.message)) {
      return res.status(503).json({ error: 'Falta la migración de asesor por usuario (v0.9.458, deploy pendiente).' });
    }
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.54 — ASISTENTE IA DEL PANEL (copiloto: Q&A sobre tus datos + reportes)
// =====================================================================

// Arma un "snapshot" compacto y SOLO-LECTURA de los datos del tenant para
// dárselo a Gemini como contexto. Todo agregado (sin PII innecesaria).
async function buildAssistantSnapshot(tenantId) {
  const snap = {};
  const q = (sql, p = [tenantId]) => db.query(sql, p).then(r => r.rows).catch(() => []);
  const one = (sql, p = [tenantId]) => db.query(sql, p).then(r => r.rows[0] || {}).catch(() => ({}));

  snap.conversaciones = await one(`
    SELECT
      COUNT(*) FILTER (WHERE status='open')::int AS abiertas,
      COUNT(*) FILTER (WHERE status='open' AND mode='human')::int AS con_humano,
      COUNT(*) FILTER (WHERE status='open' AND mode='bot')::int AS con_aitana,
      COUNT(*) FILTER (WHERE COALESCE(stage,'venta')='postventa' AND status='open')::int AS postventa
    FROM conversations WHERE tenant_id = $1`);
  snap.leads = await one(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='new')::int AS nuevos,
      COUNT(*) FILTER (WHERE status='won')::int AS ganados,
      COUNT(*) FILTER (WHERE COALESCE(score,0) >= 85)::int AS calientes,
      COUNT(*) FILTER (WHERE COALESCE(score,0) >= 70)::int AS calificados
    FROM leads WHERE tenant_id = $1`);
  snap.leads_calientes_top = await q(`
    SELECT COALESCE(l.name, c.contact_name, c.phone) AS nombre, l.score, l.vertical, c.phone
    FROM leads l JOIN conversations c ON c.id = l.conversation_id
    WHERE l.tenant_id = $1 AND COALESCE(l.score,0) >= 70 AND l.status NOT IN ('won','lost')
    ORDER BY l.score DESC LIMIT 10`);
  snap.mensajes = await one(`
    SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS ultimas_24h,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS ultimos_7d
    FROM messages m WHERE EXISTS (SELECT 1 FROM conversations c WHERE c.id = m.conversation_id AND c.tenant_id = $1)`);
  snap.tareas = await one(`
    SELECT COUNT(*) FILTER (WHERE status IN ('pending','in_progress'))::int AS activas,
           COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_at < NOW())::int AS atrasadas
    FROM tasks WHERE tenant_id = $1`).catch(() => ({}));
  // v0.9.179: AGENDA en el snapshot del copiloto (citas del agendador propio). Bolivia = UTC-4.
  snap.agenda = await one(`
    SELECT
      COUNT(*) FILTER (WHERE status='pending')::int AS por_tomar,
      COUNT(*) FILTER (WHERE status='scheduled' AND starts_at >= NOW())::int AS proximas,
      COUNT(*) FILTER (WHERE status='scheduled' AND (starts_at - INTERVAL '4 hours')::date = (NOW() - INTERVAL '4 hours')::date)::int AS hoy,
      COUNT(*) FILTER (WHERE status='completed')::int AS realizadas
    FROM appointments WHERE tenant_id = $1 AND provider='inhouse'`).catch(() => ({}));
  snap.proximas_citas = await q(`
    SELECT to_char(a.starts_at - INTERVAL '4 hours', 'DD/MM HH24:MI') AS cuando,
           CASE a.status WHEN 'pending' THEN 'por tomar' WHEN 'scheduled' THEN 'asignada' WHEN 'completed' THEN 'realizada' ELSE a.status END AS estado,
           COALESCE(a.attendee_name, a.attendee_phone, 'Cliente') AS cliente, u.display_name AS asesor
    FROM appointments a LEFT JOIN tenant_users u ON u.id = a.user_id
    WHERE a.tenant_id = $1 AND a.provider='inhouse' AND a.status IN ('pending','scheduled') AND a.starts_at >= NOW() - INTERVAL '2 hours'
    ORDER BY a.starts_at ASC LIMIT 12`).catch(() => []);
  snap.campanas = await one(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status='scheduled')::int AS programadas,
      COALESCE(SUM(sent),0)::int AS enviados_total,
      COALESCE(SUM(sent) FILTER (WHERE created_at >= date_trunc('month', NOW())),0)::int AS enviados_mes
    FROM template_campaigns WHERE tenant_id = $1`).catch(() => ({}));
  // v0.9.452 — contar el catálogo del modo ACTIVO (vehiculos/restaurante/arquitectura tienen tabla propia)
  const _snapInvT = await botCatalogTable(tenantId, 'inventory').catch(() => 'inventory_items');
  const _snapSvcT = await botCatalogTable(tenantId, 'service').catch(() => 'services');
  snap.catalogos = await one(`
    SELECT
      (SELECT COUNT(*) FROM ${_snapInvT} WHERE tenant_id=$1 AND active)::int AS productos,
      (SELECT COUNT(*) FROM properties WHERE tenant_id=$1 AND active)::int AS inmuebles,
      (SELECT COUNT(*) FROM ${_snapSvcT} WHERE tenant_id=$1 AND active)::int AS servicios
  `).catch(() => ({}));
  snap.modos = await one(`
    SELECT software_bot_enabled AS software, inventory_bot_enabled AS productos,
           realestate_bot_enabled AS inmuebles,
           COALESCE(to_jsonb(tenants) ->> 'services_bot_enabled','false')::boolean AS servicios
    FROM tenants WHERE id = $1`);
  snap.distribucion_vertical = await q(`
    SELECT COALESCE(vertical,'sin detectar') AS vertical, COUNT(*)::int AS n
    FROM conversations WHERE tenant_id=$1 AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY vertical ORDER BY n DESC LIMIT 8`);
  return snap;
}

// Mapa de secciones para que el asistente sepa "dónde está cada cosa"
const PANEL_MAP = `Mapa del panel SG Ventas (Aitana) — barra lateral izquierda:
- 💬 Inbox: conversaciones en vivo de WhatsApp + Messenger + Instagram; filtros Bot/Yo/Venta/Post-venta/Archivadas; botón 📣 Campaña. Cada mensaje muestra su hora exacta y hay separadores por día (Hoy/Ayer/fecha). Un mensaje saliente con "⚠ no entregado" es uno que falló en WhatsApp (el motivo aparece al pasar el mouse).
- ⭐ Leads: leads calificados por score, notas, etapa, calificación BANT/SPIN.
- 📅 Tareas: vistas Lista/Kanban/Gantt, asignación a usuarios, bandeja personal.
- 📣 Campañas: envíos masivos con plantillas, audiencias (inactivos/score/CSV), programación, opt-out, analítica (entregas/lecturas/respuestas/clics).
- 📤 Follow-ups: seguimiento automático. Aitana retoma sola a los leads calientes que no respondieron, en etapas por tiempo. Tiene su propio interruptor general y un piso de score. (Antes estaba dentro de Configuración; ahora es su propia sección en la barra lateral.)
- 📅 Reservas: agenda/calendario (Cal.com).
- 📊 Reportes (Analytics): embudo de conversión, distribución por rubro, por etapa venta/post-venta, oportunidades perdidas.
- ⚙️ Configuración (sub-pestañas): Modo de venta (incluye el Prompt y el mejorador con IA), Assets, Plantillas, Usuarios, Líneas, Canales (omnicanal: Messenger, Instagram y comentarios→DM), General, Test, Histórico.
- 🤖 Interruptor de IA (solo dueño): pausa o activa TODAS las respuestas automáticas de Aitana del negocio.
- 💳 Consumo y cobros / Mi plan: el plan contratado, el consumo de tokens y mensajes, y los precios.
- 🐞 Reportar un problema: botón en la barra lateral (cualquier usuario) para avisar de un bug o falla del programa al equipo de SG Ventas; el reporte queda en "Mis reportes" con su estado y la respuesta de soporte.`;

// v0.9.99: guía de conceptos para que el copiloto pueda EXPLICAR cómo funciona Aitana.
const AITANA_GUIDE = `CÓMO FUNCIONA AITANA (conceptos — explicá esto cuando el dueño pregunte "cómo funciona / qué es el prompt / cómo mejoro a Aitana / cómo funcionan los assets / qué son los follow-ups / cómo pauso la IA / por qué Aitana no dijo X"):

EL PROMPT PRINCIPAL
- Es el "cerebro" de Aitana: define cómo habla, qué ofrece, su personalidad y cómo lleva la conversación de venta. Es lo que MÁS impacta en cómo responde.
- Se edita en ⚙️ Configuración → Modo de venta → pestaña Prompt (hay un prompt por modo; se edita el del modo activo del negocio).
- Cómo MEJORARLO a mano: escribir ahí, en texto claro y ordenado, el proceso de venta del negocio, los precios/planes, las políticas (adelantos, tiempos de entrega, garantías, formas de pago) y las respuestas a las dudas más frecuentes. Cuanto más claro, específico y completo, mejor y más consistente responde. Conviene ajustarlo mirando conversaciones reales.
- MEJORAR CON IA (✨): debajo del editor del prompt hay una caja "Mejorar con IA". El dueño escribe en sus palabras qué quiere cambiar (ej: "que sea más cálido", "mensajes más cortos", "que insista más en agendar la visita") y la IA reescribe el prompt aplicando eso. El resultado aparece en el editor para revisarlo; recién se aplica al tocar "💾 Guardar este prompt" (o "↩️ Deshacer" para descartarlo). Estas mejoras consumen tokens (cuentan para el plan).
- El nombre y el tono de Aitana también se ajustan en Configuración.

LOS ASSETS (archivos que Aitana ENVÍA)
- Son imágenes, videos, PDFs o enlaces que Aitana le manda al cliente. Se cargan en ⚙️ Configuración → Assets.
- CLAVE: la "Descripción" de cada asset le sirve a Aitana para decidir CUÁNDO enviarlo (y qué es) — NO es el texto que Aitana dice. Si el dueño quiere que Aitana EXPLIQUE algo con palabras (pasos, % de adelanto, tiempos, condiciones), eso va en el PROMPT, no en la descripción del asset. El asset es el refuerzo visual; el prompt es lo que Aitana habla. Este es el malentendido más común: poner instrucciones en la descripción del asset esperando que Aitana las "diga".
- Cada asset tiene un "Modo de venta" (a qué modo le sirve) y opcionalmente un "Caption" (texto que acompaña al archivo al enviarse).
- Aitana decide sola cuándo mandar cada asset según su descripción; no hay disparo por palabra clave.

FOLLOW-UPS (seguimiento automático) — sección 📤 Follow-ups de la barra lateral
- Aitana retoma sola a los leads calientes (de score alto) que se quedaron sin responder. Se configuran ETAPAS por tiempo desde el último mensaje del cliente (ej: 15 min, 1 h, 4 h, 24 h). Dentro de las 24 h el mensaje lo redacta la IA con el contexto de la charla; pasadas las 24 h Meta obliga a usar una PLANTILLA aprobada.
- La secuencia se corta sola si el cliente responde. Respeta horario de "no molestar" y fines de semana, y tiene un interruptor general (master switch) y un piso de score mínimo.

INTERRUPTOR DE IA (master switch — solo el dueño)
- Pausa o activa TODAS las respuestas automáticas de Aitana del negocio. En OFF, los mensajes siguen entrando al inbox pero NO los responde el bot: contesta una persona desde el panel. Sirve para tomar el control manual cuando hace falta.

OMNICANAL (⚙️ Configuración → Canales)
- Además de WhatsApp, Aitana atiende Messenger e Instagram (mensajes directos), y puede responder en privado a comentarios de Facebook/Instagram convirtiéndolos en conversación. Todo cae en el mismo Inbox.

CONSUMO Y COBROS (💳 Consumo y cobros / Mi plan)
- El plan tiene una parte FIJA (por línea, usuarios y canales) y una parte de CONSUMO (mensajes salientes + tokens de IA). Todo lo que usa IA — las respuestas de Aitana, los follow-ups, este copiloto, el mejorador de prompt y los análisis automáticos — consume tokens que cuentan para el plan. El detalle se ve en esa sección.

Al explicar esto: sé concreto y breve, y siempre indicá la sección EXACTA del panel donde se hace.`;

// =====================================================================
// v0.9.494 — CATÁLOGO DE DESTINOS. El copiloto ya explicaba dónde estaba cada
// cosa; el problema es que "andá a Configuración → Modo de venta → Prompt" sigue
// obligando al usuario a encontrarlo. Con esto la respuesta trae un BOTÓN que lo
// deja parado en la pantalla exacta.
//
// Sirve para dos cosas a la vez: se inyecta en el prompt (para que el modelo sepa
// qué existe) y es la LISTA BLANCA con la que se valida el destino que elige. Un
// id inventado por el modelo se descarta: no se navega a nada que no esté acá.
// =====================================================================
const PANEL_DESTINATIONS = [
  // Secciones principales (barra lateral)
  { id: 'inbox',        label: 'Inbox',                  tab: 'inbox',       what: 'ver y responder conversaciones de WhatsApp, Messenger e Instagram; filtrar por línea, canal, etapa y estado' },
  { id: 'leads',        label: 'Leads',                  tab: 'leads',       what: 'leads calificados por score, cambiar su estado del pipeline, exportar CSV, filtrar por línea' },
  { id: 'properties',   label: 'Propiedades',            tab: 'properties',  what: 'catálogo de inmuebles: alta, edición, fotos, formatos/tipologías de un proyecto, destacadas, carpetas, sync 21Online' },
  { id: 'pending',      label: 'Por tomar',              tab: 'pending',     what: 'pool de citas pendientes sin dueño, para que alguien del equipo las tome' },
  { id: 'tasks',        label: 'Tareas',                 tab: 'tasks',       what: 'tareas del equipo en Lista, Kanban o Gantt, y asignarlas a un usuario' },
  { id: 'campaigns',    label: 'Campañas',               tab: 'campaigns',   what: 'envíos masivos con plantillas, audiencias, programación y analítica de entregas y respuestas' },
  { id: 'comments',     label: 'Comentarios',            tab: 'comments',    what: 'comentarios de Facebook e Instagram: responder público o por privado, asignar y resolver' },
  { id: 'followups',    label: 'Follow-ups',             tab: 'followups',   what: 'seguimiento automático: interruptor general, score mínimo, etapas por tiempo, horario de no molestar y plantillas' },
  { id: 'reservations', label: 'Reservas',               tab: 'reservations', what: 'calendario y agenda de citas' },
  { id: 'teamagenda',   label: 'Agenda del equipo',      tab: 'teamagenda',  what: 'ver la agenda de todos los vendedores junta' },
  { id: 'stats',        label: 'Reportes',               tab: 'stats',       what: 'analytics: embudo, leads por estado, actividad por día y hora, inteligencia de mercado, filtro por línea y reporte PDF de gerencia' },
  { id: 'miplan',       label: 'Mi plan',                tab: 'miplan',      what: 'el plan contratado, consumo de mensajes y tokens, y los precios' },
  { id: 'usage',        label: 'Consumo',                tab: 'usage',       what: 'detalle del consumo de IA y mensajes' },
  // Configuración (sub-secciones)
  { id: 'salesmode',    label: 'Config › Modo de venta', tab: 'config', section: 'salesmode',     what: 'elegir el rubro del negocio, editar el PROMPT de Aitana, mejorarlo con IA, nombre y tono del bot' },
  { id: 'assets',       label: 'Config › Multimedia',    tab: 'config', section: 'assets',        what: 'assets que Aitana envía: imágenes, PDFs, videos y links, con su descripción y caption' },
  { id: 'templates',    label: 'Config › Plantillas',    tab: 'config', section: 'templates',     what: 'plantillas de WhatsApp aprobadas por Meta, necesarias para escribir fuera de las 24 horas' },
  { id: 'users',        label: 'Config › Usuarios',      tab: 'config', section: 'users',         what: 'dar de alta al equipo, cambiar contraseñas, roles, asignar líneas y alcance por canal o etapa' },
  { id: 'perms',        label: 'Config › Roles y permisos', tab: 'config', section: 'perms',      what: 'matriz de permisos: qué ve y qué puede hacer cada rol, incluido habilitar o no el Inbox' },
  { id: 'lines',        label: 'Config › Líneas',        tab: 'config', section: 'lines',         what: 'conectar y administrar números de WhatsApp, línea principal, tokens y reconexión' },
  { id: 'channels',     label: 'Config › Canales',       tab: 'config', section: 'channels',      what: 'conectar Instagram y Messenger a través de una Página de Facebook, y Telegram' },
  { id: 'notifications', label: 'Config › Notificaciones', tab: 'config', section: 'notifications', what: 'avisos push y por WhatsApp: leads calientes, clientes VIP, citas y alertas por línea' },
  { id: 'vip',          label: 'Config › Clientes VIP',  tab: 'config', section: 'vip',           what: 'marcar números como VIP para que su chat suba al tope del inbox y avise al equipo' },
  { id: 'kb',           label: 'Config › Conocimiento',  tab: 'config', section: 'kb',            what: 'base de conocimiento: preguntas frecuentes y datos que Aitana usa para responder' },
  { id: 'voicenotes',   label: 'Config › Notas de voz',  tab: 'config', section: 'voicenotes',    what: 'la voz con la que Aitana manda audios' },
  { id: 'reservations_cfg', label: 'Config › Reservas',  tab: 'config', section: 'reservations',  what: 'configurar la agenda: duración de las citas, disponibilidad y conexión con Cal.com' },
  { id: 'realestate',   label: 'Config › Inmuebles',     tab: 'config', section: 'realestate',    what: 'opciones del modo inmobiliario, asesores C21 e importación del catálogo' },
  { id: 'global',       label: 'Config › General',       tab: 'config', section: 'global',        what: 'datos generales del negocio, horarios de atención, marca y ajustes globales' },
  { id: 'test',         label: 'Config › Test',          tab: 'config', section: 'test',          what: 'probar a Aitana en un chat de prueba sin gastar un contacto real' },
  { id: 'history',      label: 'Config › Histórico',     tab: 'config', section: 'history',       what: 'historial de cambios de configuración y quién los hizo' },
];
const PANEL_DEST_BY_ID = Object.fromEntries(PANEL_DESTINATIONS.map(d => [d.id, d]));
const PANEL_DEST_PROMPT = `DESTINOS DEL PANEL (para el botón "Llevame ahí"). Formato: id — nombre — qué se hace ahí:
${PANEL_DESTINATIONS.map(d => `${d.id} — ${d.label} — ${d.what}`).join('\n')}

NAVEGACIÓN: cuando el usuario pregunte CÓMO o DÓNDE se hace o configura algo, explicá los pasos en 2-4 líneas y terminá la respuesta con una última línea sola con el id del destino, exactamente así: [[IR:id]]. Usá SOLO ids de la lista de arriba, uno por respuesta y siempre el más específico (si la pregunta es sobre el prompt de Aitana el destino es salesmode, no config a secas). Si la pregunta no es sobre dónde hacer algo — números, reportes, conceptos — NO agregues la línea.`;

/** POST /api/admin/assistant/ask — copiloto del panel. Body: { question, history? } */
router.post('/admin/assistant/ask', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.body?.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question requerida' });
  if (question.length > 2000) return res.status(400).json({ error: 'pregunta demasiado larga' });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'El asistente no está disponible (falta GEMINI_API_KEY).' });

  try {
    const snapshot = await buildAssistantSnapshot(tenantId);
    const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
    const histTxt = history.map(h => `${h.role === 'user' ? 'USUARIO' : 'ASISTENTE'}: ${String(h.text || '').slice(0, 500)}`).join('\n');

    const systemPrompt = `Sos el copiloto IA del panel de SG Ventas (CRM de WhatsApp con la asistente Aitana). Ayudás al DUEÑO/EQUIPO del negocio (no a sus clientes) a: (1) entender sus números, (2) encontrar dónde está cada función, (3) generar mini-reportes claros sobre lo que pregunten.

REGLAS
- Respondé en español boliviano, claro y directo. Usá los DATOS REALES del snapshot; nunca inventes cifras. Si un dato no está en el snapshot, decí que no lo tenés a mano y sugerí en qué sección del panel verlo.
- Para reportes, usá texto con viñetas o tablas markdown simples. Resumí lo importante primero (1-2 líneas) y después el detalle.
- Para "cómo hago X / dónde está Y", guiate por el MAPA DEL PANEL y dá pasos cortos.
- Si preguntan cómo funciona Aitana, qué es el prompt principal, cómo mejorarla, o cómo funcionan los assets, explicalo con la GUÍA DE CONCEPTOS (CÓMO FUNCIONA AITANA) y señalá la sección exacta del panel.
- Sé honesto sobre límites: no podés enviar mensajes, borrar datos ni cambiar configuración — solo informar y orientar.
- Si detectás una oportunidad (ej: hay leads calientes sin atender, campañas con baja respuesta), mencionala brevemente.

${PANEL_MAP}

${PANEL_DEST_PROMPT}

${AITANA_GUIDE}

DATOS REALES DEL NEGOCIO (snapshot actual):
${JSON.stringify(snapshot, null, 1)}`;

    const userPrompt = `${histTxt ? 'CONVERSACIÓN PREVIA:\n' + histTxt + '\n\n' : ''}PREGUNTA DEL USUARIO:\n${question}`;

    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.4, maxOutputTokens: 1400, thinkingConfig: { thinkingBudget: 0 } },
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

    // v0.9.151 — registrar tokens del copiloto del panel en ai_usage (best-effort).
    // Sin conversation_id/phone: es una llamada del panel, no de una conversación.
    try {
      const um = gr.data?.usageMetadata;
      if (um) {
        const pt = Number(um.promptTokenCount) || 0;
        const ot = Number(um.candidatesTokenCount) || 0;
        await db.query(
          `INSERT INTO ai_usage (tenant_id, model, prompt_tokens, output_tokens, total_tokens)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, _GEM_MODEL, pt, ot, Number(um.totalTokenCount) || (pt + ot)]
        );
      }
    } catch (uerr) { console.warn('[ai_usage] log assistant/ask falló (no bloqueante):', uerr.message); }

    let answer = gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || 'No pude generar una respuesta. Probá reformular la pregunta.';

    // v0.9.494 — extraer el destino y sacarlo del texto (el marcador es interno).
    // Se valida contra la lista blanca: un id inventado se ignora en silencio y la
    // respuesta se entrega igual, sin botón. Nunca se navega a algo que no existe.
    let goto = null;
    const _m = answer.match(/\[\[\s*IR\s*:\s*([a-z0-9_]+)\s*\]\]/i);
    if (_m) {
      answer = answer.replace(_m[0], '').replace(/\n{3,}/g, '\n\n').trim();
      const d = PANEL_DEST_BY_ID[String(_m[1]).toLowerCase()];
      if (d) goto = { id: d.id, label: d.label, tab: d.tab, section: d.section || null };
    }
    res.json({ ok: true, answer, goto, snapshot_used: true });
  } catch (e) {
    console.error('assistant/ask error:', e.response?.data?.error?.message || e.message);
    res.status(500).json({ error: 'No se pudo consultar el asistente', detail: e.response?.data?.error?.message || e.message });
  }
});

// =====================================================================
// v0.9.126 — Feature #2: ANÁLISIS IA DE OPORTUNIDADES PERDIDAS.
// Detecta leads que mostraron interés y se enfriaron sin convertir, y explica
// por qué (motivo accionable) + un mensaje de re-enganche. Reusa el patrón
// Gemini de /admin/assistant/ask. Lo dispara n8n (cron diario) vía el run.
// =====================================================================
const LOA_REASONS = ['precio', 'sin_seguimiento', 'objecion_no_resuelta', 'mal_fit', 'respuesta_lenta', 'competencia', 'timing', 'no_decisor', 'sin_interes_real', 'otro'];

function _parseAnalysisJson(txt) {
  if (!txt) return null;
  const m = String(txt).match(/\{[\s\S]*\}/); // tolera ```json ... ``` y texto extra
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

// Conversaciones que mostraron interés y se enfriaron sin convertir, aún sin analizar.
async function _findLostConversations(tenantId, { minScore = 70, sinceDays = 3, limit = 25 } = {}) {
  const r = await db.query(
    `SELECT c.id, c.phone, c.contact_name, c.current_score, c.vertical, c.last_message_at,
            l.status AS lead_status, l.score AS lead_score, l.name AS lead_name, l.summary AS lead_summary
       FROM conversations c
       LEFT JOIN leads l ON l.conversation_id = c.id
      WHERE c.tenant_id = $1
        AND NOT EXISTS (SELECT 1 FROM lost_opportunity_analysis a WHERE a.conversation_id = c.id)
        -- v0.9.132 (pedido de José): piso de score GLOBAL. Solo analizar leads
        -- "buenos" (score efectivo >= umbral), nunca el 100%. Aplica incluso a
        -- los marcados 'lost' (antes entraban con score 0).
        AND COALESCE(l.score, c.current_score, 0) >= $2
        AND (
          l.status = 'lost'
          OR (
            c.last_message_at IS NOT NULL
            AND c.last_message_at < NOW() - make_interval(days => $3)
            AND COALESCE(l.status, '') NOT IN ('won', 'lost')
          )
        )
      ORDER BY COALESCE(l.score, c.current_score) DESC NULLS LAST, c.last_message_at DESC
      LIMIT $4`,
    [tenantId, minScore, sinceDays, limit]
  );
  return r.rows;
}

// Corre el análisis de UNA conversación con Gemini. Devuelve el registro o null.
// v0.9.151 — recibe tenantId (opcional) para registrar el consumo de tokens en ai_usage.
async function _analyzeLostConversation(conv, apiKey, tenantId = null) {
  const msgs = await db.query(
    `SELECT direction, sender_type,
            COALESCE(NULLIF(body, ''), NULLIF(media_caption, ''), NULLIF(transcription, ''), '[' || type || ']') AS text
       FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 80`,
    [conv.id]
  );
  if (!msgs.rows.length) return null;
  const transcript = msgs.rows.map(m => {
    const who = m.direction === 'incoming' ? 'CLIENTE' : (m.sender_type === 'human' ? 'HUMANO' : 'AITANA');
    return `${who}: ${String(m.text || '').slice(0, 400)}`;
  }).join('\n').slice(0, 9000);
  const daysCold = conv.last_message_at ? Math.floor((Date.now() - new Date(conv.last_message_at).getTime()) / 86400000) : null;

  const systemPrompt = `Sos analista de ventas de SG Ventas. Te paso UNA conversación de WhatsApp entre "Aitana" (la asistente de ventas del negocio) y un cliente potencial que mostró interés pero NO compró y se enfrió. Decí por qué se perdió y si es recuperable.
Devolvé SOLO un JSON válido (sin markdown ni backticks) con EXACTAMENTE estas claves:
{"reason_category":"precio|sin_seguimiento|objecion_no_resuelta|mal_fit|respuesta_lenta|competencia|timing|no_decisor|sin_interes_real|otro","breakpoint":"dónde/cuándo se enfrió (1 línea)","lost_signal":"qué dijo o hizo el lead justo antes de irse","aitana_could":"qué pudo hacer mejor Aitana, concreto y accionable","recoverable":true,"reengage_msg":"si recoverable=true: un mensaje corto, cálido y natural en español boliviano para reactivar a ESTE lead; si no, null","confidence":0}
Reglas: basate SOLO en la conversación, no inventes. reason_category debe ser uno de la lista. confidence 0-100.`;
  const userPrompt = `METADATOS: score=${conv.current_score}; vertical=${conv.vertical || 'n/d'}; estado_lead=${conv.lead_status || 'sin lead'}; dias_sin_responder=${daysCold == null ? 'n/d' : daysCold}; nombre=${conv.lead_name || conv.contact_name || 'n/d'}.

CONVERSACIÓN:
${transcript}`;

  const axios = require('axios');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
  const gr = await axios.post(url, {
    contents: [{ parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.3, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' },
  }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

  // v0.9.151 — registrar tokens del análisis de oportunidades perdidas (best-effort).
  try {
    const um = gr.data?.usageMetadata;
    if (um && tenantId) {
      const pt = Number(um.promptTokenCount) || 0;
      const ot = Number(um.candidatesTokenCount) || 0;
      await db.query(
        `INSERT INTO ai_usage (tenant_id, conversation_id, phone, model, prompt_tokens, output_tokens, total_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, conv.id || null, conv.phone || null, _GEM_MODEL, pt, ot, Number(um.totalTokenCount) || (pt + ot)]
      );
    }
  } catch (uerr) { console.warn('[ai_usage] log lost-opps falló (no bloqueante):', uerr.message); }

  const j = _parseAnalysisJson(gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
  if (!j) return null;
  return {
    reason_category: LOA_REASONS.includes(j.reason_category) ? j.reason_category : 'otro',
    breakpoint: j.breakpoint ? String(j.breakpoint).slice(0, 500) : null,
    lost_signal: j.lost_signal ? String(j.lost_signal).slice(0, 500) : null,
    aitana_could: j.aitana_could ? String(j.aitana_could).slice(0, 700) : null,
    recoverable: !!j.recoverable,
    reengage_msg: j.reengage_msg ? String(j.reengage_msg).slice(0, 700) : null,
    confidence: Math.min(Math.max(parseInt(j.confidence, 10) || 0, 0), 100),
  };
}

// Auth del cron: acepta el MISMO secreto que el follow-up worker (header
// x-crm-secret == N8N_SHARED_SECRET → reusa la credencial BOT_SECRET_SGVENTAS de
// n8n, sin env vars nuevas) o, como fallback, el X-Admin-Token del super-admin.
function requireAdminOrN8n(req, res, next) {
  const secret = process.env.N8N_SHARED_SECRET;
  const provided = req.headers['x-crm-secret'];
  if (secret && provided) {
    try {
      const _c = require('crypto');
      const h = (s) => _c.createHash('sha256').update(String(s)).digest();
      if (_c.timingSafeEqual(h(provided), h(secret))) return next();
    } catch (e) { /* cae al admin token */ }
  }
  return requireAdminToken(req, res, next);
}

// POST /admin/analysis/lost-opps/run — batch (lo llama el cron de n8n). Auth: x-crm-secret (n8n) o X-Admin-Token.
router.post('/admin/analysis/lost-opps/run', requireAdminOrN8n, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Falta GEMINI_API_KEY' });
  const onlyTenant = Number(req.query.tenant_id || req.body?.tenant_id) || null;
  const perTenant = Math.min(Math.max(Number(req.query.limit || req.body?.limit) || 25, 1), 100);
  const sinceDays = Math.min(Math.max(Number(req.query.since_days || req.body?.since_days) || 3, 1), 90);
  const minScore = Math.min(Math.max(Number(req.query.min_score ?? req.body?.min_score ?? 70), 0), 100); // v0.9.132: default 70 (pedido de José — solo leads buenos)
  const MAX_TOTAL = 60; // tope por corrida (costo/tiempo)
  try {
    const tq = onlyTenant
      ? await db.query(`SELECT id, COALESCE(to_jsonb(tenants) ->> 'active_prompt_mode', 'software') AS sale_mode FROM tenants WHERE id = $1`, [onlyTenant])
      : await db.query(`SELECT id, COALESCE(to_jsonb(tenants) ->> 'active_prompt_mode', 'software') AS sale_mode FROM tenants WHERE active = true ORDER BY id`);
    let analyzed = 0, errors = 0; const byTenant = [];
    for (const t of tq.rows) {
      if (analyzed >= MAX_TOTAL) break;
      const lost = await _findLostConversations(t.id, { minScore, sinceDays, limit: Math.min(perTenant, MAX_TOTAL - analyzed) });
      let n = 0;
      for (const conv of lost) {
        if (analyzed >= MAX_TOTAL) break;
        try {
          const rec = await _analyzeLostConversation(conv, apiKey, t.id);
          if (rec) {
            await db.query(
              `INSERT INTO lost_opportunity_analysis (tenant_id, conversation_id, sale_mode, reason_category, breakpoint, lost_signal, aitana_could, recoverable, reengage_msg, confidence, model)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (conversation_id) DO NOTHING`,
              [t.id, conv.id, t.sale_mode, rec.reason_category, rec.breakpoint, rec.lost_signal, rec.aitana_could, rec.recoverable, rec.reengage_msg, rec.confidence, _GEM_MODEL]
            );
            analyzed++; n++;
          }
        } catch (e) { errors++; console.error('[lost-opps] análisis falló conv', conv.id, ':', e.response?.data?.error?.message || e.message); }
      }
      if (n) byTenant.push({ tenant_id: t.id, analyzed: n });
    }
    console.log(`🔎 [lost-opps] corrida: ${analyzed} analizadas, ${errors} errores (${byTenant.length} tenants)`);
    res.json({ ok: true, analyzed, errors, by_tenant: byTenant });
  } catch (e) {
    if (/lost_opportunity_analysis/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.126' });
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/analysis/lost-opps — lista + agregados (panel del tenant).
router.get('/admin/analysis/lost-opps', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    // v0.9.145 — solo leads con score >= 70 (pedido de José: no mostrar el 100%).
    const minScore = Math.min(Math.max(Number(req.query.min_score ?? 70), 0), 100);
    const items = await db.query(
      `SELECT a.conversation_id, a.sale_mode, a.reason_category, a.breakpoint, a.lost_signal, a.aitana_could,
              a.recoverable, a.reengage_msg, a.confidence, a.analyzed_at,
              c.phone, c.contact_name, c.current_score
         FROM lost_opportunity_analysis a JOIN conversations c ON c.id = a.conversation_id
        WHERE a.tenant_id = $1 AND COALESCE(c.current_score, 0) >= $2 AND a.dismissed_at IS NULL
        ORDER BY a.analyzed_at DESC LIMIT 200`, [tenantId, minScore]);
    const byReason = await db.query(
      `SELECT a.reason_category, COUNT(*)::int AS n, SUM(CASE WHEN a.recoverable THEN 1 ELSE 0 END)::int AS recoverables
         FROM lost_opportunity_analysis a JOIN conversations c ON c.id = a.conversation_id
        WHERE a.tenant_id = $1 AND COALESCE(c.current_score, 0) >= $2 AND a.dismissed_at IS NULL GROUP BY a.reason_category ORDER BY n DESC`, [tenantId, minScore]);
    const byMode = await db.query(
      `SELECT COALESCE(a.sale_mode, '?') AS sale_mode, a.reason_category, COUNT(*)::int AS n
         FROM lost_opportunity_analysis a JOIN conversations c ON c.id = a.conversation_id
        WHERE a.tenant_id = $1 AND COALESCE(c.current_score, 0) >= $2 AND a.dismissed_at IS NULL GROUP BY a.sale_mode, a.reason_category ORDER BY n DESC`, [tenantId, minScore]);
    const totals = await db.query(
      `SELECT COUNT(*)::int AS total,
              SUM(CASE WHEN a.recoverable THEN 1 ELSE 0 END)::int AS recoverables,
              COUNT(*) FILTER (WHERE a.analyzed_at > NOW() - INTERVAL '30 days')::int AS last30
         FROM lost_opportunity_analysis a JOIN conversations c ON c.id = a.conversation_id
        WHERE a.tenant_id = $1 AND COALESCE(c.current_score, 0) >= $2 AND a.dismissed_at IS NULL`, [tenantId, minScore]);
    res.json({ ok: true, items: items.rows, by_reason: byReason.rows, by_mode: byMode.rows, totals: totals.rows[0], min_score: minScore });
  } catch (e) {
    if (/lost_opportunity_analysis/.test(e.message)) return res.json({ ok: true, items: [], by_reason: [], by_mode: [], totals: { total: 0 }, need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// v0.9.147 — Descartar un lead perdido: el usuario decide que no vale la pena.
// Marca dismissed_at → sale del reporte y NO se vuelve a analizar (la fila queda,
// y _findLostConversations ya excluye conversaciones con análisis existente).
router.post('/admin/analysis/lost-opps/dismiss', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const convId = Number(req.body && req.body.conversation_id);
  if (!convId) return res.status(400).json({ error: 'conversation_id requerido' });
  try {
    const r = await db.query(
      `UPDATE lost_opportunity_analysis SET dismissed_at = NOW()
        WHERE tenant_id = $1 AND conversation_id = $2 AND dismissed_at IS NULL RETURNING id`,
      [tenantId, convId]);
    res.json({ ok: true, dismissed: r.rowCount });
  } catch (e) {
    if (/dismissed_at/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.147 (dismissed_at)' });
    console.error('❌ [lost-opps/dismiss] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.149 — Sube una imagen a R2 y devuelve su URL pública. Lo usa el autopost de n8n
// para publicar en Instagram (la API de IG exige image_url público, no acepta binario).
// Auth: x-crm-secret (n8n) o admin token. El archivo llega como campo multipart "file".
router.post('/media/upload-public', requireAdminOrN8n, upload.single('file'), metaMediaGuard, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ error: 'falta el archivo (campo multipart "file")' });
    const mime = req.file.mimetype || 'image/jpeg';
    const filename = req.file.originalname || 'autopost.jpg';
    const prefix = (req.body && req.body.prefix) || 'autopost';
    const r = await r2.upload({ buffer: req.file.buffer, mimeType: mime, prefix, filename });
    if (!r || !r.url) return res.status(503).json({ error: 'R2 no está configurado en el servidor' });
    res.json({ ok: true, url: r.url, size: r.size, content_type: r.content_type });
  } catch (e) {
    console.error('❌ [media/upload-public] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.128 — Feature #3: AUTO-MEJORA de prompts por modo (autorun + bitácora).
// Reusa la data de #2 (lost_opportunity_analysis): si un modo pierde leads por
// un motivo dominante, Gemini reescribe el prompt de ese modo para atacarlo, se
// aplica solo, se versiona (bot_prompt_history) y se registra. Reversible.
// =====================================================================
async function _findModesToTune() {
  const r = await db.query(`
    WITH active AS (
      SELECT id AS tenant_id, COALESCE(to_jsonb(tenants) ->> 'active_prompt_mode', 'software') AS sale_mode
        FROM tenants WHERE active = true
    ),
    losses AS (
      SELECT a.tenant_id, a.sale_mode, a.reason_category, COUNT(*)::int AS n
        FROM lost_opportunity_analysis a
        JOIN active ac ON ac.tenant_id = a.tenant_id AND ac.sale_mode = a.sale_mode
       WHERE a.analyzed_at > NOW() - INTERVAL '30 days'
       GROUP BY a.tenant_id, a.sale_mode, a.reason_category
    ),
    agg AS (
      SELECT tenant_id, sale_mode, SUM(n)::int AS total,
             (ARRAY_AGG(reason_category ORDER BY n DESC))[1] AS dominant_reason,
             MAX(n)::int AS dominant_n
        FROM losses GROUP BY tenant_id, sale_mode
    )
    SELECT g.tenant_id, g.sale_mode, g.total, g.dominant_reason, g.dominant_n
      FROM agg g
     WHERE g.total >= 5
       AND g.sale_mode <> 'software'
       AND g.dominant_n::numeric / NULLIF(g.total, 0) >= 0.35
       AND NOT EXISTS (
         SELECT 1 FROM prompt_autotune_log l
          WHERE l.tenant_id = g.tenant_id AND l.sale_mode = g.sale_mode
            AND l.status = 'applied' AND l.applied_at > NOW() - INTERVAL '7 days'
       )
     ORDER BY g.total DESC`);
  return r.rows;
}

// GUARDRAIL: la mejora NO se aplica si rompe el contrato del prompt.
function _validateTunedPrompt(orig, nuevo) {
  if (!nuevo || typeof nuevo !== 'string') return { ok: false, reason: 'vacío' };
  const olen = (orig || '').length || 1;
  if (nuevo.length < olen * 0.6) return { ok: false, reason: 'demasiado corto' };
  if (nuevo.length > olen * 2.0) return { ok: false, reason: 'demasiado largo' };
  if (!/respuesta/i.test(nuevo)) return { ok: false, reason: 'falta la clave "respuesta" del JSON' };
  if (!/(JSON|FORMATO)/i.test(nuevo)) return { ok: false, reason: 'falta la sección de FORMATO/JSON' };
  for (const key of ['service_to_send', 'property_to_send', 'inventory_to_send', 'asset_to_send', 'photo_label', 'send_docs']) {
    if (orig.includes(key) && !nuevo.includes(key)) return { ok: false, reason: `perdió la clave ${key}` };
  }
  for (const ph of ['{{business_name}}', '{{calcom_event_url}}']) {
    if (orig.includes(ph) && !nuevo.includes(ph)) return { ok: false, reason: `perdió el placeholder ${ph}` };
  }
  return { ok: true };
}

// v0.9.151 — tenantId (opcional) para registrar el consumo de tokens en ai_usage.
async function _generateTunedPrompt(currentPrompt, mode, dominantReason, snippets, apiKey, tenantId = null) {
  const ej = (snippets || []).slice(0, 8).map((s, i) =>
    `${i + 1}. se enfrió: ${String(s.breakpoint || '').slice(0, 160)} | señal: ${String(s.lost_signal || '').slice(0, 160)} | Aitana pudo: ${String(s.aitana_could || '').slice(0, 160)}`
  ).join('\n');
  const systemPrompt = `Sos experto en optimización de prompts de ventas por WhatsApp. Te doy el PROMPT ACTUAL de la asistente "Aitana" para un modo de venta y el PATRÓN DE PÉRDIDA dominante (motivo #1 por el que se le escapan los leads, con ejemplos reales). Mejorá el prompt SOLO para atacar ese motivo.
REGLAS DURAS (si no las cumplís el cambio se descarta):
- Conservá TODA la estructura, reglas y tono. Cambiá lo MÍNIMO necesario.
- NO toques la sección FORMATO DE SALIDA / el JSON ni sus claves (respuesta, *_to_send, etc.).
- Conservá los placeholders {{...}} tal cual.
Devolvé SOLO un JSON válido, sin markdown:
{"nuevo_prompt":"<el prompt completo, mejorado>","que_cambio":"1-2 líneas concretas","por_que":"por qué ataca el motivo","resultado_esperado":"qué se espera que mejore"}`;
  const userPrompt = `MODO: ${mode}\nMOTIVO DOMINANTE DE PÉRDIDA: ${dominantReason}\nEJEMPLOS REALES:\n${ej || '(sin ejemplos)'}\n\nPROMPT ACTUAL:\n${currentPrompt}`;
  const axios = require('axios');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
  const gr = await axios.post(url, {
    contents: [{ parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.4, maxOutputTokens: 6000, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' },
  }, { timeout: 60000, headers: { 'Content-Type': 'application/json' } });

  // v0.9.151 — registrar tokens de la auto-mejora de prompts (best-effort).
  try {
    const um = gr.data?.usageMetadata;
    if (um && tenantId) {
      const pt = Number(um.promptTokenCount) || 0;
      const ot = Number(um.candidatesTokenCount) || 0;
      await db.query(
        `INSERT INTO ai_usage (tenant_id, model, prompt_tokens, output_tokens, total_tokens)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, _GEM_MODEL, pt, ot, Number(um.totalTokenCount) || (pt + ot)]
      );
    }
  } catch (uerr) { console.warn('[ai_usage] log prompt-autotune falló (no bloqueante):', uerr.message); }

  return _parseAnalysisJson(gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
}

// POST /admin/analysis/prompt-autotune/run — autorun (n8n). x-crm-secret o X-Admin-Token.
router.post('/admin/analysis/prompt-autotune/run', requireAdminOrN8n, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Falta GEMINI_API_KEY' });
  const promptBuilder = require('./bot-prompt-builder');
  const MAX = Math.min(Math.max(Number(req.query.limit || req.body?.limit) || 20, 1), 50);
  try {
    const targets = (await _findModesToTune()).slice(0, MAX);
    let applied = 0, discarded = 0, skipped = 0; const out = [];
    for (const t of targets) {
      const pr = await db.query(`SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2 AND line_id IS NULL`, [t.tenant_id, t.sale_mode]); // v0.9.258: el autotune opera SOLO sobre el Default del tenant
      const current = pr.rows[0] && pr.rows[0].content;
      if (!current || !current.trim()) { skipped++; continue; }
      const snips = await db.query(
        `SELECT breakpoint, lost_signal, aitana_could FROM lost_opportunity_analysis
          WHERE tenant_id = $1 AND sale_mode = $2 AND reason_category = $3 AND analyzed_at > NOW() - INTERVAL '30 days'
          ORDER BY analyzed_at DESC LIMIT 8`, [t.tenant_id, t.sale_mode, t.dominant_reason]);
      let gen;
      try { gen = await _generateTunedPrompt(current, t.sale_mode, t.dominant_reason, snips.rows, apiKey, t.tenant_id); }
      catch (e) { skipped++; console.error('[autotune] gen falló', t.tenant_id, t.sale_mode, ':', e.response?.data?.error?.message || e.message); continue; }
      if (!gen || !gen.nuevo_prompt) { skipped++; continue; }
      const val = _validateTunedPrompt(current, gen.nuevo_prompt);
      if (!val.ok) {
        await db.query(
          `INSERT INTO prompt_autotune_log (tenant_id, sale_mode, dominant_reason, status, what_changed, why, expected_result, losses_n, model)
           VALUES ($1,$2,$3,'discarded',$4,$5,$6,$7,'${_GEM_MODEL}')`,
          [t.tenant_id, t.sale_mode, t.dominant_reason, `Descartado: ${val.reason}`, gen.por_que || null, gen.resultado_esperado || null, t.total]
        );
        discarded++; out.push({ tenant_id: t.tenant_id, sale_mode: t.sale_mode, status: 'discarded', reason: val.reason }); continue;
      }
      await db.query(`UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3 AND line_id IS NULL`, [gen.nuevo_prompt, t.tenant_id, t.sale_mode]);
      try { await promptBuilder.saveSnapshot(`Auto-mejora ${t.sale_mode}: ${(gen.que_cambio || t.dominant_reason || '').slice(0, 120)}`, t.tenant_id); } catch (e) {}
      try { promptBuilder.invalidateCache(t.tenant_id); } catch (e) {}
      await db.query(
        `INSERT INTO prompt_autotune_log (tenant_id, sale_mode, dominant_reason, status, what_changed, why, expected_result, prompt_before, prompt_after, losses_n, model)
         VALUES ($1,$2,$3,'applied',$4,$5,$6,$7,$8,$9,'${_GEM_MODEL}')`,
        [t.tenant_id, t.sale_mode, t.dominant_reason, gen.que_cambio || null, gen.por_que || null, gen.resultado_esperado || null, current, gen.nuevo_prompt, t.total]
      );
      applied++; out.push({ tenant_id: t.tenant_id, sale_mode: t.sale_mode, status: 'applied', dominant_reason: t.dominant_reason });
    }
    console.log(`🤖 [autotune] aplicadas=${applied} descartadas=${discarded} saltadas=${skipped}`);
    res.json({ ok: true, applied, discarded, skipped, items: out });
  } catch (e) {
    if (/prompt_autotune_log|lost_opportunity_analysis/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.128' });
    res.status(500).json({ error: e.message });
  }
});

// GET /admin/analysis/prompt-autotune — bitácora (panel del tenant).
router.get('/admin/analysis/prompt-autotune', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(
      `SELECT id, sale_mode, dominant_reason, status, what_changed, why, expected_result, losses_n, applied_at, reverted_at
         FROM prompt_autotune_log WHERE tenant_id = $1 ORDER BY applied_at DESC LIMIT 100`, [tenantId]);
    res.json({ ok: true, items: r.rows });
  } catch (e) {
    if (/prompt_autotune_log/.test(e.message)) return res.json({ ok: true, items: [], need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// POST /admin/analysis/prompt-autotune/:id/revert — restaurar el prompt anterior.
router.post('/admin/analysis/prompt-autotune/:id/revert', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  try {
    const row = await db.query(`SELECT sale_mode, prompt_before, status FROM prompt_autotune_log WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
    if (!row.rows[0]) return res.status(404).json({ error: 'no encontrado' });
    const r = row.rows[0];
    if (r.status !== 'applied' || !r.prompt_before) return res.status(400).json({ error: 'no es un cambio aplicado reversible' });
    await db.query(`UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3 AND line_id IS NULL`, [r.prompt_before, tenantId, r.sale_mode]);
    const promptBuilder = require('./bot-prompt-builder');
    try { await promptBuilder.saveSnapshot(`Revertida auto-mejora ${r.sale_mode} (log #${id})`, tenantId); } catch (e) {}
    try { promptBuilder.invalidateCache(tenantId); } catch (e) {}
    await db.query(`UPDATE prompt_autotune_log SET status = 'reverted', reverted_at = NOW() WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// v0.9.113 — MESA DE SOPORTE (BPO): ciclo de vida de ticket.
// La lógica de dominio (estados, presencia, SLA, audit) vive en
// support-tickets.js (probado aparte). Acá van solo las rutas, gateadas
// por requireSupportEnabled ⇒ los tenants de venta no ven nada.
// =====================================================================

// Flag de mesa por tenant (cache corta, igual patrón que los permisos).
const _supportFlagCache = new Map();
async function isSupportEnabled(tenantId) {
  const c = _supportFlagCache.get(tenantId);
  if (c && (Date.now() - c.at) < 30000) return c.on;
  let on = false;
  try { const r = await db.query('SELECT support_enabled FROM tenants WHERE id = $1', [tenantId]); on = !!(r.rows[0] && r.rows[0].support_enabled); } catch (e) {}
  _supportFlagCache.set(tenantId, { at: Date.now(), on });
  return on;
}
function requireSupportEnabled(req, res, next) {
  const tenantId = resolveOrgTenantId(req);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  isSupportEnabled(tenantId)
    .then((on) => {
      if (!on && !req.isSuperAdmin) return res.status(403).json({ error: 'La mesa de soporte no está habilitada para esta organización', code: 'SUPPORT_DISABLED' });
      req.supportTenantId = tenantId;
      next();
    })
    .catch((e) => res.status(500).json({ error: e.message }));
}

/** PUT /api/admin/support/enabled — prende/apaga la Mesa de Soporte del tenant.
 *  Owner (su org) o super-admin (cualquiera con ?tenant_id). Siembra categorías al prender. */
router.put('/admin/support/enabled', requireTenantSession, requireRole('owner'), async (req, res) => {
  try {
    const tenantId = resolveOrgTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
    const enabled = !!(req.body && (req.body.enabled === true || req.body.enabled === 'true'));
    await db.query('UPDATE tenants SET support_enabled = $2 WHERE id = $1', [tenantId, enabled]);
    _supportFlagCache.delete(tenantId);
    if (enabled) {
      const CATS = [['horario', 'Horarios', 'auto', 30, 240, 1], ['ubicacion', 'Ubicación', 'auto', 30, 240, 2], ['estado_pedido', 'Estado de pedido', 'auto', 20, 180, 3], ['facturacion', 'Facturación', 'suggest', 30, 240, 4], ['reembolso', 'Reembolso', 'escalate', 15, 120, 5], ['reclamo', 'Reclamo', 'escalate', 10, 90, 6], ['otro', 'Otro', 'escalate', 30, 240, 99]];
      for (const [key, label, autonomy, s1, s2, ord] of CATS) {
        await db.query(`INSERT INTO support_categories (tenant_id, key, label, autonomy, sla_first_response_min, sla_resolution_min, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, key) DO NOTHING`, [tenantId, key, label, autonomy, s1, s2, ord]);
      }
    }
    res.json({ ok: true, support_enabled: enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Errores del módulo de dominio → HTTP.
function mapTicketError(res, e) {
  const m = String(e.message || '');
  if (m === 'TICKET_NOT_FOUND') return res.status(404).json({ error: 'Ticket no encontrado' });
  if (m.startsWith('BAD_TRANSITION')) return res.status(409).json({ error: 'Transición de estado inválida', code: m });
  return res.status(500).json({ error: m });
}

// Carga un ticket del tenant + chequea visibilidad del agente (línea/etapa).
async function loadTicketScoped(req, tenantId, ticketId) {
  const r = await db.query(
    `SELECT st.*, c.line_id, c.stage, c.phone
       FROM support_tickets st JOIN conversations c ON c.id = st.conversation_id
      WHERE st.id = $1 AND st.tenant_id = $2`,
    [ticketId, tenantId]
  );
  if (!r.rows[0]) return { code: 404 };
  const t = r.rows[0];
  if (!agentCanSeeConversation(await getAgentLineIds(req), t)) return { code: 404 };
  if (!agentCanSeeStage(await getAgentStageScope(req), t)) return { code: 404 };
  if (!agentCanSeeChannel(await getAgentChannelScope(req), t)) return { code: 404 }; // v0.9.285
  return { ticket: t };
}

/** GET /api/admin/tickets — la cola, con filtros y scope de agente. */
router.get('/admin/tickets', requireTenantSession, requireSupportEnabled, async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const { status, mine, unassigned, category, line_id, phone } = req.query;
    const where = ['st.tenant_id = $1'];
    const params = [tenantId];
    const add = (clause, val) => { params.push(val); where.push(clause.replace('$$', `$${params.length}`)); };
    if (status) add('st.status = $$', status);
    if (category) add('st.category = $$', category);
    if (line_id) add('c.line_id = $$', parseInt(line_id));
    if (phone) add('c.phone = $$', phone);
    if (mine === '1' || mine === 'true') add('st.assigned_agent_id = $$', req.userId);
    if (unassigned === '1' || unassigned === 'true') where.push(`st.assigned_agent_id IS NULL AND st.status = 'open'`);
    const agentLines = await getAgentLineIds(req);
    if (agentLines) { params.push(agentLines); where.push(`(c.line_id = ANY($${params.length}) OR c.line_id IS NULL)`); }
    const stageScope = await getAgentStageScope(req);
    if (stageScope) { params.push(stageScope); where.push(`COALESCE(c.stage,'venta') = $${params.length}`); }
    const chanScope = await getAgentChannelScope(req);
    if (chanScope) { params.push(chanScope); where.push(`COALESCE(c.channel,'whatsapp') = ANY($${params.length}::text[])`); }
    const q = await db.query(
      `SELECT st.*, c.phone, c.contact_name, c.line_id, c.stage, u.display_name AS agent_name
         FROM support_tickets st
         JOIN conversations c ON c.id = st.conversation_id
         LEFT JOIN tenant_users u ON u.id = st.assigned_agent_id
        WHERE ${where.join(' AND ')}
        ORDER BY (st.status = 'open') DESC, st.sla_breached DESC, st.created_at DESC
        LIMIT 200`,
      params
    );
    res.json({ ok: true, tickets: q.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/tickets/sla-scan — worker n8n (header x-crm-secret). DEFINIDA ANTES de /:id. */
router.get('/admin/tickets/sla-scan', requireN8nSecret, async (req, res) => {
  try {
    let tenantIds = [];
    if (req.query.tenant_id) tenantIds = [parseInt(req.query.tenant_id)];
    else { const r = await db.query('SELECT id FROM tenants WHERE support_enabled = TRUE'); tenantIds = r.rows.map((x) => x.id); }
    const breached = [];
    for (const tid of tenantIds) {
      const ids = await supportTickets.scanSlaBreaches({ tenantId: tid });
      for (const id of ids) breached.push({ tenant_id: tid, ticket_id: id });
    }
    res.json({ ok: true, breached, count: breached.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/tickets/auto-close — worker n8n: cierra resueltos > N días. */
router.get('/admin/tickets/auto-close', requireN8nSecret, async (req, res) => {
  try {
    const days = parseInt(req.query.days || '3', 10);
    let tenantIds = [];
    if (req.query.tenant_id) tenantIds = [parseInt(req.query.tenant_id)];
    else { const r = await db.query('SELECT id FROM tenants WHERE support_enabled = TRUE'); tenantIds = r.rows.map((x) => x.id); }
    const closed = [];
    for (const tid of tenantIds) {
      const ids = await supportTickets.autoCloseResolved({ tenantId: tid, days });
      for (const id of ids) closed.push({ tenant_id: tid, ticket_id: id });
    }
    res.json({ ok: true, closed, count: closed.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/stats/support — métricas de la mesa (FRT, AHT, SLA, CSAT, por estado/categoría/agente). */
router.get('/admin/stats/support', requireTenantSession, requireSupportEnabled, async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const days = Math.min(parseInt(req.query.days || '30', 10), 365);
    const ivl = 'NOW() - make_interval(days => $2::int)';
    const summary = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS abiertos,
         COUNT(*) FILTER (WHERE status = 'resolved')::int AS resueltos,
         COUNT(*) FILTER (WHERE status = 'closed')::int AS cerrados,
         COUNT(*) FILTER (WHERE handled_by = 'bot' AND status IN ('resolved','closed'))::int AS auto_resueltos_bot,
         COUNT(*) FILTER (WHERE sla_breached)::int AS sla_vencidos,
         COUNT(*) FILTER (WHERE status IN ('resolved','closed') AND NOT sla_breached)::int AS cerrados_en_sla,
         ROUND(AVG(EXTRACT(EPOCH FROM (first_response_at - created_at))/60) FILTER (WHERE first_response_at IS NOT NULL))::int AS frt_prom_min,
         ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))/60) FILTER (WHERE resolved_at IS NOT NULL))::int AS aht_prom_min,
         ROUND(AVG(csat) FILTER (WHERE csat IS NOT NULL), 2) AS csat_prom,
         COUNT(*) FILTER (WHERE csat IS NOT NULL)::int AS csat_n
       FROM support_tickets WHERE tenant_id = $1 AND created_at > ${ivl}`,
      [tenantId, days]
    );
    const byStatus = await db.query(
      `SELECT status, COUNT(*)::int AS n FROM support_tickets
        WHERE tenant_id = $1 AND created_at > ${ivl} GROUP BY status ORDER BY n DESC`, [tenantId, days]);
    const byCategory = await db.query(
      `SELECT COALESCE(category,'(sin categoría)') AS category, COUNT(*)::int AS n,
              COUNT(*) FILTER (WHERE sla_breached)::int AS sla_vencidos
         FROM support_tickets WHERE tenant_id = $1 AND created_at > ${ivl}
        GROUP BY category ORDER BY n DESC`, [tenantId, days]);
    const byAgent = await db.query(
      `SELECT u.display_name AS agente, COUNT(*)::int AS tickets,
              COUNT(*) FILTER (WHERE st.status IN ('resolved','closed'))::int AS cerrados,
              ROUND(AVG(st.csat) FILTER (WHERE st.csat IS NOT NULL),2) AS csat
         FROM support_tickets st JOIN tenant_users u ON u.id = st.assigned_agent_id
        WHERE st.tenant_id = $1 AND st.created_at > ${ivl}
        GROUP BY u.display_name ORDER BY tickets DESC`, [tenantId, days]);
    const s = summary.rows[0];
    const cerradosTot = s.resueltos + s.cerrados;
    const sla_dentro_pct = cerradosTot ? Math.round(100 * s.cerrados_en_sla / cerradosTot) : null;
    res.json({ ok: true, days, summary: s, sla_dentro_pct, by_status: byStatus.rows, by_category: byCategory.rows, by_agent: byAgent.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** GET /api/admin/stats/support-live — estado EN VIVO (agentes + cola actual). Para pollear. */
router.get('/admin/stats/support-live', requireTenantSession, requireSupportEnabled, async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const agents = await db.query(
      `SELECT u.id, u.display_name AS name,
              COALESCE(ap.status,'offline') AS status,
              COALESCE(ap.active_chats,0)::int AS active_chats,
              COALESCE(ap.max_concurrent,4)::int AS max_concurrent,
              ap.last_seen_at
         FROM tenant_users u
         LEFT JOIN agent_presence ap ON ap.tenant_user_id = u.id
        WHERE u.tenant_id = $1 AND u.active = TRUE AND u.role IN ('owner','supervisor','agent')
        ORDER BY (COALESCE(ap.status,'offline') = 'online') DESC, active_chats DESC, u.display_name ASC`,
      [tenantId]
    );
    const q = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status NOT IN ('resolved','closed'))::int AS abiertos,
         COUNT(*) FILTER (WHERE assigned_agent_id IS NULL AND status = 'open')::int AS sin_asignar,
         COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
         COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
         COUNT(*) FILTER (WHERE status = 'escalated')::int AS escalated,
         COUNT(*) FILTER (WHERE sla_breached AND status NOT IN ('resolved','closed'))::int AS sla_vencidos
       FROM support_tickets WHERE tenant_id = $1`,
      [tenantId]
    );
    const online = agents.rows.filter((a) => a.status === 'online').length;
    res.json({ ok: true, online, agents: agents.rows, queue: q.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/admin/tickets — alta manual sobre una conversación. */
router.post('/admin/tickets', requireTenantSession, requireSupportEnabled, requirePerm('support_handle'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const { conversation_id, phone, category = null, priority = 'normal' } = req.body || {};
    let convId = conversation_id ? parseInt(conversation_id) : null;
    if (!convId && phone) {
      const c = await db.query('SELECT id FROM conversations WHERE phone = $1 AND tenant_id = $2 ORDER BY last_message_at DESC NULLS LAST LIMIT 1', [phone, tenantId]);
      if (!c.rows[0]) return res.status(404).json({ error: 'Conversación no encontrada' });
      convId = c.rows[0].id;
    }
    if (!convId) return res.status(400).json({ error: 'conversation_id o phone requerido' });
    const out = await supportTickets.createTicketIfNone({
      tenantId, conversationId: convId, category, priority,
      handledBy: 'agent', actorKind: 'agent', actorUserId: req.userId || null,
    });
    res.json({ ok: true, ticket: out.ticket, created: out.created });
  } catch (e) { mapTicketError(res, e); }
});

/** GET /api/admin/tickets/:id — detalle + timeline. :id solo dígitos (no choca con sla-scan). */
router.get('/admin/tickets/:id(\\d+)', requireTenantSession, requireSupportEnabled, async (req, res) => {
  try {
    const r = await loadTicketScoped(req, req.supportTenantId, parseInt(req.params.id));
    if (r.code) return res.status(r.code).json({ error: 'Ticket no encontrado' });
    const ev = await db.query(
      `SELECT te.*, u.display_name AS actor_name
         FROM ticket_events te LEFT JOIN tenant_users u ON u.id = te.actor_user_id
        WHERE te.ticket_id = $1 ORDER BY te.id ASC`,
      [r.ticket.id]
    );
    res.json({ ok: true, ticket: r.ticket, events: ev.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST /api/admin/tickets/:id/claim — tomar el ticket (lo asigna a mí) + silenciar al bot. */
router.post('/admin/tickets/:id/claim', requireTenantSession, requireSupportEnabled, requirePerm('support_handle'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const scoped = await loadTicketScoped(req, tenantId, parseInt(req.params.id));
    if (scoped.code) return res.status(scoped.code).json({ error: 'Ticket no encontrado' });
    const ticket = await supportTickets.claimTicket({ ticketId: scoped.ticket.id, tenantId, userId: req.userId });
    await db.query(`UPDATE conversations SET mode = 'human' WHERE id = $1`, [scoped.ticket.conversation_id]);
    res.json({ ok: true, ticket });
  } catch (e) { mapTicketError(res, e); }
});

/** POST /api/admin/tickets/:id/assign — asignar/transferir (owner/supervisor). */
router.post('/admin/tickets/:id/assign', requireTenantSession, requireSupportEnabled, requirePerm('support_assign'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const toUserId = parseInt((req.body || {}).to_user_id);
    if (!toUserId) return res.status(400).json({ error: 'to_user_id requerido' });
    const u = await db.query('SELECT id FROM tenant_users WHERE id = $1 AND tenant_id = $2 AND active = TRUE', [toUserId, tenantId]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Agente no encontrado en la organización' });
    const ticket = await supportTickets.assignTicket({ ticketId: parseInt(req.params.id), tenantId, toUserId, byUserId: req.userId, actorKind: 'supervisor' });
    await db.query(`UPDATE conversations SET mode = 'human' WHERE id = $1`, [ticket.conversation_id]);
    res.json({ ok: true, ticket });
  } catch (e) { mapTicketError(res, e); }
});

/** POST /api/admin/tickets/:id/route — auto-asigna al mejor agente online (por carga). */
router.post('/admin/tickets/:id/route', requireTenantSession, requireSupportEnabled, requirePerm('support_assign'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const scoped = await loadTicketScoped(req, tenantId, parseInt(req.params.id));
    if (scoped.code) return res.status(scoped.code).json({ error: 'Ticket no encontrado' });
    const agentId = await supportTickets.autoAssign({ tenantId, ticketId: scoped.ticket.id, byUserId: req.userId });
    if (!agentId) return res.status(409).json({ error: 'No hay agentes online con capacidad', code: 'NO_AGENT_AVAILABLE' });
    res.json({ ok: true, assigned_agent_id: agentId });
  } catch (e) { mapTicketError(res, e); }
});

/** PATCH /api/admin/tickets/:id/status — transición (in_progress/pending/escalated/resolved/closed). */
router.patch('/admin/tickets/:id/status', requireTenantSession, requireSupportEnabled, requirePerm('support_handle'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const to = (req.body || {}).to;
    if (!['in_progress', 'pending', 'escalated', 'resolved', 'closed'].includes(to)) return res.status(400).json({ error: 'estado destino inválido' });
    const scoped = await loadTicketScoped(req, tenantId, parseInt(req.params.id));
    if (scoped.code) return res.status(scoped.code).json({ error: 'Ticket no encontrado' });
    const ticket = await supportTickets.transitionStatus({ ticketId: scoped.ticket.id, tenantId, toStatus: to, actorUserId: req.userId, actorKind: req.userRole === 'agent' ? 'agent' : 'supervisor' });
    res.json({ ok: true, ticket });
  } catch (e) { mapTicketError(res, e); }
});

/** POST /api/admin/tickets/:id/reopen — reabrir (resolved/closed → in_progress). */
router.post('/admin/tickets/:id/reopen', requireTenantSession, requireSupportEnabled, requirePerm('support_handle'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const scoped = await loadTicketScoped(req, tenantId, parseInt(req.params.id));
    if (scoped.code) return res.status(scoped.code).json({ error: 'Ticket no encontrado' });
    const ticket = await supportTickets.transitionStatus({ ticketId: scoped.ticket.id, tenantId, toStatus: 'in_progress', actorUserId: req.userId, actorKind: req.userRole === 'agent' ? 'agent' : 'supervisor' });
    res.json({ ok: true, ticket });
  } catch (e) { mapTicketError(res, e); }
});

/** POST /api/admin/tickets/:id/note — nota interna (con autor + audit en ticket_events). */
router.post('/admin/tickets/:id/note', requireTenantSession, requireSupportEnabled, requirePerm('support_handle'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    const body = (req.body || {}).body;
    if (!body || !body.trim()) return res.status(400).json({ error: 'body requerido' });
    const scoped = await loadTicketScoped(req, tenantId, parseInt(req.params.id));
    if (scoped.code) return res.status(scoped.code).json({ error: 'Ticket no encontrado' });
    await db.query(
      `INSERT INTO conversation_notes (conversation_id, body, author) VALUES ($1, $2, $3)`,
      [scoped.ticket.conversation_id, body.trim(), req.userName || (req.userId ? `user:${req.userId}` : null)]
    );
    await supportTickets.logEvent(db, { ticketId: scoped.ticket.id, tenantId, actorUserId: req.userId, actorKind: 'agent', eventType: 'note', meta: { len: body.trim().length } });
    res.json({ ok: true });
  } catch (e) { mapTicketError(res, e); }
});

/** PUT /api/admin/me/presence — el agente cambia su presencia (online/away/offline). */
router.put('/admin/me/presence', requireTenantSession, requireSupportEnabled, requirePerm('support_handle'), async (req, res) => {
  try {
    const tenantId = req.supportTenantId;
    if (!req.userId) return res.status(400).json({ error: 'sesión sin usuario' });
    const status = (req.body || {}).status;
    if (!['online', 'away', 'offline'].includes(status)) return res.status(400).json({ error: 'status inválido (online|away|offline)' });
    await db.query(
      `INSERT INTO agent_presence (tenant_user_id, tenant_id, status, last_seen_at)
         VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_user_id) DO UPDATE SET status = EXCLUDED.status, last_seen_at = NOW()`,
      [req.userId, tenantId, status]
    );
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =====================================================================
// v0.9.132 — OMNICANAL Fase 2 (#1): conectar Instagram / Messenger.
// El owner conecta una Página de Facebook (con su IG vinculado opcional).
// Guardamos el page access token cifrado en tenant_channels y suscribimos la
// página al webhook. La ingesta (webhook.js) y la respuesta por canal
// (/whatsapp/send) ya estaban listas desde Fase 1/1b.
// =====================================================================

const CHANNELS_SELECT = `SELECT id, channel, page_id, ig_id, page_name, active, connected_at
   FROM tenant_channels WHERE tenant_id = $1 ORDER BY page_name NULLS LAST, channel`;

function _metaPublicConfig() {
  // v0.9.133: el scope del FB.login es configurable por env. Por defecto pide
  // SOLO los permisos de Messenger/Páginas (que tienen acceso de prueba en dev).
  // Los de Instagram (instagram_basic, instagram_manage_messages) requieren
  // Acceso Avanzado vía App Review; hasta que Meta los apruebe, pedirlos rompe
  // el login del admin ("Invalid Scopes"). Cuando se aprueben, setear
  // META_CONNECT_SCOPE con la lista completa (incluyendo los de IG) — sin deploy.
  // v0.9.569: + pages_read_engagement y pages_manage_engagement — SIN estos, Meta
  // rechaza publicar la respuesta pública sobre el comentario (#200) aunque el DM
  // privado sí salga. Si la app usa Facebook Login for Business (config_id), los
  // permisos se agregan ADEMÁS en la configuración del login, no solo acá.
  const DEFAULT_SCOPE = 'pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,pages_manage_engagement,business_management';
  return {
    app_id: process.env.META_APP_ID || null,
    graph_version: process.env.META_GRAPH_VERSION || 'v25.0',
    messaging_config_id: process.env.META_MESSAGING_CONFIG_ID || null, // opcional (FB Login for Business)
    connect_scope: process.env.META_CONNECT_SCOPE || DEFAULT_SCOPE,
  };
}

// Config pública para inicializar el SDK de Facebook en el panel (sin secretos).
router.get('/channels/meta-config', requireTenantSession, (req, res) => {
  res.json(_metaPublicConfig());
});

// Lista los canales conectados del tenant (sin exponer tokens).
router.get('/channels', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    let rows = [];
    try {
      const r = await db.query(CHANNELS_SELECT, [tenantId]);
      rows = r.rows;
    } catch (e) {
      if (!/tenant_channels/.test(e.message)) throw e; // tabla no migrada todavía → lista vacía
    }
    res.json({ ok: true, channels: rows, meta_config: _metaPublicConfig() });
  } catch (e) {
    console.error('❌ [channels] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.142/283 — Inbox de comentarios (FB feed / IG comments) del tenant, con filtros y estado.
router.get('/channels/comments', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const status = String(req.query.status || 'open');
  const channel = String(req.query.channel || '').trim();
  const q = String(req.query.q || '').trim();
  try {
    let rows = [], counts = { open: 0, resolved: 0, ignored: 0 };
    try {
      const where = ['c.tenant_id = $1']; const params = [tenantId];
      if (status === 'open') where.push(`c.status IN ('new','dm_sent','dm_failed','replied')`);
      else if (status === 'resolved') where.push(`c.status = 'resolved'`);
      else if (status === 'ignored') where.push(`c.status = 'ignored'`);
      if (channel === 'instagram' || channel === 'facebook') { params.push(channel); where.push(`c.channel = $${params.length}`); }
      if (q) { params.push('%' + q + '%'); where.push(`(c.text ILIKE $${params.length} OR c.from_name ILIKE $${params.length})`); }
      const r = await db.query(
        `SELECT c.id, c.channel, c.page_id, c.comment_id, c.parent_id, c.post_id, c.from_id, c.from_name,
                c.text, c.status, c.replied_at, c.reply_text, c.is_hidden, c.assigned_to, c.created_at,
                u.display_name AS assignee_name
           FROM channel_comments c LEFT JOIN tenant_users u ON u.id = c.assigned_to
          WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT 200`, params);
      rows = r.rows;
      const cr = await db.query(
        `SELECT COUNT(*) FILTER (WHERE status IN ('new','dm_sent','dm_failed','replied')) AS open,
                COUNT(*) FILTER (WHERE status = 'resolved') AS resolved,
                COUNT(*) FILTER (WHERE status = 'ignored') AS ignored
           FROM channel_comments WHERE tenant_id = $1`, [tenantId]);
      if (cr.rows[0]) counts = { open: Number(cr.rows[0].open), resolved: Number(cr.rows[0].resolved), ignored: Number(cr.rows[0].ignored) };
    } catch (e) { if (!/channel_comments|tenant_users/.test(e.message)) throw e; }
    res.json({ ok: true, comments: rows, counts });
  } catch (e) {
    console.error('❌ [channels/comments] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.286 — traduce el error de permisos de Meta (#200 / App Review) a algo claro para el tenant.
function _commentReplyErr(raw, mode) {
  const t = String(raw || '');
  if (/#200|App Review|not available|pages_manage_engagement|pages_read_user_content|permiss/i.test(t)) {
    return (mode === 'public')
      ? 'Meta todavía no aprobó los permisos para responder comentarios de Facebook EN PÚBLICO (pages_manage_engagement + pages_read_user_content, vía App Review). Mientras tanto usá "DM privado". [Meta: ' + t + ']'
      : 'Meta rechazó el envío por permisos pendientes de App Review. [Meta: ' + t + ']';
  }
  return t || 'No se pudo responder';
}
/**
 * GET  /api/admin/alerts/email        — v0.9.572: estado del canal de correo
 * POST /api/admin/alerts/email/test   — manda un correo de prueba AHORA (ignora el cooldown)
 * Sirve para confirmar que las alertas críticas van a llegar ANTES de necesitarlas.
 */
router.get('/admin/alerts/email', requireTenantSession, requireRole('owner'), (req, res) => {
  res.json({ ok: true, ...require('./mailer').status() });
});
router.post('/admin/alerts/email/test', requireTenantSession, requireRole('owner'), async (req, res) => {
  const mailer = require('./mailer');
  if (!mailer.isConfigured()) {
    return res.status(409).json({ error: 'Faltan RESEND_API_KEY, MAIL_FROM o ALERT_EMAIL_TO en el servidor.' });
  }
  const r = await mailer.alert('test', {
    title: 'Prueba de alertas por correo',
    detail: 'Si estás leyendo esto, el canal de alertas por email funciona.\n\n'
      + 'Por acá van a llegar: Aitana muda (n8n caído), su recuperación, línea de WhatsApp caída '
      + 'y cada cliente que quede sin responder por una caída de la IA.',
    severity: 'ok', force: true,
  });
  if (r && r.error) return res.status(502).json({ error: r.error });
  res.json({ ok: true, sent_to: mailer.status().to });
});

/**
 * GET  /api/admin/system/health — v0.9.578: ¿la autodefensa está realmente armada?
 * POST /api/admin/system/drill  — simulacro completo (ver n8n-watchdog.drill)
 *
 * Nació de una pregunta razonable: "¿cómo pruebo que esto funciona sin esperar a que
 * se caiga?". El health es de solo lectura; el drill manda DOS correos de prueba y
 * escribe una fila descartable en la cola, pero no despacha nada a n8n ni reinicia nada.
 *
 * v0.9.578b — SOLO SUPER-ADMIN (X-Admin-Token). n8n es infraestructura NUESTRA, compartida
 * por todos los tenants: el dueño de una inmobiliaria no tiene por qué ver el estado de la
 * cola global, ni el nombre del servicio en Railway, ni disparar correos a nuestra casilla.
 */
router.get('/admin/system/health', requireAdminToken, async (req, res) => {
  const wd = require('./n8n-watchdog');
  const [probe, railway, queue] = await Promise.all([
    wd.ENABLED ? wd.probe() : Promise.resolve(null),
    wd.checkRailway(),
    wd.pendingStats(),
  ]);
  res.json({
    ok: true,
    watchdog: wd.status(),
    probe,
    railway,
    queue,
    mailer: require('./mailer').status(),
  });
});

router.post('/admin/system/drill', requireAdminToken, async (req, res) => {
  const wd = require('./n8n-watchdog');
  try {
    // tenant_id solo se usa para dirigir el push de la escalada; def 1 (SG Bolivia).
    const _t = parseInt((req.body && req.body.tenant_id) || 1, 10);
    const out = await wd.drill({
      tenantId: Number.isFinite(_t) && _t > 0 ? _t : 1,
      escalate: req.body && (req.body.escalate === true || req.body.escalate === '1'),
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/channels/permissions — v0.9.569
 * Diagnóstico honesto de la conexión con Meta: pregunta a Graph qué permisos tiene
 * REALMENTE el token de la página (debug_token con el app token) y marca los que
 * faltan para cada función. Nació porque la respuesta pública fallaba en silencio
 * por falta de pages_manage_engagement y en el panel todo se veía "activado".
 */
router.get('/channels/permissions', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const NEEDED = [
    { scope: 'pages_messaging', para: 'Responder por Messenger y mandar el mensaje privado al que comenta' },
    { scope: 'pages_read_engagement', para: 'Leer el post y los comentarios de tu página' },
    { scope: 'pages_manage_engagement', para: 'Publicar la respuesta VISIBLE sobre el comentario (Facebook)' },
    { scope: 'instagram_basic', para: 'Leer la cuenta de Instagram vinculada' },
    { scope: 'instagram_manage_messages', para: 'Responder mensajes de Instagram' },
    { scope: 'instagram_manage_comments', para: 'Publicar la respuesta visible sobre el comentario (Instagram)' },
  ];
  try {
    const cc = (await _getChannelCtx(tenantId, 'messenger')) || (await _getChannelCtx(tenantId, 'instagram'));
    if (!cc) return res.status(409).json({ error: 'No hay ninguna página de Facebook/Instagram conectada.' });
    const appId = process.env.META_APP_ID, appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) return res.status(500).json({ error: 'Faltan META_APP_ID / META_APP_SECRET en el servidor.' });
    const axios = require('axios');
    const dbg = await axios.get('https://graph.facebook.com/v21.0/debug_token', {
      params: { input_token: cc.token, access_token: `${appId}|${appSecret}` }, timeout: 12000,
    });
    const granted = (dbg.data?.data?.scopes || []).map(String);
    const checks = NEEDED.map(n => ({ ...n, ok: granted.includes(n.scope) }));
    const faltan = checks.filter(c => !c.ok).map(c => c.scope);
    res.json({
      ok: true, page_id: cc.pageId, granted, checks, faltan,
      puede_responder_publico_fb: granted.includes('pages_manage_engagement'),
      puede_responder_publico_ig: granted.includes('instagram_manage_comments'),
      como_arreglar: faltan.length
        ? 'Agregá los permisos que faltan en la configuración de Facebook Login de la app en developers.facebook.com y después reconectá la página acá en Config → Canales (el token viejo NO gana permisos solo).'
        : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
});

/**
 * GET /api/channels/comments/:id/thread — v0.9.580
 * El hilo COMPLETO del comentario, pedido a Meta en el momento.
 *
 * Por qué no sale de nuestra base: el webhook descarta los comentarios de la propia
 * página (si no, Aitana se contestaría a sí misma en bucle), así que nuestras propias
 * respuestas nunca se guardaron; y las respuestas posteriores del cliente quedaban como
 * filas sueltas, sin relación visible con el comentario que las originó. El resultado
 * era que el panel mostraba el primer comentario y una línea suelta con el último texto
 * que habíamos publicado — nunca la conversación.
 */
router.get('/channels/comments/:id/thread', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  try {
    const cr = await db.query(`SELECT * FROM channel_comments WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId]);
    const c = cr.rows[0];
    if (!c) return res.status(404).json({ error: 'Comentario no encontrado' });
    const isIG = c.channel === 'instagram';
    const cc = await _getChannelCtx(tenantId, isIG ? 'instagram' : 'messenger');
    if (!cc || !cc.token) return res.status(409).json({ error: 'La página no está conectada (sin token). Reconectala en Config → Canales.' });
    // El id "nuestro" de la página/IG, para marcar qué mensajes del hilo son propios.
    const propio = new Set([String(cc.pageId || ''), String(cc.igId || '')].filter(Boolean));
    const t = await meta.getCommentThread(c.comment_id, cc.token, isIG);
    if (!t.success) {
      // Sin pages_read_user_content Meta devuelve #200; se dice con todas las letras.
      const falta = /permission|#200|OAuth/i.test(String(t.error || ''));
      return res.status(falta ? 409 : 502).json({
        error: falta
          ? 'Meta no deja leer el hilo: falta el permiso pages_read_user_content en el token de la página. Reconectala en Config → Canales.'
          : t.error,
      });
    }
    const marcar = (m) => Object.assign({}, m, { es_nuestro: propio.has(String(m.from_id || '')) });
    res.json({
      ok: true,
      root: marcar(t.root),
      replies: (t.replies || []).map(marcar),
      total: 1 + (t.replies || []).length,
    });
  } catch (e) {
    console.error('❌ [comments/thread] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.283 — Responder un comentario: público (en el hilo) o privado (DM al que comentó).
router.post('/channels/comments/:id/reply', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  const text = String((req.body && req.body.text) || '').trim();
  const mode = String((req.body && req.body.mode) || 'public');
  if (!text) return res.status(400).json({ error: 'Escribí una respuesta' });
  try {
    const cr = await db.query(`SELECT * FROM channel_comments WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId]);
    const c = cr.rows[0];
    if (!c) return res.status(404).json({ error: 'Comentario no encontrado' });
    const isIG = c.channel === 'instagram';
    const cc = await _getChannelCtx(tenantId, isIG ? 'instagram' : 'messenger');
    if (!cc || !cc.token) return res.status(409).json({ error: 'La página de Facebook/Instagram no está conectada (sin token). Reconectala en Config → Canales y volvé a intentar.' });
    const uid = req.userId || null;
    if (mode === 'private') {
      const r = await meta.sendPrivateReplyToComment(c.page_id, c.comment_id, text, cc.token);
      if (!r.success) return res.status(400).json({ error: _commentReplyErr(r.error, 'private') });
      await db.query(`UPDATE channel_comments SET status = 'dm_sent', replied_at = NOW(), handled_by = $2 WHERE id = $1`, [id, uid]);
      return res.json({ ok: true, mode: 'private', status: 'dm_sent' });
    }
    const r = await meta.replyToCommentPublic(c.comment_id, text, cc.token, isIG);
    if (!r.success) return res.status(400).json({ error: _commentReplyErr(r.error, 'public') });
    await db.query(`UPDATE channel_comments SET status = 'replied', replied_at = NOW(), reply_text = $2, handled_by = $3 WHERE id = $1`, [id, text, uid]);
    res.json({ ok: true, mode: 'public', status: 'replied' });
  } catch (e) {
    console.error('❌ [comments/reply] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.283 — Cambiar estado (resolver / ignorar / reabrir).
router.post('/channels/comments/:id/status', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  const status = String((req.body && req.body.status) || '').trim();
  if (!['new', 'replied', 'resolved', 'ignored'].includes(status)) return res.status(400).json({ error: 'estado inválido' });
  try {
    const r = await db.query(`UPDATE channel_comments SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId, status]);
    if (!r.rows.length) return res.status(404).json({ error: 'no encontrado' });
    res.json({ ok: true, status });
  } catch (e) { console.error('❌ [comments/status]', e.message); res.status(500).json({ error: e.message }); }
});

// v0.9.283 — Asignar/desasignar el comentario a un asesor del equipo.
router.post('/channels/comments/:id/assign', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  const raw = req.body ? req.body.user_id : null;
  const userId = (raw === null || raw === '' || raw === undefined) ? null : parseInt(raw);
  try {
    if (userId != null) {
      const u = await db.query(`SELECT id FROM tenant_users WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [userId, tenantId]);
      if (!u.rows.length) return res.status(400).json({ error: 'usuario inválido' });
    }
    const r = await db.query(`UPDATE channel_comments SET assigned_to = $3 WHERE id = $1 AND tenant_id = $2 RETURNING id`, [id, tenantId, userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'no encontrado' });
    res.json({ ok: true, assigned_to: userId });
  } catch (e) { console.error('❌ [comments/assign]', e.message); res.status(500).json({ error: e.message }); }
});

// v0.9.283 — Ocultar/mostrar el comentario en la red (Meta).
router.post('/channels/comments/:id/hide', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const id = parseInt(req.params.id);
  const hide = req.body ? (req.body.hide !== false) : true;
  try {
    const cr = await db.query(`SELECT * FROM channel_comments WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [id, tenantId]);
    const c = cr.rows[0];
    if (!c) return res.status(404).json({ error: 'no encontrado' });
    const isIG = c.channel === 'instagram';
    const cc = await _getChannelCtx(tenantId, isIG ? 'instagram' : 'messenger');
    if (!cc || !cc.token) return res.status(409).json({ error: 'La página de Facebook/Instagram no está conectada (sin token). Reconectala en Config → Canales y volvé a intentar.' });
    const r = await meta.hideComment(c.comment_id, hide, cc.token, isIG);
    if (!r.success) return res.status(400).json({ error: r.error || 'No se pudo ocultar' });
    await db.query(`UPDATE channel_comments SET is_hidden = $3 WHERE id = $1 AND tenant_id = $2`, [id, tenantId, hide]);
    res.json({ ok: true, is_hidden: hide });
  } catch (e) { console.error('❌ [comments/hide]', e.message); res.status(500).json({ error: e.message }); }
});

// v0.9.144 — Dispara las "required API test calls" del App Review (read engagement,
// IG basic, IG messages, manage_metadata) con el token guardado. Owner only.
router.post('/channels/run-review-calls', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const tc = await db.query(
      `SELECT page_id, ig_id, page_token_enc FROM tenant_channels
         WHERE tenant_id = $1 AND active = TRUE AND page_token_enc IS NOT NULL
         ORDER BY (ig_id IS NOT NULL) DESC, id DESC LIMIT 1`,
      [tenantId]
    );
    if (!tc.rows.length) return res.status(400).json({ error: 'No hay página conectada con token guardado' });
    const { page_id, ig_id, page_token_enc } = tc.rows[0];
    const token = decryptSafe(page_token_enc);
    if (!token) return res.status(400).json({ error: 'No se pudo descifrar el token de la página' });
    const results = await meta.runReviewTestCalls(page_id, ig_id, token);
    res.json({ ok: true, page_id, ig_id: ig_id || null, results });
  } catch (e) {
    console.error('❌ [channels/run-review-calls] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.143 — Re-suscribe la(s) página(s) conectada(s) al webhook con el token
// guardado (sin reconectar), y devuelve los fields suscritos (diagnóstico de `feed`).
router.post('/channels/resubscribe', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(`SELECT DISTINCT page_id, page_token_enc FROM tenant_channels WHERE tenant_id = $1 AND active = TRUE`, [tenantId]);
    const out = [];
    for (const row of r.rows) {
      const token = decryptSafe(row.page_token_enc);
      if (!token) { out.push({ page_id: row.page_id, error: 'sin token' }); continue; }
      let subErr = null;
      try { await meta.subscribePageToApp(row.page_id, token); } catch (e) { subErr = e.response?.data?.error?.message || e.message; }
      let fields = null;
      try { const subs = await meta.getPageSubscribedFields(row.page_id, token); fields = subs.map(s => s.subscribed_fields || []).flat(); } catch (e) { /* */ }
      out.push({ page_id: row.page_id, resubscribed: !subErr, subscribe_err: subErr, subscribed_fields: fields });
    }
    res.json({ ok: true, results: out });
  } catch (e) {
    console.error('❌ [channels/resubscribe] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Conecta una Página (Messenger + IG si está vinculado).
// Body: { user_token, page_id } — user_token = token corto del FB.login del panel.
router.post('/channels/connect', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  if (!process.env.ENCRYPTION_KEY) return res.status(503).json({ error: 'Servidor no configurado (falta ENCRYPTION_KEY)' });
  {
    const { rateLimitOk } = require('./auth');
    if (!rateLimitOk('connect-channel:' + tenantId, 10, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Demasiados intentos de conexión. Esperá unos minutos.' });
    }
  }
  const { user_token, page_id } = req.body || {};
  if (!user_token || !page_id) return res.status(400).json({ error: 'user_token y page_id requeridos' });

  try {
    // 1) token de usuario de larga duración (→ page token permanente)
    let longUserToken;
    try {
      longUserToken = await meta.exchangeForLongLivedUserToken(user_token);
    } catch (e) {
      console.error('❌ [channels/connect] long-lived exchange falló:', e.response?.data || e.message);
      return res.status(400).json({ error: 'No se pudo validar con Meta', detail: e.response?.data?.error?.message || e.message });
    }
    if (!longUserToken) return res.status(400).json({ error: 'Meta no devolvió token de usuario' });

    // 2) v0.9.141: page token + IG vía /me/accounts (NO usa GET /{page-id}, que exige
    //    pages_read_engagement). /me/accounts devuelve el access_token de cada página
    //    con pages_show_list. Buscamos la página elegida en esa lista.
    let pagesList = [];
    try {
      pagesList = await meta.getUserPages(longUserToken);
    } catch (e) {
      console.error('❌ [channels/connect] getUserPages falló:', e.response?.data || e.message);
      return res.status(403).json({ error: 'No se pudieron leer tus páginas de Facebook', detail: e.response?.data?.error?.message || e.message });
    }
    const page = pagesList.find(p => String(p.id) === String(page_id));
    if (!page) return res.status(404).json({ error: 'Esa página no está entre las que administrás con esta cuenta' });
    const pageToken = page.access_token;
    if (!pageToken) return res.status(403).json({ error: 'Meta no devolvió el token de la página (revisá que seas admin de la Página)' });
    const pageName = page.name || `Página ${String(page_id).slice(-4)}`;
    const igAcct = page.instagram_business_account || null;
    const igId = igAcct?.id || null;

    // 3) anti-robo: ¿esta página ya es de OTRA organización?
    const owner = await db.query(`SELECT DISTINCT tenant_id FROM tenant_channels WHERE page_id = $1`, [String(page_id)]);
    if (owner.rows.some(r => Number(r.tenant_id) !== Number(tenantId))) {
      return res.status(409).json({ error: 'Esa página ya está conectada en otra organización' });
    }

    // 4) guardar (cifrado) messenger + instagram (si hay IG)
    const enc = encryptToken(pageToken);
    const upsert = (channel, igVal) => db.query(
      `INSERT INTO tenant_channels (tenant_id, channel, page_id, ig_id, page_name, page_token_enc, active, connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW())
       ON CONFLICT (channel, page_id) DO UPDATE
         SET page_token_enc = EXCLUDED.page_token_enc, page_name = EXCLUDED.page_name,
             ig_id = EXCLUDED.ig_id, active = TRUE, connected_at = NOW()`,
      [tenantId, channel, String(page_id), igVal, pageName, enc]
    );
    await upsert('messenger', null);
    if (igId) await upsert('instagram', String(igId));

    // 5) suscribir la página al webhook (warn-only)
    let subscribed = false;
    try {
      await meta.subscribePageToApp(String(page_id), pageToken);
      subscribed = true;
      console.log(`✅ [channels/connect] Página ${page_id} suscrita (tenant ${tenantId})`);
    } catch (e) {
      console.warn('⚠️ [channels/connect] No se pudo suscribir la página:', e.response?.data?.error?.message || e.message);
    }

    const list = await db.query(CHANNELS_SELECT, [tenantId]);
    res.status(201).json({
      ok: true,
      page_name: pageName,
      instagram: igId ? (igAcct.username || igId) : null,
      webhook_subscribed: subscribed,
      channels: list.rows,
    });
  } catch (e) {
    console.error('❌ [channels/connect] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// v0.9.135 — Facebook Login for Business: intercambia el "code" del login
// (config_id) por un user access token y lista las Páginas que administra el
// usuario (para el selector). Esta app NO acepta FB.login con scope (el SDK
// rompe al parsear la respuesta) → hay que usar config_id + code, igual que el
// login del panel.
router.post('/channels/fb-exchange', requireTenantSession, requireRole('owner'), async (req, res) => {
  const { code, redirect_uri } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code requerido' });
  {
    const { rateLimitOk } = require('./auth');
    const tid = req.tenantId || 0;
    if (!rateLimitOk('channel-exchange:' + tid, 15, 15 * 60 * 1000)) {
      return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos.' });
    }
  }
  try {
    let tokenData;
    try {
      // v0.9.137: flujo REDIRECT (como el login del panel). El code se intercambia
      // CON el mismo redirect_uri del diálogo (origin + /panel/) → evita el error
      // "redirect_uri must be identical to the one in the OAuth dialog request".
      tokenData = await meta.exchangeLoginCodeForToken(code, redirect_uri || '');
    } catch (e) {
      console.error('❌ [channels/fb-exchange] exchange falló:', e.response?.data || e.message);
      return res.status(400).json({ error: 'No se pudo validar el login con Meta', detail: e.response?.data?.error?.message || e.message });
    }
    const userToken = tokenData.access_token;
    if (!userToken) return res.status(400).json({ error: 'Meta no devolvió token de usuario' });
    let pages = [];
    let pagesErr = null;
    try {
      pages = await meta.getUserPages(userToken);
    } catch (e) {
      pagesErr = e.response?.data?.error?.message || e.message;
      console.warn('⚠️ [channels/fb-exchange] getUserPages:', pagesErr);
    }
    // v0.9.141: NO mandar los page access tokens al frontend (solo id/name/ig).
    const safePages = pages.map(p => ({ id: p.id, name: p.name, instagram_business_account: p.instagram_business_account || null }));
    console.log(`[channels/fb-exchange] token=${!!userToken} pages=${pages.length} err=${pagesErr || '-'}`);
    res.json({ ok: true, user_token: userToken, pages: safePages, pages_count: safePages.length, _pages_err: pagesErr });
  } catch (e) {
    console.error('❌ [channels/fb-exchange] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Desconecta una Página (desactiva messenger + instagram de esa página).
// Body: { page_id }
router.post('/channels/disconnect', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const { page_id } = req.body || {};
  if (!page_id) return res.status(400).json({ error: 'page_id requerido' });
  try {
    // intentar desuscribir del webhook (warn-only) con el token guardado
    try {
      const tok = await db.query(`SELECT page_token_enc FROM tenant_channels WHERE tenant_id = $1 AND page_id = $2 LIMIT 1`, [tenantId, String(page_id)]);
      const pageToken = tok.rows[0] ? decryptSafe(tok.rows[0].page_token_enc) : null;
      if (pageToken) await meta.unsubscribePageFromApp(String(page_id), pageToken);
    } catch (e) {
      console.warn('⚠️ [channels/disconnect] no se pudo desuscribir:', e.response?.data?.error?.message || e.message);
    }
    await db.query(`UPDATE tenant_channels SET active = FALSE WHERE tenant_id = $1 AND page_id = $2`, [tenantId, String(page_id)]);
    const list = await db.query(CHANNELS_SELECT, [tenantId]);
    res.json({ ok: true, channels: list.rows });
  } catch (e) {
    console.error('❌ [channels/disconnect] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ v0.9.281 — CANAL TELEGRAM (bot por tenant vía @BotFather) ============
// Misma infra omnicanal (tenant_channels): channel='telegram', page_id=<bot_id>,
// page_name='@user', page_token_enc=<bot token>, webhook_secret=<random>.
router.get('/channels/telegram', requireTenantSession, async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(
      `SELECT page_id AS bot_id, page_name AS bot_username, active,
              (business_connection_id IS NOT NULL) AS business_connected, COALESCE(business_can_reply, TRUE) AS business_can_reply
         FROM tenant_channels WHERE tenant_id = $1 AND channel = 'telegram' AND active = TRUE ORDER BY id`, [tenantId]);
    res.json({ ok: true, bots: r.rows });
  } catch (e) {
    if (/tenant_channels|webhook_secret|business_connection_id|business_can_reply/.test(e.message)) return res.json({ ok: true, bots: [], needs_migration: true });
    res.status(500).json({ error: e.message });
  }
});

router.post('/channels/connect-telegram', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const token = String((req.body && req.body.bot_token) || '').trim();
  if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) return res.status(400).json({ error: 'Token de bot inválido (pegá el que te da @BotFather)' });
  try {
    const tg = require('./telegram');
    const me = await tg.getMe(token);
    if (!me || !me.id) return res.status(400).json({ error: 'Telegram no reconoció el token' });
    const secret = require('crypto').randomBytes(16).toString('hex');
    const base = process.env.PUBLIC_BASE_URL || 'https://app.sg-ventas.com';
    const url = `${base}/api/telegram/webhook/${secret}`;
    await tg.setWebhook(token, url, secret);
    await db.query(
      `INSERT INTO tenant_channels (tenant_id, channel, page_id, page_name, page_token_enc, webhook_secret, active)
       VALUES ($1,'telegram',$2,$3,$4,$5,TRUE)
       ON CONFLICT (channel, page_id) DO UPDATE
         SET tenant_id = EXCLUDED.tenant_id, page_name = EXCLUDED.page_name,
             page_token_enc = EXCLUDED.page_token_enc, webhook_secret = EXCLUDED.webhook_secret, active = TRUE`,
      [tenantId, String(me.id), '@' + (me.username || me.id), encryptToken(token), secret]);
    console.log(`✅ [telegram] bot @${me.username} conectado (tenant ${tenantId})`);
    res.json({ ok: true, bot: '@' + (me.username || me.id), bot_id: String(me.id) });
  } catch (e) {
    const detail = (e.response && e.response.data && e.response.data.description) || e.message;
    console.error('❌ [channels/connect-telegram] error:', detail);
    res.status(400).json({ error: 'No se pudo conectar el bot', detail });
  }
});

router.post('/channels/disconnect-telegram', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin && req.query.tenant_id ? parseInt(req.query.tenant_id) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const botId = String((req.body && req.body.bot_id) || '').trim();
  try {
    const tg = require('./telegram');
    const r = await db.query(`SELECT page_token_enc FROM tenant_channels WHERE tenant_id = $1 AND channel = 'telegram' AND page_id = $2 LIMIT 1`, [tenantId, botId]);
    const tok = r.rows[0] ? decryptSafe(r.rows[0].page_token_enc) : null;
    if (tok) { try { await tg.deleteWebhook(tok); } catch (e) { console.warn('⚠️ [telegram] deleteWebhook:', e.message); } }
    await db.query(`UPDATE tenant_channels SET active = FALSE WHERE tenant_id = $1 AND channel = 'telegram' AND page_id = $2`, [tenantId, botId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('❌ [channels/disconnect-telegram] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============ v0.9.160 — TICKETS DE PLATAFORMA (clientes reportan bugs a SG Ventas) ============
// El tenant (cualquier usuario) reporta un problema del programa; el super-admin lo atiende
// en cola desde el panel de Netlify y lo analiza con IA (Gemini). Separado del BPO (support_tickets).
const _PT_STATUS = ['abierto', 'en_proceso', 'resuelto'];
const _PT_PRIORITY = ['baja', 'media', 'alta', 'critica'];

// v0.9.161 — DEFENSA: asegura el esquema de platform_bug_reports en runtime (idempotente,
// cacheado por proceso). Cubre el caso de que la tabla YA existiera con otro esquema
// (de una versión previa) o que la migración no haya corrido: agrega las columnas que
// falten con ADD COLUMN IF NOT EXISTS. Se llama al boot (server.js) y en el 1er reporte.
let _ptSchemaEnsured = false;
async function ensurePlatformTicketsSchema() {
  if (_ptSchemaEnsured) return;
  await db.query(`CREATE TABLE IF NOT EXISTS platform_bug_reports (id SERIAL PRIMARY KEY)`);
  const cols = [
    ['tenant_id', 'INTEGER'], ['reporter_user_id', 'INTEGER'], ['reporter_name', 'TEXT'], ['reporter_email', 'TEXT'],
    ['title', 'TEXT'], ['description', 'TEXT'], ['area', 'TEXT'], ['screenshot_url', 'TEXT'],
    ['status', "TEXT DEFAULT 'abierto'"], ['priority', 'TEXT'], ['ai_category', 'TEXT'], ['ai_severity', 'TEXT'],
    ['ai_summary', 'TEXT'], ['ai_suggested_action', 'TEXT'], ['ai_analyzed_at', 'TIMESTAMPTZ'],
    ['admin_reply', 'TEXT'], ['admin_notes', 'TEXT'], ['created_at', 'TIMESTAMPTZ DEFAULT NOW()'], ['updated_at', 'TIMESTAMPTZ DEFAULT NOW()'],
  ];
  for (const [c, t] of cols) await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS ${c} ${t}`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_platform_bug_reports_status ON platform_bug_reports (status, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_platform_bug_reports_tenant ON platform_bug_reports (tenant_id, created_at DESC)`);
  _ptSchemaEnsured = true;
  console.log('✅ platform_bug_reports schema asegurado en runtime');
}

// POST /api/tickets/report — el tenant crea un reporte (cualquier usuario logueado).
router.post('/tickets/report', requireTenantSession, async (req, res) => {
  await ensurePlatformTicketsSchema().catch(() => {});
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.body?.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const title = String(req.body?.title || '').trim();
  const description = String(req.body?.description || '').trim();
  const area = (String(req.body?.area || '').trim() || null);
  if (!title) return res.status(400).json({ error: 'Poné un título corto del problema' });
  if (!description) return res.status(400).json({ error: 'Describí qué pasó' });
  if (title.length > 200) return res.status(400).json({ error: 'Título demasiado largo (máx 200)' });
  if (description.length > 4000) return res.status(400).json({ error: 'Descripción demasiado larga (máx 4000)' });

  // Screenshot opcional como data URL base64 → subir a R2 (best-effort, no bloquea el ticket).
  let screenshotUrl = null;
  const shot = req.body?.screenshot_base64;
  if (shot && typeof shot === 'string' && shot.startsWith('data:image/')) {
    try {
      const m = shot.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (m) {
        const buffer = Buffer.from(m[2], 'base64');
        if (buffer.length > 0 && buffer.length <= 5 * 1024 * 1024) {
          const up = await r2.upload({ buffer, mimeType: m[1], prefix: 'tickets', filename: 'screenshot' });
          if (up && up.url) screenshotUrl = up.url;
        }
      }
    } catch (e) { console.warn('[ticket] screenshot upload falló (no bloqueante):', e.message); }
  }

  let rName = null, rEmail = null;
  if (req.userId) {
    try {
      const u = await db.query('SELECT display_name, email FROM tenant_users WHERE id = $1', [req.userId]);
      if (u.rows[0]) { rName = u.rows[0].display_name || null; rEmail = u.rows[0].email || null; }
    } catch (e) {}
  }
  try {
    const ins = await db.query(
      `INSERT INTO platform_bug_reports (tenant_id, reporter_user_id, reporter_name, reporter_email, title, description, area, screenshot_url, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'abierto') RETURNING id, created_at`,
      [tenantId, req.userId || null, rName, rEmail, title, description, area, screenshotUrl]
    );
    console.log(`🐞 [ticket] nuevo #${ins.rows[0].id} tenant ${tenantId}: ${title.slice(0, 60)}`);
    res.json({ ok: true, id: ins.rows[0].id, created_at: ins.rows[0].created_at });
  } catch (e) {
    console.error('[ticket] insert error:', e.message);
    res.status(500).json({ error: 'No se pudo guardar el reporte: ' + e.message });
  }
});

// GET /api/tickets/mine — el tenant ve sus propios reportes (estado + respuesta de soporte).
router.get('/tickets/mine', requireTenantSession, async (req, res) => {
  await ensurePlatformTicketsSchema().catch(() => {});
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query(
      `SELECT id, title, description, area, screenshot_url, status, priority, admin_reply, created_at, updated_at
         FROM platform_bug_reports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`, [tenantId]);
    res.json({ ok: true, tickets: r.rows });
  } catch (e) {
    if (/platform_bug_reports/.test(e.message)) return res.json({ ok: true, tickets: [], need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/platform-tickets — super-admin: cola completa (+ filtro ?status=).
router.get('/admin/platform-tickets', requireAdminToken, async (req, res) => {
  await ensurePlatformTicketsSchema().catch(() => {});
  const status = String(req.query.status || 'all');
  const params = []; let where = '';
  if (_PT_STATUS.includes(status)) { params.push(status); where = `WHERE t.status = $1`; }
  try {
    const r = await db.query(
      `SELECT t.*, tn.name AS tenant_name
         FROM platform_bug_reports t LEFT JOIN tenants tn ON tn.id = t.tenant_id
         ${where}
         ORDER BY (t.status = 'abierto') DESC, t.created_at DESC LIMIT 500`, params);
    const counts = await db.query(`SELECT status, COUNT(*)::int AS n FROM platform_bug_reports GROUP BY status`);
    res.json({ ok: true, tickets: r.rows, counts: counts.rows });
  } catch (e) {
    if (/platform_bug_reports/.test(e.message)) return res.json({ ok: true, tickets: [], counts: [], need_migration: true });
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/admin/platform-tickets/:id — super-admin: estado / prioridad / respuesta / notas.
router.patch('/admin/platform-tickets/:id', requireAdminToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  const sets = [], vals = [];
  if (req.body.status != null) { if (!_PT_STATUS.includes(req.body.status)) return res.status(400).json({ error: 'estado inválido' }); vals.push(req.body.status); sets.push(`status = $${vals.length}`); }
  if (req.body.priority != null) { if (!_PT_PRIORITY.includes(req.body.priority)) return res.status(400).json({ error: 'prioridad inválida' }); vals.push(req.body.priority); sets.push(`priority = $${vals.length}`); }
  if (req.body.admin_reply != null) { vals.push(String(req.body.admin_reply).slice(0, 4000)); sets.push(`admin_reply = $${vals.length}`); }
  if (req.body.admin_notes != null) { vals.push(String(req.body.admin_notes).slice(0, 4000)); sets.push(`admin_notes = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nada para actualizar' });
  vals.push(id);
  try {
    const r = await db.query(`UPDATE platform_bug_reports SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'no encontrado' });
    res.json({ ok: true, ticket: r.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/platform-tickets/:id/analyze — super-admin: triage con IA (Gemini). Tokens → ai_usage.
router.post('/admin/platform-tickets/:id/analyze', requireAdminToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id inválido' });
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Falta GEMINI_API_KEY' });
  try {
    const tr = await db.query('SELECT * FROM platform_bug_reports WHERE id = $1', [id]);
    const t = tr.rows[0];
    if (!t) return res.status(404).json({ error: 'no encontrado' });
    const started = Date.now();
    const systemPrompt = `Sos un analista de soporte técnico de SG Ventas (un CRM de WhatsApp con la asistente Aitana). Te paso un TICKET que un cliente (dueño de negocio) reportó sobre un problema del programa. Clasificalo para que el equipo lo priorice y atienda.
Devolvé SOLO un JSON válido, sin markdown:
{"categoria":"<bug | error de uso | pedido de funcion | duda | facturacion | otro>","severidad":"<baja | media | alta | critica>","resumen":"<1-2 lineas, qué pasa>","accion_sugerida":"<qué deberia hacer soporte primero, 1-2 lineas>"}`;
    const userPrompt = `TÍTULO: ${t.title}\nÁREA: ${t.area || '(no indicada)'}\nDESCRIPCIÓN:\n${t.description}`;
    const axios = require('axios');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
    const gr = await axios.post(url, {
      contents: [{ parts: [{ text: userPrompt }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 0.2, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' },
    }, { timeout: 40000, headers: { 'Content-Type': 'application/json' } });

    try {
      const um = gr.data && gr.data.usageMetadata;
      if (um) {
        const pt = Number(um.promptTokenCount) || 0, ot = Number(um.candidatesTokenCount) || 0;
        await db.query(`INSERT INTO ai_usage (tenant_id, model, prompt_tokens, output_tokens, total_tokens) VALUES ($1,$2,$3,$4,$5)`,
          [t.tenant_id, _GEM_MODEL, pt, ot, Number(um.totalTokenCount) || (pt + ot)]);
      }
    } catch (uerr) { console.warn('[ai_usage] log ticket-analyze falló (no bloqueante):', uerr.message); }

    let parsed = {};
    try { parsed = JSON.parse(gr.data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}'); } catch (e) { parsed = {}; }
    const upd = await db.query(
      `UPDATE platform_bug_reports SET ai_category=$1, ai_severity=$2, ai_summary=$3, ai_suggested_action=$4, ai_analyzed_at=NOW(), updated_at=NOW() WHERE id=$5 RETURNING *`,
      [parsed.categoria || null, parsed.severidad || null, parsed.resumen || null, parsed.accion_sugerida || null, id]);
    res.json({ ok: true, ticket: upd.rows[0], meta: { duration_ms: Date.now() - started } });
  } catch (e) {
    res.status(502).json({ error: 'No se pudo analizar: ' + (e.response?.data?.error?.message || e.message) });
  }
});
// ============ FIN TICKETS DE PLATAFORMA ============

// v0.9.274 — BROADCAST a demanda: el super-admin compone un aviso y lo manda por PUSH a los tenants,
// y (opcional) por WhatsApp free-form al dueño. El free-form SOLO entra dentro de la ventana de 24h
// (mensaje de servicio, sin costo); fuera de la ventana Meta lo rechaza → NO se cobra plantilla. Por eso
// acá NUNCA mandamos plantilla: si no entra el free-form, simplemente no llega (queda contado como fuera de ventana).
router.post('/admin/broadcast', requireAdminToken, async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim().slice(0, 120);
  const body = String((req.body && req.body.body) || '').trim().slice(0, 1000);
  const target = (req.body && req.body.target) || 'all';
  const alsoWhatsapp = !!(req.body && req.body.also_whatsapp);
  if (!body) return res.status(400).json({ ok: false, error: 'El cuerpo del mensaje es requerido.' });
  try {
    let ids = [];
    if (target && typeof target === 'object' && target.tenant_id) {
      const tid = parseInt(target.tenant_id, 10);
      if (Number.isFinite(tid)) ids = [tid];
    } else {
      const r = await db.query(`SELECT id FROM tenants WHERE active = TRUE AND LOWER(COALESCE(billing_status,'')) <> 'cancelled' ORDER BY id`);
      ids = r.rows.map((x) => x.id);
    }
    const roles = (req.body && Array.isArray(req.body.roles) && req.body.roles.length) ? req.body.roles : ['owner'];
    let pushSent = 0, waSent = 0, waFailed = 0;
    for (const id of ids) {
      try { const pr = await pushNotifier.broadcast({ title: title || '📣 SG Ventas', body, url: '/panel/' }, id, { roles }); pushSent += (pr && pr.sent) || 0; } catch (e) { console.warn('[broadcast] push tenant', id, e.message); }
      if (alsoWhatsapp) {
        try {
          const ap = (await db.query('SELECT alert_phone FROM tenants WHERE id = $1', [id])).rows[0];
          let phone = ap && ap.alert_phone;
          if (!phone && id === 1) phone = process.env.OWNER_PHONE || null;
          if (phone) {
            const _meta = require('./meta');
            const ctx = await getConversationMetaCtx({ tenant_id: id });
            const txt = (title ? '*' + title + '*\n\n' : '') + body;
            const rr = await _meta.sendText(phone, txt, false, ctx);
            if (rr && rr.success) waSent += 1; else waFailed += 1;
          }
        } catch (e) { waFailed += 1; }
      }
    }
    console.log(`📣 [broadcast] ${ids.length} tenant(s) · push ${pushSent} · wa ${waSent} ok / ${waFailed} fuera de ventana`);
    res.json({ ok: true, tenants: ids.length, push_sent: pushSent, whatsapp_sent: waSent, whatsapp_failed: waFailed });
  } catch (e) {
    console.error('[broadcast]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// v0.9.274 — Aviso de ACTIVACIÓN (push al dueño + WhatsApp best-effort). Factorizado para reusarlo
// desde el PATCH manual de billing_status y desde el cron de conversión de trials (runTrialConversions).
async function notifyTenantActivated(id) {
  try {
    pushNotifier.broadcast({
      title: '✅ Tu cuenta está activa',
      body: 'A fin de mes se cobra tu plan fijo + el consumo de IA del mes. Podés verlo en "Mi plan" desde tu cuenta.',
      url: '/panel/',
    }, id, { roles: ['owner'] })
      .then(r => console.log(`📲 [activación] push de cobro a tenant ${id}: ${r.sent} enviado(s)`))
      .catch(e => console.warn('[activación] push falló:', e.message));
  } catch (e) { console.warn('[activación] push falló:', e.message); }
  try {
    const _ap = (await db.query('SELECT alert_phone FROM tenants WHERE id = $1', [id])).rows[0];
    let _alertPhone = _ap && _ap.alert_phone;
    if (!_alertPhone && id === 1) _alertPhone = process.env.OWNER_PHONE || null;
    if (!_alertPhone) { console.log(`📲 [activación] WhatsApp omitido (tenant ${id} sin alert_phone)`); return; }
    const _meta = require('./meta');
    const _ctx = await getConversationMetaCtx({ tenant_id: id });
    const _txt = `✅ ¡Tu cuenta de SG Ventas está activa!\n\nA fin de mes se cobra tu plan fijo (Bs) + el consumo de IA del mes (en USD, convertido a Bs al tipo de cambio oficial del BCB). Podés ver el detalle y el total a pagar en *Mi plan*, desde tu cuenta principal.`;
    const _r = await _meta.sendText(_alertPhone, _txt, false, _ctx);
    console.log(`📲 [activación] WhatsApp a tenant ${id} (${_alertPhone}): ${_r && _r.success ? 'ok' : 'falló ' + ((_r && _r.error) || '')}`);
  } catch (e) { console.warn('[activación] WhatsApp falló:', e.message); }
}

// v0.9.274 — CRON (diario): convierte a PAGO los trials cuyo trial_ends_at ya venció.
// Marca la fecha de corte (billing_anchor_at = trial_ends_at) → desde ahí se cuenta el consumo
// y arranca el cobro (primer mes prorrateado). Dispara el aviso de activación. SOLO afecta cuentas
// con trial_ends_at seteado (las altas NUEVAS por el connect); los trials viejos quedan intactos.
async function runTrialConversions() {
  let due;
  try {
    due = await db.query(
      `SELECT id, trial_ends_at FROM tenants
        WHERE LOWER(COALESCE(billing_status,'')) = 'trial'
          AND trial_ends_at IS NOT NULL
          AND trial_ends_at <= NOW()`);
  } catch (e) { console.warn('[trial→pago] query:', e.message); return { converted: 0 }; }
  let n = 0;
  for (const t of (due.rows || [])) {
    try {
      const up = await db.query(
        `UPDATE tenants
            SET billing_status = 'active',
                billing_anchor_at = COALESCE(billing_anchor_at, trial_ends_at)
          WHERE id = $1 AND LOWER(COALESCE(billing_status,'')) = 'trial'
          RETURNING id`, [t.id]);
      if (up.rows.length === 0) continue; // carrera: ya no estaba en trial
      n += 1;
      console.log(`💳 [trial→pago] tenant ${t.id} → activo, corte = ${t.trial_ends_at}`);
      notifyTenantActivated(t.id).catch(() => {});
      // v0.9.274 — REFERIDOS: si este tenant fue referido, su crédito pasa a 'earned' (libera el 10% del referidor).
      try { await db.query(`UPDATE referral_credits SET status = 'earned', earned_at = NOW() WHERE referred_tenant_id = $1 AND status = 'pending'`, [t.id]); }
      catch (e) { console.warn(`[trial→pago] referral earn tenant ${t.id}:`, e.message); }
    } catch (e) { console.warn(`[trial→pago] tenant ${t.id}:`, e.message); }
  }
  if (n) console.log(`💳 [trial→pago] ${n} cuenta(s) convertidas a pago`);
  return { converted: n };
}

// ============ v0.9.276 — HEALTH CHECK DE LÍNEAS META ============
// Problema: el super-admin mostraba "Access Token 🟢 configurado" con solo tener un token guardado,
// aunque la línea estuviera DESCONECTADA de Meta (token vencido / número removido / permisos). Este
// chequeo valida el phone_number_id + token CONTRA Meta (getPhoneNumberInfo): si Meta devuelve los
// datos del número → 'connected'; si lo rechaza → 'disconnected'; si no hay con qué chequear → 'unknown'.

async function checkTenantMetaHealth(tenantId) {
  let phone = null, tokenEnc = null;
  try {
    const r = await db.query('SELECT meta_phone_number_id, meta_token_enc FROM tenants WHERE id = $1', [tenantId]);
    if (r.rows.length) { phone = r.rows[0].meta_phone_number_id; tokenEnc = r.rows[0].meta_token_enc; }
    // Fallback multi-línea: si la tabla tenants no tiene phone, usamos la primera línea configurada.
    if (!phone) {
      const l = await db.query(
        `SELECT meta_phone_number_id, meta_token_enc FROM tenant_lines
          WHERE tenant_id = $1 AND meta_phone_number_id IS NOT NULL ORDER BY id LIMIT 1`, [tenantId]);
      if (l.rows.length) { phone = l.rows[0].meta_phone_number_id; tokenEnc = l.rows[0].meta_token_enc; }
    }
  } catch (e) { return { status: 'unknown', error: e.message }; }

  let status = 'unknown', verified_name = null, display_phone_number = null;
  if (phone) {
    // v0.9.457: probar los tokens EN CAPAS antes de declarar la línea caída. Antes,
    // si la fila no tenía token propio se preguntaba con el token GLOBAL (SG Bolivia),
    // que obviamente no tiene permiso sobre el número de otro tenant → Meta lo rechaza
    // → marcábamos 'disconnected' y le mandábamos a José una ALERTA FALSA de línea caída.
    try {
      const probe = await probePhoneNumberInfo(tenantId, phone, tokenEnc);
      if (probe.tried === 0) status = 'unknown';
      else if (probe.info) {
        status = 'connected';
        verified_name = probe.info.verified_name;
        display_phone_number = probe.info.display_phone_number;
      } else status = 'disconnected';
    } catch (e) { status = 'disconnected'; }
  }
  try { await db.query('UPDATE tenants SET meta_health = $2, meta_health_at = NOW() WHERE id = $1', [tenantId, status]); } catch (_) {}
  return { status, verified_name, display_phone_number };
}

// CRON: chequea TODAS las líneas activas y ALERTA a José cuando una CAE (transición a 'disconnected').
async function runMetaHealthChecks() {
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, name, meta_health FROM tenants
        WHERE active = TRUE AND meta_phone_number_id IS NOT NULL
          AND LOWER(COALESCE(billing_status,'')) <> 'cancelled'
        ORDER BY id`)).rows;
  } catch (e) { console.warn('[meta-health] query:', e.message); return { checked: 0 }; }
  let checked = 0, down = 0;
  for (const t of rows) {
    const prev = t.meta_health;
    const { status } = await checkTenantMetaHealth(t.id);
    checked += 1;
    if (status === 'disconnected' && prev !== 'disconnected') {
      down += 1;
      console.warn(`🔴 [meta-health] línea CAÍDA: tenant ${t.id} (${t.name})`);
      notifyOwnerLineDown(t.id, t.name).catch(() => {});
    } else if (status === 'connected' && prev === 'disconnected') {
      console.log(`🟢 [meta-health] línea RECUPERADA: tenant ${t.id} (${t.name})`);
    }
  }
  if (down) console.warn(`🔴 [meta-health] ${down} línea(s) recién caída(s) de ${checked} chequeada(s)`);
  return { checked, down };
}

// Aviso a JOSÉ (dueño de la plataforma) cuando la línea de un tenant se desconecta. Push a la cuenta
// owner (tenant 1) + WhatsApp best-effort a OWNER_PHONE. Se dispara SOLO en la transición (no re-alerta
// mientras siga caída → sin spam).
async function notifyOwnerLineDown(tenantId, tenantName) {
  const label = `${tenantName || 'Tenant'} (#${tenantId})`;
  // v0.9.572 — alerta por email (canal independiente del push del navegador)
  try {
    await require('./mailer').alert(`linea-caida-${tenantId}`, {
      title: 'Línea de WhatsApp caída',
      detail: `La conexión de ${label} con Meta dejó de responder (token vencido o número removido).\nHay que reconectar la línea desde el panel.`,
      severity: 'error',
    });
  } catch (e) { console.warn('[line-down] email falló:', e.message); }
  try {
    await pushNotifier.broadcast({
      title: '🔴 Línea de WhatsApp caída',
      body: `La conexión de ${label} con Meta dejó de responder (token vencido o número removido). Reconectá la línea.`,
      url: '/panel/',
    }, 1, { roles: ['owner'] });
  } catch (e) { console.warn('[meta-health] push falló:', e.message); }
  try {
    let phone = process.env.OWNER_PHONE || null;
    if (!phone) { const _ap = (await db.query('SELECT alert_phone FROM tenants WHERE id = 1')).rows[0]; phone = _ap && _ap.alert_phone; }
    if (!phone) return;
    const _meta = require('./meta');
    const ctx = await getConversationMetaCtx({ tenant_id: 1 });
    const txt = `🔴 *Línea caída* — ${label}\n\nSu WhatsApp dejó de responderle a Meta (token vencido / número removido / permisos). No entran ni salen mensajes de ese tenant hasta reconectar.`;
    // v0.9.572 — igual que en bot-down: el mensaje libre NO sale si la ventana de 24 h
    // está cerrada, que es el caso normal en una alerta. Con ALERT_TEMPLATE_NAME sale
    // como plantilla aprobada; sin ella, se avisa en el log (el email ya salió).
    const tpl = process.env.ALERT_TEMPLATE_NAME || null;
    if (tpl) {
      const r = await _meta.sendTemplate(phone, tpl, process.env.ALERT_TEMPLATE_LANG || 'es',
        [{ type: 'body', parameters: [{ type: 'text', text: txt.replace(/\s+/g, ' ').slice(0, 900) }] }], ctx);
      if (!r || !r.success) console.warn(`[meta-health] plantilla "${tpl}" falló: ${r && r.error}`);
    } else {
      const r = await _meta.sendText(phone, txt, false, ctx);
      if (r && !r.success && /24 hours|131047|re-?engagement|outside/i.test(String(r.error || ''))) {
        console.warn('[meta-health] ⚠️ WhatsApp NO salió: ventana de 24 h cerrada. Configurá ALERT_TEMPLATE_NAME. El email SÍ se envió.');
      }
    }
  } catch (e) { console.warn('[meta-health] WhatsApp falló:', e.message); }
}
// ============ FIN HEALTH CHECK DE LÍNEAS META ============

// v0.9.46: expuesto para el worker de campañas programadas (setInterval en server.js)
// v0.9.313 — AUTO-RESOLVER tickets por inactividad del cliente (config por tenant) + endpoints.
router.get('/admin/support/config', requireTenantSession, requireRole('owner', 'supervisor'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  try {
    const r = await db.query('SELECT COALESCE(support_enabled, FALSE) AS enabled, COALESCE(ticket_idle_hours, 24) AS idle_hours FROM tenants WHERE id = $1', [tenantId]);
    let csat = { enabled: false, question: '', template: '', cooldown_days: 7 };
    try {
      const c = await db.query("SELECT COALESCE(csat_enabled,FALSE) AS enabled, COALESCE(csat_question,'') AS question, COALESCE(csat_template,'') AS template, COALESCE(csat_cooldown_days,7) AS cooldown_days FROM tenants WHERE id = $1", [tenantId]);
      if (c.rows[0]) csat = { enabled: !!c.rows[0].enabled, question: c.rows[0].question, template: c.rows[0].template, cooldown_days: c.rows[0].cooldown_days };
    } catch (e) { /* migración CSAT (v0.9.331) aún no corrió */ }
    res.json({ ok: true, enabled: !!(r.rows[0] && r.rows[0].enabled), idle_hours: (r.rows[0] ? r.rows[0].idle_hours : 24), csat });
  } catch (e) {
    if (/ticket_idle_hours/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.313 (ticket_idle_hours)' });
    res.status(500).json({ error: e.message });
  }
});
router.patch('/admin/support/idle-hours', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const h = Math.max(0, Math.min(720, parseInt((req.body || {}).hours, 10) || 0));
  try {
    await db.query('UPDATE tenants SET ticket_idle_hours = $1 WHERE id = $2', [h, tenantId]);
    res.json({ ok: true, idle_hours: h });
  } catch (e) {
    if (/ticket_idle_hours/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.313 (ticket_idle_hours)' });
    res.status(500).json({ error: e.message });
  }
});
// v0.9.331 — CSAT (encuesta de satisfacción BPO): guardar config por tenant.
router.patch('/admin/support/csat-config', requireTenantSession, requireRole('owner'), async (req, res) => {
  const tenantId = req.tenantId || (req.isSuperAdmin ? (Number(req.query.tenant_id) || 1) : null);
  if (!tenantId) return res.status(400).json({ error: 'tenant_id requerido' });
  const b = req.body || {};
  const enabled = !!b.enabled;
  const question = (b.question != null ? String(b.question) : '').trim().slice(0, 600) || null;
  const template = (b.template != null ? String(b.template) : '').trim().slice(0, 200) || null;
  const cooldown = Math.max(0, Math.min(90, parseInt(b.cooldown_days, 10) || 0));
  try {
    await db.query('UPDATE tenants SET csat_enabled = $1, csat_question = $2, csat_template = $3, csat_cooldown_days = $4 WHERE id = $5',
      [enabled, question, template, cooldown, tenantId]);
    res.json({ ok: true, csat: { enabled, question: question || '', template: template || '', cooldown_days: cooldown } });
  } catch (e) {
    if (/csat_/.test(e.message)) return res.status(503).json({ error: 'Falta la migración v0.9.331 (CSAT)' });
    res.status(500).json({ error: e.message });
  }
});
// Cron: recorre tenants con mesa de soporte on + ticket_idle_hours>0 y resuelve los tickets inactivos.
async function runTicketAutoResolve() {
  let tenants = [];
  try { tenants = (await db.query("SELECT id, COALESCE(ticket_idle_hours, 24) AS h FROM tenants WHERE COALESCE(support_enabled, FALSE) = TRUE AND COALESCE(ticket_idle_hours, 24) > 0")).rows; }
  catch (e) { return { skipped: 'not_migrated' }; }
  let total = 0;
  for (const t of tenants) {
    try {
      const ids = await supportTickets.autoResolveIdleTickets({ tenantId: t.id, hours: t.h });
      total += ids.length;
      if (ids.length) console.log(`🎧 [idle-resolve] tenant ${t.id}: ${ids.length} ticket(s) resuelto(s) por inactividad (${t.h}h)`);
    } catch (e) { console.warn(`[idle-resolve] tenant ${t.id} falló:`, e.message); }
  }
  return { resolved: total };
}
router.runTicketAutoResolve = runTicketAutoResolve;

// v0.9.363 — Scanner de SLA como CRON INTERNO (antes SOLO existía el endpoint
// /admin/tickets/sla-scan pensado para un worker de n8n que en la práctica no está
// configurado → los breaches de resolución NUNCA se marcaban y el tablero mostraba
// "Dentro de SLA 100%" como falso verde). Mismo patrón que runTicketAutoResolve.
// El endpoint para n8n sigue existiendo (idempotente: marcar dos veces no duplica).
async function runSlaBreachScan() {
  let tenants = [];
  try { tenants = (await db.query('SELECT id FROM tenants WHERE COALESCE(support_enabled, FALSE) = TRUE')).rows; }
  catch (e) { return { skipped: 'not_migrated' }; }
  let total = 0;
  for (const t of tenants) {
    try {
      const ids = await supportTickets.scanSlaBreaches({ tenantId: t.id });
      total += ids.length;
      if (ids.length) console.log(`🎧 [sla-scan] tenant ${t.id}: ${ids.length} ticket(s) marcados con SLA de resolución vencido`);
    } catch (e) { console.warn(`[sla-scan] tenant ${t.id} falló:`, e.message); }
  }
  return { breached: total };
}
router.runSlaBreachScan = runSlaBreachScan;

router.runDueCampaigns = runDueCampaigns;
router.runTrialConversions = runTrialConversions; // v0.9.274: cron trial→pago (setInterval en server.js)
router.runMetaHealthChecks = runMetaHealthChecks;   // v0.9.276: cron health check de líneas (setInterval en server.js)
router.checkTenantMetaHealth = checkTenantMetaHealth; // v0.9.276: chequeo on-demand (detalle del tenant)
router.ensurePlatformTicketsSchema = ensurePlatformTicketsSchema; // v0.9.161: lo llama server.js al boot
router.callMetaWithTenantTokens = callMetaWithTenantTokens; // v0.9.540: lo usa el borrado de tenant (admin-billing) para des-suscribir de Meta

module.exports = router;
