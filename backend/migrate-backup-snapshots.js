/**
 * migrate-backup-snapshots.js — v0.8.0 Sprint 1
 *
 * Sistema de snapshots manual. Útil antes de cambios destructivos o como backup
 * por tenant. El contenido se guarda en R2 (no en DB) para evitar bloating.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando backup_snapshots...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS backup_snapshots (
        id              SERIAL PRIMARY KEY,
        tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        -- NULL = snapshot global (toda la DB), no de un tenant específico

        label           TEXT NOT NULL,             -- "antes de cambio de prompt", "pre-deploy v0.8.0", etc.
        kind            TEXT NOT NULL DEFAULT 'manual',  -- 'manual', 'pre-deploy', 'pre-migration', 'auto'

        r2_key          TEXT,                      -- key en R2 donde está el dump JSON
        size_bytes      BIGINT,
        rows_count      INTEGER,                   -- cuántas filas contiene aprox
        tables_included TEXT[],                    -- ['conversations', 'messages', 'leads', ...]

        notes           TEXT,
        created_by      TEXT NOT NULL,             -- 'super-admin', 'system', token hint
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_snapshots_tenant_created ON backup_snapshots(tenant_id, created_at DESC);`);

    console.log('✅ Tabla backup_snapshots creada');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-backup-snapshots:', err);
    process.exit(1);
  }
})();
