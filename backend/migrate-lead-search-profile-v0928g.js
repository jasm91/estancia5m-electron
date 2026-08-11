/**
 * migrate-lead-search-profile-v0928g.js — v0.9.299
 * Perfil de búsqueda del lead (GENÉRICO, reutilizable en TODOS los modos de venta).
 * leads.search_profile JSONB:
 *   { operation, budget_min, budget_max, currency, location, timeline, notes,
 *     attributes: { ...campos específicos del modo... } }
 * El bot lo emite en su JSON (bloque central en bot-prompt-builder) y se guarda/mergea
 * en /whatsapp/lead. Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.299 — Perfil de búsqueda del lead (leads.search_profile)…');
  await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS search_profile JSONB;`);
  console.log('✅ leads.search_profile (JSONB, genérico por modo).');
  console.log('🎉 Migración v0.9.299 (perfil de búsqueda) completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
