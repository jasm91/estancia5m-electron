/**
 * migrate-channel-prompts-v0928d.js — v0.9.284
 * PROMPT POR CANAL. Extiende tenant_mode_prompts con `channel` para que Messenger,
 * Instagram y Telegram puedan tener su propio prompt (override completo del modo activo),
 * en paralelo al override por línea de WhatsApp. Filas:
 *   - Default:        line_id NULL, channel NULL
 *   - Override línea: line_id=X,    channel NULL   (WhatsApp)
 *   - Override canal: line_id NULL, channel='telegram'|'messenger'|'instagram'
 * La unicidad pasa a (tenant, mode, COALESCE(line_id,0), COALESCE(channel,'')). Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.284 — Prompt por canal: tenant_mode_prompts.channel…');
  await db.query(`ALTER TABLE tenant_mode_prompts ADD COLUMN IF NOT EXISTS channel TEXT;`);
  // reemplazar el índice único (que solo contemplaba tenant+mode+line) por uno que incluya el canal
  await db.query(`DROP INDEX IF EXISTS uq_tmp_tenant_mode_line;`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tmp_tenant_mode_line_channel
                  ON tenant_mode_prompts (tenant_id, mode, COALESCE(line_id, 0), COALESCE(channel, ''));`);
  console.log('✅ tenant_mode_prompts.channel + índice único nuevo.');
  console.log('🎉 Migración prompt por canal v0.9.284 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
