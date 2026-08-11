/**
 * Migración v0.9.46 — Módulo de Campañas outbound
 *
 * template_campaigns (ya existe desde v0.9.9) suma:
 *   - name         TEXT          nombre amigable de la campaña
 *   - scheduled_at TIMESTAMPTZ   si se programó a futuro (NULL = inmediata)
 *   - var_mapping  JSONB         mapeo de variables guardado (para ejecutar luego)
 *   - delay_ms     INTEGER       throttle entre envíos
 *   - status admite: 'running' | 'done' | 'scheduled' | 'cancelled'
 *
 * campaign_optout — lista de exclusión por tenant. Un teléfono acá NUNCA recibe
 *   campañas (se filtra en resolveBroadcastAudience). Se llena a mano desde el
 *   panel o automáticamente cuando un cliente responde BAJA/STOP.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-campaigns-v0946.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.46 — módulo de campañas...');

  // template_campaigns puede no existir si nunca se corrió v0.9.9 → crearla base
  await db.query(`
    CREATE TABLE IF NOT EXISTS template_campaigns (
      id            TEXT PRIMARY KEY,
      tenant_id     INTEGER NOT NULL,
      template_name TEXT NOT NULL,
      language      TEXT NOT NULL,
      category      TEXT,
      total         INTEGER NOT NULL DEFAULT 0,
      sent          INTEGER NOT NULL DEFAULT 0,
      failed        INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'running',
      audience      JSONB,
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at   TIMESTAMPTZ
    );
  `);

  await db.query(`ALTER TABLE template_campaigns ADD COLUMN IF NOT EXISTS name         TEXT;`);
  await db.query(`ALTER TABLE template_campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;`);
  await db.query(`ALTER TABLE template_campaigns ADD COLUMN IF NOT EXISTS var_mapping  JSONB;`);
  await db.query(`ALTER TABLE template_campaigns ADD COLUMN IF NOT EXISTS delay_ms     INTEGER;`);
  console.log('✅ template_campaigns +name/scheduled_at/var_mapping/delay_ms');

  await db.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_created ON template_campaigns (tenant_id, created_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled ON template_campaigns (status, scheduled_at) WHERE status = 'scheduled';`);
  console.log('✅ índices de campañas');

  await db.query(`
    CREATE TABLE IF NOT EXISTS campaign_optout (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL,
      phone      TEXT NOT NULL,
      reason     TEXT,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_optout_tenant_phone ON campaign_optout (tenant_id, phone);`);
  console.log('✅ tabla campaign_optout');

  console.log('🎉 Migración v0.9.46 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
