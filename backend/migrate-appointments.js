/**
 * migrate-appointments.js — Sg Sales v0.8.2
 *
 * Tabla `appointments` para guardar las citas creadas via Cal.com webhook.
 * Columna `calcom_webhook_secret` en `tenants` para verificar firmas de Cal.com.
 *
 * Idempotente: usa IF NOT EXISTS.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando tabla appointments...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,

        -- Datos del evento (de Cal.com)
        external_id VARCHAR(255) UNIQUE,
        external_uid VARCHAR(255),
        provider VARCHAR(32) DEFAULT 'calcom',
        event_type_slug VARCHAR(128),

        -- Cliente
        attendee_name VARCHAR(255),
        attendee_email VARCHAR(255),
        attendee_phone VARCHAR(64),
        attendee_timezone VARCHAR(64),

        -- Fechas
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,

        -- Meet/conferencia
        meet_url TEXT,
        meet_id VARCHAR(255),

        -- Estado
        status VARCHAR(32) DEFAULT 'scheduled',  -- scheduled | cancelled | rescheduled | completed | no_show
        cancellation_reason TEXT,

        -- Raw para debug
        raw_payload JSONB,

        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_appointments_tenant ON appointments(tenant_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appointments_conversation ON appointments(conversation_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appointments_starts ON appointments(starts_at);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);`);

    console.log('✅ Tabla appointments creada');

    // Agregar columnas a tenants para configuración de Cal.com
    console.log('▶ Agregando columnas calcom_* a tenants...');

    await db.query(`
      ALTER TABLE tenants
      ADD COLUMN IF NOT EXISTS calcom_webhook_secret TEXT,
      ADD COLUMN IF NOT EXISTS calcom_event_url TEXT;
    `);

    console.log('✅ Columnas calcom_* agregadas a tenants');

    // Seed para tenant 1 (SG Bolivia)
    // Link de Cal.com de Jose (josesaid.itesm@gmail.com, username jose-said-3jwb0g)
    await db.query(`
      UPDATE tenants
      SET calcom_event_url = COALESCE(calcom_event_url, 'https://cal.com/jose-said-3jwb0g/demo-sg-sales')
      WHERE id = 1 AND calcom_event_url IS NULL;
    `);

    console.log('✅ Cal.com event URL placeholder seteado para tenant 1');
    console.log('');
    console.log('🎯 PRÓXIMO PASO MANUAL:');
    console.log('   1. En Railway, agregar env CALCOM_WEBHOOK_SECRET con el secret de Cal.com');
    console.log('   2. (Opcional) Si tu URL final NO es cal.com/jose-said/demo-sg-sales:');
    console.log('      UPDATE tenants SET calcom_event_url = \'https://cal.com/TU-SLUG/TU-EVENT\' WHERE id = 1;');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-appointments:', err);
    process.exit(1);
  }
})();
