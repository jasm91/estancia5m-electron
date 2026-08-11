/**
 * backup-bot-config-tables.js — v0.9.7
 *
 * Hace un dump JSON de las 6 tablas de config del bot ANTES de la migration
 * multi-tenant (que cambia PKs). Si algo sale mal, podés restaurar desde acá.
 *
 * Solo LECTURA. Escribe un archivo JSON en el directorio actual.
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node backup-bot-config-tables.js
 */

const db = require('./db');
const fs = require('fs');

const TABLES = [
  'bot_prompt_base',
  'bot_verticals',
  'bot_pricing_plans',
  'bot_proof_points',
  'bot_global_config',
  'bot_prompt_history',
];

(async () => {
  try {
    console.log('💾 Backup de tablas bot_* (pre-migration multi-tenant)\n');
    const backup = { created_at: new Date().toISOString(), tables: {} };

    for (const t of TABLES) {
      const r = await db.query(`SELECT * FROM ${t}`);
      backup.tables[t] = r.rows;
      console.log(`   ✅ ${t}: ${r.rows.length} filas`);
    }

    const filename = `backup-bot-config-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(backup, null, 2));
    console.log(`\n✅ Backup guardado en: ${filename}`);
    console.log('   Guardá este archivo. Si la migration falla, podés restaurar desde acá.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en backup:', err);
    process.exit(1);
  }
})();
