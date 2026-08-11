/**
 * tenant-resolver.js — v0.8.0 Sprint 2
 *
 * Middleware multi-tenant para sg-ventas.
 *
 * Responsabilidades:
 *   1. Resolver `req.tenant` a partir del token (X-Admin-Token header o ?token=)
 *   2. Mantener retrocompatibilidad: tu ADMIN_TOKEN actual sigue funcionando
 *      (porque ya está hasheado como token_hash del tenant_id=1 SG Bolivia)
 *   3. Caché in-memory para evitar bcrypt en cada request (TTL 60s)
 *   4. Lookup por hint primero (rápido), bcrypt solo si hay candidatos
 *
 * Exporta:
 *   - resolveTenant: middleware obligatorio para /api/admin/*
 *   - requireN8nSecret: middleware para /api/whatsapp/* y /api/bot/* (sin cambios)
 *   - optionalTenant: para endpoints públicos
 *   - invalidateTenantCache: para forzar refresh cuando se modifica un tenant
 *
 * Flow del resolveTenant:
 *   1. Extraer token (header X-Admin-Token o query.token)
 *   2. Buscar en cache → si encuentra y no expiró, return
 *   3. Calcular lookup_hint (primeros 8 chars del token)
 *   4. SELECT * FROM tenants WHERE token_lookup_hint = $hint AND active = TRUE
 *   5. Para cada candidato, bcrypt.compare(token, token_hash)
 *   6. El que matchea → req.tenant + cachear
 *   7. Si nada matchea → 401
 *
 * Nota sobre n8n: n8n se autentica con X-CRM-Secret (un shared secret global).
 * Eso significa que n8n NO está asociado a un tenant específico — puede
 * trabajar para CUALQUIER tenant. El tenant lo recibe en el PAYLOAD del request
 * (ej. body.tenant_id o body.conversation_id que ya tiene tenant_id implícito).
 */

const db = require('./db');
const bcrypt = require('bcryptjs');

const N8N_SHARED_SECRET = process.env.N8N_SHARED_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // legacy, para retrocompat

// ─── Cache de tokens resueltos ────────────────────────────────────
// Key: token plano (lo que vino en el request)
// Value: { tenant: {...}, expires: timestamp ms }
const tenantCache = new Map();
const CACHE_TTL_MS = 60_000; // 1 minuto

function _setCache(token, tenant) {
  tenantCache.set(token, {
    tenant,
    expires: Date.now() + CACHE_TTL_MS,
  });
}

function _getCache(token) {
  const entry = tenantCache.get(token);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    tenantCache.delete(token);
    return null;
  }
  return entry.tenant;
}

/**
 * Limpia cache. Llamar después de crear/modificar/eliminar tenants.
 */
function invalidateTenantCache(token = null) {
  if (token) {
    tenantCache.delete(token);
  } else {
    tenantCache.clear();
  }
}

