/**
 * n8n-watchdog.js — v0.9.571
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTODEFENSA CONTRA "AITANA MUDA".
 *
 * QUÉ PASÓ (10-ago-2026): el Postgres de n8n reinició (~14:10). n8n llevaba un mes
 * corriendo, su pool de conexiones murió y NO reconecta solo: se quedó respondiendo
 * `{"code":503,"message":"Database is not ready!"}` a todo. Railway lo mostraba
 * "Online" y el deploy "successful", porque el contenedor estaba vivo. El CRM
 * despachaba, recibía 503, lo logueaba… y descartaba el mensaje. Los leads de
 * anuncios que entraron en esa ventana nunca recibieron respuesta.
 *
 * CUATRO CAPAS, de la más barata a la más agresiva:
 *
 *   1. REINTENTO INMEDIATO (en webhook.js → dispatchToN8n): 3 intentos con backoff.
 *      Cubre el 90% de los casos: hipos de segundos, cold start, deploy en curso.
 *
 *   2. COLA PERSISTENTE (este módulo): si los 3 intentos fallan, el mensaje NO se
 *      pierde — se guarda en `n8n_pending` y se reintenta cada minuto hasta
 *      N8N_PENDING_MAX_MIN (def 20). Una fila por conversación (el payload lleva
 *      el historial, así que reintentar el ÚLTIMO cubre todos los mensajes que
 *      hayan entrado mientras tanto, y evita responder tres veces).
 *
 *   3. WATCHDOG DE SALUD: sonda `/healthz/readiness` de n8n cada 60 s. Ese endpoint
 *      es justo el que devuelve 503 cuando la base se desconectó, así que detecta el
 *      zombi que Railway no ve. A los 2 fallos seguidos avisa al dueño.
 *
 *   4. AUTO-REDEPLOY (opt-in): a los N fallos seguidos, si están configurados
 *      RAILWAY_API_TOKEN + RAILWAY_N8N_SERVICE_ID, reinicia el servicio n8n solo
 *      vía la API de Railway (serviceInstanceRedeploy). Cooldown y tope diario para
 *      que nunca entre en bucle de reinicios.
 *
 * Si expiran los reintentos, el lead NO se pierde en silencio: se marca la
 * conversación y se avisa por push al dueño del tenant para que lo tome un humano.
 *
 * Todo es OPT-IN por env y best-effort: sin config, el módulo no hace nada.
 *   N8N_HEALTH_URL           base de n8n (ej. https://n8n-production-xxxx.up.railway.app)
 *   N8N_WATCHDOG_ENABLED     '1' para prender la sonda (def apagado)
 *   N8N_PENDING_MAX_MIN      minutos que se reintenta un mensaje (def 20)
 *   N8N_RESTART_AFTER        fallos seguidos para el auto-redeploy (def 3)
 *   RAILWAY_API_TOKEN        token de cuenta de Railway (habilita el auto-redeploy)
 *   RAILWAY_N8N_SERVICE_ID   id del servicio n8n
 *   RAILWAY_ENVIRONMENT_ID   id del environment (opcional según la forma de la API)
 */
const db = require('./db');
const axios = require('axios');

const HEALTH_URL = (process.env.N8N_HEALTH_URL || '').replace(/\/+$/, '');
const ENABLED = process.env.N8N_WATCHDOG_ENABLED === '1' && !!HEALTH_URL;
const MAX_MIN = Math.max(1, parseInt(process.env.N8N_PENDING_MAX_MIN || '20', 10) || 20);
const RESTART_AFTER = Math.max(2, parseInt(process.env.N8N_RESTART_AFTER || '3', 10) || 3);
const RESTART_COOLDOWN_MS = 15 * 60 * 1000;
const RESTART_MAX_PER_DAY = 4;

let _failStreak = 0;
let _lastState = 'unknown';   // ok | down | unknown
let _lastRestartAt = 0;
let _restartsToday = 0;
let _restartsDay = '';
let _probing = false;
let _draining = false;

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS n8n_pending (
      id              BIGSERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      tenant_id       INTEGER,
      payload         JSONB NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {});
  // Una sola fila pendiente por conversación: el payload lleva el historial, así que
  // el ÚLTIMO reintento cubre todos los mensajes que entraron mientras n8n estaba caído.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_n8n_pending_conv
                    ON n8n_pending (conversation_id) WHERE status = 'pending'`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_n8n_pending_status
                    ON n8n_pending (status, created_at)`).catch(() => {});
}

