/**
 * migrate-conv-topics-v0945.js — v0.9.345
 * AUTO-TOPICS por IA: columnas para el clasificador de temas de conversaciones
 * (topic-classifier.js) — qué vienen a buscar/consultar los clientes, en todos los modos.
 * Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.345 — topics de conversaciones (clasificador IA)…');
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS topics TEXT[];`);
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS topics_updated_at TIMESTAMPTZ;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conversations_topics ON conversations USING GIN (topics);`);
  console.log('✅ conversations.topics + topics_updated_at + índice GIN listos.');
  console.log('🎉 Migración v0.9.345 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
