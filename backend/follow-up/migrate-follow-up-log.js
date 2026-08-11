/**
 * migrate-follow-up-log.js — Módulo Follow-up automático v1.0
 *
 * Tabla follow_up_log: registra cada follow-up que el worker programa, envía o cancela.
 * Una fila por intento de follow-up por conversación.
 *
 * Estados:
 *   - scheduled: planificado para enviar (timer no ejecutado todavía)
 *   - sent: enviado exitosamente vía Meta
 *   - failed: error al enviar (network, Meta API, etc.)
 *   - cancelled: cancelado manualmente desde el panel
 *   - skipped: el lead respondió antes de las 22-23h o ya no califica
 *   - window_expired: pasaron las 24h de Meta antes de poder enviarlo
 *
 * Multi-tenant desde día 1: incluye tenant_id como FK a tenants(id).
 *
 * También agrega columna follow_up_enabled a la tabla conversations
 * (default TRUE) para permitir override manual por conversación.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando follow_up_log...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS follow_up_log (
        id                  SERIAL PRIMARY KEY,
        tenant_id           INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

        conversation_id     INTEGER NOT NULL,
        lead_id             INTEGER,                      -- nullable: a veces no hay lead aún
        phone               TEXT NOT NULL,                 -- redundante pero útil para queries rápidas

        -- Programación
        scheduled_for       TIMESTAMPTZ NOT NULL,         -- cuándo el worker debería enviarlo
        sent_at             TIMESTAMPTZ,                  -- cuándo se mandó (NULL si aún no)

        -- Contenido del follow-up
        message_body        TEXT,                         -- mensaje generado por Gemini
        gemini_prompt       TEXT,                         -- prompt usado (para debug/audit)

        -- Estado
        status              TEXT NOT NULL DEFAULT 'scheduled',
        -- scheduled / sent / failed / cancelled / skipped / window_expired

        error_message       TEXT,                         -- si falló, por qué
        trigger_reason      TEXT,                         -- ej: '23h_score75'

        -- Tracking de respuesta del cliente
        response_received       BOOLEAN DEFAULT FALSE,
        response_received_at    TIMESTAMPTZ,
        response_message_id     INTEGER,                  -- FK al mensaje del cliente que respondió

        -- Score al momento del follow-up (para análisis)
        score_at_send       INTEGER,

        -- Meta WhatsApp message ID (para tracking)
        meta_message_id     TEXT,

        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Índices críticos para el worker
    await db.query(`CREATE INDEX IF NOT EXISTS idx_followup_scheduled
                    ON follow_up_log(scheduled_for, status)
                    WHERE status = 'scheduled';`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_followup_tenant_status
                    ON follow_up_log(tenant_id, status, scheduled_for DESC);`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_followup_conversation
                    ON follow_up_log(conversation_id, created_at DESC);`);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_followup_phone_tenant
                    ON follow_up_log(phone, tenant_id, created_at DESC);`);

    // Trigger updated_at
    await db.query(`
      CREATE OR REPLACE FUNCTION update_followup_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await db.query(`
      DROP TRIGGER IF EXISTS trg_followup_updated_at ON follow_up_log;
      CREATE TRIGGER trg_followup_updated_at
        BEFORE UPDATE ON follow_up_log
        FOR EACH ROW
        EXECUTE FUNCTION update_followup_updated_at();
    `);

    console.log('✅ Tabla follow_up_log creada');

    // === Nueva columna en conversations: follow_up_enabled ===
    console.log('▶ Agregando follow_up_enabled a conversations...');

    await db.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS follow_up_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    `);

    console.log('✅ Columna follow_up_enabled agregada a conversations');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-follow-up-log:', err);
    process.exit(1);
  }
})();
