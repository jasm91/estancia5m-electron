/**
 * migrate-audit-logs.js — v0.8.0 Sprint 1
 *
 * Tabla audit_logs cross-tenant. Cualquier acción importante queda registrada
 * con su tenant_id, actor, payload. Cap de 5000 entries por tenant, prune >30 días.
 *
 * Patrón idéntico a EstanciaPro.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando audit_logs...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id              BIGSERIAL PRIMARY KEY,
        tenant_id       INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
        -- tenant_id puede ser NULL para acciones cross-tenant (ej: super-admin creando un tenant)

        action          TEXT NOT NULL,          -- 'tenant_created', 'lead_qualified', 'asset_uploaded', etc.
        entity          TEXT,                   -- 'tenant', 'conversation', 'asset', 'lead'
        entity_id       TEXT,                   -- id de la entidad afectada (puede ser string o number)

        actor_type      TEXT NOT NULL,          -- 'super-admin', 'tenant-admin', 'tenant-viewer', 'bot', 'system'
        actor_id        TEXT,                   -- token hint o identificador del actor
        actor_ip        TEXT,
        actor_ua        TEXT,
        actor_geo       TEXT,                   -- código país opcional

        payload         JSONB,                  -- detalles específicos de la acción
        result          TEXT,                   -- 'success', 'error', 'partial'

        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Índices
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_tenant_created ON audit_logs(tenant_id, created_at DESC);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at DESC);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id) WHERE entity IS NOT NULL;`);

    console.log('✅ Tabla audit_logs creada');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-audit-logs:', err);
    process.exit(1);
  }
})();
