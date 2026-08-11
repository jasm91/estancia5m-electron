/**
 * Migración v0.9.91 — Plano Soporte (paso 0 del CRM de soporte)
 *
 * Crea el esqueleto de datos de la mesa de soporte SOBRE el spine actual.
 * NO toca handover_requests ni conversation_notes (ya sirven para el handoff).
 *
 * (1) conversations.plane          → 'venta' (default) | 'soporte'. Ortogonal a
 *     mode(bot/human): un tenant puede tener líneas/convos de ambos planos.
 * (2) conversations.window_expires_at → último inbound + 24h (la ventana de
 *     servicio de WhatsApp). El webhook lo recalcula en cada mensaje entrante.
 * (3) tenants.support_enabled       → FALSE por default ⇒ VENTA sigue siendo el
 *     comportamiento de hoy, cero sorpresa. El onboarding lo prende.
 * (4) support_tickets               → el caso (sibling de leads).
 * (5) agent_presence                → online/away + concurrencia por agente.
 * (6) support_categories            → taxonomía + política de autonomía por tenant.
 * (7) reengage_queue                → cola de plantillas Utility (re-enganche 24h).
 *
 * Tipos: conversations.id / tenants.id / tenant_users.id son SERIAL (int4),
 * así que TODAS las FK acá son INTEGER (un BIGINT contra un int4 rompería la FK).
 *
 * Idempotente (IF NOT EXISTS / ON CONFLICT DO NOTHING). Seguro de correr 2 veces.
 *
 * Uso (Railway → servicio sg-ventas → Console, DATABASE_URL ya está en el env):
 *   node migrate-support-v0991.js
 */
const db = require('./db');

const SEED_TENANT = 5; // tenant de test. Solo se siembra si existe.

const DEFAULT_CATEGORIES = [
  // key,            label,               autonomy,   sla1,  sla2,  orden
  ['horario',        'Horarios',          'auto',       30,   240,   1],
  ['ubicacion',      'Ubicación',         'auto',       30,   240,   2],
  ['estado_pedido',  'Estado de pedido',  'auto',       20,   180,   3],
  ['facturacion',    'Facturación',       'suggest',    30,   240,   4],
  ['reembolso',      'Reembolso',         'escalate',   15,   120,   5],
  ['reclamo',        'Reclamo',           'escalate',   10,    90,   6],
  ['otro',           'Otro',              'escalate',   30,   240,  99],
];

