/**
 * agenda.js — Reglas de la agenda de citas (v0.9.514)
 * ---------------------------------------------------------------------------
 * FUENTE ÚNICA DE VERDAD. Antes el cálculo de horarios libres estaba duplicado en
 * dos archivos (api.js `_genSlots` y bot-prompt-builder.js `_availableSlotsBlock`)
 * con criterios de "ocupado" DISTINTOS: uno miraba una ventana de ±slot y el otro
 * exigía igualdad exacta de timestamp. Resultado: Aitana ofrecía huecos que la
 * página pública consideraba ocupados, y al revés. Acá se calcula una sola vez.
 *
 * QUÉ ARREGLA, ADEMÁS DE UNIFICAR:
 *   · El camino del bot (/api/bot/book-appointment) no validaba NADA: ni choque de
 *     horario, ni día hábil, ni horario de atención. Dos clientes podían quedar a
 *     la misma hora, y se podía agendar un domingo a las 3 de la mañana.
 *   · Los "Horarios de atención" del negocio eran solo texto para el prompt del
 *     bot; la agenda los ignoraba por completo.
 *
 * CONFIGURACIÓN EN DOS NIVELES
 *   La organización fija la regla (tenants.agenda_config) y cada asesor puede
 *   pisarla (tenant_users.agenda_config). Cualquier clave ausente en el asesor
 *   hereda la del tenant, y la del tenant hereda el default de acá. Así el dueño
 *   pone el estándar sin impedir que alguien haga visitas de 90 minutos.
 *
 * NOTA SOBRE HORARIOS: todo el módulo trabaja en "minutos del día" locales del
 * asesor (tz_offset_min) y recién al final convierte a UTC. Mezclar husos a mitad
 * del cálculo es la forma clásica de que aparezcan citas corridas una hora.
 */
const db = require('./db');

const DEFAULTS = {
  slot_minutes: 30,          // duración de la visita
  buffer_minutes: 0,         // colchón entre citas (traslado entre inmuebles)
  capacity_per_slot: 1,      // cuántas citas pueden convivir en el mismo horario
  min_notice_minutes: 30,    // anticipación mínima para reservar
  max_days_ahead: 14,        // hasta cuándo se ofrece agenda
  max_per_day: 0,            // 0 = sin tope de citas por día
  respect_business_hours: false, // por defecto NO, para no cambiarle la agenda a quien ya opera
  blocked_dates: [],         // ['2026-08-06', …] feriados / vacaciones
  no_booking_windows: [],    // v0.9.522 — franjas horarias diarias donde NO se agenda:
                             // [{from:'12:30', to:'14:00'}, …]. Aplica TODOS los días.
                             // Ej: almuerzo (12:30-14:00) o "nada después de las 18:00" (18:00-23:59).
                             // Aitana no ofrece esos slots y propone otros libres.
};

const LIMITES = {
  slot_minutes: [5, 480], buffer_minutes: [0, 240], capacity_per_slot: [1, 50],
  min_notice_minutes: [0, 20160], max_days_ahead: [1, 180], max_per_day: [0, 50],
};

