/**
 * Migración v0.9.58 — Horarios de atención
 *
 * tenants.business_hours JSONB — horario de atención del negocio:
 *   {
 *     tz: "America/La_Paz",
 *     days: { mon:[{open:"08:00",close:"18:00"}], tue:[...], ... },   // [] = cerrado ese día
 *     note: "Feriados cerrado"   // texto libre opcional
 *   }
 * NULL = sin horario configurado (Aitana no menciona horarios).
 *
 * Aitana lo usa para decir si está abierto/cerrado AHORA y cuál es el próximo
 * horario (se calcula en el server al armar el prompt, con la timezone del tenant).
 *
 * Idempotente.  DATABASE_URL="..." node migrate-business-hours-v0958.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.58 — horarios de atención...');
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_hours JSONB;`);
  console.log('✅ tenants.business_hours');
  console.log('🎉 Migración v0.9.58 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
