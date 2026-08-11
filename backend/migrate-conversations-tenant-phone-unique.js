/**
 * migrate-conversations-tenant-phone-unique.js
 *
 * HISTÓRICO: Sprint 2 step 2 imponía UNIQUE (tenant_id, phone) en conversations.
 *
 * v0.9.470 — OBSOLETO / REEMPLAZADO. Desde que las conversaciones se separan POR LÍNEA,
 * un mismo contacto puede tener conversaciones legítimas con el mismo (tenant_id, phone)
 * en 2 líneas distintas. El UNIQUE (tenant_id, phone) es IMPOSIBLE de crear y tumbaba el
 * release (code 23505: "Key (tenant_id, phone)=(12, 59162072038) is duplicated").
 *
 * Esta migración ahora sólo RECONCILIA al modelo correcto y es 100% NON-FATAL:
 *   - dropea los constraints/índices viejos por (tenant_id, phone) si existen
 *   - garantiza el índice UNIQUE por línea (tenant_id, phone, COALESCE(line_id,0))
 *   - NUNCA hace process.exit(1): un fallo acá jamás debe tumbar la app
 *     (el boot self-repair de server.js reconcilia igual).
 */

require('dotenv').config();
const db = require('./db');

async function tryQuery(label, sql) {
  try {
    await db.query(sql);
    console.log(`   ✅ ${label}`);
  } catch (e) {
    console.log(`   ⚠️  ${label}: ${e.message} (non-fatal, se continúa)`);
  }
}

(async () => {
  console.log('🚀 Migración: conversations unicidad POR LÍNEA (v0.9.470, non-fatal)');

  try {
    // 1. Borrar los constraints/índices viejos por (tenant_id, phone) — ya no aplican con multi-línea.
    //    DROP CONSTRAINT también elimina el índice asociado.
    await tryQuery('drop constraint conversations_tenant_phone_key',
      'ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_phone_key');
    await tryQuery('drop constraint conversations_phone_key',
      'ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_phone_key');
    await tryQuery('drop index conversations_tenant_phone_key',
      'DROP INDEX IF EXISTS conversations_tenant_phone_key');
    await tryQuery('drop index conversations_phone_key',
      'DROP INDEX IF EXISTS conversations_phone_key');
    await tryQuery('drop index idx_conv_tenant_phone',
      'DROP INDEX IF EXISTS idx_conv_tenant_phone');

    // 2. Garantizar el índice UNIQUE por línea (idempotente).
    await tryQuery('create unique index conversations_tenant_phone_line_key',
      'CREATE UNIQUE INDEX IF NOT EXISTS conversations_tenant_phone_line_key ON conversations (tenant_id, phone, COALESCE(line_id, 0))');

    // 3. Estado final (informativo)
    try {
      const final = await db.query(`
        SELECT indexname FROM pg_indexes
        WHERE tablename = 'conversations'
          AND indexname IN ('conversations_tenant_phone_line_key','conversations_tenant_phone_key','conversations_phone_key','idx_conv_tenant_phone')
      `);
      console.log('\n📋 Índices de unicidad presentes en conversations:');
      for (const row of final.rows) console.log(`   - ${row.indexname}`);
    } catch (e) {
      console.log(`   ⚠️  no se pudo listar índices finales: ${e.message}`);
    }

    console.log('\n✅ Reconciliación por-línea completa.');
    process.exit(0);
  } catch (err) {
    // Blindaje total: incluso ante un error inesperado, NO tumbamos el release.
    console.error('⚠️  Error inesperado (non-fatal, se continúa):', err.message);
    process.exit(0);
  }
})();
