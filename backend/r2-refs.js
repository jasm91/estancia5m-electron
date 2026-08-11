/**
 * r2-refs.js — v0.9.272
 *
 * FUENTE ÚNICA de las columnas/tablas que referencian objetos de R2 (imágenes, PDFs, assets,
 * media de chat, comprobantes). La usan: el endpoint /api/admin/storage (atribución por tenant +
 * huérfanos), su purga, y el cron de mantenimiento (storage-maintenance.js).
 *
 * Tener esto en UN solo lugar evita que el conteo de huérfanos y el borrado se desincronicen
 * (que fue exactamente el bug v0.9.271: faltaban catálogos de rubro, media de chat y comprobantes,
 * y "Purgar huérfanos" los habría borrado).
 *
 * Cada query va con try/catch en el caller → si una tabla/columna no existe, se ignora sola.
 */

const R2_URL_QUERIES = [
  // Inmuebles
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM properties`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM properties`,
  // Servicios
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM services`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM services`,
  // Artículos / inventario
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM inventory_items`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM inventory_items`,
  `SELECT tenant_id, image_url AS url FROM inventory_items WHERE image_url IS NOT NULL`,
  // Assets (materiales de demo)
  `SELECT tenant_id, url FROM media_assets WHERE url IS NOT NULL`,
  // Catálogos de rubro
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM catalog_salud`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM catalog_salud`,
  `SELECT tenant_id, image_url AS url FROM catalog_salud WHERE image_url IS NOT NULL`,
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM catalog_belleza`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM catalog_belleza`,
  `SELECT tenant_id, image_url AS url FROM catalog_belleza WHERE image_url IS NOT NULL`,
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM catalog_restaurante`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM catalog_restaurante`,
  `SELECT tenant_id, image_url AS url FROM catalog_restaurante WHERE image_url IS NOT NULL`,
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM catalog_vehiculos`,
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM catalog_vehiculos`,
  `SELECT tenant_id, image_url AS url FROM catalog_vehiculos WHERE image_url IS NOT NULL`,
  `SELECT tenant_id, jsonb_array_elements_text(image_urls) AS url FROM catalog_arquitectura`, // v0.9.452
  `SELECT tenant_id, jsonb_array_elements_text(file_urls)  AS url FROM catalog_arquitectura`, // v0.9.452
  // v0.9.570 — ARTE DE PROMOCIONES TEMPORALES (properties.promotions[].images).
  // SIN esta línea purgeOrphans las borraría: no las referencia ningún otro catálogo.
  `SELECT tenant_id, jsonb_array_elements_text(promo -> 'images') AS url
     FROM properties, jsonb_array_elements(COALESCE(to_jsonb(properties) -> 'promotions', '[]'::jsonb)) AS promo
    WHERE jsonb_typeof(promo -> 'images') = 'array'`,
  // Media de chat (fotos/videos/audios que se mandan y reciben) + comprobantes de pago
  `SELECT tenant_id, media_url AS url FROM messages WHERE media_url IS NOT NULL`,
  `SELECT tenant_id, image_url AS url FROM tenant_payments WHERE image_url IS NOT NULL`,
  `SELECT tenant_id, receipt_url AS url FROM billing_payments WHERE receipt_url IS NOT NULL`,   // v0.9.281 — comprobantes de pago (billing_payments): sin esto purgeOrphans los borraba
];

/**
 * Devuelve un Set con TODAS las keys de R2 referenciadas por cualquier catálogo/tabla.
 * @param {*} db   módulo de DB (con .query)
 * @param {*} r2   módulo r2 (con .extractKeyFromUrl)
 */
async function getReferencedKeys(db, r2) {
  const set = new Set();
  for (const sql of R2_URL_QUERIES) {
    try {
      const r = await db.query(sql);
      for (const row of r.rows) {
        if (!row.url) continue;
        const k = r2.extractKeyFromUrl(row.url);
        if (k) set.add(k);
      }
    } catch (_) { /* tabla/columna inexistente → ignorar */ }
  }
  return set;
}

module.exports = { R2_URL_QUERIES, getReferencedKeys };