/** Normaliza y acota lo que venga del panel. Silencioso: valores basura → default. */
function sanitize(raw) {
  const inp = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const [k, [min, max]] of Object.entries(LIMITES)) {
    if (inp[k] === undefined || inp[k] === null || inp[k] === '') continue;
    const v = Math.round(Number(inp[k]));
    if (!Number.isFinite(v)) continue;
    out[k] = Math.min(max, Math.max(min, v));
  }
  if (inp.respect_business_hours !== undefined) out.respect_business_hours = inp.respect_business_hours === true || inp.respect_business_hours === 'true';
  if (Array.isArray(inp.blocked_dates)) {
    // No alcanza con el formato: '2026-13-99' pasa el regex y después no bloquea
    // nada nunca, en silencio. Se valida que sea una fecha que exista de verdad.
    const esFecha = (d) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
      const [y, m, day] = d.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, day));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
    };
    out.blocked_dates = [...new Set(inp.blocked_dates.map((d) => String(d || '').trim()).filter(esFecha))]
      .sort().slice(0, 200);
  }
  if (Array.isArray(inp.no_booking_windows)) {
    // Franjas diarias sin agenda. Se valida que sean horas reales y que from < to;
    // así una franja basura ('25:00' o from>=to) se descarta en silencio en vez de
    // bloquear el día entero o no bloquear nada.
    const esHora = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
      if (!m) return false;
      return +m[1] >= 0 && +m[1] <= 23 && +m[2] >= 0 && +m[2] <= 59;
    };
    out.no_booking_windows = inp.no_booking_windows
      .map((w) => ({ from: String((w && w.from) || '').trim(), to: String((w && w.to) || '').trim() }))
      .filter((w) => esHora(w.from) && esHora(w.to) && _hhmmToMo(w.from, 0) < _hhmmToMo(w.to, 0))
      .sort((a, b) => _hhmmToMo(a.from, 0) - _hhmmToMo(b.from, 0))
      .slice(0, 20);
  }
  return out;
}

/** Mezcla los tres niveles. El asesor gana sobre el tenant, y el tenant sobre el default. */
function merge(tenantCfg, userCfg) {
  return { ...DEFAULTS, ...sanitize(tenantCfg), ...sanitize(userCfg) };
}

// v0.9.523 — CONFIG POR LÍNEA. Antes se mezclaba tenant + asesor (por-usuario), pero
// resultaba confuso. Ahora, igual que los prompts: default del tenant + override por
// LÍNEA (tenant_lines.agenda_config). La línea gana sobre el default. La disponibilidad
// propia de cada asesor (avail_*, break_*) sigue siendo por-usuario — eso es su calendario,
// no las reglas de la agenda.
async function getConfig(tenantId, lineId) {
  let tCfg = null, lCfg = null;
  try {
    const r = await db.query(`SELECT to_jsonb(tenants) -> 'agenda_config' AS cfg FROM tenants WHERE id = $1`, [tenantId]);
    tCfg = r.rows[0] && r.rows[0].cfg;
  } catch (e) { /* columna sin migrar */ }
  if (lineId) {
    try {
      const r = await db.query(`SELECT to_jsonb(tenant_lines) -> 'agenda_config' AS cfg FROM tenant_lines WHERE id = $1`, [lineId]);
      lCfg = r.rows[0] && r.rows[0].cfg;
    } catch (e) { /* columna sin migrar → solo default del tenant */ }
  }
  return merge(tCfg, lCfg);
}

/** line_id de una conversación (para resolver la config al ofrecer/validar citas). */
async function lineIdOfConversation(conversationId) {
  if (!conversationId) return null;
  try {
    const r = await db.query('SELECT line_id FROM conversations WHERE id = $1', [conversationId]);
    return (r.rows[0] && r.rows[0].line_id) || null;
  } catch (e) { return null; }
}

/**
 * line_id "efectiva" de un asesor para el link público de agenda. El link es por-asesor,
 * no por-línea; si el asesor tiene EXACTAMENTE una línea asignada usamos su config, y si
 * tiene 0 o varias caemos al default del tenant (no hay una línea obvia).
 */
async function lineIdOfUser(userId) {
  if (!userId) return null;
  try {
    const r = await db.query('SELECT line_id FROM tenant_user_lines WHERE user_id = $1', [userId]);
    return r.rows.length === 1 ? r.rows[0].line_id : null;
  } catch (e) { return null; }
}

// ── horarios de atención del negocio ─────────────────────────────────
const BH_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * Convierte los business_hours del tenant en rangos de minutos por día de semana
 * ISO (1=lunes … 7=domingo). Devuelve null si no hay nada configurado, que
 * significa "no restringir" — no "cerrado todos los días".
 */
