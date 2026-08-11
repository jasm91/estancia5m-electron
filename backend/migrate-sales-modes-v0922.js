/**
 * Migración v0.9.22 — Modos de venta + Inmuebles + Cal
 *
 * Modo de venta = qué vende Aitana. Interruptores independientes por org:
 *   - software_bot_enabled   (servicios/software; default TRUE = comportamiento actual)
 *   - inventory_bot_enabled  (artículos comerciales; ya creado en v0.9.21)
 *   - realestate_bot_enabled (inmuebles; nuevo)
 *
 * 1. tenants.software_bot_enabled (default TRUE — no rompe nada).
 * 2. tenants.realestate_bot_enabled (default FALSE).
 * 3. tenants.cal_api_key (encriptada) — para mostrar reservas de Cal.com.
 * 4. Tabla properties (inmuebles): operación, tipo, zona, m², dorm/baños/garajes,
 *    precio, estado, descripción, varias imágenes (JSONB).
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-sales-modes-v0922.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.22 — modos de venta + inmuebles + cal...');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS software_bot_enabled BOOLEAN NOT NULL DEFAULT TRUE;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS realestate_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS cal_api_key TEXT;`);
  console.log('✅ flags de modo + cal_api_key en tenants');

  await db.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code        TEXT,
      title       TEXT NOT NULL,
      operation   TEXT NOT NULL DEFAULT 'venta',     -- venta | alquiler | anticretico
      type        TEXT NOT NULL DEFAULT 'casa',       -- casa | departamento | terreno | local | oficina | otro
      zone        TEXT,
      area_m2     NUMERIC(10,2),
      bedrooms    INTEGER,
      bathrooms   INTEGER,
      garages     INTEGER,
      price       NUMERIC(14,2),
      currency    TEXT NOT NULL DEFAULT 'USD',
      status      TEXT NOT NULL DEFAULT 'disponible', -- disponible | reservado | vendido
      description TEXT,
      image_urls  JSONB NOT NULL DEFAULT '[]'::jsonb,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_properties_tenant ON properties (tenant_id, active);`);
  console.log('✅ tabla properties + índice');

  console.log('🎉 Migración v0.9.22 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error en migración:', e.message); process.exit(1); });
