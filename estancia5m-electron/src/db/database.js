const path = require('path');
const fs = require('fs');
const { app } = require('electron');

let SQL;
let db;
let dbPath;

async function initialize() {
  const initSqlJs = require('sql.js');
  const wasmPath = app.isPackaged
    ? path.join(process.resourcesPath, 'sql-wasm.wasm')
    : path.join(__dirname, '../../node_modules/sql.js/dist/sql-wasm.wasm');

  SQL = await initSqlJs({ locateFile: () => wasmPath });
  dbPath = path.join(app.getPath('userData'), 'estancia5m.db');

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON;');
  createTables();
  seedInitialData();
  persistToDisk();
  console.log('[DB] Initialized at:', dbPath);
}

function persistToDisk() {
  try {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.error('[DB] Persist error:', e.message);
  }
}

function createTables() {
  db.run(`CREATE TABLE IF NOT EXISTS lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL,
    category TEXT NOT NULL, breed TEXT, animal_count INTEGER DEFAULT 0,
    avg_weight REAL, entry_date TEXT, status TEXT DEFAULT 'active',
    paddock TEXT, notes TEXT, created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')), _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS vet_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT NOT NULL,
    unit TEXT NOT NULL, stock_qty REAL DEFAULT 0, stock_min REAL DEFAULT 0,
    dose_per_50kg REAL, expiry_date TEXT, supplier TEXT, unit_cost REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS treatments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, vet_product_id INTEGER NOT NULL,
    lot_id INTEGER, lot_code TEXT, animal_tag TEXT, treatment_scope TEXT NOT NULL,
    animals_treated INTEGER DEFAULT 1, dose_applied REAL NOT NULL,
    total_product_used REAL NOT NULL, applied_at TEXT NOT NULL,
    next_application TEXT, diagnosis TEXT, notes TEXT, total_cost REAL DEFAULT 0,
    registered_by_name TEXT, created_at TEXT DEFAULT (datetime('now')),
    _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS health_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, alert_type TEXT NOT NULL,
    severity TEXT NOT NULL, vet_product_id INTEGER, lot_id INTEGER,
    title TEXT NOT NULL, message TEXT NOT NULL, resolved INTEGER DEFAULT 0,
    due_at TEXT, created_at TEXT DEFAULT (datetime('now')),
    _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lot_code TEXT, buyer_name TEXT NOT NULL,
    buyer_type TEXT NOT NULL, animals_sold INTEGER NOT NULL, total_weight_kg REAL NOT NULL,
    price_per_kg REAL NOT NULL, total_amount REAL NOT NULL, sale_date TEXT NOT NULL,
    invoice_number TEXT, traceability_required INTEGER DEFAULT 0, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, purchase_type TEXT NOT NULL,
    description TEXT NOT NULL, quantity REAL, unit TEXT, unit_price REAL NOT NULL,
    total_amount REAL NOT NULL, purchase_date TEXT NOT NULL,
    payment_status TEXT DEFAULT 'paid', supplier TEXT, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL,
    phone TEXT, salary REAL DEFAULT 0, hire_date TEXT, active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')), _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS field_activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, employee_name TEXT NOT NULL,
    activity_type TEXT NOT NULL, lot_code TEXT, description TEXT NOT NULL,
    performed_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')),
    _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS traceability_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, lot_code TEXT, sale_id INTEGER,
    cert_number TEXT UNIQUE, buyer_name TEXT NOT NULL, buyer_type TEXT NOT NULL,
    issued_date TEXT NOT NULL, animal_summary TEXT, health_summary TEXT,
    status TEXT DEFAULT 'issued', notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), _dirty INTEGER DEFAULT 1, server_id INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sync_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL,
    record_id INTEGER NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')), attempts INTEGER DEFAULT 0, error TEXT
  )`);
  console.log('[DB] Tables ready');
}