function businessRanges(bh) {
  if (!bh || typeof bh !== 'object' || !bh.days) return null;
  const out = {};
  let alguno = false;
  for (let iso = 1; iso <= 7; iso++) {
    const key = BH_DAYS[iso % 7]; // 7 (domingo ISO) → 'sun'
    const arr = Array.isArray(bh.days[key]) ? bh.days[key] : [];
    out[iso] = arr.map((r) => {
      const [oh, om] = String(r.open || '').split(':').map(Number);
      const [ch, cm] = String(r.close || '').split(':').map(Number);
      if (!Number.isFinite(oh) || !Number.isFinite(ch)) return null;
      return [oh * 60 + (om || 0), ch * 60 + (cm || 0)];
    }).filter(Boolean);
    if (out[iso].length) alguno = true;
  }
  return alguno ? out : null;
}

function dentroDeBusiness(ranges, isoDow, desdeMo, hastaMo) {
  if (!ranges) return true;
  const dia = ranges[isoDow] || [];
  if (!dia.length) return false; // día cerrado
  return dia.some(([a, b]) => desdeMo >= a && hastaMo <= b);
}

// ── generación de horarios ───────────────────────────────────────────
function _hhmmToMo(s, fallback) {
  if (!/^\d{1,2}:\d{2}$/.test(String(s || ''))) return fallback;
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
}
function _fechaLocal(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Devuelve los horarios LIBRES del asesor, ya filtrados por todo:
 * disponibilidad propia, pausa, horarios del negocio, feriados, anticipación
 * mínima, ventana máxima, bloqueos manuales, cupo por horario y tope diario.
 *
 * `citas` son las citas vigentes del asesor: [{ starts_at, ends_at }].
 * El choque se evalúa por SOLAPAMIENTO REAL de rangos —incluyendo el colchón—,
 * no por igualdad de hora de inicio: una visita de 90 minutos tapa tres slots de
 * 30, y antes eso no se veía.
 */
function generarSlots({ user, cfg, citas = [], bloqueos = [], businessHours = null, ahora = null }) {
  const c = cfg || DEFAULTS;
  const offsetMin = Number.isFinite(+user.tz_offset_min) ? +user.tz_offset_min : -240;
  const slotMin = Math.max(5, Number(user.slot_minutes) || c.slot_minutes || 30);
  const buffer = Math.max(0, Number(c.buffer_minutes) || 0);
  const cupo = Math.max(1, Number(c.capacity_per_slot) || 1);
  const nowUtc = ahora == null ? Date.now() : ahora;
  const minNotice = Math.max(0, Number(c.min_notice_minutes));
  const dias = Math.max(1, Number(c.max_days_ahead) || 14);
  const topeDia = Math.max(0, Number(c.max_per_day) || 0);
  const feriados = new Set(Array.isArray(c.blocked_dates) ? c.blocked_dates : []);
  const ranges = c.respect_business_hours ? businessRanges(businessHours) : null;
  // v0.9.522 — franjas diarias sin agenda (almuerzo, "nada después de las X"), en minutos del día.
  const noBook = (Array.isArray(c.no_booking_windows) ? c.no_booking_windows : [])
    .map((w) => [_hhmmToMo(w.from, null), _hhmmToMo(w.to, null)])
    .filter(([a, b]) => a != null && b != null && a < b);

  const availDays = String(user.avail_days || '1,2,3,4,5').split(',').map((s) => parseInt(s, 10)).filter((n) => n >= 1 && n <= 7);
  const startMo = _hhmmToMo(user.avail_start, 9 * 60);
  const endMo = _hhmmToMo(user.avail_end, 18 * 60);
  let bsMo = null, beMo = null;
  if (user.break_start && user.break_end) {
    bsMo = _hhmmToMo(user.break_start, null); beMo = _hhmmToMo(user.break_end, null);
  }

  // Citas y bloqueos como rangos [inicio, fin) en ms. Al colchón se lo suma a la
  // cita, no al slot: así "30 min entre visitas" significa media hora libre a cada
  // lado de lo ya agendado, que es como lo piensa un asesor.
  const ocupados = citas.map((a) => {
    const s = new Date(a.starts_at).getTime();
    const e = a.ends_at ? new Date(a.ends_at).getTime() : s + slotMin * 60000;
    return [s - buffer * 60000, e + buffer * 60000, _fechaLocal(s, offsetMin)];
  }).filter(([s]) => Number.isFinite(s));
  const bloqs = bloqueos.map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e));

  const porDia = {};
  for (const [, , f] of ocupados) { if (f) porDia[f] = (porDia[f] || 0) + 1; }

  const localNow = new Date(nowUtc + offsetMin * 60000);
  const out = [];
  for (let d = 0; d < dias; d++) {
    const probe = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate() + d));
    let dow = probe.getUTCDay(); dow = dow === 0 ? 7 : dow;
    if (!availDays.includes(dow)) continue;
    const fecha = `${probe.getUTCFullYear()}-${String(probe.getUTCMonth() + 1).padStart(2, '0')}-${String(probe.getUTCDate()).padStart(2, '0')}`;
    if (feriados.has(fecha)) continue;
    if (topeDia && (porDia[fecha] || 0) >= topeDia) continue;

    for (let m = startMo; m + slotMin <= endMo; m += slotMin) {
      if (bsMo != null && beMo != null && m < beMo && m + slotMin > bsMo) continue; // almuerzo del asesor
      if (noBook.some(([a, b]) => m < b && m + slotMin > a)) continue; // v0.9.522 — franja sin agenda de la org
      if (!dentroDeBusiness(ranges, dow, m, m + slotMin)) continue;
      const utcMs = Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), probe.getUTCDate(), 0, m, 0) - offsetMin * 60000;
      if (utcMs <= nowUtc + minNotice * 60000) continue;
      const fin = utcMs + slotMin * 60000;
      if (bloqs.some(([s, e]) => utcMs < e && fin > s)) continue;
      const choques = ocupados.filter(([s, e]) => utcMs < e && fin > s).length;
      if (choques >= cupo) continue;
      out.push(new Date(utcMs).toISOString());
    }
  }
  return { slots: out, slotMin };
}

