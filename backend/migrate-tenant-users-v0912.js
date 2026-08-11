/**
 * Migración v0.9.12 — Multi-usuario por tenant (organización)
 *
 * 1. Tabla tenant_users: usuarios con login email+password DENTRO de un tenant.
 *    Roles: owner (dueño, entra también con Facebook) | supervisor | agent.
 * 2. tenants.invite_code: código de invitación de la organización ("org token").
 *    Con él, un agente se auto-registra en POST /api/auth/register.
 *    Backfill automático para tenants existentes.
 * 3. messages.sent_by_user_id: atribución de mensajes humanos (quién respondió).
 *
 * Idempotente (IF NOT EXISTS en todo). Uso:
 *   DATABASE_URL="..." node migrate-tenant-users-v0912.js
 */
const crypto = require('crypto');
const db = require('./db');

function genInviteCode() {
  // org-XXXXXXXXXX (10 chars base32-ish, sin ambiguos)
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) s += alphabet[bytes[i] % alphabet.length];
  return `org-${s}`;
}

async function migrate() {
  console.log('🔧 v0.9.12 — multi-usuario por tenant...');

  // 1. Tabla de usuarios por tenant
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_users (
      id            SERIAL PRIMARY KEY,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email         TEXT,                          -- NULL para owner FB-only (hasta que setee email)
      password_hash TEXT,                          -- NULL para owner FB-only (hasta que setee password)
      display_name  TEXT,
      role          TEXT NOT NULL DEFAULT 'agent'
                    CHECK (role IN ('owner','supervisor','agent')),
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      fb_user_id    TEXT,                          -- vínculo con el login de Facebook (owner)
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
  `);
  console.log('✅ tabla tenant_users');

  // Email único GLOBAL (login sin pedir organización). Permite NULL (owner FB-only).
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_users_email
    ON tenant_users (LOWER(email)) WHERE email IS NOT NULL;
  `);
  // Un solo owner por fb_user_id dentro del tenant
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_users_fb
    ON tenant_users (tenant_id, fb_user_id) WHERE fb_user_id IS NOT NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users (tenant_id);
  `);
  console.log('✅ índices tenant_users');

  // 2. Código de invitación de la organización
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS invite_code TEXT UNIQUE;`);
  const pending = await db.query(`SELECT id, slug FROM tenants WHERE invite_code IS NULL;`);
  for (const t of pending.rows) {
    // Reintento simple ante colisión (probabilidad ínfima)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await db.query('UPDATE tenants SET invite_code = $1 WHERE id = $2', [genInviteCode(), t.id]);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
    console.log(`  → invite_code generado para tenant ${t.id} (${t.slug})`);
  }
  console.log('✅ tenants.invite_code (backfill incluido)');

  // 3. Atribución de mensajes humanos
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS
      sent_by_user_id INTEGER REFERENCES tenant_users(id) ON DELETE SET NULL;
  `);
  console.log('✅ messages.sent_by_user_id');

  console.log('🎉 Migración v0.9.12 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
