/**
 * migrate-media-assets-unique-v098.js — v0.9.8
 *
 * Cambia el UNIQUE de media_assets de (asset_id) global a (tenant_id, asset_id),
 * para que cada tenant pueda tener sus propios asset_ids sin colisionar con otros.
 *
 * Transaccional + idempotente. Mantiene la PK (id) intacta.
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node migrate-media-assets-unique-v098.js
 */

const db = require('./db');

(async () => {
  const client = await db.pool.connect();
  try {
    console.log('🚀 Migrando UNIQUE de media_assets → (tenant_id, asset_id)\n');

    // Idempotencia: ¿ya existe el unique compuesto?
    const composite = await client.query(`
      SELECT 1 FROM pg_constraint
      WHERE conrelid = 'media_assets'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) ILIKE '%(tenant_id, asset_id)%'
    `);
    if (composite.rows.length > 0) {
      console.log('⏭  El UNIQUE (tenant_id, asset_id) ya existe. Nada que hacer.');
      client.release();
      process.exit(0);
    }

    await client.query('BEGIN');

    // Soltar el UNIQUE viejo (asset_id global), si existe
    const oldUnique = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'media_assets'::regclass AND contype = 'u'
        AND pg_get_constraintdef(oid) ILIKE '%(asset_id)%'
    `);
    for (const row of oldUnique.rows) {
      await client.query(`ALTER TABLE media_assets DROP CONSTRAINT ${row.conname}`);
      console.log(`   - UNIQUE viejo ${row.conname} soltado`);
    }

    // Crear el UNIQUE compuesto
    await client.query(`
      ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_tenant_asset_key UNIQUE (tenant_id, asset_id)
    `);
    console.log('   ✅ UNIQUE (tenant_id, asset_id) creado');

    // Verificar que tenant 1 conserva sus assets
    const n = await client.query(`SELECT COUNT(*)::int AS n FROM media_assets WHERE tenant_id = 1`);
    console.log(`   media_assets tenant 1: ${n.rows[0].n} filas`);

    await client.query('COMMIT');
    console.log('\n✅ COMMIT — media_assets ahora es único por (tenant_id, asset_id)');
    client.release();
    process.exit(0);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ ROLLBACK:', err.message);
    console.error('Nada cambió.');
    client.release();
    process.exit(1);
  }
})();
