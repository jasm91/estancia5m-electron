// ============================================================
// biz-intel.js — v0.9.559 INTELIGENCIA DE NEGOCIOS (super-admin)
// Ingresos teóricos (QRs de cobro emitidos por período + ventas software creadas)
// vs ingresos REALES (pagos verificados: QR billing pagado + software pagado + USDT
// acreditado) vs costos REALES (IA por tokens de ai_usage × precios, voz por chars
// de voice_usage × precio ElevenLabs, y costos manuales: infra/Railway, marketing,
// personal temporal, comisiones, otros) + NÓMINA (biz_staff con factor de carga).
// Resultado bruto = real − costos directos (IA+voz+infra).
// Resultado neto  = bruto − nómina − adquisición (marketing+temporales+comisiones) − otros.
// Todo best-effort: una fuente que falte devuelve 0, nunca rompe el resumen.
// ============================================================
const db = require('./db');

let _schemaOk = false;
async function ensureSchema() {
  if (_schemaOk) return;
  await db.query(`CREATE TABLE IF NOT EXISTS biz_staff (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT,
    salary_bs NUMERIC(12,2) NOT NULL DEFAULT 0,
    load_factor NUMERIC(5,2) NOT NULL DEFAULT 1.30,
    start_month TEXT NOT NULL,          -- 'YYYY-MM'
    end_month TEXT,                     -- NULL = sigue activo
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE TABLE IF NOT EXISTS biz_costs (
    id SERIAL PRIMARY KEY,
    month TEXT NOT NULL,                -- 'YYYY-MM'
    category TEXT NOT NULL,             -- infra | marketing | personal_temporal | comisiones | ia_extra | otros
    concept TEXT,
    amount_bs NUMERIC(12,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_biz_costs_month ON biz_costs (month)`).catch(() => {});
  // v0.9.566 — switch de respuesta pública a comentarios (self-heal)
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_enabled boolean NOT NULL DEFAULT false`).catch(() => {});
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_text text`).catch(() => {});
  _schemaOk = true;
}

