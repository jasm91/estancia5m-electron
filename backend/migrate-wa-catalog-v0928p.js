/**
 * migrate-wa-catalog-v0928p.js — v0.9.328
 * Sincronización del catálogo de WhatsApp Commerce → inventory_items. Guarda el catalog_id
 * elegido y cuándo se sincronizó. Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.328 — tenants.wa_catalog_id (sync catálogo WhatsApp Commerce)…');
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_catalog_id TEXT;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS wa_catalog_synced_at TIMESTAMPTZ;`);
  console.log('✅ tenants.wa_catalog_id / wa_catalog_synced_at listos.');
  console.log('🎉 Migración v0.9.328 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
