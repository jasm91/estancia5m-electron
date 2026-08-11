/* Pruebas de la verificación de autodefensa (v0.9.578). Sin red ni base real. */
const path = require('path');
let fails = 0, oks = 0;
function t(name, cond, extra) {
  if (cond) { oks++; console.log('  ✅', name); }
  else { fails++; console.log('  ❌', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

// ── stub de db ───────────────────────────────────────────────────────────────
const ROWS = [];
let SEQ = 1;
const DBLOG = [];
const db = {
  async query(sql, params = []) {
    DBLOG.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    if (/CREATE (TABLE|UNIQUE INDEX|INDEX)/i.test(sql)) return { rows: [] };
    if (/^\s*DELETE FROM n8n_pending/i.test(sql)) {
      for (let i = ROWS.length - 1; i >= 0; i--) if (ROWS[i].conversation_id === params[0]) ROWS.splice(i, 1);
      return { rows: [] };
    }
    if (/INSERT INTO n8n_pending/i.test(sql)) {
      const aged = /INTERVAL/.test(sql);
      const m = sql.match(/INTERVAL '(\d+) minutes'/);
      const row = {
        id: SEQ++, conversation_id: params[0], tenant_id: params[1],
        payload: JSON.parse(params[2]), attempts: 1, status: 'pending',
        created_at: new Date(Date.now() - (aged ? parseInt(m[1], 10) : 0) * 60000),
      };
      ROWS.push(row);
      return { rows: [row] };
    }
    if (/UPDATE n8n_pending SET status='expired'/i.test(sql)) {
      const r = ROWS.find((x) => x.id === params[0]); if (r) r.status = 'expired'; return { rows: [] };
    }
    if (/UPDATE n8n_pending SET status='done'/i.test(sql)) {
      const r = ROWS.find((x) => x.id === params[0]); if (r) r.status = 'done'; return { rows: [] };
    }
    if (/UPDATE n8n_pending SET attempts/i.test(sql)) {
      const r = ROWS.find((x) => x.id === params[0]); if (r) r.attempts++; return { rows: [] };
    }
    if (/SELECT status, COUNT/i.test(sql)) {
      const by = {};
      for (const r of ROWS) by[r.status] = (by[r.status] || 0) + 1;
      return { rows: Object.keys(by).map((s) => ({ status: s, n: by[s], last: new Date() })) };
    }
    if (/FROM n8n_pending WHERE status = 'pending'/i.test(sql)) {
      return { rows: ROWS.filter((r) => r.status === 'pending') };
    }
    if (/FROM conversations WHERE id/i.test(sql)) return { rows: [] };
    return { rows: [] };
  },
};
require.cache[require.resolve('./db')] = { id: 'db', filename: 'db', loaded: true, exports: db };

// push-notifier stub
const PUSHES = [];
require.cache[require.resolve('./push-notifier')] = {
  id: 'pn', filename: 'pn', loaded: true,
  exports: { broadcast: async (p, tenant, o) => { PUSHES.push({ p, tenant, o }); } },
};

// ── env + axios stub ─────────────────────────────────────────────────────────
process.env.RESEND_API_KEY = 're_fake';
process.env.MAIL_FROM = 'alertas@sg.test';
process.env.ALERT_EMAIL_TO = 'jose@test.com';
process.env.N8N_HEALTH_URL = 'https://n8n.test';
process.env.N8N_WATCHDOG_ENABLED = '1';
process.env.N8N_PENDING_MAX_MIN = '20';

const MAILS = [];
let N8N_UP = true;
let RAILWAY_MODE = 'ok';
global.__AX = async (method, url, body, cfg) => {
  if (method === 'get' && /healthz\/readiness/.test(url)) {
    return N8N_UP ? { status: 200, data: { status: 'ok' } } : { status: 503, data: { code: 503, message: 'Database is not ready!' } };
  }
  if (method === 'post' && /api\.resend\.com/.test(url)) { MAILS.push(body); return { status: 200, data: { id: 'm1' } }; }
  if (method === 'post' && /backboard\.railway/.test(url)) {
    if (RAILWAY_MODE === 'ok') return { status: 200, data: { data: { service: { id: 's1', name: 'n8n' } } } };
    if (RAILWAY_MODE === 'errors') return { status: 200, data: { errors: [{ message: 'Not Authorized' }] } };
    const e = new Error('Request failed'); e.response = { status: 401 }; throw e;
  }
  throw new Error('URL inesperada: ' + url);
};

const wd = require('./n8n-watchdog');

(async () => {
  console.log('\n🧪 checkRailway');
  delete process.env.RAILWAY_API_TOKEN; delete process.env.RAILWAY_N8N_SERVICE_ID;
  let r = await wd.checkRailway();
  t('sin token → configured=false y no revienta', r.configured === false && r.ok === false, r);

  process.env.RAILWAY_API_TOKEN = 'tok'; process.env.RAILWAY_N8N_SERVICE_ID = 'svc';
  r = await wd.checkRailway();
  t('token válido → ok y nombre del servicio', r.ok === true && r.service === 'n8n', r);

  RAILWAY_MODE = 'errors';
  r = await wd.checkRailway();
  t('GraphQL con errors → ok=false', r.ok === false && /Not Authorized/.test(r.detail), r);

  RAILWAY_MODE = '401';
  r = await wd.checkRailway();
  t('401 → mensaje claro de token rechazado', r.ok === false && /401/.test(r.detail), r);
  RAILWAY_MODE = 'ok';

  console.log('\n🧪 drill — camino feliz');
  MAILS.length = 0; PUSHES.length = 0; ROWS.length = 0;
  let d = await wd.drill({ tenantId: 7 });
  t('todos los pasos OK', d.ok === true, d.steps.filter((s) => !s.ok));
  t('manda exactamente 2 correos (caída + recuperación)', MAILS.length === 2, MAILS.length);
  t('el 1º es la alerta roja', /MUDA/.test(MAILS[0].subject) && /🔴/.test(MAILS[0].subject), MAILS[0] && MAILS[0].subject);
  t('el 2º es la recuperación verde', /volvió/.test(MAILS[1].subject) && /✅/.test(MAILS[1].subject), MAILS[1] && MAILS[1].subject);
  t('NO manda push en el modo normal', PUSHES.length === 0, PUSHES.length);
  t('la fila de prueba se borra al final', ROWS.length === 0, ROWS);
  t('el paso de drenaje dice enviado', d.steps.some((s) => /drenaje/i.test(s.paso) && s.ok), d.steps);

  console.log('\n🧪 drill — escalada a humano');
  MAILS.length = 0; PUSHES.length = 0; ROWS.length = 0;
  d = await wd.drill({ tenantId: 7, escalate: true });
  t('el paso de expiración pasa', d.steps.some((s) => /Expiración/i.test(s.paso) && s.ok), d.steps);
  t('sale el correo de lead perdido', MAILS.some((m) => /sin responder/i.test(m.subject)), MAILS.map((m) => m.subject));
  t('sale el push al tenant correcto', PUSHES.length === 1 && PUSHES[0].tenant === 7, PUSHES);
  t('la fila de prueba se borra igual', ROWS.length === 0, ROWS);

  console.log('\n🧪 drill — n8n caído de verdad');
  N8N_UP = false; MAILS.length = 0; ROWS.length = 0;
  d = await wd.drill({ tenantId: 1 });
  t('reporta la sonda en rojo', d.steps.some((s) => /Sonda/.test(s.paso) && !s.ok), d.steps[0]);
  t('ok global = false', d.ok === false);
  t('aun así manda los correos (el canal se prueba igual)', MAILS.length === 2, MAILS.length);
  N8N_UP = true;

  console.log('\n🧪 drill — sin correo configurado');
  MAILS.length = 0; ROWS.length = 0;
  delete require.cache[require.resolve('./mailer')];
  const KEY = process.env.RESEND_API_KEY; delete process.env.RESEND_API_KEY;
  delete require.cache[require.resolve('./n8n-watchdog')];
  const wd2 = require('./n8n-watchdog');
  d = await wd2.drill({ tenantId: 1 });
  t('avisa que falta config y no revienta', d.steps.some((s) => /Correo/.test(s.paso) && !s.ok), d.steps);
  t('no intenta mandar nada', MAILS.length === 0, MAILS.length);
  process.env.RESEND_API_KEY = KEY;
  delete require.cache[require.resolve('./mailer')];

  console.log('\n🧪 drain() sigue funcionando tras el refactor');
  ROWS.length = 0;
  await db.query(`INSERT INTO n8n_pending (conversation_id, tenant_id, payload, attempts, last_error, created_at) VALUES ($1,$2,$3::jsonb,1,'x', NOW())`, [111, 3, '{"a":1}']);
  await db.query(`INSERT INTO n8n_pending (conversation_id, tenant_id, payload, attempts, last_error, created_at) VALUES ($1,$2,$3::jsonb,1,'x', NOW() - INTERVAL '30 minutes')`, [222, 3, '{"b":2}']);
  const enviados = [];
  const res = await wd.drain(async (p) => { enviados.push(p); });
  t('drena la reciente y expira la vieja', res.sent === 1 && res.expired === 1, res);
  t('solo despachó la reciente', enviados.length === 1 && enviados[0].a === 1, enviados);

  console.log('\n🧪 pendingStats');
  ROWS.length = 0;
  await db.query(`INSERT INTO n8n_pending (conversation_id, tenant_id, payload, attempts, last_error, created_at) VALUES ($1,$2,$3::jsonb,1,'x', NOW())`, [1, 1, '{}']);
  const st = await wd.pendingStats();
  t('cuenta las pendientes', st.pending === 1 && st.expired === 0, st);

  console.log(`\n${fails === 0 ? '✅' : '❌'} ${oks} OK · ${fails} fallos\n`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(1); });