// ─── Extracción de token del request ──────────────────────────────
function _extractToken(req) {
  return (
    req.headers['x-admin-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query.token ||
    null
  );
}

// ─── Lookup de tenant por token (con bcrypt) ──────────────────────
async function _lookupTenantByToken(token) {
  if (!token || token.length < 8) return null;

  // 1. Hint = primeros 8 chars
  const hint = token.slice(0, 8);

  // 2. Buscar candidatos por hint (puede haber 0, 1 o pocos)
  const r = await db.query(`
    SELECT id, slug, name, active, plan, token_hash,
           meta_phone_number_id, waba_id, r2_prefix,
           billing_status, read_only
    FROM tenants
    WHERE token_lookup_hint = $1 AND active = TRUE
    LIMIT 10
  `, [hint]);

  if (r.rows.length === 0) return null;

  // 3. Para cada candidato, bcrypt.compare
  for (const candidate of r.rows) {
    try {
      const matches = await bcrypt.compare(token, candidate.token_hash);
      if (matches) {
        // Removemos token_hash del objeto antes de devolverlo (no lo queremos en req)
        const { token_hash, ...tenant } = candidate;
        return tenant;
      }
    } catch (e) {
      console.error('bcrypt.compare error:', e.message);
    }
  }

  return null;
}

// =====================================================================
// MIDDLEWARES
// =====================================================================

/**
 * resolveTenant: middleware OBLIGATORIO para endpoints /api/admin/*.
 * Si no resuelve tenant → 401.
 * Si resuelve → setea req.tenant y deja pasar.
 */
async function resolveTenant(req, res, next) {
  const token = _extractToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  // Cache hit?
  const cached = _getCache(token);
  if (cached) {
    req.tenant = cached;
    return next();
  }

  // Cache miss, resolver
  try {
    const tenant = await _lookupTenantByToken(token);
    if (!tenant) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Tenant en read-only?
    if (tenant.read_only && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      return res.status(403).json({
        error: 'Tenant in read-only mode',
        billing_status: tenant.billing_status,
      });
    }

    _setCache(token, tenant);
    req.tenant = tenant;
    next();
  } catch (err) {
    console.error('resolveTenant error:', err);
    res.status(500).json({ error: 'Internal error during tenant resolution' });
  }
}

/**
 * optionalTenant: intenta resolver tenant pero NO falla si no hay.
 * Útil para endpoints públicos que pueden tener contexto opcional.
 */
async function optionalTenant(req, res, next) {
  const token = _extractToken(req);
  if (!token) {
    req.tenant = null;
    return next();
  }

  const cached = _getCache(token);
  if (cached) {
    req.tenant = cached;
    return next();
  }

  try {
    const tenant = await _lookupTenantByToken(token);
    if (tenant) {
      _setCache(token, tenant);
      req.tenant = tenant;
    } else {
      req.tenant = null;
    }
    next();
  } catch (err) {
    console.error('optionalTenant error:', err);
    req.tenant = null;
    next();
  }
}

/**
 * requireN8nSecret: middleware para endpoints donde n8n llama al backend.
 * No setea req.tenant — el tenant lo recibe en el payload.
 * IDÉNTICO al de api.js para retrocompat.
 */
function requireN8nSecret(req, res, next) {
  const provided = req.headers['x-crm-secret'];
  // v0.9.67 (auditoría 12-jun): comparación en tiempo constante (patrón C-2)
  const _c = require('crypto');
  const h = (s) => _c.createHash('sha256').update(String(s)).digest();
  const ok = N8N_SHARED_SECRET && provided &&
    _c.timingSafeEqual(h(provided), h(N8N_SHARED_SECRET));
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

/**
 * requireSuperAdmin: middleware para endpoints del panel super-admin.
 * Por ahora reusa ADMIN_TOKEN (env var). En Sprint 3 cambiamos a un
 * SUPER_ADMIN_TOKEN dedicado.
 */
function requireSuperAdmin(req, res, next) {
  const token = String(req.headers['x-super-admin-token'] || req.query.super_token || '');
  const superToken = process.env.SUPER_ADMIN_TOKEN || ADMIN_TOKEN;
  // v0.9.44 (auditoría C-2): comparación en tiempo constante (hash de largo fijo)
  const _c = require('crypto');
  const ok = superToken && token &&
    _c.timingSafeEqual(_c.createHash('sha256').update(token).digest(),
                       _c.createHash('sha256').update(superToken).digest());
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized (super-admin)' });
  }
  next();
}

// =====================================================================
// STEP 2b — Resolvers sin token (webhook + n8n)
// =====================================================================

// ─── Cache de tenant por phone_number_id (webhook Meta) ──────────
const phoneNumberIdCache = new Map();
const PHONE_NUMBER_ID_CACHE_TTL_MS = 60_000;

function _getPhoneNumberIdCache(pnid) {
  const entry = phoneNumberIdCache.get(pnid);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    phoneNumberIdCache.delete(pnid);
    return null;
  }
  return entry.tenant;
}

function _setPhoneNumberIdCache(pnid, tenant) {
  phoneNumberIdCache.set(pnid, {
    tenant,
    expires: Date.now() + PHONE_NUMBER_ID_CACHE_TTL_MS,
  });
}

function invalidatePhoneNumberIdCache(pnid = null) {
  if (pnid) phoneNumberIdCache.delete(pnid);
  else phoneNumberIdCache.clear();
}

/**
 * Resolver tenant a partir del phone_number_id que Meta envía en el webhook.
 * v0.9.13: primero busca en tenant_lines (multi-línea); si la tabla no existe
 * o no hay match, cae a la columna legacy tenants.meta_phone_number_id.
 * El tenant devuelto incluye `line_id` (null si vino por la vía legacy).
 *
 * @param {string} phoneNumberId - el value.metadata.phone_number_id de Meta
 * @returns {Promise<Object|null>} tenant object (con line_id) o null
 */
