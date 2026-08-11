/**
 * Migración v0.9.55 — Permisos granulares por rol
 *
 * role_permissions: overrides POR ORGANIZACIÓN de lo que cada rol puede hacer.
 * Es SPARSE — solo se guardan filas que cambian el default. Sin filas = el
 * sistema usa los defaults (= comportamiento histórico, no rompe nada):
 *   owner       → todo
 *   supervisor  → catálogos, campañas, assets, export, reset-context (ON)
 *   agent       → todo OFF (solo inbox/leads/tareas propias)
 *
 * El owner siempre tiene todos los permisos (no se puede auto-bloquear).
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-role-permissions-v0955.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.55 — permisos granulares por rol...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      tenant_id   INTEGER NOT NULL,
      role        TEXT NOT NULL,
      permission  TEXT NOT NULL,
      allowed     BOOLEAN NOT NULL,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, role, permission)
    );
  `);
  console.log('✅ tabla role_permissions');
  console.log('🎉 Migración v0.9.55 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
