/**
 * migrate-tenants-embedded-signup.js
 *
 * Sprint 2 Fase A: agrega columnas a `tenants` necesarias para Meta Embedded Signup.
 *
 * Columnas agregadas (todas NULLABLE, cero riesgo):
 *   - meta_access_token            TEXT       (system user token del WABA del cliente)
 *   - meta_access_token_expires_at TIMESTAMPTZ (cuándo expira para renovar)
 *   - meta_business_portfolio_id   TEXT       (Business Portfolio ID del cliente)
 *   - meta_solution_id             TEXT       (Solution ID generado en Embedded Signup)
 *   - meta_onboarding_completed_at TIMESTAMPTZ (timestamp del onboarding exitoso)
 *   - webhook_subscribed           BOOLEAN    (¿está suscrito el WABA al webhook?)
 *
 * Estas columnas NO afectan el flujo actual (tenant 1 SG Bolivia las tiene NULL).
 * El refactor de meta.js para usar meta_access_token por tenant viene después.
 *
 * Idempotente: chequea si las columnas ya existen antes de agregar.
 */

require('dotenv').config();
const db = require('./db');

const COLUMNS_TO_ADD = [
  { name: 'meta_access_token', type: 'TEXT', comment: 'System user token del WABA del cliente (rotable)' },
  { name: 'meta_access_token_expires_at', type: 'TIMESTAMPTZ', comment: 'Vencimiento del token para renovar' },
  { name: 'meta_business_portfolio_id', type: 'TEXT', comment: 'Business Portfolio ID del cliente en Meta' },
  { name: 'meta_solution_id', type: 'TEXT', comment: 'Solution ID generado en Embedded Signup' },
  { name: 'meta_onboarding_completed_at', type: 'TIMESTAMPTZ', comment: 'Timestamp del onboarding exitoso' },
  { name: 'webhook_subscribed', type: 'BOOLEAN DEFAULT FALSE', comment: 'WABA suscrito al webhook' },
  // v0.9.122: flag del modo de venta ARQUITECTURA (consultivo, lee el catálogo
  // `services`). Va acá —migración que corre en cada deploy vía migrate-all— para
  // que la columna exista ANTES de que el api.js nuevo la escriba en MODE_FLAGS
  // (exclusividad), sin depender de correr v0987 a mano. Idempotente.
  { name: 'arquitectura_bot_enabled', type: 'BOOLEAN NOT NULL DEFAULT FALSE', comment: 'Modo de venta Arquitectura/Proyectos activo (exclusivo)' },
];

(async () => {
  console.log('🚀 Migración: agregar columnas Embedded Signup a tenants');

  try {
    // Verificar qué columnas ya existen
    const existing = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'tenants'
    `);
    const existingCols = new Set(existing.rows.map(r => r.column_name));

    let added = 0;
    let skipped = 0;

    for (const col of COLUMNS_TO_ADD) {
      if (existingCols.has(col.name)) {
        console.log(`   ⏭  ${col.name}: ya existe, salteando`);
        skipped++;
        continue;
      }

      const sql = `ALTER TABLE tenants ADD COLUMN ${col.name} ${col.type}`;
      console.log(`   ➕ Agregando ${col.name} (${col.type})...`);
      await db.query(sql);

      // Comentario para documentación interna en pg_description
      const escapedComment = col.comment.replace(/'/g, "''");
      await db.query(
        `COMMENT ON COLUMN tenants.${col.name} IS '${escapedComment}'`
      );

      console.log(`   ✅ ${col.name} agregada`);
      added++;
    }

    // Índice para búsquedas por meta_business_portfolio_id (útil al onboardear)
    const idxCheck = await db.query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'tenants' AND indexname = 'idx_tenants_meta_business_portfolio'
    `);
    if (idxCheck.rows.length === 0) {
      await db.query(`
        CREATE INDEX idx_tenants_meta_business_portfolio
        ON tenants(meta_business_portfolio_id)
        WHERE meta_business_portfolio_id IS NOT NULL
      `);
      console.log('   ✅ idx_tenants_meta_business_portfolio creado');
    } else {
      console.log('   ⏭  idx_tenants_meta_business_portfolio ya existe');
    }

    // Índice parcial para tokens que están por expirar (útil para renovación automática)
    const idxCheck2 = await db.query(`
      SELECT 1 FROM pg_indexes
      WHERE tablename = 'tenants' AND indexname = 'idx_tenants_meta_token_expires'
    `);
    if (idxCheck2.rows.length === 0) {
      await db.query(`
        CREATE INDEX idx_tenants_meta_token_expires
        ON tenants(meta_access_token_expires_at)
        WHERE meta_access_token_expires_at IS NOT NULL
      `);
      console.log('   ✅ idx_tenants_meta_token_expires creado');
    } else {
      console.log('   ⏭  idx_tenants_meta_token_expires ya existe');
    }

    console.log(`\n📊 Resumen: ${added} columnas agregadas, ${skipped} ya existían`);

    // Verificación final
    const verify = await db.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'tenants'
        AND column_name IN (
          'meta_access_token', 'meta_access_token_expires_at',
          'meta_business_portfolio_id', 'meta_solution_id',
          'meta_onboarding_completed_at', 'webhook_subscribed'
        )
      ORDER BY column_name
    `);
    console.log('\n📋 Columnas Embedded Signup en tenants:');
    for (const row of verify.rows) {
      console.log(`   - ${row.column_name} (${row.data_type}, nullable=${row.is_nullable})`);
    }

    console.log('\n✅ Migración completa');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migración:', err.message);
    console.error(err);
    process.exit(1);
  }
})();
