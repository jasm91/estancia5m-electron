/**
 * tasks-worker.js — Sg Sales v0.9.5
 *
 * Worker que corre dentro del proceso del servidor.
 * Cada N segundos revisa tareas pending vencidas no notificadas,
 * dispara push notification y marca notified_push=true.
 *
 * Se inicia desde server.js con startTasksWorker().
 */

const db = require('./db');
const pushNotifier = require('./push-notifier');

const CHECK_INTERVAL_MS = 60 * 1000; // 1 min
let _intervalRef = null;
let _isRunning = false; // evita solapamientos si una corrida tarda

async function checkDueTasks() {
  if (_isRunning) return;
  _isRunning = true;
  try {
    // Bloqueo optimista: SELECT FOR UPDATE marcaría las filas; usamos
    // UPDATE...RETURNING para que sea atómico (cada tarea se notifica 1 sola vez)
    const result = await db.query(`
      UPDATE tasks
         SET notified_push = true, updated_at = NOW()
       WHERE status = 'pending'
         AND notified_push = false
         AND due_at <= NOW()
       RETURNING id, title, description, conversation_id, lead_id, task_type, priority, tenant_id
    `);

    if (result.rows.length === 0) {
      _isRunning = false;
      return;
    }

    console.log(`📅 Tasks worker: ${result.rows.length} tarea(s) vencida(s), enviando push...`);

    // Para cada tarea: obtener nombre del contacto si aplica y mandar push
    for (const task of result.rows) {
      let contactInfo = '';
      if (task.conversation_id) {
        const conv = await db.query(
          `SELECT contact_name, phone FROM conversations WHERE id = $1`,
          [task.conversation_id]
        );
        if (conv.rows[0]) {
          contactInfo = ` · ${conv.rows[0].contact_name || conv.rows[0].phone}`;
        }
      }

      const typeEmoji = {
        'call': '📞',
        'follow_up': '🔄',
        'send_proposal': '📄',
        'other': '📅',
      }[task.task_type] || '📅';

      const priorityPrefix = task.priority === 'high' ? '🔥 ' : '';

      try {
        // v0.9.67 (auditoría 12-jun P1#8): push SOLO a los dispositivos del
        // tenant de la tarea — antes era broadcast global y el nombre/teléfono
        // del contacto de una org llegaba a los dispositivos de TODAS.
        await pushNotifier.broadcast({
          title: `${priorityPrefix}${typeEmoji} ${task.title}`,
          body: (task.description || 'Tarea vencida') + contactInfo,
          url: '/?tab=tasks',
          icon: '/icons/icon-192.svg',
        }, task.tenant_id || null);
      } catch (e) {
        console.error(`  ❌ Error enviando push para tarea ${task.id}:`, e.message);
      }
    }
  } catch (err) {
    console.error('❌ Tasks worker error:', err);
  } finally {
    _isRunning = false;
  }
}

function startTasksWorker() {
  if (_intervalRef) {
    console.log('⚠️  Tasks worker ya estaba corriendo');
    return;
  }
  console.log(`▶ Tasks worker iniciado (chequea cada ${CHECK_INTERVAL_MS / 1000}s)`);
  // Primera corrida 5s después de arrancar (deja al server estabilizarse)
  setTimeout(checkDueTasks, 5000);
  _intervalRef = setInterval(checkDueTasks, CHECK_INTERVAL_MS);
}

function stopTasksWorker() {
  if (_intervalRef) {
    clearInterval(_intervalRef);
    _intervalRef = null;
    console.log('▶ Tasks worker detenido');
  }
}

module.exports = { startTasksWorker, stopTasksWorker, checkDueTasks };
