/**
 * SG Ventas - Migrations
 * Crea las tablas en PostgreSQL. Ejecutar con: node migrate.js
 * Es idempotente — se puede correr varias veces sin romper nada.
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const SCHEMA = `
-- ============================================================
-- conversations: una fila por número de WhatsApp en contacto
-- ============================================================
CREATE TABLE IF NOT EXISTS conversations (
  id              SERIAL PRIMARY KEY,
  phone           VARCHAR(20) NOT NULL UNIQUE,
  contact_name    VARCHAR(255),
  mode            VARCHAR(10) NOT NULL DEFAULT 'bot',  -- 'bot' | 'human'
  campaign_ref    VARCHAR(100),                         -- ej: REF-FB-MAY26-CRM
  vertical        VARCHAR(50),                          -- crm | inventario | restaurante | otro
  last_message_at TIMESTAMPTZ,
  unread_count    INTEGER NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'open',  -- open | closed | archived
  bant_progress   JSONB DEFAULT '{}'::jsonb,            -- estado acumulativo BANT
  spin_progress   JSONB DEFAULT '{}'::jsonb,            -- estado acumulativo SPIN
  current_score   INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_conversations_mode_status ON conversations(mode, status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON conversations(last_message_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_conversations_phone ON conversations(phone);

-- ============================================================
-- messages: historial completo de la conversación
-- ============================================================
CREATE TABLE IF NOT EXISTS messages (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  wa_message_id    VARCHAR(255) UNIQUE,                 -- id de Meta (idempotencia)
  direction        VARCHAR(10) NOT NULL,                -- incoming | outgoing
  sender_type      VARCHAR(10) NOT NULL DEFAULT 'client', -- client | bot | human | system
  type             VARCHAR(20) NOT NULL DEFAULT 'text', -- text | image | audio | video | document | location
  body             TEXT,
  media_id         VARCHAR(255),                        -- id de media en Meta (entrantes)
  media_url        TEXT,                                -- URL pública (salientes)
  media_mime_type  VARCHAR(100),
  media_caption    TEXT,
  transcription    TEXT,                                -- transcripción si es audio entrante
  raw_payload      JSONB,
  status           VARCHAR(20) DEFAULT 'sent',          -- queued | sent | delivered | read | failed
  error_message    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_conv_created ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_direction ON messages(direction);

-- ============================================================
-- leads: leads calificados por el bot
-- ============================================================
CREATE TABLE IF NOT EXISTS leads (
  id               SERIAL PRIMARY KEY,
  conversation_id  INTEGER NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  phone            VARCHAR(20) NOT NULL,
  name             VARCHAR(255),
  email            VARCHAR(255),
  company          VARCHAR(255),
  vertical         VARCHAR(50),
  bant             JSONB,
  spin             JSONB,
  score            INTEGER DEFAULT 0,
  status           VARCHAR(20) NOT NULL DEFAULT 'new',
  -- new | contacted | qualified | proposal_sent | won | lost
  summary          TEXT,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);

-- Migración idempotente para tablas creadas antes del UNIQUE constraint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint 
    WHERE conname = 'leads_conversation_id_unique' OR conname = 'leads_conversation_id_key'
  ) THEN
    -- Limpiar duplicados existentes (deja solo el más reciente por conversation_id)
    DELETE FROM leads a USING leads b
    WHERE a.id < b.id AND a.conversation_id = b.conversation_id;
    
    -- Agregar constraint
    BEGIN
      ALTER TABLE leads ADD CONSTRAINT leads_conversation_id_unique UNIQUE (conversation_id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- ============================================================
-- media_assets: catálogo de videos/imágenes/PDFs que el bot puede enviar
-- ============================================================
CREATE TABLE IF NOT EXISTS media_assets (
  id            SERIAL PRIMARY KEY,
  asset_id      VARCHAR(100) UNIQUE NOT NULL,           -- ej: 'demo_crm_90s'
  type          VARCHAR(20) NOT NULL,                   -- video | image | document | audio
  url           TEXT NOT NULL,                          -- URL pública (Cloudflare R2)
  mime_type     VARCHAR(100),
  caption       TEXT,                                   -- texto que acompaña al asset
  vertical      VARCHAR(50),                            -- crm | inventario | etc | null=general
  triggers      TEXT[],                                 -- palabras/frases que sugieren mandar este asset
  description   TEXT,                                   -- para que Gemini entienda qué hace este asset
  active        BOOLEAN NOT NULL DEFAULT true,
  send_count    INTEGER DEFAULT 0,                      -- analytics: cuántas veces se envió
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_media_assets_vertical ON media_assets(vertical);
CREATE INDEX IF NOT EXISTS idx_media_assets_active ON media_assets(active);

-- ============================================================
-- handover_requests: cuándo se solicitó pasar a humano y por qué
-- ============================================================
CREATE TABLE IF NOT EXISTS handover_requests (
  id              SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reason          VARCHAR(50),         -- 'qualified_lead' | 'client_requested_human' | 'bot_failed'
  triggered_by    VARCHAR(20),         -- 'bot' | 'admin' | 'client'
  notes           TEXT,
  notified_owner  BOOLEAN DEFAULT FALSE,
  notified_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_handover_conv ON handover_requests(conversation_id);

-- Migración idempotente: agregar columnas si no existen (para tablas creadas antes)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='handover_requests' AND column_name='notified_owner') THEN
    ALTER TABLE handover_requests ADD COLUMN notified_owner BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='handover_requests' AND column_name='notified_at') THEN
    ALTER TABLE handover_requests ADD COLUMN notified_at TIMESTAMPTZ;
  END IF;
END $$;

-- ============================================================
-- Trigger: actualizar updated_at automáticamente
-- ============================================================
CREATE OR REPLACE FUNCTION trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_timestamp_conversations ON conversations;
CREATE TRIGGER set_timestamp_conversations
BEFORE UPDATE ON conversations
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();

DROP TRIGGER IF EXISTS set_timestamp_leads ON leads;
CREATE TRIGGER set_timestamp_leads
BEFORE UPDATE ON leads
FOR EACH ROW EXECUTE FUNCTION trigger_set_timestamp();
`;

const SEED_MEDIA_ASSETS = `
-- v0.7.6: ya no seedeamos assets de ejemplo.
-- Los assets son contenido del usuario, no schema. Se cargan desde la consola
-- Configuración → Assets. Antes acá había 5 placeholders con URLs
-- 'CAMBIAR-CON-TU-URL...' que reaparecían en cada deploy aunque el usuario
-- los hubiera borrado. Ahora la tabla queda vacía en instalaciones nuevas.
SELECT 1;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('🔧 Aplicando schema...');
    await client.query(SCHEMA);
    console.log('✅ Schema aplicado');

    console.log('🌱 (v0.7.6: seed de assets removido — gestión vía consola)');
    await client.query(SEED_MEDIA_ASSETS);
    console.log('✅ Schema listo');

    console.log('\n📊 Estado actual de la base:');
    const tables = await client.query(`
      SELECT table_name, (
        SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = t.table_name AND table_schema = 'public'
      ) AS columns
      FROM information_schema.tables t
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    tables.rows.forEach(r => console.log(`  • ${r.table_name} (${r.columns} columnas)`));

    console.log('\n✅ Migración completada');
  } catch (e) {
    console.error('❌ Error en migración:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
