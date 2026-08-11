/**
 * software-sales.js — v0.9.528
 * ---------------------------------------------------------------------------
 * Aitana (modo software) vende el SISTEMA DE INVENTARIO, cobra por QR Baneco y
 * —al confirmarse el pago— crea la cuenta en el Inventario vía su API de
 * integración (POST /api/integration/provision-tenant, header X-CRM-Secret) y le
 * manda al cliente su usuario y contraseña por WhatsApp.
 *
 * Flujo:
 *   1) n8n llama POST /api/bot/software-sale con { tenant_id, phone, biz_name,
 *      admin_name, admin_email, plan } cuando Aitana ya juntó los datos.
 *   2) Se crea la venta (software_sales, 'pending'), se genera el QR y se le manda
 *      al cliente (imagen a WhatsApp).
 *   3) Baneco NO avisa cuando se paga → un worker (pollPendingSales) consulta el
 *      estado de los QR pendientes. Al pagarse: provisiona en el Inventario y manda
 *      el acceso.
 *
 * Env necesarias:
 *   INVENTARIO_BASE_URL              (default: la URL de Railway del Inventario)
 *   INVENTARIO_INTEGRATION_SECRET    (== INTEGRATION_SECRET del Inventario)
 *   (BANECO_* ya configuradas para el cobro por QR)
 */
const db = require('./db');
const baneco = require('./baneco');
const meta = require('./meta');
const r2 = require('./r2');

const PLANS = {
  prueba:   { label: 'Prueba 7 días', amount: 50,   meses: 0, dias: 7 }, // v0.9.530
  mes:      { label: 'Mensual',   amount: 350,  meses: 1 },
  semestre: { label: 'Semestral', amount: 2000, meses: 6 },
  anual:    { label: 'Anual',     amount: 3900, meses: 12 },
};

function _invUrl() { return String(process.env.INVENTARIO_BASE_URL || 'https://web-production-4eda3.up.railway.app').replace(/\/+$/, ''); }
function _invSecret() { return process.env.INVENTARIO_INTEGRATION_SECRET || process.env.INTEGRATION_SECRET || ''; }
function _emailOk(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '').trim()); }
function _normPlan(p) {
  const s = String(p || '').trim().toLowerCase();
  if (PLANS[s]) return s;
  if (/prueba|trial|demo|7\s*d[ií]a/.test(s)) return 'prueba';
  if (/sem|semestr/.test(s)) return 'semestre';   // antes que "mes" (semestral contiene "mes")
  if (/an[uú]al|anio|año/.test(s)) return 'anual';
  if (/mes|mensual/.test(s)) return 'mes';
  return null;
}
// v0.9.535 — Inventario NO conoce los plan_id de SG (p.ej. "intermedio"); espera sus propios
// códigos de PERÍODO: prueba | mes | semestre | anual. Traducimos el plan de SG al de Inventario
// antes de provisionar. Derivamos por el código/nombre del plan; si no se puede inferir, un plan
// pago se manda como 'mes' (mensual, el caso más común) y uno sin costo como 'prueba'.
function _toInvPlan(sale) {
  const byCode = _normPlan(sale && sale.plan);
  if (byCode) return byCode;
  if (Number(sale && sale.amount) === 0) return 'prueba';
  return 'mes';
}
function _norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }

