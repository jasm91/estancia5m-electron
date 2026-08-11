/**
 * migrate-bot-config-multitenant-v097.js — v0.9.7 (Sprint 1)
 *
 * Agrega scope por tenant a las tablas de configuración del bot.
 * Cambia las PKs "naturales" (globales) por PKs compuestas con tenant_id.
 *
 * Tablas afectadas:
 *   bot_verticals:      PK vertical_id        → PK (tenant_id, vertical_id)
 *   bot_pricing_plans:  PK plan_id            → PK (tenant_id, plan_id)
 *   bot_global_config:  PK config_key         → PK (tenant_id, config_key)
 *   bot_prompt_base:    PK id=1 (singleton)   → PK (tenant_id)  [rompe singleton]
 *   bot_proof_points:   FK vertical_id        → FK (tenant_id, vertical_id)
 *
 * SEGURIDAD:
 *   - TODO corre en una transacción (BEGIN/COMMIT). Si algo falla → ROLLBACK,
 *     las tablas quedan EXACTAMENTE como estaban.
 *   - Las filas existentes obtienen tenant_id = 1 (SG Bolivia) automáticamente.
 *   - IDEMPOTENTE: si ya tiene tenant_id, no hace nada.
 *   - Verificación final: confirma que SG Bolivia (tenant 1) conserva sus datos.
 *
 * CORRÉ EL BACKUP PRIMERO: node backup-bot-config-tables.js
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node migrate-bot-config-multitenant-v097.js
 */

const db = require('./db');

