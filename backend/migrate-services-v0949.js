/**
 * Migración v0.9.49 — Modo de venta SERVICIOS (4to modo)
 *
 * Para negocios de servicios y reservas de espacios: canchas, salones de
 * eventos, consultorios, spas, gimnasios, coworking, alquiler de equipos.
 *
 * 1. tenants.services_bot_enabled — flag del modo (exclusivo como los demás)
 * 2. Tabla services:
 *    - name, category ("cancha", "salón", "masaje"...), description
 *    - price + currency + price_unit ('por hora'|'por sesión'|'por día'|'por persona'|'precio fijo')
 *    - duration_minutes (sesiones), capacity (espacios: personas)
 *    - features (una por línea), schedule_notes (horarios/disponibilidad en texto)
 *    - booking_url (link de reserva propio; si está vacío Aitana usa el de Cal de la org)
 *    - image_urls/image_labels/file_urls — fotos etiquetadas (hasta 20) y PDFs,
 *      mismo patrón que productos/inmuebles (photo_label / send_docs)
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-services-v0949.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.49 — modo de venta SERVICIOS...');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS services_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('✅ tenants.services_bot_enabled');

  await db.query(`
    CREATE TABLE IF NOT EXISTS services (
      id               SERIAL PRIMARY KEY,
      tenant_id        INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code             TEXT,
      name             TEXT NOT NULL,
      category         TEXT,
      description      TEXT,
      price            NUMERIC(12,2),
      currency         TEXT NOT NULL DEFAULT 'Bs',
      price_unit       TEXT NOT NULL DEFAULT 'por sesión',
      duration_minutes INTEGER,
      capacity         INTEGER,
      features         TEXT,
      schedule_notes   TEXT,
      booking_url      TEXT,
      image_urls       JSONB NOT NULL DEFAULT '[]',
      image_labels     JSONB NOT NULL DEFAULT '{}',
      file_urls        JSONB NOT NULL DEFAULT '[]',
      active           BOOLEAN NOT NULL DEFAULT TRUE,
      created_by       INTEGER,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_services_tenant ON services (tenant_id, active);`);
  console.log('✅ tabla services + índice');

  console.log('🎉 Migración v0.9.49 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
