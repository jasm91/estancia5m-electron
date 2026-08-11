/**
 * onboarding.js — v0.9.60
 *
 * Rutas para Meta Embedded Signup. Permite que un cliente nuevo conecte su
 * WhatsApp Business a Sg Sales sin intervención técnica manual.
 *
 * Flujo:
 *   1. Frontend (landing) dispara el JS SDK de Meta con el Config ID
 *   2. Usuario autoriza → Meta devuelve un `code` + datos del WABA/phone
 *   3. Frontend hace POST /api/onboarding/exchange-code con esos datos
 *   4. Este módulo:
 *      a. Exchange code → access_token
 *      b. Valida que el número pertenece a la WABA autorizada (anti-spoof)
 *      c. Crea tenant nuevo + su LÍNEA default (tenant_lines) en una transacción
 *      d. Suscribe el WABA al webhook
 *      e. Devuelve la URL del panel (login con Facebook)
 *
 * v0.9.60 — FIX 500 "Error interno en onboarding":
 *   - El INSERT no incluía `r2_prefix` (NOT NULL sin default) → violación de
 *     constraint en TODO onboarding público. Ahora se setea `tenants/<slug>`.
 *   - Se crea también la línea en `tenant_lines` (sistema multi-línea v0.9.13);
 *     antes el tenant quedaba solo con la columna legacy.
 *   - Dup-check contra tenant_lines + tenants (antes solo tenants → un número
 *     ya conectado como línea hubiera explotado por UNIQUE más adelante).
 *   - Anti-spoof: el número debe pertenecer a la WABA del token (como add-line).
 *   - La respuesta ya no devuelve el token sgv_ (?token= solo funciona en modo
 *     audit desde v0.9.12); ahora apunta al login del panel con Facebook.
 *
 * SEGURIDAD: el access_token del cliente se guarda ENCRIPTADO (crypto.js AES-256-GCM).
 * Requiere ENCRYPTION_KEY en env.
 */

const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const router = express.Router();

const db = require('./db');
const meta = require('./meta');
const { encrypt } = require('./crypto');
const { invalidatePhoneNumberIdCache } = require('./tenant-resolver');

// URL del panel del cliente (login email+password o Continuar con Facebook)
const PANEL_URL = process.env.PANEL_BASE_URL || 'https://app.sg-ventas.com/panel/';

/**
 * Genera un token de acceso al panel para el tenant nuevo.
 * Formato: sgv_<32 hex chars>. Devuelve { plain, hash, hint }.
 */
async function generateTenantToken() {
  const plain = 'sgv_' + crypto.randomBytes(24).toString('hex');
  const hash = await bcrypt.hash(plain, 10);
  const hint = plain.substring(0, 8);
  return { plain, hash, hint };
}

/**
 * Genera un slug único a partir del nombre del negocio.
 */
