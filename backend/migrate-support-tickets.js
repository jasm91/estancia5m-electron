/**
 * migrate-support-tickets.js — v0.8.0 Sprint 1
 *
 * Tickets de soporte. En SG Ventas pueden venir desde:
 *   - Botón "Reportar problema" en el panel del tenant
 *   - Comandos en WhatsApp (/soporte, /bug) si se implementa después
 *
 * Funcionan desde día 1 sin el problema legacy de cross-bot de EstanciaPro,
 * porque SG Ventas tiene UN solo modelo de bot (multi-tenant centralizado).
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando support_tickets...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id              SERIAL PRIMARY KEY,
        tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

        code            TEXT NOT NULL UNIQUE,        -- "SG-2026-0001" auto-generado
        status          TEXT NOT NULL DEFAULT 'open', -- open/in_progress/resolved/closed

        priority        TEXT DEFAULT 'normal',       -- low/normal/high/urgent

        -- Quién reporta
        reporter_type   TEXT NOT NULL,               -- 'tenant-admin', 'tenant-viewer', 'whatsapp-user'
        reporter_phone  TEXT,                        -- si vino por WhatsApp
        reporter_name   TEXT,
        reporter_email  TEXT,

        -- Contenido
        subject         TEXT NOT NULL,
        body            TEXT NOT NULL,
        attachments     JSONB DEFAULT '[]'::jsonb,   -- [{ r2_key, type, name }]

        -- Procesamiento
        assigned_to     TEXT,                        -- 'super-admin' o un user específico
        internal_notes  TEXT,                        -- notas privadas del super-admin
        resolution      TEXT,                        -- qué se hizo

        -- Notificación al usuario
        notif_status    TEXT DEFAULT 'none',         -- none/pending/sent/failed
        notif_message   TEXT,                        -- último mensaje enviado al usuario
        notif_sent_at   TIMESTAMPTZ,

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at     TIMESTAMPTZ
      );
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status ON support_tickets(tenant_id, status);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_status_priority ON support_tickets(status, priority, created_at DESC);`);

    console.log('✅ Tabla support_tickets creada');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-support-tickets:', err);
    process.exit(1);
  }
})();