// ── FUENTE ÚNICA DE PLANES: los planes VIVOS de Inventario ────────────────────
// v0.9.536 — Inventario es el DUEÑO del catálogo de planes (define precio y días de vigencia).
// SG los lee en vivo desde su API de integración (GET /api/integration/plans) para el modo de
// venta de software. Así lo que Aitana cotiza, el precio del QR y el código que se provisiona
// SIEMPRE coinciden con Inventario — sin catálogo paralelo ni traducción. Cache 5 min.
// Si Inventario no está configurado o no responde → devuelve null y se cae a bot_pricing_plans.
let _invPlansCache = { at: 0, plans: null };
async function getInvPlans() {
  if (!_invSecret()) return null;
  const now = Date.now();
  if (_invPlansCache.plans && (now - _invPlansCache.at) < 300000) return _invPlansCache.plans;
  try {
    const resp = await fetch(_invUrl() + '/api/integration/plans', { headers: { 'X-CRM-Secret': _invSecret() } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json().catch(() => null);
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.plans) ? data.plans : null);
    if (!list) throw new Error('respuesta sin lista de planes');
    const plans = list
      .filter(p => p && (p.active === undefined || p.active) && (p.public === undefined || p.public))
      .map(p => ({
        code: String(p.code || p.plan_id || p.id || '').trim(),
        name: String(p.name || p.display_name || p.code || '').trim(),
        price: Number(p.price != null ? p.price : (p.price_bs != null ? p.price_bs : p.monthly_bs)) || 0,
        days: Number(p.days || p.dias || 0) || null,
        description: String(p.description || p.target_description || '').trim(),
      }))
      .filter(p => p.code);
    _invPlansCache = { at: now, plans };
    return plans;
  } catch (e) {
    console.warn('[software-sale] getInvPlans falló, uso catálogo local:', e.message);
    return null; // fuerza fallback a bot_pricing_plans (red de seguridad)
  }
}
// Match tolerante de un input contra una lista [{code, name, amount, days}].
function _matchPlan(rows, input) {
  const key = _norm(input);
  if (!key || !rows || !rows.length) return null;
  const mk = (r) => { const a = Number(r.amount); return (Number.isFinite(a) && a >= 0) ? { code: r.code, label: r.name, amount: a, days: r.days } : null; };
  for (const r of rows) if (_norm(r.code) === key || _norm(r.name) === key) { const m = mk(r); if (m) return m; }
  const generic = _normPlan(input);
  for (const r of rows) {
    const dn = _norm(r.name);
    if ((dn.length >= 4 && key.includes(dn)) || (generic && (_norm(r.code) === generic || _normPlan(r.name) === generic))) { const m = mk(r); if (m) return m; }
  }
  return null;
}
// Bloque de planes para el prompt (lo que Aitana cotiza) desde Inventario. null → usar el local.
async function softwarePlansBlock() {
  const inv = await getInvPlans();
  if (!inv || !inv.length) return null;
  return inv.map(p => {
    const dias = p.days ? ` · ${p.days} días de vigencia` : '';
    const para = p.description ? `\nPara: ${p.description}` : '';
    return `────────────────────────────────────────────────────────
**${p.name.toUpperCase()} — ${p.price} Bs**   [código: ${p.code}]
────────────────────────────────────────────────────────${para}${dias}`;
  }).join('\n');
}

