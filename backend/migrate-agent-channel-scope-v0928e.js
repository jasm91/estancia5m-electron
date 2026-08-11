/**
 * migrate-agent-channel-scope-v0928e.js — v0.9.285
 * Alcance por CANAL del agente: un agente puede quedar restringido a ciertos canales
 * (whatsapp/messenger/instagram/telegram), igual que hoy se restringe por LÍNEA
 * (tenant_user_lines) y por ETAPA (tenant_users.stage_scope). NULL/[] = ve todos. Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.285 — Alcance por canal del agente: tenant_users.channel_scope…');
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS channel_scope TEXT[];`);
  console.log('✅ tenant_users.channel_scope (TEXT[]; NULL/vacío = todos los canales).');
  console.log('🎉 Migración v0.9.285 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