async function resolveTenantByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;

  const cached = _getPhoneNumberIdCache(phoneNumberId);
  if (cached) return cached;

  // v0.9.13 — Vía nueva: tenant_lines (una org puede tener N números)
  try {
    const rl = await db.query(`
      SELECT t.id, t.slug, t.name, t.active, t.plan, t.meta_phone_number_id,
             t.waba_id, t.r2_prefix, t.billing_status, t.read_only,
             tl.id AS line_id
      FROM tenant_lines tl
      JOIN tenants t ON t.id = tl.tenant_id
      WHERE tl.meta_phone_number_id = $1 AND tl.active = TRUE AND t.active = TRUE
      LIMIT 1
    `, [phoneNumberId]);
    if (rl.rows.length > 0) {
      const tenant = rl.rows[0];
      _setPhoneNumberIdCache(phoneNumberId, tenant);
      return tenant;
    }
  } catch (err) {
    // Tabla aún no migrada → seguimos con la vía legacy sin romper nada
    if (!/tenant_lines/.test(err.message)) {
      console.error('resolveTenantByPhoneNumberId (lines) error:', err.message);
    }
  }

  // Vía legacy: columna única en tenants
  try {
    const r = await db.query(`
      SELECT id, slug, name, active, plan, meta_phone_number_id, waba_id,
             r2_prefix, billing_status, read_only
      FROM tenants
      WHERE meta_phone_number_id = $1 AND active = TRUE
      LIMIT 1
    `, [phoneNumberId]);

    if (r.rows.length === 0) return null;

    const tenant = r.rows[0];
    tenant.line_id = null;
    _setPhoneNumberIdCache(phoneNumberId, tenant);
    return tenant;
  } catch (err) {
    console.error('resolveTenantByPhoneNumberId error:', err.message);
    return null;
  }
}

// ─── Cache de tenant por phone del cliente (n8n /whatsapp/send) ───
const phoneCache = new Map();
const PHONE_CACHE_TTL_MS = 60_000;

function _getPhoneCache(phone) {
  const entry = phoneCache.get(phone);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    phoneCache.delete(phone);
    return null;
  }
  return entry.tenant;
}

function _setPhoneCache(phone, tenant) {
  phoneCache.set(phone, {
    tenant,
    expires: Date.now() + PHONE_CACHE_TTL_MS,
  });
}

function invalidatePhoneCache(phone = null) {
  if (phone) phoneCache.delete(phone);
  else phoneCache.clear();
}

/**
 * Resolver tenant a partir del phone del cliente.
 * Busca en conversations.phone para encontrar el tenant_id existente.
 * Si no existe conversación previa, retorna null (caller decide fallback).
 *
 * @param {string} phone - número del cliente (ej. 59177001196)
 * @returns {Promise<Object|null>} tenant object o null
 */
