/**
 * Migración v0.9.400 — Fase 1 de especialización Concesionaria/Vehículos.
 *
 * El modo Vehículos usa la tabla genérica `inventory_items` (mismo shape que "artículos").
 * Para que Aitana venda autos con la inteligencia de inmuebles, cada ítem-vehículo necesita
 * campos propios. `brand` (=marca) ya existe; agregamos el resto + `specs` JSONB para la
 * ficha técnica completa (como la cartilla del fabricante: autonomía, batería, potencia, etc.).
 *
 * Todas NULL para los ítems que no son vehículos → no afecta a los otros rubros.
 * Idempotente. Registrada en migrate-all.js.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.400 — campos de vehículo en inventory_items...');
  const cols = [
    ['model', 'TEXT'],              // modelo (brand ya existe = marca)
    ['model_year', 'INTEGER'],      // año
    ['km', 'INTEGER'],              // kilometraje (usados)
    ['body_type', 'TEXT'],          // sedán / SUV / pickup / hatchback / moto / furgón ...
    ['fuel', 'TEXT'],               // nafta / diésel / GNC / eléctrico / híbrido
    ['transmission', 'TEXT'],       // mecánica / automática
    ['condition', 'TEXT'],          // 0km / usado
    ['version', 'TEXT'],            // versión / trim
    ['specs', 'JSONB'],             // ficha técnica completa (libre): {autonomia_km, bateria_kwh, potencia_hp, ...}
  ];
  for (const [name, type] of cols) {
    await db.query(`ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS ${name} ${type};`);
  }
  // Índices para el matcher (presupuesto/tipo/año/km) — parciales, solo donde hay dato.
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inventory_vehicle ON inventory_items (tenant_id, body_type, model_year) WHERE body_type IS NOT NULL;`);
  console.log('✅ inventory_items: model, model_year, km, body_type, fuel, transmission, condition, version, specs');
  console.log('🎉 Migración v0.9.400 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración v0.9.400:', e.message);
  process.exit(1);
});
