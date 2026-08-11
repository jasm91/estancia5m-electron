/**
 * migrate-conv-search-profile-v0928k.js — v0.9.305
 * Captura del perfil de búsqueda ANTES de calificar: conversations.search_profile JSONB.
 * El bot lo emite cada turno; /progress lo acumula en la conversación; al crear el lead,
 * este hereda el perfil acumulado (no se pierde lo detectado pre-calificación). Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.305 — conversations.search_profile (captura pre-calificación)…');
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS search_profile JSONB;`);
  console.log('✅ conversations.search_profile listo.');
  console.log('🎉 Migración v0.9.305 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
