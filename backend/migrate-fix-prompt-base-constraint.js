/**
 * Fix puntual — bot_prompt_base sin UNIQUE(tenant_id)
 *
 * Tras las migraciones multi-tenant, bot_prompt_base quedó con un índice
 * compuesto (tenant_id, id) en vez de una constraint única sobre tenant_id.
 * Eso rompe el `ON CONFLICT (tenant_id)` al guardar el prompt base
 * ("there is no unique or exclusion constraint matching the ON CONFLICT").
 *
 * Este script:
 *   1. Deduplica filas por tenant (deja la de mayor version/id).
 *   2. Agrega UNIQUE(tenant_id).
 * Así el guardado funciona YA con el código actualmente deployado.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-fix-prompt-base-constraint.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 Fix bot_prompt_base UNIQUE(tenant_id)...');

  // 1. Deduplicar (por si quedó más de una fila por tenant)
  const dup = await db.query(`
    DELETE FROM bot_prompt_base a
    USING bot_prompt_base b
    WHERE a.tenant_id = b.tenant_id
      AND a.ctid < b.ctid;
  `);
  console.log(`  → ${dup.rowCount} fila(s) duplicada(s) eliminada(s)`);

  // 2. Agregar la constraint única (si ya existe, ignora)
  try {
    await db.query(`ALTER TABLE bot_prompt_base ADD CONSTRAINT bot_prompt_base_tenant_unique UNIQUE (tenant_id);`);
    console.log('✅ UNIQUE(tenant_id) agregada');
  } catch (e) {
    if (/already exists|ya existe|duplicate/i.test(e.message)) {
      console.log('✅ La constraint ya existía — nada que hacer');
    } else {
      throw e;
    }
  }

  console.log('🎉 Listo. Ya podés guardar el prompt base.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
