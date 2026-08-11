/**
 * Migración v0.9.52 — Eventos de calidad de Meta (protección del número)
 *
 * quality_events: registro de webhooks phone_number_quality_update /
 * account_update. Si Meta degrada o marca el número (FLAGGED/RESTRICTED),
 * el sistema pausa las campañas programadas del tenant y el panel lo avisa.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-quality-v0952.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.52 — eventos de calidad de Meta...');
  await db.query(`
    CREATE TABLE IF NOT EXISTS quality_events (
      id           SERIAL PRIMARY KEY,
      tenant_id    INTEGER,
      waba_id      TEXT,
      phone_number TEXT,
      field        TEXT,
      event        TEXT,
      detail       JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_quality_events_tenant ON quality_events (tenant_id, created_at DESC);`);
  console.log('✅ tabla quality_events');

  // v0.9.52: CLICK TRACKING — un código corto por destinatario de campaña.
  // app.sg-ventas.com/r/<code> registra el clic y redirige a la URL destino.
  await db.query(`
    CREATE TABLE IF NOT EXISTS tracked_links (
      code        TEXT PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      campaign_id TEXT,
      phone       TEXT,
      url         TEXT NOT NULL,
      clicks      INTEGER NOT NULL DEFAULT 0,
      clicked_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tracked_links_campaign ON tracked_links (campaign_id);`);
  console.log('✅ tabla tracked_links (click tracking)');
  console.log('🎉 Migración v0.9.52 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
