/**
 * Migración v0.9.9 — Tabla template_sends
 *
 * Registra cada envío de plantilla de WhatsApp (Meta-approved template).
 * Sirve para:
 *   - Mostrar el costo Meta real por tenant (count × tarifa según categoría).
 *   - Auditar campañas (envío masivo, Capa 2) vía campaign_id.
 *   - Evitar re-enganches duplicados (Capa 3).
 *
 * Recordá: mensajes de servicio (respuestas dentro de 24h) son GRATIS.
 * Solo los templates de marketing/auth fuera de ventana tienen costo.
 *
 * Uso:
 *   DATABASE_URL="..." node migrate-template-sends.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 Creando tabla template_sends...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS template_sends (
      id              BIGSERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL,
      conversation_id INTEGER,                 -- opcional
      phone           TEXT NOT NULL,           -- destinatario
      template_name   TEXT NOT NULL,
      language        TEXT,                    -- ej "es"
      category        TEXT,                    -- MARKETING | UTILITY | AUTHENTICATION
      campaign_id     TEXT,                    -- agrupa envíos masivos (Capa 2); null en manual
      wa_message_id   VARCHAR(255),            -- id de Meta
      status          VARCHAR(20) DEFAULT 'sent', -- sent | failed
      error_message   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Índice para el panel: costo Meta por tenant y por fecha (filtro mensual)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_template_sends_tenant_date
    ON template_sends (tenant_id, created_at);
  `);

  // Índice para agrupar campañas
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_template_sends_campaign
    ON template_sends (campaign_id);
  `);

  console.log('✅ Tabla template_sends creada (índices tenant+fecha y campaign).');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