async function resolveTenantByPhone(phone) {
  if (!phone) return null;

  const cached = _getPhoneCache(phone);
  if (cached) return cached;

  try {
    const r = await db.query(`
      SELECT t.id, t.slug, t.name, t.active, t.plan, t.meta_phone_number_id,
             t.waba_id, t.r2_prefix, t.billing_status, t.read_only
      FROM conversations c
      JOIN tenants t ON t.id = c.tenant_id
      WHERE c.phone = $1 AND t.active = TRUE
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT 1
    `, [phone]);

    if (r.rows.length === 0) return null;

    const tenant = r.rows[0];
    _setPhoneCache(phone, tenant);
    return tenant;
  } catch (err) {
    console.error('resolveTenantByPhone error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// v0.9.6 — Meta context por tenant (para envío multi-tenant)
// ─────────────────────────────────────────────────────────────────

const { decryptSafe } = require('./crypto');

// Cache del ctx por tenantId (TTL 60s) para no desencriptar en cada envío
const metaCtxCache = new Map();
const META_CTX_TTL_MS = 60_000;

/**
 * Devuelve el contexto Meta { phoneNumberId, accessToken } para un tenant.
 *
 * - Si el tenant tiene meta_phone_number_id + meta_token_enc (onboarded vía
 *   Embedded Signup) → devuelve esas credenciales (token desencriptado).
 * - Si NO tiene token propio (ej. SG Bolivia tenant 1, que usa el global) →
 *   devuelve null. meta.js interpreta null como "usá las env vars globales".
 *
 * Esto es lo que hace que SG Bolivia siga funcionando idéntico y los tenants
 * nuevos usen su propio WABA.
 *
 * @param {number} tenantId
 * @returns {Promise<{phoneNumberId, accessToken}|null>}
 */
async function getTenantMetaCtx(tenantId) {
  if (!tenantId || tenantId === 1) return null; // tenant 1 = global, sin ctx

  const cached = metaCtxCache.get(tenantId);
  if (cached && Date.now() < cached.expires) return cached.ctx;

  try {
    const r = await db.query(
      `SELECT meta_phone_number_id, meta_token_enc
         FROM tenants
        WHERE id = $1 AND active = TRUE
        LIMIT 1`,
      [tenantId]
    );
    if (r.rows.length === 0) return null;

    const { meta_phone_number_id, meta_token_enc } = r.rows[0];
    // Si falta cualquiera de los dos, cae al global (null)
    if (!meta_phone_number_id || !meta_token_enc) {
      metaCtxCache.set(tenantId, { ctx: null, expires: Date.now() + META_CTX_TTL_MS });
      return null;
    }

    const accessToken = decryptSafe(meta_token_enc);
    if (!accessToken) {
      console.error(`⚠️  getTenantMetaCtx: no se pudo desencriptar token de tenant ${tenantId}`);
      return null;
    }

    const ctx = { phoneNumberId: meta_phone_number_id, accessToken };
    metaCtxCache.set(tenantId, { ctx, expires: Date.now() + META_CTX_TTL_MS });
    return ctx;
  } catch (err) {
    console.error('getTenantMetaCtx error:', err.message);
    return null; // ante error, fallback al global (no rompe envío)
  }
}

function invalidateMetaCtxCache(tenantId = null) {
  if (tenantId) metaCtxCache.delete(tenantId);
  else metaCtxCache.clear();
}

// ─────────────────────────────────────────────────────────────────
// v0.9.13 — Meta ctx por LÍNEA (multi-línea por organización)
// ─────────────────────────────────────────────────────────────────

const lineCtxCache = new Map();

/**
 * Ctx Meta para una línea concreta.
 * Fallback de credenciales por capas (igual filosofía que _resolveCreds):
 *   token:  línea → tenant → global (null en el campo = meta.js usa env)
 *   número: SIEMPRE el de la línea (es el punto del multi-línea)
 *
 * Retorna:
 *   { phoneNumberId, accessToken } — accessToken puede ser null (= token global)
 *   null  — línea default del tenant 1 sin token propio (full legacy global)
 *   undefined — línea no encontrada/inactiva (caller decide fallback)
 */
async function getLineMetaCtx(lineId) {
  if (!lineId) return undefined;

  const cached = lineCtxCache.get(lineId);
  if (cached && Date.now() < cached.expires) return cached.ctx;

  try {
    const r = await db.query(
      `SELECT tl.meta_phone_number_id, tl.meta_token_enc, tl.is_default, tl.tenant_id,
              t.meta_token_enc AS tenant_token_enc
         FROM tenant_lines tl
         JOIN tenants t ON t.id = tl.tenant_id
        WHERE tl.id = $1 AND tl.active = TRUE AND t.active = TRUE
        LIMIT 1`,
      [lineId]
    );
    if (r.rows.length === 0) return undefined;

    const row = r.rows[0];
    let accessToken = null;
    if (row.meta_token_enc) accessToken = decryptSafe(row.meta_token_enc);
    if (!accessToken && row.tenant_token_enc) accessToken = decryptSafe(row.tenant_token_enc);

    let ctx;
    if (!accessToken && row.meta_phone_number_id === process.env.META_PHONE_NUMBER_ID) {
      // Línea principal global (SG Bolivia): comportamiento legacy idéntico
      ctx = null;
    } else {
      // accessToken null → meta.js usa el token global con el NÚMERO de la línea
      ctx = { phoneNumberId: row.meta_phone_number_id, accessToken };
    }
    lineCtxCache.set(lineId, { ctx, expires: Date.now() + META_CTX_TTL_MS });
    return ctx;
  } catch (err) {
    if (!/tenant_lines/.test(err.message)) {
      console.error('getLineMetaCtx error:', err.message);
    }
    return undefined; // tabla no migrada o error → caller usa fallback por tenant
  }
}

function invalidateLineCtxCache(lineId = null) {
  if (lineId) lineCtxCache.delete(lineId);
  else lineCtxCache.clear();
}

/**
 * Ctx Meta para responder UNA conversación: por su línea si la tiene,
 * si no por su tenant (comportamiento v0.9.6). Este es el helper que
 * deben usar TODOS los envíos ligados a una conversación.
 */
async function getConversationMetaCtx(conversation) {
  if (conversation && conversation.line_id) {
    const ctx = await getLineMetaCtx(conversation.line_id);
    if (ctx !== undefined) return ctx;
  }
  return getTenantMetaCtx(conversation ? conversation.tenant_id : null);
}

module.exports = {
  resolveTenant,
  optionalTenant,
  requireN8nSecret,
  requireSuperAdmin,
  invalidateTenantCache,
  // Step 2b — multi-tenant sin token
  resolveTenantByPhoneNumberId,
  resolveTenantByPhone,
  invalidatePhoneNumberIdCache,
  invalidatePhoneCache,
  // v0.9.6 — Meta ctx por tenant
  getTenantMetaCtx,
  invalidateMetaCtxCache,
  // v0.9.13 — multi-línea
  getLineMetaCtx,
  getConversationMetaCtx,
  invalidateLineCtxCache,
};
