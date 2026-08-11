/**
 * Migración v0.9.19 — Handoff multi-tenant
 *
 * 1. tenants.alert_phone: número de WhatsApp donde ESA org recibe las alertas
 *    de leads calificados (configurable por el owner en el panel).
 *    Fallback legacy: tenant 1 sin alert_phone usa env OWNER_PHONE.
 * 2. push_subscriptions.tenant_id: las suscripciones legacy (NULL) se asignan
 *    al tenant 1 (eran de José). El broadcast ahora filtra por tenant.
 * 3. push_subscriptions.user_id: reservado para filtrar por usuario/línea
 *    cuando se configure web push con VAPID.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-alerts-v0919.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.19 — handoff multi-tenant...');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS alert_phone TEXT;`);
  console.log('✅ tenants.alert_phone');

  await db.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS tenant_id INTEGER;`);
  await db.query(`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_id INTEGER;`);
  const fixed = await db.query(`UPDATE push_subscriptions SET tenant_id = 1 WHERE tenant_id IS NULL;`);
  console.log(`✅ push_subscriptions.tenant_id/user_id (${fixed.rowCount} legacy → tenant 1)`);

  console.log('🎉 Migración v0.9.19 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
