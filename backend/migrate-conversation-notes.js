/**
 * migrate-conversation-notes.js
 *
 * Crea la tabla conversation_notes usada por:
 *   - GET    /api/admin/conversations/:phone/notes
 *   - POST   /api/admin/conversations/:phone/notes
 *   - DELETE /api/admin/conversations/notes/:id
 *   - GET    /api/admin/export/conversations  (cuando include_notes=true)
 *
 * Columnas (según uso real en api.js):
 *   id, conversation_id, body, author, created_at
 *
 * Idempotente: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando tabla conversation_notes...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS conversation_notes (
        id SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        author VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_notes_conv_id
      ON conversation_notes(conversation_id);
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_conversation_notes_created_at
      ON conversation_notes(created_at DESC);
    `);

    console.log('✅ conversation_notes lista');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-conversation-notes:', err);
    process.exit(1);
  }
})();
