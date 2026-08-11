/**
 * migrate-archive-feature-v090.js — Sg Sales v0.9.0
 *
 * Feature: archivar conversaciones (ocultar de vista principal sin borrar).
 *
 * La columna `status` ya existe en conversations con valores 'open' | 'closed' | 'archived'
 * (ver migrate.js línea 28). Esta migración NO agrega columnas — solo:
 *
 *   1. Agrega columna `archived_at` (timestamp) para saber CUÁNDO se archivó
 *      (útil para auditoría y para no re-archivar lo recién reactivado).
 *   2. Crea un índice parcial para listar archivadas eficientemente.
 *
 * Comportamiento de la feature (implementado en api.js + webhook.js):
 *   - Manual: POST /admin/conversations/:phone/archive  → status='archived'
 *   - Manual: POST /admin/conversations/:phone/unarchive → status='open'
 *   - Auto: POST /admin/conversations/auto-archive (n8n cron) → archiva inactivas > 3 días
 *   - Reactivación: webhook entrante reabre automáticamente si llega mensaje a archivada
 *
 * IDEMPOTENTE: usa IF NOT EXISTS, se puede correr múltiples veces.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Agregando columna archived_at a conversations...');
    await db.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ DEFAULT NULL
    `);

    console.log('▶ Creando índice parcial para conversaciones archivadas...');
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_archived
      ON conversations(tenant_id, last_message_at DESC NULLS LAST)
      WHERE status = 'archived'
    `);

    console.log('▶ Creando índice para auto-archivado (inactividad)...');
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_status_lastmsg
      ON conversations(status, last_message_at)
      WHERE status = 'open'
    `);

    console.log('✅ Migration archive-feature v0.9.0 completada');
    console.log('   - Columna archived_at agregada');
    console.log('   - Índices de archivado creados');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-archive-feature-v090:', err);
    process.exit(1);
  }
})();
