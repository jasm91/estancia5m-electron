/**
 * Rutas admin de facturación v0.9.25 — para el panel super-admin v0.2.0
 *
 * Endpoints (todos detrás de requireAdmin / X-Admin-Token):
 *   GET   /api/admin/overview?period=YYYY-MM
 *   GET   /api/admin/billing?period=YYYY-MM
 *   GET   /api/admin/tenants/:id/billing?period=YYYY-MM
 *   POST  /api/admin/tenants/:id/payments   {period, concept, amount, method, note, line_id?}
 *   POST  /api/admin/tenants/:id/packs      {size, price, note, period?}
 *   PATCH /api/admin/tenants/:id/pricing    {price_per_line, price_per_user, setup_fee}
 *
 * Montaje en server.js (después de definir requireAdmin):
 *   require('./admin-billing-routes-v0925')(app, { requireAdmin });
 *
 * Requiere: migrate-billing-v0925.js corrido.
 *
 * Notas:
 *  - Detecta en runtime los nombres reales de columnas de tenant_lines /
 *    tenant_users y la fuente de "mensajes masivos" (campaign_messages,
 *    campaign_sends, campaigns, messages.campaign_id...). Si no encuentra
 *    ninguna, devuelve campaign_source:'none' y el panel muestra "—".
 *  - Los nombres de columna interpolados en SQL salen SIEMPRE de listas
 *    blancas internas (nunca del request).
 */

