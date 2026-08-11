/**
 * migrate-tasks-v095.js — Sg Sales v0.9.5
 *
 * Sistema de tareas/recordatorios para vendedores.
 *
 * Comportamiento:
 *   - Tarea puede estar asociada a conversación O lead O suelta
 *   - Vencimiento dispara push notification (vía worker setInterval)
 *   - Auto-creación cuando lead alcanza score >= 85 (tarea "Llamar en 30 min")
 *   - Estado: pending → done/cancelled/snoozed
 *
 * IDEMPOTENTE: usa IF NOT EXISTS, se puede correr múltiples veces.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando tabla tasks...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id              SERIAL PRIMARY KEY,
        tenant_id       INTEGER NOT NULL DEFAULT 1 REFERENCES tenants(id) ON DELETE CASCADE,
        conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL,
        lead_id         INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        title           TEXT NOT NULL,
        description     TEXT,
        due_at          TIMESTAMPTZ NOT NULL,
        task_type       VARCHAR(32) DEFAULT 'other',
            -- 'call' | 'follow_up' | 'send_proposal' | 'other'
        status          VARCHAR(16) DEFAULT 'pending',
            -- 'pending' | 'done' | 'cancelled' | 'snoozed'
        priority        VARCHAR(8) DEFAULT 'normal',
            -- 'high' | 'normal' | 'low'
        notified_push   BOOLEAN DEFAULT false,
        auto_created    BOOLEAN DEFAULT false,
            -- true cuando la creó el sistema (lead score >=85)
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        completed_at    TIMESTAMPTZ,
        updated_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    console.log('▶ Creando índices...');
    // Índice principal para el worker (busca pending vencidas no notificadas)
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_pending_due
      ON tasks(due_at, notified_push)
      WHERE status = 'pending'
    `);

    // Índice para listar por conversación/lead (vista en modal)
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_conversation
      ON tasks(conversation_id, status)
      WHERE conversation_id IS NOT NULL
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_lead
      ON tasks(lead_id, status)
      WHERE lead_id IS NOT NULL
    `);

    // Índice para lista global con filtros por estado y fecha
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_status_due
      ON tasks(tenant_id, status, due_at)
    `);

    console.log('✅ Migration tasks v0.9.5 completada');
    console.log('   - Tabla tasks creada');
    console.log('   - 4 índices creados');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-tasks-v095:', err);
    process.exit(1);
  }
})();