async function columnExists(client, table, column) {
  const r = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = $1 AND column_name = $2
  `, [table, column]);
  return r.rows.length > 0;
}

(async () => {
  const client = await db.pool.connect();
  try {
    console.log('🚀 Migration multi-tenant de config del bot (v0.9.7)\n');

    // Chequeo de idempotencia: si bot_verticals ya tiene tenant_id, asumimos hecho
    const alreadyDone = await columnExists(client, 'bot_verticals', 'tenant_id');
    if (alreadyDone) {
      console.log('⏭  bot_verticals ya tiene tenant_id. Migration ya aplicada, saliendo.');
      client.release();
      process.exit(0);
    }

    await client.query('BEGIN');
    console.log('▶ Transacción iniciada (BEGIN)\n');

    // ───────────────────────────────────────────────────────────
    // 1. bot_proof_points: primero soltamos la FK vieja (depende de bot_verticals)
    // ───────────────────────────────────────────────────────────
    console.log('1️⃣  bot_proof_points: soltando FK vieja a bot_verticals...');
    // El nombre de la constraint puede variar; la buscamos dinámicamente
    const fkRes = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'bot_proof_points'::regclass AND contype = 'f'
    `);
    for (const row of fkRes.rows) {
      await client.query(`ALTER TABLE bot_proof_points DROP CONSTRAINT ${row.conname}`);
      console.log(`   - FK ${row.conname} soltada`);
    }

    // ───────────────────────────────────────────────────────────
    // 2. bot_verticals: agregar tenant_id, cambiar PK
    // ───────────────────────────────────────────────────────────
    console.log('2️⃣  bot_verticals: agregando tenant_id + PK compuesta...');
    await client.query(`ALTER TABLE bot_verticals ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE`);
    await client.query(`ALTER TABLE bot_verticals DROP CONSTRAINT bot_verticals_pkey`);
    await client.query(`ALTER TABLE bot_verticals ADD PRIMARY KEY (tenant_id, vertical_id)`);
    console.log('   ✅ PK ahora (tenant_id, vertical_id)');

    // ───────────────────────────────────────────────────────────
    // 3. bot_pricing_plans: agregar tenant_id, cambiar PK
    // ───────────────────────────────────────────────────────────
    console.log('3️⃣  bot_pricing_plans: agregando tenant_id + PK compuesta...');
    await client.query(`ALTER TABLE bot_pricing_plans ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE`);
    await client.query(`ALTER TABLE bot_pricing_plans DROP CONSTRAINT bot_pricing_plans_pkey`);
    await client.query(`ALTER TABLE bot_pricing_plans ADD PRIMARY KEY (tenant_id, plan_id)`);
    console.log('   ✅ PK ahora (tenant_id, plan_id)');

    // ───────────────────────────────────────────────────────────
    // 4. bot_global_config: agregar tenant_id, cambiar PK
    // ───────────────────────────────────────────────────────────
    console.log('4️⃣  bot_global_config: agregando tenant_id + PK compuesta...');
    await client.query(`ALTER TABLE bot_global_config ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE`);
    await client.query(`ALTER TABLE bot_global_config DROP CONSTRAINT bot_global_config_pkey`);
    await client.query(`ALTER TABLE bot_global_config ADD PRIMARY KEY (tenant_id, config_key)`);
    console.log('   ✅ PK ahora (tenant_id, config_key)');

    // ───────────────────────────────────────────────────────────
    // 5. bot_prompt_base: romper singleton, PK por tenant
    // ───────────────────────────────────────────────────────────
    console.log('5️⃣  bot_prompt_base: rompiendo singleton, PK por tenant...');
    await client.query(`ALTER TABLE bot_prompt_base ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE`);
    // Soltar el CHECK singleton (id=1) y la PK vieja
    const checkRes = await client.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'bot_prompt_base'::regclass AND contype = 'c'
    `);
    for (const row of checkRes.rows) {
      await client.query(`ALTER TABLE bot_prompt_base DROP CONSTRAINT ${row.conname}`);
      console.log(`   - CHECK ${row.conname} soltado`);
    }
    await client.query(`ALTER TABLE bot_prompt_base DROP CONSTRAINT bot_prompt_base_pkey`);
    await client.query(`ALTER TABLE bot_prompt_base ADD PRIMARY KEY (tenant_id)`);
    // La columna id queda como informativa (ya no es PK ni singleton)
    console.log('   ✅ PK ahora (tenant_id), singleton roto');

    // ───────────────────────────────────────────────────────────
    // 6. bot_proof_points: agregar tenant_id + recrear FK compuesta
    // ───────────────────────────────────────────────────────────
    console.log('6️⃣  bot_proof_points: agregando tenant_id + FK compuesta...');
    await client.query(`ALTER TABLE bot_proof_points ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE`);
    await client.query(`
      ALTER TABLE bot_proof_points
      ADD CONSTRAINT bot_proof_points_vertical_fk
      FOREIGN KEY (tenant_id, vertical_id)
      REFERENCES bot_verticals(tenant_id, vertical_id)
      ON DELETE CASCADE
    `);
    console.log('   ✅ FK ahora (tenant_id, vertical_id)');

    // ───────────────────────────────────────────────────────────
    // 7. Índices por tenant para queries del builder
    // ───────────────────────────────────────────────────────────
    console.log('7️⃣  Creando índices por tenant...');
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bot_verticals_tenant ON bot_verticals(tenant_id, active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bot_pricing_tenant ON bot_pricing_plans(tenant_id, active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bot_proof_tenant ON bot_proof_points(tenant_id, vertical_id)`);
    console.log('   ✅ índices creados');

    // ───────────────────────────────────────────────────────────
    // 8. VERIFICACIÓN: SG Bolivia (tenant 1) conserva sus datos
    // ───────────────────────────────────────────────────────────
    console.log('\n8️⃣  Verificación de integridad (tenant 1 = SG Bolivia)...');
    const checks = [
      ['bot_verticals', 'SELECT COUNT(*)::int AS n FROM bot_verticals WHERE tenant_id = 1'],
      ['bot_pricing_plans', 'SELECT COUNT(*)::int AS n FROM bot_pricing_plans WHERE tenant_id = 1'],
      ['bot_global_config', 'SELECT COUNT(*)::int AS n FROM bot_global_config WHERE tenant_id = 1'],
      ['bot_prompt_base', 'SELECT COUNT(*)::int AS n FROM bot_prompt_base WHERE tenant_id = 1'],
      ['bot_proof_points', 'SELECT COUNT(*)::int AS n FROM bot_proof_points WHERE tenant_id = 1'],
    ];
    let promptBaseOk = false;
    for (const [name, q] of checks) {
      const r = await client.query(q);
      const n = r.rows[0].n;
      console.log(`   ${name}: ${n} filas en tenant 1`);
      if (name === 'bot_prompt_base' && n >= 1) promptBaseOk = true;
    }

    if (!promptBaseOk) {
      throw new Error('VERIFICACIÓN FALLÓ: bot_prompt_base no tiene fila para tenant 1. Abortando.');
    }

    await client.query('COMMIT');
    console.log('\n✅ COMMIT — Migration completada con éxito');
    console.log('   SG Bolivia (tenant 1) conserva toda su config.');
    console.log('   Las tablas ahora soportan múltiples tenants.');
    client.release();
    process.exit(0);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ ROLLBACK — La migration falló y se revirtió todo:');
    console.error('  ', err.message);
    console.error('\nLas tablas quedaron EXACTAMENTE como estaban antes. No se perdió nada.');
    client.release();
    process.exit(1);
  }
})();