// v0.9.564 — buckets por granularidad: month 'YYYY-MM' · day 'YYYY-MM-DD' · week 'IYYY-Www' (ISO)
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const y = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const wk = 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(wk).padStart(2, '0')}`;
}
function bucketList(n, gran) {
  const out = []; const d = new Date();
  if (gran === 'day') {
    for (let i = n - 1; i >= 0; i--) { const x = new Date(Date.now() - i * 86400000); out.push(x.toISOString().slice(0, 10)); }
  } else if (gran === 'week') {
    const seen = new Set();
    for (let i = (n * 7) - 1; i >= 0; i--) { const k = isoWeekKey(new Date(Date.now() - i * 86400000)); if (!seen.has(k)) { seen.add(k); out.push(k); } }
    return out.slice(-n);
  } else {
    for (let i = n - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(`${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`); }
  }
  return out;
}
function monthList(n) {
  const out = [];
  const d = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

async function _pricing() {
  const def = { gin: 0.30, gout: 2.50, el1k: 0.11, tc: 10.4 };
  try {
    const r = await db.query(`SELECT (to_jsonb(platform_pricing)->>'gemini_in_usd_per_m')::numeric AS gin,
        (to_jsonb(platform_pricing)->>'gemini_out_usd_per_m')::numeric AS gout,
        (to_jsonb(platform_pricing)->>'elevenlabs_usd_per_1k_chars')::numeric AS el1k,
        (to_jsonb(platform_pricing)->>'usd_to_bs_rate')::numeric AS tc
      FROM platform_pricing WHERE id = 1`);
    const p = r.rows[0] || {};
    return { gin: N(p.gin) || def.gin, gout: N(p.gout) || def.gout, el1k: N(p.el1k) || def.el1k, tc: N(p.tc) || def.tc };
  } catch (e) { return def; }
}

// agrupador tolerante: query que devuelve filas {m, v} → Map(month→num). Falla → Map vacío.
async function _byMonth(sql, params = []) {
  try {
    const r = await db.query(sql, params);
    const m = new Map();
    for (const row of r.rows) if (row.m) m.set(row.m, N(row.v));
    return m;
  } catch (e) { return new Map(); }
}

// v0.9.560 — tenants NO facturables (trial/suspended/cancelled): fuera del ingreso teórico.
const NOBILL = `('trial','suspended','cancelled')`;
const BILLABLE = `LOWER(COALESCE((to_jsonb(tenants)->>'billing_status'),'active')) NOT IN ${NOBILL}`;

// v0.9.560 — estructura ACTUAL facturable: cuánto teórico fijo por líneas / usuarios / canales
// (mismas reglas del billing: línea incluye 1 usuario; billing_excluded no cuenta; precios por tenant).
async function currentStructure(P) {
  const out = { tenants_facturables: 0, tenants_no_facturables: 0, lineas_n: 0, usuarios_facturables_n: 0, usuarios_cobrados_n: 0, canales_n: 0, lineasBs: 0, usuariosBs: 0, canalesBs: 0 };
  try {
    const bt = await db.query(`SELECT id,
        COALESCE((to_jsonb(tenants)->>'price_per_line')::numeric, 25) AS pl,
        COALESCE((to_jsonb(tenants)->>'price_per_user')::numeric, 15) AS pu,
        (to_jsonb(tenants)->>'price_per_channel')::numeric AS pc
      FROM tenants WHERE COALESCE(active, TRUE) = TRUE AND ${BILLABLE}`);
    const nb = await db.query(`SELECT COUNT(*)::int AS n FROM tenants WHERE LOWER(COALESCE((to_jsonb(tenants)->>'billing_status'),'active')) IN ${NOBILL}`);
    out.tenants_no_facturables = N(nb.rows[0] && nb.rows[0].n);
    out.tenants_facturables = bt.rows.length;
    let defCh = 290;
    try { const c = await db.query(`SELECT (to_jsonb(platform_pricing)->>'default_price_per_channel')::numeric AS v FROM platform_pricing WHERE id=1`); defCh = N(c.rows[0] && c.rows[0].v) || 290; } catch (e) {}
    const lines = new Map(), users = new Map(), chans = new Map();
    try { for (const r of (await db.query(`SELECT tenant_id, COUNT(*) FILTER (WHERE COALESCE(active, TRUE) = TRUE AND COALESCE((to_jsonb(tenant_lines)->>'billing_excluded')::boolean, FALSE) = FALSE)::int AS n FROM tenant_lines GROUP BY tenant_id`)).rows) lines.set(r.tenant_id, N(r.n)); } catch (e) {}
    try { for (const r of (await db.query(`SELECT tenant_id, COUNT(*) FILTER (WHERE COALESCE((to_jsonb(tenant_users)->>'billing_excluded')::boolean, FALSE) = FALSE)::int AS n FROM tenant_users GROUP BY tenant_id`)).rows) users.set(r.tenant_id, N(r.n)); } catch (e) {}
    try { for (const r of (await db.query(`SELECT tenant_id, COUNT(*)::int AS n FROM tenant_channels WHERE channel IN ('messenger','instagram') GROUP BY tenant_id`)).rows) chans.set(r.tenant_id, N(r.n)); } catch (e) {}
    for (const t of bt.rows) {
      const ln = N(lines.get(t.id)), us = N(users.get(t.id)), ch = N(chans.get(t.id));
      const cobrados = Math.max(0, us - ln); // cada línea incluye 1 usuario
      out.lineas_n += ln; out.usuarios_facturables_n += us; out.usuarios_cobrados_n += cobrados; out.canales_n += ch;
      out.lineasBs += ln * N(t.pl) * P.tc;
      out.usuariosBs += cobrados * N(t.pu) * P.tc;
      out.canalesBs += ch * (N(t.pc) || defCh);
    }
    for (const k of ['lineasBs', 'usuariosBs', 'canalesBs']) out[k] = Math.round(out[k]);
  } catch (e) { /* best-effort */ }
  return out;
}

async function summary(months = 12, gran = 'month') {
  await ensureSchema();
  gran = ['day', 'week', 'month'].includes(String(gran)) ? String(gran) : 'month';
  const isMonth = gran === 'month';
  const F = gran === 'day' ? 'YYYY-MM-DD' : gran === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM';
  const maxN = gran === 'day' ? 92 : 26;
  const list = isMonth ? monthList(Math.min(Math.max(Number(months) || 12, 3), 24))
    : bucketList(Math.min(Math.max(Number(months) || 30, 7), maxN), gran);
  const P = await _pricing();
  const estructura = await currentStructure(P);

  // ── Ingresos (SOLO tenants facturables: trial/suspended/cancelled quedan FUERA — v0.9.560) ──
  const teoQr = isMonth ? await _byMonth(`SELECT q.period AS m, SUM(q.amount_bs) AS v FROM tenant_payment_qr q JOIN tenants ON tenants.id = q.tenant_id AND ${BILLABLE} GROUP BY q.period`) : new Map();
  const realQr = await _byMonth(`SELECT COALESCE(to_char(q.paid_at,'${F}'), q.period) AS m, SUM(q.amount_bs) AS v FROM tenant_payment_qr q JOIN tenants ON tenants.id = q.tenant_id WHERE q.status='paid' GROUP BY 1`);
  const teoSw = await _byMonth(`SELECT to_char(created_at,'${F}') AS m, SUM(amount) AS v FROM software_sales WHERE COALESCE(amount,0) > 0 GROUP BY 1`);
  const realSw = await _byMonth(`SELECT to_char(COALESCE(paid_at, created_at),'${F}') AS m, SUM(amount) AS v FROM software_sales WHERE status IN ('paid','provisioned') GROUP BY 1`);
  const realUsdt = await _byMonth(`SELECT to_char(created_at,'${F}') AS m, SUM(COALESCE((to_jsonb(usdt_payments)->>'amount_bs')::numeric, (to_jsonb(usdt_payments)->>'credited_bs')::numeric, 0)) AS v FROM usdt_payments WHERE COALESCE(to_jsonb(usdt_payments)->>'status','') IN ('credited','confirmed','paid') GROUP BY 1`);

  // ── Costos automáticos por uso real (total = todos los tenants; trial aparte como insight) ──
  const aiIn = await _byMonth(`SELECT to_char(created_at,'${F}') AS m, SUM(prompt_tokens) AS v FROM ai_usage GROUP BY 1`);
  const aiOut = await _byMonth(`SELECT to_char(created_at,'${F}') AS m, SUM(output_tokens) AS v FROM ai_usage GROUP BY 1`);
  const vozChars = await _byMonth(`SELECT to_char(created_at,'${F}') AS m, SUM(chars) AS v FROM voice_usage GROUP BY 1`);
  // v0.9.560 — desglose: uso de tenants FACTURABLES (refacturable como ingreso) vs trial (costo sin ingreso)
  const aiInB = await _byMonth(`SELECT to_char(u.created_at,'${F}') AS m, SUM(u.prompt_tokens) AS v FROM ai_usage u JOIN tenants ON tenants.id = u.tenant_id AND ${BILLABLE} GROUP BY 1`);
  const aiOutB = await _byMonth(`SELECT to_char(u.created_at,'${F}') AS m, SUM(u.output_tokens) AS v FROM ai_usage u JOIN tenants ON tenants.id = u.tenant_id AND ${BILLABLE} GROUP BY 1`);
  const vozB = await _byMonth(`SELECT to_char(u.created_at,'${F}') AS m, SUM(u.chars) AS v FROM voice_usage u JOIN tenants ON tenants.id = u.tenant_id AND ${BILLABLE} GROUP BY 1`);

  // ── v0.9.562 — series de crecimiento (acumulado por mes de alta) ──
  const cumT = await _byMonth(`SELECT to_char(created_at,'${F}') AS m, COUNT(*)::int AS v FROM tenants GROUP BY 1`);
  const cumL = await _byMonth(`SELECT to_char(COALESCE((to_jsonb(tenant_lines)->>'created_at')::timestamptz, NOW()),'${F}') AS m, COUNT(*)::int AS v FROM tenant_lines GROUP BY 1`);
  const cumU = await _byMonth(`SELECT to_char(COALESCE((to_jsonb(tenant_users)->>'created_at')::timestamptz, NOW()),'${F}') AS m, COUNT(*)::int AS v FROM tenant_users GROUP BY 1`);
  const cumC = await _byMonth(`SELECT to_char(COALESCE((to_jsonb(tenant_channels)->>'created_at')::timestamptz, NOW()),'${F}') AS m, COUNT(*)::int AS v FROM tenant_channels GROUP BY 1`);
  const cumUpTo = (map, m) => { let t = 0; for (const [k, v] of map) if (k <= m) t += v; return t; };

  // ── Costos manuales ──
  let costRows = [];
  try { costRows = (await db.query(`SELECT month, category, SUM(amount_bs) AS v FROM biz_costs GROUP BY month, category`)).rows; } catch (e) {}
  const manual = new Map(); // month → {cat: v}
  for (const r of costRows) {
    if (!manual.has(r.month)) manual.set(r.month, {});
    manual.get(r.month)[r.category] = N(r.v);
  }

  // ── Nómina ──
  let staff = [];
  try { staff = (await db.query(`SELECT * FROM biz_staff ORDER BY id`)).rows; } catch (e) {}
  const nominaDe = (m) => !isMonth ? 0 : staff.reduce((acc, s) => {
    if (s.start_month && s.start_month <= m && (!s.end_month || s.end_month >= m)) acc += N(s.salary_bs) * (N(s.load_factor) || 1.30);
    return acc;
  }, 0);

  // ── v0.9.563 — MÉTRICAS SAAS: pagos por tenant-mes (base = QR billing pagado; software
  // provisionado cuenta como pago del comprador nuevo). Movimientos de MRR mes contra mes.
  const payTM = new Map(); // tenant → Map(mes → Bs)
  try {
    const r = await db.query(`SELECT tenant_id, COALESCE(to_char(paid_at,'YYYY-MM'), period) AS m, SUM(amount_bs)::numeric AS v FROM tenant_payment_qr WHERE status='paid' GROUP BY 1,2`);
    for (const row of r.rows) { if (!payTM.has(row.tenant_id)) payTM.set(row.tenant_id, new Map()); payTM.get(row.tenant_id).set(row.m, N(row.v)); }
  } catch (e) {}
  const prevOf = (m) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 2, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
  const firstPay = new Map(); // tenant → primer mes pagado
  for (const [t, mm] of payTM) firstPay.set(t, [...mm.keys()].sort()[0]);
  const saasDe = (m) => {
    const pm = prevOf(m);
    let nuevo = 0, expansion = 0, contraccion = 0, churned = 0, base = 0, pagantes = 0, altas = 0;
    for (const [t, mm] of payTM) {
      const cur = N(mm.get(m)), prev = N(mm.get(pm));
      if (cur > 0) { base += cur; pagantes++; }
      if (cur > 0 && prev === 0) { if (firstPay.get(t) === m) { nuevo += cur; altas++; } else expansion += cur; }
      else if (cur > 0 && prev > 0) { if (cur > prev) expansion += cur - prev; else if (cur < prev) contraccion += prev - cur; }
      else if (cur === 0 && prev > 0) churned += prev;
    }
    return { nuevo: Math.round(nuevo), expansion: Math.round(expansion), contraccion: Math.round(contraccion), churned: Math.round(churned), mrr_base: Math.round(base), pagantes, altas };
  };
  // Cohortes: mes de primer pago → cuántos siguen pagando k meses después
  const cohortes = [];
  const cMonths = isMonth ? list.slice(-12) : [];
  for (const cm of cMonths) {
    const members = [...firstPay.entries()].filter(([, f]) => f === cm).map(([t]) => t);
    if (!members.length) continue;
    const ret = cMonths.filter((m2) => m2 >= cm).map((m2) => members.filter((t) => N(payTM.get(t).get(m2)) > 0).length);
    cohortes.push({ cohort: cm, size: members.length, ret });
  }

  const rows = list.map((m) => {
    const teorico = N(teoQr.get(m)) + N(teoSw.get(m));
    const realQ = N(realQr.get(m)), realS = N(realSw.get(m)), realU = N(realUsdt.get(m));
    const real = realQ + realS + realU;
    const iaBs = ((N(aiIn.get(m)) / 1e6) * P.gin + (N(aiOut.get(m)) / 1e6) * P.gout) * P.tc;
    const vozBs = (N(vozChars.get(m)) / 1000) * P.el1k * P.tc;
    const mc = (isMonth ? manual.get(m) : null) || {};
    const infra = N(mc.infra), mkt = N(mc.marketing), temp = N(mc.personal_temporal), com = N(mc.comisiones), iaX = N(mc.ia_extra), otros = N(mc.otros);
    const nomina = nominaDe(m);
    const directos = iaBs + vozBs + infra + iaX;
    const adquisicion = mkt + temp + com;
    const costosTot = directos + adquisicion + nomina + otros;
    const iaRefactBs = ((N(aiInB.get(m)) / 1e6) * P.gin + (N(aiOutB.get(m)) / 1e6) * P.gout) * P.tc;
    const vozRefactBs = (N(vozB.get(m)) / 1000) * P.el1k * P.tc;
    return {
      month: m,
      ingresos: {
        teorico: Math.round(teorico), teorico_qr: Math.round(N(teoQr.get(m))), teorico_software: Math.round(N(teoSw.get(m))), // v0.9.561 — separar fuentes
        real: Math.round(real), real_qr: Math.round(realQ), real_software: Math.round(realS), real_usdt: Math.round(realU),
        // v0.9.560 — desglose teórico del mes: fijo (estructura actual) + variable refacturable del mes
        detalle: { lineas: estructura.lineasBs, usuarios: estructura.usuariosBs, canales: estructura.canalesBs, ia: Math.round(iaRefactBs), voz: Math.round(vozRefactBs) },
      },
      costos: {
        ia: Math.round(iaBs), voz: Math.round(vozBs),
        ia_trial: Math.round(iaBs - iaRefactBs), voz_trial: Math.round(vozBs - vozRefactBs), // gastado en tenants NO facturables
        infra: Math.round(infra), ia_extra: Math.round(iaX), marketing: Math.round(mkt), personal_temporal: Math.round(temp), comisiones: Math.round(com), otros: Math.round(otros), nomina: Math.round(nomina), total: Math.round(costosTot),
      },
      bruto: Math.round(real - directos),
      neto: Math.round(real - costosTot),
      series: { tenants: cumUpTo(cumT, m), lineas: cumUpTo(cumL, m), usuarios: cumUpTo(cumU, m), canales: cumUpTo(cumC, m) }, // v0.9.562
      saas: !isMonth ? null : (() => { const s2 = saasDe(m); s2.cac = s2.altas > 0 ? Math.round(adquisicion / s2.altas) : 0; return s2; })(), // v0.9.563
    };
  });
  return { months: list.length, gran, pricing: { tc: P.tc }, estructura, cohortes, rows, staff_count: staff.filter(s => !s.end_month).length };
}

module.exports = { ensureSchema, summary };

// ============================================================
// v0.9.565 — CONVERSIÓN por origen (ads vs orgánico) y atención (bot vs humano)
// + métricas de COMENTARIOS (FB/IG): volumen, % respondidos, tiempo de respuesta.
// Pedido José 9-ago: los chats personales atendidos por humanos ensucian la
// conversión — acá se segmenta. Reusable por la reportería del tenant (?tenant_id).
// ============================================================
async function conversion(days = 30, tenantId = null) {
  const d = Math.min(Math.max(Number(days) || 30, 7), 180);
  const tFilter = tenantId ? `AND c.tenant_id = ${Number(tenantId)}` : '';
  const out = { days: d, segmentos: [], comments: null };
  try {
    const r = await db.query(`
      WITH convs AS (
        SELECT c.id,
               (COALESCE(to_jsonb(c)->>'ai_origin','') = 'ads' OR to_jsonb(c)->'referral' IS NOT NULL AND to_jsonb(c)->>'referral' IS NOT NULL) AS es_ads,
               EXISTS (SELECT 1 FROM messages mm WHERE mm.conversation_id = c.id AND mm.sender_type = 'bot') AS bot,
               COALESCE((to_jsonb(c)->>'score')::numeric, 0) >= 70 AS calificado
        FROM conversations c
        WHERE c.created_at > NOW() - ($1 || ' days')::interval ${tFilter})
      SELECT es_ads, bot, COUNT(*)::int AS convs, COUNT(*) FILTER (WHERE calificado)::int AS calificados
      FROM convs GROUP BY es_ads, bot`, [d]);
    const seg = (ads, bot) => r.rows.find((x) => x.es_ads === ads && x.bot === bot) || { convs: 0, calificados: 0 };
    const mk = (label, rows2) => {
      const convs = rows2.reduce((a, x) => a + N(x.convs), 0), cal = rows2.reduce((a, x) => a + N(x.calificados), 0);
      return { label, convs, calificados: cal, tasa: convs > 0 ? Math.round(100 * cal / convs) : 0 };
    };
    out.segmentos = [
      mk('Iniciadas por ADS', [seg(true, true), seg(true, false)]),
      mk('Orgánicas', [seg(false, true), seg(false, false)]),
      mk('Atendidas por el BOT', [seg(true, true), seg(false, true)]),
      mk('Solo humano (chats personales)', [seg(true, false), seg(false, false)]),
      mk('ADS + BOT (el embudo pagado real)', [seg(true, true)]),
    ];
  } catch (e) { /* best-effort */ }
  try {
    const c = await db.query(`
      SELECT channel, COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'dm_sent')::int AS respondidos,
             ROUND(AVG(EXTRACT(EPOCH FROM (replied_at - created_at)) / 60) FILTER (WHERE replied_at IS NOT NULL))::int AS avg_min,
             ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (replied_at - created_at)) / 60) FILTER (WHERE replied_at IS NOT NULL))::int AS p50_min
      FROM channel_comments WHERE created_at > NOW() - ($1 || ' days')::interval ${tenantId ? `AND tenant_id = ${Number(tenantId)}` : ''}
      GROUP BY channel`, [d]);
    out.comments = c.rows.map((x) => ({ channel: x.channel, total: N(x.total), respondidos: N(x.respondidos), pct: N(x.total) > 0 ? Math.round(100 * N(x.respondidos) / N(x.total)) : 0, avg_min: N(x.avg_min), p50_min: N(x.p50_min) }));
  } catch (e) { out.comments = []; }
  return out;
}
module.exports.conversion = conversion;
