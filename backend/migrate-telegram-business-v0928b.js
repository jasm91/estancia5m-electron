/**
 * migrate-telegram-business-v0928b.js — v0.9.282
 * Telegram Business: permite que el DUEÑO enlace su CUENTA PERSONAL de Telegram al bot
 * (Ajustes → Telegram Business → Chatbots) y Aitana conteste sus DMs personales como él.
 *   - conversations.tg_business_connection_id → con qué conexión responder ese chat.
 *   - tenant_channels.business_connection_id / business_owner_id / business_can_reply →
 *     estado de la conexión del bot con la cuenta personal (para el panel + el eco del dueño).
 * Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.282 — Telegram Business (cuenta personal ↔ bot)…');
  await db.query(`ALTER TABLE conversations   ADD COLUMN IF NOT EXISTS tg_business_connection_id TEXT;`);
  await db.query(`ALTER TABLE tenant_channels ADD COLUMN IF NOT EXISTS business_connection_id TEXT;`);
  await db.query(`ALTER TABLE tenant_channels ADD COLUMN IF NOT EXISTS business_owner_id TEXT;`);
  await db.query(`ALTER TABLE tenant_channels ADD COLUMN IF NOT EXISTS business_can_reply BOOLEAN DEFAULT TRUE;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conversations_tg_bizconn ON conversations (tg_business_connection_id) WHERE tg_business_connection_id IS NOT NULL;`);
  console.log('✅ columnas Telegram Business listas.');
  console.log('🎉 Migración Telegram Business v0.9.282 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
