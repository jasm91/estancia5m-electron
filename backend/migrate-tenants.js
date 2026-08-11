/**
 * migrate-tenants.js — v0.8.0 Sprint 1
 *
 * Crea la tabla raíz `tenants`. Es la fuente de verdad para el multi-tenant.
 *
 * Patrón reutilizado de EstanciaPro con mejoras:
 *   - tenant_id es INTEGER puro (no string "tenant_<N>" como legacy de EstanciaPro)
 *   - token se almacena hasheado con bcrypt (no en texto plano)
 *   - columnas específicas de SG Ventas: meta_phone_number_id, gemini_api_key_enc, r2_prefix
 *
 * IDEMPOTENTE: CREATE TABLE IF NOT EXISTS.
 *
 * NOTA: el cifrado de meta_token / app_secret / gemini_api_key se hace a nivel
 * de aplicación (módulo crypto.js) usando AES-256-GCM con key en env var.
 * En la DB se guardan ya cifrados. La columna se llama *_enc para recordarlo.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando tabla tenants...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id                       SERIAL PRIMARY KEY,
        slug                     TEXT UNIQUE NOT NULL,
        name                     TEXT NOT NULL,

        -- Auth
        token_hash               TEXT NOT NULL,
        token_lookup_hint        TEXT,           -- primeros 8 chars del token plano, ayuda búsqueda

        -- Status / suspensión
        active                   BOOLEAN NOT NULL DEFAULT TRUE,
        read_only                BOOLEAN NOT NULL DEFAULT FALSE,
        suspended_at             TIMESTAMPTZ,
        suspended_reason         TEXT,

        -- Plan / facturación
        plan                     TEXT NOT NULL DEFAULT 'trial',  -- trial/basic/pro/enterprise
        billing_email            TEXT,
        billing_status           TEXT NOT NULL DEFAULT 'trial',  -- trial/active/overdue/suspended
        plan_quota_msgs          INTEGER,         -- NULL = ilimitado
        plan_quota_assets_mb     INTEGER,         -- NULL = ilimitado

        -- Meta WhatsApp Business config (este es el ruteo clave)
        meta_phone_number_id     TEXT UNIQUE,     -- los webhooks llegan con este id
        waba_id                  TEXT,
        phone_display            TEXT,            -- "+591 615..." para mostrar
        meta_token_enc           TEXT,            -- AES-256-GCM cifrado
        meta_app_secret_enc      TEXT,            -- AES-256-GCM cifrado
        meta_verify_token        TEXT,            -- plano (se valida en GET handshake)

        -- Gemini API
        gemini_api_key_enc       TEXT,            -- NULL = usa la global de SG Bolivia

        -- R2 storage
        r2_prefix                TEXT NOT NULL,   -- "tenants/<slug>"

        -- n8n workflow
        n8n_webhook_url          TEXT,            -- URL del webhook que dispara el bot para este tenant

        -- Notificaciones al dueño
        owner_phone              TEXT,            -- E.164, recibe alertas de leads calificados

        -- Device tracking (decisión 12)
        devices                  JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_seen                TIMESTAMPTZ,
        last_device_os           TEXT,
        last_device_type         TEXT,            -- mobile/tablet/desktop
        last_panel_version       TEXT,            -- ej "v0.8.0"

        -- Misc
        notes                    TEXT,            -- notas internas de SG Bolivia
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Índices
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tenants_active ON tenants(active) WHERE active = TRUE;`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tenants_meta_phone_id ON tenants(meta_phone_number_id) WHERE meta_phone_number_id IS NOT NULL;`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tenants_token_hint ON tenants(token_lookup_hint) WHERE token_lookup_hint IS NOT NULL;`);

    // Trigger para updated_at
    await db.query(`
      CREATE OR REPLACE FUNCTION update_tenants_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.query(`
      DROP TRIGGER IF EXISTS tenants_updated_at_trigger ON tenants;
      CREATE TRIGGER tenants_updated_at_trigger
      BEFORE UPDATE ON tenants
      FOR EACH ROW EXECUTE FUNCTION update_tenants_updated_at();
    `);

    console.log('✅ Tabla tenants creada con índices y trigger');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-tenants:', err);
    process.exit(1);
  }
})();
