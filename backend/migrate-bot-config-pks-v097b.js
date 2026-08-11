/**
 * migrate-bot-config-pks-v097b.js — v0.9.7 (Sprint 1) — CORREGIDA
 *
 * Las 5 tablas YA tienen tenant_id (de una migración previa). Esta migration
 * SOLO cambia las PKs naturales por PKs compuestas con tenant_id, para que
 * múltiples tenants puedan compartir el mismo vertical_id/plan_id/config_key.
 *
 * Cambios:
 *   bot_verticals:      PK (vertical_id)  → PK (tenant_id, vertical_id)
 *   bot_pricing_plans:  PK (plan_id)      → PK (tenant_id, plan_id)
 *   bot_global_config:  PK (config_key)   → PK (tenant_id, config_key)
 *   bot_prompt_base:    PK (id) + CHECK singleton → PK (tenant_id)  [rompe singleton]
 *   bot_proof_points:   PK (id) se MANTIENE; su FK a bot_verticals se recrea
 *                       apuntando a (tenant_id, vertical_id)
 *
 * SEGURIDAD:
 *   - TODO en una transacción (BEGIN/COMMIT). Falla → ROLLBACK, nada cambia.
 *   - IDEMPOTENTE: detecta si las PKs ya son compuestas y sale sin tocar.
 *   - Verifica al final que tenant 1 (SG Bolivia) conserva sus filas.
 *
 * Nombres de constraints confirmados por diagnóstico:
 *   bot_*_pkey (PKs), bot_prompt_base_singleton (CHECK),
 *   bot_proof_points_vertical_id_fkey (FK a recrear)
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node migrate-bot-config-pks-v097b.js
 */

const db = require('./db');

// Cuenta cuántas columnas tiene la PK de una tabla (para idempotencia)
async function pkColumnCount(client, table) {
  const r = await client.query(`
    SELECT COUNT(*)::int AS n
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = $1 AND tc.constraint_type = 'PRIMARY KEY'
  `, [table]);
  return r.rows[0].n;
}

