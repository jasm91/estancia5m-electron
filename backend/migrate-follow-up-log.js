/**
 * migrate-follow-up-log.js — v0.7.22 Follow-up automático
 *
 * Crea tabla follow_up_log para tracking de todos los follow-ups generados,
 * enviados, respondidos, fallidos, cancelados.
 *
 * Agrega columna follow_up_enabled a conversations (para opt-out por conversación
 * sin afectar el toggle global).
 *
 * IDEMPOTENTE: CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando tabla follow_up_log...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS follow_up_log (
        id               SERIAL PRIMARY KEY,
        tenant_id        INTEGER NOT NULL DEFAULT 1,
        conversation_id  INTEGER NOT NULL,

        -- Status del follow-up
        status           TEXT NOT NULL DEFAULT 'scheduled',
          -- 'scheduled' | 'sent' | 'failed' | 'cancelled' | 'skipped' | 'window_expired'

        -- Mensaje generado por Gemini (texto que se envió o se va a enviar)
        message_body     TEXT,

        -- Contexto del momento en que se programó
        score_at_send    INTEGER,
        vertical_at_send TEXT,

        -- Timestamps
        scheduled_for    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at          TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        -- Tracking de respuesta del cliente
        response_received      BOOLEAN NOT NULL DEFAULT FALSE,
        response_at            TIMESTAMPTZ,
        response_message_id    INTEGER,

        -- Error (si falló)
        error_message    TEXT,

        -- Constraints
        CONSTRAINT fk_followup_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
        CONSTRAINT fk_followup_conversation FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);

    // Índices
    await db.query(`CREATE INDEX IF NOT EXISTS idx_fu_tenant_status ON follow_up_log(tenant_id, status);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_fu_tenant_conv ON follow_up_log(tenant_id, conversation_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_fu_scheduled ON follow_up_log(scheduled_for) WHERE status = 'scheduled';`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_fu_sent_recent ON follow_up_log(tenant_id, sent_at DESC) WHERE sent_at IS NOT NULL;`);

    console.log('✅ Tabla follow_up_log creada con índices');

    // ─── Columna follow_up_enabled en conversations ──────────────
    console.log('\n▶ Agregando follow_up_enabled a conversations...');
    const colExists = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'conversations' AND column_name = 'follow_up_enabled'
    `);
    if (colExists.rows.length > 0) {
      console.log('⏭ Columna follow_up_enabled ya existe, salteando');
    } else {
      await db.query(`ALTER TABLE conversations ADD COLUMN follow_up_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
      console.log('✅ Columna follow_up_enabled agregada (DEFAULT TRUE)');
    }

    console.log('\n✅ Migración follow_up_log completa.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-follow-up-log:', err);
    process.exit(1);
  }
})();
