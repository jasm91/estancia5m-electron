/**
 * Migración v0.9.18 — Respuestas rápidas personales
 *
 * quick_replies.owner_user_id:
 *   NULL  → de la ORGANIZACIÓN (administran owner/supervisor, las ven todos)
 *   valor → PERSONAL de ese usuario (solo él la ve y administra)
 *
 * El índice único pasa a estar scopeado: el mismo atajo puede existir
 * como org y como personal de distintos usuarios sin chocar.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-qr-personal-v0918.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.18 — respuestas rápidas personales...');

  await db.query(`
    ALTER TABLE quick_replies ADD COLUMN IF NOT EXISTS
      owner_user_id INTEGER REFERENCES tenant_users(id) ON DELETE CASCADE;
  `);
  console.log('✅ quick_replies.owner_user_id');

  await db.query(`DROP INDEX IF EXISTS idx_quick_replies_shortcut;`);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_shortcut_scoped
    ON quick_replies (tenant_id, COALESCE(owner_user_id, 0), LOWER(shortcut));
  `);
  console.log('✅ índice único scopeado (org vs personal)');

  console.log('🎉 Migración v0.9.18 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