(async () => {
  const client = await db.pool.connect();
  try {
    console.log('🚀 Migration de PKs multi-tenant (v0.9.7b — corregida)\n');

    // Idempotencia: si bot_verticals ya tiene PK compuesta (2 cols), ya está hecho
    const vCols = await pkColumnCount(client, 'bot_verticals');
    if (vCols >= 2) {
      console.log('⏭  bot_verticals ya tiene PK compuesta. Migration ya aplicada, saliendo.');
      client.release();
      process.exit(0);
    }

    await client.query('BEGIN');
    console.log('▶ Transacción iniciada (BEGIN)\n');

    // ───────────────────────────────────────────────────────────
    // 1. Soltar la FK de bot_proof_points → bot_verticals (apunta a PK vieja)
    // ───────────────────────────────────────────────────────────
    console.log('1️⃣  bot_proof_points: soltando FK vieja a bot_verticals...');
    await client.query(`ALTER TABLE bot_proof_points DROP CONSTRAINT IF EXISTS bot_proof_points_vertical_id_fkey`);
    console.log('   ✅ FK vieja soltada');

    // ───────────────────────────────────────────────────────────
    // 2. bot_verticals: PK (vertical_id) → (tenant_id, vertical_id)
    // ───────────────────────────────────────────────────────────
    console.log('2️⃣  bot_verticals: PK → (tenant_id, vertical_id)...');
    await client.query(`ALTER TABLE bot_verticals DROP CONSTRAINT bot_verticals_pkey`);
    await client.query(`ALTER TABLE bot_verticals ADD PRIMARY KEY (tenant_id, vertical_id)`);
    console.log('   ✅ hecho');

    // ───────────────────────────────────────────────────────────
    // 3. bot_pricing_plans: PK (plan_id) → (tenant_id, plan_id)
    // ───────────────────────────────────────────────────────────
    console.log('3️⃣  bot_pricing_plans: PK → (tenant_id, plan_id)...');
    await client.query(`ALTER TABLE bot_pricing_plans DROP CONSTRAINT bot_pricing_plans_pkey`);
    await client.query(`ALTER TABLE bot_pricing_plans ADD PRIMARY KEY (tenant_id, plan_id)`);
    console.log('   ✅ hecho');

    // ───────────────────────────────────────────────────────────
    // 4. bot_global_config: PK (config_key) → (tenant_id, config_key)
    // ───────────────────────────────────────────────────────────
    console.log('4️⃣  bot_global_config: PK → (tenant_id, config_key)...');
    await client.query(`ALTER TABLE bot_global_config DROP CONSTRAINT bot_global_config_pkey`);
    await client.query(`ALTER TABLE bot_global_config ADD PRIMARY KEY (tenant_id, config_key)`);
    console.log('   ✅ hecho');

    // ───────────────────────────────────────────────────────────
    // 5. bot_prompt_base: romper singleton + PK (id) → (tenant_id)
    // ───────────────────────────────────────────────────────────
    console.log('5️⃣  bot_prompt_base: rompiendo singleton + PK → (tenant_id)...');
    await client.query(`ALTER TABLE bot_prompt_base DROP CONSTRAINT IF EXISTS bot_prompt_base_singleton`);
    await client.query(`ALTER TABLE bot_prompt_base DROP CONSTRAINT bot_prompt_base_pkey`);
    await client.query(`ALTER TABLE bot_prompt_base ADD PRIMARY KEY (tenant_id)`);
    console.log('   ✅ singleton roto, PK ahora (tenant_id)');

    // ───────────────────────────────────────────────────────────
    // 6. bot_proof_points: recrear FK apuntando a (tenant_id, vertical_id)
    //    (su PK id se mantiene; solo recreamos la FK)
    // ───────────────────────────────────────────────────────────
    console.log('6️⃣  bot_proof_points: recreando FK → (tenant_id, vertical_id)...');
    await client.query(`
      ALTER TABLE bot_proof_points
      ADD CONSTRAINT bot_proof_points_vertical_fk
      FOREIGN KEY (tenant_id, vertical_id)
      REFERENCES bot_verticals(tenant_id, vertical_id)
      ON DELETE CASCADE
    `);
    console.log('   ✅ FK recreada');

    // ───────────────────────────────────────────────────────────
    // 7. Índices por tenant (idempotentes)
    // ───────────────────────────────────────────────────────────
    console.log('7️⃣  Índices por tenant...');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bot_verticals_tenant ON bot_verticals(tenant_id, active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bot_pricing_tenant ON bot_pricing_plans(tenant_id, active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bot_proof_tenant ON bot_proof_points(tenant_id, vertical_id)`);
    console.log('   ✅ índices OK');

    // ───────────────────────────────────────────────────────────
    // 8. Verificación: tenant 1 conserva sus filas
    // ───────────────────────────────────────────────────────────
    console.log('\n8️⃣  Verificación (tenant 1 = SG Bolivia)...');
    const expect = {
      bot_verticals: 7, bot_pricing_plans: 7, bot_global_config: 16,
      bot_prompt_base: 1, bot_proof_points: 8,
    };
    let allOk = true;
    for (const [t, exp] of Object.entries(expect)) {
      const r = await client.query(`SELECT COUNT(*)::int AS n FROM ${t} WHERE tenant_id = 1`);
      const n = r.rows[0].n;
      const ok = n === exp;
      console.log(`   ${ok ? '✅' : '❌'} ${t}: ${n} filas (esperado ${exp})`);
      if (!ok) allOk = false;
    }
    if (!allOk) {
      throw new Error('VERIFICACIÓN FALLÓ: los conteos de tenant 1 no coinciden con el backup. Abortando.');
    }

    await client.query('COMMIT');
    console.log('\n✅ COMMIT — PKs migradas con éxito');
    console.log('   SG Bolivia (tenant 1) conserva toda su config.');
    console.log('   Múltiples tenants ahora pueden compartir vertical_id/plan_id/config_key.');
    client.release();
    process.exit(0);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ ROLLBACK — La migration falló y se revirtió todo:');
    console.error('  ', err.message);
    console.error('\nLas tablas quedaron EXACTAMENTE como estaban. No se perdió nada.');
    client.release();
    process.exit(1);
  }
})();
