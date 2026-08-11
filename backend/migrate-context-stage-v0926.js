/**
 * Migración v0.9.26 — Reset de contexto + etapa venta/post-venta
 *
 * (1) conversations.context_reset_at: al "resetear contexto", Aitana olvida
 *     todo lo anterior a esa marca (el dispatch a n8n filtra el historial),
 *     pero los mensajes siguen visibles en el panel.
 * (2) conversations.stage: 'venta' (default) | 'postventa'. Filtros en el
 *     inbox + se informa en el system prompt cuando es post-venta.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-context-stage-v0926.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.26 — reset de contexto + etapas venta/post-venta...');

  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS context_reset_at TIMESTAMPTZ;`);
  console.log('✅ conversations.context_reset_at');

  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'venta';`);
  console.log('✅ conversations.stage (default venta)');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_stage
    ON conversations (tenant_id, stage);
  `);
  console.log('✅ índice (tenant_id, stage)');

  console.log('🎉 Migración v0.9.26 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
