/**
 * migrate-c21-agents-v09384.js — v0.9.384
 * ASESOR ASIGNADO (facilitación C21). Cuando un inmueble ya está asignado a un asesor
 * colega (Century 21), el equipo funciona como facilitador y necesita verlo en el
 * resumen del lead y poder escribirle por WhatsApp.
 *
 *  - properties.assigned_agent_name TEXT: el asesor que trae el Excel C21
 *    (columnas nombre + apellidoP + apellidoM). Se captura en la carga masiva.
 *  - c21_agents(tenant_id, name, phone): DIRECTORIO editable por tenant. El Excel NO
 *    trae teléfonos, así que el número de WhatsApp se carga acá UNA vez por asesor y
 *    se resuelve al mostrar (agregar un número no requiere re-importar). La carga masiva
 *    autocompleta la lista con los asesores que detecta (phone queda null hasta cargarlo).
 *
 * INTERNO: este dato es solo para el equipo del panel; Aitana NUNCA se lo manda al cliente.
 * Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.384 — asesor asignado C21: properties.assigned_agent_name + tabla c21_agents…');
  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS assigned_agent_name text;`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS c21_agents (
      id          serial PRIMARY KEY,
      tenant_id   integer NOT NULL,
      name        text NOT NULL,
      phone       text,
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
    );
  `);
  // Un asesor por nombre y tenant (case-insensitive) → el UPSERT de la carga masiva es estable.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS c21_agents_tenant_name_uidx ON c21_agents (tenant_id, lower(name));`);
  // v0.9.386 — flag por-tenant para el botón "👥 Asesores C21" (lo prende/apaga el super-admin, igual que la carga masiva C21).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS c21_agents_enabled boolean DEFAULT false;`);
  // Seed: los tenants que YA tienen la carga masiva C21 habilitada arrancan con el botón de asesores prendido (no lo pierden al deployar).
  await db.query(`UPDATE tenants SET c21_agents_enabled = true WHERE COALESCE(c21_import_enabled, false) = true AND c21_agents_enabled IS DISTINCT FROM true;`);
  console.log('✅ properties.assigned_agent_name + c21_agents + tenants.c21_agents_enabled listos.');
  console.log('🎉 Migración v0.9.384 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
