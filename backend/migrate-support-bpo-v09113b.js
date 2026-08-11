/**
 * migrate-support-bpo-v09113b.js — v0.9.113 (Fase 0 de la Mesa de Soporte / BPO)
 *
 * Sucesora corregida de migrate-support-v0991.js (que quedó DORMIDA: nunca entró
 * a migrate-all.js y su `support_tickets` colisionaba con la legacy). Corre SIEMPRE
 * DESPUÉS de migrate-support-rename-v09113.js (que libera el nombre support_tickets).
 *
 * Crea el esqueleto de datos de la mesa de soporte SOBRE el spine actual:
 *   (1) conversations.plane            → 'venta' (default) | 'soporte'. Ortogonal a
 *       mode(bot/human) y a stage(venta/postventa). Es el eje del BPO.
 *   (2) conversations.window_expires_at → último inbound + 24h (ventana de WhatsApp).
 *   (3) tenants.support_enabled        → FALSE por default ⇒ VENTA sigue igual. CERO
 *       REGRESIÓN: nadie tiene la mesa hasta que el owner la prenda explícitamente.
 *   (4) support_tickets (BPO)          → el caso (sibling de leads) + columnas de SLA.
 *   (5) ticket_events                  → audit por ACTOR (quién hizo qué). handover_requests
 *       no sirve (sin status, sin FK a usuario): la verdad del ticket vive acá.
 *   (6) agent_presence                 → online/away + concurrencia por agente (colas).
 *   (7) support_categories             → taxonomía + SLA + política de autonomía por tenant.
 *   (8) reengage_queue                 → cola de plantillas Utility (re-enganche 24h / CSAT).
 *
 * Tipos: conversations.id / tenants.id / tenant_users.id son SERIAL (int4) ⇒ TODAS
 * las FK acá son INTEGER (un BIGINT contra int4 rompería la FK).
 *
 * Idempotente (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING).
 * Seguro de correr 2+ veces.
 *
 * Decisión: NO se auto-prende support_enabled en ningún tenant (se prende a mano por
 * tenant cuando arranca el dogfooding). Sí se siembran las categorías por defecto en
 * TODOS los tenants existentes, así la mesa queda lista para usar al prender el flag.
 *
 * Uso: node migrate-support-bpo-v09113b.js
 */
const db = require('./db');

const DEFAULT_CATEGORIES = [
  // key,            label,               autonomy,   sla1(min), sla2(min), orden
  ['horario',        'Horarios',          'auto',       30,   240,   1],
  ['ubicacion',      'Ubicación',         'auto',       30,   240,   2],
  ['estado_pedido',  'Estado de pedido',  'auto',       20,   180,   3],
  ['facturacion',    'Facturación',       'suggest',    30,   240,   4],
  ['reembolso',      'Reembolso',         'escalate',   15,   120,   5],
  ['reclamo',        'Reclamo',           'escalate',   10,    90,   6],
  ['otro',           'Otro',              'escalate',   30,   240,  99],
];

async function migrate() {
  console.log('🔧 v0.9.113 — Mesa de Soporte (BPO): esqueleto de datos…');

  // ── (1)(2) conversations: plano + ventana 24h ──────────────────────────────
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS plane TEXT NOT NULL DEFAULT 'venta';`);
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS window_expires_at TIMESTAMPTZ;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conversations_tenant_plane ON conversations (tenant_id, plane);`);
  console.log('✅ conversations.plane + window_expires_at (+índice)');

  // ── (3) tenants: bandera de plano soporte (feature-flag, default OFF) ───────
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS support_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  console.log('✅ tenants.support_enabled (default FALSE ⇒ venta sigue igual)');

  // ── (4) support_tickets (BPO) ──────────────────────────────────────────────
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

  // Columnas extra del spec (idempotentes — agregan o no hacen nada):
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ;`);                 // cuándo se asignó al agente actual (AHT / auditoría)
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;`);                  // cierre definitivo (!= resolved_at)
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_first_response_due_at TIMESTAMPTZ;`);  // snapshot del SLA de 1a respuesta
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_resolution_due_at TIMESTAMPTZ;`);      // snapshot del SLA de resolucion
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS breach_kind TEXT;`);                       // first_response|resolution

  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_tenant_status ON support_tickets (tenant_id, status);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tickets_agent_status ON support_tickets (tenant_id, assigned_agent_id, status);`);
  // Scanner de SLA barato: solo tickets vivos.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tickets_sla_scan
    ON support_tickets (tenant_id, status, sla_breached)
    WHERE status NOT IN ('resolved', 'closed');
  `);
  // Invariante: máximo UN ticket activo (no resuelto/cerrado) por conversación.
  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_open_per_conversation
    ON support_tickets (conversation_id)
    WHERE status NOT IN ('resolved', 'closed');
  `);
  console.log('✅ support_tickets BPO (+SLA cols +índices +unique de 1 ticket activo/conversación)');

  // ── (5) ticket_events — audit por actor (quién hizo qué) ───────────────────
  await db.query(`
    CREATE TABLE IF NOT EXISTS ticket_events (
      id            SERIAL PRIMARY KEY,
      ticket_id     INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      actor_user_id INTEGER REFERENCES tenant_users(id) ON DELETE SET NULL,
      actor_kind    TEXT NOT NULL DEFAULT 'system',  -- bot|agent|supervisor|system|client
      event_type    TEXT NOT NULL,                   -- created|assigned|reassigned|status_change|note|first_response|resolved|reopened|closed|transferred|sla_breach
      from_value    TEXT,
      to_value      TEXT,
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_events_ticket ON ticket_events (ticket_id, created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ticket_events_tenant_type ON ticket_events (tenant_id, event_type);`);
  console.log('✅ ticket_events (+índices)');

  // ── (6) agent_presence ─────────────────────────────────────────────────────
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

  // ── (7) support_categories ─────────────────────────────────────────────────
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

  // ── (8) reengage_queue ─────────────────────────────────────────────────────
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

  // ── SEED: categorías por defecto en TODOS los tenants (idempotente) ────────
  // No se prende support_enabled en ninguno (eso es decisión del owner). Solo se
  // dejan las categorías sembradas para que la mesa esté lista al prender el flag.
  const tenants = await db.query('SELECT id FROM tenants');
  let totalInserted = 0;
  for (const { id: tenantId } of tenants.rows) {
    for (const [key, label, autonomy, sla1, sla2, ord] of DEFAULT_CATEGORIES) {
      const r = await db.query(
        `INSERT INTO support_categories
           (tenant_id, key, label, autonomy, sla_first_response_min, sla_resolution_min, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
        [tenantId, key, label, autonomy, sla1, sla2, ord]
      );
      totalInserted += r.rowCount;
    }
  }
  console.log(`✅ seed categorías: ${totalInserted} filas nuevas en ${tenants.rows.length} tenant(s).`);

  console.log('🎉 Migración v0.9.113 (BPO) completa. Venta intacta; mesa de soporte lista para Fase 1.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
