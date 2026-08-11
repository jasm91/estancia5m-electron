/**
 * Migración v0.9.29 — Usuarios divididos por etapa (venta / post-venta)
 *
 * tenant_users.stage_scope: 'todas' (default) | 'venta' | 'postventa'.
 * Solo restringe a AGENTES: un agente con etapa asignada ve únicamente las
 * conversaciones de esa etapa (enforced server-side en list/activity/
 * messages/send/upload, igual que las líneas asignadas de v0.9.14).
 * Owner y supervisor siempre ven todo.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-user-stage-v0929.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.29 — stage_scope en tenant_users...');

  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS stage_scope TEXT NOT NULL DEFAULT 'todas';`);
  console.log('✅ tenant_users.stage_scope (default todas)');

  console.log('🎉 Migración v0.9.29 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