async function migrate() {
  console.log('🔧 v0.9.91 — plano Soporte (esqueleto de la mesa)…');

  // ── (1)(2) conversations: plano + ventana 24h ──────────────────────────────
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS plane TEXT NOT NULL DEFAULT 'venta';`);
  console.log('✅ conversations.plane (default venta)');

  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS window_expires_at TIMESTAMPTZ;`);
  console.log('✅ conversations.window_expires_at');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_tenant_plane
    ON conversations (tenant_id, plane);
  `);
  console.log('✅ índice (tenant_id, plane)');

  // ── (3) tenants: bandera de plano soporte ──────────────────────────────────
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('✅ tenants.support_enabled (default FALSE ⇒ venta sigue igual)');

  // ── (4) support_tickets ────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id                SERIAL PRIMARY KEY,
      tenant_id         INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      status            TEXT NOT NULL DEFAULT 'open',     -- open|in_progress|pending|escalated|resolved|closed
      handled_by        TEXT NOT NULL DEFAULT 'bot',      -- bot|agent
      category          TEXT,                             -- support_categories.key (lógico)
      priority          TEXT NOT NULL DEFAULT 'normal',   -- low|normal|high|urgent
      assigned_agent_id INTEGER REFERENCES tenant_users(id) ON DELETE SET NULL,
      ai_summary        TEXT,                             -- resumen del problema (1-2 líneas)
      ai_reasoning      TEXT,                             -- "qué intentó la IA" (traza de handoff)
      ai_confidence     TEXT,                             -- resolvable_auto|needs_agent|needs_transaction
      sentiment         TEXT,                             -- neutral|frustrated|angry|happy
      first_response_at TIMESTAMPTZ,                      -- para FRT
      resolved_at       TIMESTAMPTZ,
      reopened_count    INTEGER NOT NULL DEFAULT 0,
      csat              SMALLINT,                         -- 1-5 (encuesta post-cierre)
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status ON support_tickets (tenant_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_agent_status ON support_tickets (tenant_id, assigned_agent_id, status);`);
  // Invariante: máximo UN ticket activo (no resuelto/cerrado) por conversación.
  // El webhook hace "crear si no hay abierto" — este índice lo blinda contra carreras.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_open_per_conversation
    ON support_tickets (conversation_id)
    WHERE status NOT IN ('resolved', 'closed');
  `);
  console.log('✅ support_tickets (+índices +unique de 1 ticket activo/conversación)');

  // ── (5) agent_presence ─────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_presence (
      tenant_user_id  INTEGER PRIMARY KEY REFERENCES tenant_users(id) ON DELETE CASCADE,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      status          TEXT NOT NULL DEFAULT 'offline',   -- online|away|offline
      max_concurrent  SMALLINT NOT NULL DEFAULT 4,
      active_chats    SMALLINT NOT NULL DEFAULT 0,        -- cache de tickets in_progress del agente
      skills          JSONB NOT NULL DEFAULT '[]'::jsonb, -- ["facturacion","tecnico"] (skills-based, fase posterior)
      last_seen_at    TIMESTAMPTZ
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_presence_tenant_status ON agent_presence (tenant_id, status);`);
  console.log('✅ agent_presence (+índice)');

  // ── (6) support_categories ─────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS support_categories (
      id                     SERIAL PRIMARY KEY,
      tenant_id              INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      key                    TEXT NOT NULL,
      label                  TEXT NOT NULL,
      autonomy               TEXT NOT NULL DEFAULT 'escalate',  -- auto|suggest|escalate
      sla_first_response_min INTEGER NOT NULL DEFAULT 30,
      sla_resolution_min     INTEGER NOT NULL DEFAULT 240,
      sort_order             INTEGER NOT NULL DEFAULT 0,
      UNIQUE (tenant_id, key)
    );
  `);
  console.log('✅ support_categories');

  // ── (7) reengage_queue ─────────────────────────────────────────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS reengage_queue (
      id          SERIAL PRIMARY KEY,
      ticket_id   INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      template    TEXT NOT NULL,                          -- nombre de plantilla aprobada en Meta
      status      TEXT NOT NULL DEFAULT 'pending',        -- pending|sent|failed
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_reengage_status ON reengage_queue (status);`);
  console.log('✅ reengage_queue (+índice)');

  // ── SEED (solo tenant de test, y solo si existe) ───────────────────────────
  const t = await db.query('SELECT id FROM tenants WHERE id = $1', [SEED_TENANT]);
  if (t.rows.length === 0) {
    console.log(`ℹ️  tenant ${SEED_TENANT} no existe — se saltea el seed (esquema igual quedó creado).`);
  } else {
    // Prende soporte en el tenant de test para poder probar la rebanada fina.
    await db.query('UPDATE tenants SET support_enabled = TRUE WHERE id = $1', [SEED_TENANT]);

    let inserted = 0;
    for (const [key, label, autonomy, sla1, sla2, ord] of DEFAULT_CATEGORIES) {
      const r = await db.query(
        `INSERT INTO support_categories
           (tenant_id, key, label, autonomy, sla_first_response_min, sla_resolution_min, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [SEED_TENANT, key, label, autonomy, sla1, sla2, ord]
      );
      inserted += r.rowCount;
    }
    console.log(`✅ seed tenant ${SEED_TENANT}: support_enabled=TRUE, ${inserted} categorías nuevas (${DEFAULT_CATEGORIES.length} en total).`);
  }

  console.log('🎉 Migración v0.9.91 completa. Venta intacta; soporte listo para el paso 1.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