// v0.9.531 — FUENTE ÚNICA DE PRECIOS. El monto del QR sale de la tabla de planes que el
// dueño maneja en el panel (Config → Modo software → Planes → bot_pricing_plans): el mismo
// origen que alimenta lo que Aitana cotiza ({{plans_block}}). Match por plan_id o por nombre
// (normalizados). Si no está en la tabla, cae a los planes fijos (prueba/mes/semestre/anual).
// Devuelve { code, label, amount } o null.
async function _resolvePlan(tenantId, input, opts = {}) {
  const key = _norm(input);
  if (!key) return null;
  // v0.9.538 — consciente del PRODUCTO. opts={product, integration}. Producto integrado
  // ('inventario') → planes vivos de Inventario. Producto local → SOLO sus planes (vertical_id).
  // Sin producto (legacy) → Inventario primero, luego catálogo local completo.
  const product = opts.product || null;
  const integration = opts.integration || null;
  const useInv = integration === 'inventario' || (!product && !!_invSecret());
  if (useInv) {
    const inv = await getInvPlans();
    if (inv && inv.length) {
      const m = _matchPlan(inv.map(p => ({ code: p.code, name: p.name, amount: p.price, days: p.days })), input);
      if (m) return m;
      if (integration === 'inventario') return null; // producto integrado: no cae a local
      // legacy sin producto: si Inventario no matchea, seguimos a local abajo
    } else if (integration === 'inventario') {
      return null; // integrado pero Inventario caído → no resolvemos (evita cobrar mal)
    }
  }
  // Catálogo LOCAL (producto local, o fallback legacy). Con producto → filtramos por vertical_id.
  let rows = [];
  if (tenantId) {
    try {
      const r = product
        ? await db.query(`SELECT plan_id, display_name, monthly_bs FROM bot_pricing_plans WHERE tenant_id = $1 AND active = TRUE AND vertical_id = $2`, [tenantId, product])
        : await db.query(`SELECT plan_id, display_name, monthly_bs FROM bot_pricing_plans WHERE tenant_id = $1 AND active = TRUE`, [tenantId]);
      rows = r.rows;
    } catch (e) { /* tabla sin migrar → fallback */ }
  }
  const mk = (row) => {
    const amt = Number(row.monthly_bs);
    return (Number.isFinite(amt) && amt >= 0) ? { code: row.plan_id, label: row.display_name, amount: amt } : null;
  };
  for (const row of rows) {
    if (_norm(row.plan_id) === key || _norm(row.display_name) === key) { const m = mk(row); if (m) return m; }
  }
  const generic = _normPlan(input);
  for (const row of rows) {
    const dn = _norm(row.display_name);
    const hitsName = dn.length >= 4 && key.includes(dn);
    const hitsGeneric = generic && (_norm(row.plan_id) === generic || _normPlan(row.display_name) === generic);
    if (hitsName || hitsGeneric) { const m = mk(row); if (m) return m; }
  }
  // fallback a los planes fijos SOLO en modo legacy (sin producto)
  if (!product && generic && PLANS[generic]) return { code: generic, label: PLANS[generic].label, amount: PLANS[generic].amount };
  return null;
}
async function _activePlansList(tenantId, opts = {}) {
  const product = opts.product || null;
  const integration = opts.integration || null;
  if (integration === 'inventario' || (!product && !!_invSecret())) {
    const inv = await getInvPlans();
    if (inv && inv.length) return inv.map(p => `${p.name} (Bs ${p.price})`).join(' · ');
    if (integration === 'inventario') return 'los planes disponibles';
  }
  try {
    const r = product
      ? await db.query(`SELECT display_name, monthly_bs FROM bot_pricing_plans WHERE tenant_id = $1 AND active = TRUE AND vertical_id = $2 ORDER BY sort_order, monthly_bs`, [tenantId, product])
      : await db.query(`SELECT display_name, monthly_bs FROM bot_pricing_plans WHERE tenant_id = $1 AND active = TRUE ORDER BY sort_order, monthly_bs`, [tenantId]);
    if (r.rows.length) return r.rows.map(p => `${p.display_name} (Bs ${p.monthly_bs})`).join(' · ');
  } catch (e) {}
  return 'los planes disponibles';
}
// v0.9.538 — integración declarada del producto ('inventario' | 'none' | null si no existe).
async function _productIntegration(tenantId, product) {
  if (!product) return null;
  try {
    const r = await db.query(`SELECT integration_type FROM bot_verticals WHERE tenant_id = $1 AND vertical_id = $2 LIMIT 1`, [tenantId, product]);
    return (r.rows[0] && r.rows[0].integration_type) || 'none';
  } catch (e) { return null; }
}

