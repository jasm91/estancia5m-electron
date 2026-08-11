/**
 * migrate-clean-prop-price-lines-v0946.js — v0.9.346
 * Quita de `properties.description` las líneas "Precio: $us. 93.000.-" que el Excel C21
 * trae DENTRO de la descripción (hallazgo del test en vivo 8-jul-2026): la ficha mostraba
 * el precio dos veces (campo `price` en Bs + "$us" en la descripción), a veces contradictorios.
 * El precio vive SOLO en el campo `price` — fuente única.
 *
 * NO toca el campo `price` ni `currency` (montos del cliente no se corrigen solos).
 * Idempotente: re-ejecutar no cambia nada si ya está limpio.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.346 — limpieza de líneas "Precio:" en descripciones de inmuebles…');

  // Extensión unaccent para el agrupado de "Zonas más pedidas" (Equipétrol = Equipetrol).
  // Si el rol no puede crear extensiones, el endpoint tiene fallback sin unaccent.
  try {
    await db.query('CREATE EXTENSION IF NOT EXISTS unaccent;');
    console.log('   ✅ Extensión unaccent disponible (agrupado de zonas sin acentos).');
  } catch (e) {
    console.log('   ⚠️  No se pudo crear la extensión unaccent (' + e.message + ') — el endpoint de zonas usará el fallback.');
  }

  // v0.9.348: también "Precio de alquiler:" / "Precio de venta:" (hallazgo del 3er test en vivo).
  const dirty = await db.query(
    `SELECT id, tenant_id, title FROM properties WHERE description ~* '(^|\\n)\\s*precio(\\s+de\\s+\\S+)?\\s*[:.]'`
  );
  if (!dirty.rows.length) {
    console.log('   ✅ Sin líneas "Precio:" en descripciones.');
    return;
  }
  console.log(`   🧹 ${dirty.rows.length} propiedad(es) con "Precio:" en la descripción:`);
  dirty.rows.forEach((r) => console.log(`      - #${r.id} (t${r.tenant_id}): ${String(r.title).slice(0, 70)}`));

  // Borra cada línea que EMPIEZA con "Precio:" o "Precio." (case-insensitive), completa hasta
  // el salto de línea; después colapsa saltos de línea triples y recorta bordes.
  await db.query(`
    UPDATE properties SET description = NULLIF(TRIM(BOTH E' \\n\\r\\t' FROM
      regexp_replace(
        regexp_replace(description, '(^|\\n)\\s*[Pp][Rr][Ee][Cc][Ii][Oo](\\s+[Dd][Ee]\\s+\\S+)?\\s*[:.][^\\n]*', '\\1', 'g'),
        E'\\n{3,}', E'\\n\\n', 'g'
      )), '')
    WHERE description ~* '(^|\\n)\\s*precio(\\s+de\\s+\\S+)?\\s*[:.]';
  `);
  console.log('   ✅ Líneas "Precio:" eliminadas (el precio queda solo en el campo price).');
}

module.exports = migrate;
if (require.main === module) migrate().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