module.exports = function registerAdminBillingRoutes(app, opts = {}) {
  const db = opts.db || require('./db');
  const requireAdmin = opts.requireAdmin;
  if (!requireAdmin) throw new Error('admin-billing-routes: falta requireAdmin');
  // v0.9.105 — auth de tenant para el endpoint self-service /api/me/billing
  const requireTenantSession = opts.requireTenantSession || (() => {
    try { return require('./auth').requireTenantSession; } catch (_) { return null; }
  })();
  const r2 = require('./r2'); // v0.9.81: monitoreo de almacenamiento

  const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const CONCEPTS = ['monthly', 'setup', 'pack', 'other'];
  // v0.9.243 — nombre del mes en español a partir del período 'YYYY-MM' (para la descripción del QR).
  function _monthEs(period) {
    const M = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    return M[Math.max(0, Math.min(11, (parseInt(String(period).slice(5, 7), 10) || 1) - 1))];
  }

  // v0.9.272 — La lista de columnas/tablas con URLs de R2 vive en r2-refs.js (FUENTE ÚNICA).
  // La comparten: este endpoint /storage (atribución + huérfanos), /storage/purge-orphans, y el
  // cron de mantenimiento (storage-maintenance.js) → así el conteo y el borrado NO se desincronizan
  // (eso causó el bug v0.9.271 donde catálogos/chat/comprobantes se contaban como huérfanos).
  const { R2_URL_QUERIES } = require('./r2-refs');

  // ----------------------------------------------------------
  // Introspección de esquema (cacheada)
  // ----------------------------------------------------------
  let schemaCache = null;

  async function tableColumns(table) {
    const r = await db.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`, [table]);
    return r.rows.map(x => x.column_name);
  }

  function pick(cols, candidates) {
    for (const c of candidates) if (cols.includes(c)) return c;
    return null;
  }

  async function getSchema() {
    if (schemaCache) return schemaCache;
    const s = { lines: null, users: null, campaign: { source: 'none' } };

    // --- tenant_lines ---
    const lineCols = await tableColumns('tenant_lines');
    if (lineCols.length) {
      s.lines = {
        phone: pick(lineCols, ['phone_number', 'display_phone_number', 'phone', 'number']),
        display: pick(lineCols, ['display_name', 'verified_name', 'name', 'label']),
        pnid: pick(lineCols, ['phone_number_id', 'meta_phone_number_id']),
        active: pick(lineCols, ['active', 'enabled']),
        setupPaid: lineCols.includes('setup_paid') ? 'setup_paid' : null,
        created: pick(lineCols, ['created_at', 'connected_at']),
        excluded: pick(lineCols, ['billing_excluded']), // v0.9.525 — líneas no facturables
      };
    }

    // --- tenant_users ---
    const userCols = await tableColumns('tenant_users');
    if (userCols.length) {
      s.users = {
        email: pick(userCols, ['email', 'user_email']),
        name: pick(userCols, ['name', 'full_name', 'display_name']),
        role: pick(userCols, ['role']),
        active: pick(userCols, ['active', 'enabled']),
        created: pick(userCols, ['created_at']),
        excluded: pick(userCols, ['billing_excluded']), // v0.9.223 — usuarios no facturables (soporte)
      };
    }

    // --- fuente de mensajes masivos ---
    // sg-ventas: template_campaigns (v0.9.9) guarda el progreso por campaña
    // con contador `sent` — es la fuente preferida.
    {
      const cols = await tableColumns('template_campaigns');
      if (cols.includes('tenant_id') && cols.includes('sent') && cols.includes('created_at')) {
        s.campaign = {
          source: 'template_campaigns', kind: 'sum', table: 'template_campaigns',
          countCol: 'sent', dateCol: 'created_at',
        };
      }
    }
    if (s.campaign.source === 'none') for (const t of ['campaign_messages', 'campaign_sends']) {
      const cols = await tableColumns(t);
      if (cols.includes('tenant_id') && cols.includes('created_at')) {
        s.campaign = { source: t, kind: 'rows', table: t };
        break;
      }
    }
    if (s.campaign.source === 'none') {
      const cols = await tableColumns('campaigns');
      const cnt = pick(cols, ['sent_count', 'recipients_count', 'total_sent', 'sent']);
      if (cols.includes('tenant_id') && cnt && pick(cols, ['created_at', 'sent_at'])) {
        s.campaign = {
          source: 'campaigns', kind: 'sum', table: 'campaigns',
          countCol: cnt, dateCol: pick(cols, ['sent_at', 'created_at']),
        };
      }
    }
    if (s.campaign.source === 'none') {
      const cols = await tableColumns('messages');
      if (cols.includes('campaign_id')) {
        s.campaign = { source: 'messages.campaign_id', kind: 'messages_fk', table: 'messages' };
      } else if (cols.includes('is_campaign')) {
        s.campaign = { source: 'messages.is_campaign', kind: 'messages_flag', table: 'messages' };
      }
    }

    schemaCache = s;
    return s;
  }

  // ----------------------------------------------------------
  // Helpers de datos
  // ----------------------------------------------------------
  function validPeriod(p) {
    if (p && PERIOD_RE.test(p)) return p;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // Mapa tenant_id → mensajes masivos del período
  async function campaignCounts(period) {
    const s = await getSchema();
    const c = s.campaign;
    if (c.source === 'none') return { map: {}, source: 'none' };

    const start = `${period}-01`;
    let sql;
    if (c.kind === 'rows') {
      sql = `SELECT tenant_id, COUNT(*)::int AS n FROM ${c.table}
             WHERE created_at >= $1::date AND created_at < ($1::date + interval '1 month')
             GROUP BY tenant_id`;
    } else if (c.kind === 'sum') {
      sql = `SELECT tenant_id, COALESCE(SUM(${c.countCol}),0)::int AS n FROM ${c.table}
             WHERE ${c.dateCol} >= $1::date AND ${c.dateCol} < ($1::date + interval '1 month')
             GROUP BY tenant_id`;
    } else if (c.kind === 'messages_fk') {
      sql = `SELECT tenant_id, COUNT(*)::int AS n FROM messages
             WHERE campaign_id IS NOT NULL
               AND created_at >= $1::date AND created_at < ($1::date + interval '1 month')
             GROUP BY tenant_id`;
    } else {
      sql = `SELECT tenant_id, COUNT(*)::int AS n FROM messages
             WHERE is_campaign = TRUE
               AND created_at >= $1::date AND created_at < ($1::date + interval '1 month')
             GROUP BY tenant_id`;
    }
    const r = await db.query(sql, [start]);
    const map = {};
    for (const row of r.rows) map[row.tenant_id] = row.n;
    return { map, source: c.source };
  }

  // v0.9.25b: volumen de masivos para cobrar — comprados (packs) vs enviados.
  // Saldo ACUMULADO (los packs no vencen por mes): SUM(message_packs.size)
  // histórico menos enviados históricos. Negativo = excedente sin cobrar.
  async function campaignVolume(period) {
    const s = await getSchema();
    const out = {}; // tenant_id → { sent_period, sent_total, bought_total, bought_period, balance }

    // Comprados (packs)
    const bought = await db.query(`
      SELECT tenant_id,
             COALESCE(SUM(size), 0)::int AS bought_total,
             COALESCE(SUM(size) FILTER (
               WHERE created_at >= $1::date AND created_at < ($1::date + interval '1 month')
             ), 0)::int AS bought_period
      FROM message_packs
      GROUP BY tenant_id
    `, [`${period}-01`]);
    for (const r2 of bought.rows) {
      out[r2.tenant_id] = {
        sent_period: 0, sent_total: 0,
        bought_total: r2.bought_total, bought_period: r2.bought_period,
      };
    }

    // Enviados (misma fuente que campaignCounts)
    const c = s.campaign;
    if (c.source !== 'none') {
      let sql;
      if (c.kind === 'sum') {
        sql = `SELECT tenant_id,
                      COALESCE(SUM(${c.countCol}), 0)::int AS sent_total,
                      COALESCE(SUM(${c.countCol}) FILTER (
                        WHERE ${c.dateCol} >= $1::date AND ${c.dateCol} < ($1::date + interval '1 month')
                      ), 0)::int AS sent_period
               FROM ${c.table} GROUP BY tenant_id`;
      } else if (c.kind === 'rows') {
        sql = `SELECT tenant_id,
                      COUNT(*)::int AS sent_total,
                      COUNT(*) FILTER (
                        WHERE created_at >= $1::date AND created_at < ($1::date + interval '1 month')
                      )::int AS sent_period
               FROM ${c.table} GROUP BY tenant_id`;
      } else {
        const cond = c.kind === 'messages_fk' ? 'campaign_id IS NOT NULL' : 'is_campaign = TRUE';
        sql = `SELECT tenant_id,
                      COUNT(*)::int AS sent_total,
                      COUNT(*) FILTER (
                        WHERE created_at >= $1::date AND created_at < ($1::date + interval '1 month')
                      )::int AS sent_period
               FROM messages WHERE ${cond} GROUP BY tenant_id`;
      }
      const sent = await db.query(sql, [`${period}-01`]);
      for (const r2 of sent.rows) {
        if (!out[r2.tenant_id]) out[r2.tenant_id] = { bought_total: 0, bought_period: 0 };
        out[r2.tenant_id].sent_total = r2.sent_total;
        out[r2.tenant_id].sent_period = r2.sent_period;
      }
    }

    for (const id of Object.keys(out)) {
      const v = out[id];
      v.sent_total = v.sent_total || 0;
      v.sent_period = v.sent_period || 0;
      v.balance = v.bought_total - v.sent_total;
    }
    return { volumes: out, source: c.source };
  }

  // ----------------------------------------------------------
  // v0.9.151 — NUEVO MODELO DE BILLING: FIJO (Bs) + CONSUMO (USD)
  //   FIJO   = líneas×price_per_line + usuarios_excedentes×price_per_user
  //            + canales_adicionales×price_per_channel
  //   CONSUMO= tokens (ai_usage × tarifa Gemini × markup)
  //            + mensajes salientes (count × meta_cost_per_msg × markup)
  //   Moneda MIXTA a propósito: el FIJO va en Bs y el CONSUMO en USD.
  // ----------------------------------------------------------
  // Defaults si platform_pricing aún no tiene las columnas nuevas (pre-migración).
  const CONSUMPTION_DEFAULTS = {
    default_price_per_channel: 290,
    gemini_in_usd_per_m: 0.30,
    gemini_out_usd_per_m: 2.50,
    meta_cost_per_msg_usd: 0.05,
    consumption_markup: 1.20,
    elevenlabs_usd_per_1k_chars: 0.10, // v0.9.392 — notas de voz ElevenLabs (USD por 1.000 caracteres)
    usd_to_bs_rate: 9.73, // v0.9.266 — fallback si la tabla no tiene la tasa (TCO oficial BCB); el cron lo actualiza
  };

  // Lee las tarifas nuevas (canal Bs + tarifas USD + markup) de la fila id=1.
  // Tolera la tabla/columnas inexistentes (devuelve defaults) para no romper.
  async function readConsumptionConfig() {
    try {
      const r = await db.query(
        `SELECT default_price_per_channel, gemini_in_usd_per_m, gemini_out_usd_per_m,
                meta_cost_per_msg_usd, consumption_markup,
                (to_jsonb(platform_pricing) ->> 'elevenlabs_usd_per_1k_chars')::numeric AS elevenlabs_usd_per_1k_chars,
                (to_jsonb(platform_pricing) ->> 'usd_to_bs_rate')::numeric AS usd_to_bs_rate,
                (to_jsonb(platform_pricing) ->> 'usd_rate_date') AS usd_rate_date
           FROM platform_pricing WHERE id = 1`);
      if (!r.rows.length) return { ...CONSUMPTION_DEFAULTS };
      const row = r.rows[0];
      const num = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v));
      return {
        default_price_per_channel: num(row.default_price_per_channel, CONSUMPTION_DEFAULTS.default_price_per_channel),
        gemini_in_usd_per_m:       num(row.gemini_in_usd_per_m,       CONSUMPTION_DEFAULTS.gemini_in_usd_per_m),
        gemini_out_usd_per_m:      num(row.gemini_out_usd_per_m,      CONSUMPTION_DEFAULTS.gemini_out_usd_per_m),
        meta_cost_per_msg_usd:     num(row.meta_cost_per_msg_usd,     CONSUMPTION_DEFAULTS.meta_cost_per_msg_usd),
        consumption_markup:        num(row.consumption_markup,        CONSUMPTION_DEFAULTS.consumption_markup),
        elevenlabs_usd_per_1k_chars: num(row.elevenlabs_usd_per_1k_chars, CONSUMPTION_DEFAULTS.elevenlabs_usd_per_1k_chars),
        usd_to_bs_rate:            num(row.usd_to_bs_rate,            CONSUMPTION_DEFAULTS.usd_to_bs_rate),
        usd_rate_date:             row.usd_rate_date || null,
      };
    } catch (e) {
      // tabla/columna inexistente (migración no corrida) → defaults
      return { ...CONSUMPTION_DEFAULTS };
    }
  }

  // v0.9.266 — TASA USD→Bs: baja el TIPO DE CAMBIO OFICIAL (TCO) del dólar publicado por el BCB
  // y lo guarda en platform_pricing (id=1). Fuente: tco_reporte_ultima_cotizacion.php — el TCO es el
  // promedio ponderado de compra de los bancos, que es el "tipo de cambio oficial" de la portada del BCB.
  // (Antes se usaba valor_referencial_venta_svg.php.) Manda Referer (anti-hotlink). FAIL-SAFE: si falla,
  // NO toca la tasa guardada (se mantiene la última). El TCO viene en HTML → se quitan los tags antes de parsear.
  async function _fetchAndStoreBcbRate() {
    try {
      const resp = await fetch('https://www.bcb.gob.bo/tco_reporte_ultima_cotizacion.php', {
        headers: { 'Referer': 'https://www.bcb.gob.bo/', 'User-Agent': 'Mozilla/5.0 (compatible; SGVentasBot/1.0)' },
        signal: AbortSignal.timeout(15000),
      });
      const raw = await resp.text();
      const txt = raw.replace(/<[^>]+>/g, ' '); // quitar tags HTML para que el patrón matchee aunque el número venga envuelto
      const m = txt.match(/Bs\s*([0-9]{1,3}(?:[.,][0-9]{1,2})?)\s*\/\s*\$?\s*us/i);
      if (!m) { console.warn(`[bcb-rate] patrón "Bs X/$us" no encontrado (status ${resp.status}, len ${raw.length}) — se mantiene la última tasa`); return null; }
      const rate = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (!(rate > 0) || rate > 100) { console.warn(`[bcb-rate] valor fuera de rango: "${m[1]}" — ignorado`); return null; }
      // v0.9.267 — la fecha que se muestra es la de CONSULTA del dato (cuando el cron baja la tasa),
      // NO la "fecha de publicación" del BCB (que viene con días de atraso). En hora de Bolivia.
      let dateTxt;
      try { dateTxt = new Date().toLocaleDateString('es-BO', { timeZone: 'America/La_Paz', day: 'numeric', month: 'long', year: 'numeric' }); }
      catch (e) { dateTxt = new Date().toISOString().slice(0, 10); }
      await db.query(`UPDATE platform_pricing SET usd_to_bs_rate = $1, usd_rate_date = $2, usd_rate_updated_at = NOW() WHERE id = 1`, [rate, dateTxt]).catch(() => {});
      console.log(`💱 [bcb-rate] TCO oficial USD→Bs actualizado: ${rate} (BCB ${dateTxt || '?'})`);
      return rate;
    } catch (e) {
      console.warn('[bcb-rate] no se pudo actualizar (se mantiene la última tasa): ' + e.message);
      return null;
    }
  }
  // Refrescar al boot (a los 45s) y cada 12h. Tolerante a fallos.
  setTimeout(() => { _fetchAndStoreBcbRate().catch(() => {}); }, 45000);
  setInterval(() => { _fetchAndStoreBcbRate().catch(() => {}); }, 12 * 60 * 60 * 1000);

  // channels_count por tenant: canales ADICIONALES a WhatsApp (la línea base).
  //   +1 Messenger activo, +1 Instagram activo (tenant_channels), +1 si comments_enabled.
  // Devuelve { map: { tenant_id: n }, ok }. Tolera tablas/columnas inexistentes.
  async function channelsCountMap() {
    const map = {};
    // Messenger + Instagram activos en tenant_channels
    try {
      const r = await db.query(
        `SELECT tenant_id,
                COUNT(*) FILTER (WHERE channel = 'messenger') AS has_messenger,
                COUNT(*) FILTER (WHERE channel = 'instagram') AS has_instagram
           FROM tenant_channels
          WHERE active = TRUE
          GROUP BY tenant_id`);
      for (const row of r.rows) {
        const n = (Number(row.has_messenger) > 0 ? 1 : 0) + (Number(row.has_instagram) > 0 ? 1 : 0);
        map[row.tenant_id] = (map[row.tenant_id] || 0) + n;
      }
    } catch (e) { /* tabla tenant_channels inexistente → 0 */ }
    // +1 por comentarios habilitados
    try {
      const r = await db.query(`SELECT id FROM tenants WHERE comments_enabled = TRUE`);
      for (const row of r.rows) map[row.id] = (map[row.id] || 0) + 1;
    } catch (e) { /* columna comments_enabled inexistente → 0 */ }
    return map;
  }

  // CONSUMO USD del período por tenant: tokens (ai_usage) + mensajes salientes.
  // Devuelve { tokens: {id:usd}, messages: {id:usd}, countsOut: {id:n} }.
  async function consumptionUsdMaps(period, cfg) {
    const start = `${period}-01`;
    const tokens = {}, messages = {}, voice = {}, countsOut = {};
    const markup = Number(cfg.consumption_markup) || 1;

    // Tokens (ai_usage) → USD con tarifa Gemini in/out × markup
    try {
      // v0.9.274 — el consumo se cuenta SOLO desde la fecha de corte (billing_anchor_at): así el consumo
      // del período de trial NO se cobra. Para las cuentas viejas (anchor = created_at) no cambia nada.
      const r = await db.query(
        `SELECT au.tenant_id,
                COALESCE(SUM(au.prompt_tokens), 0)::bigint AS in_tok,
                COALESCE(SUM(au.output_tokens), 0)::bigint AS out_tok
           FROM ai_usage au
           JOIN tenants t ON t.id = au.tenant_id
          WHERE au.created_at >= $1::date AND au.created_at < ($1::date + interval '1 month')
            AND au.created_at >= COALESCE(t.billing_anchor_at, '-infinity'::timestamptz)
          GROUP BY au.tenant_id`, [start]);
      for (const row of r.rows) {
        const costUsd = (Number(row.in_tok) / 1e6) * Number(cfg.gemini_in_usd_per_m)
                      + (Number(row.out_tok) / 1e6) * Number(cfg.gemini_out_usd_per_m);
        tokens[row.tenant_id] = costUsd * markup;
      }
    } catch (e) { /* tabla ai_usage inexistente → 0 */ }

    // v0.9.152 — "mensajes salientes" = mensajes de CAMPAÑA / PLANTILLAS (lo que Meta
    // cobra), NO las respuestas normales del bot en conversación. Reutilizamos el
    // contador de campañas (template_campaigns.sent + fallbacks) por tenant y período.
    try {
      const { map: campMap } = await campaignCounts(period);
      for (const tid of Object.keys(campMap || {})) {
        const n = Number(campMap[tid]) || 0;
        countsOut[tid] = n;
        messages[tid] = n * Number(cfg.meta_cost_per_msg_usd) * markup;
      }
    } catch (e) { /* sin fuente de campañas → 0 */ }

    // v0.9.392 — ElevenLabs (voice_usage): caracteres × tarifa/1.000 × markup. Respeta billing_anchor_at (trial no se cobra).
    try {
      const r = await db.query(
        `SELECT vu.tenant_id, COALESCE(SUM(vu.chars), 0)::bigint AS chars
           FROM voice_usage vu
           JOIN tenants t ON t.id = vu.tenant_id
          WHERE vu.created_at >= $1::date AND vu.created_at < ($1::date + interval '1 month')
            AND vu.created_at >= COALESCE(t.billing_anchor_at, '-infinity'::timestamptz)
          GROUP BY vu.tenant_id`, [start]);
      for (const row of r.rows) {
        voice[row.tenant_id] = (Number(row.chars) / 1000) * Number(cfg.elevenlabs_usd_per_1k_chars) * markup;
      }
    } catch (e) { /* tabla voice_usage inexistente → 0 */ }

    return { tokens, messages, voice, countsOut };
  }

  // v0.9.275 — variante de campaignCounts para UN tenant DESDE una fecha (sin tope superior). Para el variable "desde el cursor".
  async function campaignCountSince(tenantId, since) {
    const s = await getSchema();
    const c = s.campaign;
    if (!c || c.source === 'none') return 0;
    let sql;
    if (c.kind === 'rows') {
      sql = `SELECT COUNT(*)::int AS n FROM ${c.table} WHERE tenant_id = $1 AND created_at >= $2`;
    } else if (c.kind === 'sum') {
      sql = `SELECT COALESCE(SUM(${c.countCol}),0)::int AS n FROM ${c.table} WHERE tenant_id = $1 AND ${c.dateCol} >= $2`;
    } else if (c.kind === 'messages_fk') {
      sql = `SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id = $1 AND campaign_id IS NOT NULL AND created_at >= $2`;
    } else {
      sql = `SELECT COUNT(*)::int AS n FROM messages WHERE tenant_id = $1 AND is_campaign = TRUE AND created_at >= $2`;
    }
    try { const r = await db.query(sql, [tenantId, since]); return Number(r.rows[0].n) || 0; } catch (_) { return 0; }
  }

  // v0.9.275 — consumo VARIABLE (Bs + USD) de un tenant DESDE una fecha (tokens Gemini + mensajes de campaña),
  // con markup. Es lo que el modelo nuevo cobra: el variable se cuenta desde el cursor last_variable_billed_at.
  async function consumptionSinceBs(tenantId, since, cfg) {
    const rate = Number(cfg.usd_to_bs_rate) || 0;
    const markup = Number(cfg.consumption_markup) || 1;
    let tokensUsd = 0, messagesUsd = 0, voiceUsd = 0;
    try {
      const r = await db.query(
        `SELECT COALESCE(SUM(prompt_tokens),0)::bigint AS in_tok, COALESCE(SUM(output_tokens),0)::bigint AS out_tok
           FROM ai_usage WHERE tenant_id = $1 AND created_at >= $2`, [tenantId, since]);
      tokensUsd = (Number(r.rows[0].in_tok) / 1e6) * Number(cfg.gemini_in_usd_per_m)
                + (Number(r.rows[0].out_tok) / 1e6) * Number(cfg.gemini_out_usd_per_m);
    } catch (_) {}
    try { const n = await campaignCountSince(tenantId, since); messagesUsd = n * Number(cfg.meta_cost_per_msg_usd); } catch (_) {}
    // v0.9.392 — ElevenLabs (voice_usage): caracteres × tarifa/1.000
    try {
      const vr = await db.query(`SELECT COALESCE(SUM(chars),0)::bigint AS chars FROM voice_usage WHERE tenant_id = $1 AND created_at >= $2`, [tenantId, since]);
      voiceUsd = (Number(vr.rows[0].chars) / 1000) * Number(cfg.elevenlabs_usd_per_1k_chars);
    } catch (_) {}
    tokensUsd *= markup; messagesUsd *= markup; voiceUsd *= markup;
    const usd = tokensUsd + messagesUsd + voiceUsd;
    return { usd, bs: usd * rate, tokensUsd, messagesUsd, voiceUsd };
  }

  // Filas de facturación por tenant para un período
  async function billingRows(period) {
    const s = await getSchema();
    const linesActive = s.lines && s.lines.active ? `WHERE tl.${s.lines.active} = TRUE` : '';
    const usersActive = s.users && s.users.active ? `WHERE tu.${s.users.active} = TRUE` : '';
    // v0.9.525 — líneas NO facturables (billing_excluded): no se cobra su price_per_line
    // ni su setup. El CUPO de usuarios (lines_count) sigue contando TODAS las líneas
    // activas para no subir el cobro de usuarios sin querer.
    const linesExclClause = s.lines && s.lines.excluded ? ` AND COALESCE(tl.${s.lines.excluded}, FALSE) = FALSE` : '';
    const setupPaidExpr = s.lines && s.lines.setupPaid
      ? `(SELECT COUNT(*)::int FROM tenant_lines tl WHERE tl.tenant_id = t.id AND tl.setup_paid = FALSE${linesExclClause})`
      : `0`;
    const linesCountExpr = s.lines
      ? `(SELECT COUNT(*)::int FROM tenant_lines tl ${linesActive ? linesActive + ' AND' : 'WHERE'} tl.tenant_id = t.id)`
      : `0`;
    const billableLinesExpr = s.lines
      ? `(SELECT COUNT(*)::int FROM tenant_lines tl ${linesActive ? linesActive + ' AND' : 'WHERE'} tl.tenant_id = t.id${linesExclClause})`
      : `0`;
    const usersCountExpr = s.users
      ? `(SELECT COUNT(*)::int FROM tenant_users tu ${usersActive ? usersActive + ' AND' : 'WHERE'} tu.tenant_id = t.id)`
      : `0`;
    // v0.9.223 — usuarios FACTURABLES = activos que NO están marcados billing_excluded.
    const usersExclClause = s.users && s.users.excluded ? ` AND COALESCE(tu.${s.users.excluded}, FALSE) = FALSE` : '';
    const billableUsersExpr = s.users
      ? `(SELECT COUNT(*)::int FROM tenant_users tu ${usersActive ? usersActive + ' AND' : 'WHERE'} tu.tenant_id = t.id${usersExclClause})`
      : `0`;

    // v0.9.151 — price_per_channel (override por tenant) + comments_enabled.
    // Tolerantes a columnas no migradas vía to_jsonb (evita romper si falta).
    const r = await db.query(`
      SELECT
        t.id AS tenant_id, t.slug, t.name, t.active, t.billing_status, t.created_at, t.meta_health,
        t.price_per_line, t.price_per_user, t.setup_fee, t.messages_unlimited,
        (to_jsonb(t) ->> 'price_per_channel')::numeric AS price_per_channel,
        COALESCE((to_jsonb(t) ->> 'comments_enabled')::boolean, FALSE) AS comments_enabled,
        ${linesCountExpr} AS lines_count,
        ${billableLinesExpr} AS billable_lines_count,
        ${usersCountExpr} AS users_count,
        ${billableUsersExpr} AS billable_users_count,
        ${setupPaidExpr} AS setups_pending,
        COALESCE((
          SELECT SUM(bp.amount) FROM billing_payments bp
          WHERE bp.tenant_id = t.id AND bp.period = $1 AND bp.concept = 'monthly'
        ), 0)::numeric AS monthly_paid
      FROM tenants t
      ORDER BY t.id
    `, [period]);

    // v0.9.151 — config de consumo + canales + consumo USD del período
    const cfg = await readConsumptionConfig();
    const chMap = await channelsCountMap();
    const { tokens: tokMap, messages: msgMap, voice: voiceMap } = await consumptionUsdMaps(period, cfg);

    return r.rows.map(row => {
      // v0.9.119 — cada LÍNEA (price_per_line) incluye 1 usuario; se cobran solo
      // los usuarios que EXCEDEN la cantidad de líneas (a price_per_user c/u).
      // v0.9.223 — solo se cobran los usuarios FACTURABLES (excluye los billing_excluded) que exceden las líneas.
      const billableUsers = Math.max(0, Number(row.billable_users_count ?? row.users_count) - Number(row.lines_count));
      // v0.9.525 — el cargo por línea usa SOLO las líneas facturables (no las excluidas).
      const billableLines = Number(row.billable_lines_count ?? row.lines_count);
      // v0.9.151 — canales adicionales × precio por canal (override por tenant → default global)
      const pricePerChannel = row.price_per_channel != null
        ? Number(row.price_per_channel) : Number(cfg.default_price_per_channel);
      const channelsCount = Number(chMap[row.tenant_id] || 0);
      const channelsBs = channelsCount * pricePerChannel;
      // FIJO (Bs)
      const expected = billableLines * Number(row.price_per_line)
                     + billableUsers * Number(row.price_per_user)
                     + channelsBs;
      // CONSUMO (USD)
      const tokensUsd = Number(tokMap[row.tenant_id] || 0);
      const messagesUsd = Number(msgMap[row.tenant_id] || 0);
      const voiceUsd = Number(voiceMap[row.tenant_id] || 0);
      const consumptionUsd = tokensUsd + messagesUsd + voiceUsd;
      const paid = Number(row.monthly_paid);
      const pending = Math.max(0, expected - paid);
      let payment_status = 'na';
      if (expected > 0) {
        payment_status = paid >= expected ? 'paid' : (paid > 0 ? 'partial' : 'pending');
      }
      return {
        ...row,
        lines_count: Number(row.lines_count),
        billable_lines_count: billableLines,
        users_count: Number(row.users_count),
        billable_users: billableUsers,
        setups_pending: Number(row.setups_pending),
        price_per_line: Number(row.price_per_line),
        price_per_user: Number(row.price_per_user),
        setup_fee: Number(row.setup_fee),
        // v0.9.151 — nuevos campos (aditivos; no rompen UI existente)
        price_per_channel: pricePerChannel,
        channels_count: channelsCount,
        channels_bs: channelsBs,
        tokens_usd: tokensUsd,
        messages_usd: messagesUsd,
        voice_usd: voiceUsd,                  // v0.9.392 — ElevenLabs
        monthly_expected_bs: expected,        // = FIJO total en Bs
        monthly_expected_usd: consumptionUsd, // = CONSUMO total en USD
        monthly_expected: expected,           // backward-compat: total FIJO en Bs
        monthly_paid: paid,
        pending,
        payment_status,
      };
    });
  }

  // ----------------------------------------------------------
  // GET /api/admin/overview
  // ----------------------------------------------------------
  app.get('/api/admin/overview', requireAdmin, async (req, res) => {
    try {
      const period = validPeriod(req.query.period);
      const s = await getSchema();
      const rows = await billingRows(period);
      const { map: cMap, source } = await campaignCounts(period);

      // last_message_at por tenant (mismo criterio que la lista existente)
      const lm = await db.query(`
        SELECT t.id, MAX(m.created_at) AS last_message_at
        FROM tenants t
        LEFT JOIN conversations c ON c.tenant_id = t.id
        LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY t.id
      `);
      const lmMap = {};
      for (const r2 of lm.rows) lmMap[r2.id] = r2.last_message_at;

      // usuarios por rol (global)
      let usersByRole = { owner: 0, supervisor: 0, agent: 0 };
      let usersActiveTotal = 0;
      if (s.users) {
        const activeFilter = s.users.active ? `WHERE ${s.users.active} = TRUE` : '';
        const ur = await db.query(`
          SELECT ${s.users.role ? s.users.role : `'agent'`} AS role, COUNT(*)::int AS n
          FROM tenant_users ${activeFilter} GROUP BY 1
        `);
        for (const r2 of ur.rows) {
          usersByRole[r2.role] = (usersByRole[r2.role] || 0) + r2.n;
          usersActiveTotal += r2.n;
        }
      }

      const tenants = rows.map(r2 => ({
        id: r2.tenant_id,
        slug: r2.slug,
        name: r2.name,
        active: r2.active,
        billing_status: r2.billing_status,
        lines_count: r2.lines_count,
        users_count: r2.users_count,
        monthly_expected: r2.monthly_expected,
        monthly_paid: r2.monthly_paid,
        payment_status: r2.payment_status,
        setups_pending: r2.setups_pending,
        campaign_msgs: cMap[r2.tenant_id] || 0,
        last_message_at: lmMap[r2.tenant_id] || null,
        // v0.9.151 — billing FIJO (Bs) + CONSUMO (USD)
        channels_count: r2.channels_count,
        channels_bs: r2.channels_bs,
        tokens_usd: r2.tokens_usd,
        messages_usd: r2.messages_usd,
        voice_usd: r2.voice_usd,       // v0.9.392 — ElevenLabs
        monthly_expected_bs: r2.monthly_expected_bs,
        monthly_expected_usd: r2.monthly_expected_usd,
        created_at: r2.created_at,     // columna "Alta" (fecha de alta) del dashboard
        meta_health: r2.meta_health,   // v0.9.276 — estado real de la línea Meta (dot en el dashboard)
      }));

      const activeRows = rows.filter(r2 => r2.active);
      const kpis = {
        tenants_total: rows.length,
        tenants_active: activeRows.length,
        lines_active: rows.reduce((a, r2) => a + r2.lines_count, 0),
        users_active: usersActiveTotal || rows.reduce((a, r2) => a + r2.users_count, 0),
        users_by_role: usersByRole,
        campaign_msgs: Object.values(cMap).reduce((a, n) => a + n, 0),
        mrr_expected: activeRows.reduce((a, r2) => a + r2.monthly_expected, 0),
        expected_total: rows.reduce((a, r2) => a + r2.monthly_expected, 0),
        paid_total: rows.reduce((a, r2) => a + r2.monthly_paid, 0),
        pending_total: rows.reduce((a, r2) => a + r2.pending, 0),
        setups_pending: rows.reduce((a, r2) => a + r2.setups_pending, 0),
      };

      res.json({ ok: true, period, campaign_source: source, kpis, tenants });
    } catch (e) {
      console.error('overview:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // GET /api/admin/billing
  // ----------------------------------------------------------
  app.get('/api/admin/billing', requireAdmin, async (req, res) => {
    try {
      const period = validPeriod(req.query.period);
      const rows = await billingRows(period);

      // v0.9.25b: volumen de masivos (comprados vs enviados) por tenant
      const { volumes, source: campaignSource } = await campaignVolume(period);
      const empty = { sent_period: 0, sent_total: 0, bought_total: 0, bought_period: 0, balance: 0 };
      for (const r2 of rows) {
        const v = volumes[r2.tenant_id] || empty;
        r2.campaign_sent_period = v.sent_period;
        r2.campaign_sent_total = v.sent_total;
        r2.packs_bought_total = v.bought_total;
        r2.campaign_balance = v.balance;
      }

      const totals = {
        expected: rows.reduce((a, r2) => a + r2.monthly_expected, 0),
        paid: rows.reduce((a, r2) => a + r2.monthly_paid, 0),
        pending: rows.reduce((a, r2) => a + r2.pending, 0),
        setups_pending: rows.reduce((a, r2) => a + r2.setups_pending, 0),
        setups_pending_amount: rows.reduce((a, r2) => a + r2.setups_pending * r2.setup_fee, 0),
        campaign_sent_period: rows.reduce((a, r2) => a + (r2.campaign_sent_period || 0), 0),
        campaign_overage: rows.reduce((a, r2) => a + Math.max(0, -(r2.campaign_balance || 0)), 0),
        // v0.9.151 — totales del nuevo modelo (Bs FIJO + USD CONSUMO)
        channels_bs: rows.reduce((a, r2) => a + (r2.channels_bs || 0), 0),
        tokens_usd: rows.reduce((a, r2) => a + (r2.tokens_usd || 0), 0),
        messages_usd: rows.reduce((a, r2) => a + (r2.messages_usd || 0), 0),
        voice_usd: rows.reduce((a, r2) => a + (r2.voice_usd || 0), 0), // v0.9.392 — ElevenLabs
        expected_bs: rows.reduce((a, r2) => a + (r2.monthly_expected_bs || 0), 0),
        expected_usd: rows.reduce((a, r2) => a + (r2.monthly_expected_usd || 0), 0),
      };
      res.json({ ok: true, period, totals, rows, campaign_source: campaignSource });
    } catch (e) {
      console.error('billing:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // GET /api/admin/tenants/:id/billing
  // ----------------------------------------------------------
  // v0.9.268 — DEUDA ACUMULADA (mes a mes). Suma el saldo de cada mes FACTURABLE (fijo + consumo − pagado)
  // desde el alta del tenant hasta el período actual, EXCLUYENDO los meses saldados (billing_settlements).
  // Tenants NO facturables (trial/suspended/cancelled) NO acumulan: devuelve SOLO el saldo del mes actual
  // (= comportamiento de hoy → cambio cero para los trials). El fijo histórico se aproxima con el fijo actual.
  // v0.9.274 — anchorAt = fecha de corte (billing_anchor_at): es el ancla de acumulación + la base de la
  // proración del primer mes. createdAt queda solo para detectar si el corte viene de un TRIAL
  // (anchorAt > createdAt → prorratea el mes del corte). Para las cuentas viejas (anchorAt == createdAt,
  // backfill) NO prorratea y el ancla es la misma de siempre → su cobro NO cambia.

  // v0.9.274 — DESCUENTO POR REFERIDOS: cada crédito 'earned' = 10% del FIJO; acumulativo, tope 100%.
  async function _referralDiscount(tenantId, fijoBs) {
    let credits = 0;
    try {
      const r = await db.query(`SELECT COUNT(*)::int AS n FROM referral_credits WHERE referrer_tenant_id = $1 AND status = 'earned'`, [tenantId]);
      credits = r.rows[0].n || 0;
    } catch (e) { /* tabla sin migrar → sin descuento */ }
    const pct = Math.min(credits * 10, 100);
    const discountBs = Math.max(0, (Number(fijoBs) || 0) * pct / 100);
    return { credits, pct, discountBs };
  }

  // v0.9.274 — consume créditos de referido para un período (idempotente por período). Hasta 10 'earned'
  // pasan a 'applied' (el resto rueda). Si materialize=true, además graba el descuento como abono
  // "Descuento referido" para que el período PAGADO cierre exacto y NO se vuelva a descontar el mes
  // siguiente. Al SALDAR no hace falta materializar (el settlement ya pone el mes en 0).
  async function _consumeReferralCredits(tenantId, period, materialize) {
    try {
      const already = await db.query(`SELECT 1 FROM referral_credits WHERE referrer_tenant_id = $1 AND applied_period = $2 LIMIT 1`, [tenantId, period]);
      if (already.rows.length) return 0;
      const ec = await db.query(`SELECT COUNT(*)::int AS n FROM referral_credits WHERE referrer_tenant_id = $1 AND status = 'earned'`, [tenantId]);
      const earned = ec.rows[0].n || 0;
      if (!earned) return 0;
      const consume = Math.min(earned, 10);
      if (materialize) {
        let fijo = 0; try { fijo = await _monthlyExpectedBs(tenantId); } catch (_) {}
        const pct = Math.min(consume * 10, 100);
        const discountBs = Math.round((Number(fijo) || 0) * pct / 100 * 100) / 100;
        if (discountBs > 0) {
          await db.query(
            `INSERT INTO billing_payments (tenant_id, period, concept, amount, method, note) VALUES ($1, $2, 'monthly', $3, 'Descuento referido', $4)`,
            [tenantId, period, discountBs, `${consume} referido(s) × 10% del fijo`]).catch((e) => console.warn('[referidos] abono:', e.message));
        }
      }
      const up = await db.query(
        `UPDATE referral_credits SET status = 'applied', applied_period = $2
          WHERE id IN (SELECT id FROM referral_credits WHERE referrer_tenant_id = $1 AND status = 'earned' ORDER BY created_at ASC LIMIT 10)`,
        [tenantId, period]);
      if (up.rowCount) console.log(`🎁 [referidos] tenant ${tenantId}: ${up.rowCount} crédito(s) consumidos en ${period}`);
      return up.rowCount;
    } catch (e) { console.warn('[referidos] consumir:', e.message); return 0; }
  }

  // v0.9.275 — al PAGAR EL TOTAL adeudado: (1) saldar el fijo de los meses no saldados (anchor → actual),
  // (2) avanzar el cursor del VARIABLE a NOW() → el consumo se cuenta de cero para la próxima factura,
  // (3) consumir créditos de referido. Deja el "A pagar" en 0 limpio. Lo llaman _creditPayment/_creditBanecoQr.
  async function _closeBillingPeriod(tenantId, currentPeriod) {
    try {
      const tr = await db.query(`SELECT billing_anchor_at, created_at FROM tenants WHERE id = $1`, [tenantId]);
      const anchor = tr.rows[0] && (tr.rows[0].billing_anchor_at || tr.rows[0].created_at);
      const anchorD = anchor ? new Date(anchor) : null;
      if (anchorD && !isNaN(anchorD.getTime())) {
        const [cy, cm] = currentPeriod.split('-').map(Number);
        let y = anchorD.getFullYear(), m = anchorD.getMonth() + 1;
        for (let i = 0; i < 120; i++) {
          const per = `${y}-${String(m).padStart(2, '0')}`;
          await db.query(`INSERT INTO billing_settlements (tenant_id, period, note) VALUES ($1, $2, 'pago completo') ON CONFLICT (tenant_id, period) DO NOTHING`, [tenantId, per]).catch(() => {});
          if (y > cy || (y === cy && m >= cm)) break; // hasta el mes actual inclusive
          m++; if (m > 12) { m = 1; y++; }
        }
      }
      await db.query(`UPDATE tenants SET last_variable_billed_at = NOW() WHERE id = $1`, [tenantId]).catch(() => {});
      await _consumeReferralCredits(tenantId, currentPeriod, false); // settle ya pone el fijo en 0 → sin materializar
      console.log(`🧾 [billing] período cerrado por pago total — tenant ${tenantId} · cursor variable → ahora`);
    } catch (e) { console.warn('[billing] cerrar período:', e.message); }
  }

  async function _accumulatedDebtBs(tenantId, currentPeriod, fijoBs, cfg, billable, anchorAt, createdAt) {
    const rate = Number(cfg.usd_to_bs_rate) || 0;
    let settledSet = new Set();
    try {
      const sr = await db.query(`SELECT period FROM billing_settlements WHERE tenant_id = $1`, [tenantId]);
      settledSet = new Set(sr.rows.map(r => r.period));
    } catch (e) { /* tabla sin migrar → nada saldado */ }
    const anchorDate = anchorAt ? new Date(anchorAt) : (createdAt ? new Date(createdAt) : null);
    const createdDate = createdAt ? new Date(createdAt) : null;
    // Proración SOLO en el mes del corte y SOLO si el corte es posterior al alta (= vino de un trial).
    const proratesCutoff = anchorDate && createdDate && !isNaN(anchorDate.getTime())
      && anchorDate.getTime() > createdDate.getTime();
    const anchorYM = (anchorDate && !isNaN(anchorDate.getTime()))
      ? `${anchorDate.getFullYear()}-${String(anchorDate.getMonth() + 1).padStart(2, '0')}` : null;
    // v0.9.275 — FIJO por mes (SIN consumo): cada mes no saldado aporta max(0, fijoDelMes − pagos del mes).
    const monthFijo = async (period) => {
      if (settledSet.has(period)) return 0;
      if (anchorYM && period < anchorYM) return 0; // un mes anterior al corte/alta no se factura
      let fijoForMonth = Number(fijoBs);
      if (proratesCutoff && period === anchorYM) {
        const daysInMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth() + 1, 0).getDate();
        const billedDays = Math.max(0, daysInMonth - anchorDate.getDate() + 1); // del día del corte a fin de mes
        fijoForMonth = fijoForMonth * (billedDays / daysInMonth);
      }
      const pr = await db.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM billing_payments
         WHERE tenant_id = $1 AND period = $2 AND concept = 'monthly'`, [tenantId, period]);
      return Math.max(0, fijoForMonth - Number(pr.rows[0].paid));
    };
    let fijoTotal = await monthFijo(currentPeriod);
    if (billable && anchorDate && !isNaN(anchorDate.getTime())) {
      const [cy, cm] = currentPeriod.split('-').map(Number); // cm 1-based
      let y = anchorDate.getFullYear(), m = anchorDate.getMonth() + 1; // m 1-based
      for (let i = 0; i < 120; i++) {
        if (y > cy || (y === cy && m >= cm)) break; // hasta el mes ANTERIOR al actual (el actual ya se contó)
        fijoTotal += await monthFijo(`${y}-${String(m).padStart(2, '0')}`);
        m++; if (m > 12) { m = 1; y++; }
      }
    }
    // v0.9.275 — VARIABLE: consumo (Bs) DESDE el cursor last_variable_billed_at, contado UNA sola vez (no por
    // mes). El cursor avanza al pagar el total → un pago full resetea el variable; sin "mes que se reabre".
    let variableBs = 0;
    try {
      const cr = await db.query(`SELECT last_variable_billed_at, billing_anchor_at, created_at FROM tenants WHERE id = $1`, [tenantId]);
      const since = cr.rows[0] && (cr.rows[0].last_variable_billed_at || cr.rows[0].billing_anchor_at || cr.rows[0].created_at);
      if (since) { const _c = await consumptionSinceBs(tenantId, since, cfg); variableBs = _c.bs; }
    } catch (_) {}
    let total = fijoTotal + variableBs;
    // v0.9.274 — descuento por referidos: 10% del fijo por crédito 'earned' (acumulativo, tope 100%), sobre el
    // FIJO, restado del total (nunca negativo). En el MISMO lugar que el QR → display == cobro.
    if (billable) {
      try { const { discountBs } = await _referralDiscount(tenantId, fijoBs); total = Math.max(0, total - discountBs); } catch (e) {}
    }
    return Math.max(0, total);
  }

  app.get('/api/admin/tenants/:id/billing', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const period = validPeriod(req.query.period);
      const s = await getSchema();

      const tr = await db.query(
        `SELECT id, name, price_per_line, price_per_user, setup_fee, messages_unlimited, created_at,
                (to_jsonb(tenants) ->> 'billing_status') AS billing_status,
                (to_jsonb(tenants) ->> 'billing_anchor_at')::timestamptz AS billing_anchor_at,
                (to_jsonb(tenants) ->> 'referral_code') AS referral_code,
                (to_jsonb(tenants) ->> 'referred_by_tenant_id')::int AS referred_by_tenant_id,
                (to_jsonb(tenants) ->> 'price_per_channel')::numeric AS price_per_channel,
                COALESCE((to_jsonb(tenants) ->> 'billing_currency'), 'BOB') AS billing_currency,
                COALESCE((to_jsonb(tenants) ->> 'comments_enabled')::boolean, FALSE) AS comments_enabled,
                COALESCE((to_jsonb(tenants) ->> 'comment_public_reply_enabled')::boolean, FALSE) AS comment_public_reply_enabled,
                (to_jsonb(tenants) ->> 'comment_public_reply_text') AS comment_public_reply_text,
                COALESCE(NULLIF(to_jsonb(tenants) ->> 'comment_public_reply_mode',''),'ai') AS comment_public_reply_mode
           FROM tenants WHERE id = $1`, [id]);
      if (tr.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
      const t = tr.rows[0];

      // Líneas
      let lines = [];
      if (s.lines) {
        const L = s.lines;
        const sel = [
          'id',
          L.phone ? `${L.phone} AS phone_number` : `NULL AS phone_number`,
          L.display ? `${L.display} AS display_name` : `NULL AS display_name`,
          L.pnid ? `${L.pnid} AS phone_number_id` : `NULL AS phone_number_id`,
          L.setupPaid ? `${L.setupPaid} AS setup_paid` : `TRUE AS setup_paid`,
          L.active ? `COALESCE(${L.active}, TRUE) AS active` : `TRUE AS active`,
          L.created ? `${L.created} AS created_at` : `NULL AS created_at`,
          L.excluded ? `COALESCE(${L.excluded}, FALSE) AS billing_excluded` : `FALSE AS billing_excluded`, // v0.9.525
        ].join(', ');
        const lr = await db.query(`SELECT ${sel} FROM tenant_lines WHERE tenant_id = $1 ORDER BY id`, [id]);
        lines = lr.rows;
      }

      // Usuarios
      let users = [];
      if (s.users) {
        const U = s.users;
        const sel = [
          'id',
          U.email ? `${U.email} AS email` : `NULL AS email`,
          U.name ? `${U.name} AS name` : `NULL AS name`,
          U.role ? `${U.role} AS role` : `NULL AS role`,
          U.created ? `${U.created} AS created_at` : `NULL AS created_at`,
          U.excluded ? `COALESCE(${U.excluded}, FALSE) AS billing_excluded` : `FALSE AS billing_excluded`, // v0.9.223
          `COALESCE((to_jsonb(tenant_users) ->> 'hidden_from_tenant')::boolean, FALSE) AS hidden_from_tenant`, // v0.9.226
        ].join(', ');
        const ur = await db.query(`SELECT ${sel} FROM tenant_users WHERE tenant_id = $1 ORDER BY id`, [id]);
        users = ur.rows;
      }

      // Pagos y packs
      const pr = await db.query(
        `SELECT id, period, concept, amount, method, note, line_id, created_at,
                (to_jsonb(billing_payments) ->> 'receipt_url') AS receipt_url
         FROM billing_payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]);
      const kr = await db.query(
        `SELECT id, size, price, note, created_at
         FROM message_packs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 30`, [id]);

      // Breakdown del período
      const linesCount = s.lines && s.lines.active
        ? lines.filter(l => l[s.lines.active] !== false).length
        : lines.length;
      const usersCount = users.length;
      // v0.9.119 — cada LÍNEA incluye 1 usuario; solo se cobran los usuarios que exceden las líneas.
      // v0.9.223 — los usuarios billing_excluded (soporte) NO cuentan para el cobro.
      const billableUsersCount = users.filter(u => u.billing_excluded !== true).length;
      const billableUsers = Math.max(0, billableUsersCount - linesCount);
      const aitanaTotal = linesCount * Number(t.price_per_line);
      const usersTotal = billableUsers * Number(t.price_per_user);

      // v0.9.151 — canales adicionales (Bs) + consumo del período (USD)
      const cfg = await readConsumptionConfig();
      const chMap = await channelsCountMap();
      const pricePerChannel = t.price_per_channel != null
        ? Number(t.price_per_channel) : Number(cfg.default_price_per_channel);
      const channelsCount = Number(chMap[id] || 0);
      const channelsBs = channelsCount * pricePerChannel;
      // v0.9.275 — consumo VARIABLE desde el cursor (coherente con lo que cobra el QR / "A pagar").
      let tokensUsd = 0, messagesUsd = 0, voiceUsd = 0;
      try {
        const _cur = await db.query(`SELECT COALESCE(last_variable_billed_at, billing_anchor_at, created_at) AS since FROM tenants WHERE id = $1`, [id]);
        if (_cur.rows[0] && _cur.rows[0].since) { const _cs = await consumptionSinceBs(id, _cur.rows[0].since, cfg); tokensUsd = _cs.tokensUsd; messagesUsd = _cs.messagesUsd; voiceUsd = _cs.voiceUsd; }
      } catch (_) {}

      // FIJO (Bs)
      const expected = aitanaTotal + usersTotal + channelsBs;
      const payr = await db.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM billing_payments
         WHERE tenant_id = $1 AND period = $2 AND concept = 'monthly'`, [id, period]);
      const paid = Number(payr.rows[0].paid);

      // Masivos del período + saldo comprados vs enviados (v0.9.25b)
      const { map: cMap, source } = await campaignCounts(period);
      const volAll = await campaignVolume(period);

      // v0.9.268 — DEUDA ACUMULADA (fijo + consumo de los meses NO saldados) + si el mes actual ya está saldado.
      const _billable = !['trial', 'suspended', 'cancelled'].includes(String(t.billing_status || '').toLowerCase());
      const _accumulatedDebt = await _accumulatedDebtBs(id, period, expected, cfg, _billable, t.billing_anchor_at, t.created_at);
      let _currentSettled = false;
      try { const _sc = await db.query(`SELECT 1 FROM billing_settlements WHERE tenant_id = $1 AND period = $2`, [id, period]); _currentSettled = _sc.rows.length > 0; } catch (e) {}

      // v0.9.274 — info de referidos para el super-admin: código propio, quién lo refirió, contadores y descuento.
      let _referralInfo = null;
      try {
        let referredByName = null;
        if (t.referred_by_tenant_id) { const rb = await db.query(`SELECT name FROM tenants WHERE id = $1`, [t.referred_by_tenant_id]); referredByName = rb.rows[0] && rb.rows[0].name; }
        let invited = 0, converted = 0, in_trial = 0;
        const cr = await db.query(`SELECT status, COUNT(*)::int AS n FROM referral_credits WHERE referrer_tenant_id = $1 GROUP BY status`, [id]);
        for (const row of cr.rows) { invited += row.n; if (row.status === 'earned' || row.status === 'applied') converted += row.n; if (row.status === 'pending') in_trial += row.n; }
        const _rd = await _referralDiscount(id, expected);
        _referralInfo = { code: t.referral_code || null, referred_by: referredByName, invited, converted, in_trial, discount_pct: _rd.pct, discount_bs: Math.round(_rd.discountBs * 100) / 100 };
      } catch (e) { /* referral_credits sin migrar */ }

      res.json({
        ok: true,
        period,
        referral: _referralInfo,
        pricing: {
          price_per_line: Number(t.price_per_line),
          price_per_user: Number(t.price_per_user),
          setup_fee: Number(t.setup_fee),
          messages_unlimited: t.messages_unlimited === true,
          // v0.9.151 — tarifas nuevas (aditivas)
          price_per_channel: pricePerChannel,
          comments_enabled: t.comments_enabled === true,
          // v0.9.510 — moneda en la que se le factura a este cliente. Por ahora es SOLO
          // una etiqueta: el cálculo de la deuda sigue siendo en Bs para todos.
          billing_currency: t.billing_currency || 'BOB',
          gemini_in_usd_per_m: Number(cfg.gemini_in_usd_per_m),
          gemini_out_usd_per_m: Number(cfg.gemini_out_usd_per_m),
          meta_cost_per_msg_usd: Number(cfg.meta_cost_per_msg_usd),
          consumption_markup: Number(cfg.consumption_markup),
        },
        breakdown: {
          lines_count: linesCount,
          users_count: usersCount,
          billable_users: billableUsers,
          aitana_total: aitanaTotal,
          users_total: usersTotal,
          // v0.9.151 — canales (Bs) + consumo (USD) + totales por moneda
          channels_count: channelsCount,
          channels_bs: channelsBs,
          tokens_usd: tokensUsd,
          messages_usd: messagesUsd,
          voice_usd: voiceUsd,                  // v0.9.392 — ElevenLabs
          monthly_expected_bs: expected,        // = FIJO total en Bs
          monthly_expected_usd: tokensUsd + messagesUsd + voiceUsd, // = CONSUMO total en USD
          monthly_expected: expected,           // backward-compat: total FIJO en Bs
          monthly_paid: paid,
          pending: Math.max(0, expected - paid),
          accumulated_debt_bs: _accumulatedDebt,  // v0.9.268 — deuda total acumulada (fijo+consumo de meses no saldados)
          current_settled: _currentSettled,        // ¿el mes actual ya está marcado como saldado?
        },
        campaign: (() => {
          // v0.9.25b: incluir saldo comprados vs enviados
          const v = volAll.volumes[id] || { sent_period: 0, sent_total: 0, bought_total: 0, balance: 0 };
          return { msgs: cMap[id] || 0, source, sent_total: v.sent_total, bought_total: v.bought_total, balance: v.balance };
        })(),
        lines,
        users,
        payments: pr.rows,
        packs: kr.rows,
      });
    } catch (e) {
      console.error('tenant billing:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // POST /api/admin/tenants/:id/payments
  // ----------------------------------------------------------
  app.post('/api/admin/tenants/:id/payments', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const { concept, amount, method, note, line_id } = req.body || {};
      const period = validPeriod((req.body || {}).period);

      if (!CONCEPTS.includes(concept)) return res.status(400).json({ ok: false, error: 'concepto inválido' });
      const amt = Number(amount);
      if (isNaN(amt) || amt < 0) return res.status(400).json({ ok: false, error: 'monto inválido' });

      const r = await db.query(
        `INSERT INTO billing_payments (tenant_id, period, concept, amount, method, note, line_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, period, concept, amt, method || null, note || null, line_id || null]);

      // Si es setup de una línea, marcarla como cobrada
      if (concept === 'setup' && line_id) {
        const s = await getSchema();
        if (s.lines && s.lines.setupPaid) {
          await db.query(
            `UPDATE tenant_lines SET setup_paid = TRUE WHERE id = $1 AND tenant_id = $2`,
            [line_id, id]);
        }
      }

      res.json({ ok: true, payment: r.rows[0] });
    } catch (e) {
      console.error('payment:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // PATCH /api/admin/billing-payments/:id — v0.9.265: editar un pago registrado a mano.
  // Campos editables: concept, amount, period, method, note, date (created_at). El resumen
  // de facturación se recalcula solo (las lecturas suman billing_payments en vivo).
  // ----------------------------------------------------------
  app.patch('/api/admin/billing-payments/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const b = req.body || {};
      const sets = [], params = [];
      let i = 1;
      if (b.concept !== undefined) {
        if (!CONCEPTS.includes(b.concept)) return res.status(400).json({ ok: false, error: 'concepto inválido' });
        sets.push(`concept = $${i++}`); params.push(b.concept);
      }
      if (b.amount !== undefined) {
        const amt = Number(b.amount);
        if (isNaN(amt) || amt < 0) return res.status(400).json({ ok: false, error: 'monto inválido' });
        sets.push(`amount = $${i++}`); params.push(amt);
      }
      if (b.period !== undefined) { sets.push(`period = $${i++}`); params.push(validPeriod(b.period)); }
      if (b.method !== undefined) { sets.push(`method = $${i++}`); params.push(b.method || null); }
      if (b.note !== undefined) { sets.push(`note = $${i++}`); params.push(b.note || null); }
      if (b.date !== undefined && b.date) {
        const d = new Date(b.date);
        if (!isNaN(d.getTime())) { sets.push(`created_at = $${i++}`); params.push(d.toISOString()); }
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: 'nada para actualizar' });
      params.push(id);
      const r = await db.query(`UPDATE billing_payments SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, params);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'pago no encontrado' });
      res.json({ ok: true, payment: r.rows[0] });
    } catch (e) {
      console.error('billing-payment patch:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // DELETE /api/admin/billing-payments/:id — v0.9.265: eliminar un pago registrado a mano.
  // ----------------------------------------------------------
  app.delete('/api/admin/billing-payments/:id', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const r = await db.query(
        `DELETE FROM billing_payments WHERE id = $1 RETURNING tenant_id, period, concept, amount`, [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, error: 'pago no encontrado' });
      const p = r.rows[0];
      console.log(`🗑️  [billing] pago #${id} eliminado — tenant ${p.tenant_id} · ${p.concept} · Bs ${p.amount} · ${p.period}`);
      res.json({ ok: true, deleted: { id, ...p } });
    } catch (e) {
      console.error('billing-payment delete:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // POST /api/admin/tenants/:id/packs
  // ----------------------------------------------------------
  // ----------------------------------------------------------
  // v0.9.268 — SALDAR DEUDA DEL MES: cierra un período (sin registrar pago) para que NO acumule.
  // POST /api/admin/tenants/:id/settle-month {period?, note?}   ·   DELETE …?period=  (deshacer)
  // ----------------------------------------------------------
  app.post('/api/admin/tenants/:id/settle-month', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const period = validPeriod((req.body || {}).period);
      const note = ((req.body || {}).note || '').toString().slice(0, 200) || null;
      await db.query(
        `INSERT INTO billing_settlements (tenant_id, period, note) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, period) DO UPDATE SET settled_at = NOW(), note = EXCLUDED.note`,
        [id, period, note]);
      // v0.9.274 — al cerrar el mes, consumir los créditos de referido (el settlement ya pone el mes en 0,
      // así que NO hace falta materializar el abono → materialize=false).
      await _consumeReferralCredits(id, period, false);
      console.log(`🧾 [billing] mes SALDADO — tenant ${id} · ${period}`);
      res.json({ ok: true, period });
    } catch (e) {
      console.error('settle-month:', e);
      if (/billing_settlements/.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta correr la migración v0.9.268' });
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.delete('/api/admin/tenants/:id/settle-month', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const period = validPeriod(req.query.period);
      await db.query(`DELETE FROM billing_settlements WHERE tenant_id = $1 AND period = $2`, [id, period]);
      // v0.9.274 — al DESHACER el saldado, devolver a 'earned' los créditos consumidos en ese período.
      try { await db.query(`UPDATE referral_credits SET status = 'earned', applied_period = NULL WHERE referrer_tenant_id = $1 AND status = 'applied' AND applied_period = $2`, [id, period]); } catch (e) {}
      console.log(`↩️  [billing] saldado DESHECHO — tenant ${id} · ${period}`);
      res.json({ ok: true, period });
    } catch (e) {
      console.error('unsettle-month:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.post('/api/admin/tenants/:id/packs', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const { size, price, note } = req.body || {};
      const period = validPeriod((req.body || {}).period);

      const sz = parseInt(size, 10);
      const pr = Number(price);
      if (!sz || sz < 1) return res.status(400).json({ ok: false, error: 'tamaño inválido' });
      if (isNaN(pr) || pr < 0) return res.status(400).json({ ok: false, error: 'precio inválido' });

      const r = await db.query(
        `INSERT INTO message_packs (tenant_id, size, price, note)
         VALUES ($1,$2,$3,$4) RETURNING *`, [id, sz, pr, note || null]);

      // Registrar también el pago del pack
      await db.query(
        `INSERT INTO billing_payments (tenant_id, period, concept, amount, method, note)
         VALUES ($1,$2,'pack',$3,NULL,$4)`,
        [id, period, pr, `Pack ${sz} mensajes${note ? ' — ' + note : ''}`]);

      res.json({ ok: true, pack: r.rows[0] });
    } catch (e) {
      console.error('pack:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // PATCH /api/admin/tenants/:id/pricing
  // ----------------------------------------------------------
  app.patch('/api/admin/tenants/:id/pricing', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const { price_per_line, price_per_user, setup_fee, messages_unlimited, comments_enabled, price_per_channel, billing_currency } = req.body || {};
      const vals = [Number(price_per_line), Number(price_per_user), Number(setup_fee)];
      if (vals.some(v => isNaN(v) || v < 0)) {
        return res.status(400).json({ ok: false, error: 'valores inválidos' });
      }
      // messages_unlimited es opcional: si no viene (null), no se toca.
      const unlimited = (messages_unlimited === true || messages_unlimited === false)
        ? messages_unlimited : null;
      // v0.9.151 — comentarios (toggle) + override de precio por canal.
      // comments_enabled null = no tocar. price_per_channel: vacío/null → NULL (usa default global); número → override.
      const commentsOn = (comments_enabled === true || comments_enabled === false) ? comments_enabled : null;
      // v0.9.566 — respuesta pública a comentarios (switch + texto), self-heal de columnas
      try {
        if (req.body.comment_public_reply_enabled !== undefined || req.body.comment_public_reply_text !== undefined || req.body.comment_public_reply_mode !== undefined) {
          await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_enabled boolean NOT NULL DEFAULT false`).catch(() => {});
          await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_text text`).catch(() => {});
          await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comment_public_reply_mode text NOT NULL DEFAULT 'ai'`).catch(() => {});
          if (req.body.comment_public_reply_mode !== undefined)
            await db.query(`UPDATE tenants SET comment_public_reply_mode = $1 WHERE id = $2`, [String(req.body.comment_public_reply_mode) === 'fixed' ? 'fixed' : 'ai', id]);
          if (req.body.comment_public_reply_enabled !== undefined)
            await db.query(`UPDATE tenants SET comment_public_reply_enabled = $1 WHERE id = $2`, [!!req.body.comment_public_reply_enabled, id]);
          if (req.body.comment_public_reply_text !== undefined)
            await db.query(`UPDATE tenants SET comment_public_reply_text = $1 WHERE id = $2`, [String(req.body.comment_public_reply_text || '').slice(0, 200) || null, id]);
        }
      } catch (e) { console.warn('[pricing] comment_public_reply:', e.message); }
      const ppcProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'price_per_channel');
      const ppc = ppcProvided
        ? ((price_per_channel === '' || price_per_channel == null || isNaN(Number(price_per_channel)) || Number(price_per_channel) < 0) ? null : Number(price_per_channel))
        : null;
      const r = await db.query(
        `UPDATE tenants SET price_per_line=$1, price_per_user=$2, setup_fee=$3,
                            messages_unlimited = COALESCE($4, messages_unlimited),
                            comments_enabled   = COALESCE($5, comments_enabled),
                            price_per_channel  = CASE WHEN $6 THEN $7 ELSE price_per_channel END
         WHERE id=$8 RETURNING price_per_line, price_per_user, setup_fee, messages_unlimited, comments_enabled, price_per_channel`,
        [...vals, unlimited, commentsOn, ppcProvided, ppc, id]);
      if (r.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });

      // v0.9.510 — MONEDA DE FACTURACIÓN. Va en un UPDATE aparte y defensivo a propósito:
      // si la columna todavía no se migró, el guardado de precios —que es lo que de verdad
      // importa— no se cae por eso. Solo se acepta BOB o USDT; cualquier otra cosa se ignora.
      let currency = null;
      if (typeof billing_currency === 'string') {
        const c = billing_currency.trim().toUpperCase();
        if (c === 'BOB' || c === 'USDT') currency = c;
        else return res.status(400).json({ ok: false, error: 'moneda inválida (solo BOB o USDT)' });
      }
      let savedCurrency = null;
      try {
        const cr = await db.query(
          `UPDATE tenants SET billing_currency = COALESCE($1, billing_currency)
           WHERE id = $2 RETURNING billing_currency`, [currency, id]);
        savedCurrency = cr.rows[0] ? cr.rows[0].billing_currency : null;
      } catch (e) { /* columna no migrada todavía */ }

      res.json({ ok: true, pricing: { ...r.rows[0], billing_currency: savedCurrency } });
    } catch (e) {
      console.error('pricing:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // PRECIOS GLOBALES DE PLATAFORMA (platform_pricing, single-row id=1)
  //   GET /api/admin/pricing-config  → defaults + catálogo de packs
  //   PUT /api/admin/pricing-config  → actualiza defaults + packs + plan ilimitado
  // Los tenants NUEVOS heredan estos defaults al crearse (ver onboarding.js).
  // Los existentes mantienen su precio (override por tenant en PATCH .../pricing).
  // ----------------------------------------------------------
  const PRICING_DEFAULTS = {
    default_price_per_line: 25,
    default_price_per_user: 15,
    default_setup_fee: 149,
    message_packs: [
      { size: 1000, price: 89 },
      { size: 5000, price: 399 },
      { size: 10000, price: 749 },
    ],
    unlimited_monthly_price: 0,
  };

  function normalizePacks(raw) {
    if (!Array.isArray(raw)) throw new Error('message_packs debe ser una lista');
    const out = [];
    for (const it of raw) {
      const size = parseInt(it && it.size, 10);
      const price = Number(it && it.price);
      if (!Number.isFinite(size) || size < 1) throw new Error('pack con tamaño inválido');
      if (!Number.isFinite(price) || price < 0) throw new Error('pack con precio inválido');
      out.push({ size, price });
    }
    out.sort((a, b) => a.size - b.size);
    return out;
  }

  async function readPricingConfig() {
    // v0.9.151 — leemos también las tarifas nuevas vía to_jsonb para no romper si la
    // migración aún no agregó las columnas (devolvemos los defaults de consumo).
    const r = await db.query(
      `SELECT default_price_per_line, default_price_per_user, default_setup_fee,
              message_packs, unlimited_monthly_price, updated_at,
              to_jsonb(platform_pricing) AS _all
         FROM platform_pricing WHERE id = 1`);
    if (r.rows.length === 0) return { ...PRICING_DEFAULTS, ...CONSUMPTION_DEFAULTS, updated_at: null };
    const row = r.rows[0];
    const all = row._all || {};
    const num = (v, d) => (v == null || isNaN(Number(v)) ? d : Number(v));
    return {
      default_price_per_line: Number(row.default_price_per_line),
      default_price_per_user: Number(row.default_price_per_user),
      default_setup_fee: Number(row.default_setup_fee),
      message_packs: Array.isArray(row.message_packs) ? row.message_packs : PRICING_DEFAULTS.message_packs,
      unlimited_monthly_price: Number(row.unlimited_monthly_price),
      // v0.9.151 — tarifas nuevas (canal Bs + consumo USD + markup), aditivas
      default_price_per_channel: num(all.default_price_per_channel, CONSUMPTION_DEFAULTS.default_price_per_channel),
      gemini_in_usd_per_m:       num(all.gemini_in_usd_per_m,       CONSUMPTION_DEFAULTS.gemini_in_usd_per_m),
      gemini_out_usd_per_m:      num(all.gemini_out_usd_per_m,      CONSUMPTION_DEFAULTS.gemini_out_usd_per_m),
      meta_cost_per_msg_usd:     num(all.meta_cost_per_msg_usd,     CONSUMPTION_DEFAULTS.meta_cost_per_msg_usd),
      consumption_markup:        num(all.consumption_markup,        CONSUMPTION_DEFAULTS.consumption_markup),
      elevenlabs_usd_per_1k_chars: num(all.elevenlabs_usd_per_1k_chars, CONSUMPTION_DEFAULTS.elevenlabs_usd_per_1k_chars), // v0.9.392 — notas de voz
      // v0.9.210 — cuenta de cobro de SG (para verificar comprobantes) + QR + umbral de auto-aprobado
      collection_bank:       all.collection_bank || null,
      collection_account:    all.collection_account || null,
      collection_holder:     all.collection_holder || null,
      collection_qr_url:     all.collection_qr_url || null,
      ocr_autoapprove_score: num(all.ocr_autoapprove_score, 0.90),
      // v0.9.227 — tasa USD→Bs (valor referencial de venta del BCB). Auto-actualizada por cron; editable como override.
      usd_to_bs_rate:        num(all.usd_to_bs_rate, CONSUMPTION_DEFAULTS.usd_to_bs_rate),
      usd_rate_date:         all.usd_rate_date || null,
      usd_rate_updated_at:   all.usd_rate_updated_at || null,
      // v0.9.510 — lista de referencia para clientes que se facturan en USDT.
      // null = todavía sin definir; el panel lo muestra vacío en vez de inventar un número.
      default_price_per_line_usdt:    num(all.default_price_per_line_usdt, null),
      default_price_per_user_usdt:    num(all.default_price_per_user_usdt, null),
      default_setup_fee_usdt:         num(all.default_setup_fee_usdt, null),
      default_price_per_channel_usdt: num(all.default_price_per_channel_usdt, null),
      unlimited_monthly_price_usdt:   num(all.unlimited_monthly_price_usdt, null),
      consumption_markup_usdt:        num(all.consumption_markup_usdt, null),
      updated_at: row.updated_at,
    };
  }

  app.get('/api/admin/pricing-config', requireAdmin, async (req, res) => {
    try {
      const cfg = await readPricingConfig();
      res.json({ ok: true, pricing: cfg });
    } catch (e) {
      // Si la tabla todavía no existe (migración no corrida), devolvemos defaults
      // para que el panel no rompa, marcando que falta migrar.
      if (/platform_pricing/.test(e.message) && /exist|relation/i.test(e.message)) {
        return res.json({ ok: true, pricing: { ...PRICING_DEFAULTS, updated_at: null }, needs_migration: true });
      }
      console.error('pricing-config GET:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.put('/api/admin/pricing-config', requireAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const ppl = Number(b.default_price_per_line);
      const ppu = Number(b.default_price_per_user);
      const setup = Number(b.default_setup_fee);
      const unlimited = Number(b.unlimited_monthly_price);
      for (const [k, v] of [['línea', ppl], ['usuario', ppu], ['setup', setup], ['ilimitado', unlimited]]) {
        if (!Number.isFinite(v) || v < 0) return res.status(400).json({ ok: false, error: `precio ${k} inválido` });
      }
      let packs;
      try { packs = normalizePacks(b.message_packs); }
      catch (pe) { return res.status(400).json({ ok: false, error: pe.message }); }

      await db.query(
        `INSERT INTO platform_pricing
           (id, default_price_per_line, default_price_per_user, default_setup_fee, message_packs, unlimited_monthly_price, updated_at)
         VALUES (1, $1, $2, $3, $4::jsonb, $5, NOW())
         ON CONFLICT (id) DO UPDATE SET
           default_price_per_line  = EXCLUDED.default_price_per_line,
           default_price_per_user  = EXCLUDED.default_price_per_user,
           default_setup_fee       = EXCLUDED.default_setup_fee,
           message_packs           = EXCLUDED.message_packs,
           unlimited_monthly_price = EXCLUDED.unlimited_monthly_price,
           updated_at              = NOW()`,
        [ppl, ppu, setup, JSON.stringify(packs), unlimited]);

      // v0.9.151 — tarifas nuevas (canal en Bs + consumo USD + markup). Separado y
      // defensivo: si la migración aún no corrió, no rompe el guardado principal.
      const okNum = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0) ? Number(v) : null;
      try {
        await db.query(
          `UPDATE platform_pricing SET
             default_price_per_channel = COALESCE($1, default_price_per_channel),
             gemini_in_usd_per_m       = COALESCE($2, gemini_in_usd_per_m),
             gemini_out_usd_per_m      = COALESCE($3, gemini_out_usd_per_m),
             meta_cost_per_msg_usd     = COALESCE($4, meta_cost_per_msg_usd),
             consumption_markup        = COALESCE($5, consumption_markup),
             elevenlabs_usd_per_1k_chars = COALESCE($7, elevenlabs_usd_per_1k_chars),
             usd_to_bs_rate            = COALESCE($6, usd_to_bs_rate),
             usd_rate_date             = CASE WHEN $6 IS NOT NULL THEN '(manual)' ELSE usd_rate_date END,
             usd_rate_updated_at       = CASE WHEN $6 IS NOT NULL THEN NOW() ELSE usd_rate_updated_at END,
             updated_at = NOW()
           WHERE id = 1`,
          [okNum(b.default_price_per_channel), okNum(b.gemini_in_usd_per_m), okNum(b.gemini_out_usd_per_m), okNum(b.meta_cost_per_msg_usd), okNum(b.consumption_markup), okNum(b.usd_to_bs_rate), okNum(b.elevenlabs_usd_per_1k_chars)]);
      } catch (e) { /* columnas no migradas todavía */ }

      // v0.9.210 — datos de COBRO (cuenta + titular + banco + QR) que el motor usa para verificar
      // los comprobantes, + umbral de auto-aprobado. Defensivo (si la migración aún no corrió).
      try {
        const str = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
        await db.query(
          `UPDATE platform_pricing SET
             collection_bank       = COALESCE($1, collection_bank),
             collection_account    = COALESCE($2, collection_account),
             collection_holder     = COALESCE($3, collection_holder),
             collection_qr_url     = COALESCE($4, collection_qr_url),
             ocr_autoapprove_score = COALESCE($5, ocr_autoapprove_score),
             updated_at = NOW()
           WHERE id = 1`,
          [str(b.collection_bank), str(b.collection_account), str(b.collection_holder), str(b.collection_qr_url), okNum(b.ocr_autoapprove_score)]);
      } catch (e) { /* columnas no migradas todavía */ }

      // v0.9.510 — LISTA DE PRECIOS EN USDT (referencia para clientes del exterior).
      // A diferencia de los bloques de arriba, acá SÍ se permite borrar un valor: mandar
      // el campo vacío lo deja en NULL = "todavía no definido". Por eso no se usa COALESCE
      // sino un flag de "vino en el body", igual que con price_per_channel.
      try {
        const USDT_COLS = ['default_price_per_line_usdt', 'default_price_per_user_usdt', 'default_setup_fee_usdt',
                           'default_price_per_channel_usdt', 'unlimited_monthly_price_usdt', 'consumption_markup_usdt'];
        const sets = [], params = [];
        for (const col of USDT_COLS) {
          if (!Object.prototype.hasOwnProperty.call(b, col)) continue;
          const raw = b[col];
          const val = (raw === '' || raw == null || !Number.isFinite(Number(raw)) || Number(raw) < 0) ? null : Number(raw);
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        }
        if (sets.length) {
          await db.query(`UPDATE platform_pricing SET ${sets.join(', ')}, updated_at = NOW() WHERE id = 1`, params);
        }
      } catch (e) { /* columnas no migradas todavía */ }

      const cfg = await readPricingConfig();
      res.json({ ok: true, pricing: cfg });
    } catch (e) {
      console.error('pricing-config PUT:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // MODOS DE VENTA POR TENANT (flags *_bot_enabled en tenants)
  //   GET   /api/admin/tenants/:id/modes
  //   PATCH /api/admin/tenants/:id/modes  {software?, inventory?, realestate?, services?}
  // Son los mismos flags que el tenant ve en su panel; acá el super-admin los
  // habilita/deshabilita. Va en este módulo a propósito para NO tocar api.js.
  // ----------------------------------------------------------
  const MODE_MAP = {
    software:   'software_bot_enabled',
    inventory:  'inventory_bot_enabled',
    realestate: 'realestate_bot_enabled',
    services:   'services_bot_enabled',
  };
  function modesFromRow(t) {
    return {
      software:   t.software_bot_enabled !== false, // legacy NULL = on
      inventory:  t.inventory_bot_enabled === true,
      realestate: t.realestate_bot_enabled === true,
      services:   t.services_bot_enabled === true,
    };
  }

  app.get('/api/admin/tenants/:id/modes', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const r = await db.query(
        `SELECT software_bot_enabled, inventory_bot_enabled, realestate_bot_enabled, services_bot_enabled, active_prompt_mode,
                COALESCE(to_jsonb(tenants) -> 'mode_visibility', '{}'::jsonb) AS mode_visibility
           FROM tenants WHERE id = $1`, [id]);
      if (r.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
      res.json({ ok: true, modes: modesFromRow(r.rows[0]), active_prompt_mode: r.rows[0].active_prompt_mode || null, mode_visibility: r.rows[0].mode_visibility || {} });
    } catch (e) {
      console.error('modes GET:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  app.patch('/api/admin/tenants/:id/modes', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const b = req.body || {};
      // v0.9.87: el super-admin SOLO controla la visibilidad cosmética de los modos
      // en el panel del cliente (mode_visibility). NO prende/apaga engines ni define
      // el modo activo — eso lo decide el DUEÑO desde su panel (switches exclusivos).
      if (!b.visibility || typeof b.visibility !== 'object') {
        return res.status(400).json({ ok: false, error: 'visibility requerido (objeto { modo: boolean })' });
      }
      const ALLOWED = ['software', 'articulos', 'inmuebles', 'servicios', 'arquitectura', 'salud', 'belleza', 'restaurante', 'vehiculos', 'soporte']; // v0.9.122: + soporte (Mesa de soporte) · v0.9.228: + vehiculos (visibilidad del rubro Concesionaria en el panel del cliente)
      const vis = {};
      for (const k of ALLOWED) {
        if (b.visibility[k] === undefined) continue;
        if (typeof b.visibility[k] !== 'boolean') return res.status(400).json({ ok: false, error: `visibility.${k} debe ser boolean` });
        vis[k] = b.visibility[k];
      }
      // v0.9.230: MERGE sobre lo ya guardado (NO reemplazar todo el objeto). Así, si un
      // front cacheado/viejo no manda alguna clave (p.ej. vehiculos), no borra la
      // visibilidad de los demás modos. Las claves presentes en el request mandan.
      const curRow = await db.query(`SELECT COALESCE(to_jsonb(tenants) -> 'mode_visibility', '{}'::jsonb) AS v FROM tenants WHERE id = $1`, [id]);
      if (curRow.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
      const merged = Object.assign({}, curRow.rows[0].v || {}, vis);
      const r = await db.query(
        `UPDATE tenants SET mode_visibility = $1::jsonb WHERE id = $2
         RETURNING COALESCE(to_jsonb(tenants) -> 'mode_visibility', '{}'::jsonb) AS mode_visibility`,
        [JSON.stringify(merged), id]);
      if (r.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
      res.json({ ok: true, mode_visibility: r.rows[0].mode_visibility || {} });
    } catch (e) {
      console.error('modes PATCH:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // v0.9.231 — COBROS QR (BANECO "BEC QR CONNECT") — primero desde el super-admin.
  //   GET    /api/admin/baneco/health           → ¿configurado? (env en Railway)
  //   POST   /api/admin/baneco/qr               {amount, currency?, description?, singleUse?, modifyAmount?, dueDays?, transactionId?}
  //   GET    /api/admin/baneco/qr/:qrId/status  → 0 pendiente · 1 pagado · 9 anulado
  //   DELETE /api/admin/baneco/qr/:qrId         → anula el QR
  // Credenciales SOLO por entorno (BANECO_*). No se guardan en DB ni en el repo.
  // ----------------------------------------------------------
  const baneco = require('./baneco');
  app.get('/api/admin/baneco/health', requireAdmin, async (req, res) => {
    try {
      const c = baneco.cfg();
      res.json({ ok: true, configured: baneco.isConfigured(), base: c.base || null, user: c.user || null, hasAccount: !!c.account });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/admin/baneco/qr', requireAdmin, async (req, res) => {
    try {
      if (!baneco.isConfigured()) return res.status(503).json({ ok: false, error: 'BANECO no está configurado (faltan variables de entorno en Railway)' });
      const b = req.body || {};
      const amount = Number(b.amount);
      if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'amount inválido (debe ser mayor a 0)' });
      const currency = (b.currency === 'USD') ? 'USD' : 'BOB';
      const dueDays = Math.min(Math.max(parseInt(b.dueDays, 10) || 1, 1), 365);
      const dueDate = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);
      const txId = (b.transactionId ? String(b.transactionId) : ('SA' + Date.now())).slice(0, 30);
      const out = await baneco.generateQR({
        transactionId: txId,
        amount,
        currency,
        description: String(b.description || 'Cobro SG Ventas').slice(0, 100),
        dueDate,
        singleUse: b.singleUse !== false,
        modifyAmount: b.modifyAmount === true,
      });
      res.json({ ok: true, qrId: out.qrId, qrImage: out.qrImage, transactionId: txId, amount, currency, dueDate });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.get('/api/admin/baneco/qr/:qrId/status', requireAdmin, async (req, res) => {
    try {
      if (!baneco.isConfigured()) return res.status(503).json({ ok: false, error: 'BANECO no está configurado' });
      const st = await baneco.getStatus(req.params.qrId);
      res.json({ ok: true, statusQrCode: st.statusQrCode, payment: st.payment || [] });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });
  app.delete('/api/admin/baneco/qr/:qrId', requireAdmin, async (req, res) => {
    try {
      if (!baneco.isConfigured()) return res.status(503).json({ ok: false, error: 'BANECO no está configurado' });
      await baneco.cancelQR(req.params.qrId);
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // v0.9.505 — COBROS EN USDT (Polygon). Para clientes del exterior, donde Baneco
  // no llega. Mismo espíritu que el bloque de arriba: solo super-admin, y las
  // credenciales viven en variables de entorno, nunca en la DB ni en el repo.
  //   GET  /api/admin/usdt/health              → ¿configurado?
  //   PUT  /api/admin/usdt/address/:tenantId   {address, label?} → asigna la dirección
  //   GET  /api/admin/usdt/request/:tenantId   ?amount= (USD) | ?amount_bs= (Bs, convierte)
  //   GET  /api/admin/usdt/rate                → tasa Bs/USD vigente y de dónde sale
  //   GET  /api/admin/usdt/payments/:tenantId  → pagos recibidos + total
  //   POST /api/admin/usdt/check               → fuerza la revisión ya (sin esperar el cron)
  const usdt = require('./usdt');
  app.get('/api/admin/usdt/health', requireAdmin, async (req, res) => {
    try {
      const c = usdt.cfg();
      const n = await require('./db').query('SELECT COUNT(*)::int AS n FROM usdt_addresses').catch(() => ({ rows: [{ n: 0 }] }));
      const proximo = usdt.canDerive() ? await usdt.nextIndex().catch(() => null) : null;
      res.json({ ok: true, configured: usdt.isConfigured(), enabled: c.enabled, hasApiKey: !!c.apiKey, contract: c.contract, minConfirms: c.minConfirms, direcciones: n.rows[0].n, canDerive: usdt.canDerive(), nextIndex: proximo });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  // v0.9.508 — asigna la próxima dirección derivada de la xpub. Idempotente:
  // si el tenant ya tiene dirección la devuelve tal cual, nunca la reemplaza.
  app.post('/api/admin/usdt/derive/:tenantId', requireAdmin, async (req, res) => {
    try {
      const t = parseInt(req.params.tenantId, 10);
      if (!t) return res.status(400).json({ ok: false, error: 'tenant_id inválido' });
      res.json({ ok: true, ...(await usdt.assignDerived(t)) });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  app.put('/api/admin/usdt/address/:tenantId', requireAdmin, async (req, res) => {
    try {
      const t = parseInt(req.params.tenantId, 10);
      if (!t) return res.status(400).json({ ok: false, error: 'tenant_id inválido' });
      const out = await usdt.setAddress(t, (req.body || {}).address, (req.body || {}).label);
      res.json({ ok: true, ...out });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  //   ?amount=  monto en USD   ·   ?amount_bs=  monto en Bs (convierte al vuelo)
  app.get('/api/admin/usdt/request/:tenantId', requireAdmin, async (req, res) => {
    try {
      const t = parseInt(req.params.tenantId, 10);
      const out = await usdt.paymentRequest(t, req.query.amount, { amountBs: req.query.amount_bs });
      res.json({ ok: true, ...out });
    } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
  });
  // Tipo de cambio vigente que se usaría para convertir Bs → USDT.
  app.get('/api/admin/usdt/rate', requireAdmin, async (req, res) => {
    try { res.json({ ok: true, ...(await usdt.usdToBsRate()) }); }
    catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/admin/usdt/payments/:tenantId', requireAdmin, async (req, res) => {
    try {
      const t = parseInt(req.params.tenantId, 10);
      const [list, total, addr] = await Promise.all([usdt.payments(t), usdt.totalPaid(t), usdt.getAddress(t)]);
      res.json({ ok: true, address: addr ? addr.address : null, derivation_index: addr ? addr.derivation_index : null, total_usdt: total, payments: list });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
  });
  app.post('/api/admin/usdt/check', requireAdmin, async (req, res) => {
    try {
      if (!usdt.isConfigured()) return res.status(503).json({ ok: false, error: 'USDT no está configurado (faltan USDT_ENABLED / POLYGONSCAN_API_KEY en Railway)' });
      res.json({ ok: true, ...(await usdt.checkAll()) });
    } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
  });

  // v0.9.88: el super-admin crea un usuario para un tenant (mismo modelo que el
  // POST /admin/users del dueño, pero con requireAdmin y tenant por :id).
  app.post('/api/admin/tenants/:id/users', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
      const email = String(req.body.email || '').trim().toLowerCase();
      const password = String(req.body.password || '');
      const displayName = String(req.body.display_name || '').trim();
      const role = String(req.body.role || 'agent');
      if (!email || !password || !displayName) return res.status(400).json({ ok: false, error: 'email, nombre y contraseña requeridos' });
      // v0.9.524 — el "usuario" puede ser email O un nombre simple (ej. "jsaid"). Login busca por LOWER(email) exacto.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !/^[a-z0-9][a-z0-9._-]{2,59}$/.test(email)) return res.status(400).json({ ok: false, error: 'Usá un email válido o un usuario (mín. 3 · solo letras, números y . _ -)' });
      if (password.length < 8) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres' });
      if (!['owner', 'supervisor', 'agent'].includes(role)) return res.status(400).json({ ok: false, error: 'role inválido (owner | supervisor | agent)' });
      const t = await db.query('SELECT id FROM tenants WHERE id = $1', [id]);
      if (t.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
      const dupe = await db.query('SELECT id FROM tenant_users WHERE LOWER(email) = $1', [email]);
      if (dupe.rows.length > 0) return res.status(409).json({ ok: false, error: 'Ese email ya está registrado' });
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(password, 10);
      const ins = await db.query(
        `INSERT INTO tenant_users (tenant_id, email, password_hash, display_name, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email, display_name, role, active, created_at`,
        [id, email, hash, displayName, role]);
      res.status(201).json({ ok: true, user: ins.rows[0] });
    } catch (e) {
      if (String(e.message).includes('idx_tenant_users_email')) return res.status(409).json({ ok: false, error: 'Ese email ya está registrado' });
      console.error('create tenant user:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // v0.9.223/226 — marcar/desmarcar flags de un usuario (super-admin):
  //   billing_excluded   = NO se cobra al tenant (p.ej. usuarios de soporte de SG).
  //   hidden_from_tenant = NO aparece en los listados que ve el tenant (equipo, vendedores, agenda, permisos).
  app.patch('/api/admin/tenants/:id/users/:userId', requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const userId = parseInt(req.params.userId, 10);
      if (isNaN(id) || isNaN(userId)) return res.status(400).json({ ok: false, error: 'id inválido' });

      // v0.9.241 — cambiar la CONTRASEÑA del usuario desde el super-admin (se hashea con bcrypt; nunca en texto plano ni en logs).
      if (typeof req.body.password === 'string') {
        const pw = req.body.password;
        if (pw.length < 8) return res.status(400).json({ ok: false, error: 'La contraseña debe tener al menos 8 caracteres' });
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(pw, 10);
        const upd = await db.query(`UPDATE tenant_users SET password_hash = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id, email`, [hash, userId, id]);
        if (upd.rows.length === 0) return res.status(404).json({ ok: false, error: 'usuario no encontrado en ese tenant' });
        console.log(`🔑 [admin] contraseña cambiada para usuario ${userId} (tenant ${id})`);
        return res.json({ ok: true, password_changed: true, user: { id: upd.rows[0].id, email: upd.rows[0].email } });
      }

      const sets = [], vals = [];
      if (typeof req.body.billing_excluded === 'boolean') { vals.push(req.body.billing_excluded === true); sets.push(`billing_excluded = $${vals.length}`); }
      if (typeof req.body.hidden_from_tenant === 'boolean') { vals.push(req.body.hidden_from_tenant === true); sets.push(`hidden_from_tenant = $${vals.length}`); }
      // v0.9.463 — editar el NOMBRE visible del usuario desde el super-admin. Es solo cosmético
      // (lo que ve el equipo del tenant en listados/chats); no toca email, rol ni permisos.
      // OJO: escribimos en la MISMA columna que lee el listado (getSchema resuelve
      // name|full_name|display_name según lo que exista). Si acá pusiéramos 'display_name'
      // fijo y la tabla tuviera además 'name', el panel seguiría mostrando el nombre viejo.
      let _nameCol = null;
      if (typeof req.body.display_name === 'string') {
        const _s = await getSchema();
        _nameCol = (_s.users && _s.users.name) || 'display_name';
        const dn = req.body.display_name.trim().replace(/\s+/g, ' ').slice(0, 120);
        if (!dn) return res.status(400).json({ ok: false, error: 'El nombre no puede quedar vacío' });
        vals.push(dn); sets.push(`${_nameCol} = $${vals.length}`);
      }
      if (!sets.length) return res.status(400).json({ ok: false, error: 'display_name, billing_excluded o hidden_from_tenant requerido' });
      vals.push(userId, id);
      const upd = await db.query(
        `UPDATE tenant_users SET ${sets.join(', ')} WHERE id = $${vals.length - 1} AND tenant_id = $${vals.length}
         RETURNING id, ${_nameCol ? `${_nameCol} AS name,` : ''} billing_excluded, hidden_from_tenant`,
        vals);
      if (upd.rows.length === 0) return res.status(404).json({ ok: false, error: 'usuario no encontrado en ese tenant' });
      res.json({ ok: true, user: upd.rows[0] });
    } catch (e) {
      if (/billing_excluded|hidden_from_tenant|does not exist/i.test(e.message)) return res.status(503).json({ ok: false, error: 'Falta migrar el flag (redeploy backend)' });
      console.error('toggle user flag:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // --------------------------------------------------------------------
  // v0.9.463 — ELIMINAR un usuario del tenant (super-admin).
  //
  // Candado ANTI-LOCKOUT: no se puede borrar al último owner ACTIVO del
  // tenant. Si se borra, nadie puede volver a entrar al panel de ese
  // cliente y hay que reparar a mano en Postgres. Por eso el chequeo va
  // dentro de la misma transacción que el DELETE (si dos borrados llegan
  // a la vez, el FOR UPDATE serializa y el segundo ve el estado real).
  //
  // Qué pasa con la historia: las FKs que apuntan a tenant_users son
  // ON DELETE SET NULL (mensajes enviados, comentarios asignados,
  // tickets) o CASCADE (user_lines, QR personal, prefs de soporte). O
  // sea: las conversaciones y mensajes NO se borran — pierden la
  // atribución al usuario, que pasa a NULL. Nada de datos del cliente
  // se pierde.
  //
  // El panel manda ?expect_email= con el email que el super-admin
  // escribió a mano: si no coincide con el de la fila, no se borra
  // (evita borrar la fila equivocada si la tabla se reordenó).
  // --------------------------------------------------------------------
  app.delete('/api/admin/tenants/:id/users/:userId', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(id) || isNaN(userId)) return res.status(400).json({ ok: false, error: 'id inválido' });

    const client = await db.getClient();
    try {
      await client.query('BEGIN');

      const cur = await client.query(
        `SELECT id, email, display_name, role, COALESCE(active, TRUE) AS active
           FROM tenant_users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [userId, id]
      );
      if (cur.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ ok: false, error: 'usuario no encontrado en ese tenant' });
      }
      const target = cur.rows[0];

      // Confirmación por email (el super-admin lo tipea en el modal).
      const expect = (req.query.expect_email || '').toString().trim().toLowerCase();
      if (expect && expect !== String(target.email || '').toLowerCase()) {
        await client.query('ROLLBACK');
        return res.status(409).json({ ok: false, error: 'El email escrito no coincide con el del usuario. No se borró nada.' });
      }

      // Anti-lockout: ¿queda algún OTRO owner activo?
      if (target.role === 'owner' && target.active) {
        const others = await client.query(
          `SELECT COUNT(*)::int AS n FROM tenant_users
            WHERE tenant_id = $1 AND id <> $2 AND role = 'owner' AND COALESCE(active, TRUE) = TRUE`,
          [id, userId]
        );
        if (others.rows[0].n === 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            ok: false,
            error: 'Es el único owner activo del tenant. Si lo borrás, nadie puede entrar al panel de este cliente. Creá o activá otro owner primero.',
          });
        }
      }

      await client.query('DELETE FROM tenant_users WHERE id = $1 AND tenant_id = $2', [userId, id]);
      await client.query('COMMIT');

      console.log(`🗑️ [admin] usuario ${userId} (${target.email}) eliminado del tenant ${id}`);

      // Auditoría best-effort: no debe tumbar el borrado si la tabla no existe.
      try {
        await db.query(
          `INSERT INTO audit_logs (tenant_id, action, details, created_at)
           VALUES ($1, $2, $3, NOW())`,
          [id, 'admin.tenant_user.delete', JSON.stringify({ user_id: userId, email: target.email, role: target.role })]
        );
      } catch (auditErr) {
        console.warn('[admin/users DELETE] audit log failed (non-blocking):', auditErr.message);
      }

      res.json({ ok: true, deleted: { id: target.id, email: target.email, display_name: target.display_name, role: target.role } });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('delete tenant user:', e);
      res.status(500).json({ ok: false, error: e.message });
    } finally {
      client.release();
    }
  });

  // ----------------------------------------------------------
  // MONITOREO DE ALMACENAMIENTO POR TENANT (v0.9.81)
  //   GET /api/admin/storage
  // R2 (Cloudflare): bytes + objetos bajo el prefijo de cada tenant.
  // BD: conteo de filas por tabla pesada (proxy de footprint) + tamaño total de la BD.
  // ----------------------------------------------------------
  app.get('/api/admin/storage', requireAdmin, async (req, res) => {
    try {
      const t = await db.query(`SELECT id, slug, name, r2_prefix FROM tenants ORDER BY id`);
      const tenants = t.rows;

      // Conteos por tenant (una query agrupada por tabla; si la tabla no tiene tenant_id, se omite).
      const COUNT_TABLES = ['conversations', 'messages', 'media_assets', 'leads', 'template_sends'];
      const counts = {}; // counts[tenant_id][table] = n
      for (const table of COUNT_TABLES) {
        try {
          const r = await db.query(`SELECT tenant_id, COUNT(*)::int AS n FROM ${table} GROUP BY tenant_id`);
          for (const row of r.rows) {
            if (row.tenant_id == null) continue;
            (counts[row.tenant_id] = counts[row.tenant_id] || {})[table] = row.n;
          }
        } catch (_) { /* tabla sin tenant_id o inexistente → se ignora */ }
      }

      // R2: el bucket es PLANO por tipo (properties/, inventory/, services/, media/, */docs/);
      // las keys NO llevan tenant. Atribuimos bytes por tenant mapeando las URLs que cada
      // tenant referencia en su BD contra el listado completo del bucket (key→bytes).
      const r2State = await r2.listAllSizes(); // { sizes:Map, totalBytes, totalObjects, configured }
      const r2Configured = r2State.configured;

      // (tenant_id, url) de todas las columnas con URLs de R2 (imágenes + PDFs + assets).
      const tenantKeys = {}; // tenant_id -> Set(key)
      const referencedAll = new Set(); // todas las keys referenciadas por cualquier tenant
      for (const sql of R2_URL_QUERIES) {
        try {
          const r = await db.query(sql);
          for (const row of r.rows) {
            if (!row.url) continue;
            const key = r2.extractKeyFromUrl(row.url);
            if (!key) continue;
            referencedAll.add(key);
            if (row.tenant_id == null) continue;
            (tenantKeys[row.tenant_id] = tenantKeys[row.tenant_id] || new Set()).add(key);
          }
        } catch (_) { /* columna/tabla inexistente → ignorar */ }
      }

      // v0.9.84 — Huérfanos: objetos del bucket que ningún catálogo referencia
      // (fotos quitadas con la ✕ cuyo archivo quedó en R2). Candidatos a purga.
      let orphanCount = 0, orphanBytes = 0;
      if (r2Configured) {
        for (const o of r2State.objects) {
          if (!referencedAll.has(o.key)) { orphanCount += 1; orphanBytes += o.size; }
        }
      }

      const rows = [];
      let r2AttrBytes = 0, r2AttrObjects = 0;
      for (const ten of tenants) {
        let bytes = 0, objects = 0;
        const keys = tenantKeys[ten.id];
        if (keys && r2Configured) {
          for (const k of keys) {
            if (r2State.sizes.has(k)) { bytes += r2State.sizes.get(k); objects += 1; }
          }
        }
        r2AttrBytes += bytes; r2AttrObjects += objects;
        const c = counts[ten.id] || {};
        rows.push({
          tenant_id: ten.id, slug: ten.slug, name: ten.name,
          r2_bytes: bytes, r2_objects: objects,
          conversations: c.conversations || 0,
          messages: c.messages || 0,
          media_assets: c.media_assets || 0,
          leads: c.leads || 0,
          template_sends: c.template_sends || 0,
        });
      }

      let dbSizeBytes = null;
      try {
        const d = await db.query(`SELECT pg_database_size(current_database())::bigint AS bytes`);
        dbSizeBytes = Number(d.rows[0].bytes);
      } catch (_) {}

      // v0.9.478 — DESGLOSE POR PREFIJO: dónde está realmente el espacio. Sin esto solo se veía
      // el total por tenant y había que adivinar si eran fotos de catálogo o media de chat.
      // Se agrupa por el primer segmento de la key (incoming/, outgoing/, properties/, assets/…),
      // que es como el bucket está organizado. `chat` marca los prefijos que expira el TTL.
      const CHAT_P = ['incoming', 'outgoing'];
      const prefAgg = {};
      for (const o of (r2State.objects || [])) {
        const seg = String(o.key || '').split('/')[0] || '(raíz)';
        const a = (prefAgg[seg] = prefAgg[seg] || { prefix: seg, bytes: 0, objects: 0, chat: CHAT_P.includes(seg) });
        a.bytes += (o.size || 0); a.objects += 1;
      }
      const byPrefix = Object.values(prefAgg).sort((a, b) => b.bytes - a.bytes);

      // v0.9.479 — SIMULADOR DE RETENCIÓN: "si el TTL fuera de N días, ¿cuánto liberaría HOY?".
      // Cruza cada objeto de chat con la fecha del MENSAJE que lo referencia (mismo criterio que
      // expireChatMedia v0.9.477), arma la distribución de edades y acumula por ventana. Read-only:
      // no borra nada, solo responde qué pasaría. Sirve para elegir la ventana con datos.
      let retention = null;
      try {
        const mr = await db.query(
          `SELECT media_url, MIN(created_at) AS created_at
             FROM messages WHERE media_url IS NOT NULL GROUP BY media_url`
        );
        const now = Date.now();
        const items = []; // { ageDays, bytes }
        let trackedBytes = 0, oldestDays = 0;
        for (const row of mr.rows) {
          const key = r2.extractKeyFromUrl(row.media_url);
          if (!key) continue;
          if (!CHAT_P.some((p) => key.startsWith(p + '/'))) continue; // solo media de chat
          const size = r2State.sizes.get(key);
          if (size == null) continue; // ya no está en R2
          const ageDays = (now - new Date(row.created_at).getTime()) / 86400000;
          items.push({ ageDays, bytes: size });
          trackedBytes += size;
          if (ageDays > oldestDays) oldestDays = ageDays;
        }
        const WINDOWS = [5, 10, 15, 20, 30, 45, 60, 90];
        retention = {
          tracked_objects: items.length,
          tracked_bytes: trackedBytes,
          oldest_days: Math.floor(oldestDays),
          current_ttl_days: parseInt(process.env.CHAT_MEDIA_TTL_DAYS || '90', 10) || 90,
          windows: WINDOWS.map((d) => {
            const sel = items.filter((i) => i.ageDays > d);
            const bytes = sel.reduce((s, i) => s + i.bytes, 0);
            return {
              ttl_days: d,
              freed_objects: sel.length,
              freed_bytes: bytes,
              freed_pct_of_chat: trackedBytes ? Math.round((bytes / trackedBytes) * 100) : 0,
            };
          }),
        };
      } catch (e) {
        console.warn('[storage] simulador de retención:', e.message);
      }

      res.json({
        ok: true,
        tenants: rows,
        retention,
        by_prefix: byPrefix,
        totals: {
          db_size_bytes: dbSizeBytes,
          r2_total_bytes: r2State.totalBytes,
          r2_total_objects: r2State.totalObjects,
          r2_attributed_bytes: r2AttrBytes,
          r2_attributed_objects: r2AttrObjects,
          r2_unattributed_bytes: Math.max(0, r2State.totalBytes - r2AttrBytes),
          r2_orphan_count: orphanCount,
          r2_orphan_bytes: orphanBytes,
          r2_configured: r2Configured,
        },
      });
    } catch (e) {
      console.error('storage GET:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // GET /api/admin/resource-health
  //   v0.9.273 — Snapshot de salud de recursos para el chequeo MENSUAL de escalabilidad:
  //   tamaño de DB + tablas más grandes, crecimiento de `messages`, conexiones vs max,
  //   tenants, uso de R2, consumo de Gemini del mes y top tenants por volumen. Todo
  //   read-only y best-effort (cada métrica en su try/catch → una tabla faltante no
  //   rompe el resto). Super-admin (requireAdmin). Lo consume la tarea programada mensual.
  // ----------------------------------------------------------
  app.get('/api/admin/resource-health', requireAdmin, async (req, res) => {
    const out = { ok: true, generated_at: new Date().toISOString() };
    const num = (x) => (x == null ? null : Number(x));

    // --- Base de datos ---
    const database = {};
    try {
      const d = await db.query(`SELECT pg_database_size(current_database())::bigint AS bytes`);
      database.size_bytes = num(d.rows[0].bytes);
    } catch (e) { database.size_error = e.message; }
    try {
      const tbl = await db.query(
        `SELECT c.relname AS table_name, pg_total_relation_size(c.oid)::bigint AS bytes
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
          ORDER BY pg_total_relation_size(c.oid) DESC
          LIMIT 8`);
      database.biggest_tables = tbl.rows.map((r) => ({ table: r.table_name, bytes: num(r.bytes) }));
    } catch (e) { database.tables_error = e.message; }
    try {
      const m = await db.query(
        `SELECT COUNT(*)::bigint AS total,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::bigint AS last_30d,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '60 days' AND created_at < NOW() - INTERVAL '30 days')::bigint AS prev_30d,
                MIN(created_at) AS oldest_at
           FROM messages`);
      database.messages = { total: num(m.rows[0].total), last_30d: num(m.rows[0].last_30d), prev_30d: num(m.rows[0].prev_30d), oldest_at: m.rows[0].oldest_at };
    } catch (e) { database.messages_error = e.message; }
    try {
      const cx = await db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE state = 'active')::int AS active,
                current_setting('max_connections')::int AS max_connections
           FROM pg_stat_activity WHERE datname = current_database()`);
      database.connections = { in_use: cx.rows[0].total, active: cx.rows[0].active, max_connections: cx.rows[0].max_connections, pool_max_per_instance: 10 };
    } catch (e) { database.connections_error = e.message; }
    out.database = database;

    // --- Tenants ---
    try {
      const t = await db.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE LOWER(COALESCE(billing_status,'')) = 'active')::int AS active
           FROM tenants`);
      out.tenants = { total: t.rows[0].total, active: t.rows[0].active };
    } catch (e) { out.tenants = { error: e.message }; }

    // --- Top tenants por volumen de mensajes (señal "Paolo": crecimiento en profundidad) ---
    try {
      const tt = await db.query(
        `SELECT t.id, t.name, COUNT(m.*)::bigint AS messages
           FROM tenants t LEFT JOIN messages m ON m.tenant_id = t.id
          GROUP BY t.id, t.name ORDER BY COUNT(m.*) DESC LIMIT 5`);
      out.top_tenants_by_messages = tt.rows.map((r) => ({ tenant_id: r.id, name: r.name, messages: num(r.messages) }));
    } catch (_) {}

    // --- R2 (almacenamiento) ---
    try {
      const r2State = await r2.listAllSizes();
      out.r2 = { configured: r2State.configured, total_bytes: r2State.totalBytes, total_objects: r2State.totalObjects };
    } catch (e) { out.r2 = { error: e.message }; }

    // --- Gemini: consumo del mes en curso (driver de costo variable) ---
    try {
      const a = await db.query(
        `SELECT COALESCE(SUM(total_tokens),0)::bigint AS total_tokens,
                COALESCE(SUM(prompt_tokens),0)::bigint AS prompt_tokens,
                COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
                COUNT(*)::bigint AS calls
           FROM ai_usage WHERE created_at >= date_trunc('month', NOW())`);
      out.gemini_this_month = { total_tokens: num(a.rows[0].total_tokens), prompt_tokens: num(a.rows[0].prompt_tokens), output_tokens: num(a.rows[0].output_tokens), calls: num(a.rows[0].calls) };
    } catch (e) { out.gemini_this_month = { error: e.message }; }

    // --- Mensajes salientes del mes (proxy de costo Meta + envío) ---
    try {
      const o = await db.query(`SELECT COUNT(*)::bigint AS n FROM messages WHERE direction = 'outgoing' AND created_at >= date_trunc('month', NOW())`);
      out.outbound_messages_this_month = num(o.rows[0].n);
    } catch (_) {}

    // Umbrales orientativos (del análisis de escalabilidad v0.9.272) para que el reporte
    // mensual sepa cuándo RECOMENDAR ampliar. Ajustar con datos reales.
    out.thresholds = {
      db_size_bytes_watch: 8 * 1024 * 1024 * 1024,
      messages_table_bytes_watch: 5 * 1024 * 1024 * 1024,
      connections_pct_watch: 0.7,
      single_conversation_msgs_watch: 100000,
      note: 'Orientativos; el chequeo mensual los usa como guía, no como regla dura.',
    };

    res.json(out);
  });

  // ----------------------------------------------------------
  // POST /api/admin/storage/purge-orphans?confirm=1
  //   Borra del bucket los objetos que ningún catálogo referencia.
  //   Sin confirm=1 => DRY-RUN (reporta qué borraría, no borra).
  //   Salta objetos de < SAFETY_MIN minutos (subidas en curso).
  // ----------------------------------------------------------
  app.post('/api/admin/storage/purge-orphans', requireAdmin, async (req, res) => {
    try {
      const confirm = req.query.confirm === '1' || req.body?.confirm === true;
      const SAFETY_MIN = 60;
      const r2State = await r2.listAllSizes();
      if (!r2State.configured) {
        return res.json({ ok: true, dry_run: !confirm, configured: false, candidates: 0, deleted: 0, freed_bytes: 0, skipped_recent: 0, note: 'R2 no configurado' });
      }

      // keys referenciadas por cualquier tenant (mismas columnas que /storage)
      const referenced = new Set();
      for (const sql of R2_URL_QUERIES) {
        try {
          const r = await db.query(sql);
          for (const row of r.rows) {
            if (!row.url) continue;
            const k = r2.extractKeyFromUrl(row.url);
            if (k) referenced.add(k);
          }
        } catch (_) { /* tabla/columna inexistente → ignorar */ }
      }

      const cutoff = Date.now() - SAFETY_MIN * 60 * 1000;
      const toDelete = [];
      let candidateBytes = 0, skippedRecent = 0;
      for (const o of r2State.objects) {
        if (referenced.has(o.key)) continue;
        const lm = o.lastModified ? new Date(o.lastModified).getTime() : 0;
        if (lm > cutoff) { skippedRecent += 1; continue; } // muy reciente, no tocar
        toDelete.push(o.key);
        candidateBytes += o.size;
      }

      if (!confirm) {
        return res.json({
          ok: true, dry_run: true, configured: true,
          candidates: toDelete.length, freed_bytes: candidateBytes,
          skipped_recent: skippedRecent,
          sample: toDelete.slice(0, 10),
        });
      }

      const result = await r2.deleteObjects(toDelete);
      console.log(`🧹 purge-orphans: borrados ${result.deleted}/${toDelete.length} objetos (${candidateBytes} bytes)`);
      res.json({
        ok: true, dry_run: false, configured: true,
        candidates: toDelete.length,
        deleted: result.deleted,
        freed_bytes: candidateBytes,
        skipped_recent: skippedRecent,
        errors: result.errors.slice(0, 10),
      });
    } catch (e) {
      console.error('purge-orphans:', e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ----------------------------------------------------------
  // POST /api/admin/tenants/:id/delete   body: { confirm_slug }
  //   Elimina el tenant y TODAS sus filas en cualquier tabla con tenant_id,
  //   más sus objetos en R2. Requiere confirm_slug == slug exacto. Protege tenant 1.
  //   Multi-pass con savepoints: reintenta tablas que fallan por FK hasta resolver
  //   el orden de borrado (sin necesidad de conocer las dependencias de antemano).
  // ----------------------------------------------------------
  const PROTECTED_TENANT_IDS = [1]; // SG Bolivia (org dueña) — no se puede borrar

  app.post('/api/admin/tenants/:id/delete', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ ok: false, error: 'id inválido' });
    if (PROTECTED_TENANT_IDS.includes(id)) {
      return res.status(403).json({ ok: false, error: 'Ese tenant está protegido y no se puede eliminar.' });
    }

    // tenant + slug
    let tenant;
    try {
      const tr = await db.query('SELECT id, slug, name FROM tenants WHERE id = $1', [id]);
      if (tr.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
      tenant = tr.rows[0];
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }

    const confirmSlug = String(req.body?.confirm_slug || '').trim();
    if (confirmSlug !== tenant.slug) {
      return res.status(400).json({ ok: false, error: `Confirmación inválida: escribí el slug exacto (${tenant.slug}).` });
    }

    // 0) v0.9.540 — DES-SUSCRIBIR DE META antes de purgar. Borrar el tenant del CRM no sacaba el
    // WABA de la app en Meta (seguía suscrito → figuraba en el Business Portfolio). Ahora des-
    // suscribimos cada WABA del tenant (best-effort, no bloquea el borrado). GUARDAS: no tocamos el
    // WABA global ni uno que comparta OTRO tenant activo. La capa de partner/ownership sigue siendo
    // de Meta (se quita desde Business Settings), pero la conexión de la app queda limpia.
    const metaUnsub = { unsubscribed: [], skipped: [] };
    try {
      const meta = require('./meta');
      const callMetaWithTenantTokens = require('./api').callMetaWithTenantTokens;
      const GLOBAL_WABA = process.env.META_WABA_ID || null;
      const lr = await db.query(
        `SELECT DISTINCT COALESCE(tl.waba_id, t.waba_id) AS waba, tl.meta_token_enc
           FROM tenant_lines tl JOIN tenants t ON t.id = tl.tenant_id
          WHERE tl.tenant_id = $1 AND COALESCE(tl.waba_id, t.waba_id) IS NOT NULL`, [id]).catch(() => ({ rows: [] }));
      const rows = lr.rows.slice();
      // incluir el WABA propio del tenant aunque no tenga líneas
      const tw = await db.query('SELECT waba_id FROM tenants WHERE id = $1', [id]).catch(() => ({ rows: [] }));
      if (tw.rows[0] && tw.rows[0].waba_id && !rows.some(r => String(r.waba) === String(tw.rows[0].waba_id))) {
        rows.push({ waba: tw.rows[0].waba_id, meta_token_enc: null });
      }
      const doneWabas = new Set();
      for (const row of rows) {
        const waba = row.waba && String(row.waba);
        if (!waba || doneWabas.has(waba)) continue;
        doneWabas.add(waba);
        if (GLOBAL_WABA && waba === String(GLOBAL_WABA)) { metaUnsub.skipped.push({ waba, reason: 'WABA global' }); continue; }
        const others = await db.query(
          `SELECT COUNT(*)::int AS n FROM tenant_lines
            WHERE active = TRUE AND tenant_id <> $1
              AND COALESCE(waba_id, (SELECT waba_id FROM tenants WHERE id = tenant_lines.tenant_id)) = $2`,
          [id, waba]).catch(() => ({ rows: [{ n: 0 }] }));
        if (others.rows[0].n > 0) { metaUnsub.skipped.push({ waba, reason: `compartido por ${others.rows[0].n} línea(s) de otro tenant` }); continue; }
        if (typeof callMetaWithTenantTokens !== 'function') { metaUnsub.skipped.push({ waba, reason: 'helper no disponible' }); continue; }
        try {
          await callMetaWithTenantTokens(id, row.meta_token_enc, (token) => meta.unsubscribeWABA(waba, token));
          metaUnsub.unsubscribed.push(waba);
          console.log(`🔌 [tenant/delete] WABA ${waba} des-suscrito de Meta (tenant ${id})`);
        } catch (e) {
          metaUnsub.skipped.push({ waba, reason: 'no se pudo des-suscribir: ' + (e.response?.data?.error?.message || e.message) });
          console.warn(`⚠️ [tenant/delete] no se pudo des-suscribir WABA ${waba}:`, e.message);
        }
      }
    } catch (e) { console.warn('⚠️ [tenant/delete] paso de des-suscripción falló (no bloqueante):', e.message); }

    // 1) Juntar las keys R2 del tenant ANTES de borrar (para purgarlas después del commit)
    let r2Keys = [];
    try {
      const keySet = new Set();
      for (const sql of R2_URL_QUERIES) {
        try {
          const r = await db.query(sql);
          for (const row of r.rows) {
            if (String(row.tenant_id) !== String(id) || !row.url) continue;
            const k = r2.extractKeyFromUrl(row.url);
            if (k) keySet.add(k);
          }
        } catch (_) { /* tabla/columna inexistente → ignorar */ }
      }
      r2Keys = [...keySet];
    } catch (_) { /* no bloqueante */ }

    // 2) Borrado transaccional de todas las tablas con tenant_id
    const client = await db.getClient();
    let tablesCleared = 0, rowsDeleted = 0;
    const cleared = [];
    try {
      await client.query('BEGIN');

      // descubrir SOLO tablas base (no vistas) con columna tenant_id; 'tenants' se borra al final
      const cols = await client.query(`
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name`);

      let remaining = cols.rows
        .map(r => r.table_name)
        .filter(t => t !== 'tenants' && /^[a-z_][a-z0-9_]*$/i.test(t));

      let pass = 0;
      while (remaining.length > 0) {
        pass += 1;
        if (pass > 25) throw new Error('Demasiadas pasadas borrando tablas (posible FK externa).');
        const stillFailing = [];
        let progress = false;
        for (const t of remaining) {
          await client.query('SAVEPOINT sp_del');
          try {
            const del = await client.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [id]);
            await client.query('RELEASE SAVEPOINT sp_del');
            rowsDeleted += del.rowCount || 0;
            tablesCleared += 1;
            cleared.push(t);
            progress = true;
          } catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT sp_del');
            stillFailing.push(t);
          }
        }
        remaining = stillFailing;
        if (remaining.length > 0 && !progress) {
          throw new Error(`No se pudieron borrar por FK (¿referencia externa o ciclo?): ${remaining.join(', ')}`);
        }
      }

      // finalmente el tenant
      const delT = await client.query('DELETE FROM tenants WHERE id = $1', [id]);
      rowsDeleted += delT.rowCount || 0;

      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      client.release();
      console.error('delete tenant:', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
    client.release();

    // 3) Purga de R2 (best-effort, ya commiteado el borrado en BD)
    let r2Deleted = 0;
    if (r2Keys.length > 0) {
      try {
        const pr = await r2.deleteObjects(r2Keys);
        r2Deleted = pr.deleted;
      } catch (e) { console.warn('delete tenant R2:', e.message); }
    }

    console.log(`🗑️  Tenant ${id} (${tenant.slug}) eliminado: ${tablesCleared} tablas, ${rowsDeleted} filas, ${r2Deleted} objetos R2`);
    res.json({
      ok: true, deleted: true,
      tenant: { id, slug: tenant.slug, name: tenant.name },
      tables_cleared: tablesCleared,
      rows_deleted: rowsDeleted,
      r2_deleted: r2Deleted,
      meta_unsubscribed: metaUnsub.unsubscribed,   // v0.9.540 — WABAs des-suscritos de Meta
      meta_skipped: metaUnsub.skipped,             // WABAs que NO se tocaron (global/compartido/error)
    });
  });

  // ----------------------------------------------------------
  // GET /api/me/billing  — facturación del tenant logueado (self-service)
  // v0.9.105: espeja /api/admin/tenants/:id/billing pero scopeado al JWT del
  // tenant (req.tenantId). Read-only para el cliente: ve su plan, lo que debe,
  // el saldo de campañas y el historial de pagos. No puede modificar nada.
  // ----------------------------------------------------------
  if (requireTenantSession) {
    app.get('/api/me/billing', requireTenantSession, async (req, res) => {
      try {
        const id = req.tenantId;
        if (!id) return res.status(400).json({ ok: false, error: 'sesión sin tenant' });
        const period = validPeriod(req.query.period);
        const s = await getSchema();

        const tr = await db.query(
          `SELECT id, name, plan, billing_status, price_per_line, price_per_user, setup_fee, messages_unlimited, created_at,
                  (to_jsonb(tenants) ->> 'billing_anchor_at')::timestamptz AS billing_anchor_at,
                  (to_jsonb(tenants) ->> 'price_per_channel')::numeric AS price_per_channel,
                  COALESCE((to_jsonb(tenants) ->> 'comments_enabled')::boolean, FALSE) AS comments_enabled,
                  (to_jsonb(tenants) ->> 'billing_balance_bs')::numeric AS billing_balance_bs,
                  (to_jsonb(tenants) ->> 'billing_next_due_date') AS billing_next_due_date
             FROM tenants WHERE id = $1`, [id]);
        if (tr.rows.length === 0) return res.status(404).json({ ok: false, error: 'tenant no encontrado' });
        const t = tr.rows[0];

        // Conteo de líneas activas (todas = cupo de usuarios) y facturables (para el cargo).
        let linesCount = 0, billableLinesCount = 0;
        if (s.lines) {
          const L = s.lines;
          const activeSel = L.active ? `${L.active} AS active` : `TRUE AS active`;
          const exclLineSel = L.excluded ? `COALESCE(${L.excluded}, FALSE)` : `FALSE`;
          const lr = await db.query(`SELECT ${activeSel}, (${exclLineSel}) AS billing_excluded FROM tenant_lines WHERE tenant_id = $1`, [id]);
          const act = L.active ? lr.rows.filter(x => x.active !== false) : lr.rows;
          linesCount = act.length;
          billableLinesCount = act.filter(x => x.billing_excluded !== true).length; // v0.9.525
        }
        // Conteo de usuarios (total para display + facturables para el cobro)
        let usersCount = 0, billableUsersCount = 0;
        if (s.users) {
          const exclSel = s.users.excluded ? `COALESCE(${s.users.excluded}, FALSE)` : `FALSE`;
          const ur = await db.query(`SELECT (${exclSel}) AS billing_excluded FROM tenant_users WHERE tenant_id = $1`, [id]);
          usersCount = ur.rows.length;
          billableUsersCount = ur.rows.filter(x => x.billing_excluded !== true).length; // v0.9.223
        }

        // v0.9.151 — alinear con admin: cada LÍNEA incluye 1 usuario; solo se cobran
        // los usuarios EXCEDENTES. v0.9.223 — y los billing_excluded (soporte) NO se cobran.
        const billableUsers = Math.max(0, billableUsersCount - linesCount);
        const aitanaTotal = billableLinesCount * Number(t.price_per_line); // v0.9.525 — excluye líneas no facturables
        const usersTotal = billableUsers * Number(t.price_per_user);

        // v0.9.151 — canales adicionales (Bs) + consumo del período (USD)
        const cfg = await readConsumptionConfig();
        const chMap = await channelsCountMap();
        const pricePerChannel = t.price_per_channel != null
          ? Number(t.price_per_channel) : Number(cfg.default_price_per_channel);
        const channelsCount = Number(chMap[id] || 0);
        const channelsBs = channelsCount * pricePerChannel;
        // v0.9.275 — consumo VARIABLE desde el cursor (lo que efectivamente cobra el QR), no por mes calendario.
        let tokensUsd = 0, messagesUsd = 0, voiceUsd = 0;
        try {
          const _cur = await db.query(`SELECT COALESCE(last_variable_billed_at, billing_anchor_at, created_at) AS since FROM tenants WHERE id = $1`, [id]);
          if (_cur.rows[0] && _cur.rows[0].since) { const _cs = await consumptionSinceBs(id, _cur.rows[0].since, cfg); tokensUsd = _cs.tokensUsd; messagesUsd = _cs.messagesUsd; voiceUsd = _cs.voiceUsd; }
        } catch (_) {}

        // FIJO (Bs)
        const expected = aitanaTotal + usersTotal + channelsBs;

        const payr = await db.query(
          `SELECT COALESCE(SUM(amount),0)::numeric AS paid FROM billing_payments
           WHERE tenant_id = $1 AND period = $2 AND concept = 'monthly'`, [id, period]);
        const paid = Number(payr.rows[0].paid);

        // v0.9.227 — CONSUMO (USD) → Bs al valor referencial de VENTA del dólar (BCB). Entra al "A pagar".
        const _usdRate = Number(cfg.usd_to_bs_rate) || 0;
        const _consumoUsd = tokensUsd + messagesUsd + voiceUsd;
        const _consumoBs = _usdRate > 0 ? _consumoUsd * _usdRate : 0;
        const _totalToPayBs = expected + _consumoBs;

        // v0.9.279 — RENDIMIENTO: costo del mes ÷ el TOTAL de cada cosa, con el MISMO criterio que la vista
        // "Por línea" (la correcta). NO se filtra el CONTEO por fecha: lo "del mes" es el COSTO (fijo+consumo).
        // Antes se filtraba el conteo por created_at dentro del mes → el día 1 del mes daba casi todo cero
        // (1 calificado, 0 citas) aunque el pipeline real fuera 29 y 7. Clientes = todas las conversaciones;
        // calificados = leads score≥70 (join por conversación, evita el tenant_id DEFAULT 1 de leads);
        // citas = appointments con status 'scheduled' (= "Agendadas" del macro; antes contaba cualquier estado).
        let _activeClients = 0, _qualLeads = 0, _appts = 0;
        try { const _r = await db.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE tenant_id = $1`, [id]); _activeClients = _r.rows[0].n; } catch (e) {}
        try { const _r = await db.query(`SELECT COUNT(DISTINCT l.id)::int AS n FROM conversations c JOIN leads l ON l.conversation_id = c.id WHERE c.tenant_id = $1 AND COALESCE(l.score,0) >= 70`, [id]); _qualLeads = _r.rows[0].n; } catch (e) {}
        try { const _r = await db.query(`SELECT COUNT(*)::int AS n FROM appointments a JOIN conversations c ON c.id = a.conversation_id WHERE c.tenant_id = $1 AND a.status = 'scheduled'`, [id]); _appts = _r.rows[0].n; } catch (e) {}
        const _perf = {
          period,
          cost_base_bs: _totalToPayBs,
          active_clients: _activeClients,
          qualified_leads: _qualLeads,
          appointments: _appts,
          cost_per_active_client: _activeClients > 0 ? _totalToPayBs / _activeClients : null,
          cost_per_qualified_lead: _qualLeads > 0 ? _totalToPayBs / _qualLeads : null,
          cost_per_appointment: _appts > 0 ? _totalToPayBs / _appts : null,
        };

        // Historial (read-only): pagos + packs
        const pr = await db.query(
          `SELECT id, period, concept, amount, method, note, created_at,
                  (to_jsonb(billing_payments) ->> 'receipt_url') AS receipt_url
           FROM billing_payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 24`, [id]);
        const kr = await db.query(
          `SELECT size, price, note, created_at
           FROM message_packs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 12`, [id]);

        // Saldo de campañas (comprados − enviados)
        const volAll = await campaignVolume(period);
        const v = volAll.volumes[id] || { sent_period: 0, sent_total: 0, bought_total: 0, balance: 0 };

        // v0.9.209 — datos de cobro de SG (QR + cuenta) para mostrar en "Mi plan"
        const cq = await db.query(`SELECT collection_bank, collection_account, collection_holder, collection_qr_url FROM platform_pricing WHERE id = 1`).catch(() => ({ rows: [] }));
        const coll = cq.rows[0] || {};
        const _isTrial = ['trial', 'suspended', 'cancelled'].includes(String(t.billing_status || '').toLowerCase());
        // v0.9.268 — "A pagar" = DEUDA ACUMULADA (meses NO saldados). Trial/suspended/cancelled: solo el mes
        // actual (gate, sin cambios). Es EXACTAMENTE el mismo número que cobra el QR (_amountDueBs).
        const _accDue = await _accumulatedDebtBs(id, period, expected, cfg, !_isTrial, t.billing_anchor_at, t.created_at);
        // v0.9.212 — comprobantes subidos por el tenant (todos los estados) para mostrar en "Mi plan"
        const cmp = await db.query(
          `SELECT id, status, amount_bs, nro_comprobante, confidence, image_url, created_at, applied_at
             FROM tenant_payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [id]).catch(() => ({ rows: [] }));

        res.json({
          ok: true,
          period,
          tenant: { id: t.id, name: t.name || null },  // v0.9.282 — para el recibo imprimible en "Mi plan"
          performance: _perf,
          plan: t.plan || null,
          billing_status: t.billing_status || null,
          // v0.9.209 — pagos QR: trial no se cobra (solo muestra el monto); saldo + vencimiento + QR.
          is_trial: _isTrial,
          billing_balance_bs: Number(t.billing_balance_bs) || 0,
          billing_next_due_date: t.billing_next_due_date || null,
          collection: { bank: coll.collection_bank || null, account: coll.collection_account || null, holder: coll.collection_holder || null, qr_url: coll.collection_qr_url || null },
          comprobantes: cmp.rows,
          pricing: {
            monthly_price: expected,
            price_per_line: Number(t.price_per_line),
            price_per_user: Number(t.price_per_user),
            setup_fee: Number(t.setup_fee),
            messages_unlimited: t.messages_unlimited === true,
            // v0.9.151 — tarifas nuevas (aditivas)
            price_per_channel: pricePerChannel,
            comments_enabled: t.comments_enabled === true,
            gemini_in_usd_per_m: Number(cfg.gemini_in_usd_per_m),
            gemini_out_usd_per_m: Number(cfg.gemini_out_usd_per_m),
            meta_cost_per_msg_usd: Number(cfg.meta_cost_per_msg_usd),
            consumption_markup: Number(cfg.consumption_markup),
          },
          breakdown: {
            lines_count: linesCount,
            users_count: usersCount,
            // v0.9.151 — usuarios facturables (excedente sobre líneas) + canales + consumo
            billable_users: billableUsers,
            channels_count: channelsCount,
            channels_bs: channelsBs,
            tokens_usd: tokensUsd,
            messages_usd: messagesUsd,
            voice_usd: voiceUsd,                  // v0.9.392 — ElevenLabs
            monthly_expected_bs: expected,        // = FIJO total en Bs
            monthly_expected_usd: _consumoUsd,    // = CONSUMO total en USD
            monthly_expected: expected,           // backward-compat: total FIJO en Bs
            // v0.9.227 — consumo convertido a Bs (tasa BCB) + total a pagar (fijo + consumo)
            usd_to_bs_rate: _usdRate,
            usd_rate_date: cfg.usd_rate_date || null,
            consumo_bs: _consumoBs,
            total_to_pay_bs: _totalToPayBs,
            monthly_paid: paid,
            pending: Math.round(_accDue * 100) / 100, // v0.9.268 — deuda ACUMULADA (= lo que cobra el QR)
            pending_current_month: Math.max(0, _totalToPayBs - paid), // solo el mes actual (informativo)
          },
          campaign: {
            source: volAll.source,
            sent_total: v.sent_total,
            sent_period: v.sent_period,
            bought_total: v.bought_total,
            balance: v.balance,
            unlimited: t.messages_unlimited === true,
          },
          payments: pr.rows,
          packs: kr.rows,
        });
      } catch (e) {
        console.error('me billing:', e);
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // v0.9.274 — datos del PROGRAMA DE REFERIDOS para la tarjeta de "Mi plan".
    app.get('/api/me/referral', requireTenantSession, async (req, res) => {
      const id = req.tenantId;
      if (!id) return res.status(400).json({ ok: false, error: 'sesión sin tenant' });
      try {
        let code = null;
        try { const tr = await db.query(`SELECT referral_code FROM tenants WHERE id = $1`, [id]); code = tr.rows[0] && tr.rows[0].referral_code; } catch (_) {}
        let invited = 0, converted = 0, in_trial = 0;
        try {
          const cr = await db.query(`SELECT status, COUNT(*)::int AS n FROM referral_credits WHERE referrer_tenant_id = $1 GROUP BY status`, [id]);
          for (const row of cr.rows) {
            invited += row.n;
            if (row.status === 'earned' || row.status === 'applied') converted += row.n;
            if (row.status === 'pending') in_trial += row.n;
          }
        } catch (_) { /* tabla sin migrar */ }
        let pct = 0, discount_bs = 0;
        try { const fijo = await _monthlyExpectedBs(id); const d = await _referralDiscount(id, fijo); pct = d.pct; discount_bs = Math.round(d.discountBs * 100) / 100; } catch (_) {}
        res.json({ ok: true, code, invited, converted, in_trial, discount_pct: pct, discount_bs });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });

    // ============ v0.9.209 — PAGOS QR: subir comprobante + OCR (Gemini visión) + auto-acreditar ============
    // FIJO mensual (Bs) de un tenant — compacto, reusa los helpers de consumo de arriba.
    async function _monthlyExpectedBs(tenantId) {
      const tr = await db.query(
        `SELECT price_per_line, price_per_user,
                (to_jsonb(tenants) ->> 'price_per_channel')::numeric AS price_per_channel
           FROM tenants WHERE id = $1`, [tenantId]);
      if (!tr.rows[0]) return 0;
      const t = tr.rows[0];
      const s = await getSchema();
      // v0.9.268 — alinear con /api/me/billing y el panel admin: contar SOLO líneas ACTIVAS y
      // usuarios FACTURABLES (excluir billing_excluded). Antes contaba TODAS → el QR cobraba de más
      // que el "A pagar" mostrado en Mi plan.
      let lines = 0, billableLines = 0, users = 0;
      if (s.lines) {
        const L = s.lines;
        const activeSel = L.active ? `${L.active} AS active` : `TRUE AS active`;
        const exclLineSel = L.excluded ? `COALESCE(${L.excluded}, FALSE)` : `FALSE`;
        const lr = await db.query(`SELECT ${activeSel}, (${exclLineSel}) AS billing_excluded FROM tenant_lines WHERE tenant_id = $1`, [tenantId]);
        const act = L.active ? lr.rows.filter(x => x.active !== false) : lr.rows;
        lines = act.length;
        billableLines = act.filter(x => x.billing_excluded !== true).length; // v0.9.525
      }
      if (s.users) {
        const exclSel = s.users.excluded ? `COALESCE(${s.users.excluded}, FALSE)` : `FALSE`;
        const ur = await db.query(`SELECT (${exclSel}) AS billing_excluded FROM tenant_users WHERE tenant_id = $1`, [tenantId]);
        users = ur.rows.filter(x => x.billing_excluded !== true).length;
      }
      const billableUsers = Math.max(0, users - lines);
      const cfg = await readConsumptionConfig();
      const chMap = await channelsCountMap();
      const ppc = t.price_per_channel != null ? Number(t.price_per_channel) : Number(cfg.default_price_per_channel);
      const channels = Number(chMap[tenantId] || 0);
      return billableLines * Number(t.price_per_line || 0) + billableUsers * Number(t.price_per_user || 0) + channels * ppc; // v0.9.525
    }

    // Lee el comprobante con Gemini visión → JSON estructurado. Best-effort (no rompe si falla).
    async function _ocrComprobante(buffer, mimeType, tenantId) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return { error: 'sin_gemini' };
      const axios = require('axios');
      const prompt = `Sos un lector de comprobantes de pago bancarios de Bolivia (BNB, BCP, BISA, Banco Unión, etc.).
Mirá la imagen y devolvé SOLO un JSON (sin texto extra, sin markdown) con EXACTAMENTE estas claves:
{"banco_origen": string|null, "fecha": "YYYY-MM-DD"|null, "hora": string|null, "originante": string|null, "monto": number|null, "moneda": string|null, "cuenta_destino": string|null, "nombre_destinatario": string|null, "banco_destino": string|null, "nro_comprobante": string|null, "es_comprobante": boolean, "confianza": number}
Reglas: "monto" como número sin separador de miles (ej 1400.00). "nro_comprobante" = el identificador de transacción/comprobante más largo y único que veas. "es_comprobante"=false si la imagen NO es un comprobante de transferencia/pago. "confianza" entre 0 y 1 según qué tan legible y completo está.`;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_MODEL}:generateContent?key=${apiKey}`;
      try {
        const gr = await axios.post(url, {
          contents: [{ parts: [
            { inline_data: { mime_type: mimeType || 'image/jpeg', data: buffer.toString('base64') } },
            { text: prompt },
          ] }],
          generationConfig: { temperature: 0, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } },
        }, { timeout: 40000, headers: { 'Content-Type': 'application/json' } });
        try {
          const um = gr.data && gr.data.usageMetadata;
          if (um) {
            const pt = Number(um.promptTokenCount) || 0, ot = Number(um.candidatesTokenCount) || 0;
            await db.query(`INSERT INTO ai_usage (tenant_id, model, prompt_tokens, output_tokens, total_tokens) VALUES ($1,$2,$3,$4,$5)`,
              [tenantId, _GEM_MODEL, pt, ot, Number(um.totalTokenCount) || (pt + ot)]).catch(() => {});
          }
        } catch (_) {}
        const txt = (gr.data && gr.data.candidates && gr.data.candidates[0] && gr.data.candidates[0].content
          && gr.data.candidates[0].content.parts && gr.data.candidates[0].content.parts[0]
          && gr.data.candidates[0].content.parts[0].text) || '';
        const mm = txt.match(/\{[\s\S]*\}/);
        if (!mm) return { error: 'sin_json' };
        return { data: JSON.parse(mm[0]) };
      } catch (e) {
        return { error: (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message };
      }
    }

    // ¿la cuenta destino del comprobante coincide con la cuenta de cobro de SG? (la cuenta sale
    // enmascarada, ej 701****358 → match por prefijo+sufijo visibles + banco).
    function _accountMatches(ext, cfg) {
      const acc = String(cfg.collection_account || '').replace(/\D/g, '');
      const destRaw = String(ext.cuenta_destino || '');
      const digits = destRaw.replace(/[^0-9]/g, '');
      if (!acc || digits.length < 6) return false; // sin cuenta configurada o sin dato suficiente
      const pre = digits.slice(0, 3), suf = digits.slice(-3);
      const okNum = acc.startsWith(pre) && acc.endsWith(suf);
      const bank = String(cfg.collection_bank || '').toLowerCase().split(/\s+/)[0];
      const okBank = !bank || String(ext.banco_destino || '').toLowerCase().includes(bank);
      return okNum && okBank;
    }

    // acredita un pago: ledger + saldo + (si cubre el mes) avanza vencimiento y saca de past_due.
    async function _applyPaymentCredit(tenantId, amountBs, ref, coversPeriod) {
      await db.query(`INSERT INTO billing_ledger (tenant_id, type, amount_bs, description, ref) VALUES ($1,'credit',$2,$3,$4)`,
        [tenantId, amountBs, 'Pago por QR acreditado', ref]);
      if (coversPeriod) {
        await db.query(`UPDATE tenants SET
            billing_balance_bs = COALESCE(billing_balance_bs,0) + $2,
            billing_status = CASE WHEN billing_status = 'past_due' THEN 'active' ELSE billing_status END,
            billing_next_due_date = CASE
              WHEN billing_next_due_date IS NULL OR billing_next_due_date < CURRENT_DATE THEN (CURRENT_DATE + INTERVAL '1 month')::date
              ELSE (billing_next_due_date + INTERVAL '1 month')::date END
          WHERE id = $1`, [tenantId, amountBs]);
      } else {
        await db.query(`UPDATE tenants SET billing_balance_bs = COALESCE(billing_balance_bs,0) + $2 WHERE id = $1`, [tenantId, amountBs]);
      }
    }

    // v0.9.213 — acredita un pago APROBADO (auto o manual): saldo + vencimiento + billing_payments
    // (lo que muestra "Mi plan") + marca el comprobante approved/applied. Única fuente de verdad.
    async function _creditPayment(pay) {
      const tenantId = pay.tenant_id;
      const amount = Number(pay.amount_bs) || 0;
      const _aPagar = await _amountDueBs(tenantId); // total ANTES de este pago (fijo + variable − descuento)
      const _coversTotal = amount >= _aPagar - 0.5 && _aPagar > 0;
      await _applyPaymentCredit(tenantId, amount, 'pay#' + pay.id, _coversTotal);
      const _period = new Date().toISOString().slice(0, 7);
      await db.query(`INSERT INTO billing_payments (tenant_id, period, concept, amount, method, note, receipt_url) VALUES ($1,$2,'monthly',$3,'Comprobante QR',$4,$5)`,
        [tenantId, _period, amount, 'Comprobante #' + pay.id, pay.image_url || null]).catch((e) => console.warn('[pagos] billing_payments insert:', e.message));
      // v0.9.275 — si el pago CUBRE EL TOTAL adeudado: saldar fijo + avanzar cursor del variable + consumir referidos.
      if (_coversTotal) await _closeBillingPeriod(tenantId, _period);
      await db.query(`UPDATE tenant_payments SET status='approved', applied_at = NOW() WHERE id = $1`, [pay.id]);
    }

    // POST /api/me/billing/upload-comprobante — el tenant sube su comprobante. OCR → verifica →
    // auto-acredita si el score es alto + cuenta/monto/fecha OK + nº único; si no, queda 'pending'.
    app.post('/api/me/billing/upload-comprobante', requireTenantSession, async (req, res) => {
      const tenantId = req.tenantId;
      if (!tenantId) return res.status(400).json({ ok: false, error: 'sesión sin tenant' });
      const dataUrl = String((req.body && req.body.image) || '');
      const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ ok: false, error: 'Mandá la imagen del comprobante.' });
      const mime = m[1];
      const buffer = Buffer.from(m[2], 'base64');
      if (buffer.length > 1500000) return res.status(413).json({ ok: false, error: 'La imagen es muy pesada. Sacá una captura más liviana (o esperá: el panel la comprime sola).' });
      try {
        let imageUrl = null;
        try { const up = await r2.upload({ buffer, mimeType: mime, prefix: 'payments', filename: `comprobante-${tenantId}-${Date.now()}` }); imageUrl = up && up.url; } catch (e) { console.warn('[pagos] R2 upload falló:', e.message); }

        const ocr = await _ocrComprobante(buffer, mime, tenantId);
        const ext = (ocr && ocr.data) || {};
        const conf = Number(ext.confianza) || 0;
        const amount = Number(ext.monto) || 0;
        const nro = ext.nro_comprobante ? String(ext.nro_comprobante).slice(0, 80) : null;

        const pcfg = await db.query(`SELECT collection_bank, collection_account, collection_holder, ocr_autoapprove_score FROM platform_pricing WHERE id = 1`).catch(() => ({ rows: [] }));
        const cfg = pcfg.rows[0] || {};
        const threshold = Number(cfg.ocr_autoapprove_score) || 0.90;
        const expected = await _monthlyExpectedBs(tenantId);

        const checks = {
          es_comprobante: ext.es_comprobante !== false,
          cuenta_ok: _accountMatches(ext, cfg),
          monto_ok: amount > 0 && (expected <= 0 || amount >= expected),
          fecha_ok: !ext.fecha || (Date.now() - Date.parse(ext.fecha)) < 8 * 86400000,
          score_ok: conf >= threshold,
        };
        const allOk = checks.es_comprobante && checks.cuenta_ok && checks.monto_ok && checks.fecha_ok && checks.score_ok;
        const decision = allOk ? 'approved' : 'pending';
        const reason = allOk ? null : Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(',');

        let payId;
        try {
          const ins = await db.query(
            `INSERT INTO tenant_payments (tenant_id, source, status, image_url, amount_bs, nro_comprobante, extracted, confidence, reason)
             VALUES ($1,'ocr',$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
            [tenantId, decision, imageUrl, amount || null, nro, JSON.stringify(ext), conf || null, reason]);
          payId = ins.rows[0].id;
        } catch (e) {
          if (/uq_tenant_payments_compro|duplicate key/.test(e.message)) {
            return res.json({ ok: true, status: 'rejected', reason: 'comprobante_repetido', message: 'Ese comprobante ya fue registrado antes.' });
          }
          throw e;
        }

        if (decision === 'approved') {
          await _creditPayment({ id: payId, tenant_id: tenantId, amount_bs: amount, image_url: imageUrl });
          return res.json({ ok: true, status: 'approved', amount_bs: amount, message: '✅ Pago acreditado. ¡Gracias!' });
        }
        return res.json({ ok: true, status: 'pending', message: 'Recibimos tu comprobante. Lo verificamos y te confirmamos en breve.', checks });
      } catch (e) {
        console.error('[pagos] upload-comprobante:', e.message);
        res.status(500).json({ ok: false, error: e.message });
      }
    });
    // ===== v0.9.213 — REVISIÓN de comprobantes (super-admin): pendientes + aprobar/rechazar =====
    app.get('/api/admin/payments/pending', requireAdmin, async (req, res) => {
      try {
        // v0.9.217 — solo PENDIENTES: la pestaña es la cola de aprobación. La imagen de los
        // ya acreditados se ve con el botón "Ver" en el historial de pagos de cada tenant.
        const r = await db.query(
          `SELECT p.id, p.tenant_id, t.name AS tenant_name, p.status, p.image_url, p.amount_bs,
                  p.nro_comprobante, p.extracted, p.confidence, p.reason, p.created_at
             FROM tenant_payments p LEFT JOIN tenants t ON t.id = p.tenant_id
            WHERE p.status = 'pending' ORDER BY p.created_at DESC LIMIT 100`);
        res.json({ ok: true, payments: r.rows });
      } catch (e) {
        if (/tenant_payments/.test(e.message)) return res.json({ ok: true, payments: [], needs_migration: true });
        res.status(500).json({ ok: false, error: e.message });
      }
    });
    app.post('/api/admin/payments/:id/approve', requireAdmin, async (req, res) => {
      const pid = parseInt(req.params.id, 10);
      if (!pid) return res.status(400).json({ ok: false, error: 'id inválido' });
      try {
        const pr = await db.query(`SELECT id, tenant_id, amount_bs, status, image_url FROM tenant_payments WHERE id = $1`, [pid]);
        const pay = pr.rows[0];
        if (!pay) return res.status(404).json({ ok: false, error: 'pago no encontrado' });
        if (pay.status === 'approved') return res.json({ ok: true, already: true });
        // permitir corregir el monto a mano si el OCR leyó mal
        if (req.body && req.body.amount_bs != null) {
          const a = Number(req.body.amount_bs);
          if (Number.isFinite(a) && a >= 0) { pay.amount_bs = a; await db.query(`UPDATE tenant_payments SET amount_bs = $2 WHERE id = $1`, [pid, a]); }
        }
        await _creditPayment(pay);
        res.json({ ok: true, amount_bs: Number(pay.amount_bs) || 0 });
      } catch (e) { console.error('approve payment:', e.message); res.status(500).json({ ok: false, error: e.message }); }
    });
    app.post('/api/admin/payments/:id/reject', requireAdmin, async (req, res) => {
      const pid = parseInt(req.params.id, 10);
      if (!pid) return res.status(400).json({ ok: false, error: 'id inválido' });
      try {
        await db.query(`UPDATE tenant_payments SET status = 'rejected', reason = $2 WHERE id = $1 AND status <> 'approved'`,
          [pid, String((req.body && req.body.reason) || 'rechazado a mano').slice(0, 200)]);
        res.json({ ok: true });
      } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
    });
    console.log('✅ Rutas de revisión de pagos montadas (v0.9.213)');

    console.log('✅ Ruta /api/me/billing/upload-comprobante montada (v0.9.209)');

    console.log('✅ Ruta self-service /api/me/billing montada (v0.9.105)');

    // ============ v0.9.232 — COBROS QR por TENANT (BANECO) + acreditación AUTOMÁTICA ============
    const _baneco = require('./baneco');

    // "A pagar" exacto del tenant (FIJO + consumo en Bs − pagado del período) — mismo cálculo que /api/me/billing.
    async function _amountDueBs(tenantId) {
      const period = new Date().toISOString().slice(0, 7);
      const expected = await _monthlyExpectedBs(tenantId);
      const ccfg = await readConsumptionConfig();
      // v0.9.268 — DEUDA ACUMULADA: el monto del QR suma los meses NO saldados, no solo el actual.
      // Gate de trial: trial/suspended/cancelled NO acumulan (solo el mes actual = como antes).
      let billable = true, createdAt = null, anchorAt = null;
      try {
        const tr = await db.query(`SELECT created_at, (to_jsonb(tenants) ->> 'billing_anchor_at')::timestamptz AS billing_anchor_at, (to_jsonb(tenants) ->> 'billing_status') AS billing_status FROM tenants WHERE id = $1`, [tenantId]);
        if (tr.rows[0]) {
          billable = !['trial', 'suspended', 'cancelled'].includes(String(tr.rows[0].billing_status || '').toLowerCase());
          createdAt = tr.rows[0].created_at;
          anchorAt = tr.rows[0].billing_anchor_at;
        }
      } catch (e) {}
      const due = await _accumulatedDebtBs(tenantId, period, expected, ccfg, billable, anchorAt, createdAt);
      return Math.round(Math.max(0, due) * 100) / 100;
    }

    // Acredita un QR BANECO pagado UNA sola vez (marca paid antes de acreditar → anti-doble). Reusa _applyPaymentCredit.
    async function _creditBanecoQr(row, paymentObj) {
      const upd = await db.query(
        `UPDATE tenant_payment_qr SET status='paid', paid_at=NOW(), payment_json=$2::jsonb WHERE id=$1 AND status='pending' RETURNING tenant_id, amount_bs`,
        [row.id, JSON.stringify(paymentObj || {})]);
      if (upd.rowCount === 0) return false; // otra corrida ya lo acreditó
      const tenantId = upd.rows[0].tenant_id;
      const amount = Number(paymentObj && paymentObj.amount != null ? paymentObj.amount : upd.rows[0].amount_bs) || 0;
      const _aPagar = await _amountDueBs(tenantId); // total ANTES de este pago (fijo + variable − descuento)
      const _coversTotal = amount >= _aPagar - 0.5 && _aPagar > 0;
      await _applyPaymentCredit(tenantId, amount, 'baneco#' + row.qr_id, _coversTotal);
      const _period = new Date().toISOString().slice(0, 7);
      await db.query(`INSERT INTO billing_payments (tenant_id, period, concept, amount, method, note) VALUES ($1,$2,'monthly',$3,'QR BANECO',$4)`,
        [tenantId, _period, amount, 'QR ' + row.qr_id]).catch((e) => console.warn('[baneco] billing_payments:', e.message));
      // v0.9.275 — si el pago CUBRE EL TOTAL: saldar fijo + avanzar cursor del variable + consumir referidos.
      if (_coversTotal) await _closeBillingPeriod(tenantId, _period);
      console.log(`✅ [baneco] QR ${row.qr_id} pagado → acreditado tenant ${tenantId} (${amount} Bs)`);
      return true;
    }

    // POST /api/admin/tenants/:id/baneco-qr — genera QR atado al tenant por su "A pagar" (o monto override).
    app.post('/api/admin/tenants/:id/baneco-qr', requireAdmin, async (req, res) => {
      try {
        if (!_baneco.isConfigured()) return res.status(503).json({ ok: false, error: 'BANECO no está configurado (variables de entorno)' });
        const tenantId = parseInt(req.params.id, 10);
        if (!tenantId) return res.status(400).json({ ok: false, error: 'id inválido' });
        const b = req.body || {};
        const period = new Date().toISOString().slice(0, 7);
        let amount = Number(b.amount);
        if (!(amount > 0)) amount = await _amountDueBs(tenantId);
        if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'El tenant no tiene saldo a pagar este período.' });
        const dueDays = Math.min(Math.max(parseInt(b.dueDays, 10) || 3, 1), 365);
        const dueDate = new Date(Date.now() + dueDays * 86400000).toISOString().slice(0, 10);
        const txId = ('T' + tenantId + '-' + period.replace('-', '') + '-' + Date.now().toString().slice(-6)).slice(0, 30);
        const _tn = (await db.query('SELECT name FROM tenants WHERE id=$1', [tenantId])).rows[0];
        const _desc = (((_tn && _tn.name) ? _tn.name : 'Cobro') + ' ' + _monthEs(period)).slice(0, 100);
        const out = await _baneco.generateQR({
          transactionId: txId, amount, currency: 'BOB',
          description: _desc,
          dueDate, singleUse: true, modifyAmount: false,
        });
        await db.query(
          `INSERT INTO tenant_payment_qr (tenant_id, qr_id, transaction_id, period, amount_bs, currency, status, due_date)
           VALUES ($1,$2,$3,$4,$5,'BOB','pending',$6)`,
          [tenantId, out.qrId, txId, period, amount, dueDate]).catch((e) => console.warn('[baneco] insert qr:', e.message));
        res.json({ ok: true, qrId: out.qrId, qrImage: out.qrImage, transactionId: txId, amount, period, dueDate });
      } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    });

    // v0.9.507 — GET /api/admin/tenants/:id/usdt-request — cobro en USDT por su "A pagar" exacto.
    // Vive DENTRO de este bloque a propósito: necesita _amountDueBs, el mismo cálculo que usa
    // el QR de Baneco. Así el cobro por banco y el cobro en cripto son siempre el MISMO número;
    // si mañana cambia la fórmula de la deuda, cambia para los dos a la vez y no se desfasan.
    app.get('/api/admin/tenants/:id/usdt-request', requireAdmin, async (req, res) => {
      try {
        const tenantId = parseInt(req.params.id, 10);
        if (!tenantId) return res.status(400).json({ ok: false, error: 'id inválido' });
        const bs = await _amountDueBs(tenantId);
        if (!(bs > 0)) return res.status(400).json({ ok: false, error: 'El tenant no tiene saldo a pagar este período.' });
        const out = await require('./usdt').paymentRequest(tenantId, null, { amountBs: bs });
        res.json({ ok: true, ...out });
      } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
    });

    // GET /api/admin/tenants/:id/baneco-qr — últimos QR del tenant (estado).
    app.get('/api/admin/tenants/:id/baneco-qr', requireAdmin, async (req, res) => {
      try {
        const tenantId = parseInt(req.params.id, 10);
        const r = await db.query(`SELECT id, qr_id, amount_bs, period, status, created_at, paid_at FROM tenant_payment_qr WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 10`, [tenantId]);
        res.json({ ok: true, qrs: r.rows });
      } catch (e) {
        if (/tenant_payment_qr/.test(e.message)) return res.json({ ok: true, qrs: [] });
        res.status(500).json({ ok: false, error: e.message });
      }
    });

    // SELF-SERVICE del tenant: genera SU propio QR por su "A pagar" y consulta/acredita.
    app.post('/api/me/billing/baneco-qr', requireTenantSession, async (req, res) => {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) return res.status(400).json({ ok: false, error: 'sesión sin tenant' });
        if (!_baneco.isConfigured()) return res.status(503).json({ ok: false, error: 'El pago con QR no está disponible por ahora.' });
        const period = new Date().toISOString().slice(0, 7);
        const amount = await _amountDueBs(tenantId);
        if (!(amount > 0)) return res.status(400).json({ ok: false, error: 'No tenés saldo a pagar este período.' });
        const dueDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
        const txId = ('T' + tenantId + '-' + period.replace('-', '') + '-' + Date.now().toString().slice(-6)).slice(0, 30);
        const _tn = (await db.query('SELECT name FROM tenants WHERE id=$1', [tenantId])).rows[0];
        const _desc = (((_tn && _tn.name) ? _tn.name : 'Cobro') + ' ' + _monthEs(period)).slice(0, 100);
        const out = await _baneco.generateQR({ transactionId: txId, amount, currency: 'BOB', description: _desc, dueDate, singleUse: true, modifyAmount: false });
        await db.query(`INSERT INTO tenant_payment_qr (tenant_id, qr_id, transaction_id, period, amount_bs, currency, status, due_date) VALUES ($1,$2,$3,$4,$5,'BOB','pending',$6)`,
          [tenantId, out.qrId, txId, period, amount, dueDate]).catch((e) => console.warn('[baneco] insert qr (me):', e.message));
        res.json({ ok: true, qrId: out.qrId, qrImage: out.qrImage, amount, dueDate });
      } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    });
    app.get('/api/me/billing/baneco-qr/:qrId/status', requireTenantSession, async (req, res) => {
      try {
        const tenantId = req.tenantId;
        if (!tenantId) return res.status(400).json({ ok: false, error: 'sesión sin tenant' });
        const own = await db.query(`SELECT id, qr_id, tenant_id, amount_bs, status FROM tenant_payment_qr WHERE qr_id=$1 AND tenant_id=$2`, [req.params.qrId, tenantId]);
        if (!own.rows[0]) return res.status(404).json({ ok: false, error: 'QR no encontrado' });
        const row = own.rows[0];
        if (row.status === 'paid') return res.json({ ok: true, statusQrCode: 1, credited: true });
        const st = await _baneco.getStatus(req.params.qrId);
        let credited = false;
        if (st && st.statusQrCode === 1) credited = await _creditBanecoQr(row, (st.payment && st.payment[0]) || null);
        res.json({ ok: true, statusQrCode: st ? st.statusQrCode : 0, credited });
      } catch (e) { res.status(502).json({ ok: false, error: e.message }); }
    });

    // CRON — poller de QR pendientes: pregunta al banco (statusQR) y acredita los pagados.
    async function _pollBanecoPending() {
      if (!_baneco.isConfigured()) return;
      let rows;
      try {
        const r = await db.query(`SELECT id, qr_id, tenant_id, amount_bs FROM tenant_payment_qr WHERE status='pending' AND (due_date IS NULL OR due_date >= CURRENT_DATE - 2) ORDER BY created_at ASC LIMIT 50`);
        rows = r.rows;
      } catch (e) { return; /* tabla aún no migrada */ }
      for (const row of rows) {
        try {
          const st = await _baneco.getStatus(row.qr_id);
          if (st && st.statusQrCode === 1) {
            await _creditBanecoQr(row, (st.payment && st.payment[0]) || null);
          } else if (st && st.statusQrCode === 9) {
            await db.query(`UPDATE tenant_payment_qr SET status='cancelled' WHERE id=$1 AND status='pending'`, [row.id]).catch(() => {});
          }
        } catch (e) { /* reintenta en la próxima corrida */ }
      }
      await db.query(`UPDATE tenant_payment_qr SET status='expired' WHERE status='pending' AND due_date IS NOT NULL AND due_date < CURRENT_DATE - 2`).catch(() => {});
    }
    setTimeout(() => { _pollBanecoPending().catch(() => {}); }, 60000);
    setInterval(() => { _pollBanecoPending().catch(() => {}); }, 3 * 60000); // cada 3 min
    console.log('✅ [baneco] poller de cobros QR por tenant activo (cada 3 min)');

    console.log('✅ Ruta self-service /api/me/billing montada (v0.9.105)');
  } else {
    console.warn('⚠️  /api/me/billing NO montado: no se encontró requireTenantSession');
  }

  console.log('✅ Rutas admin billing v0.9.25 montadas');
};
