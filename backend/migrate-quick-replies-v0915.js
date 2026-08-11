/**
 * Migración v0.9.15 — Respuestas rápidas del chat
 *
 * quick_replies: atajos reutilizables para el composer del panel.
 *   - body: texto libre (puede incluir URLs). Si hay asset, va como caption.
 *   - asset_id: referencia suave a media_assets.asset_id (imagen/video/doc/link).
 *   - shortcut: lo que se tipea tras "/" en el chat (ej. /precio).
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-quick-replies-v0915.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.15 — respuestas rápidas...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS quick_replies (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      shortcut   TEXT NOT NULL,
      title      TEXT,
      body       TEXT,
      asset_id   TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      created_by INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (body IS NOT NULL OR asset_id IS NOT NULL)
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_replies_shortcut
    ON quick_replies (tenant_id, LOWER(shortcut));
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_quick_replies_tenant ON quick_replies (tenant_id);`);
  console.log('✅ tabla quick_replies + índices');

  console.log('🎉 Migración v0.9.15 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
