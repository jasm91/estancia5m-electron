/**
 * diagnose-bot-tables-state.js — solo lectura
 * Muestra para cada tabla bot_*: si tiene tenant_id y cuál es su PK actual.
 */
const db = require('./db');

(async () => {
  const tables = ['bot_verticals','bot_pricing_plans','bot_global_config','bot_prompt_base','bot_proof_points'];
  console.log('📊 Estado actual de las tablas bot_*\n');
  for (const t of tables) {
    const col = await db.query(
      'SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND column_name=$2',
      [t, 'tenant_id']
    );
    const pk = await db.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
       WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
       ORDER BY kcu.ordinal_position`,
      [t]
    );
    const hasTenant = col.rows.length > 0 ? 'SÍ' : 'NO';
    const pkCols = pk.rows.map(r => r.column_name).join(', ') || '(ninguna)';
    console.log(`${t.padEnd(20)} tenant_id=${hasTenant.padEnd(3)} PK=(${pkCols})`);
  }

  // Además: ver si hay datos en tenant != 1 (por si una migración previa los movió)
  console.log('\n📊 Distribución de filas por tenant_id:');
  for (const t of tables) {
    try {
      const r = await db.query(`SELECT tenant_id, COUNT(*)::int AS n FROM ${t} GROUP BY tenant_id ORDER BY tenant_id`);
      const dist = r.rows.map(x => `t${x.tenant_id}=${x.n}`).join(' ');
      console.log(`${t.padEnd(20)} ${dist || '(sin filas)'}`);
    } catch (e) {
      console.log(`${t.padEnd(20)} (no tiene tenant_id: ${e.message.split('\n')[0]})`);
    }
  }
  process.exit(0);
})();
