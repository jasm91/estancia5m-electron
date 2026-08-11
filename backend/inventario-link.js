/**
 * inventario-link.js — v0.9.545
 * Integración TOTAL del modo "Artículos comerciales" con el sistema de Inventario.
 *
 * El dueño vincula su cuenta de Inventario (email+password, una sola vez) desde el panel:
 * SG resuelve su tenant de Inventario vía POST /api/integration/resolve-tenant y guarda SOLO
 * el tenant_id (la contraseña no se persiste). Con el vínculo activo:
 *   - El catálogo que ve Aitana (modo artículos) sale EN VIVO de Inventario (precios/stock reales).
 *   - Aitana puede registrar ventas reales en Inventario (descuenta stock) y consultar saldos.
 *   - Los números tageados como ADMIN (gestionados en el super-admin de Inventario, endpoint
 *     GET /api/integration/admins) reciben trato de gestión: resúmenes, stock bajo, etc.
 *
 * AISLAMIENTO: todo está gateado por el vínculo (inv_link_tenant_id) y por los flags del modo
 * artículos. El modo inmuebles no pasa por acá ni ve ninguno de estos bloques/acciones.
 *
 * Env (las mismas de software-sales): INVENTARIO_BASE_URL, INVENTARIO_INTEGRATION_SECRET.
 */
const db = require('./db');

function invUrl() { return String(process.env.INVENTARIO_BASE_URL || 'https://web-production-4eda3.up.railway.app').replace(/\/+$/, ''); }
function invSecret() { return process.env.INVENTARIO_INTEGRATION_SECRET || process.env.INTEGRATION_SECRET || ''; }
function norm8(p) { return String(p || '').replace(/\D/g, '').slice(-8); }

async function ensureSchema() {
  for (const sql of [
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inv_link_tenant_id INT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inv_link_name TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inv_link_branch TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inv_link_branches JSONB`,
    `ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS sale_mode TEXT`,
    `CREATE TABLE IF NOT EXISTS article_orders (id SERIAL PRIMARY KEY, tenant_id INT, phone TEXT, customer_name TEXT, items JSONB, branch TEXT, entrega TEXT, direccion TEXT, total NUMERIC, qr_id TEXT, sale_id INT, status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(), paid_at TIMESTAMPTZ)`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inv_link_at TIMESTAMPTZ`,
  ]) { await db.query(sql).catch(() => {}); }
}

// ── Vínculo (cache 60s) ──────────────────────────────────────────────────────
const _linkCache = new Map();
async function getLink(tenantId) {
  const k = Number(tenantId) || 0;
  const c = _linkCache.get(k);
  if (c && Date.now() - c.at < 60000) return c.v;
  let v = null;
  try {
    const r = await db.query(`SELECT inv_link_tenant_id, inv_link_name, inv_link_branch, inv_link_branches FROM tenants WHERE id = $1`, [k]);
    if (r.rows[0] && r.rows[0].inv_link_tenant_id) v = { inv_tenant_id: r.rows[0].inv_link_tenant_id, name: r.rows[0].inv_link_name, branch: r.rows[0].inv_link_branch, branches: Array.isArray(r.rows[0].inv_link_branches) ? r.rows[0].inv_link_branches : [] };
  } catch (e) { /* columnas sin migrar */ }
  _linkCache.set(k, { at: Date.now(), v });
  return v;
}
function bustLink(tenantId) { _linkCache.delete(Number(tenantId) || 0); _catCache.delete(Number(tenantId) || 0); _admCache.delete(Number(tenantId) || 0); }

