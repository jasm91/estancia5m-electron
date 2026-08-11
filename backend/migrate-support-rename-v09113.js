/**
 * migrate-support-rename-v09113.js — v0.9.113 (Fase 0 de la Mesa de Soporte / BPO)
 *
 * Desambigua la COLISIÓN de la tabla `support_tickets`.
 *
 * Hay DOS tablas históricas con ese nombre y schemas incompatibles:
 *   - v0.8.0 (migrate-support-tickets.js): bug-reporting de tenants hacia SG.
 *     Firma distintiva: columna `reporter_type`. ESTÁ en migrate-all.js (prod).
 *   - v0.9.91 (migrate-support-v0991.js / ahora -bpo-v09113b): el CASO de soporte
 *     (conversation_id, assigned_agent_id, SLA, CSAT). NO estaba en migrate-all.js.
 *
 * Como ambas usaban `CREATE TABLE IF NOT EXISTS support_tickets`, en cualquier
 * entorno donde ya exista la vieja, el schema de BPO NUNCA se aplicaba (silencioso).
 *
 * Esta migración RENOMBRA la vieja a `platform_tickets` para liberar el nombre
 * `support_tickets` (que pasa a ser el de BPO). OJO: en Postgres los nombres de
 * índice, secuencia y constraint son GLOBALES por schema → hay que renombrar
 * también `support_tickets_pkey`, `support_tickets_id_seq` e
 * `idx_tickets_tenant_status` / `idx_tickets_status_priority`, o la migración de
 * BPO no podría recrearlos con esos mismos nombres.
 *
 * Idempotente y GUARDADA: solo renombra si existe `support_tickets` Y es la legacy
 * (tiene `reporter_type`). Si ya existe `platform_tickets`, o si la `support_tickets`
 * presente NO es la legacy (ya es la de BPO), no toca nada.
 *
 * Uso: node migrate-support-rename-v09113.js   (corre antes de -bpo-v09113b.js)
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.113 — desambiguar support_tickets (legacy → platform_tickets)…');

  // (a) Si ya existe platform_tickets, el rename ya se hizo → idempotente, salir.
  const hasPlatform = await db.query(`SELECT to_regclass('public.platform_tickets') AS t`);
  if (hasPlatform.rows[0].t) {
    console.log('ℹ️  platform_tickets ya existe — rename ya aplicado. Skip.');
    process.exit(0);
  }

  // (b) Si no existe support_tickets, es instalación fresca (la legacy aún no se
  //     creó, o nunca existió) → nada que renombrar.
  const hasSupport = await db.query(`SELECT to_regclass('public.support_tickets') AS t`);
  if (!hasSupport.rows[0].t) {
    console.log('ℹ️  no existe support_tickets — nada que renombrar. Skip.');
    process.exit(0);
  }

  // (c) Guarda: solo renombrar si la support_tickets presente es la LEGACY.
  //     La legacy tiene `reporter_type`; la de BPO no.
  const isLegacy = await db.query(`
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'support_tickets'
       AND column_name  = 'reporter_type'
  `);
  if (isLegacy.rows.length === 0) {
    console.log('⚠️  support_tickets existe pero NO es la legacy (sin reporter_type): ya es la de BPO. NO se renombra. Skip.');
    process.exit(0);
  }

  // (d) Es la legacy. Renombrar tabla + objetos globales (PK, secuencia, índices).
  //     ALTER ... IF EXISTS en índices/secuencia para no romper si algún nombre
  //     difiere por instalaciones viejas.
  await db.query(`ALTER TABLE support_tickets RENAME TO platform_tickets;`);
  console.log('✅ tabla support_tickets → platform_tickets');

  await db.query(`ALTER INDEX IF EXISTS support_tickets_pkey RENAME TO platform_tickets_pkey;`);
  await db.query(`ALTER SEQUENCE IF EXISTS support_tickets_id_seq RENAME TO platform_tickets_id_seq;`);
  await db.query(`ALTER INDEX IF EXISTS support_tickets_code_key RENAME TO platform_tickets_code_key;`);
  await db.query(`ALTER INDEX IF EXISTS idx_tickets_tenant_status RENAME TO idx_platform_tickets_tenant_status;`);
  await db.query(`ALTER INDEX IF EXISTS idx_tickets_status_priority RENAME TO idx_platform_tickets_status_priority;`);
  console.log('✅ PK / secuencia / índices globales liberados (prefijo platform_)');

  console.log('🎉 Rename completo. El nombre support_tickets queda libre para la tabla de BPO.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