async function ensureSchema() {
  try {
    await db.query(`CREATE TABLE IF NOT EXISTS software_sales (
      id SERIAL PRIMARY KEY,
      tenant_id INT, conversation_id INT, phone TEXT,
      biz_name TEXT, admin_name TEXT, admin_email TEXT,
      plan TEXT, amount NUMERIC,
      qr_id TEXT, status TEXT DEFAULT 'pending',
      inv_tenant_id INT, temp_password TEXT, login_url TEXT,
      attempts INT DEFAULT 0, last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), paid_at TIMESTAMPTZ, provisioned_at TIMESTAMPTZ
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_software_sales_pending ON software_sales (status) WHERE status = 'pending'`).catch(() => {});
    // v0.9.534 — throttle de reintentos de provisión
    await db.query(`ALTER TABLE software_sales ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`).catch(() => {});
    // v0.9.538 — modo software = catálogo de PRODUCTOS. Cada plan cuelga de un producto
    // (bot_verticals.vertical_id) y cada producto declara su integración. Solo afecta al modo
    // software; los proof_points y media ya estaban ligados por vertical. Aditivo, idempotente.
    await db.query(`ALTER TABLE bot_pricing_plans ADD COLUMN IF NOT EXISTS vertical_id TEXT`).catch(() => {});
    await db.query(`ALTER TABLE bot_verticals ADD COLUMN IF NOT EXISTS integration_type TEXT DEFAULT 'none'`).catch(() => {});
    await db.query(`ALTER TABLE software_sales ADD COLUMN IF NOT EXISTS product TEXT`).catch(() => {});
    // v0.9.545 — vínculo del tenant con SU cuenta del sistema de Inventario (modo artículos)
    await require('./inventario-link').ensureSchema().catch(() => {});
    // Backfill: los planes locales existentes se asignan al primer producto activo de su tenant.
    await db.query(
      `UPDATE bot_pricing_plans p SET vertical_id = (
         SELECT v.vertical_id FROM bot_verticals v
          WHERE v.tenant_id = p.tenant_id AND v.active = TRUE
          ORDER BY v.sort_order, v.display_name LIMIT 1)
       WHERE p.vertical_id IS NULL`).catch(() => {});
  } catch (e) { console.error('[software-sales] schema:', e.message); }
}

