/**
 * migrate-webhook-queue-v0928n.js — v0.9.326
 * Cola durable de ingestión: cada webhook de Meta se persiste crudo ANTES de responder 200,
 * y un worker reprocesa lo que quedó colgado tras un reinicio → no se pierden mensajes.
 * Idempotente. status: pending | processing | done | failed.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.326 — webhook_events (cola durable de ingestión)…');
  await db.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      id           BIGSERIAL PRIMARY KEY,
      object       TEXT,
      payload      JSONB NOT NULL,
      status       TEXT NOT NULL DEFAULT 'pending',
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at   TIMESTAMPTZ,
      processed_at TIMESTAMPTZ
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS ix_webhook_events_pending ON webhook_events (status, created_at) WHERE status IN ('pending','processing');`);
  console.log('✅ webhook_events listo.');
  console.log('🎉 Migración v0.9.326 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
