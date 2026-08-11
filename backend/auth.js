/**
 * auth.js — v0.9.12
 *
 * Login con Facebook para clientes (tenants) del panel de Sg Sales.
 *
 * v0.9.12 — Multi-usuario por organización:
 *   - El login con Facebook queda SOLO para el dueño (owner): crea/vincula la
 *     organización y auto-provisiona su tenant_user con rol owner.
 *   - El ingreso diario de todos es email+password (POST /auth/login).
 *   - Alta de agentes: auto-registro con el invite_code de la org
 *     (POST /auth/register) o creación manual por el owner (api.js).
 *   - El JWT ahora lleva { tenant_id, slug, user_id, role, name }.
 *     JWTs viejos (sin user_id) siguen valiendo como owner (retrocompat).
 *   - requireRole(...roles): middleware de autorización por rol.
 *
 * Flujo:
 *   1. El cliente se loguea con Facebook en el panel (JS SDK).
 *   2. El frontend manda el FB access token a POST /api/auth/facebook-login.
 *   3. Validamos el token con Meta (debug_token), obtenemos el fb_user_id.
 *   4. Resolvemos el tenant:
 *      a) Si ya hay un tenant con ese fb_user_id → ese (logins siguientes).
 *      b) Si no, matcheamos los WABAs del usuario contra tenants.waba_id
 *         (primer login) y vinculamos fb_user_id al tenant encontrado.
 *   5. Emitimos un JWT firmado con JWT_SECRET que lleva { tenant_id, fb_user_id }.
 *   6. El frontend guarda el JWT y lo manda en cada request (Authorization: Bearer).
 *
 * Convivencia con el sistema actual:
 *   - El ADMIN_TOKEN global sigue funcionando (super-admin / auditoría).
 *   - El middleware requireTenantSession acepta JWT de tenant O el ADMIN_TOKEN.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto'); // v0.9.67: timing-safe en requireTenantSession
const db = require('./db');
const meta = require('./meta');

const JWT_TTL = '24h'; // v0.9.47 (auditoría A-5): antes 7d — un JWT robado valía una semana
// v0.9.434 — "Mantener sesión iniciada": TTL extendido OPT-IN desde el checkbox del login
// (el usuario lo elige explícitamente; el default sigue siendo 24h de A-5).
const JWT_REMEMBER_TTL = process.env.JWT_REMEMBER_TTL || '30d';
const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LEN = 8;

// v0.9.47 (auditoría A-6): rate limiting en memoria (anti fuerza bruta en login).
const _rl = new Map();
function rateLimitOk(key, max, windowMs) {
  const now = Date.now();
  const e = _rl.get(key) || { n: 0, t: now };
  if (now - e.t > windowMs) { e.n = 0; e.t = now; }
  e.n++;
  _rl.set(key, e);
  if (_rl.size > 5000) { for (const [k, v] of _rl) { if (now - v.t > windowMs) _rl.delete(k); } }
  return e.n <= max;
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
}

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET no configurado');
  return s;
}

/**
 * Emite un JWT de sesión para un tenant.
 * v0.9.12: si se pasa un tenant_user, el JWT lleva user_id + role + name.
 * Sin user (JWTs legacy / scripts), role implícito = owner.
 */
function issueSession(tenant, user = null, opts = null) {
  const payload = {
    tenant_id: tenant.id,
    slug: tenant.slug,
    fb_user_id: tenant.fb_user_id || null,
    user_id: user ? user.id : null,
    role: user ? user.role : 'owner',
    name: user ? (user.display_name || user.email || null) : null,
  };
  // v0.9.519 — SESIÓN DE SOPORTE (super-admin entra como el tenant). Marca en el
  // token que es soporte de SG, para que la auditoría distinga lo que hizo soporte
  // de lo que hizo el dueño, y para poder darle un TTL corto (no queda abierta).
  let ttl = (opts && opts.remember) ? JWT_REMEMBER_TTL : JWT_TTL;
  if (opts && opts.support) {
    payload.support = true;
    payload.name = payload.name || '🛟 Soporte SG';
    ttl = opts.supportTtl || '2h';
  }
  return jwt.sign(payload, getJwtSecret(), { expiresIn: ttl });
}

/**
 * v0.9.12 — Auto-provisiona (o recupera) el tenant_user OWNER para un login
 * con Facebook. Idempotente: busca por (tenant_id, fb_user_id); si no existe,
 * lo crea. Así la atribución de mensajes (sent_by) funciona también para el dueño.
 */
