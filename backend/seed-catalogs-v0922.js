/**
 * v0.9.22 — Siembra ejemplos de inventario e inmuebles para probar.
 * Idempotente (no duplica por código/título). NO activa los modos — eso lo
 * hace José desde el panel (Config → 🎯 Modo de venta).
 *
 * Uso:
 *   DATABASE_URL="..." node seed-catalogs-v0922.js        # tenant 1
 *   DATABASE_URL="..." node seed-catalogs-v0922.js 3      # otro tenant
 */
const db = require('./db');
const TENANT = parseInt(process.argv[2]) || 1;

const ARTICLES = [
  { code: 'LAP-001', name: 'Laptop HP 15"', stock: 8,  price: 4200, currency: 'Bs', description: 'Core i5, 8GB RAM, 512GB SSD. Ideal oficina y estudio.' },
  { code: 'CEL-014', name: 'Celular Samsung A35', stock: 15, price: 2600, currency: 'Bs', description: '128GB, cámara 50MP, batería 5000mAh.' },
  { code: 'IMP-003', name: 'Impresora Epson L3250', stock: 0, price: 1450, currency: 'Bs', description: 'Multifunción con sistema continuo. (sin stock por ahora)' },
  { code: 'AUR-021', name: 'Auriculares inalámbricos', stock: 30, price: 180, currency: 'Bs', description: 'Bluetooth 5.3, estuche de carga, 24h de autonomía.' },
];

const PROPERTIES = [
  { title: 'Casa en Equipetrol', operation: 'venta', type: 'casa', zone: 'Equipetrol Norte', area_m2: 320, bedrooms: 4, bathrooms: 3, garages: 2, price: 285000, currency: 'USD', status: 'disponible', description: 'Casa moderna a estrenar, 2 plantas, patio amplio y churrasquera.' },
  { title: 'Departamento Av. San Martín', operation: 'alquiler', type: 'departamento', zone: 'Av. San Martín', area_m2: 95, bedrooms: 2, bathrooms: 2, garages: 1, price: 650, currency: 'USD', status: 'disponible', description: 'Depto amoblado en edificio con seguridad 24/7, piscina y gimnasio.' },
  { title: 'Terreno Urubó', operation: 'venta', type: 'terreno', zone: 'Urubó - Condominio cerrado', area_m2: 600, price: 78000, currency: 'USD', status: 'disponible', description: 'Lote plano en condominio con áreas verdes y club house.' },
  { title: 'Oficina Centro Empresarial', operation: 'alquiler', type: 'oficina', zone: 'Centro', area_m2: 60, bathrooms: 1, garages: 1, price: 480, currency: 'USD', status: 'reservado', description: 'Oficina lista para usar, aire acondicionado y recepción compartida.' },
];

async function seed() {
  console.log(`🌱 Sembrando catálogos de ejemplo para tenant ${TENANT}...`);
  let a = 0, p = 0;
  for (const it of ARTICLES) {
    try {
      const ex = await db.query('SELECT 1 FROM inventory_items WHERE tenant_id=$1 AND LOWER(code)=LOWER($2)', [TENANT, it.code]);
      if (ex.rows.length) { console.log(`  ⏭  art ${it.code}`); continue; }
      await db.query(
        `INSERT INTO inventory_items (tenant_id, code, name, stock, description, price, currency) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [TENANT, it.code, it.name, it.stock, it.description, it.price, it.currency]
      );
      a++; console.log(`  ✅ art ${it.code}`);
    } catch (e) {
      if (/inventory_items/.test(e.message) && /does not exist/.test(e.message)) { console.error('❌ Falta migración v0.9.21'); process.exit(1); }
      console.error(`  ⚠️  ${it.code}: ${e.message}`);
    }
  }
  for (const pr of PROPERTIES) {
    try {
      const ex = await db.query('SELECT 1 FROM properties WHERE tenant_id=$1 AND title=$2', [TENANT, pr.title]);
      if (ex.rows.length) { console.log(`  ⏭  inm ${pr.title}`); continue; }
      await db.query(
        `INSERT INTO properties (tenant_id, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [TENANT, pr.title, pr.operation, pr.type, pr.zone, pr.area_m2 ?? null, pr.bedrooms ?? null, pr.bathrooms ?? null, pr.garages ?? null, pr.price ?? null, pr.currency, pr.status, pr.description]
      );
      p++; console.log(`  ✅ inm ${pr.title}`);
    } catch (e) {
      if (/properties/.test(e.message) && /does not exist/.test(e.message)) { console.error('❌ Falta migración v0.9.22'); process.exit(1); }
      console.error(`  ⚠️  ${pr.title}: ${e.message}`);
    }
  }
  console.log(`🎉 Listo — ${a} artículos, ${p} inmuebles. Activá los modos en Config → 🎯 Modo de venta.`);
  process.exit(0);
}
seed().catch((e) => { console.error('❌', e.message); process.exit(1); });
