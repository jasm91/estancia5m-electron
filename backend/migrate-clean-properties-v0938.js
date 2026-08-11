/**
 * migrate-clean-properties-v0938.js — v0.9.338
 * Limpieza de datos del catálogo de inmuebles (hallazgos de la auditoría UI/UX 8-jul-2026):
 *
 * 1. MOJIBAKE: títulos/descripciones/zonas con rachas de "??" (encoding roto del Excel C21)
 *    → se eliminan las rachas de 2+ signos de interrogación y se colapsan espacios/guiones
 *    huérfanos. Un "?" solo (pregunta legítima) NO se toca.
 * 2. PRECIOS CON DECIMALES SUELTOS: "12169965.6" se REDONDEA al entero (inofensivo en Bs/USD
 *    de inmuebles y arregla el render "Bs 12.169.965,6").
 * 3. PRECIOS SOSPECHOSOS (posible error de escala, ej. "Bs 13.076" por un edificio en venta):
 *    NO se corrigen solos — se LISTAN en el log para revisión manual. Corregir montos de un
 *    cliente sin confirmar es peor que el bug.
 *
 * Idempotente: re-ejecutar no cambia nada si ya está limpio.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.338 — limpieza de catálogo de inmuebles…');

  // 1) Mojibake en title / description / zone
  const dirty = await db.query(`SELECT id, tenant_id, title FROM properties WHERE title ~ '\\?{2,}' OR description ~ '\\?{2,}' OR zone ~ '\\?{2,}'`);
  if (dirty.rows.length) {
    console.log(`   🧹 ${dirty.rows.length} propiedad(es) con encoding roto (??):`);
    dirty.rows.forEach((r) => console.log(`      - #${r.id} (t${r.tenant_id}): ${String(r.title).slice(0, 70)}`));
    await db.query(`
      UPDATE properties SET
        title = NULLIF(TRIM(regexp_replace(regexp_replace(COALESCE(title, ''), '\\?{2,}', '', 'g'), '\\s*[–-]\\s*$|\\s{2,}', ' ', 'g')), ''),
        description = NULLIF(TRIM(regexp_replace(COALESCE(description, ''), '\\?{2,}', '', 'g')), ''),
        zone = NULLIF(TRIM(regexp_replace(COALESCE(zone, ''), '\\?{2,}', '', 'g')), '')
      WHERE title ~ '\\?{2,}' OR description ~ '\\?{2,}' OR zone ~ '\\?{2,}';
    `);
    // título que quedó vacío tras limpiar → fallback comercial
    await db.query(`
      UPDATE properties SET title = INITCAP(COALESCE(type, 'Inmueble')) || COALESCE(' en ' || zone, '')
      WHERE title IS NULL OR TRIM(title) = '';
    `);
    console.log('   ✅ Mojibake limpiado (título vacío → fallback "Tipo en Zona").');
  } else {
    console.log('   ✅ Sin mojibake en el catálogo.');
  }

  // 2) Decimales sueltos → redondear
  const dec = await db.query(`UPDATE properties SET price = ROUND(price) WHERE price IS NOT NULL AND price <> ROUND(price) RETURNING id, tenant_id, price`);
  console.log(dec.rows.length
    ? `   ✅ ${dec.rows.length} precio(s) con decimales redondeados: ${dec.rows.map((r) => '#' + r.id).join(', ')}`
    : '   ✅ Sin precios con decimales sueltos.');

  // 3) Sospechosos de escala — SOLO reporte (no se tocan)
  const sus = await db.query(`
    SELECT id, tenant_id, title, operation, type, price, currency FROM properties
    WHERE active = TRUE AND price IS NOT NULL AND operation = 'venta'
      AND ((UPPER(COALESCE(currency, 'Bs')) IN ('BS', 'BOB') AND price < 50000)
        OR (UPPER(COALESCE(currency, '')) = 'USD' AND price < 8000))
    ORDER BY tenant_id, price`);
  if (sus.rows.length) {
    console.log(`   ⚠️  ${sus.rows.length} precio(s) SOSPECHOSOS de escala (VENTA demasiado barata) — revisar a mano:`);
    sus.rows.forEach((r) => console.log(`      - #${r.id} (t${r.tenant_id}) ${r.currency || 'Bs'} ${r.price} · ${String(r.title).slice(0, 60)}`));
    console.log('      (No se corrigen automáticamente: confirmá con el cliente y editá desde el panel.)');
  } else {
    console.log('   ✅ Sin precios sospechosos de escala.');
  }

  console.log('🎉 Migración v0.9.338 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