async function upsertOwnerUser(tenantId, fbUserId) {
  const found = await db.query(
    'SELECT id, role, display_name, email, active FROM tenant_users WHERE tenant_id = $1 AND fb_user_id = $2',
    [tenantId, fbUserId]
  );
  if (found.rows.length > 0) return found.rows[0];
  const ins = await db.query(
    `INSERT INTO tenant_users (tenant_id, fb_user_id, role, display_name)
     VALUES ($1, $2, 'owner', 'Dueño')
     ON CONFLICT DO NOTHING
     RETURNING id, role, display_name, email, active`,
    [tenantId, fbUserId]
  );
  if (ins.rows.length > 0) {
    console.log(`✅ [auth] tenant_user owner auto-creado (tenant ${tenantId}, fb ${fbUserId})`);
    return ins.rows[0];
  }
  // Carrera: otro request lo creó entre el SELECT y el INSERT
  const again = await db.query(
    'SELECT id, role, display_name, email, active FROM tenant_users WHERE tenant_id = $1 AND fb_user_id = $2',
    [tenantId, fbUserId]
  );
  return again.rows[0] || null;
}

/**
 * Verifica un JWT y devuelve su payload, o null si es inválido/expirado.
 */
function verifySession(token) {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (e) {
    return null;
  }
}

