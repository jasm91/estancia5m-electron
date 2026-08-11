/**
 * Migración v0.9.25 — Facturación para el panel super-admin
 *
 * Modelo de cobro (jun 2026):
 *   - Incorporación por línea (setup_fee, una vez)  → default $149
 *   - Aitana por línea (price_per_line, mensual)    → default $25
 *   - Usuario humano (price_per_user, mensual)      → default $15
 *   - Packs de mensajes masivos (message_packs)
 *
 * Crea:
 *   - tenants.price_per_line / price_per_user / setup_fee (override por tenant)
 *   - tenant_lines.setup_paid (si la tabla existe)
 *   - billing_payments: pagos registrados a mano desde el panel
 *   - message_packs: packs de mensajes vendidos
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-billing-v0925.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.25 — billing super-admin...');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS price_per_line NUMERIC(10,2) NOT NULL DEFAULT 25;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS price_per_user NUMERIC(10,2) NOT NULL DEFAULT 15;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS setup_fee NUMERIC(10,2) NOT NULL DEFAULT 149;`);
  console.log('✅ tenants.price_per_line / price_per_user / setup_fee (25 / 15 / 149)');

  // tenant_lines.setup_paid — solo si la tabla existe (v0.9.13+)
  const linesTable = await db.query(`SELECT to_regclass('public.tenant_lines') AS t;`);
  if (linesTable.rows[0].t) {
    await db.query(`ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS setup_paid BOOLEAN NOT NULL DEFAULT FALSE;`);
    console.log('✅ tenant_lines.setup_paid (default false)');
  } else {
    console.log('⚠️  tenant_lines no existe — salteo setup_paid (correr migración v0.9.13 primero)');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS billing_payments (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      period     TEXT NOT NULL,                 -- 'YYYY-MM' al que aplica el pago
      concept    TEXT NOT NULL DEFAULT 'monthly', -- 'monthly' | 'setup' | 'pack' | 'other'
      amount     NUMERIC(10,2) NOT NULL,
      method     TEXT,                          -- transferencia | qr | efectivo | tarjeta | otro
      note       TEXT,
      line_id    INTEGER,                       -- si concept='setup', la línea cobrada
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_billing_payments_tenant_period ON billing_payments (tenant_id, period);`);
  console.log('✅ tabla billing_payments');

  await db.query(`
    CREATE TABLE IF NOT EXISTS message_packs (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      size       INTEGER NOT NULL,              -- cantidad de mensajes del pack
      price      NUMERIC(10,2) NOT NULL,
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_message_packs_tenant ON message_packs (tenant_id);`);
  console.log('✅ tabla message_packs');

  console.log('🎉 Migración v0.9.25 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
