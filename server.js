require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  // Tabla de clientes (tenants)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      plan       TEXT NOT NULL DEFAULT 'standard',
      active     BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      notes      TEXT
    );
  `);

  // Tabla de datos con tenant_id
  await pool.query(`
    CREATE TABLE IF NOT EXISTS store (
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
      key        TEXT NOT NULL,
      value      JSONB NOT NULL DEFAULT '[]',
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (tenant_id, key)
    );
  `);

  // Crear cliente por defecto (Estancia 5M - Cesar Moreno)
  const defaultToken = process.env.API_TOKEN || 'estancia5m-2026-secreto';
  await pool.query(`
    INSERT INTO tenants (name, token, plan, notes)
    VALUES ($1, $2, 'standard', 'Primer cliente - Estancia 5M Santa Cruz Bolivia')
    ON CONFLICT (token) DO NOTHING
  `, ['Estancia 5M - Cesar Moreno', defaultToken]);

  // Inicializar tablas vacias para todos los tenants activos
  const tables = [
    'lots','vet_products','treatments','health_alerts','sales',
    'purchases','employees','field_activities','tasks','pesajes',
    'advances','maintenance','agua','sal','conteo','partos','alimento'
  ];
  const tenants = await pool.query(`SELECT id FROM tenants WHERE active = true`);
  for (const tenant of tenants.rows) {
    for (const t of tables) {
      await pool.query(`
        INSERT INTO store (tenant_id, key, value)
        VALUES ($1, $2, '[]')
        ON CONFLICT (tenant_id, key) DO NOTHING
      `, [tenant.id, t]);
    }
  }
  console.log('[DB] Multi-tenant schema listo');
}

async function getTable(tenantId, key) {
  const res = await pool.query(
    'SELECT value FROM store WHERE tenant_id=$1 AND key=$2',
    [tenantId, key]
  );
  return res.rows.length ? res.rows[0].value : [];
}

async function setTable(tenantId, key, data) {
  await pool.query(`
    INSERT INTO store (tenant_id, key, value, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (tenant_id, key)
    DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()
  `, [tenantId, key, JSON.stringify(data)]);
}

function mergeById(existing, incoming) {
  const map = {};
  existing.forEach(r => { map[r.id] = r; });
  const merged = [...existing];
  incoming.forEach(r => { if (!map[r.id]) merged.push(r); });
  return merged;
}

// Auth multi-tenant: busca el tenant por token
async function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Token requerido' });
  try {
    const result = await pool.query(
      'SELECT id, name, plan, active FROM tenants WHERE token = $1', [token]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Token invalido' });
    if (!result.rows[0].active) return res.status(403).json({ error: 'Licencia inactiva. Contacta a SG Bolivia.' });
    req.tenantId   = result.rows[0].id;
    req.tenantName = result.rows[0].name;
    next();
  } catch(e) { res.status(500).json({ error: 'Error auth: ' + e.message }); }
}

// Auth admin: solo con ADMIN_TOKEN para gestionar clientes
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (token !== (process.env.ADMIN_TOKEN || 'sgbolivia-admin-2026')) {
    return res.status(401).json({ error: 'Admin token requerido' });
  }
  next();
}

app.get('/', (req, res) => res.json({ app:'Jisunu5M API', version:'4.0.0', status:'online', db:'postgresql-multi-tenant' }));
app.get('/ping', (req, res) => res.json({ ok: true }));

// ADMIN: crear nuevo cliente
app.post('/api/admin/tenants', adminAuth, async (req, res) => {
  try {
    const { name, token, plan, notes } = req.body;
    if (!name || !token) return res.status(400).json({ error: 'name y token requeridos' });
    const result = await pool.query(
      `INSERT INTO tenants (name, token, plan, notes) VALUES ($1,$2,$3,$4) RETURNING id, name, plan, active, created_at`,
      [name, token, plan || 'standard', notes || '']
    );
    const tid = result.rows[0].id;
    const tables = ['lots','vet_products','treatments','health_alerts','sales','purchases','employees','field_activities','tasks','pesajes','advances','maintenance','agua','sal','conteo','partos','alimento'];
    for (const t of tables) {
      await pool.query(`INSERT INTO store (tenant_id, key, value) VALUES ($1,$2,'[]') ON CONFLICT DO NOTHING`, [tid, t]);
    }
    console.log(`[ADMIN] Nuevo tenant: ${name} (id=${tid})`);
    res.status(201).json({ ok: true, tenant: result.rows[0] });
  } catch(e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Token ya existe' });
    res.status(500).json({ error: e.message });
  }
});

// ADMIN: listar clientes
app.get('/api/admin/tenants', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT t.id, t.name, t.plan, t.active, t.created_at, t.notes,
        (SELECT MAX(s.updated_at) FROM store s WHERE s.tenant_id=t.id) as last_sync
      FROM tenants t ORDER BY t.created_at DESC
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ADMIN: activar/desactivar cliente (cortar acceso si no paga)
app.patch('/api/admin/tenants/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('UPDATE tenants SET active=$1 WHERE id=$2', [req.body.active, req.params.id]);
    res.json({ ok: true, id: req.params.id, active: req.body.active });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SYNC PUSH
app.post('/api/sync-push', auth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const { db, source, preserve_lots, tasks_replace } = req.body;
    if (!db) return res.status(400).json({ error: 'db required' });
    const isField = source === 'field';
    const pushed = {};

    if (Array.isArray(db.lots) && db.lots.length > 0) {
      const existingLots = await getTable(tid, 'lots');
      if (isField) {
        const upd = existingLots.map(ex => {
          const inc = db.lots.find(l => l.id == ex.id);
          if (!inc) return ex;
          return { ...ex, paddock: inc.paddock||ex.paddock, animal_count: inc.animal_count!==undefined?inc.animal_count:ex.animal_count, avg_weight: inc.avg_weight||ex.avg_weight, server_updated_at: new Date().toISOString() };
        });
        db.lots.forEach(l => { if (!existingLots.find(e => e.id==l.id)) upd.push(l); });
        await setTable(tid, 'lots', upd); pushed.lots = upd.length;
      } else if (!preserve_lots) {
        const upd = existingLots.map(ex => {
          const inc = db.lots.find(l => l.id == ex.id);
          if (!inc) return ex;
          return { ...inc, paddock: ex.paddock, animal_count: ex.animal_count, avg_weight: ex.avg_weight, server_updated_at: new Date().toISOString() };
        });
        db.lots.forEach(l => { if (!existingLots.find(e => e.id==l.id)) upd.push(l); });
        await setTable(tid, 'lots', upd); pushed.lots = upd.length;
      }
    }

    for (const [k,t] of Object.entries({ sales:'sales', employees:'employees', alerts:'health_alerts' })) {
      if (Array.isArray(db[k])) { await setTable(tid, t, db[k]); pushed[t]=db[k].length; }
    }

    if (Array.isArray(db.products) && db.products.length > 0) {
      const ex = await getTable(tid, 'vet_products');
      const upd = ex.map(e => {
        const inc = db.products.find(p => p.id==e.id); if (!inc) return e;
        const sWins = (inc.stock_updated_at||inc.server_updated_at||'') >= (e.stock_updated_at||e.server_updated_at||'') || inc.stock_qty!==undefined;
        return { ...e, stock_qty: sWins&&inc.stock_qty!==undefined?inc.stock_qty:e.stock_qty, stock_updated_at: sWins?new Date().toISOString():e.stock_updated_at, ...(isField?{}:{name:inc.name||e.name,type:inc.type||e.type,unit:inc.unit||e.unit,stock_min:inc.stock_min||e.stock_min,unit_cost:inc.unit_cost||e.unit_cost,supplier:inc.supplier||e.supplier,expiry_date:inc.expiry_date||e.expiry_date}), server_updated_at:new Date().toISOString() };
      });
      if (!isField) db.products.forEach(p => { if (!ex.find(e => e.id==p.id)) upd.push(p); });
      await setTable(tid, 'vet_products', upd); pushed.vet_products=upd.length;
    }

    if (Array.isArray(db.purchases) && db.purchases.length > 0) {
      const ex = await getTable(tid, 'purchases'); const exMap={};
      ex.forEach(r => { exMap[r.id]=r; });
      const merged = ex.map(r => { const inc=db.purchases.find(p=>p.id==r.id); return inc?{...r,...inc}:r; });
      db.purchases.forEach(p => { if (!exMap[p.id]) merged.push(p); });
      await setTable(tid, 'purchases', merged); pushed.purchases=merged.length;
    }

    if (Array.isArray(db.maintenance) && db.maintenance.length > 0) {
      const ex = await getTable(tid, 'maintenance');
      await setTable(tid, 'maintenance', mergeById(ex, db.maintenance));
      pushed.maintenance=(await getTable(tid,'maintenance')).length;
    }

    for (const [k,t] of Object.entries({ treatments:'treatments',pesajes:'pesajes',agua:'agua',sal:'sal',conteo:'conteo',partos:'partos',alimento:'alimento' })) {
      if (Array.isArray(db[k]) && db[k].length > 0) {
        const ex = await getTable(tid, t);
        await setTable(tid, t, mergeById(ex, db[k]));
        pushed[t]=(await getTable(tid,t)).length;
      }
    }

    for (const [k,t] of Object.entries({ activities:'field_activities', advances:'advances' })) {
      if (Array.isArray(db[k]) && db[k].length > 0) {
        const ex = await getTable(tid, t);
        await setTable(tid, t, mergeById(ex, db[k]));
        pushed[t]=(await getTable(tid,t)).length;
      }
    }

    if (db.tasks_list && Array.isArray(db.tasks_list)) {
      if (tasks_replace) {
        await setTable(tid, 'tasks', db.tasks_list); pushed.tasks=db.tasks_list.length;
      } else {
        const ex = await getTable(tid, 'tasks');
        const merged = ex.map(t => {
          const inc = db.tasks_list.find(x => x.id===t.id); if (!inc) return t;
          const iw = (inc.updated_at||'') >= (t.updated_at||'');
          return { ...t, title:inc.title||t.title, desc:inc.desc||t.desc, assignee:inc.assignee||t.assignee, priority:inc.priority||t.priority, due:inc.due||t.due, lot:inc.lot||t.lot, status:iw?inc.status:t.status, completed_at:iw?inc.completed_at:t.completed_at, updated_at:iw?inc.updated_at:t.updated_at, comment:iw?(inc.comment||t.comment):(t.comment||inc.comment), comment_by:iw?(inc.comment_by||t.comment_by):(t.comment_by||inc.comment_by), comment_at:iw?(inc.comment_at||t.comment_at):(t.comment_at||inc.comment_at) };
        });
        db.tasks_list.forEach(t => { if (!ex.find(e => e.id===t.id)) merged.push(t); });
        await setTable(tid, 'tasks', merged); pushed.tasks=merged.length;
      }
    }

    res.json({ ok:true, tenant:req.tenantName, pushed, timestamp:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// SYNC PULL
app.get('/api/sync-pull', auth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const [lots,products,treatments,health_alerts,sales,purchases,employees,field_activities,tasks,pesajes,advances,maintenance,agua,sal,conteo,partos,alimento] = await Promise.all([
      getTable(tid,'lots'),getTable(tid,'vet_products'),getTable(tid,'treatments'),getTable(tid,'health_alerts'),getTable(tid,'sales'),getTable(tid,'purchases'),
      getTable(tid,'employees'),getTable(tid,'field_activities'),getTable(tid,'tasks'),getTable(tid,'pesajes'),getTable(tid,'advances'),getTable(tid,'maintenance'),
      getTable(tid,'agua'),getTable(tid,'sal'),getTable(tid,'conteo'),getTable(tid,'partos'),getTable(tid,'alimento'),
    ]);
    res.json({ lots,products,treatments,health_alerts,sales,purchases,employees,field_activities,tasks,pesajes,advances,maintenance,agua,sal,conteo,partos,alimento,tenant:req.tenantName,timestamp:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// TASKS BULK
app.post('/api/tasks/bulk', auth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const { tasks, replace_all } = req.body;
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks must be array' });
    if (replace_all) { await setTable(tid,'tasks',tasks); return res.json({ ok:true, count:tasks.length }); }
    const ex = await getTable(tid,'tasks');
    const merged = ex.map(t => {
      const inc=tasks.find(x=>x.id===t.id); if (!inc) return t;
      const iw=(inc.updated_at||'')>=(t.updated_at||'');
      return { ...t, title:inc.title||t.title, desc:inc.desc||t.desc, assignee:inc.assignee||t.assignee, priority:inc.priority||t.priority, due:inc.due||t.due, lot:inc.lot||t.lot, status:iw?inc.status:t.status, updated_at:iw?inc.updated_at:t.updated_at, comment:iw?(inc.comment||t.comment):(t.comment||inc.comment), comment_by:iw?(inc.comment_by||t.comment_by):(t.comment_by||inc.comment_by), comment_at:iw?(inc.comment_at||t.comment_at):(t.comment_at||inc.comment_at) };
    });
    tasks.forEach(t => { if (!ex.find(e=>e.id===t.id)) merged.push(t); });
    await setTable(tid,'tasks',merged);
    res.json({ ok:true, count:merged.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// BULK PUSH tabla individual
app.post('/api/bulk-push', auth, async (req, res) => {
  try {
    const { table, records } = req.body;
    if (!table || !Array.isArray(records)) return res.status(400).json({ error: 'table y records requeridos' });
    await setTable(req.tenantId, table, records);
    res.json({ ok:true, table, count:records.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// BACKUP completo del tenant
app.get('/api/backup', auth, async (req, res) => {
  try {
    const tid = req.tenantId;
    const tables = ['lots','vet_products','treatments','health_alerts','sales','purchases','employees','field_activities','tasks','pesajes','advances','maintenance','agua','sal','conteo','partos','alimento'];
    const backup = { tenant:req.tenantName, timestamp:new Date().toISOString(), tables:{} };
    for (const t of tables) { backup.tables[t] = await getTable(tid, t); }
    res.setHeader('Content-Disposition', `attachment; filename="backup_${req.tenantName.replace(/\s+/g,'_')}_${new Date().toISOString().split('T')[0]}.json"`);
    res.json(backup);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CRUD generico por tenant
function makeCRUD(tableKey) {
  const router = express.Router();
  router.get('/', auth, async (req, res) => { try { res.json(await getTable(req.tenantId, tableKey)); } catch(e) { res.status(500).json({ error:e.message }); } });
  router.post('/', auth, async (req, res) => {
    try {
      const rows = await getTable(req.tenantId, tableKey);
      const data = { ...req.body, server_updated_at: new Date().toISOString() };
      const idx = rows.findIndex(r => r.id==data.id);
      if (idx>=0) rows[idx]=data; else rows.push(data);
      await setTable(req.tenantId, tableKey, rows);
      res.status(201).json(data);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });
  router.put('/:id', auth, async (req, res) => {
    try {
      const rows = await getTable(req.tenantId, tableKey);
      const idx = rows.findIndex(r => r.id==req.params.id);
      if (idx===-1) return res.status(404).json({ error:'Not found' });
      rows[idx] = { ...rows[idx], ...req.body, server_updated_at: new Date().toISOString() };
      await setTable(req.tenantId, tableKey, rows);
      res.json(rows[idx]);
    } catch(e) { res.status(500).json({ error:e.message }); }
  });
  router.delete('/:id', auth, async (req, res) => {
    try {
      const rows = await getTable(req.tenantId, tableKey);
      await setTable(req.tenantId, tableKey, rows.filter(r => r.id!=req.params.id));
      res.json({ deleted:true });
    } catch(e) { res.status(500).json({ error:e.message }); }
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

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`[API] Jisunu5M v4.0 Multi-tenant en puerto ${PORT}`);
    console.log(`[API] Admin: usar ADMIN_TOKEN en variables de Railway`);
  });
}).catch(err => { console.error('[DB] Error:', err.message); process.exit(1); });
