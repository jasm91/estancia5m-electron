/**
 * migrate-password-resets-v0928o.js — v0.9.327
 * Reset de contraseña por link (el dueño genera un link de un solo uso; el miembro pone su clave).
 * Guardamos solo el HASH del token + expiración 1h + single-use. Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.327 — password_resets (reset de clave por link)…');
  await db.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id          BIGSERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      tenant_id   INTEGER NOT NULL,
      token_hash  TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used_at     TIMESTAMPTZ,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS ix_password_resets_token ON password_resets (token_hash);`);
  console.log('✅ password_resets listo.');
  console.log('🎉 Migración v0.9.327 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
