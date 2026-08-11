/**
 * migrate-csat-survey-v0928q.js — v0.9.331
 * Encuesta de satisfacción (CSAT) para modo BPO/Soporte.
 * - support_tickets.csat_sent_at: cuándo se envió la encuesta (anti-reenvío + enfriamiento).
 * - support_tickets.csat_comment: comentario abierto opcional del cliente.
 * - tenants.csat_enabled / csat_question / csat_template / csat_cooldown_days: config por tenant.
 * (La columna support_tickets.csat 1-5 ya existía.) Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.331 — CSAT BPO: columnas de encuesta de satisfacción…');
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_sent_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS csat_comment TEXT;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS csat_enabled BOOLEAN DEFAULT FALSE;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS csat_question TEXT;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS csat_template TEXT;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS csat_cooldown_days INTEGER DEFAULT 7;`);
  console.log('✅ CSAT: support_tickets.csat_sent_at/csat_comment + tenants.csat_* listos.');
  console.log('🎉 Migración v0.9.331 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