// =====================================================================
// POST /api/auth/facebook-login
// Body: { code }  (authorization code del Business Login con config_id)
// =====================================================================
router.post('/auth/facebook-login', async (req, res) => {
  const { code, redirect_uri } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'code requerido' });
  }
  if (!process.env.JWT_SECRET) {
    console.error('❌ [auth] JWT_SECRET no configurado');
    return res.status(503).json({ error: 'Servidor no configurado para login (falta JWT_SECRET)' });
  }

  try {
    // 1. Intercambiar el code por un access token (Business Login devuelve code)
    //    El redirect_uri debe coincidir con el usado en el diálogo OAuth.
    let tokenData;
    try {
      tokenData = await meta.exchangeLoginCodeForToken(code, redirect_uri);
    } catch (e) {
      const metaErr = e.response?.data?.error?.message || e.message;
      console.error('❌ [auth] Exchange code falló:', e.response?.data || e.message);
      return res.status(401).json({ error: 'No se pudo validar el login con Facebook', detail: metaErr });
    }
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(401).json({ error: 'Facebook no devolvió un token válido' });
    }

    // 2. Validar el token y obtener metadata (fb_user_id + WABAs)
    const debug = await meta.debugFacebookToken(accessToken);
    if (!debug.is_valid) {
      return res.status(401).json({ error: 'Token de Facebook inválido o expirado' });
    }
    if (String(debug.app_id) !== String(process.env.META_APP_ID)) {
      return res.status(401).json({ error: 'El token no pertenece a esta aplicación' });
    }
    const fbUserId = String(debug.user_id || '');
    if (!fbUserId) {
      return res.status(401).json({ error: 'No se pudo obtener el usuario de Facebook' });
    }

    // 3a. Buscar tenant por fb_user_id (logins siguientes)
    let tRes = await db.query(
      'SELECT id, slug, name, active, fb_user_id FROM tenants WHERE fb_user_id = $1',
      [fbUserId]
    );

    // 3b. Primer login: matchear por WABAs del usuario contra tenants.waba_id
    //     (resuelve la vinculación automática para tenants ya existentes, ej. SG Bolivia)
    const wabaIds = meta.extractWABAIdsFromDebug(debug); // v0.9.61: hoisted para diagnóstico
    if (tRes.rows.length === 0) {
      if (wabaIds.length > 0) {
        const match = await db.query(
          `SELECT id, slug, name, active, fb_user_id FROM tenants WHERE waba_id = ANY($1::text[]) LIMIT 1`,
          [wabaIds]
        );
        if (match.rows.length > 0) {
          // Vincular el fb_user_id al tenant encontrado (queda para próximos logins)
          await db.query('UPDATE tenants SET fb_user_id = $1 WHERE id = $2', [fbUserId, match.rows[0].id]);
          match.rows[0].fb_user_id = fbUserId;
          tRes = match;
          console.log(`✅ [auth] Vinculado fb_user ${fbUserId} → tenant ${match.rows[0].id} (primer login vía WABA)`);
        }
      }
    }

    // 3b-bis. v0.9.457: la misma búsqueda pero contra tenant_lines.waba_id.
    // Punto ciego real: una org puede tener sus números en una WABA distinta a
    // tenants.waba_id (líneas agregadas después, o el número principal migrado).
    // El dueño quedaba sin poder entrar con Facebook aunque la org fuera suya.
    if (tRes.rows.length === 0 && wabaIds.length > 0) {
      try {
        const match = await db.query(
          `SELECT t.id, t.slug, t.name, t.active, t.fb_user_id
           FROM tenants t JOIN tenant_lines l ON l.tenant_id = t.id
           WHERE l.waba_id = ANY($1::text[]) AND t.active = TRUE
           ORDER BY (t.fb_user_id IS NULL) DESC, t.id DESC LIMIT 1`,
          [wabaIds]
        );
        if (match.rows.length > 0) {
          if (!match.rows[0].fb_user_id) {
            await db.query('UPDATE tenants SET fb_user_id = $1 WHERE id = $2', [fbUserId, match.rows[0].id]);
            match.rows[0].fb_user_id = fbUserId;
          }
          tRes = match;
          console.log(`✅ [auth] Vinculado fb_user ${fbUserId} → tenant ${match.rows[0].id} (primer login vía WABA de LÍNEA)`);
        }
      } catch (e) {
        console.warn('⚠️ [auth] match por tenant_lines.waba_id no disponible:', e.message);
      }
    }

    // 3c. v0.9.62: probe por Graph. Los granular_scopes del token de login
    //     pueden venir SIN target_ids (depende de la config de login de Meta),
    //     dejando el fallback 3b ciego. Pero con whatsapp_business_management
    //     concedido, Graph solo deja LEER una WABA si el usuario tiene rol
    //     sobre ella → probamos las WABAs de los tenants: si puede leerla,
    //     es su organización. Prioriza tenants sin dueño vinculado y más nuevos
    //     (el caso típico: owner recién onboardeado entrando por primera vez).
    if (tRes.rows.length === 0) {
      // v0.9.457: el probe ahora también considera las WABAs de las LÍNEAS
      // (UNION), no solo tenants.waba_id — mismo punto ciego que 3b-bis.
      let cand;
      try {
        cand = await db.query(
          `SELECT DISTINCT ON (id) id, slug, name, active, fb_user_id, waba_id FROM (
             SELECT id, slug, name, active, fb_user_id, waba_id FROM tenants
              WHERE waba_id IS NOT NULL AND active = TRUE
             UNION
             SELECT t.id, t.slug, t.name, t.active, t.fb_user_id, l.waba_id FROM tenants t
               JOIN tenant_lines l ON l.tenant_id = t.id
              WHERE l.waba_id IS NOT NULL AND t.active = TRUE
           ) q
           ORDER BY id, (fb_user_id IS NULL) DESC`
        );
        cand.rows.sort((a, b) => (a.fb_user_id === null) === (b.fb_user_id === null) ? b.id - a.id : (a.fb_user_id === null ? -1 : 1));
        cand.rows = cand.rows.slice(0, 25);
      } catch (e) {
        cand = await db.query(
          `SELECT id, slug, name, active, fb_user_id, waba_id FROM tenants
           WHERE waba_id IS NOT NULL AND active = TRUE
           ORDER BY (fb_user_id IS NULL) DESC, id DESC
           LIMIT 25`
        );
      }
      for (const t of cand.rows) {
        if (await meta.canAccessWABA(t.waba_id, accessToken)) {
          if (!t.fb_user_id) {
            // Solo reclama la org si todavía no tiene dueño vinculado
            await db.query('UPDATE tenants SET fb_user_id = $1 WHERE id = $2', [fbUserId, t.id]);
            t.fb_user_id = fbUserId;
          }
          tRes = { rows: [t] };
          console.log(`✅ [auth] Vinculado fb_user ${fbUserId} → tenant ${t.id} (${t.slug}) vía probe de WABA ${t.waba_id}`);
          break;
        }
      }
    }

    if (tRes.rows.length === 0) {
      // v0.9.61: diagnóstico — sin esto el NO_TENANT es una caja negra.
      // Si "wabas del token" sale vacío Y el probe no matcheó, el usuario que
      // está logueando no tiene rol sobre ninguna WABA conectada (¿cuenta
      // equivocada?) o falta whatsapp_business_management en la config de login.
      // v0.9.457: sumamos las WABAs que la base conoce, para poder comparar de
      // un vistazo contra las del token sin abrir psql.
      let knownWabas = [];
      try {
        const kw = await db.query(
          `SELECT DISTINCT w FROM (
             SELECT waba_id AS w FROM tenants WHERE waba_id IS NOT NULL AND active = TRUE
             UNION SELECT l.waba_id FROM tenant_lines l JOIN tenants t ON t.id = l.tenant_id
              WHERE l.waba_id IS NOT NULL AND t.active = TRUE) q`
        );
        knownWabas = kw.rows.map(r => r.w);
      } catch (e) { /* noop */ }
      console.warn(
        `⚠️ [auth/fb-login] NO_TENANT: fb_user=${fbUserId} | wabas del token=[${wabaIds.join(', ') || 'NINGUNA'}] | ` +
        `wabas conocidas=[${knownWabas.join(', ') || 'NINGUNA'}] | ` +
        `granular_scopes=${JSON.stringify((debug.granular_scopes || []).map(s => s.scope))} | probe de WABAs: sin match | ` +
        `Fix: ¿cuenta FB correcta? ¿whatsapp_business_management en la config de login? O PATCH /admin/tenants/:id {fb_user_id}`
      );
      return res.status(403).json({
        error: 'Tu cuenta de Facebook todavía no está vinculada a ningún negocio. Conectá tu WhatsApp Business primero en el onboarding.',
        code: 'NO_TENANT',
        fb_user_id: fbUserId,
      });
    }

    const tenant = tRes.rows[0];

    // 4. Verificar que el tenant esté activo
    if (!tenant.active) {
      return res.status(403).json({ error: 'Tu cuenta está suspendida. Contactá a soporte.', code: 'SUSPENDED' });
    }

    // 5. v0.9.12: auto-provisionar el tenant_user OWNER (si la tabla existe)
    let ownerUser = null;
    try {
      ownerUser = await upsertOwnerUser(tenant.id, fbUserId);
      if (ownerUser && ownerUser.active === false) {
        return res.status(403).json({ error: 'Tu usuario está desactivado en esta organización.', code: 'USER_INACTIVE' });
      }
      if (ownerUser) {
        await db.query('UPDATE tenant_users SET last_login_at = NOW() WHERE id = $1', [ownerUser.id]);
      }
    } catch (e) {
      // Tabla aún no migrada → login sigue funcionando como antes (rol owner implícito)
      console.warn('⚠️ [auth] tenant_users no disponible (¿falta migración v0.9.12?):', e.message);
    }

    // 6. Emitir sesión JWT
    const sessionToken = issueSession(tenant, ownerUser);
    res.json({
      ok: true,
      session_token: sessionToken,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: ownerUser ? { id: ownerUser.id, role: ownerUser.role, name: ownerUser.display_name } : null,
    });
  } catch (e) {
    console.error('❌ [auth/facebook-login] error:', e.response?.data || e.message);
    res.status(500).json({ error: 'No se pudo completar el login', detail: e.message });
  }
});

