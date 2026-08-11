/**
 * Migración v0.9.87 — Modos de venta independientes (separación física total)
 *
 * Cierra el modelo donde los rubros piggybackeaban la tabla del padre
 * (salud/belleza en `services`, restaurante en `inventory_items`).
 *
 * 1. tenants: +salud_bot_enabled, +belleza_bot_enabled, +restaurante_bot_enabled
 *    (flags propios, exclusivos como los demás modos — los maneja el OWNER).
 * 2. tenants.mode_visibility JSONB — control COSMÉTICO del super-admin
 *    (qué cards ve el cliente en la UI). NO define el modo activo.
 *    Default '{}' = todo visible.
 * 3. Tablas propias por rubro (separación física total):
 *      catalog_salud       (clon de services)
 *      catalog_belleza     (clon de services)
 *      catalog_restaurante (clon de inventory_items)
 *    Cada una con su PROPIA secuencia de id y FK a tenants ON DELETE CASCADE
 *    (el LIKE no copia FKs ni da secuencia propia).
 * 4. Backfill: tenants cuyo active_prompt_mode YA es un rubro →
 *    mueve sus filas del padre a la tabla nueva (atómico: DELETE..RETURNING + INSERT),
 *    prende el flag del rubro y apaga el resto (exclusividad).
 *    Idempotente: tras mover, el padre queda sin esas filas → re-run mueve 0.
 *
 * Aditiva y segura de correr ANTES de deployar api.js v0.9.87
 * (tablas/columnas nuevas no rompen el código viejo).
 *
 * Uso (sin exponer el secreto):
 *   railway run node backend/migrate-modos-independientes-v0987.js
 */
const db = require('./db');

async function cloneCatalog(table, source) {
  // 1. clonar estructura viva (columnas, NOT NULL, defaults, índices, PK). NO copia FKs.
  await db.query(`CREATE TABLE IF NOT EXISTS ${table} (LIKE ${source} INCLUDING ALL);`);
  // 2. secuencia propia para el id (el LIKE deja el default apuntando a la seq del padre)
  await db.query(`CREATE SEQUENCE IF NOT EXISTS ${table}_id_seq;`);
  await db.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_id_seq');`);
  await db.query(`ALTER SEQUENCE ${table}_id_seq OWNED BY ${table}.id;`);
  // 3. FK a tenants ON DELETE CASCADE (guardado contra re-run)
  await db.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_tenant_fk') THEN
        ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant_fk
          FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);
  console.log(`✅ ${table} (clon de ${source}, seq propia + FK ON DELETE CASCADE)`);
}

async function backfillRubro(rubro, flag, table, source) {
  // mover filas del padre → tabla del rubro (atómico en un solo statement)
  const moved = await db.query(`
    WITH moved AS (
      DELETE FROM ${source}
      WHERE tenant_id IN (SELECT id FROM tenants WHERE active_prompt_mode = $1)
      RETURNING *
    )
    INSERT INTO ${table} SELECT * FROM moved;
  `, [rubro]);
  // reasentar la secuencia (se preservaron los ids originales)
  await db.query(`SELECT setval('${table}_id_seq', COALESCE((SELECT MAX(id) FROM ${table}), 0) + 1, false);`);
  // exclusividad: prender SOLO el flag del rubro, apagar el resto (sin repetir columna)
  const ALL_FLAGS = [
    'software_bot_enabled', 'inventory_bot_enabled', 'realestate_bot_enabled',
    'services_bot_enabled', 'salud_bot_enabled', 'belleza_bot_enabled', 'restaurante_bot_enabled',
    'arquitectura_bot_enabled', // v0.9.122
  ];
  const offSets = ALL_FLAGS.filter((f) => f !== flag).map((f) => `${f} = false`).join(', ');
  const upd = await db.query(`
    UPDATE tenants SET ${offSets}, ${flag} = true
    WHERE active_prompt_mode = $1;
  `, [rubro]);
  console.log(`   ↳ ${rubro}: ${moved.rowCount} fila(s) ${source} → ${table} · ${upd.rowCount} tenant(s) con ${flag}=true`);
}

async function migrate() {
  console.log('🔧 v0.9.87 — modos de venta independientes (separación física total)...');

  // 1. flags propios de los rubros (los maneja el owner)
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS salud_bot_enabled        BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS belleza_bot_enabled      BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS restaurante_bot_enabled  BOOLEAN NOT NULL DEFAULT FALSE;`);
  // v0.9.122: arquitectura — modo consultivo de alto ticket. Flag propio y
  // exclusivo como los demás; LEE el catálogo `services` (paquetes del estudio),
  // por eso NO clona una tabla nueva (a diferencia de salud/belleza).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS arquitectura_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('✅ tenants.{salud,belleza,restaurante,arquitectura}_bot_enabled');

  // 2. visibilidad cosmética (super-admin) — no define qué corre
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS mode_visibility JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  console.log("✅ tenants.mode_visibility (cosmético, '{}' = todo visible)");

  // 3. tablas propias por rubro
  await cloneCatalog('catalog_salud', 'services');
  await cloneCatalog('catalog_belleza', 'services');
  await cloneCatalog('catalog_restaurante', 'inventory_items');

  // 4. backfill de los que YA usan un rubro
  console.log('🔁 Backfill de tenants con rubro activo (probablemente 0)...');
  await backfillRubro('salud', 'salud_bot_enabled', 'catalog_salud', 'services');
  await backfillRubro('belleza', 'belleza_bot_enabled', 'catalog_belleza', 'services');
  await backfillRubro('restaurante', 'restaurante_bot_enabled', 'catalog_restaurante', 'inventory_items');

  console.log('🎉 Migración v0.9.87 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
