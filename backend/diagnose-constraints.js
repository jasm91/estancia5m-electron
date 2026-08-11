/**
 * diagnose-constraints.js — solo lectura
 * Muestra los nombres EXACTOS de las constraints (PK, FK, CHECK) de las tablas bot_*
 * para que la migration las pueda soltar por nombre real.
 */
const db = require('./db');

(async () => {
  const tables = ['bot_verticals','bot_pricing_plans','bot_global_config','bot_prompt_base','bot_proof_points'];
  for (const t of tables) {
    console.log(`\n=== ${t} ===`);
    const r = await db.query(`
      SELECT conname, contype
      FROM pg_constraint
      WHERE conrelid = $1::regclass
      ORDER BY contype
    `, [t]);
    for (const row of r.rows) {
      const types = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', c: 'CHECK', u: 'UNIQUE' };
      console.log(`  ${row.conname}  [${types[row.contype] || row.contype}]`);
    }
  }
  process.exit(0);
})();
