/**
 * migrate-comments-inbox-v0928c.js — v0.9.283
 * Pestaña dedicada de Comentarios (inbox estilo AngrySpace) sobre channel_comments.
 * Agrega: asignación a un asesor, texto de la última respuesta pública, quién la atendió,
 * y flag de ocultado. Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.283 — Inbox de comentarios (channel_comments +assigned/reply/hidden)…');
  await db.query(`ALTER TABLE channel_comments ADD COLUMN IF NOT EXISTS assigned_to INTEGER REFERENCES tenant_users(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE channel_comments ADD COLUMN IF NOT EXISTS reply_text TEXT;`);
  await db.query(`ALTER TABLE channel_comments ADD COLUMN IF NOT EXISTS handled_by INTEGER REFERENCES tenant_users(id) ON DELETE SET NULL;`);
  await db.query(`ALTER TABLE channel_comments ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN DEFAULT FALSE;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_comments_assigned ON channel_comments (tenant_id, assigned_to) WHERE assigned_to IS NOT NULL;`);
  console.log('✅ channel_comments listo para el inbox.');
  console.log('🎉 Migración inbox comentarios v0.9.283 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
