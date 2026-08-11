/**
 * Migración v0.9.43 — Tareas dinámicas (asignación + kanban + gantt)
 *
 * tasks:
 *   - assigned_to INTEGER → tenant_users.id (a quién está asignada; aparece en
 *     su bandeja y en el badge 📥 del panel)
 *   - created_by  INTEGER → tenant_users.id (quién la creó)
 *   - start_at    TIMESTAMPTZ (inicio planificado — barra del Gantt va start_at→due_at)
 *   - due_at pasa a ser OPCIONAL (tareas de tablero sin fecha)
 *   - status admite 'in_progress' (columna del kanban; el campo ya era VARCHAR libre)
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-tasks-dynamic-v0943.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.43 — tareas dinámicas...');

  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assigned_to INTEGER;`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by  INTEGER;`);
  await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_at    TIMESTAMPTZ;`);
  console.log('✅ tasks.assigned_to / created_by / start_at');

  await db.query(`ALTER TABLE tasks ALTER COLUMN due_at DROP NOT NULL;`).catch(() => {});
  console.log('✅ tasks.due_at ahora es opcional');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_tasks_tenant_assignee
    ON tasks (tenant_id, assigned_to, status);
  `);
  console.log('✅ índice (tenant_id, assigned_to, status)');

  console.log('🎉 Migración v0.9.43 completa.');
  process.exit(0);
}

migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
