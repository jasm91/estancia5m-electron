/**
 * migrate-add-tenant-id-to-existing.js — v0.8.0 Sprint 1
 *
 * Agrega columna `tenant_id INTEGER NOT NULL DEFAULT 1` a TODAS las tablas existentes.
 *
 * Estrategia clave para no romper nada:
 *   1. La columna agregada tiene DEFAULT 1 temporal
 *   2. Todas las filas existentes pasan a tenant_id=1 automáticamente
 *   3. El tenant_id=1 será creado por migrate-seed-default-tenant.js (SG Bolivia)
 *   4. NO se quita el DEFAULT en esta migración. Eso lo hace migrate-drop-default-tenant-id.js
 *      DESPUÉS de Sprint 1 completo, cuando todas las INSERTs hayan sido refactoradas para
 *      especificar tenant_id explícitamente.
 *
 * También agrega los índices que necesitamos para queries eficientes filtrando por tenant_id.
 *
 * IDEMPOTENTE: usa ADD COLUMN IF NOT EXISTS y CREATE INDEX IF NOT EXISTS.
 */

const db = require('./db');

// Lista canónica de tablas y sus índices nuevos
// (tabla, [indices a crear])
const TABLES = [
  {
    name: 'conversations',
    indices: [
      { name: 'idx_conv_tenant_lastmsg', sql: 'CREATE INDEX IF NOT EXISTS idx_conv_tenant_lastmsg ON conversations(tenant_id, last_message_at DESC)' },
      // v0.9.470: la unicidad ahora es POR LÍNEA — (tenant_id, phone, COALESCE(line_id,0)).
      // El índice viejo UNIQUE(tenant_id, phone) rompe porque un mismo contacto puede
      // tener conversaciones legítimas en 2 líneas distintas del mismo tenant.
      { name: 'conversations_tenant_phone_line_key', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS conversations_tenant_phone_line_key ON conversations (tenant_id, phone, COALESCE(line_id, 0))' },
    ],
    drop_old: [
      // Si existe el índice viejo UNIQUE(phone), lo borramos porque ahora la unicidad es por (tenant_id, phone, line)
      'DROP INDEX IF EXISTS conversations_phone_key',
      // v0.9.470: borrar los índices UNIQUE por (tenant_id, phone) que ya no aplican con multi-línea
      'DROP INDEX IF EXISTS conversations_tenant_phone_key',
      'DROP INDEX IF EXISTS idx_conv_tenant_phone',
    ],
  },
  {
    name: 'messages',
    indices: [
      { name: 'idx_msg_tenant_conv_created', sql: 'CREATE INDEX IF NOT EXISTS idx_msg_tenant_conv_created ON messages(tenant_id, conversation_id, created_at)' },
    ],
  },
  {
    name: 'leads',
    indices: [
      { name: 'idx_leads_tenant_conv', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_tenant_conv ON leads(tenant_id, conversation_id)' },
      { name: 'idx_leads_tenant_status', sql: 'CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status)' },
    ],
    drop_old: [
      'DROP INDEX IF EXISTS leads_conversation_id_key',
    ],
  },
  {
    name: 'media_assets',
    indices: [
      { name: 'idx_ma_tenant', sql: 'CREATE INDEX IF NOT EXISTS idx_ma_tenant ON media_assets(tenant_id)' },
    ],
  },
  {
    name: 'bot_global_config',
    indices: [
      { name: 'idx_bgc_tenant_key', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_bgc_tenant_key ON bot_global_config(tenant_id, config_key)' },
    ],
    drop_old: [
      'DROP INDEX IF EXISTS bot_global_config_config_key_key',
    ],
  },
  {
    name: 'bot_verticals',
    indices: [
      { name: 'idx_bv_tenant_vid', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_bv_tenant_vid ON bot_verticals(tenant_id, vertical_id)' },
    ],
  },
  {
    name: 'bot_pricing_plans',
    indices: [
      { name: 'idx_bpp_tenant', sql: 'CREATE INDEX IF NOT EXISTS idx_bpp_tenant ON bot_pricing_plans(tenant_id)' },
    ],
  },
  {
    name: 'bot_prompt_history',
    indices: [
      { name: 'idx_bph_tenant', sql: 'CREATE INDEX IF NOT EXISTS idx_bph_tenant ON bot_prompt_history(tenant_id)' },
    ],
  },
  {
    name: 'bot_proof_points',
    indices: [
      { name: 'idx_bpr_tenant', sql: 'CREATE INDEX IF NOT EXISTS idx_bpr_tenant ON bot_proof_points(tenant_id)' },
    ],
  },
  {
    name: 'bot_entry_templates',
    indices: [
      { name: 'idx_bet_tenant_name', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_bet_tenant_name ON bot_entry_templates(tenant_id, name)' },
    ],
    drop_old: [
      'DROP INDEX IF EXISTS bot_entry_templates_name_key',
    ],
  },
  {
    name: 'bot_prompt_base',
    indices: [
      // La PK actual es id=1. Después del cambio, queremos UNIQUE(tenant_id, id) y id sigue siendo 1 por tenant.
      { name: 'idx_bpb_tenant', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_bpb_tenant ON bot_prompt_base(tenant_id, id)' },
    ],
  },
  {
    name: 'handover_requests',
    indices: [
      { name: 'idx_hr_tenant_conv', sql: 'CREATE INDEX IF NOT EXISTS idx_hr_tenant_conv ON handover_requests(tenant_id, conversation_id)' },
    ],
  },
  {
    name: 'conversation_notes',
    indices: [
      { name: 'idx_cn_tenant_conv', sql: 'CREATE INDEX IF NOT EXISTS idx_cn_tenant_conv ON conversation_notes(tenant_id, conversation_id)' },
    ],
  },
  {
    name: 'push_subscriptions',
    indices: [
      { name: 'idx_ps_tenant_endpoint', sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_ps_tenant_endpoint ON push_subscriptions(tenant_id, endpoint)' },
    ],
    drop_old: [
      'DROP INDEX IF EXISTS push_subscriptions_endpoint_key',
    ],
  },
];

async function addTenantIdColumn(tableName) {
  const result = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND column_name = 'tenant_id'`,
    [tableName]
  );

  if (result.rows.length > 0) {
    console.log(`   ⏭  ${tableName}: ya tiene tenant_id, salteando`);
    return;
  }

  console.log(`   ➕ ${tableName}: agregando tenant_id INTEGER NOT NULL DEFAULT 1`);
  await db.query(`ALTER TABLE ${tableName} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);

  // NOTA: NO agregamos FK a tenants(id) todavía porque tenants se crea en otra migración.
  // La FK se agrega al final de esta migración cuando ya existen ambas tablas.
}

async function addForeignKey(tableName) {
  const fkName = `fk_${tableName}_tenant_id`;
  // Verificar si la FK ya existe
  const exists = await db.query(
    `SELECT constraint_name FROM information_schema.table_constraints
     WHERE table_name = $1 AND constraint_name = $2 AND constraint_type = 'FOREIGN KEY'`,
    [tableName, fkName]
  );
  if (exists.rows.length > 0) {
    console.log(`   ⏭  ${tableName}: FK ya existe, salteando`);
    return;
  }
  console.log(`   🔗 ${tableName}: agregando FK → tenants(id)`);
  // ON DELETE RESTRICT — no permitimos borrar un tenant que tenga datos
  await db.query(`
    ALTER TABLE ${tableName}
    ADD CONSTRAINT ${fkName} FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT
  `);
}

(async () => {
  try {
    console.log('▶ Agregando tenant_id a las 13 tablas existentes...');

    // Verificar que tenants exista
    const tenantsExists = await db.query(
      `SELECT to_regclass('public.tenants') IS NOT NULL AS exists`
    );
    if (!tenantsExists.rows[0].exists) {
      throw new Error('La tabla tenants NO existe. Correr migrate-tenants.js primero.');
    }

    // Paso 1: ADD COLUMN tenant_id en cada tabla
    for (const t of TABLES) {
      // Verificar que la tabla exista (pudo haberse renombrado o no haberse creado todavía)
      const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t.name}`]);
      if (!exists.rows[0].exists) {
        console.log(`   ⚠️  ${t.name}: tabla no existe, salteando`);
        continue;
      }
      await addTenantIdColumn(t.name);
    }

    // Paso 2: drop old uniqueness constraints (si tenían UNIQUE(phone) etc.)
    console.log('\n▶ Eliminando constraints UNIQUE obsoletas...');
    for (const t of TABLES) {
      if (!t.drop_old) continue;
      for (const sql of t.drop_old) {
        try {
          await db.query(sql);
          console.log(`   🗑  ${t.name}: ${sql.replace(/DROP INDEX IF EXISTS /, '')}`);
        } catch (e) {
          // No es crítico si el índice ya no existe
          console.log(`   ⚠️  ${t.name}: ${e.message}`);
        }
      }
    }

    // Paso 3: crear nuevos índices compuestos por tenant_id
    // v0.9.470: NON-FATAL. Un índice que falle (p.ej. UNIQUE con duplicados legítimos por
    // multi-línea, o datos preexistentes) NO debe abortar el release y tumbar la app.
    // Se registra el error y se continúa; el boot self-repair de server.js reconcilia.
    console.log('\n▶ Creando índices compuestos por tenant_id...');
    for (const t of TABLES) {
      for (const idx of t.indices) {
        try {
          await db.query(idx.sql);
          console.log(`   ✅ ${idx.name}`);
        } catch (e) {
          console.log(`   ⚠️  ${idx.name}: NO se pudo crear (${e.message}) — se continúa (non-fatal)`);
        }
      }
    }

    // Paso 4: FOREIGN KEY a tenants(id) (después de que tenants existe)
    console.log('\n▶ Agregando FOREIGN KEYs → tenants(id)...');
    for (const t of TABLES) {
      const exists = await db.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${t.name}`]);
      if (!exists.rows[0].exists) continue;
      await addForeignKey(t.name);
    }

    console.log('\n✅ tenant_id agregado a todas las tablas. Filas existentes quedan con tenant_id=1.');
    console.log('   Recordá: el DEFAULT 1 se quita en migrate-drop-default-tenant-id.js al final de Sprint 1.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-add-tenant-id-to-existing:', err);
    process.exit(1);
  }
})();
