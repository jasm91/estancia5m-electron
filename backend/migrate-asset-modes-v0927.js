/**
 * Migración v0.9.27 — Assets por modo de venta
 *
 * Antes: TODOS los assets del tenant iban a Aitana en cada mensaje,
 * sin importar el modo de venta (software/artículos/inmuebles).
 *
 * Ahora: media_assets.sale_mode ('todos' | 'software' | 'articulos' | 'inmuebles').
 * El dispatch a n8n filtra: un asset viaja solo si sale_mode='todos' o si el
 * modo correspondiente está habilitado en la org (toggles de tenants).
 *
 * Los assets existentes quedan en 'todos' (comportamiento idéntico al actual).
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-asset-modes-v0927.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.27 — assets por modo de venta...');

  await db.query(`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS sale_mode TEXT NOT NULL DEFAULT 'todos';`);
  console.log('✅ media_assets.sale_mode (default todos)');

  console.log('🎉 Migración v0.9.27 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
