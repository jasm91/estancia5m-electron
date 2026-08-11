/**
 * Migración v0.9.33 — Inmuebles: ubicación de mapa + documentos (PDFs)
 *
 *   - properties.maps_url   TEXT  — link de Google Maps (u otro mapa) de la
 *     propiedad. Aitana lo incluye en la ficha y el panel lo muestra.
 *   - properties.file_urls  JSONB — array de documentos adjuntos
 *     [{ url, name }] (planos, brochures, reglamentos en PDF, etc.).
 *     Aitana los manda como documento después de las fotos.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-property-attachments-v0933.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.33 — mapa + documentos en properties...');

  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS maps_url TEXT;`);
  console.log('✅ properties.maps_url');

  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS file_urls JSONB NOT NULL DEFAULT '[]';`);
  console.log('✅ properties.file_urls (default [])');

  console.log('🎉 Migración v0.9.33 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