function seedInitialData() {
  const res = db.exec('SELECT COUNT(*) as c FROM lots');
  if ((res[0]?.values[0]?.[0] || 0) > 0) return;

  db.run(`INSERT INTO lots (code,category,breed,animal_count,avg_weight,entry_date,status,paddock) VALUES
    ('A-07','novillo','Nelore',68,412,'2025-09-15','active','Potrero Norte'),
    ('B-12','novillo','Brahman',47,389,'2025-10-01','active','Potrero Este'),
    ('C-03','ternero','Nelore',28,187,'2026-01-10','active','Potrero Sur'),
    ('D-01','novillo','Brahman',94,458,'2025-07-20','active','Potrero Oeste'),
    ('E-09','recria_mixta','Nelore',112,231,'2025-11-05','active','Potrero Central'),
    ('F-05','vaquillona','Criollo',55,298,'2025-12-01','active','Potrero Sur')`);

  db.run(`INSERT INTO vet_products (name,type,unit,stock_qty,stock_min,dose_per_50kg,expiry_date,supplier,unit_cost) VALUES
    ('Ivermectina 1%','antiparasitario','ml',2,5,1.0,'2027-06-01','Vetsuper',12.5),
    ('Closantel 5%','antiparasitario','ml',4,5,2.5,'2026-12-01','Vetsuper',18.0),
    ('Sal Mineral','vitamina','kg',320,100,null,null,'AgroSC',2.8),
    ('Vacuna Aftosa','vacuna','dosis',180,50,1.0,'2026-09-01','SENASAG',3.5),
    ('Pen-Estreptomicina','antibiotico','amp',3,10,null,'2026-11-01','Farmavid',8.0),
    ('Complejo B','vitamina','ml',15,10,2.0,'2027-01-01','Vetsuper',6.5)`);

  db.run(`INSERT INTO health_alerts (alert_type,severity,vet_product_id,title,message,resolved) VALUES
    ('stock_low','critical',1,'Stock crítico: Ivermectina 1%','Quedan 2ml. Mínimo 5ml.',0),
    ('vaccine_due','warning',4,'Vacuna Aftosa vence — Lote B-12','47 animales. Vacunar antes del 30/03.',0),
    ('stock_low','critical',5,'Stock crítico: Pen-Estreptomicina','Quedan 3 ampollas. Mínimo 10.',0)`);

  db.run(`INSERT INTO employees (name,role,phone,salary,hire_date) VALUES
    ('Juan Ríos','capataz','+591 72000001',3500,'2020-03-01'),
    ('Pedro Mamani','peon','+591 72000003',2800,'2022-06-15'),
    ('Carlos Quispe','peon','+591 72000004',2800,'2023-01-10')`);

  db.run(`INSERT INTO sales (lot_code,buyer_name,buyer_type,animals_sold,total_weight_kg,price_per_kg,total_amount,sale_date,traceability_required) VALUES
    ('D-01','Frigorífico Boliviano S.A.','frigorifico',40,17200,6.5,111800,'2026-03-12',1),
    ('A-07','Feria Ganadera Trinidad','feria',12,4800,6.2,29760,'2026-02-25',0)`);

  persistToDisk();
  console.log('[DB] Seed data inserted');
}

function query(table, action, data = {}, where = {}) {
  const allowed = ['lots','vet_products','treatments','health_alerts','sales',
    'purchases','employees','field_activities','traceability_records','sync_queue'];
  if (!allowed.includes(table)) throw new Error('Table not allowed: ' + table);

  switch (action) {
    case 'selectAll': {
      const { sql, params } = buildWhere(where);
      return rowsToObjects(db.exec(`SELECT * FROM ${table}${sql} ORDER BY id DESC`, params));
    }
    case 'selectOne': {
      const { sql, params } = buildWhere(where);
      return rowsToObjects(db.exec(`SELECT * FROM ${table}${sql} LIMIT 1`, params))[0] || null;
    }
    case 'insert': {
      data.created_at = data.created_at || new Date().toISOString();
      data._dirty = 1;
      const keys = Object.keys(data);
      const vals = Object.values(data);
      db.run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`, vals);
      const id = rowsToObjects(db.exec('SELECT last_insert_rowid() as id'))[0]?.id;
      persistToDisk();
      queueChange(table, id, 'insert', data);
      return { id, changes: 1 };
    }
    case 'update': {
      data._dirty = 1;
      const { sql, params } = buildWhere(where);
      const keys = Object.keys(data);
      db.run(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')}${sql}`, [...Object.values(data), ...params]);
      persistToDisk();
      if (where.id) queueChange(table, where.id, 'update', data);
      return { changes: 1 };
    }
    case 'delete': {
      const { sql, params } = buildWhere(where);
      db.run(`DELETE FROM ${table}${sql}`, params);
      persistToDisk();
      if (where.id) queueChange(table, where.id, 'delete', {});
      return { changes: 1 };
    }
    default: throw new Error('Unknown action: ' + action);
  }
}

function raw(sql) { return rowsToObjects(db.exec(sql)); }

function buildWhere(where = {}) {
  const keys = Object.keys(where);
  if (!keys.length) return { sql: '', params: [] };
  return { sql: ' WHERE ' + keys.map(k => k+'=?').join(' AND '), params: Object.values(where) };
}

function rowsToObjects(results) {
  if (!results?.length) return [];
  const { columns, values } = results[0];
  return values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

function queueChange(table, recordId, action, payload) {
  db.run(`INSERT INTO sync_queue (table_name,record_id,action,payload) VALUES (?,?,?,?)`,
    [table, recordId, action, JSON.stringify(payload)]);
}

function getPendingChangesCount() {
  return rowsToObjects(db.exec('SELECT COUNT(*) as c FROM sync_queue'))[0]?.c || 0;
}

function getPendingChanges() {
  return rowsToObjects(db.exec('SELECT * FROM sync_queue ORDER BY created_at ASC LIMIT 100'));
}

function markSynced(queueIds, table, recordId, serverId) {
  db.run(`DELETE FROM sync_queue WHERE id IN (${queueIds.join(',')})`);
  if (table && recordId) db.run(`UPDATE ${table} SET _dirty=0, server_id=? WHERE id=?`, [serverId, recordId]);
  persistToDisk();
}

module.exports = { initialize, query, raw, getPendingChangesCount, getPendingChanges, markSynced };
