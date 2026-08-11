/**
 * migrate-leads-tenant-backfill-v0981.js — v0.9.81
 *
 * Los leads creados antes del fix en api.js (el INSERT no seteaba `tenant_id`)
 * tomaron el DEFAULT de la columna (`tenant_id = 1` = SG Bolivia), así que
 * quedaron MAL ATRIBUIDOS: el panel de los demás tenants filtra por
 * `l.tenant_id` y no los ve (caían todos en el tenant 1).
 *
 * Este backfill re-atribuye cada lead al tenant de SU conversación.
 * IDEMPOTENTE: solo toca leads cuyo tenant_id difiere del de su conversación.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Re-atribuyendo leads.tenant_id al tenant de su conversación...');
    const res = await db.query(`
      UPDATE leads l
         SET tenant_id = c.tenant_id,
             updated_at = NOW()
        FROM conversations c
       WHERE c.id = l.conversation_id
         AND l.tenant_id IS DISTINCT FROM c.tenant_id
    `);
    console.log(`   ✅ ${res.rowCount} lead(s) re-atribuido(s) a su tenant correcto.`);

    const left = await db.query(`
      SELECT COUNT(*)::int AS n
        FROM leads l JOIN conversations c ON c.id = l.conversation_id
       WHERE l.tenant_id IS DISTINCT FROM c.tenant_id`);
    console.log(`   Leads que aún difieren de su conversación: ${left.rows[0].n}`);

    console.log('✅ Re-atribución de leads.tenant_id completa.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-leads-tenant-backfill-v0981:', err);
    process.exit(1);
  }
})();
