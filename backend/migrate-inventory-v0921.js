/**
 * Migración v0.9.21 — Módulo de inventario
 *
 * 1. inventory_items: catálogo de artículos por organización.
 *    code, name, stock, description, image_url, price (opcional), currency, active.
 * 2. tenants.inventory_bot_enabled: interruptor por org. Si está ON, Aitana
 *    conoce el catálogo y puede enviarlo (consulta DISPONIBILIDAD, nunca revela
 *    números de stock al cliente — eso se controla en el payload a n8n).
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-inventory-v0921.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.21 — módulo de inventario...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      stock       INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      image_url   TEXT,
      price       NUMERIC(12,2),
      currency    TEXT NOT NULL DEFAULT 'Bs',
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_code
    ON inventory_items (tenant_id, LOWER(code));
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_inventory_tenant ON inventory_items (tenant_id, active);`);
  console.log('✅ tabla inventory_items + índices');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS inventory_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('✅ tenants.inventory_bot_enabled');

  console.log('🎉 Migración v0.9.21 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error en migración:', e.message); process.exit(1); });
