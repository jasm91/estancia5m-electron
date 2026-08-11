/**
 * migrate-add-fb-user-id.js — v0.9.8
 *
 * Agrega la columna fb_user_id a tenants, usada para vincular el usuario de
 * Facebook que se loguea al panel con su tenant.
 *
 * Aditiva e idempotente. No toca datos existentes.
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node migrate-add-fb-user-id.js
 */

const db = require('./db');

(async () => {
  try {
    console.log('🚀 Agregando fb_user_id a tenants...\n');

    const exists = await db.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'fb_user_id'
    `);
    if (exists.rows.length > 0) {
      console.log('⏭  La columna fb_user_id ya existe. Nada que hacer.');
      process.exit(0);
    }

    await db.query(`ALTER TABLE tenants ADD COLUMN fb_user_id TEXT`);
    // Índice único parcial: cada FB user mapea a 1 tenant (permite NULLs múltiples)
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_fb_user_id
      ON tenants(fb_user_id) WHERE fb_user_id IS NOT NULL
    `);

    console.log('✅ Columna fb_user_id agregada + índice único parcial.');
    console.log('   (Los tenants existentes quedan con fb_user_id = NULL hasta su primer login con Facebook.)');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
