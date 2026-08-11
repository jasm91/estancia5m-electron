/**
 * migrate-tenant-ui-overrides-v0928h.js — v0.9.300
 * Overrides de VISIBILIDAD del panel por-tenant, controlados por el SUPER-ADMIN.
 * tenants.ui_overrides JSONB = mapa { "<feature_key>": false } donde false = OCULTAR
 * esa sección/botón para ESE tenant, INCLUSO para el rol Dueño (gana sobre el bypass de owner).
 * Modelo "solo ocultar": ausente o true = comportamiento normal por rol. Idempotente.
 *
 * Claves soportadas (fuente de verdad; el panel las mapea a selectores y el super-admin a labels):
 *   Secciones: nav_leads, nav_reservations, nav_pending, nav_tasks, nav_campaigns,
 *              nav_followups, nav_reports, nav_config, nav_comments
 *   Botones:   btn_export, btn_miplan, btn_campaign, btn_ai_master, btn_team_agenda
 *   Config:    cfg_catalog, cfg_users, cfg_lines, cfg_channels, cfg_notifications, cfg_perms
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.300 — tenants.ui_overrides (visibilidad por-tenant desde super-admin)…');
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ui_overrides JSONB;`);
  console.log('✅ tenants.ui_overrides (JSONB, modelo solo-ocultar).');
  console.log('🎉 Migración v0.9.300 (ui_overrides) completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