/** Guarda (o pisa) el despacho fallido de una conversación para reintentarlo después. */
async function enqueue(conversation, payload, err) {
  try {
    await ensureSchema();
    await db.query(
      `INSERT INTO n8n_pending (conversation_id, tenant_id, payload, attempts, last_error)
            VALUES ($1,$2,$3::jsonb,1,$4)
       ON CONFLICT (conversation_id) WHERE status = 'pending'
       DO UPDATE SET payload = EXCLUDED.payload, attempts = n8n_pending.attempts + 1,
                     last_error = EXCLUDED.last_error, updated_at = NOW()`,
      [conversation.id, conversation.tenant_id || null, JSON.stringify(payload), String(err || '').slice(0, 300)]
    );
    console.warn(`🧊 [n8n-pending] conv ${conversation.id} encolada para reintento (n8n no responde)`);
  } catch (e) {
    console.error('[n8n-pending] no se pudo encolar:', e.message);
  }
}

/**
 * Reintenta las conversaciones encoladas. La llama el cron y también el watchdog
 * apenas detecta que n8n volvió (para que la respuesta salga sin esperar al minuto).
 */
async function drain(dispatchFn) {
  if (_draining) return { skipped: 'overlap' };
  _draining = true;
  let sent = 0, expired = 0;
  try {
    const r = await db.query(
      `SELECT id, conversation_id, tenant_id, payload, attempts, created_at
         FROM n8n_pending WHERE status = 'pending' ORDER BY id ASC LIMIT 25`).catch(() => ({ rows: [] }));
    for (const row of r.rows) {
      const out = await _processRow(row, dispatchFn);
      if (out === 'sent') sent++;
      else if (out === 'expired') expired++;
    }
  } finally { _draining = false; }
  if (sent || expired) console.log(`🧊 [n8n-pending] drenaje: ${sent} reenviadas · ${expired} expiradas`);
  return { sent, expired };
}

/**
 * v0.9.578 — UNA fila de la cola. Extraído de drain() para que el SIMULACRO pueda
 * ejercitar exactamente este código sobre una fila de prueba, sin tocar las reales.
 * Devuelve 'sent' | 'expired' | 'retry'.
 */
async function _processRow(row, dispatchFn) {
  const ageMin = (Date.now() - new Date(row.created_at).getTime()) / 60000;
  if (ageMin > MAX_MIN) {
    await db.query(`UPDATE n8n_pending SET status='expired', updated_at=NOW() WHERE id=$1`, [row.id]).catch(() => {});
    await _escalateToHuman(row).catch(() => {});
    return 'expired';
  }
  try {
    await dispatchFn(row.payload);
    await db.query(`UPDATE n8n_pending SET status='done', updated_at=NOW() WHERE id=$1`, [row.id]).catch(() => {});
    console.log(`✅ [n8n-pending] conv ${row.conversation_id} reintentada con éxito (${Math.round(ageMin)} min de atraso)`);
    return 'sent';
  } catch (e) {
    await db.query(`UPDATE n8n_pending SET attempts = attempts + 1, last_error = $2, updated_at = NOW() WHERE id = $1`,
      [row.id, String(e.message || '').slice(0, 300)]).catch(() => {});
    return 'retry';
  }
}

/**
 * Se agotaron los reintentos: el lead NO se pierde en silencio. Se avisa por push al
 * dueño del tenant para que un humano lo tome, con el nombre y el teléfono del cliente.
 */