async function _invGet(path) {
  const resp = await fetch(invUrl() + path, { headers: { 'X-CRM-Secret': invSecret() } });
  if (!resp.ok) { const e = new Error('HTTP ' + resp.status); e.status = resp.status; throw e; }
  return resp.json();
}
async function _invPost(path, body) {
  const resp = await fetch(invUrl() + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': invSecret() },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, ok: resp.ok, data };
}

// ── Catálogo VIVO para el dispatch del bot (cache 120s) ──────────────────────
// Mismo shape que el inventoryCatalog local del webhook: in_stock booleano (JAMÁS cantidades
// al cliente), sin fotos ni docs (id:0 → inventory_to_send nunca matchea una ficha local).
const _catCache = new Map();
async function getLiveCatalog(tenantId) {
  const link = await getLink(tenantId);
  if (!link || !invSecret()) return null;
  const k = Number(tenantId) || 0;
  const c = _catCache.get(k);
  if (c && Date.now() - c.at < 120000) return c.v;
  try {
    const data = await _invGet(`/api/integration/products?tenant_id=${link.inv_tenant_id}&q=&limit=300`);
    const list = Array.isArray(data) ? data : (data && data.products) || [];
    const v = list.map((p) => ({
      id: 0, code: p.code, name: p.name, description: null,
      price: Number(p.sale_price != null ? p.sale_price : p.price) || 0, currency: 'Bs',
      in_stock: Number(p.stock) > 0, brand: p.brand || null, category: p.category || null,
      subcategory: null, features: null, photos: [], docs_count: 0,
      price_ref: `Bs ${Number(p.sale_price != null ? p.sale_price : p.price) || 0}`,
      _live: true,
    }));
    const vInStock = v.filter(p => p.in_stock); // v0.9.554 — sin stock NI SE MUESTRA al bot
    _catCache.set(k, { at: Date.now(), v: vInStock });
    return vInStock;
  } catch (e) {
    console.warn('[inv-link] catálogo vivo falló, fallback local:', e.message);
    return null; // el webhook cae al catálogo local
  }
}

// ── Catálogo para el PANEL del dueño (con cantidades — es su propio negocio) ──
async function panelCatalog(tenantId) {
  const link = await getLink(tenantId);
  if (!link || !invSecret()) return null;
  const data = await _invGet(`/api/integration/products?tenant_id=${link.inv_tenant_id}&q=&limit=500`);
  const list = Array.isArray(data) ? data : (data && data.products) || [];
  return list.map(p => ({
    code: p.code, name: p.name, category: p.category || null, brand: p.brand || null,
    price: Number(p.sale_price != null ? p.sale_price : p.price) || 0, stock: Number(p.stock) || 0,
  }));
}

// ── Admins tageados (se gestionan en el super-admin de Inventario; cache 120s) ─
const _admCache = new Map();
async function getAdmins(tenantId) {
  const link = await getLink(tenantId);
  if (!link || !invSecret()) return [];
  const k = Number(tenantId) || 0;
  const c = _admCache.get(k);
  if (c && Date.now() - c.at < 120000) return c.v;
  let v = [];
  try {
    const data = await _invGet(`/api/integration/admins?tenant_id=${link.inv_tenant_id}`);
    v = (data && data.admins) || [];
  } catch (e) { /* endpoint aún no publicado (Tarea 6) → sin admins */ }
  _admCache.set(k, { at: Date.now(), v });
  return v;
}
async function adminFor(tenantId, phone) {
  const p8 = norm8(phone);
  if (!p8) return null;
  const admins = await getAdmins(tenantId);
  return admins.find(a => norm8(a.phone) === p8) || null;
}

// ── Acciones del bot (las llama api.js /bot/inventario/*) ────────────────────
async function searchProducts(tenantId, q) {
  const link = await getLink(tenantId);
  if (!link) return null;
  const data = await _invGet(`/api/integration/products?tenant_id=${link.inv_tenant_id}&q=${encodeURIComponent(q || '')}&limit=8`);
  const listAll = (Array.isArray(data) ? data : (data && data.products) || []);
  const list = listAll.filter(p => Number(p.stock) > 0).slice(0, 8); // v0.9.554 — solo con stock
  if (!list.length && listAll.length) return { message: `Uy, "${q}" está agotado ahora mismo 🙏. ¿Te muestro alternativas parecidas que sí tengo disponibles?` };
  if (!list.length) return { message: `No encontré "${q}" en el catálogo ahora mismo. ¿Querés que busque con otro nombre o te muestro opciones parecidas?` };
  const lines = list.map(p => `• *${p.name}* (${p.code}) — Bs ${Number(p.sale_price != null ? p.sale_price : p.price) || 0}${Number(p.stock) > 0 ? ' ✅ disponible' : ' ⛔ sin stock'}`);
  return { message: `Esto es lo que tengo ahora mismo:\n\n${lines.join('\n')}\n\n¿Te preparo alguno? Decime cuál y cuántas unidades. 🙌`, items: list };
}

// v0.9.556 — mapa de stock EN VIVO (uso INTERNO del checkout; jamás viaja al prompt del bot).
// Cache corto (60s) porque valida dinero: mejor un fetch de más que un QR imposible.
const _stkCache = new Map();
async function _liveStockMap(tenantId) {
  const link = await getLink(tenantId);
  if (!link || !invSecret()) return null;
  const k = Number(tenantId) || 0;
  const c = _stkCache.get(k);
  if (c && Date.now() - c.at < 60000) return c.v;
  const data = await _invGet(`/api/integration/products?tenant_id=${link.inv_tenant_id}&q=&limit=300`);
  const list = Array.isArray(data) ? data : (data && data.products) || [];
  const m = new Map();
  for (const p of list) m.set(String(p.code || '').toUpperCase(), { stock: Number(p.stock) || 0, name: p.name, price: Number(p.sale_price != null ? p.sale_price : p.price) || 0 });
  _stkCache.set(k, { at: Date.now(), v: m });
  return m;
}

async function registerSale(tenantId, { phone, customer_name, items, branch, admin, entrega, direccion, paid }) {
  const link = await getLink(tenantId);
  if (!link) return null;
  if (!Array.isArray(items) || !items.length) return { message: 'Decime qué productos querés (código o nombre) y cuántas unidades, y te armo el pedido.' };
  const _entrega = String(entrega || '').toLowerCase() === 'envio' ? 'envio' : (String(entrega || '').toLowerCase() === 'retiro' ? 'retiro' : null);
  const _dir = String(direccion || '').trim().slice(0, 140) || null;
  // v0.9.556 — CANDADO PRE-COBRO (bug batería 8-ago: 50 grips con 43 en stock → QR por Bs 2.750
  // generado; si el cliente pagaba, el registro fallaba DESPUÉS de cobrado). Antes de generar QR
  // o registrar, se valida la cantidad contra el stock TOTAL en vivo. (El stock POR SUCURSAL aún
  // no está expuesto por la API de integración — queda el /sales como segunda barrera y el
  // manejo paid_error de pollPendingOrders como red final.)
  if (!paid) {
    try {
      const stk = await _liveStockMap(tenantId);
      if (stk && stk.size) {
        for (const it of items) {
          const p = stk.get(String(it.code || '').trim().toUpperCase());
          const q = Number(it.qty) || 1;
          if (p && q > p.stock) {
            return { message: p.stock > 0
              ? `Uy, de *${p.name}* no me alcanza el stock para ${q} unidades 🙏 — puedo prepararte hasta *${p.stock}* ahora mismo. ¿Te anoto ${p.stock} o preferís que el equipo te avise cuando repongamos?`
              : `Uy, *${p.name}* justo se agotó 🙏. ¿Te muestro una alternativa parecida que sí tengo disponible?` };
          }
        }
      }
    } catch (e) { /* sin mapa → /sales valida al registrar (barrera previa intacta) */ }
  }
  // v0.9.550 — COBRO PRIMERO (José): QR Baneco DINÁMICO con el monto exacto, generado por
  // Inventario (sus credenciales). La venta se registra SOLO cuando el pago se verifica
  // (poller). Si Inventario aún no publica /payment-qr → flujo directo de siempre.
  if (!admin && !paid) {
    const qrRes = await _startQrOrder(tenantId, link, { phone, customer_name, items, branch, entrega: _entrega, direccion: _dir }).catch(() => null);
    if (qrRes) return qrRes;
  }
  // dedupe estable ~10 min: mismo pedido reintentado no se duplica en Inventario
  const bucket = Math.floor(Date.now() / 600000);
  const key = require('crypto').createHash('md5').update(tenantId + '|' + norm8(phone) + '|' + JSON.stringify(items) + '|' + bucket).digest('hex').slice(0, 12);
  const body = {
    tenant_id: link.inv_tenant_id,
    branch: branch || link.branch || undefined,
    customer: { name: (customer_name || 'Cliente WhatsApp').slice(0, 80), phone: String(phone || '').replace(/\D/g, '') || undefined },
    type: 'cash',
    note: `${admin ? 'venta registrada por admin vía WhatsApp' : 'pedido por WhatsApp (Aitana)'}${_entrega === 'envio' ? ` · ENVÍO a: ${_dir || 'dirección a confirmar'}` : (_entrega === 'retiro' ? ' · RETIRO en sucursal' : '')}`.slice(0, 200),
    items: items.map(i => ({ code: String(i.code || '').trim(), qty: Number(i.qty) || 1 })),
    external_ref: key,
  };
  const r = await _invPost('/api/integration/sales', body);
  if (r.ok && r.data && (r.data.ok || r.data.already_exists)) {
    const d = r.data;
    const det = (d.items || []).map(i => `• ${i.name} ×${i.qty} — Bs ${i.price * i.qty}`).join('\n');
    // v0.9.546 — push "🛒 Venta realizada" al equipo (roles según Config → Notificaciones) para
    // coordinar el envío. Solo ventas NUEVAS (no reintentos deduplicados). Best-effort.
    if (d.ok && !d.already_exists) {
      _notifySale(tenantId, { phone, customer: body.customer.name, det, total: d.total, sucursal: d.sucursal, sale_id: d.sale_id, admin, entrega: _entrega, direccion: _dir }).catch(() => {});
    }
    // v0.9.547 — QR DE COBRO del negocio: si el tenant subió su QR bancario a Multimedia con el
    // id "qr_cobro" (imagen), se lo mandamos con el total. Verificación de pago: manual, del equipo.
    // v0.9.547b — NOTA DE VENTA OFICIAL: si Inventario expone el documento de la venta
    // (GET /api/integration/sales/:id/receipt → { url } PDF/imagen), se lo mandamos al cliente.
    // Si el endpoint no existe todavía, va solo la nota en texto (el mensaje de abajo).
    if (!admin) _sendReceipt(tenantId, phone, d.sale_id, link).catch(() => {});
    let qrSent = false;
    if (!admin && !paid) qrSent = await _sendPaymentQr(tenantId, phone, d.total).catch(() => false);
    const entLine = _entrega === 'envio' ? `\n🚚 Entrega: envío a ${_dir || '(me pasás la dirección y coordinamos)'}` : (_entrega === 'retiro' ? `\n🏬 Entrega: retiro en ${d.sucursal || 'la sucursal'}` : '');
    const payLine = paid ? '\n\n💚 Pago recibido y verificado — ¡gracias!' : qrSent ? '\n\n💳 Te pasé el QR para el pago — apenas lo hagas, el equipo lo confirma y coordinamos.' : '\n\nEl equipo te confirma el pago al coordinar la entrega.';
    const _f = new Date(Date.now() - 4 * 3600000); // hora Bolivia
    const _fecha = `${String(_f.getUTCDate()).padStart(2, '0')}/${String(_f.getUTCMonth() + 1).padStart(2, '0')}/${_f.getUTCFullYear()}`;
    // v0.9.547 — el cierre ES la nota de venta (número real del sistema de Inventario)
    return { message: `🧾 *NOTA DE VENTA Nº ${d.sale_id}*\n${link.name || 'Tu compra'} · ${_fecha}\n👤 ${body.customer.name}\n\n${det}\n\n*TOTAL: Bs ${d.total}*${entLine}${payLine}\n\n¡Gracias por tu compra! 🙌`, sale_id: d.sale_id };
  }
  const err = (r.data && r.data.error) || ('HTTP ' + r.status);
  if (/stock insuficiente/i.test(err)) return { message: `Uy, ${err.replace('Stock insuficiente', 'me quedé sin stock suficiente')}. ¿Querés que lo anote por una cantidad menor o te aviso apenas repongamos?` };
  console.warn('[inv-link] venta falló:', err);
  return { message: 'No pude registrar el pedido en este momento 🙏. Ya avisé al equipo — en un ratito lo intentamos de nuevo o te contactan.' };
}

// v0.9.550 — QR Baneco dinámico (Inventario genera con SUS credenciales) + verificación previa.
async function _ctxByPhone(tenantId, phone) {
  try {
    const c = await db.query(`SELECT * FROM conversations WHERE tenant_id=$1 AND regexp_replace(COALESCE(phone,''),'\\D','','g') LIKE '%' || $2 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [tenantId, String(phone || '').replace(/\D/g, '').slice(-8)]);
    return c.rows[0] ? await require('./tenant-resolver').getConversationMetaCtx(c.rows[0]) : null;
  } catch (e) { return null; }
}
async function _startQrOrder(tenantId, link, o) {
  const cat = await getLiveCatalog(tenantId);
  if (!cat) return null;
  let total = 0;
  const detLines = []; // v0.9.556 — NOMBRES al cliente (batería 8-ago: le llegaba "ACC-001 ×50")
  for (const it of (o.items || [])) {
    const p = cat.find(x => String(x.code).toUpperCase() === String(it.code || '').trim().toUpperCase());
    if (!p || !(p.price > 0)) return null; // sin precio confiable → flujo directo
    const q = Number(it.qty) || 1;
    total += p.price * q;
    detLines.push(`• ${p.name} ×${q} — Bs ${p.price * q}`);
  }
  if (!(total > 0)) return null;
  const phone8 = String(o.phone || '').replace(/\D/g, '');
  // v0.9.556 — ANTI DOBLE-QR (batería 8-ago): si el MISMO cliente ya tiene un pedido pendiente
  // por el MISMO total en los últimos 15 min, no se genera otra orden ni otro QR (el cliente
  // podía terminar pagando dos veces; Inventario deduplicaba la venta pero la 2ª plata quedaba huérfana).
  try {
    const dup = await db.query(
      `SELECT id FROM article_orders WHERE tenant_id=$1 AND phone=$2 AND total=$3 AND status='pending' AND created_at > NOW() - INTERVAL '15 minutes' LIMIT 1`,
      [tenantId, phone8, total]);
    if (dup.rows.length) {
      return { message: `Ese pedido ya lo tenés anotado con su QR enviado 👆 (total *Bs ${total}*). Pagalo cuando quieras y el resto sigue solo. Si querés cambiar algo, decime y lo rearmamos. 🙌` };
    }
  } catch (e) { /* sin dedupe → flujo normal */ }
  const qr = await _invPost('/api/integration/payment-qr', { tenant_id: link.inv_tenant_id, amount: total, description: `Pedido WhatsApp ${o.customer_name || ''}`.trim().slice(0, 90) });
  const qrId = qr.ok && qr.data && (qr.data.qr_id || qr.data.qrId);
  if (!qrId) return null; // endpoint aún no publicado (Tarea 8) → flujo directo
  const ins = await db.query(
    `INSERT INTO article_orders (tenant_id, phone, customer_name, items, branch, entrega, direccion, total, qr_id, status)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,'pending') RETURNING id`,
    [tenantId, phone8, o.customer_name || null, JSON.stringify(o.items), o.branch || link.branch || null, o.entrega, o.direccion, total, String(qrId)]);
  const img = qr.data.qr_image || qr.data.qrImage;
  try {
    if (img) {
      const up = await require('./r2').upload({ buffer: Buffer.from(img, 'base64'), mimeType: 'image/png', prefix: 'qr-pedidos', filename: `qr-ord${ins.rows[0].id}.png` });
      await require('./meta').sendImage(phone8, up.url, `💳 Pagá tu pedido — *Bs ${total}* (monto exacto)\nEscaneá con la app de tu banco. Apenas se acredite, registro tu venta y te llega tu nota. ✅`, await _ctxByPhone(tenantId, o.phone));
    }
  } catch (e) { console.warn('[inv-link] envío QR pedido:', e.message); }
  console.log(`💳 [inv-link] QR Baneco pedido #${ins.rows[0].id} Bs ${total} (qr ${qrId})`);
  // v0.9.556 — "queda ANOTADO" (no "reservado": el stock no se retiene hasta el pago)
  return { message: `¡Perfecto! Tu pedido queda anotado, pendiente de pago:\n\n${detLines.join('\n')}\n\n*Total: Bs ${total}*\n\nTe mandé el QR con el monto exacto 👆 — apenas el banco confirme tu pago, registro la venta y te paso tu nota de venta. 🙌` };
}
let _pollingOrders = false;
async function pollPendingOrders() {
  if (_pollingOrders) return; _pollingOrders = true;
  try {
    const r = await db.query(`SELECT * FROM article_orders WHERE status='pending' AND created_at > NOW() - INTERVAL '24 hours' ORDER BY id LIMIT 20`).catch(() => ({ rows: [] }));
    for (const o of r.rows) {
      const link = await getLink(o.tenant_id); if (!link) continue;
      let st = null;
      try { st = await _invGet(`/api/integration/payment-status?tenant_id=${link.inv_tenant_id}&qr_id=${encodeURIComponent(o.qr_id)}`); } catch (e) { continue; }
      const isPaid = st && (st.status === 'paid' || st.statusQrCode === 1);
      const isCancelled = st && (st.status === 'cancelled' || st.statusQrCode === 9);
      if (isCancelled) { await db.query(`UPDATE article_orders SET status='expired' WHERE id=$1`, [o.id]).catch(() => {}); continue; }
      if (!isPaid) continue;
      const upd = await db.query(`UPDATE article_orders SET status='paid', paid_at=NOW() WHERE id=$1 AND status='pending' RETURNING id`, [o.id]).catch(() => ({ rows: [] }));
      if (!upd.rows.length) continue;
      console.log(`💰 [inv-link] pedido #${o.id} PAGADO (Bs ${o.total}) → registrando venta en Inventario`);
      const res = await registerSale(o.tenant_id, { phone: o.phone, customer_name: o.customer_name, items: o.items, branch: o.branch, entrega: o.entrega, direccion: o.direccion, paid: true }).catch(() => null);
      if (res && res.sale_id) {
        await db.query(`UPDATE article_orders SET status='registered', sale_id=$2 WHERE id=$1`, [o.id, res.sale_id]).catch(() => {});
        if (res.message) { try { await require('./meta').sendText(String(o.phone || ''), '💚 ¡Pago confirmado!\n\n' + res.message, false, await _ctxByPhone(o.tenant_id, o.phone)); } catch (e) {} }
      } else {
        // v0.9.556 — PAGO RECIBIDO PERO VENTA NO REGISTRADA (stock vendido en el medio, red, etc).
        // Antes: la orden quedaba 'paid' muda y al cliente le llegaba "no tengo stock" DESPUÉS de
        // pagar, sin que NADIE del equipo se entere. Ahora: estado paid_error + push URGENTE al
        // equipo + mensaje honesto al cliente (sin culparlo ni dejarlo en el aire).
        await db.query(`UPDATE article_orders SET status='paid_error' WHERE id=$1`, [o.id]).catch(() => {});
        console.error(`🆘 [inv-link] pedido #${o.id} PAGADO (Bs ${o.total}) pero el registro FALLÓ${res && res.message ? ` — ${res.message.slice(0, 120)}` : ''}`);
        try {
          const pushNotifier = require('./push-notifier');
          if (pushNotifier.isConfigured()) {
            await pushNotifier.broadcast({
              title: `🆘 Pago recibido SIN venta — Bs ${o.total}`,
              body: `Pedido #${o.id} de ${o.customer_name || o.phone}: el pago se confirmó pero la venta NO se registró en Inventario${res && res.message ? ' (posible falta de stock)' : ''}. Atender YA: entregar manual o devolver.`,
              url: `/panel/?conv=${encodeURIComponent(o.phone)}`,
              conversation_phone: o.phone,
            }, o.tenant_id, { roles: ['owner', 'supervisor'] }).catch(() => {});
          }
        } catch (e) { /* push best-effort */ }
        try {
          await require('./meta').sendText(String(o.phone || ''), '💚 Tu pago está confirmado — ¡gracias! Tuvimos un detalle técnico al registrar tu pedido y ya avisé al equipo: te contactan en breve para coordinar la entrega. 🙏', false, await _ctxByPhone(o.tenant_id, o.phone));
        } catch (e) {}
      }
    }
    // v0.9.556 — ÚLTIMO CHEQUEO antes de expirar (batería 8-ago): si el cliente pagó pasadas las
    // 24 h (el QR bancario puede seguir vigente), antes NADIE se enteraba. Una consulta final de
    // payment-status decide: pagado → se procesa igual; no pagado → recién ahí expira.
    try {
      const exp = await db.query(`SELECT * FROM article_orders WHERE status='pending' AND created_at <= NOW() - INTERVAL '24 hours' ORDER BY id LIMIT 10`).catch(() => ({ rows: [] }));
      for (const o of exp.rows) {
        let paidLate = false;
        try {
          const link = await getLink(o.tenant_id);
          if (link) {
            const st = await _invGet(`/api/integration/payment-status?tenant_id=${link.inv_tenant_id}&qr_id=${encodeURIComponent(o.qr_id)}`);
            paidLate = !!(st && (st.status === 'paid' || st.statusQrCode === 1));
          }
        } catch (e) { /* sin respuesta → expira normal */ }
        if (paidLate) {
          await db.query(`UPDATE article_orders SET created_at = NOW() WHERE id=$1`, [o.id]).catch(() => {}); // re-entra al ciclo normal como pending vigente
          console.log(`💰 [inv-link] pedido #${o.id} pagado FUERA de las 24h → reprocesando`);
        } else {
          await db.query(`UPDATE article_orders SET status='expired' WHERE id=$1 AND status='pending'`, [o.id]).catch(() => {});
        }
      }
    } catch (e) { /* best-effort */ }
  } catch (e) { console.warn('[inv-link] poll orders:', e.message); }
  finally { _pollingOrders = false; }
}

// v0.9.547b — nota de venta OFICIAL desde Inventario (si publica /sales/:id/receipt).
async function _sendReceipt(tenantId, phone, saleId, link) {
  try {
    const data = await _invGet(`/api/integration/sales/${saleId}/receipt?tenant_id=${link.inv_tenant_id}`);
    const url = data && (data.url || data.pdf_url || data.receipt_url);
    if (!url) return false;
    const meta = require('./meta');
    const p = String(phone || '').replace(/\D/g, '');
    let ctx = null;
    try {
      const c = await db.query(`SELECT * FROM conversations WHERE tenant_id=$1 AND regexp_replace(COALESCE(phone,''),'\\D','','g') LIKE '%' || $2 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`, [tenantId, p.slice(-8)]);
      if (c.rows[0]) ctx = await require('./tenant-resolver').getConversationMetaCtx(c.rows[0]);
    } catch (e) {}
    if (/\.pdf(\?|$)/i.test(url) && typeof meta.sendDocument === 'function') await meta.sendDocument(p, url, `nota-venta-${saleId}.pdf`, `🧾 Tu nota de venta Nº ${saleId}`, ctx);
    else await meta.sendImage(p, url, `🧾 Tu nota de venta Nº ${saleId}`, ctx);
    console.log(`🧾 [inv-link] nota de venta oficial ${saleId} enviada`);
    return true;
  } catch (e) { return false; /* endpoint aún no publicado → solo nota en texto */ }
}

// v0.9.547 — QR DE COBRO estático del negocio (media_assets id "qr_cobro"): se manda con el total.
async function _sendPaymentQr(tenantId, phone, total) {
  const a = await db.query(`SELECT url FROM media_assets WHERE tenant_id=$1 AND asset_id='qr_cobro' AND active=TRUE AND type='image' LIMIT 1`, [tenantId]).catch(() => ({ rows: [] }));
  if (!a.rows[0] || !a.rows[0].url) return false;
  let ctx = null;
  try {
    const c = await db.query(
      `SELECT * FROM conversations WHERE tenant_id=$1 AND regexp_replace(COALESCE(phone,''),'\\D','','g') LIKE '%' || $2 ORDER BY last_message_at DESC NULLS LAST LIMIT 1`,
      [tenantId, String(phone || '').replace(/\D/g, '').slice(-8)]);
    if (c.rows[0]) ctx = await require('./tenant-resolver').getConversationMetaCtx(c.rows[0]);
  } catch (e) { /* sin ctx → token global */ }
  await require('./meta').sendImage(String(phone || '').replace(/\D/g, ''), a.rows[0].url, `💳 Pagá tu pedido — *Bs ${total}*\nEscaneá este QR con la app de tu banco.`, ctx);
  console.log(`💳 [inv-link] QR de cobro enviado (tenant ${tenantId}, Bs ${total})`);
  return true;
}

// v0.9.546 — "🛒 Venta realizada": resumen al equipo con la app (coordina el envío).
async function _notifySale(tenantId, { phone, customer, det, total, sucursal, sale_id, admin, entrega, direccion }) {
  try {
    const prefs = await require('./notify-prefs').getNotifPrefs(tenantId);
    const ev = (prefs && prefs.sale_completed) || {};
    const roles = Array.isArray(ev.push_roles) ? ev.push_roles : [];
    if (!roles.length) return; // el dueño apagó el evento
    const pn = require('./push-notifier');
    if (typeof pn.isConfigured === 'function' && !pn.isConfigured()) return;
    const p = String(phone || '').replace(/\D/g, '');
    await pn.broadcast({
      title: '🛒 Venta realizada — coordinar entrega',
      body: (`${customer} · Bs ${total} · ${sucursal || 'sucursal principal'}\n` +
        (entrega === 'envio' ? `🚚 ENVÍO a: ${direccion || 'dirección a confirmar'}\n` : (entrega === 'retiro' ? '🏬 RETIRO en sucursal\n' : '')) +
        `${String(det || '').replace(/\*/g, '')}`).slice(0, 170) + `\nVenta #${sale_id}${admin ? ' (registrada por admin)' : ''}`,
      url: '/panel/?conv=' + encodeURIComponent(p),
      conversation_phone: p,
    }, tenantId, { roles });
    console.log(`🔔 [inv-link] push "Venta realizada" (venta ${sale_id}) → roles ${roles.join(',')}`);
  } catch (e) { console.warn('[inv-link] push venta falló:', e.message); }
}

async function customerBalance(tenantId, { phone, name }) {
  const link = await getLink(tenantId);
  if (!link) return null;
  let rows = [];
  try {
    const qs = phone ? `phone=${encodeURIComponent(String(phone).replace(/\D/g, ''))}` : `name=${encodeURIComponent(name || '')}`;
    const data = await _invGet(`/api/integration/customer-balance?tenant_id=${link.inv_tenant_id}&${qs}`);
    rows = Array.isArray(data) ? data : [];
  } catch (e) {
    if (phone && name) { try { const d2 = await _invGet(`/api/integration/customer-balance?tenant_id=${link.inv_tenant_id}&name=${encodeURIComponent(name)}`); rows = Array.isArray(d2) ? d2 : []; } catch (e2) {} }
  }
  if (!rows.length) return { message: 'No encontré una cuenta a crédito a tu nombre. Si creés que es un error, decime a nombre de quién está y lo verifico. 🙌' };
  const c = rows[0];
  const overdue = Number(c.overdue) > 0 ? `\n⚠️ Vencido: Bs ${c.overdue}` : '';
  return { message: `Tu saldo pendiente es *Bs ${c.balance}*${overdue}\n(a nombre de ${c.name})` };
}

async function adminSummary(tenantId, { date }) {
  const link = await getLink(tenantId);
  if (!link) return null;
  try {
    const data = await _invGet(`/api/integration/summary?tenant_id=${link.inv_tenant_id}${date ? `&date=${encodeURIComponent(date)}` : ''}`);
    const byb = (data.by_branch || []).map(b => `• ${b.branch}: ${b.count} venta(s) — Bs ${b.total}`).join('\n');
    const top = (data.top_products || []).slice(0, 5).map(p => `• ${p.name} ×${p.qty}`).join('\n');
    return { message: `📊 *Resumen ${data.date || 'de hoy'}*\n\nVentas: ${data.sales_count} — *Bs ${data.total}*\nContado: Bs ${data.cash_total} · Crédito: Bs ${data.credit_total}${byb ? `\n\nPor sucursal:\n${byb}` : ''}${top ? `\n\nMás vendidos:\n${top}` : ''}` };
  } catch (e) {
    if (e.status === 404) return { message: 'El resumen de ventas todavía no está publicado en Inventario (falta el endpoint /summary). Avisale a José 😉' };
    return { message: 'No pude traer el resumen ahora mismo. Probá de nuevo en un momento.' };
  }
}

async function adminLowStock(tenantId) {
  const link = await getLink(tenantId);
  if (!link) return null;
  try {
    const data = await _invGet(`/api/integration/low-stock?tenant_id=${link.inv_tenant_id}`);
    const list = Array.isArray(data) ? data : (data && data.items) || [];
    if (!list.length) return { message: '👌 No hay productos con stock bajo ahora mismo.' };
    const lines = list.slice(0, 15).map(p => `• ${p.name} (${p.code}) — quedan ${p.stock}`);
    return { message: `📉 *Stock bajo:*\n\n${lines.join('\n')}` };
  } catch (e) {
    if (e.status === 404) return { message: 'El reporte de stock bajo todavía no está publicado en Inventario (falta el endpoint /low-stock).' };
    return { message: 'No pude traer el stock bajo ahora mismo. Probá de nuevo en un momento.' };
  }
}

// v0.9.548 — sucursales del negocio: en vivo (/branches, Tarea 4) → guardadas al vincular → default.
const _brCache = new Map();
async function getBranches(tenantId) {
  const link = await getLink(tenantId);
  if (!link) return [];
  const k = Number(tenantId) || 0;
  const c = _brCache.get(k);
  if (c && Date.now() - c.at < 600000) return c.v;
  let v = [];
  try {
    const data = await _invGet(`/api/integration/branches?tenant_id=${link.inv_tenant_id}`);
    v = (Array.isArray(data) ? data : (data && data.branches) || []).map(b => b.name).filter(Boolean);
  } catch (e) { /* endpoint aún no publicado */ }
  if (!v.length && Array.isArray(link.branches)) v = link.branches.map(b => (b && b.name) || b).filter(Boolean);
  if (!v.length && link.branch) v = [link.branch];
  _brCache.set(k, { at: Date.now(), v });
  return v;
}

// ── Bloques de prompt (los anexa bot-prompt-builder SOLO en modo artículos) ──
// v0.9.555 — buttonsOn (tenants.bot_buttons_enabled): los pasos cerrados del checkout llevan
// su marcador [botones:] EXPLÍCITO en los ejemplos. Causa raíz del reporte "no usa botones":
// el bloque general 🔘 sí viajaba, pero estos ejemplos literales (que el modelo imita) no
// mostraban el marcador — a diferencia de inmuebles/vehículos, donde los defaults están llenos
// de [botones:] y por eso ahí sí salen. Con el toggle OFF los ejemplos van en texto natural.
async function liveBlock(tenantId, link, buttonsOn = true) {
  const branches = await getBranches(tenantId).catch(() => []);
  // v0.9.556 — un DEPÓSITO no es una tienda (batería 8-ago: "Depósito Central" aparecía como
  // opción de retiro para el cliente). Se filtra de las opciones de RETIRO; el descuento de
  // stock del envío (link.branch) no cambia.
  const pickup = branches.filter(b => !/dep[oó]sito|almac[eé]n|bodega/i.test(String(b)));
  const multi = pickup.length > 1;
  const _brMark = multi
    ? (pickup.length <= 3
        ? ` [botones: ${pickup.slice(0, 3).join(' | ')}]`
        : ` [lista: ${pickup.slice(0, 10).join(' | ')}]`)
    : '';
  const sucRule = multi
    ? `\n• SUCURSALES REALES (únicas opciones de retiro): ${pickup.join(' · ')}. En el checkout, si el cliente RETIRA: preguntale EN CUÁL de esas sucursales retira${buttonsOn ? ` terminando tu respuesta con el marcador${_brMark}` : ' (listá las sucursales DENTRO de tu texto)'} y agregá "branch": "<nombre EXACTO de la lista>" al registrar_pedido — el stock se descuenta de ESA sucursal. Si es ENVÍO: NO pongas "branch" (despacha ${link.branch || 'la sucursal configurada'}). NUNCA inventes sucursales fuera de la lista ni ofrezcas depósitos.`
    : '';
  const btnRule = buttonsOn
    ? `\n• 🔘 BOTONES EN EL CHECKOUT (OBLIGATORIO): los pasos cerrados van SIEMPRE con su marcador al final de tu "respuesta" — paso ② entrega: [botones: Retiro en tienda | Envío a domicilio] · paso ③ confirmación del total: [botones: Sí, confirmar | Cambiar algo]. También cuando ofrezcas 2-3 alternativas concretas de producto ("¿cuál te muestro?"). El paso ① (nombre) y la dirección de envío son preguntas ABIERTAS: van SIN marcador.`
    : '';
  // v0.9.557 — candados de checkout tras la batería en vivo del 8-ago (set 2):
  // (a) "ya registré tu pedido" SIN emitir registrar_pedido (cliente creyó comprar y no existía nada),
  // (b) arrastre del pedido anterior ya anotado con QR al pedido nuevo (+50 grips fantasma),
  // (c) total inventado (Bs 2.922 con items que sumaban 2.847),
  // (d) sucursal inexistente resuelta con una "política de zonas" inventada,
  // (e) promesas de cambio/devolución y specs (sabor) que la ficha no trae.
  const guardRule = `\n• ⚠️ REGLA DURA DE REGISTRO: PROHIBIDO decir "ya registré / ya anoté / quedó registrado tu pedido" si en ese MISMO JSON no va "registrar_pedido". En el turno en que el cliente confirma, emití la acción y tu "respuesta" es SOLO una frase corta de acompañamiento ("¡Listo! Te preparo el QR 👇") — la confirmación REAL (detalle + QR + nota) la manda el SISTEMA en sus propios mensajes. JAMÁS digas que "un asesor coordinará el pago": el pago es con el QR automático de tu pedido.\n• 🧹 PEDIDO CERRADO NO SE ARRASTRA: cuando el sistema anota un pedido y manda su QR, ese pedido queda CERRADO. El próximo pedido arranca SIEMPRE de cero: NO re-sumes los productos del pedido anterior al resumen nuevo. Si el cliente quiere cambiar el pendiente, avisale que el anterior queda sin efecto si no se paga y armá el nuevo aparte.\n• 🔢 TOTAL EXACTO: el total del resumen es la suma EXACTA de (precio del catálogo × cantidad) de los items de ESTE pedido, nada más. Si el cliente corrige la lista, recalculá desde cero y volvé a mostrar el detalle.\n• 📍 SUCURSAL QUE NO EXISTE: si el cliente nombra una sucursal fuera de la lista real, decile con honestidad que esa no la tenemos y mostrale las reales para que ÉL elija${buttonsOn ? ' (con su marcador de botones/lista)' : ''}. NO le asignes vos una sucursal "por zona" ni inventes políticas de cobertura.\n• 🚫 NI SPECS NI POLÍTICAS INVENTADAS: no afirmes sabor, talla, material o variantes que la ficha no trae ("viene en sabor tradicional" NO se dice si la ficha no lo dice), y no prometas cambios, devoluciones o garantías — un reclamo se deriva al asesor con empatía y sin comprometer la solución. ⚠️ Esto vale AUNQUE VOS lo hayas dicho antes en esta misma conversación: un dato inventado NO se vuelve verdad por repetirlo — si te preguntan de nuevo, corregí ("ese detalle te lo confirma el equipo").\n• 🛑 ELEGIR SUCURSAL NO ES CONFIRMAR (batería 8-ago: se registró un pedido apenas el cliente tocó la sucursal, sin mostrarle el total): después de que elige sucursal viene SIEMPRE el paso ③ — resumen con items y TOTAL${buttonsOn ? ' + [botones: Sí, confirmar | Cambiar algo]' : ''} — y SOLO su "sí" dispara registrar_pedido. Nada de registrar directo desde la elección de sucursal o de entrega.\n• 🔤 CANTIDAD AMBIGUA: si el nombre del producto ya trae pack/par/x3 (ej. "Muñequera Par", "Grip x3") y el cliente pide "3 muñequeras", NO adivines: confirmá en una línea cuántas UNIDADES del producto quiere ("¿3 pares, o sea 3 unidades del par?") antes de sumarlo.`;
  return `\n\n══════════════════════════════════════════════════════════════\n🔗 CATÁLOGO EN VIVO — SISTEMA DE INVENTARIO (${link.name || 'conectado'})\n══════════════════════════════════════════════════════════════\n\nEste negocio tiene su sistema de Inventario CONECTADO: el catálogo de arriba viene EN VIVO de su sistema (precios y disponibilidad reales). Reglas ESPECIALES que mandan sobre las generales:\n• NO uses inventory_to_send con este catálogo (no hay fichas con foto): presentá los productos EN TEXTO con nombre y precio.\n• Para buscar o confirmar disponibilidad/precio de algo puntual, agregá en tu JSON: "consultar_inventario": { "q": "<lo que busca>" } — el sistema responde con datos reales. Usalo en vez de adivinar.\n• CHECKOUT OBLIGATORIO (en orden, un paso por mensaje, sin saltearte ninguno): cuando el cliente elija qué llevar → ① pedile su NOMBRE (si no lo sabés ya del contexto) → ② preguntá la ENTREGA: "¿retirás en tienda o te lo enviamos?"${buttonsOn ? ' — tu "respuesta" de ese paso TERMINA OBLIGATORIAMENTE con la línea [botones: Retiro en tienda | Envío a domicilio] (sin excepción: es la única forma de que el cliente vea los botones)' : ''} (si es envío, pedí zona/dirección) → ③ confirmá el RESUMEN con el total ("¿Confirmo 1 × Gatorade 500ml, total Bs 22, envío a Equipetrol?"${buttonsOn ? ' + [botones: Sí, confirmar | Cambiar algo]' : ''}). RECIÉN con el "sí" explícito del cliente, emití: "registrar_pedido": { "customer_name": "<nombre>", "items": [ { "code": "<código>", "qty": <cantidad> } ], "entrega": "retiro" | "envio", "direccion": "<dirección o null>" }. El sistema registra la venta REAL, le manda su NOTA DE VENTA con el número (y el QR de cobro del negocio si está configurado). PROHIBIDO registrar sin nombre, sin entrega definida o sin la confirmación del total.\n• Si preguntan cuánto deben (clientes a crédito): "saldo_cliente": true — el sistema busca por su teléfono.\n• 🚫 PROHIBIDO ofrecer, recomendar o prometer un producto SIN STOCK: si algo está agotado, decilo con honestidad y ofrecé la alternativa disponible más parecida. Solo se vende lo que está disponible AHORA.\n• NUNCA digas cuántas unidades quedan a un cliente: solo "disponible" o "sin stock".\n• 💳 CRÉDITO: si el cliente pide comprar A CRÉDITO, en cuotas o "pagar después": NO lo ofrezcas, NO lo negocies y NO registres el pedido. Respondé con calidez que las ventas a crédito las coordina un asesor personalmente, y en ese MISMO turno marcá "calificado": true con "reason": "qualified_lead" y score 90+ (lead caliente → el equipo lo toma). El crédito SOLO lo aprueba un humano.${btnRule}${guardRule}${sucRule}`;
}
function adminBlock(admin) {
  return `\n\n══════════════════════════════════════════════════════════════\n👑 MODO ADMINISTRADOR — este número es del EQUIPO del negocio\n══════════════════════════════════════════════════════════════\n\nQuien te escribe es ${admin.name || 'un administrador'} del negocio (número autorizado). NO le vendas: atendelo como su ASISTENTE DE GESTIÓN, con respuestas directas y concretas.\nPodés (acciones en tu JSON):\n• "resumen_ventas": { "date": "YYYY-MM-DD" | null } → ventas del día (o la fecha que pida).\n• "stock_bajo": true → qué hay que reponer.\n• "consultar_inventario": { "q": "..." } → buscar productos (a un admin SÍ podés decirle cantidades exactas de stock si te las pide, usando los datos que devuelva el sistema).\n${admin.can_transact === false ? '• Este admin NO tiene permitido registrar ventas: si lo pide, decile con respeto que su número no tiene habilitadas transacciones.' : '• "registrar_pedido": { "customer_name": "<cliente>", "items": [...] } → registrar una venta que él te dicte. SIEMPRE confirmá antes de emitir ("¿Confirmo 2 × PANO-428 para Ana, Bs 500?").'}\nSi pide algo que no podés hacer todavía, decilo con honestidad. Nada de guiones de venta, score ni calificación con este número.`;
}

module.exports = { ensureSchema, getLink, bustLink, getLiveCatalog, panelCatalog, getBranches, getAdmins, pollPendingOrders, adminFor, searchProducts, registerSale, customerBalance, adminSummary, adminLowStock, liveBlock, adminBlock, invUrl, invSecret };
