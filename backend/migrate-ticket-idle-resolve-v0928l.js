/**
 * migrate-ticket-idle-resolve-v0928l.js — v0.9.313
 * Auto-resolver tickets de soporte por inactividad del cliente. tenants.ticket_idle_hours:
 * si el cliente no responde en N horas, el ticket activo pasa a 'resolved' (cron). Default 24; 0 = off.
 * Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.313 — tenants.ticket_idle_hours (auto-resolver por inactividad)…');
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ticket_idle_hours INTEGER DEFAULT 24;`);
  console.log('✅ tenants.ticket_idle_hours (default 24; 0 = desactivado).');
  console.log('🎉 Migración v0.9.313 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