async function _escalateToHuman(row) {
  console.error(`🆘 [n8n-pending] conv ${row.conversation_id} EXPIRÓ tras ${MAX_MIN} min sin n8n → escalada a humano`);
  // v0.9.572 — email al dueño de la plataforma: un lead sin responder es plata perdida,
  // y el push del tenant puede no estar suscrito. force=true: cada lead perdido avisa.
  try {
    const c0 = await db.query(`SELECT contact_name, phone FROM conversations WHERE id = $1`, [row.conversation_id]);
    const i0 = c0.rows[0] || {};
    await require('./mailer').alert(`lead-perdido-${row.conversation_id}`, {
      title: 'Cliente sin responder por caída de la IA',
      detail: `Tenant ${row.tenant_id || '?'} · conversación ${row.conversation_id}\n`
        + `Cliente: ${i0.contact_name || 's/nombre'} (${i0.phone || 's/teléfono'})\n\n`
        + `El mensaje estuvo ${MAX_MIN} min en cola esperando a n8n y expiró sin respuesta.\n`
        + `Ya se notificó por push al dueño del tenant para que lo tome un humano.`,
      severity: 'warn', force: true,
    });
  } catch (e) { console.warn('[n8n-pending] email de escalada falló:', e.message); }
  try {
    const c = await db.query(
      `SELECT contact_name, phone, channel FROM conversations WHERE id = $1`, [row.conversation_id]);
    const info = c.rows[0] || {};
    const quien = info.contact_name || info.phone || `conv ${row.conversation_id}`;
    const pushNotifier = require('./push-notifier');
    await pushNotifier.broadcast({
      title: '🆘 Cliente sin responder',
      body: `${quien} escribió y la IA estuvo caída. Respondele vos: la conversación quedó sin contestar.`,
      url: '/panel/',
    }, row.tenant_id, { roles: ['owner', 'supervisor'] });
  } catch (e) { console.warn('[n8n-pending] escalada falló:', e.message); }
}

/** Sonda de salud. /healthz/readiness es el que devuelve 503 cuando la base se cayó. */
async function probe() {
  try {
    const r = await axios.get(`${HEALTH_URL}/healthz/readiness`, { timeout: 8000, validateStatus: () => true });
    const ok = r.status === 200 && (r.data?.status === 'ok' || r.status === 200);
    return { ok, status: r.status, body: typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 200) : String(r.data || '').slice(0, 200) };
  } catch (e) {
    return { ok: false, status: 0, body: e.code || e.message };
  }
}