// =====================================================================
// POST /api/auth/login — v0.9.12: ingreso diario con email + password
// Body: { email, password }
// El email es único GLOBAL → no hace falta indicar la organización.
// =====================================================================
router.post('/auth/login', async (req, res) => {
  // v0.9.47: máx 10 intentos/15min por IP + 15 por email (IPs rotativas)
  const ip = clientIp(req);
  if (!rateLimitOk('login:' + ip, 10, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá 15 minutos.' });
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!email || !password) {
    return res.status(400).json({ error: 'email y password requeridos' });
  }
  if (!rateLimitOk('login-email:' + email, 15, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos para este email. Esperá 15 minutos.' });
  }
  if (!process.env.JWT_SECRET) {
    return res.status(503).json({ error: 'Servidor no configurado para login (falta JWT_SECRET)' });
  }
  try {
    const r = await db.query(
      `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.display_name, u.role, u.active,
              t.slug, t.name AS tenant_name, t.active AS tenant_active, t.fb_user_id
       FROM tenant_users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE LOWER(u.email) = $1
       LIMIT 1`,
      [email]
    );
    // Mensaje genérico SIEMPRE (no revelar si el email existe)
    const fail = () => res.status(401).json({ error: 'Email o contraseña incorrectos' });
    if (r.rows.length === 0) return fail();
    const u = r.rows[0];
    if (!u.password_hash) return fail();
    const okPass = await bcrypt.compare(password, u.password_hash);
    if (!okPass) return fail();
    if (!u.active) return res.status(403).json({ error: 'Tu usuario está desactivado. Hablá con el dueño de tu organización.', code: 'USER_INACTIVE' });
    if (!u.tenant_active) return res.status(403).json({ error: 'La organización está suspendida. Contactá a soporte.', code: 'SUSPENDED' });

    await db.query('UPDATE tenant_users SET last_login_at = NOW() WHERE id = $1', [u.id]);

    const tenant = { id: u.tenant_id, slug: u.slug, name: u.tenant_name, fb_user_id: u.fb_user_id };
    const sessionToken = issueSession(tenant, u, { remember: !!req.body.remember }); // v0.9.434 — checkbox "mantener sesión"
    res.json({
      ok: true,
      session_token: sessionToken,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: { id: u.id, role: u.role, name: u.display_name || u.email, email: u.email },
    });
  } catch (e) {
    console.error('❌ [auth/login] error:', e.message);
    res.status(500).json({ error: 'No se pudo completar el login' });
  }
});

// =====================================================================
// POST /api/auth/register — v0.9.12: auto-registro con código de organización
// Body: { invite_code, email, password, display_name }
// Crea SIEMPRE rol agent (nunca owner/supervisor por código). Auto-login.
// =====================================================================
router.post('/auth/register', async (req, res) => {
  const inviteCode = String(req.body.invite_code || '').trim().toLowerCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const displayName = String(req.body.display_name || '').trim();
  if (!inviteCode || !email || !password || !displayName) {
    return res.status(400).json({ error: 'invite_code, email, password y display_name son requeridos' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Email inválido' });
  }
  if (password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `La contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres` });
  }
  try {
    const t = await db.query(
      'SELECT id, slug, name, active, fb_user_id FROM tenants WHERE invite_code = $1 LIMIT 1',
      [inviteCode]
    );
    if (t.rows.length === 0) {
      return res.status(404).json({ error: 'Código de organización inválido' });
    }
    const tenant = t.rows[0];
    if (!tenant.active) {
      return res.status(403).json({ error: 'La organización está suspendida.', code: 'SUSPENDED' });
    }

    const dupe = await db.query('SELECT id FROM tenant_users WHERE LOWER(email) = $1', [email]);
    if (dupe.rows.length > 0) {
      return res.status(409).json({ error: 'Ese email ya está registrado. Iniciá sesión.' });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const ins = await db.query(
      `INSERT INTO tenant_users (tenant_id, email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, 'agent')
       RETURNING id, role, display_name, email`,
      [tenant.id, email, hash, displayName]
    );
    const u = ins.rows[0];
    console.log(`✅ [auth] agente registrado: ${email} → tenant ${tenant.id} (${tenant.slug})`);

    const sessionToken = issueSession(tenant, u);
    res.status(201).json({
      ok: true,
      session_token: sessionToken,
      tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name },
      user: { id: u.id, role: u.role, name: u.display_name, email: u.email },
    });
  } catch (e) {
    // UNIQUE index puede saltar en carrera → 409 amigable
    if (String(e.message).includes('idx_tenant_users_email')) {
      return res.status(409).json({ error: 'Ese email ya está registrado. Iniciá sesión.' });
    }
    console.error('❌ [auth/register] error:', e.message);
    res.status(500).json({ error: 'No se pudo completar el registro' });
  }
});

// =====================================================================
// GET /api/auth/me — devuelve el tenant de la sesión actual (valida JWT)
// =====================================================================
router.get('/auth/me', async (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const payload = verifySession(token);
  if (!payload) return res.status(401).json({ error: 'Sesión inválida o expirada' });

  try {
    const r = await db.query('SELECT id, slug, name, active FROM tenants WHERE id = $1', [payload.tenant_id]);
    if (r.rows.length === 0 || !r.rows[0].active) {
      return res.status(401).json({ error: 'Cuenta no encontrada o inactiva' });
    }
    // v0.9.12: devolver también el usuario (rol fresco desde la DB, no del JWT)
    let user = null;
    if (payload.user_id) {
      try {
        const ur = await db.query(
          'SELECT id, email, display_name, role, active FROM tenant_users WHERE id = $1 AND tenant_id = $2',
          [payload.user_id, payload.tenant_id]
        );
        if (ur.rows.length > 0) {
          if (!ur.rows[0].active) return res.status(403).json({ error: 'Usuario desactivado', code: 'USER_INACTIVE' });
          const u = ur.rows[0];
          user = { id: u.id, email: u.email, name: u.display_name || u.email, role: u.role };
        }
      } catch (e) { /* tabla no migrada aún */ }
    }
    if (!user) user = { id: null, email: null, name: null, role: payload.role || 'owner' };
    res.json({ ok: true, tenant: r.rows[0], user });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =====================================================================
// Middleware: requireTenantSession
// Acepta: (a) JWT de tenant (Authorization: Bearer), o
//         (b) el ADMIN_TOKEN global (super-admin) vía X-Admin-Token o ?token.
// Setea req.tenantId y req.isSuperAdmin para uso downstream.
// =====================================================================
// v0.9.67 (auditoría 12-jun): comparación en tiempo constante (hash de largo
// fijo, mismo patrón C-2 de v0.9.44 — este middleware había quedado afuera
// y es el MÁS usado del sistema).
function timingSafeEq(a, b) {
  if (!a || !b) return false;
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function requireTenantSession(req, res, next) {
  // Opción b: super-admin con ADMIN_TOKEN
  const adminToken = req.headers['x-admin-token'] || req.query.token;
  if (adminToken && timingSafeEq(adminToken, process.env.ADMIN_TOKEN)) {
    req.isSuperAdmin = true;
    req.tenantId = null; // super-admin no está atado a un tenant
    req.userId = null;
    req.userRole = 'superadmin';
    return next();
  }
  // Opción a: JWT de tenant
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (token) {
    const payload = verifySession(token);
    if (payload && payload.tenant_id) {
      req.isSuperAdmin = false;
      req.tenantId = payload.tenant_id;
      // v0.9.12: identidad del usuario dentro del tenant.
      // JWTs legacy (sin user_id/role) = owner (antes solo el dueño podía loguear).
      req.userId = payload.user_id || null;
      req.userRole = payload.role || 'owner';
      req.userName = payload.name || null;
      return next();
    }
  }
  return res.status(401).json({ error: 'No autenticado' });
}

// =====================================================================
// v0.9.12 — Middleware de autorización por rol. Usar DESPUÉS de
// requireTenantSession. El super-admin pasa siempre.
//   router.post('/admin/users', requireTenantSession, requireRole('owner'), ...)
// =====================================================================
function requireRole(...roles) {
  return (req, res, next) => {
    if (req.isSuperAdmin) return next();
    if (roles.includes(req.userRole)) return next();
    return res.status(403).json({
      error: 'No tenés permisos para esta acción',
      code: 'FORBIDDEN_ROLE',
      required: roles,
      your_role: req.userRole || null,
    });
  };
}

// =====================================================================
// GET /api/auth/config — config pública para el login con Facebook del panel
// (solo el app_id + graph_version; no expone secretos)
// =====================================================================
router.get('/auth/config', (req, res) => {
  const appId = process.env.META_APP_ID;
  // v0.9.457: decir QUÉ falta. Antes, cualquiera de estas tres causas pintaba
  // el mismo "El login no está disponible" en el panel y había que adivinar.
  const missing = [];
  if (!appId) missing.push('META_APP_ID');
  if (!process.env.META_LOGIN_CONFIG_ID) missing.push('META_LOGIN_CONFIG_ID');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!appId) {
    console.error(`❌ [auth/config] login deshabilitado — falta: ${missing.join(', ')}`);
    return res.status(503).json({ error: 'Login no configurado (falta META_APP_ID)', code: 'NO_APP_ID', missing });
  }
  if (missing.length) {
    console.warn(`⚠️ [auth/config] login con Facebook deshabilitado — falta configurar: ${missing.join(', ')}`);
  }
  res.json({
    app_id: appId,
    graph_version: process.env.META_GRAPH_VERSION || 'v25.0',
    login_config_id: process.env.META_LOGIN_CONFIG_ID || null,
    login_enabled: !!process.env.JWT_SECRET && !!process.env.META_LOGIN_CONFIG_ID,
    missing: missing.length ? missing : undefined,
  });
});

// v0.9.69: rateLimitOk/clientIp exportados para la superficie pública (onboarding, /r/:code)
module.exports = { router, verifySession, requireTenantSession, requireRole, issueSession, rateLimitOk, clientIp };
