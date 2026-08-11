/**
 * v0.9.23 — Pre-carga los prompts de 'articulos' e 'inmuebles' para un tenant,
 * así el dueño solo tiene que ACTIVARLOS (Config → Prompt Base → Activar).
 * No toca el de 'software' ni cambia el modo activo. Idempotente (no pisa si ya hay).
 *
 * Uso:
 *   DATABASE_URL="..." node seed-mode-prompts-v0923.js        # tenant 1
 *   DATABASE_URL="..." node seed-mode-prompts-v0923.js 3      # otro tenant
 */
const db = require('./db');
const TENANT = parseInt(process.argv[2]) || 1;

// v0.9.65: los prompts default viven en default-mode-prompts.js (única fuente)
const { ARTICULOS, INMUEBLES, SERVICIOS } = require('./default-mode-prompts');

async function upsert(mode, content) {
  const ex = await db.query('SELECT content FROM tenant_mode_prompts WHERE tenant_id = $1 AND mode = $2', [TENANT, mode]);
  if (ex.rows[0] && (ex.rows[0].content || '').trim()) { console.log(`  ⏭  ${mode} ya tiene prompt`); return; }
  if (ex.rows.length) {
    await db.query('UPDATE tenant_mode_prompts SET content = $1, updated_at = NOW() WHERE tenant_id = $2 AND mode = $3', [content, TENANT, mode]);
  } else {
    await db.query('INSERT INTO tenant_mode_prompts (tenant_id, mode, content) VALUES ($1, $2, $3)', [TENANT, mode, content]);
  }
  console.log(`  ✅ ${mode} cargado`);
}

async function seed() {
  console.log(`🌱 Pre-cargando prompts de modo para tenant ${TENANT}...`);
  try {
    await upsert('articulos', ARTICULOS);
    await upsert('inmuebles', INMUEBLES);
    await upsert('servicios', SERVICIOS); // v0.9.49
  } catch (e) {
    if (/tenant_mode_prompts/.test(e.message)) { console.error('❌ Falta migración v0.9.23'); process.exit(1); }
    throw e;
  }
  console.log('🎉 Listo. Activá el que quieras en Config → 📝 Prompt Base → Activar este prompt.');
  process.exit(0);
}
seed().catch((e) => { console.error('❌', e.message); process.exit(1); });
