/**
 * Migración v0.9.42 — Productos comerciales con ficha completa
 * (mismo patrón que inmuebles v0.9.33/v0.9.35)
 *
 * inventory_items:
 *   - image_urls   JSONB '[]' — hasta 20 fotos por producto
 *   - image_labels JSONB '{}' — mapa { url: "descripción" } (ej. "vista frontal",
 *                  "color rojo", "detalle de la suela") → Aitana manda LA foto pedida
 *   - file_urls    JSONB '[]' — PDFs [{url, name}] (catálogo/ficha técnica),
 *                  se mandan SOLO si el cliente los pide (send_docs)
 *   - brand        TEXT — marca
 *   - category     TEXT — categoría (ej. "calzados", "electrónica")
 *   - features     TEXT — características, una por línea (Aitana las lista en la ficha)
 *
 * Backfill: la foto única vieja (image_url) pasa a image_urls como primer elemento.
 * image_url se mantiene sincronizada (= primera foto) por compatibilidad.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-inventory-rich-v0942.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.42 — ficha completa de productos (inventory_items)...');

  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_urls   JSONB NOT NULL DEFAULT '[]';`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS image_labels JSONB NOT NULL DEFAULT '{}';`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS file_urls    JSONB NOT NULL DEFAULT '[]';`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS brand    TEXT;`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS category TEXT;`);
  await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS features TEXT;`);
  console.log('✅ columnas image_urls / image_labels / file_urls / brand / category / features');

  const bf = await db.query(`
    UPDATE inventory_items
    SET image_urls = jsonb_build_array(image_url)
    WHERE image_url IS NOT NULL AND image_url <> ''
      AND (image_urls IS NULL OR image_urls = '[]'::jsonb);
  `);
  console.log(`✅ backfill: ${bf.rowCount} producto(s) con su foto única migrada a image_urls`);

  console.log('🎉 Migración v0.9.42 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
