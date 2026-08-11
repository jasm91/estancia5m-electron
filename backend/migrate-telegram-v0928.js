/**
 * migrate-telegram-v0928.js — v0.9.281
 * Canal Telegram sobre la infra omnicanal existente (tenant_channels). Solo agrega el
 * secret del webhook por bot; el resto de columnas ya sirven:
 *   channel='telegram', page_id=<bot_id>, page_name='@user', page_token_enc=<bot token>.
 * Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.281 — Canal Telegram: tenant_channels.webhook_secret…');
  await db.query(`ALTER TABLE tenant_channels ADD COLUMN IF NOT EXISTS webhook_secret TEXT;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_channels_tg_secret ON tenant_channels (webhook_secret) WHERE webhook_secret IS NOT NULL;`);
  console.log('✅ tenant_channels.webhook_secret (+índice parcial)');
  console.log('🎉 Migración Telegram v0.9.281 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
