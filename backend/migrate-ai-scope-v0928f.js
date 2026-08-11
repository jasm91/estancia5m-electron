/**
 * migrate-ai-scope-v0928f.js — v0.9.285
 * IA granular: además del master switch global (tenants.ai_enabled), permite pausar/activar
 * la IA por LÍNEA (tenant_lines.ai_enabled) y por CANAL (tenant_channels.ai_enabled).
 * Default TRUE → no cambia el comportamiento hasta que el dueño apague algo puntual. Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.285 — IA por línea/canal…');
  await db.query(`ALTER TABLE tenant_lines    ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT TRUE;`);
  await db.query(`ALTER TABLE tenant_channels ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN DEFAULT TRUE;`);
  console.log('✅ tenant_lines.ai_enabled + tenant_channels.ai_enabled (default TRUE).');
  console.log('🎉 Migración v0.9.285 (IA por scope) completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
