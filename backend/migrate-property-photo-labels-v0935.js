/**
 * Migración v0.9.35 — Fotos de inmuebles con descripción por ambiente
 *
 * properties.image_labels JSONB — mapa { url_de_foto: "descripción" }
 * (ej. "sala", "baño principal", "cocina", "fachada").
 *
 * Aitana recibe la lista de ambientes en el catálogo y puede mandar la foto
 * correspondiente cuando el cliente pide "muéstrame la sala / el baño".
 * Se mantiene image_urls como array plano (compatibilidad total).
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-property-photo-labels-v0935.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.35 — etiquetas de fotos en properties...');

  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS image_labels JSONB NOT NULL DEFAULT '{}';`);
  console.log('✅ properties.image_labels (default {})');

  console.log('🎉 Migración v0.9.35 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