/** Reinicia el servicio n8n en Railway. Opt-in y con topes: nunca entra en bucle. */
async function _autoRestart(reason) {
  const token = process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_N8N_SERVICE_ID;
  if (!token || !serviceId) {
    console.warn('🛑 [n8n-watchdog] auto-redeploy NO configurado (falta RAILWAY_API_TOKEN / RAILWAY_N8N_SERVICE_ID) — solo alerta');
    return { skipped: 'sin config' };
  }
  const today = new Date().toISOString().slice(0, 10);
  if (_restartsDay !== today) { _restartsDay = today; _restartsToday = 0; }
  if (_restartsToday >= RESTART_MAX_PER_DAY) return { skipped: 'tope diario' };
  if (Date.now() - _lastRestartAt < RESTART_COOLDOWN_MS) return { skipped: 'cooldown' };
  _lastRestartAt = Date.now(); _restartsToday++;
  const envId = process.env.RAILWAY_ENVIRONMENT_ID || null;
  const query = `mutation($sid: String!${envId ? ', $eid: String!' : ''}) {
    serviceInstanceRedeploy(serviceId: $sid${envId ? ', environmentId: $eid' : ''})
  }`;
  try {
    const r = await axios.post('https://backboard.railway.com/graphql/v2',
      { query, variables: envId ? { sid: serviceId, eid: envId } : { sid: serviceId } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    if (r.data && r.data.errors) throw new Error(JSON.stringify(r.data.errors).slice(0, 200));
    console.log(`♻️ [n8n-watchdog] AUTO-REDEPLOY disparado (${reason}) · ${_restartsToday}/${RESTART_MAX_PER_DAY} hoy`);
    return { ok: true };
  } catch (e) {
    console.error('[n8n-watchdog] auto-redeploy falló:', e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message);
    return { error: e.message };
  }
}

/** Un ciclo del watchdog. dispatchFn se usa para drenar la cola al recuperarse. */
async function tick(dispatchFn, notifyDown) {
  if (!ENABLED || _probing) return;
  _probing = true;
  try {
    const p = await probe();
    if (p.ok) {
      if (_lastState === 'down') {
        console.log(`💚 [n8n-watchdog] n8n RECUPERADO tras ${_failStreak} sondas fallidas — drenando cola`);
        if (typeof notifyDown === 'function') {
          notifyDown(`💚 n8n volvió a responder. Se reintentan los mensajes que quedaron en cola.`).catch(() => {});
        }
      }
      _failStreak = 0; _lastState = 'ok';
      if (typeof dispatchFn === 'function') await drain(dispatchFn).catch(() => {});
      return;
    }
    _failStreak++;
    _lastState = 'down';
    console.error(`🔴 [n8n-watchdog] n8n NO responde (${_failStreak} seguidas) · HTTP ${p.status} · ${p.body}`);
    if (_failStreak === 2 && typeof notifyDown === 'function') {
      notifyDown(`n8n no responde a la sonda de salud (HTTP ${p.status}: ${p.body}). Aitana está MUDA para todos los tenants. Los mensajes se están encolando para reintento.`).catch(() => {});
    }
    if (_failStreak >= RESTART_AFTER) await _autoRestart(`${_failStreak} sondas fallidas`);
  } finally { _probing = false; }
}

function status() {
  return { enabled: ENABLED, healthUrl: HEALTH_URL || null, state: _lastState, failStreak: _failStreak,
    restartsToday: _restartsToday, maxMin: MAX_MIN, restartAfter: RESTART_AFTER,
    autoRestart: !!(process.env.RAILWAY_API_TOKEN && process.env.RAILWAY_N8N_SERVICE_ID) };
}

/* ═══════════════════════════════════════════════════════════════════════════════
 * v0.9.578 — VERIFICACIÓN. Todo lo de arriba solo sirve si está bien configurado, y
 * eso hoy solo se sabe cuando ya es tarde. Estas tres funciones permiten comprobarlo
 * ANTES de necesitarlo, sin romper producción.
 * ═════════════════════════════════════════════════════════════════════════════ */

/**
 * ¿El token de Railway sirve y el service id existe? Consulta de SOLO LECTURA: pide el
 * nombre del servicio. Si esto anda, el auto-redeploy va a andar — usa el mismo token,
 * el mismo endpoint y el mismo id, pero sin reiniciar nada.
 */
async function checkRailway() {
  const token = process.env.RAILWAY_API_TOKEN;
  const serviceId = process.env.RAILWAY_N8N_SERVICE_ID;
  if (!token || !serviceId) {
    return { ok: false, configured: false,
      detail: 'Falta RAILWAY_API_TOKEN o RAILWAY_N8N_SERVICE_ID → el CRM alerta pero NO reinicia n8n solo.' };
  }
  try {
    const r = await axios.post('https://backboard.railway.com/graphql/v2',
      { query: 'query($sid: String!) { service(id: $sid) { id name } }', variables: { sid: serviceId } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    if (r.data && r.data.errors) {
      return { ok: false, configured: true, detail: JSON.stringify(r.data.errors).slice(0, 200) };
    }
    const name = r.data?.data?.service?.name || null;
    return { ok: !!name, configured: true, service: name,
      detail: name ? `Token válido. Reiniciaría el servicio "${name}".`
                   : 'El token respondió pero no devolvió el servicio: revisá RAILWAY_N8N_SERVICE_ID.' };
  } catch (e) {
    return { ok: false, configured: true,
      detail: e.response?.status === 401 ? 'Token de Railway rechazado (401).' : (e.message || 'error') };
  }
}

/** Cuántos mensajes hay en la cola, por estado. */
async function pendingStats() {
  try {
    const r = await db.query(
      `SELECT status, COUNT(*)::int AS n, MAX(updated_at) AS last
         FROM n8n_pending GROUP BY status`);
    const out = { pending: 0, done: 0, expired: 0, lastActivity: null };
    for (const row of r.rows) {
      if (row.status in out) out[row.status] = row.n;
      if (!out.lastActivity || (row.last && row.last > out.lastActivity)) out.lastActivity = row.last;
    }
    return out;
  } catch (e) { return { error: e.message }; }
}

const DRILL_CONV_ID = -99; // id imposible para una conversación real → nunca choca

/**
 * SIMULACRO de caída. Ejercita la cadena completa con datos de prueba:
 *   1. sonda real a n8n (informativa, no cambia el estado del watchdog)
 *   2. correo de "Aitana MUDA"   ← el que llega a los 2 fallos
 *   3. cola: escribe una fila de prueba y la drena con el código REAL (_processRow)
 *   4. opcional escalate=true: fuerza la expiración → correo "lead perdido" + push
 *   5. token de Railway (solo lectura): confirma que el reinicio automático podría correr
 *   6. correo de "Aitana volvió"  ← el de recuperación
 * NO toca las filas reales de la cola, NO despacha nada a n8n y NO reinicia nada.
 */
async function drill({ tenantId = null, escalate = false } = {}) {
  const steps = [];
  const push = (paso, ok, detalle) => steps.push({ paso, ok, detalle });

  // 1 — sonda real
  const p = HEALTH_URL ? await probe() : null;
  push('Sonda de salud de n8n', !!(p && p.ok),
    !HEALTH_URL ? 'N8N_HEALTH_URL sin configurar → la sonda no corre.'
      : (p.ok ? `n8n responde OK en ${HEALTH_URL}/healthz/readiness`
              : `n8n NO responde (HTTP ${p.status}: ${p.body})`));

  // 2 — correo de caída
  const mailer = require('./mailer');
  const mCfg = mailer.isConfigured();
  if (!mCfg) {
    push('Correo de alerta "Aitana muda"', false, 'Faltan RESEND_API_KEY / MAIL_FROM / ALERT_EMAIL_TO.');
  } else {
    const r1 = await mailer.alert('drill-down', {
      title: 'SIMULACRO — Aitana está MUDA',
      detail: 'Esto es una PRUEBA lanzada desde el panel. No pasó nada.\n\n'
        + 'Así se ve la alerta real: llega a los 2 fallos seguidos de la sonda (≈2 minutos), '
        + 'y a los 3 el CRM reinicia n8n solo. Mientras tanto los mensajes quedan en cola.',
      severity: 'error', force: true,
    });
    push('Correo de alerta "Aitana muda"', !r1.error, r1.error ? r1.error : `Enviado a ${mailer.status().to.join(', ')}`);
  }

  // 3 — cola: escribir + drenar con el código real
  try {
    await ensureSchema();
    await db.query(`DELETE FROM n8n_pending WHERE conversation_id = $1`, [DRILL_CONV_ID]).catch(() => {});
    const aged = escalate ? `NOW() - INTERVAL '${MAX_MIN + 5} minutes'` : 'NOW()';
    const ins = await db.query(
      `INSERT INTO n8n_pending (conversation_id, tenant_id, payload, attempts, last_error, created_at)
            VALUES ($1,$2,$3::jsonb,1,'SIMULACRO', ${aged}) RETURNING id, conversation_id, tenant_id, payload, created_at`,
      [DRILL_CONV_ID, tenantId, JSON.stringify({ drill: true })]);
    const row = ins.rows[0];
    push('Cola de reintentos (escritura)', true, `Fila de prueba creada en n8n_pending (id ${row.id}).`);

    let despachos = 0;
    const out = await _processRow(row, async () => { despachos++; }); // dispatch simulado
    if (escalate) {
      push('Expiración → escalada a humano', out === 'expired',
        out === 'expired'
          ? `La fila superó los ${MAX_MIN} min: se marcó expirada, salió el correo "Cliente sin responder" y el push al dueño.`
          : `Se esperaba "expired" y salió "${out}".`);
    } else {
      push('Cola de reintentos (drenaje)', out === 'sent' && despachos === 1,
        out === 'sent' ? 'La fila se drenó y se marcó como enviada con el mismo código que usa la recuperación real.'
                       : `Resultado inesperado: "${out}".`);
    }
    await db.query(`DELETE FROM n8n_pending WHERE conversation_id = $1`, [DRILL_CONV_ID]).catch(() => {});
  } catch (e) {
    push('Cola de reintentos', false, `No se pudo usar n8n_pending: ${e.message}`);
  }

  // 4 — Railway (solo lectura)
  const rw = await checkRailway();
  push('Reinicio automático (token de Railway)', rw.ok, rw.detail);

  // 5 — correo de recuperación
  if (mCfg) {
    const r2 = await mailer.alert('drill-up', {
      title: 'SIMULACRO — Aitana volvió a responder',
      detail: 'Segundo correo de la prueba. Así se ve el aviso de recuperación, el que llega '
        + 'cuando n8n vuelve y se drena la cola.\n\nSi te llegaron los dos correos, el canal está sano.',
      severity: 'ok', force: true,
    });
    push('Correo de recuperación "Aitana volvió"', !r2.error, r2.error ? r2.error : 'Enviado.');
  }

  const okAll = steps.every((s) => s.ok);
  console.log(`🧪 [n8n-watchdog] SIMULACRO ejecutado · ${steps.filter((s) => s.ok).length}/${steps.length} pasos OK`);
  return { ok: okAll, steps, watchdog: status(), mailer: mailer.status() };
}

module.exports = {
  ensureSchema, enqueue, drain, probe, tick, status,
  checkRailway, pendingStats, drill, // v0.9.578
  ENABLED, MAX_MIN,
};