function slugify(name) {
  const base = (name || 'cliente')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quitar acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  // sufijo aleatorio corto para garantizar unicidad
  return `${base}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * POST /api/onboarding/exchange-code
 *
 * Body esperado (del frontend Embedded Signup):
 *   {
 *     code: "...",              // code del flow JS
 *     waba_id: "...",           // del evento WA_EMBEDDED_SIGNUP
 *     phone_number_id: "...",   // del evento
 *     business_name: "...",     // opcional, nombre del negocio
 *     business_portfolio_id: "..." // opcional
 *   }
 *
 * NO requiere admin token (es un flujo público de onboarding).
 * Pero valida que el code sea canjeable por Meta (eso autentica el request).
 */
router.post('/onboarding/exchange-code', async (req, res) => {
  const { code, waba_id, phone_number_id, business_name, business_portfolio_id, coexistence, ref } = req.body;
  // v0.9.220 — TRACE de onboarding: 1ra miga, apenas entra el request (con/sin datos).
  console.log(`▶ [onboarding] exchange-code IN · waba=${waba_id || '—'} phone=${phone_number_id || '—'} business="${business_name || '—'}" portfolio=${business_portfolio_id || '—'} coexistence=${!!coexistence} code=${code ? 'sí(' + String(code).length + 'ch)' : 'NO'}`);

  // v0.9.69 (auditoría 12-jun P1#11): rate limit — endpoint público sin auth
  // que dispara queries + llamadas a Meta por intento.
  const { rateLimitOk, clientIp } = require('./auth');
  if (!rateLimitOk('onboard:' + clientIp(req), 5, 60 * 1000)) {
    return res.status(429).json({ error: 'Demasiados intentos. Esperá un minuto y reintentá.' });
  }

  if (!code) {
    return res.status(400).json({ error: 'code es requerido' });
  }
  if (!waba_id || !phone_number_id) {
    return res.status(400).json({ error: 'waba_id y phone_number_id son requeridos (no llegó el evento WA_EMBEDDED_SIGNUP; reintentá)' });
  }

  try {
    // 1. Verificar que ENCRYPTION_KEY existe antes de hacer nada
    if (!process.env.ENCRYPTION_KEY) {
      console.error('❌ ENCRYPTION_KEY no configurada — no se puede onboardear');
      return res.status(503).json({ error: 'Servidor no configurado para onboarding (falta ENCRYPTION_KEY)' });
    }

    // 2. v0.9.60: duplicados en tenant_lines (multi-línea) O en tenants (legacy)
    const existing = await db.query(
      `SELECT tenant_id AS tid FROM tenant_lines WHERE meta_phone_number_id = $1
       UNION SELECT id AS tid FROM tenants WHERE meta_phone_number_id = $1`,
      [String(phone_number_id)]
    );
    if (existing.rows.length > 0) {
      console.warn(`⛔ [onboarding] phone ${phone_number_id} YA conectado al tenant ${existing.rows[0].tid} → 409 (no se crea de nuevo)`);
      return res.status(409).json({
        error: 'Este número de WhatsApp ya está conectado a una organización',
      });
    }

    // v0.9.110: registrar el intento (best-effort). Permite monitorear prospectos
    // que empiezan pero no terminan. Si la tabla no está migrada, no bloquea.
    try {
      await db.query(
        `INSERT INTO onboarding_attempts (phone_number_id, waba_id, business_name, coexistence, status, updated_at)
         VALUES ($1, $2, $3, $4, 'started', NOW())
         ON CONFLICT (phone_number_id) DO UPDATE SET
           waba_id = EXCLUDED.waba_id,
           business_name = COALESCE(EXCLUDED.business_name, onboarding_attempts.business_name),
           coexistence = EXCLUDED.coexistence,
           status = 'started', error = NULL, updated_at = NOW()`,
        [String(phone_number_id), String(waba_id), business_name || null, !!coexistence]
      );
    } catch (e) { /* tabla no migrada -> no bloquea el onboarding */ }

    // 3. Exchange code → access_token
    console.log(`▶ [onboarding] Exchange code para waba=${waba_id} phone=${phone_number_id}${coexistence ? ' (coexistence)' : ''}`);
    let tokenData;
    try {
      tokenData = await meta.exchangeCodeForToken(code);
    } catch (e) {
      const _d = e.response?.data?.error?.message || e.message;
      console.error('❌ [onboarding] Exchange falló:', e.response?.data || e.message);
      await db.query(`UPDATE onboarding_attempts SET status='failed', error=$1, updated_at=NOW() WHERE phone_number_id=$2 AND status<>'completed'`, [('exchange: ' + _d).slice(0, 500), String(phone_number_id)]).catch(() => {});
      return res.status(400).json({
        error: 'No se pudo intercambiar el código con Meta',
        detail: _d,
      });
    }
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'Meta no devolvió token' });
    }
    const expiresIn = tokenData.expires_in; // segundos, puede ser undefined para tokens long-lived

    // v0.9.8: obtener el fb_user_id del usuario que conecta (para el login posterior al panel)
    let fbUserId = null;
    try {
      const debug = await meta.debugFacebookToken(accessToken);
      fbUserId = debug?.user_id ? String(debug.user_id) : null;
      if (fbUserId) console.log(`▶ [onboarding] fb_user_id del cliente: ${fbUserId}`);
    } catch (e) {
      console.warn('⚠️  [onboarding] No se pudo obtener fb_user_id (no bloqueante):', e.message);
    }

    // 4. v0.9.60: anti-spoof — el número DEBE pertenecer a la WABA del token
    //    (mismo criterio que /admin/lines/connect-facebook). De paso sacamos
    //    display phone y verified name.
    let phoneDisplay = null;
    let verifiedName = null;
    try {
      const phones = await meta.getPhoneNumbers(waba_id, accessToken);
      const match = phones.find(p => String(p.id) === String(phone_number_id));
      if (!match) {
        return res.status(403).json({ error: 'El número no pertenece a la cuenta de WhatsApp Business autorizada' });
      }
      phoneDisplay = match.display_phone_number || null;
      verifiedName = match.verified_name || null;
    } catch (e) {
      const _d = e.response?.data?.error?.message || e.message;
      console.error('❌ [onboarding] getPhoneNumbers falló:', e.response?.data || e.message);
      await db.query(`UPDATE onboarding_attempts SET status='failed', error=$1, updated_at=NOW() WHERE phone_number_id=$2 AND status<>'completed'`, [('verify número: ' + _d).slice(0, 500), String(phone_number_id)]).catch(() => {});
      return res.status(400).json({
        error: 'No se pudo verificar el número con Meta',
        detail: _d,
      });
    }

    // 5. Suscribir el WABA al webhook (para recibir mensajes)
    let webhookSubscribed = false;
    try {
      await meta.subscribeWABA(waba_id, accessToken);
      webhookSubscribed = true;
      console.log(`✅ [onboarding] WABA ${waba_id} suscrito al webhook`);
    } catch (e) {
      console.warn('⚠️  [onboarding] No se pudo suscribir WABA:', e.response?.data?.error?.message || e.message);
      // No fail: el cliente puede suscribir manualmente después
    }

    // 6. Crear tenant + línea default en UNA transacción (v0.9.60)
    const { hash, hint } = await generateTenantToken();
    const name = business_name || verifiedName || `Cliente ${phoneDisplay || phone_number_id}`;
    const slug = slugify(business_name || verifiedName);
    const tokenEnc = encrypt(accessToken);
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;

    // v0.9.79: el tenant nuevo hereda los precios base GLOBALES (platform_pricing).
    // Se lee FUERA de la transacción a propósito: si la tabla aún no existe
    // (migración sin correr), el error no aborta el BEGIN y caemos a 25/15/149.
    let baseLine = 290, baseUser = 120, baseSetup = 490;
    try {
      const pc = await db.query(
        `SELECT default_price_per_line, default_price_per_user, default_setup_fee
           FROM platform_pricing WHERE id = 1`);
      if (pc.rows.length) {
        baseLine = Number(pc.rows[0].default_price_per_line);
        baseUser = Number(pc.rows[0].default_price_per_user);
        baseSetup = Number(pc.rows[0].default_setup_fee);
      }
    } catch (_) { /* platform_pricing no creada todavía → defaults hardcodeados */ }

    // v0.9.274 — REFERIDOS: código propio del nuevo tenant + resolución del referidor (si vino ?ref=).
    const referralCode = 'SG-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    let referredBy = null;
    if (ref) {
      try {
        const rr = await db.query(`SELECT id FROM tenants WHERE referral_code = $1 LIMIT 1`, [String(ref).trim().toUpperCase()]);
        if (rr.rows[0]) referredBy = rr.rows[0].id;
      } catch (e) { console.warn('[onboarding] resolver referido:', e.message); }
    }

    const client = await db.getClient();
    let tenant, line;
    try {
      await client.query('BEGIN');

      const insertResult = await client.query(`
        INSERT INTO tenants (
          slug, name, token_hash, token_lookup_hint,
          active, plan, billing_status,
          r2_prefix,
          meta_phone_number_id, waba_id, phone_display,
          meta_token_enc, meta_access_token_expires_at,
          meta_business_portfolio_id, meta_onboarding_completed_at,
          webhook_subscribed, fb_user_id,
          price_per_line, price_per_user, setup_fee,
          trial_ends_at,
          referral_code, referred_by_tenant_id
        ) VALUES (
          $1, $2, $3, $4,
          TRUE, 'inicial', 'trial',
          $5,
          $6, $7, $8,
          $9, $10,
          $11, NOW(),
          $12, $13,
          $14, $15, $16,
          NOW() + INTERVAL '7 days',
          $17, $18
        )
        RETURNING id, slug, name
      `, [
        slug, name, hash, hint,
        `tenants/${slug}`, // ← FIX v0.9.60: r2_prefix es NOT NULL sin default (causaba el 500)
        String(phone_number_id), String(waba_id), phoneDisplay,
        tokenEnc, expiresAt,
        business_portfolio_id || null,
        webhookSubscribed, fbUserId,
        baseLine, baseUser, baseSetup,
        referralCode, referredBy,
      ]);
      tenant = insertResult.rows[0];

      // Línea default en tenant_lines (sistema multi-línea v0.9.13)
      const lineResult = await client.query(`
        INSERT INTO tenant_lines (tenant_id, meta_phone_number_id, display_phone, label, waba_id, meta_token_enc, is_default)
        VALUES ($1, $2, $3, $4, $5, $6, TRUE)
        RETURNING id, meta_phone_number_id, display_phone, label
      `, [
        tenant.id, String(phone_number_id), phoneDisplay,
        verifiedName || phoneDisplay || 'Principal',
        String(waba_id), tokenEnc,
      ]);
      line = lineResult.rows[0];

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    invalidatePhoneNumberIdCache(String(phone_number_id));
    console.log(`✅ [onboarding] Tenant creado: [${tenant.id}] ${tenant.name} (${tenant.slug}) — línea ${line.id} (${phoneDisplay || phone_number_id})${coexistence ? ' [coexistence]' : ''}`);

    // v0.9.527 — El push "mensaje nuevo en chat asignado" NACE DESHABILITADO para los
    // tenants nuevos (push_roles vacío). Así el dueño no recibe una notificación por cada
    // conversación desde el día uno; puede activarlo cuando quiera en Config → Notificaciones.
    // Best-effort fuera de la transacción: si falla, no corta el alta.
    try {
      await db.query(
        `INSERT INTO notification_prefs (tenant_id, prefs, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (tenant_id) DO NOTHING`,
        [tenant.id, JSON.stringify({ new_message_assigned: { push_roles: [], whatsapp: false } })]);
    } catch (e) { console.warn('[onboarding] seed notification_prefs:', e.message); }

    // v0.9.274 — REFERIDOS: si vino con un código válido, registrar el crédito 'pending' (se libera a
    // 'earned' cuando este tenant complete su trial y pase a pago). Sin auto-referencia. Fuera de la
    // transacción → un fallo acá no tira abajo el alta.
    if (referredBy && referredBy !== tenant.id) {
      try {
        await db.query(
          `INSERT INTO referral_credits (referrer_tenant_id, referred_tenant_id, status)
           VALUES ($1, $2, 'pending') ON CONFLICT (referred_tenant_id) DO NOTHING`,
          [referredBy, tenant.id]);
        console.log(`🎁 [onboarding] referido: tenant ${tenant.id} lo refirió ${referredBy} (crédito pending)`);
      } catch (e) { console.warn('[onboarding] referral_credit:', e.message); }
    }

    // 6a-bis. v0.9.65: pre-cargar los prompts default por modo, así el dueño
    // solo tiene que ACTIVAR el suyo (y el bot nunca hereda nada de otra org).
    // Best-effort fuera de la transacción (si la tabla no está migrada, no
    // bloquea el onboarding — el builder cae al prompt NEUTRO).
    try {
      const defaults = require('./default-mode-prompts');
      // v0.9.70: + rubros de primera clase (salud/belleza/restaurante)
      for (const [mode, content] of [['articulos', defaults.ARTICULOS], ['inmuebles', defaults.INMUEBLES], ['servicios', defaults.SERVICIOS], ['arquitectura', defaults.ARQUITECTURA], ['salud', defaults.SALUD], ['belleza', defaults.BELLEZA], ['restaurante', defaults.RESTAURANTE], ['vehiculos', defaults.VEHICULOS]]) {
        await db.query(
          `INSERT INTO tenant_mode_prompts (tenant_id, mode, content) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, mode, COALESCE(line_id, 0)) DO NOTHING`,
          [tenant.id, mode, content]
        );
      }
      console.log(`✅ [onboarding] Prompts default pre-cargados para tenant ${tenant.id} (articulos/inmuebles/servicios)`);
    } catch (e) {
      console.warn('⚠️  [onboarding] No se pudieron pre-cargar prompts de modo (no bloqueante):', e.message);
    }

    // 6b. v0.9.63: REGISTRAR el número en Cloud API. El Embedded Signup conecta
    //     el número pero NO lo registra — sin este paso queda "Pendiente" en el
    //     WhatsApp Manager y no puede enviar/recibir. Solo para números Cloud
    //     API puros (coexistence ya viene registrado por la app del dueño).
    //     El PIN queda como verificación en dos pasos del número → se guarda
    //     cifrado en tenant_lines.pin_enc para poder re-registrar.
    let registered = false;
    if (!coexistence) {
      try {
        const pin = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        await meta.registerPhoneNumber(String(phone_number_id), accessToken, pin);
        await db.query(`UPDATE tenant_lines SET pin_enc = $1 WHERE id = $2`, [encrypt(pin), line.id]);
        registered = true;
        console.log(`✅ [onboarding] Número ${phoneDisplay || phone_number_id} REGISTRADO en Cloud API`);
      } catch (e) {
        const detail = e.response?.data?.error?.message || e.message;
        // No bloquea el onboarding: se puede registrar después con
        // POST /api/admin/lines/:id/register (típico: el número ya tenía
        // PIN de dos pasos propio → hay que pasarlo o resetearlo en Meta).
        console.warn(`⚠️  [onboarding] No se pudo registrar el número (no bloqueante): ${detail}`);
      }
    }

    // 6c. v0.9.225 — COEXISTENCE: PEDIRLE a Meta el HISTORIAL (no lo manda solo).
    //     POST /{phone_number_id}/smb_app_data sync_type=history (+ contactos). Sin
    //     este pedido el webhook 'history' nunca llega aunque el field esté suscrito.
    //     (Causa raíz del "history nunca llega" — antes solo suscribíamos el field.)
    if (coexistence) {
      try {
        const _sync = await meta.requestCoexistenceSync(String(phone_number_id), accessToken);
        console.log(`🕓 [onboarding] Sync de coexistence SOLICITADO (history + contactos) para phone ${phone_number_id} — Meta debería mandar el webhook 'history' en los próximos minutos. contactos=${_sync.contacts?.error ? 'falló: ' + _sync.contacts.error : 'ok'}`);
      } catch (e) {
        const detail = e.response?.data?.error?.message || e.message;
        console.warn(`⚠️  [onboarding] No se pudo solicitar el sync de coexistence/history (no bloqueante): ${detail}`);
      }
    }

    // 7. Devolver al frontend la URL del panel. Desde v0.9.12 el acceso del
    //    cliente es por login (Continuar con Facebook = misma cuenta que recién
    //    usó, auto-provisiona al owner) — ya NO se entrega token por URL.
    // v0.9.110: marcar el intento como completado
    try {
      await db.query(
        `UPDATE onboarding_attempts SET status = 'completed', tenant_id = $1, phone_display = $2, updated_at = NOW() WHERE phone_number_id = $3`,
        [tenant.id, phoneDisplay || null, String(phone_number_id)]
      );
    } catch (e) {}

    res.json({
      ok: true,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        phone_display: phoneDisplay,
      },
      panel_url: PANEL_URL,
      login: 'facebook',
      webhook_subscribed: webhookSubscribed,
      registered, // v0.9.63: número registrado en Cloud API (false en coexistence)
    });

  } catch (err) {
    console.error('❌ [onboarding] Error inesperado:', err);
    // v0.9.110: marcar el intento como fallido (best-effort)
    try {
      await db.query(
        `UPDATE onboarding_attempts SET status = 'failed', error = $1, updated_at = NOW() WHERE phone_number_id = $2 AND status <> 'completed'`,
        [String(err.message || 'error').slice(0, 500), String(phone_number_id)]
      );
    } catch (e) {}
    res.status(500).json({ error: 'Error interno en onboarding', detail: err.message });
  }
});

/**
 * POST /api/onboarding/track  (v0.9.111 — funnel del Embedded Signup)
 */
// v0.9.125 — geo-IP best-effort (gratis, sin API key) para ubicar a los leads
// del funnel. NO bloquea la respuesta del track; actualiza la fila cuando vuelve.
async function lookupGeoAndStore(sessionId, ip) {
  if (!ip || ip === 'unknown') return;
  // saltar IPs privadas / loopback / link-local (no geolocalizables)
  if (/^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|fe80|f[cd])/i.test(ip)) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const resp = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: ctrl.signal });
    clearTimeout(t);
    const d = await resp.json().catch(() => null);
    if (!d || d.success === false) return;
    await db.query(
      `UPDATE onboarding_funnel SET geo_country = $2, geo_city = $3, geo_region = $4, geo_isp = $5 WHERE session_id = $1`,
      [sessionId, d.country || null, d.city || null, d.region || null, (d.connection && d.connection.isp) || null]
    );
  } catch (e) { /* best-effort: si falla el geo, la fila igual tiene la IP */ }
}

router.post('/onboarding/track', async (req, res) => {
  const { session_id, stage, waba_id, phone_number_id, coexistence, landing_url, referrer } = req.body || {};
  const { rateLimitOk, clientIp } = require('./auth');
  const ip = clientIp(req);
  if (!rateLimitOk('onbtrack:' + ip, 30, 60 * 1000)) return res.status(429).json({ ok: false });
  if (!session_id || !['launched', 'waba_selected', 'cancelled'].includes(String(stage || ''))) {
    return res.status(400).json({ ok: false });
  }
  const sid = String(session_id).slice(0, 80);
  // v0.9.125: metadata para identificar/contactar leads a medio camino.
  const ua = (String(req.headers['user-agent'] || '').slice(0, 400)) || null;
  const ref = (String(referrer || req.headers['referer'] || '').slice(0, 500)) || null;
  const lang = (String(req.headers['accept-language'] || '').slice(0, 120)) || null;
  const landing = (String(landing_url || '').slice(0, 500)) || null;
  try {
    await db.query(
      `INSERT INTO onboarding_funnel (session_id, stage, waba_id, phone_number_id, coexistence, ip, user_agent, referrer, lang, landing_url, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         stage = CASE WHEN onboarding_funnel.stage = 'waba_selected' AND EXCLUDED.stage = 'launched'
                      THEN onboarding_funnel.stage ELSE EXCLUDED.stage END,
         waba_id = COALESCE(EXCLUDED.waba_id, onboarding_funnel.waba_id),
         phone_number_id = COALESCE(EXCLUDED.phone_number_id, onboarding_funnel.phone_number_id),
         coexistence = EXCLUDED.coexistence OR onboarding_funnel.coexistence,
         ip = COALESCE(onboarding_funnel.ip, EXCLUDED.ip),
         user_agent = COALESCE(onboarding_funnel.user_agent, EXCLUDED.user_agent),
         referrer = COALESCE(onboarding_funnel.referrer, EXCLUDED.referrer),
         lang = COALESCE(onboarding_funnel.lang, EXCLUDED.lang),
         landing_url = COALESCE(onboarding_funnel.landing_url, EXCLUDED.landing_url),
         updated_at = NOW()`,
      [sid, String(stage), waba_id || null, phone_number_id || null, !!coexistence, ip || null, ua, ref, lang, landing]
    );
    res.json({ ok: true });
    // geo best-effort, una sola vez (al lanzar). No bloquea la respuesta.
    if (ip && String(stage) === 'launched') lookupGeoAndStore(sid, ip);
  } catch (e) {
    res.json({ ok: false });
  }
});

/**
 * GET /api/onboarding/config
 * Devuelve la config pública necesaria para el frontend (App ID + Config ID).
 * NO expone secretos.
 */
router.get('/onboarding/config', (req, res) => {
  const appId = process.env.META_APP_ID;
  const configId = process.env.META_CONFIG_ID || process.env.META_EMBEDDED_SIGNUP_CONFIG_ID;
  if (!appId || !configId) {
    return res.status(503).json({
      error: 'Onboarding no configurado',
      missing: {
        META_APP_ID: !appId,
        META_CONFIG_ID: !configId,
      },
    });
  }
  res.json({
    app_id: appId,
    config_id: configId,
    graph_version: process.env.META_GRAPH_VERSION || 'v25.0',
  });
});

module.exports = router;
