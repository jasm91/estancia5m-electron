/**
 * Migración v0.9.14 — Asignación de líneas por usuario
 *
 * tenant_user_lines: qué líneas trabaja cada usuario (N:M).
 * Regla de visibilidad (aplicada en api.js):
 *   - SIN filas para un usuario  → ve TODAS las líneas (default, retrocompat)
 *   - CON filas                  → solo ve conversaciones de esas líneas
 *   - owner / supervisor / super-admin → siempre ven todo (no se filtra)
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-user-lines-v0914.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.14 — asignación de líneas por usuario...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_user_lines (
      user_id    INTEGER NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
      line_id    INTEGER NOT NULL REFERENCES tenant_lines(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, line_id)
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tul_line ON tenant_user_lines (line_id);`);
  console.log('✅ tabla tenant_user_lines');

  console.log('🎉 Migración v0.9.14 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
