/**
 * migrate-fix-leads-tenant-v09107.js — v0.9.107
 * ---------------------------------------------------------------------------
 * FIX de aislamiento multi-tenant: el INSERT de leads omitía tenant_id, así que
 * TODOS los leads nacían con el default de la columna (tenant_id = 1 = SG Bolivia).
 * Resultado: los leads de todos los tenants se mezclaban en SG Bolivia.
 *
 * Este backfill re-asigna cada lead al tenant de SU conversación (fuente de
 * verdad). Idempotente: solo toca los que están mal.
 *
 * Correr junto con el deploy del api.js corregido (que ya inserta tenant_id).
 *
 * Uso:
 *   DATABASE_URL="$DATABASE_PUBLIC_URL" NODE_ENV=production node migrate-fix-leads-tenant-v09107.js
 * ---------------------------------------------------------------------------
 */
const db = require('./db');

(async () => {
  try {
    console.log('▶ migrate-fix-leads-tenant-v09107 — backfill leads.tenant_id');

    // Cuántos están mal antes de tocar
    const bad = await db.query(`
      SELECT COUNT(*) AS n
        FROM leads l
        JOIN conversations c ON c.id = l.conversation_id
       WHERE l.tenant_id IS DISTINCT FROM c.tenant_id
    `);
    console.log(`  • leads con tenant_id incorrecto: ${bad.rows[0].n}`);

    // Re-asignar al tenant de su conversación
    const r = await db.query(`
      UPDATE leads l
         SET tenant_id = c.tenant_id
        FROM conversations c
       WHERE c.id = l.conversation_id
         AND l.tenant_id IS DISTINCT FROM c.tenant_id
    `);
    console.log(`  ✓ ${r.rowCount} leads re-asignados a su tenant correcto`);

    // Sanity: ¿quedó alguno huérfano (lead sin conversación)? — informativo
    const orphan = await db.query(`
      SELECT COUNT(*) AS n FROM leads l
       WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = l.conversation_id)
    `);
    if (Number(orphan.rows[0].n) > 0) {
      console.log(`  ⚠️  ${orphan.rows[0].n} leads sin conversación (huérfanos) — revisar aparte`);
    }

    console.log('✔ migrate-fix-leads-tenant-v09107 OK');
    process.exit(0);
  } catch (e) {
    console.error('❌ Error en migrate-fix-leads-tenant-v09107:', e);
    process.exit(1);
  }
})();
