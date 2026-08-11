/**
 * Migración v0.9.23 — Prompts por modo de venta
 *
 * En vez de un solo prompt que se reemplaza a mano, cada org guarda un prompt
 * POR MODO y activa el que quiera con un clic.
 *
 *   - tenant_mode_prompts: prompt de 'articulos' e 'inmuebles' (el de 'software'
 *     sigue en bot_prompt_base, intacto, por retrocompatibilidad).
 *   - tenants.active_prompt_mode: qué modo define la PERSONA de Aitana
 *     ('software' por defecto → comportamiento actual).
 *
 * El builder (bot-prompt-builder.js) usa el prompt del modo activo:
 *   software  → bot_prompt_base + verticales/planes (como hoy)
 *   otro      → tenant_mode_prompts.content (autocontenido, sin verticales/planes)
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-mode-prompts-v0923.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.23 — prompts por modo...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_mode_prompts (
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      mode       TEXT NOT NULL,              -- 'articulos' | 'inmuebles' (software vive en bot_prompt_base)
      content    TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tenant_id, mode)
    );
  `);
  console.log('✅ tabla tenant_mode_prompts');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS active_prompt_mode TEXT NOT NULL DEFAULT 'software';`);
  console.log('✅ tenants.active_prompt_mode (default software)');

  console.log('🎉 Migración v0.9.23 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
