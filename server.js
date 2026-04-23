require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { Pool } = require('pg');

const app        = express();
const PORT       = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'jisunu-admin-2026-sgbolivia';
const PWA_VERSION = process.env.PWA_VERSION || '1.2.0';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

// ── PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── Init DB schema ────────────────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      tenant_id  TEXT NOT NULL DEFAULT 'default',
      key        TEXT NOT NULL,
      value      JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key)
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      token       TEXT UNIQUE NOT NULL,
      plan        TEXT DEFAULT 'standard',
      active      BOOLEAN DEFAULT true,
      notes       TEXT,
      last_desktop_version TEXT,
      last_pwa_version     TEXT,
      last_seen            TIMESTAMPTZ,
      last_pwa_seen        TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_device_os TEXT`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_device_type TEXT`);
  await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS devices JSONB DEFAULT '[]'`);

  await pool.query(`
    INSERT INTO tenants (name, token, plan, active, notes)
    VALUES ('Estancia 5M - César Moreno', 'estancia5m-2026-secreto', 'pro', true, 'Primer cliente - Estancia 5M Santa Cruz Bolivia')
    ON CONFLICT (token) DO NOTHING;
  `);

  const cesarTenant = await pool.query(`SELECT id FROM tenants WHERE token='estancia5m-2026-secreto'`);
  if (cesarTenant.rows.length) {
    const tenantId = 'tenant_' + cesarTenant.rows[0].id;
    await pool.query(`UPDATE store SET tenant_id = $1 WHERE tenant_id = 'default' AND key NOT IN (SELECT key FROM store WHERE tenant_id = $1)`, [tenantId]);
    await pool.query(`DELETE FROM store WHERE tenant_id = 'default'`);
    const tables = [
      'lots','vet_products','treatments','health_alerts','sales',
      'purchases','employees','field_activities','tasks','pesajes',
      'advances','maintenance','agua','sal','conteo','partos','alimento',
      'animals','animal_movements','lluvias','diesel','aceite',
      'cuentas','kardex','historial_sueldos','compras_ganado','backup_snapshots'
    ];
    for (const t of tables) {
      await pool.query(`INSERT INTO store(tenant_id, key, value) VALUES($1, $2, '[]') ON CONFLICT(tenant_id, key) DO NOTHING`, [tenantId, t]);
    }
  }
  console.log('[DB] Schema v4.1 ready — Multi-tenant + Bot TX');
}

// ── Helpers ───────────────────────────────────────────────────
async function getTable(tenantId, key) {
  const res = await pool.query('SELECT value FROM store WHERE tenant_id=$1 AND key=$2', [tenantId, key]);
  return res.rows.length ? res.rows[0].value : [];
}

async function setTable(tenantId, key, data) {
  await pool.query(
    `INSERT INTO store(tenant_id, key, value, updated_at) VALUES($1, $2, $3, NOW())
     ON CONFLICT(tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [tenantId, key, JSON.stringify(data)]
  );
}

function mergeById(existing, incoming) {
  const existingMap = {};
  existing.forEach(r => { existingMap[r.id] = r; });
  const merged = [...existing];
  incoming.forEach(r => { if (!existingMap[r.id]) merged.push(r); });
  return merged;
}

function generateToken() {
  return 'jisunu-' + crypto.randomBytes(8).toString('hex');
}

// ── Auth middleware (acepta header Authorization O ?token= en query) ──
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim() || (req.query.token || '');
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  try {
    const result = await pool.query('SELECT id, name, plan, active FROM tenants WHERE token=$1', [token]);
    if (!result.rows.length) return res.status(401).json({ error: 'Token inválido' });
    const tenant = result.rows[0];
    if (!tenant.active) return res.status(403).json({ error: 'Cuenta suspendida' });

    req.tenant = tenant;
    req.tenantId = 'tenant_' + tenant.id;

    const appVersion = req.headers['x-app-version'];
    const appType    = req.headers['x-app-type'] || 'desktop';
    const userAgent  = req.headers['user-agent'] || '';

    function parseDevice(ua) {
      let os = 'Unknown', type = 'desktop';
      if (/Windows/i.test(ua))        { os = 'Windows'; type = 'desktop'; }
      else if (/Macintosh|Mac OS/i.test(ua) && !/iPhone|iPad/i.test(ua)) { os = 'macOS'; type = 'desktop'; }
      else if (/Linux/i.test(ua) && !/Android/i.test(ua)) { os = 'Linux'; type = 'desktop'; }
      else if (/Android/i.test(ua))   { os = 'Android'; type = 'mobile'; }
      else if (/iPhone/i.test(ua))    { os = 'iOS'; type = 'mobile'; }
      else if (/iPad/i.test(ua))      { os = 'iPadOS'; type = 'tablet'; }
      if (/Electron/i.test(ua))       { type = 'desktop-app'; }
      return { os, type };
    }

    const { os: deviceOs, type: deviceType } = parseDevice(userAgent);
    const devResult = await pool.query('SELECT devices FROM tenants WHERE id=$1', [tenant.id]);
    const devices   = devResult.rows[0]?.devices || [];
    const devKey    = appType + '_' + deviceOs;
    const existIdx  = devices.findIndex(d => d.key === devKey);
    const devEntry  = {
      key: devKey, type: appType, os: deviceOs, device_type: deviceType,
      version: appVersion || '—', last_seen: new Date().toISOString(), ua: userAgent.slice(0, 120)
    };
    if (existIdx >= 0) devices[existIdx] = devEntry; else devices.push(devEntry);

    if (appVersion) {
      if (appType === 'pwa') {
        await pool.query('UPDATE tenants SET last_pwa_version=$1, last_pwa_seen=NOW(), last_device_os=$2, last_device_type=$3, devices=$4 WHERE id=$5', [appVersion, deviceOs, deviceType, JSON.stringify(devices), tenant.id]);
      } else {
        await pool.query('UPDATE tenants SET last_desktop_version=$1, last_seen=NOW(), last_device_os=$2, last_device_type=$3, devices=$4 WHERE id=$5', [appVersion, deviceOs, deviceType, JSON.stringify(devices), tenant.id]);
      }
    } else {
      await pool.query('UPDATE tenants SET last_seen=NOW(), last_device_os=$1, last_device_type=$2, devices=$3 WHERE id=$4', [deviceOs, deviceType, JSON.stringify(devices), tenant.id]);
    }
    next();
  } catch(e) { res.status(500).json({ error: e.message }); }
}

