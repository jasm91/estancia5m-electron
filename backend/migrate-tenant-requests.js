/**
 * migrate-tenant-requests.js — v0.8.0 Sprint 1
 *
 * Pipeline de signup. Cuando un cliente nuevo se registra (manualmente vía formulario,
 * o por landing page futura), se crea una request. José la revisa y aprueba/rechaza.
 * Al aprobar, se crea automáticamente el tenant.
 *
 * Patrón idéntico a EstanciaPro.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando tenant_requests...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS tenant_requests (
        id              SERIAL PRIMARY KEY,
        status          TEXT NOT NULL DEFAULT 'pending',  -- pending/approved/rejected

        -- Datos que el cliente envía al registrarse
        name            TEXT NOT NULL,                    -- "Lavadero Premium SRL"
        contact_name    TEXT,                             -- "Juan Pérez"
        contact_email   TEXT,
        contact_phone   TEXT,                             -- E.164
        vertical_interest TEXT,                           -- "lavadero", "dental", "comercial", etc.
        message         TEXT,                             -- "Quiero usar Aitana para mi negocio"
        plan_interest   TEXT,                             -- 'trial', 'basic', 'pro'

        -- Metadata
        source          TEXT,                             -- 'panel-form', 'landing', 'manual', 'whatsapp'
        ip              TEXT,
        user_agent      TEXT,

        -- Review (al aprobar/rechazar)
        reviewed_at     TIMESTAMPTZ,
        reviewed_by     TEXT,                             -- 'super-admin' o token hint
        review_notes    TEXT,
        rejection_reason TEXT,
        created_tenant_id INTEGER REFERENCES tenants(id), -- si fue aprobado, qué tenant_id se creó

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_treq_status_created ON tenant_requests(status, created_at DESC);`);

    console.log('✅ Tabla tenant_requests creada');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-tenant-requests:', err);
    process.exit(1);
  }
})();
