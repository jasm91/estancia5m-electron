/**
 * Migración v0.9.9 — Tabla template_campaigns
 *
 * Estado de cada campaña de envío masivo de plantillas.
 * El envío corre en background; esta tabla guarda el progreso
 * (total / sent / failed / status) que el panel consulta por polling.
 * Cada envío individual se loguea en template_sends con este campaign_id.
 *
 * Uso:
 *   DATABASE_URL="..." node migrate-template-campaigns.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 Creando tabla template_campaigns...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS template_campaigns (
      id            TEXT PRIMARY KEY,              -- campaign_id (camp_...)
      tenant_id     INTEGER NOT NULL,
      template_name TEXT NOT NULL,
      language      TEXT,
      category      TEXT,
      total         INTEGER NOT NULL DEFAULT 0,
      sent          INTEGER NOT NULL DEFAULT 0,
      failed        INTEGER NOT NULL DEFAULT 0,
      status        VARCHAR(20) NOT NULL DEFAULT 'running', -- running | done | error
      audience      JSONB,
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at   TIMESTAMPTZ
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_template_campaigns_tenant
    ON template_campaigns (tenant_id, created_at);
  `);

  console.log('✅ Tabla template_campaigns creada.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