// ── Admin auth ────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = (req.headers['x-admin-token'] || '').trim();
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'Admin token inválido' });
  next();
}

// ── Health ────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ app: 'EstanciaPro API', version: '4.1.0', status: 'online', db: 'postgresql', multiTenant: true, timestamp: new Date().toISOString() }));
app.get('/ping', (req, res) => res.json({ ok: true }));

// ── ADMIN — Gestión de tenants ────────────────────────────────
app.get('/api/admin/tenants', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, name, token, plan, active, notes, last_desktop_version, last_pwa_version, last_seen, last_pwa_seen, created_at, last_device_os, last_device_type, devices FROM tenants ORDER BY created_at DESC`);
    const tenants = await Promise.all(result.rows.map(async t => {
      const tenantId = 'tenant_' + t.id;
      const [lots, employees, pesajes, sales, treatments] = await Promise.all([
        getTable(tenantId, 'lots'), getTable(tenantId, 'employees'), getTable(tenantId, 'pesajes'), getTable(tenantId, 'sales'), getTable(tenantId, 'treatments'),
      ]);
      const activeLots = (lots||[]).filter(l => l.status === 'activo' || l.status === 'active');
      const totalAnimals = activeLots.reduce((s, l) => s + (l.animal_count || 0), 0);
      const lastPesaje = (pesajes||[]).sort((a,b) => (b.date||'').localeCompare(a.date||''))[0];
      return {
        ...t, total_lots: activeLots.length, total_animals: totalAnimals,
        total_employees: (employees||[]).filter(e => e.active).length,
        total_sales: (sales||[]).reduce((s, v) => s + (v.total || 0), 0),
        total_treatments: (treatments||[]).length,
        last_pesaje_date: lastPesaje ? lastPesaje.date : null,
        lots_detail: activeLots.map(l => ({ code: l.code, category: l.category, animal_count: l.animal_count, avg_weight: l.avg_weight, paddock: l.paddock })),
      };
    }));
    res.json(tenants);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/tenants', adminAuth, async (req, res) => {
  try {
    const { name, plan, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name requerido' });
    const token = generateToken();
    const result = await pool.query(`INSERT INTO tenants (name, token, plan, active, notes, created_at) VALUES ($1, $2, $3, true, $4, NOW()) RETURNING id, name, token, plan`, [name, token, plan || 'standard', notes || '']);
    const tenant = result.rows[0];
    const tenantId = 'tenant_' + tenant.id;
    const tables = ['lots','vet_products','treatments','health_alerts','sales','purchases','employees','field_activities','tasks','pesajes','advances','maintenance','agua','sal','conteo','partos','alimento','animals','animal_movements','lluvias','diesel','aceite','cuentas','kardex','historial_sueldos','compras_ganado','inventory_counts'];
    for (const t of tables) { await pool.query(`INSERT INTO store(tenant_id, key, value) VALUES($1, $2, '[]') ON CONFLICT DO NOTHING`, [tenantId, t]); }
    res.json({ ok: true, tenant_id: tenantId, name: tenant.name, api_token: tenant.token, plan: tenant.plan, pwa_url: 'https://estancia5movil.netlify.app' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/admin/tenants/:id', adminAuth, async (req, res) => {
  try {
    const { active, plan, notes } = req.body;
    await pool.query('UPDATE tenants SET active=$1, plan=COALESCE($2,plan), notes=COALESCE($3,notes) WHERE id=$4', [active, plan, notes, req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Transaction (endpoint genérico para el bot de WhatsApp) ──
app.post('/api/bot-transaction', auth, async (req, res) => {
  try {
    const { type, data } = req.body;
    if (!type || !data) return res.status(400).json({ error: 'type y data requeridos' });
    const table = type;

    // Deduplicación: rechazar transacciones idénticas en los últimos 2 minutos
    const records = await getTable(req.tenantId, table);
    const list = Array.isArray(records) ? records : [];
    const now = Date.now();
    const dedupKey = JSON.stringify({ type, employee: data.employee || '', amount: data.amount || 0, product_name: data.product_name || '', desc: data.desc || '', lot_code: data.lot_code || '', total: data.total || 0, qty: data.qty || 0, reason: data.reason || '' });
    const duplicate = list.find(function(r) {
      if (!r.source || r.source !== 'whatsapp') return false;
      if (!r.created_at) return false;
      var age = now - new Date(r.created_at).getTime();
      if (age > 120000) return false; // más de 2 min = no es duplicado
      var rKey = JSON.stringify({ type, employee: r.employee || '', amount: r.amount || 0, product_name: r.product_name || '', desc: r.desc || '', lot_code: r.lot_code || '', total: r.total || 0, qty: r.qty || 0, reason: r.reason || '' });
      return rKey === dedupKey;
    });
    if (duplicate) {
      console.log('[Bot TX] DUPLICADO rechazado:', table, dedupKey.slice(0, 80));
      return res.json({ ok: true, id: duplicate.id, type: table, deduplicated: true });
    }

    data.id = table.slice(0,3) + '_' + Date.now();
    data.created_at = new Date().toISOString();
    data.source = 'whatsapp';

    // Si es tratamiento, buscar product_id y descontar del stock
    let stockMsg = '';
    if (type === 'treatments' && data.product_name) {
      const products = await getTable(req.tenantId, 'vet_products');
      const prod = products.find(p => p.name && p.name.toLowerCase() === (data.product_name || '').toLowerCase());
      if (prod) {
        data.product_id = prod.id;
        data.unit = prod.unit || 'ml';
        const totalUsed = parseFloat(data.total) || 0;
        if (totalUsed > 0) {
          prod.stock_qty = Math.round((prod.stock_qty - totalUsed) * 100) / 100;
          prod.stock_updated_at = new Date().toISOString();
          await setTable(req.tenantId, 'vet_products', products);
          stockMsg = '. Stock ' + prod.name + ': ' + prod.stock_qty + ' ' + (prod.unit || 'ml') + ' restante';
        }
      }
    }

    // Si es compra de insumo veterinario, incrementar stock
    if (type === 'purchases' && data.desc) {
      const products = await getTable(req.tenantId, 'vet_products');
      const prod = products.find(p => p.name && p.name.toLowerCase() === (data.desc || '').toLowerCase());
      if (prod) {
        data.product_id = prod.id;
        data.unit = data.unit || prod.unit || 'ml';
        data.type = 'veterinaria';
        const qty = parseFloat(data.qty) || 0;
        if (qty > 0) {
          prod.stock_qty = Math.round((prod.stock_qty + qty) * 100) / 100;
          prod.stock_updated_at = new Date().toISOString();
          await setTable(req.tenantId, 'vet_products', products);
          stockMsg = '. Stock ' + prod.name + ': ' + prod.stock_qty + ' ' + (prod.unit || 'ml') + ' (+' + qty + ')';
          // Limpiar alerta de stock bajo si ya superó el mínimo
          if (prod.stock_qty > (prod.stock_min || 0)) {
            const alerts = await getTable(req.tenantId, 'health_alerts');
            const filtered = alerts.filter(a => !(a.type === 'stock_low' && a.title && a.title.includes(prod.name) && !a.resolved));
            if (filtered.length !== alerts.length) await setTable(req.tenantId, 'health_alerts', filtered);
          }
        }
      }
    }

    // Guardar el registro (con product_id ya asignado)
    list.push(data);
    await setTable(req.tenantId, table, list);

    console.log('[Bot TX]', req.tenantId, table, data.id, stockMsg);
    res.json({ ok: true, id: data.id, type: table, stock: stockMsg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Transaction Images ──────────────────────────────────────
app.post('/api/transaction-image', auth, async (req, res) => {
  try {
    const { transaction_id, transaction_type, base64, mime_type } = req.body;
    if (!transaction_id || !base64) return res.status(400).json({ error: 'transaction_id y base64 requeridos' });
    const images = await getTable(req.tenantId, 'transaction_images');
    const list = Array.isArray(images) ? images : [];
    const record = {
      id: 'img_' + Date.now(),
      transaction_id,
      transaction_type: transaction_type || 'unknown',
      base64: base64,
      mime_type: mime_type || 'image/jpeg',
      size_kb: Math.round(base64.length / 1024),
      created_at: new Date().toISOString(),
      uploaded_by: req.body.uploaded_by || 'unknown'
    };
    list.push(record);
    await setTable(req.tenantId, 'transaction_images', list);
    console.log('[Image]', req.tenantId, record.id, record.size_kb + 'KB for', transaction_id);
    res.json({ ok: true, id: record.id, size_kb: record.size_kb });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/transaction-image/:txId', auth, async (req, res) => {
  try {
    const images = await getTable(req.tenantId, 'transaction_images');
    const img = (Array.isArray(images) ? images : []).find(i => i.transaction_id === req.params.txId);
    if (!img) return res.status(404).json({ error: 'No image' });
    res.json({ id: img.id, transaction_id: img.transaction_id, base64: img.base64, mime_type: img.mime_type, size_kb: img.size_kb, created_at: img.created_at });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/transaction-images/list', auth, async (req, res) => {
  try {
    const images = await getTable(req.tenantId, 'transaction_images');
    const list = (Array.isArray(images) ? images : []).map(i => ({ id: i.id, transaction_id: i.transaction_id, transaction_type: i.transaction_type, size_kb: i.size_kb, created_at: i.created_at }));
    res.json(list);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bot Sessions ──────────────────────────────────────────────
app.get('/api/bot-session/:phone', auth, async (req, res) => {
  try {
    const { phone } = req.params;
    const session = await getTable(req.tenantId, 'bot_session_' + phone);
    res.json(session || { history: [], pending_transaction: null, pending_image_for: null, pending_image_type: null });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot-session/:phone', auth, async (req, res) => {
  try {
    const { phone } = req.params;
    const { history, pending_transaction, pending_image_for, pending_image_type } = req.body;
    await setTable(req.tenantId, 'bot_session_' + phone, { history: history || [], pending_transaction: pending_transaction || null, pending_image_for: pending_image_for || null, pending_image_type: pending_image_type || null, updated_at: new Date().toISOString() });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Tenant branding ──────────────────────────────────────────
app.get('/api/tenant/branding', auth, async (req, res) => {
  try {
    const branding = await getTable(req.tenantId, 'branding');
    res.json(Array.isArray(branding) ? {} : branding);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tenant/branding', auth, async (req, res) => {
  try {
    const { name, logo } = req.body;
    const current = await getTable(req.tenantId, 'branding');
    const updated = { ...(Array.isArray(current) ? {} : current), ...(name !== undefined ? { name } : {}), ...(logo !== undefined ? { logo } : {}), updated_at: new Date().toISOString() };
    await setTable(req.tenantId, 'branding', updated);
    res.json({ ok: true, branding: updated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Full DB push ──────────────────────────────────────────────
app.post('/api/sync-push', auth, async (req, res) => {
  try {
    const { db, source, preserve_lots } = req.body;
    if (!db) return res.status(400).json({ error: 'db required' });
    const tenantId = req.tenantId;
    const isField  = source === 'field';
    const pushed   = {};

    // ── LOTS
    if (Array.isArray(db.lots) && db.lots.length > 0) {
      const existingLots = await getTable(tenantId, 'lots');
      if (isField) {
        const updatedLots = existingLots.map(existing => {
          const incoming = db.lots.find(l => l.id == existing.id);
          if (!incoming) return existing;
          return { ...existing, paddock: incoming.paddock || existing.paddock, animal_count: incoming.animal_count !== undefined ? incoming.animal_count : existing.animal_count, avg_weight: incoming.avg_weight || existing.avg_weight, server_updated_at: new Date().toISOString() };
        });
        db.lots.forEach(l => { if (!existingLots.find(e => e.id == l.id)) updatedLots.push(l); });
        await setTable(tenantId, 'lots', updatedLots);
        pushed.lots = updatedLots.length;
      } else if (!preserve_lots) {
        const updatedLots = existingLots.map(existing => {
          const incoming = db.lots.find(l => l.id == existing.id);
          if (!incoming) return existing;
          return { ...incoming, paddock: existing.paddock, animal_count: existing.animal_count, avg_weight: existing.avg_weight, server_updated_at: new Date().toISOString() };
        });
        db.lots.forEach(l => { if (!existingLots.find(e => e.id == l.id)) updatedLots.push(l); });
        await setTable(tenantId, 'lots', updatedLots);
        pushed.lots = updatedLots.length;
      }
    }

    // ── DESKTOP ONLY (replace)
    if (Array.isArray(db.sales))     { await setTable(tenantId, 'sales', db.sales); pushed.sales = db.sales.length; }
    if (Array.isArray(db.employees)) { await setTable(tenantId, 'employees', db.employees); pushed.employees = db.employees.length; }
    if (Array.isArray(db.alerts))    { await setTable(tenantId, 'health_alerts', db.alerts); pushed.alerts = db.alerts.length; }

    // ── PRODUCTS
    if (Array.isArray(db.products) && db.products.length > 0) {
      const existingProducts = await getTable(tenantId, 'vet_products');
      const updatedProducts = existingProducts.map(existing => {
        const incoming = db.products.find(p => p.id == existing.id);
        if (!incoming) return existing;
        const stockWins = (incoming.stock_updated_at || '') >= (existing.stock_updated_at || '') || incoming.stock_qty !== undefined;
        return { ...existing, stock_qty: stockWins && incoming.stock_qty !== undefined ? incoming.stock_qty : existing.stock_qty, stock_updated_at: stockWins ? new Date().toISOString() : existing.stock_updated_at, ...(isField ? {} : { name: incoming.name || existing.name, type: incoming.type || existing.type, unit: incoming.unit || existing.unit, stock_min: incoming.stock_min || existing.stock_min, unit_cost: incoming.unit_cost || existing.unit_cost, supplier: incoming.supplier || existing.supplier, expiry_date: incoming.expiry_date || existing.expiry_date }), server_updated_at: new Date().toISOString() };
      });
      if (!isField) { db.products.forEach(p => { if (!existingProducts.find(e => e.id == p.id)) updatedProducts.push(p); }); }
      await setTable(tenantId, 'vet_products', updatedProducts);
      pushed.vet_products = updatedProducts.length;
    }

    // ── PURCHASES
    if (Array.isArray(db.purchases) && db.purchases.length > 0) {
      const existing = await getTable(tenantId, 'purchases');
      const existingMap = {};
      existing.forEach(r => { existingMap[r.id] = r; });
      const merged = existing.map(r => { const inc = db.purchases.find(p => p.id == r.id); return inc ? { ...r, ...inc } : r; });
      db.purchases.forEach(p => { if (!existingMap[p.id]) merged.push(p); });
      await setTable(tenantId, 'purchases', merged);
      pushed.purchases = merged.length;
    }

    // ── FIELD TABLES (merge por ID)
    const FIELD_TABLES = {
      treatments:'treatments', pesajes:'pesajes', maintenance:'maintenance',
      agua:'agua', sal:'sal', conteo:'conteo', partos:'partos', alimento:'alimento',
      lluvias:'lluvias', diesel:'diesel', aceite:'aceite',
      cuentas:'cuentas', kardex:'kardex', historial_sueldos:'historial_sueldos',
      compras_ganado:'compras_ganado',
    };
    for (const [dbKey, tableKey] of Object.entries(FIELD_TABLES)) {
      if (Array.isArray(db[dbKey]) && db[dbKey].length > 0) {
        const existing = await getTable(tenantId, tableKey);
        const merged = mergeById(existing, db[dbKey]);
        await setTable(tenantId, tableKey, merged);
        pushed[tableKey] = merged.length;
      }
    }

    // ── ACTIVIDADES Y ADELANTOS
    if (Array.isArray(db.activities) && db.activities.length > 0) {
      const existing = await getTable(tenantId, 'field_activities');
      await setTable(tenantId, 'field_activities', mergeById(existing, db.activities));
      pushed.field_activities = (await getTable(tenantId, 'field_activities')).length;
    }
    if (Array.isArray(db.advances) && db.advances.length > 0) {
      const existing = await getTable(tenantId, 'advances');
      await setTable(tenantId, 'advances', mergeById(existing, db.advances));
      pushed.advances = (await getTable(tenantId, 'advances')).length;
    }

    // ── TASKS
    if (db.tasks_list && Array.isArray(db.tasks_list)) {
      if (req.body.tasks_replace) {
        await setTable(tenantId, 'tasks', db.tasks_list);
        pushed.tasks = db.tasks_list.length;
      } else {
        const existing = await getTable(tenantId, 'tasks');
        const mergedTasks = existing.map(t => {
          const incoming = db.tasks_list.find(x => x.id === t.id);
          if (!incoming) return t;
          const wins = (incoming.updated_at || '') >= (t.updated_at || '');
          return { ...t, title: incoming.title || t.title, desc: incoming.desc || t.desc, assignee: incoming.assignee || t.assignee, priority: incoming.priority || t.priority, due: incoming.due || t.due, lot: incoming.lot || t.lot, status: wins ? incoming.status : t.status, completed_at: wins ? incoming.completed_at : t.completed_at, updated_at: wins ? incoming.updated_at : t.updated_at, comment: wins ? (incoming.comment || t.comment) : (t.comment || incoming.comment), comment_by: wins ? (incoming.comment_by || t.comment_by) : (t.comment_by || incoming.comment_by), comment_at: wins ? (incoming.comment_at || t.comment_at) : (t.comment_at || incoming.comment_at) };
        });
        db.tasks_list.forEach(t => { if (!existing.find(e => e.id === t.id)) mergedTasks.push(t); });
        await setTable(tenantId, 'tasks', mergedTasks);
        pushed.tasks = mergedTasks.length;
      }
    }

    // ── ANIMALS
    if (db.animals && !isField && typeof db.animals === 'object' && Object.keys(db.animals).length > 0) {
      await setTable(tenantId, 'animals', db.animals);
      pushed.animals = 'ok';
    }

    res.json({ ok: true, pushed, tenant: req.tenant.name, timestamp: new Date().toISOString() });

    // Backup silencioso cada 6 horas
    setImmediate(async () => {
      try {
        const allTables = ['lots','vet_products','treatments','health_alerts','sales','purchases','employees','field_activities','tasks','pesajes','advances','maintenance','agua','sal','conteo','partos','alimento','animals','animal_movements','lluvias','diesel','aceite','cuentas','kardex','historial_sueldos','compras_ganado'];
        const snapshots = await getTable(tenantId, 'backup_snapshots');
        const last = snapshots[0];
        const hrs = last ? (Date.now() - new Date(last.created_at).getTime()) / 3600000 : 999;
        if (hrs > 6) {
          const snapshot = { timestamp: new Date().toISOString(), tenant: req.tenant.name, tables: {} };
          for (const t of allTables) { snapshot.tables[t] = await getTable(tenantId, t); }
          snapshots.unshift({ id: Date.now().toString(), created_at: new Date().toISOString(), size_kb: Math.round(JSON.stringify(snapshot).length / 1024), triggered_by: 'auto-push', data: snapshot });
          await setTable(tenantId, 'backup_snapshots', snapshots.slice(0, 30));
        }
      } catch(e) { console.error('[Backup] Error:', e.message); }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Full DB pull ──────────────────────────────────────────────
app.get('/api/sync-pull', auth, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const [lots, products, treatments, health_alerts, sales, purchases,
           employees, field_activities, tasks, pesajes, advances, maintenance,
           agua, sal, conteo, partos, alimento, animals, animal_movements,
           lluvias, diesel, aceite, cuentas, kardex, historial_sueldos, compras_ganado] = await Promise.all([
      getTable(tenantId,'lots'), getTable(tenantId,'vet_products'), getTable(tenantId,'treatments'),
      getTable(tenantId,'health_alerts'), getTable(tenantId,'sales'), getTable(tenantId,'purchases'),
      getTable(tenantId,'employees'), getTable(tenantId,'field_activities'), getTable(tenantId,'tasks'),
      getTable(tenantId,'pesajes'), getTable(tenantId,'advances'), getTable(tenantId,'maintenance'),
      getTable(tenantId,'agua'), getTable(tenantId,'sal'), getTable(tenantId,'conteo'),
      getTable(tenantId,'partos'), getTable(tenantId,'alimento'), getTable(tenantId,'animals'),
      getTable(tenantId,'animal_movements'), getTable(tenantId,'lluvias'), getTable(tenantId,'diesel'),
      getTable(tenantId,'aceite'), getTable(tenantId,'cuentas'), getTable(tenantId,'kardex'),
      getTable(tenantId,'historial_sueldos'), getTable(tenantId,'compras_ganado'),
    ]);

    const validLots = lots.filter(l => {
      const status = (l.status || '').toLowerCase();
      if (status === 'sold' || status === 'vendido') return false;
      if (status === 'active' && (!l.animal_count || l.animal_count === 0)) return false;
      return true;
    });

    const branding = await getTable(tenantId, 'branding');
    res.json({
      lots: validLots, products, treatments, health_alerts, sales, purchases,
      employees, field_activities, tasks, pesajes, advances, maintenance,
      agua, sal, conteo, partos, alimento, animals, animal_movements,
      lluvias, diesel, aceite, cuentas, kardex, historial_sueldos, compras_ganado,
      branding: Array.isArray(branding) ? {} : (branding || {}),
      pwa_latest_version: PWA_VERSION, timestamp: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete lot by code ────────────────────────────────────────
app.delete('/api/lots/by-code/:code', auth, async (req, res) => {
  try {
    const existing = await getTable(req.tenantId, 'lots');
    const filtered = existing.filter(l => l.code !== req.params.code);
    await setTable(req.tenantId, 'lots', filtered);
    res.json({ ok: true, deleted: req.params.code });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Animal move ───────────────────────────────────────────────
app.post('/api/animal-move', auth, async (req, res) => {
  try {
    const { animal_id, from_lot, to_lot, date, by, source } = req.body;
    if (!animal_id || !to_lot) return res.status(400).json({ error: 'animal_id and to_lot required' });
    const tenantId = req.tenantId;
    const movements = await getTable(tenantId, 'animal_movements');
    const newMove = { id: Date.now().toString(), animal_id: animal_id.toString(), from_lot: from_lot || '', to_lot, date: date || new Date().toISOString().slice(0,10), by: by || 'Sistema', source: source || 'desktop', created_at: new Date().toISOString() };
    movements.push(newMove);
    await setTable(tenantId, 'animal_movements', movements);
    const animals = await getTable(tenantId, 'animals');
    if (typeof animals === 'object' && !Array.isArray(animals)) {
      let animalData = null;
      Object.keys(animals).forEach(lot => {
        const found = (animals[lot] || []).find(a => (a.animal_id || a.id || '').toString() === animal_id.toString());
        if (found) { animalData = found; animals[lot] = animals[lot].filter(a => a !== found); }
      });
      if (!animals[to_lot]) animals[to_lot] = [];
      animals[to_lot].push(animalData || { animal_id: animal_id.toString(), breed: '', pesajes: [] });
      await setTable(tenantId, 'animals', animals);
    }
    res.json({ ok: true, movement: newMove });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Tasks bulk ────────────────────────────────────────────────
app.post('/api/tasks/bulk', auth, async (req, res) => {
  try {
    const { tasks, replace_all } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
    if (replace_all) { await setTable(req.tenantId, 'tasks', tasks); return res.json({ ok: true, count: tasks.length }); }
    const existing = await getTable(req.tenantId, 'tasks');
    const merged = existing.map(t => {
      const inc = tasks.find(x => x.id === t.id);
      if (!inc) return t;
      const wins = (inc.updated_at || '') >= (t.updated_at || '');
      return { ...t, title: inc.title || t.title, desc: inc.desc || t.desc, assignee: inc.assignee || t.assignee, priority: inc.priority || t.priority, due: inc.due || t.due, lot: inc.lot || t.lot, status: wins ? inc.status : t.status, completed_at: wins ? inc.completed_at : t.completed_at, updated_at: wins ? inc.updated_at : t.updated_at, comment: wins ? (inc.comment || t.comment) : (t.comment || inc.comment) };
    });
    tasks.forEach(t => { if (!existing.find(e => e.id === t.id)) merged.push(t); });
    await setTable(req.tenantId, 'tasks', merged);
    res.json({ ok: true, count: merged.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bulk push single table (replace) ──────────────────────────
app.post('/api/bulk-push', auth, async (req, res) => {
  try {
    const { table, records } = req.body;
    if (!table || !Array.isArray(records)) return res.status(400).json({ error: 'table and records required' });
    await setTable(req.tenantId, table, records);
    res.json({ ok: true, table, count: records.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cloud Backup ──────────────────────────────────────────────
app.post('/api/cloud-backup', auth, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const tables = ['lots','vet_products','treatments','health_alerts','sales','purchases','employees','field_activities','tasks','pesajes','advances','maintenance','agua','sal','conteo','partos','alimento','animals','animal_movements','lluvias','diesel','aceite','cuentas','kardex','historial_sueldos','compras_ganado'];
    const snapshot = { timestamp: new Date().toISOString(), tenant: req.tenant.name, tables: {} };
    for (const t of tables) { snapshot.tables[t] = await getTable(tenantId, t); }
    const snapshots = await getTable(tenantId, 'backup_snapshots');
    snapshots.push({ id: Date.now().toString(), created_at: new Date().toISOString(), size_kb: Math.round(JSON.stringify(snapshot).length / 1024), triggered_by: req.body.triggered_by || 'manual', data: snapshot });
    await setTable(tenantId, 'backup_snapshots', snapshots.sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0, 30));
    res.json({ ok: true, id: snapshots[0].id, created_at: snapshots[0].created_at, size_kb: snapshots[0].size_kb });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cloud-backup/list', auth, async (req, res) => {
  try {
    const snapshots = await getTable(req.tenantId, 'backup_snapshots');
    res.json(snapshots.sort((a,b) => b.created_at.localeCompare(a.created_at)).map(s => ({ id: s.id, created_at: s.created_at, size_kb: s.size_kb, triggered_by: s.triggered_by })));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cloud-backup/:id', auth, async (req, res) => {
  try {
    const snapshots = await getTable(req.tenantId, 'backup_snapshots');
    const snap = snapshots.find(s => s.id === req.params.id);
    if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
    res.json(snap.data);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Restaurar snapshot: reescribe TODAS las tablas desde un snapshot guardado
app.post('/api/cloud-backup/:id/restore', auth, async (req, res) => {
  try {
    const tenantId = req.tenantId;
    const snapshots = await getTable(tenantId, 'backup_snapshots');
    const snap = snapshots.find(s => s.id === req.params.id);
    if (!snap || !snap.data || !snap.data.tables) return res.status(404).json({ error: 'Snapshot not found or invalid' });

    // Crear un snapshot de seguridad antes de restaurar
    const allTables = Object.keys(snap.data.tables);
    const safetySnap = { timestamp: new Date().toISOString(), tenant: req.tenant.name, tables: {} };
    for (const t of allTables) { safetySnap.tables[t] = await getTable(tenantId, t); }
    snapshots.unshift({ id: 'pre-restore-' + Date.now(), created_at: new Date().toISOString(), size_kb: Math.round(JSON.stringify(safetySnap).length / 1024), triggered_by: 'pre-restore', data: safetySnap });
    await setTable(tenantId, 'backup_snapshots', snapshots.slice(0, 30));

    // Restaurar cada tabla desde el snapshot
    let restored = 0;
    for (const [table, data] of Object.entries(snap.data.tables)) {
      if (Array.isArray(data) || typeof data === 'object') {
        await setTable(tenantId, table, data);
        restored++;
      }
    }

    console.log('[Restore]', tenantId, 'restored', restored, 'tables from snapshot', snap.id, '(' + snap.created_at + ')');
    res.json({ ok: true, restored_tables: restored, snapshot_date: snap.created_at, safety_snapshot: 'pre-restore-' + Date.now() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup', auth, async (req, res) => {
  try {
    const tables = ['lots','vet_products','treatments','health_alerts','sales','purchases','employees','field_activities','tasks','pesajes','advances','maintenance','agua','sal','conteo','partos','alimento','animals','animal_movements','lluvias','diesel','aceite','cuentas','kardex','historial_sueldos','compras_ganado'];
    const backup = { timestamp: new Date().toISOString(), tenant: req.tenant.name, tables: {} };
    for (const t of tables) { backup.tables[t] = await getTable(req.tenantId, t); }
    res.json(backup);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Generic CRUD ──────────────────────────────────────────────
function makeCRUD(tableKey) {
  const router = express.Router();
  router.get('/', auth, async (req, res) => { try { res.json(await getTable(req.tenantId, tableKey)); } catch(e) { res.status(500).json({ error: e.message }); } });
  router.post('/', auth, async (req, res) => {
    try {
      const rows = await getTable(req.tenantId, tableKey);
      const data = { ...req.body, server_updated_at: new Date().toISOString() };
      const idx = rows.findIndex(r => r.id == data.id);
      if (idx >= 0) rows[idx] = data; else rows.push(data);
      await setTable(req.tenantId, tableKey, rows);
      res.status(201).json(data);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  router.put('/:id', auth, async (req, res) => {
    try {
      const rows = await getTable(req.tenantId, tableKey);
      const idx = rows.findIndex(r => r.id == req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Not found' });
      rows[idx] = { ...rows[idx], ...req.body, server_updated_at: new Date().toISOString() };
      await setTable(req.tenantId, tableKey, rows);
      res.json(rows[idx]);
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  router.delete('/:id', auth, async (req, res) => {
    try {
      const rows = await getTable(req.tenantId, tableKey);
      const filtered = rows.filter(r => r.id != req.params.id);
      if (filtered.length === rows.length) return res.status(404).json({ error: 'Not found' });
      await setTable(req.tenantId, tableKey, filtered);
      res.json({ deleted: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
  return router;
}

app.use('/api/lots',             makeCRUD('lots'));
app.use('/api/vet-products',     makeCRUD('vet_products'));
app.use('/api/products',         makeCRUD('vet_products'));
app.use('/api/treatments',       makeCRUD('treatments'));
app.use('/api/health-alerts',    makeCRUD('health_alerts'));
app.use('/api/sales',            makeCRUD('sales'));
app.use('/api/purchases',        makeCRUD('purchases'));
app.use('/api/employees',        makeCRUD('employees'));
app.use('/api/field-activities', makeCRUD('field_activities'));
app.use('/api/tasks',            makeCRUD('tasks'));
app.use('/api/pesajes',          makeCRUD('pesajes'));
app.use('/api/advances',         makeCRUD('advances'));
app.use('/api/maintenance',      makeCRUD('maintenance'));
app.use('/api/agua',             makeCRUD('agua'));
app.use('/api/sal',              makeCRUD('sal'));
app.use('/api/conteo',           makeCRUD('conteo'));
app.use('/api/partos',           makeCRUD('partos'));
app.use('/api/alimento',         makeCRUD('alimento'));

// ── Auto backup cada 24 horas ─────────────────────────────────
setInterval(async () => {
  try {
    const tenants = await pool.query('SELECT id, name FROM tenants WHERE active=true');
    for (const tenant of tenants.rows) {
      const tenantId = 'tenant_' + tenant.id;
      const tables = ['lots','vet_products','treatments','sales','purchases','employees','pesajes','advances'];
      const snapshot = { timestamp: new Date().toISOString(), tenant: tenant.name, tables: {} };
      for (const t of tables) { snapshot.tables[t] = await getTable(tenantId, t); }
      const snapshots = await getTable(tenantId, 'backup_snapshots');
      snapshots.push({ id: Date.now().toString(), created_at: new Date().toISOString(), size_kb: Math.round(JSON.stringify(snapshot).length / 1024), triggered_by: 'auto', data: snapshot });
      await setTable(tenantId, 'backup_snapshots', snapshots.sort((a,b) => b.created_at.localeCompare(a.created_at)).slice(0, 30));
    }
    console.log('[AutoBackup] Snapshots guardados para', tenants.rows.length, 'tenants');
  } catch(e) { console.error('[AutoBackup] Error:', e.message); }
}, 24 * 60 * 60 * 1000);

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => { console.log(`[API] EstanciaPro v4.1 — Multi-tenant + Bot TX — Puerto ${PORT}`); });
}).catch(err => { console.error('[DB] Error:', err.message); process.exit(1); });