async function _convByPhone(tenantId, phone) {
  try {
    const c = await db.query(
      `SELECT * FROM conversations
        WHERE tenant_id = $1 AND regexp_replace(COALESCE(phone,''),'\\D','','g') LIKE '%' || $2
        ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [tenantId, phone.slice(-8)]);
    return c.rows[0] || null;
  } catch (e) { return null; }
}
async function _ctxOf(conv) {
  if (!conv) return null;
  try { return await require('./tenant-resolver').getConversationMetaCtx(conv); } catch (e) { return null; }
}

/**
 * POST /api/bot/software-sale (lo llama n8n). Valida datos, genera el QR y lo manda.
 * Si faltan datos, devuelve ready:false + missing para que Aitana los pida.
 */
async function handleSale(req, res) {
  try {
    const tenantId = Number(req.body && req.body.tenant_id) || null;
    const phone = String((req.body && req.body.phone) || '').replace(/\D/g, '');
    const biz_name = String((req.body && req.body.biz_name) || '').trim();
    const admin_name = String((req.body && req.body.admin_name) || '').trim();
    const admin_email = String((req.body && req.body.admin_email) || '').trim().toLowerCase();
    // v0.9.538 — el PRODUCTO define de dónde salen los planes y cómo se crea la cuenta.
    const product = String((req.body && req.body.product) || '').trim() || null;
    const integration = await _productIntegration(tenantId, product);
    const P = await _resolvePlan(tenantId, req.body && req.body.plan, { product, integration });

    const missing = [];
    if (!biz_name) missing.push('biz_name');
    if (!admin_name) missing.push('admin_name');
    if (!_emailOk(admin_email)) missing.push('admin_email');
    if (!P) missing.push('plan');
    if (!phone) missing.push('phone');
    if (missing.length) {
      return res.json({
        ok: true, ready: false, missing,
        message: `Para generar el cobro necesito 4 datos: el nombre del negocio, el nombre del responsable, un email para el acceso y el plan (${await _activePlansList(tenantId, { product, integration })}).`,
      });
    }

    const conv = await _convByPhone(tenantId, phone);

    const ins = await db.query(
      `INSERT INTO software_sales (tenant_id, conversation_id, phone, biz_name, admin_name, admin_email, plan, amount, status, product)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING id`,
      [tenantId, conv && conv.id, phone, biz_name, admin_name, admin_email, P.code, P.amount, product]);
    const saleId = ins.rows[0].id;

    // v0.9.531 — PLAN GRATIS (monto 0): sin QR, se crea la cuenta directo.
    if (!(P.amount > 0)) {
      await db.query(`UPDATE software_sales SET status='paid', paid_at=NOW() WHERE id=$1`, [saleId]).catch(() => {});
      const sale = { id: saleId, tenant_id: tenantId, conversation_id: conv && conv.id, phone, biz_name, admin_name, admin_email, plan: P.code, product };
      provisionSale(sale).catch(e => console.error('[software-sale] provision (gratis):', e.message));
      return res.json({
        ok: true, ready: true, sale_id: saleId, amount: 0, plan: P.code,
        message: `¡Genial! El plan ${P.label} es sin costo — estoy creando tu cuenta ahora mismo. En un momento te paso el usuario y la contraseña. 🙌`,
      });
    }

    let qr;
    try {
      qr = await baneco.generateQR({
        transactionId: 'SW' + saleId,
        amount: P.amount,
        description: `Inventario ${P.label} - ${biz_name}`.slice(0, 100),
      });
    } catch (e) {
      await db.query(`UPDATE software_sales SET status='failed', last_error=$2 WHERE id=$1`, [saleId, 'QR: ' + e.message]).catch(() => {});
      return res.json({ ok: false, ready: false, message: 'No pude generar el QR de cobro en este momento. Probemos de nuevo en un ratito.' });
    }
    await db.query(`UPDATE software_sales SET qr_id=$2 WHERE id=$1`, [saleId, qr.qrId]).catch(() => {});

    // subir el PNG del QR a R2 y mandarlo al cliente por WhatsApp
    try {
      const buf = Buffer.from(qr.qrImage, 'base64');
      const up = await r2.upload({ buffer: buf, mimeType: 'image/png', prefix: 'qr-ventas', filename: `qr-sw${saleId}.png` });
      const caption = `💳 Pago del plan ${P.label} — Bs ${P.amount}\n\nEscaneá este QR con la app de tu banco. Apenas se acredite el pago te creo la cuenta y te paso el usuario y la contraseña. ✅`;
      await meta.sendImage(phone, up.url, caption, await _ctxOf(conv)).catch(e => console.warn('[software-sale] sendImage:', e.message));
    } catch (e) { console.warn('[software-sale] R2/envío QR:', e.message); }

    return res.json({
      ok: true, ready: true, sale_id: saleId, amount: P.amount, plan: P.code,
      message: `Te envié el QR por Bs ${P.amount} (plan ${P.label}). En cuanto el banco confirme el pago, te creo la cuenta del sistema de Inventario y te mando el acceso. 🙌`,
    });
  } catch (e) {
    console.error('[software-sale]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

// ── Worker de confirmación ────────────────────────────────────────────────
let _running = false;
async function pollPendingSales() {
  if (_running) return;
  _running = true;
  try {
    const r = await db.query(
      `SELECT * FROM software_sales
        WHERE status='pending' AND qr_id IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY id LIMIT 20`);
    for (const s of r.rows) {
      let st;
      try { st = await baneco.getStatus(s.qr_id); } catch (e) { continue; }
      if (!st) continue;
      if (st.statusQrCode === 1) {
        const upd = await db.query(`UPDATE software_sales SET status='paid', paid_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`, [s.id]).catch(() => ({ rows: [] }));
        if (upd.rows && upd.rows.length) {
          console.log(`💰 [software-sale] venta ${s.id} PAGADA (${s.amount} Bs) → provisionando`);
          await provisionSale(s).catch(e => console.error('[software-sale] provision:', e.message));
        }
      } else if (st.statusQrCode === 9) {
        await db.query(`UPDATE software_sales SET status='expired' WHERE id=$1`, [s.id]).catch(() => {});
      }
    }
    await db.query(`UPDATE software_sales SET status='expired' WHERE status='pending' AND created_at <= NOW() - INTERVAL '24 hours'`).catch(() => {});

    // v0.9.534 — REINTENTO de provisión: ventas PAGADAS que no se pudieron crear en Inventario
    // (Inventario caído, secreto mal, error de esquema). Se reintenta cada ~5 min por hasta 7 días,
    // así se recuperan SOLAS al arreglar el problema, sin quedar trabadas. Throttle vía last_attempt_at.
    const rr = await db.query(
      `SELECT * FROM software_sales
        WHERE status='paid' AND provisioned_at IS NULL
          AND created_at > NOW() - INTERVAL '7 days'
          AND (last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '5 minutes')
        ORDER BY id LIMIT 10`).catch(() => ({ rows: [] }));
    for (const s of rr.rows) {
      console.log(`🔁 [software-sale] reintentando provisión venta ${s.id} (intento ${(Number(s.attempts) || 0) + 1})`);
      await provisionSale(s).catch(e => console.error('[software-sale] provision retry:', e.message));
    }
    await require('./inventario-link').pollPendingOrders().catch(() => {}); // v0.9.550 — pedidos con QR Baneco
  } catch (e) { console.error('[software-sale] poll:', e.message); }
  finally { _running = false; }
}

async function provisionSale(s) {
  const _firstTry = !(Number(s.attempts) > 0); // ¿es el primer intento? (para no spamear al cliente en cada reintento)
  // v0.9.538 — RUTEO POR PRODUCTO. Producto LOCAL (sin integración) → no hay alta automática:
  // marcamos la venta como vendida, avisamos al cliente y logueamos para el alta manual del equipo.
  // Producto integrado ('inventario') o venta legacy sin producto → sigue el flujo de Inventario.
  const _integration = await _productIntegration(s.tenant_id, s.product);
  if (s.product && _integration !== 'inventario') {
    await db.query(`UPDATE software_sales SET status='sold', provisioned_at=NOW() WHERE id=$1`, [s.id]).catch(() => {});
    if (_firstTry) {
      await _notify(s, `¡Gracias, ${s.admin_name}! Tu pago se confirmó ✅. En breve activamos tu cuenta y te pasamos los accesos. 🙌`);
      _notifyTeam(s, `venta PAGADA (alta manual): ${s.biz_name} · plan ${s.plan} · ${s.admin_email} · producto "${s.product}"`);
    }
    return;
  }
  const secret = _invSecret();
  if (!secret) {
    await _fail(s, 'Falta INVENTARIO_INTEGRATION_SECRET (env en SG)');
    if (_firstTry) await _notify(s, 'Tu pago se confirmó ✅. Estamos terminando de crear tu cuenta, te contactamos enseguida.');
    return;
  }
  let data = null, ok = false, httpStatus = 0;
  // v0.9.536 — si el plan guardado ya es un código válido de Inventario (venta nueva, resuelto
  // contra la API de Inventario), lo mandamos tal cual. Si no (venta vieja con código de SG),
  // lo traducimos por período. Así no hay PLAN_INVALID ni para ventas nuevas ni viejas.
  let invPlan;
  const _invList = await getInvPlans();
  if (_invList && _invList.some(p => _norm(p.code) === _norm(s.plan))) invPlan = s.plan;
  else invPlan = _toInvPlan(s);
  try {
    const resp = await fetch(_invUrl() + '/api/integration/provision-tenant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': secret },
      body: JSON.stringify({ name: s.biz_name, admin_email: s.admin_email, admin_name: s.admin_name, plan: invPlan }),
    });
    httpStatus = resp.status;
    data = await resp.json().catch(() => ({}));
    ok = resp.ok && data && data.ok;
    console.log(`[software-sale] Inventario /provision-tenant venta ${s.id} (plan SG "${s.plan}" → Inventario "${invPlan}") → HTTP ${httpStatus}${ok ? ' OK' : ' (falló)'}`);
    if (!ok && (httpStatus === 401 || httpStatus === 403)) {
      // El secreto de SG (INVENTARIO_INTEGRATION_SECRET) NO coincide con el INTEGRATION_SECRET de Inventario.
      console.error(`🔑 [software-sale] venta ${s.id}: Inventario rechazó el secreto (HTTP ${httpStatus}). Revisá que INVENTARIO_INTEGRATION_SECRET (SG) == INTEGRATION_SECRET (Inventario).`);
    }
    if (!ok && data && data.code === 'EMAIL_TAKEN') {
      await _fail(s, 'EMAIL_TAKEN');
      await _notify(s, `Tu pago se confirmó ✅, pero el email ${s.admin_email} ya tiene una cuenta en el sistema. Escribinos y lo resolvemos al toque.`);
      return;
    }
  } catch (e) { await _fail(s, 'fetch: ' + e.message); httpStatus = -1; }

  if (!ok) {
    await _fail(s, `provisión falló (HTTP ${httpStatus}): ` + JSON.stringify(data || {}).slice(0, 200));
    // Solo avisamos al cliente en el PRIMER intento; después se reintenta solo cada 5 min (ver poller).
    if (_firstTry) await _notify(s, 'Tu pago se confirmó ✅ pero estamos terminando de crear tu cuenta. En un ratito te llega el acceso. 🙏');
    return;
  }

  await db.query(
    `UPDATE software_sales SET status='provisioned', provisioned_at=NOW(), inv_tenant_id=$2, temp_password=$3, login_url=$4 WHERE id=$1`,
    [s.id, data.tenant_id || null, data.temp_password || null, data.login_url || null]).catch(() => {});

  const url = data.login_url || _invUrl();
  const msg = `🎉 ¡Listo, ${s.admin_name}! Tu cuenta del sistema de Inventario ya está creada.\n\n🔗 Ingresá acá: ${url}\n👤 Usuario: ${s.admin_email}\n🔑 Contraseña: ${data.temp_password}\n\nTe recomiendo cambiar la contraseña apenas entres. ¡Gracias por tu compra! 🙌`;
  await _notify(s, msg);
  console.log(`✅ [software-sale] venta ${s.id} provisionada → Inventario tenant ${data.tenant_id}`);
}

async function _fail(s, err) {
  console.error(`⚠️  [software-sale] venta ${s.id} falló: ${String(err).slice(0, 300)}`);
  await db.query(`UPDATE software_sales SET attempts=COALESCE(attempts,0)+1, last_error=$2, last_attempt_at=NOW() WHERE id=$1`, [s.id, String(err).slice(0, 300)]).catch(() => {});
}
async function _notify(s, text) {
  try {
    let ctx = null;
    if (s.conversation_id) {
      const c = await db.query('SELECT * FROM conversations WHERE id=$1', [s.conversation_id]).catch(() => ({ rows: [] }));
      if (c.rows[0]) ctx = await _ctxOf(c.rows[0]);
    }
    await meta.sendText(s.phone, text, false, ctx);
  } catch (e) { console.warn('[software-sale] notify:', e.message); }
}
// v0.9.538 — aviso al equipo para el alta manual (productos sin integración). Por ahora queda
// en el log del server; acá se puede enganchar un push/WhatsApp al dueño cuando se quiera.
function _notifyTeam(s, text) {
  console.log(`📣 [software-sale][equipo · alta manual] ${text}`);
}

module.exports = { ensureSchema, handleSale, pollPendingSales, PLANS, getInvPlans, softwarePlansBlock };