/**
 * ¿Se puede reservar `startIso` en la agenda de este asesor?
 * Devuelve { ok } o { ok:false, error } con un mensaje para mostrarle al cliente.
 * Se usa en los TRES caminos de alta (link público, bot y panel) para que las
 * reglas no dependan de por dónde entró la cita.
 */
function puedeReservar({ startIso, user, cfg, citas = [], bloqueos = [], businessHours = null, ahora = null }) {
  const start = new Date(startIso).getTime();
  if (!Number.isFinite(start)) return { ok: false, error: 'La fecha de la cita no es válida.' };
  const { slots, slotMin } = generarSlots({ user, cfg, citas, bloqueos, businessHours, ahora });
  // Tolerancia de 1 minuto: el cliente manda el mismo slot que se le ofreció, pero
  // los segundos pueden venir con ruido según de dónde salga el timestamp.
  const libre = slots.some((iso) => Math.abs(new Date(iso).getTime() - start) < 60000);
  if (libre) return { ok: true, slotMin };
  const nowUtc = ahora == null ? Date.now() : ahora;
  const c = cfg || DEFAULTS;
  if (start <= nowUtc + Math.max(0, Number(c.min_notice_minutes)) * 60000) {
    return { ok: false, error: `Ese horario es demasiado pronto: se necesita al menos ${c.min_notice_minutes} minutos de anticipación.` };
  }
  if (start > nowUtc + Math.max(1, Number(c.max_days_ahead)) * 86400000) {
    return { ok: false, error: `Ese horario está más allá de los ${c.max_days_ahead} días que se pueden agendar.` };
  }
  return { ok: false, error: 'Ese horario no está disponible. Elegí otro de los que aparecen libres.' };
}

/** Citas vigentes de un asesor, para alimentar el cálculo. */
async function citasDe(userId, dias) {
  if (!userId) return [];
  try {
    const r = await db.query(
      `SELECT starts_at, ends_at FROM appointments
        WHERE user_id = $1 AND status NOT IN ('cancelled','no_show')
          AND starts_at > NOW() - INTERVAL '1 day'
          AND starts_at < NOW() + ($2 || ' days')::interval`,
      [userId, String(Math.max(1, Number(dias) || 14) + 1)]);
    return r.rows;
  } catch (e) { return []; }
}

