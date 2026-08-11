/**
 * Migración v0.9.13 — Multi-línea por organización
 *
 * Hoy: 1 tenant = 1 número (tenants.meta_phone_number_id UNIQUE).
 * Ahora: 1 tenant = N líneas (tabla tenant_lines). La columna vieja queda
 * como referencia legacy/default — NO se borra (retrocompat total).
 *
 * 1. Tabla tenant_lines: cada línea con su phone_number_id (llave de ruteo),
 *    label, waba y token propio OPCIONAL (si NULL hereda el del tenant; si el
 *    tenant tampoco tiene, caen las credenciales globales — mismo esquema
 *    de fallback que getTenantMetaCtx/_resolveCreds).
 * 2. Backfill: el número actual de cada tenant → su línea "Principal" (default).
 * 3. conversations.line_id: por cuál línea entró la conversación (se responde
 *    SIEMPRE por esa misma línea). Backfill a la línea default del tenant.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-tenant-lines-v0913.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.13 — multi-línea por organización...');

  // 1. Tabla de líneas
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_lines (
      id                   SERIAL PRIMARY KEY,
      tenant_id            INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      meta_phone_number_id TEXT NOT NULL UNIQUE,   -- llave de ruteo entrante
      display_phone        TEXT,                   -- "+591 77001196" (visual)
      label                TEXT,                   -- "Ventas", "Soporte", "Marca X"
      waba_id              TEXT,                   -- si difiere del waba del tenant
      meta_token_enc       TEXT,                   -- NULL = hereda token del tenant/global
      active               BOOLEAN NOT NULL DEFAULT TRUE,
      is_default           BOOLEAN NOT NULL DEFAULT FALSE,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_lines_tenant ON tenant_lines (tenant_id);`);
  // Una sola línea default por tenant
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_lines_default
    ON tenant_lines (tenant_id) WHERE is_default;
  `);
  console.log('✅ tabla tenant_lines + índices');

  // 2. Backfill: número actual de cada tenant → línea "Principal" (default)
  const backfill = await db.query(`
    INSERT INTO tenant_lines (tenant_id, meta_phone_number_id, waba_id, meta_token_enc, label, is_default)
    SELECT id, meta_phone_number_id, waba_id, meta_token_enc, 'Principal', TRUE
    FROM tenants
    WHERE meta_phone_number_id IS NOT NULL
    ON CONFLICT (meta_phone_number_id) DO NOTHING
    RETURNING tenant_id, id;
  `);
  for (const r of backfill.rows) {
    console.log(`  → línea Principal creada: tenant ${r.tenant_id} (line_id ${r.id})`);
  }
  console.log(`✅ backfill de líneas (${backfill.rows.length} creadas)`);

  // 3. conversations.line_id
  await db.query(`
    ALTER TABLE conversations ADD COLUMN IF NOT EXISTS
      line_id INTEGER REFERENCES tenant_lines(id) ON DELETE SET NULL;
  `);
  const convFill = await db.query(`
    UPDATE conversations c
    SET line_id = tl.id
    FROM tenant_lines tl
    WHERE tl.tenant_id = c.tenant_id AND tl.is_default AND c.line_id IS NULL;
  `);
  console.log(`✅ conversations.line_id (backfill: ${convFill.rowCount} conversaciones)`);

  console.log('🎉 Migración v0.9.13 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