/**
 * Citas del POOL (las que crea el bot, sin dueño todavía). Cuentan como ocupadas
 * a propósito: si Aitana ya le prometió las 15:00 a un cliente, no puede
 * ofrecérselas a otro solo porque nadie las tomó del pool aún.
 */
async function citasPendientesDelTenant(tenantId, dias) {
  if (!tenantId) return [];
  try {
    const r = await db.query(
      `SELECT starts_at, ends_at FROM appointments
        WHERE tenant_id = $1 AND user_id IS NULL AND status = 'pending'
          AND starts_at > NOW() - INTERVAL '1 day'
          AND starts_at < NOW() + ($2 || ' days')::interval`,
      [tenantId, String(Math.max(1, Number(dias) || 14) + 1)]);
    return r.rows;
  } catch (e) { return []; }
}

/**
 * Qué agenda mira el bot para validar. Es la misma que usa el prompt para OFRECER
 * horarios (bot-prompt-builder), y tiene que serlo: si ofreciera los huecos de un
 * asesor y validara contra otro, el cliente elegiría un horario que después se
 * rechaza. Prioridad: el asesor asignado a la conversación → el dueño con agenda.
 */
async function agendaDeReferencia(tenantId, conversationId) {
  const COLS = 'id, display_name, avail_days, avail_start, avail_end, slot_minutes, tz_offset_min, break_start, break_end';
  if (conversationId) {
    try {
      const r = await db.query(
        `SELECT ${COLS} FROM tenant_users
          WHERE id = (SELECT assigned_to FROM conversations WHERE id = $1) AND booking_enabled = TRUE`,
        [conversationId]);
      if (r.rows[0]) return r.rows[0];
    } catch (e) { /* sigue al default */ }
  }
  try {
    const r = await db.query(
      `SELECT ${COLS} FROM tenant_users
        WHERE tenant_id = $1 AND booking_enabled = TRUE AND booking_token IS NOT NULL
        ORDER BY (role = 'owner') DESC, id ASC LIMIT 1`, [tenantId]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

// v0.9.523 — horarios de atención POR LÍNEA: override de la línea → default del tenant.
async function businessHoursDe(tenantId, lineId) {
  if (lineId) {
    try {
      const r = await db.query(`SELECT to_jsonb(tenant_lines) -> 'business_hours' AS bh FROM tenant_lines WHERE id = $1`, [lineId]);
      if (r.rows[0] && r.rows[0].bh) return r.rows[0].bh;
    } catch (e) { /* columna sin migrar → default */ }
  }
  try {
    const r = await db.query(`SELECT to_jsonb(tenants) -> 'business_hours' AS bh FROM tenants WHERE id = $1`, [tenantId]);
    return (r.rows[0] && r.rows[0].bh) || null;
  } catch (e) { return null; }
}

async function ensureSchema() {
  try { await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS agenda_config JSONB`); }
  catch (e) { console.error('[agenda] schema tenants:', e.message); }
  try { await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS agenda_config JSONB`); }
  catch (e) { console.error('[agenda] schema tenant_users:', e.message); }
  // v0.9.523 — reglas + horarios de atención POR LÍNEA
  try { await db.query(`ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS agenda_config JSONB`); }
  catch (e) { console.error('[agenda] schema tenant_lines.agenda_config:', e.message); }
  try { await db.query(`ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS business_hours JSONB`); }
  catch (e) { console.error('[agenda] schema tenant_lines.business_hours:', e.message); }
}

module.exports = {
  DEFAULTS, LIMITES, sanitize, merge, getConfig, ensureSchema,
  generarSlots, puedeReservar, businessRanges,
  citasDe, citasPendientesDelTenant, businessHoursDe, agendaDeReferencia,
  lineIdOfConversation, lineIdOfUser,
};
