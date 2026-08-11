/**
 * Webhook handlers de Meta + dispatch a n8n.
 *
 * v0.8.1 — Step 2b multi-tenant:
 *   - Resolve tenant from value.metadata.phone_number_id en cada webhook
 *   - INSERTs ahora usan tenant_id real (con fallback a 1 si no se puede resolver)
 *   - processIncomingMessage y processStatusUpdate reciben tenant como argumento
 *
 * v0.7.22 — Integración módulo Follow-up automático:
 *   - markFollowUpResponse: marca follow-ups previos como respondidos cuando llega mensaje incoming
 *   - handleStopWords: detecta "no me escriban más" y desactiva follow-up para esa conversación
 *   Ambas llamadas son non-fatal: si fallan, el webhook principal sigue funcionando.
 */

// v0.9.354 — modelo Gemini vigente (Google retiró gemini-2.5-flash el 9-jul-2026 con 404 intermitente y gemini-1.5 está muerto). Configurable por env sin redeploy.
const _GEM_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const _GEM_FALLBACK = process.env.GEMINI_MODEL_FALLBACK_BACKEND || 'gemini-flash-latest';

const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const meta = require('./meta');
const { decryptSafe } = require('./crypto'); // v0.9.142 comentarios: token de página
const r2 = require('./r2');
const tg = require('./telegram'); // v0.9.281 canal Telegram
const { resolveTenantByPhoneNumberId, getConversationMetaCtx } = require('./tenant-resolver'); // v0.9.67: + ctx para media
const supportTickets = require('./support-tickets'); // v0.9.114 mesa de soporte (BPO)
const { getUsdToBsRate } = require('./catalog-matcher'); // v0.9.346 precio en ambas monedas para el prompt

const META_APP_SECRET = process.env.META_APP_SECRET;
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const N8N_SHARED_SECRET = process.env.N8N_SHARED_SECRET;

// v0.9.192 — debounce del push "mensaje nuevo en chat asignado" (conversationId → ts ms).
// Evita spamear al asesor con un push por cada mensaje del cliente.
const _lastAssignedMsgPush = new Map();
const _lastUnassignedMsgPush = new Map(); // v0.9.526 — debounce del push a chats SIN asignar

// v0.9.114 — cache corto de tenants.support_enabled para los hooks de la mesa de
// soporte. Para tenants de venta devuelve false al toque (skip de todo el hook).
const _supportEnabledCache = new Map();
async function tenantSupportEnabled(tenantId) {
  const c = _supportEnabledCache.get(tenantId);
  if (c && (Date.now() - c.at) < 30000) return c.on;
  let on = false;
  try {
    const r = await db.query('SELECT support_enabled FROM tenants WHERE id = $1', [tenantId]);
    on = !!(r.rows[0] && r.rows[0].support_enabled);
  } catch (e) { /* columna no migrada → false */ }
  _supportEnabledCache.set(tenantId, { at: Date.now(), on });
  return on;
}

// v0.9.439 — alcance de la IA: 'all' (todos los chats) o 'ads_only' (solo los que
// nacen de un anuncio). La línea puede sobreescribir al tenant. Cache 30s.
const _aiScopeCache = new Map();
async function _aiScopeFor(tenantId, lineId) {
  const k = tenantId + ':' + (lineId || 0);
  const c = _aiScopeCache.get(k);
  if (c && (Date.now() - c.at) < 30000) return c.v;
  let v = 'all';
  try {
    if (lineId != null) {
      const lr = await db.query(`SELECT to_jsonb(tenant_lines) ->> 'ai_scope' AS s FROM tenant_lines WHERE id = $1`, [lineId]);
      if (lr.rows[0] && lr.rows[0].s) v = lr.rows[0].s;
    }
    if (v === 'all') {
      const tr = await db.query(`SELECT to_jsonb(tenants) ->> 'ai_scope' AS s FROM tenants WHERE id = $1`, [tenantId]);
      if (tr.rows[0] && tr.rows[0].s === 'ads_only') v = 'ads_only';
    }
  } catch (e) { /* columnas sin migrar → 'all' */ }
  _aiScopeCache.set(k, { v, at: Date.now() });
  return v;
}

// v0.9.155 — MASTER SWITCH de IA. Devuelve si la IA (Aitana) está habilitada para
// el tenant. Defensivo: si la columna ai_enabled no existe aún (deploy antes de la
// migración) o la query falla, devuelve TRUE para NO romper el comportamiento actual.
async function aiEnabled(tenantId, opts = {}) {
  if (!tenantId) return true;
  const lineId = (opts && opts.line_id != null) ? opts.line_id : ((opts && opts.lineId != null) ? opts.lineId : null);
  const channel = (opts && opts.channel) ? String(opts.channel).toLowerCase() : null;
  try {
    // 1) master switch global del tenant
    const r = await db.query('SELECT COALESCE(ai_enabled, TRUE) AS on FROM tenants WHERE id = $1', [tenantId]);
    if (r.rows.length && r.rows[0].on === false) return false;
    // 2) v0.9.285 — IA por LÍNEA (WhatsApp)
    if (lineId != null) {
      try {
        const lr = await db.query('SELECT COALESCE(ai_enabled, TRUE) AS on FROM tenant_lines WHERE id = $1', [lineId]);
        if (lr.rows.length && lr.rows[0].on === false) return false;
      } catch (e) { /* columna no migrada → ignorar */ }
    }
    // 3) v0.9.285 — IA por CANAL (messenger/instagram/telegram)
    if (channel && channel !== 'whatsapp') {
      try {
        const cr = await db.query('SELECT COALESCE(ai_enabled, TRUE) AS on FROM tenant_channels WHERE tenant_id = $1 AND channel = $2 AND active = TRUE LIMIT 1', [tenantId, channel]);
        if (cr.rows.length && cr.rows[0].on === false) return false;
      } catch (e) { /* columna no migrada → ignorar */ }
    }
    return true;
  } catch (e) {
    return true; // error → no bloquear el dispatch
  }
}
const HISTORY_SIZE = parseInt(process.env.WHATSAPP_HISTORY_SIZE || '15', 10);

/**
 * Verificación inicial de Meta (handshake)
 * GET /api/meta/webhook?hub.mode=subscribe&hub.challenge=...&hub.verify_token=...
 */
function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook Meta verificado');
    return res.status(200).type('text/plain').send(challenge);
  }
  console.warn('❌ Verificación de webhook falló', { mode, tokenMatch: token === META_VERIFY_TOKEN });
  return res.status(403).send('Forbidden');
}

/**
 * Verificar firma X-Hub-Signature-256 de Meta para asegurar
 * que el webhook viene realmente de Meta (no falsificado).
 */
function verifySignature(req) {
  if (!META_APP_SECRET) {
    // v0.9.44 (auditoría M-1): FAIL-CLOSED. Antes aceptaba cualquier webhook
    // sin firma si la env se caía — eso permitía inyectar mensajes falsos.
    console.error('🚨 META_APP_SECRET no configurado — RECHAZANDO webhooks (configurala en Railway)');
    return false;
  }
  const signature = req.headers['x-hub-signature-256'] || '';
  if (!signature.startsWith('sha256=')) return false;

  const rawBody = req.rawBody || JSON.stringify(req.body);
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Recibe webhook de Meta (mensajes entrantes y status updates)
 */
async function handleWebhook(req, res) {
  // 1. Validar firma
  if (!verifySignature(req)) {
    console.warn('❌ Firma de Meta inválida');
    return res.status(401).send('Invalid signature');
  }

  const _body = req.body;
  // v0.9.326 — DURABILIDAD: persistimos el payload crudo ANTES del 200. Si el server se
  // reinicia mientras procesa, el worker (runWebhookQueueRecovery) lo reprocesa → cero pérdida.
  let _qid = null;
  try {
    const _q = await db.query(
      `INSERT INTO webhook_events (object, payload, status) VALUES ($1, $2::jsonb, 'pending') RETURNING id`,
      [String((_body && _body.object) || ''), JSON.stringify(_body || {})]);
    _qid = _q.rows[0] ? _q.rows[0].id : null;
  } catch (e) { console.error('[webhook] enqueue falló (se procesa inline igual):', e.message); }

  // Meta espera <20s o reintenta (= duplicados). Respondemos ya; procesamos aparte.
  res.status(200).send('OK');

  processWebhookPayload(_body)
    .then(() => { if (_qid) db.query(`UPDATE webhook_events SET status = 'done', processed_at = NOW() WHERE id = $1`, [_qid]).catch(() => {}); })
    .catch((e) => { console.error('Error procesando webhook (queda pending para reintento):', e.message); });
}

// v0.9.326 — procesamiento del payload de Meta (extraído para reusarlo desde el worker de
// recuperación). Los mensajes ENTRANTES se await-ean (si fallan → payload pending → reintento,
// idempotente por wa_message_id); statuses/echoes/history quedan best-effort.
async function processWebhookPayload(body) {
    // v0.9.130 — OMNICANAL: Instagram DM y Facebook Messenger llegan con OTRA forma
    // (object 'instagram'/'page', entry[].messaging[]). Se rutean aparte; el camino
    // de WhatsApp (object 'whatsapp_business_account') sigue exactamente igual.
    const _obj = body?.object;
    if (_obj === 'instagram' || _obj === 'page') {
      await handleMessengerWebhook(body);
      return;
    }
    const entries = body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        // v0.9.52: PROTECCIÓN DEL NÚMERO — Meta avisa por webhook cuando el
        // quality rating baja o el número queda FLAGGED/RESTRICTED. Se registra
        // el evento y se PAUSAN las campañas programadas del tenant.
        if (change.field === 'phone_number_quality_update' || change.field === 'account_update') {
          handleQualityUpdate(entry, change).catch(e => console.error('quality update error:', e.message));
          continue;
        }
        // v0.9.57 COEXISTENCE SYNC — campos extra que Meta manda cuando el número
        // está en modo coexistence (el dueño sigue usando su app de WhatsApp Business):
        //   - smb_message_echoes / message_echoes: mensajes que el DUEÑO envió desde su app
        //   - history: backfill de hasta 180 días al conectar el número
        //   - smb_app_state_sync: contactos del teléfono
        const isCoexField = ['smb_message_echoes', 'history', 'smb_app_state_sync'].includes(change.field);
        if (change.field !== 'messages' && !isCoexField) continue;
        const value = change.value || {};

        // Step 2b: resolver tenant a partir del phone_number_id que Meta envía.
        // Cada tenant tiene su propio número de WhatsApp Business.
        const phoneNumberId = value.metadata?.phone_number_id || null;
        let tenant = null;
        if (phoneNumberId) {
          tenant = await resolveTenantByPhoneNumberId(phoneNumberId);
        }
        if (!tenant) {
          // v0.9.44 (auditoría A-4): SIN fallback a tenant 1. Un phone_number_id
          // desconocido inyectaba mensajes en la cuenta de SG Bolivia (mezcla de
          // datos / vector de spoofing). Ahora se descarta y queda en logs.
          console.error(`🚨 [webhook] phone_number_id="${phoneNumberId}" no matchea ningún tenant — mensaje DESCARTADO (¿línea sin registrar en lines?)`);
          continue;
        }

        for (const message of value.messages || []) {
          await processIncomingMessage(message, value.contacts || [], tenant);
        }

        for (const status of value.statuses || []) {
          processStatusUpdate(status, tenant).catch(e =>
            console.error('Error procesando status:', e)
          );
        }

        // v0.9.57: ECHOES — mensajes que el dueño escribió desde su propia app.
        // Pueden venir bajo el campo smb_message_echoes (value.message_echoes) o,
        // en algunas cuentas, mezclados en value.message_echoes del campo messages.
        for (const echo of value.message_echoes || []) {
          processMessageEcho(echo, value.contacts || [], tenant).catch(e =>
            console.error('Error procesando echo:', e)
          );
        }

        // v0.9.57: HISTORY — backfill de conversaciones previas (al conectar).
        // v0.9.100: red de seguridad — logueamos y PERSISTIMOS la llegada del evento
        // history apenas entra (aunque venga vacío o con forma inesperada), así los
        // onboardings de coexistence dejan de ser una caja negra. Se audita en
        // quality_events (sobrevive a la rotación de logs).
        if (change.field === 'history') {
          const hist = Array.isArray(value.history) ? value.history : [];
          let threadsClaimed = 0, msgsClaimed = 0;
          for (const h of hist) for (const th of (h.threads || [])) { threadsClaimed++; msgsClaimed += (th.messages || []).length; }
          const summary = `threads=${threadsClaimed} msgs=${msgsClaimed} es_array=${Array.isArray(value.history)}`;
          // v0.9.457 — RUIDO DE LOGS. Durante el backfill, Meta manda MUCHÍSIMOS eventos
          // con field='history' cuyo value NO trae `history` sino `messages`/`message_echoes`
          // sueltos. Esos ya los procesaron los loops de arriba (líneas 226 y 239), o sea
          // que NO se pierde nada — pero igual logueábamos "EVENTO history RECIBIDO
          // threads=0" + un ⚠️ "vino vacío o con forma inesperada" por cada uno. En el
          // onboarding del tenant 12 fueron 1563 warnings falsos contra 52 eventos reales:
          // el ruido tapaba por completo el sync que SÍ funcionó (60.968 mensajes).
          // Ahora: si el value trae mensajes/echoes y no trae `history`, ya está atendido
          // y se loguea en debug; el ⚠️ queda solo para un history REALMENTE vacío.
          const yaAtendido = !value.history
            && ((value.messages || []).length > 0 || (value.message_echoes || []).length > 0);
          if (!yaAtendido) {
            console.log(`🕓 [coexistence] EVENTO history RECIBIDO (tenant ${tenant.id}, waba ${entry.id || '?'}): ${summary}`);
          }
          db.query(
            `INSERT INTO quality_events (tenant_id, waba_id, phone_number, field, event, detail)
             VALUES ($1,$2,$3,'history','HISTORY_RECEIVED',$4)`,
            [tenant.id, String(entry.id || ''), (value.metadata && value.metadata.display_phone_number) || null,
             JSON.stringify({ summary, threadsClaimed, msgsClaimed, value_keys: Object.keys(value || {}) }).slice(0, 4000)]
          ).catch(e => { if (!/quality_events/.test(e.message)) console.error('history audit insert:', e.message); });
          if (hist.length > 0) {
            processHistorySync(hist, tenant).catch(e =>
              console.error('Error procesando history:', e)
            );
          } else if (!yaAtendido) {
            console.warn(`⚠️ [coexistence] history llegó SIN threads procesables (tenant ${tenant.id}) — Meta mandó el evento pero vacío o con forma inesperada. value keys: [${Object.keys(value || {}).join(', ')}]`);
          }
        }
      }
    }}


/**
 * Procesa un mensaje entrante: idempotencia, guarda en BD, dispara dispatch a n8n.
 * @param {Object} message    - el mensaje de Meta
 * @param {Array} contacts    - contactos del payload (para nombre)
 * @param {Object} tenant     - tenant resuelto (Step 2b). Default tenant=1 si llamada legacy.
 */
// v0.9.52: registra eventos de calidad de Meta y actúa si son graves.
// entry.id = WABA id → tenant por tenants.waba_id (best effort).
async function handleQualityUpdate(entry, change) {
  const v = change.value || {};
  const event = String(v.event || v.decision || '').toUpperCase();
  const phone = v.display_phone_number || v.phone_number || null;
  let tenantId = null;
  try {
    const t = await db.query(`SELECT id FROM tenants WHERE waba_id = $1 LIMIT 1`, [String(entry.id || '')]);
    tenantId = t.rows[0]?.id || null;
    // v0.9.68: las WABAs conectadas como LÍNEA (multi-línea/onboarding) viven en
    // tenant_lines — sin esto el evento quedaba con tenant NULL y no pausaba nada.
    if (!tenantId) {
      const tl = await db.query(`SELECT tenant_id FROM tenant_lines WHERE waba_id = $1 LIMIT 1`, [String(entry.id || '')]);
      tenantId = tl.rows[0]?.tenant_id || null;
    }
  } catch (e) {}
  try {
    await db.query(
      `INSERT INTO quality_events (tenant_id, waba_id, phone_number, field, event, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, String(entry.id || ''), phone, change.field, event || null, JSON.stringify(v)]
    );
  } catch (e) { if (!/quality_events/.test(e.message)) console.error('quality_events insert:', e.message); }

  // v0.9.63: eventos BENIGNOS del ciclo de vida (p.ej. PARTNER_APP_INSTALLED =
  // nuestra propia app instalada en la WABA durante el onboarding) — se guardan
  // para auditoría pero NO son alertas de calidad ni pausan nada.
  const benign = /^(PARTNER_APP_INSTALLED|PARTNER_ADDED|PARTNER_REMOVED|ACCOUNT_VERIFIED|BUSINESS_VERIFICATION_APPROVED|AD_ACCOUNT_LINKED|WABA_BANNED_REVERSAL)$/i.test(event);
  // v0.9.68 (auditoría 12-jun): "grave" se evalúa SOLO sobre el campo event con
  // límites de palabra — antes se buscaba el substring en el JSON ENTERO del
  // payload y cualquier campo con "ban"/"lower" pausaba todas las campañas.
  // UNFLAGGED (= el número se RECUPERÓ) no es grave.
  const grave = !benign && !/^UN/i.test(event) &&
    /\b(FLAGGED|RESTRICTED|DOWNGRADED?|DISABLED?(_UPDATE)?|BANNED?|LOWER(ED)?|ACCOUNT_RESTRICTION|ACCOUNT_VIOLATION)\b/i.test(event);
  if (benign) {
    console.log(`ℹ️ [Meta] Evento informativo ${change.field} → ${event} (tenant ${tenantId || '?'}, ${phone || 's/n'})`);
  } else {
    console[grave ? 'error' : 'warn'](`${grave ? '🚨' : '⚠️'} [calidad Meta] ${change.field} → ${event || '(ver detail)'} (tenant ${tenantId || '?'}, ${phone || 's/n'})`);
  }
  if (grave && tenantId) {
    try {
      // v0.9.68: pausa también las RUNNING (runBroadcast chequea el status y
      // corta el loop) — antes una campaña en curso seguía enviando con el
      // número ya marcado por Meta.
      const r = await db.query(
        `UPDATE template_campaigns SET status='cancelled', finished_at=NOW()
         WHERE tenant_id = $1 AND status IN ('scheduled', 'running') RETURNING id`,
        [tenantId]
      );
      if (r.rows.length) console.error(`🚨 [calidad Meta] ${r.rows.length} campaña(s) PAUSADAS (programadas y en curso) para proteger el número del tenant ${tenantId}`);
    } catch (e) {}
  }
}

// v0.9.57 — COEXISTENCE: guarda en el CRM un mensaje que el DUEÑO envió desde
// su propia app de WhatsApp Business (echo). Queda como saliente/humano y, para
// que Aitana no hable por encima, pasa la conversación a modo 'human'.
// Dedup por wa_message_id (los envíos de Aitana por API no se re-insertan).
async function processMessageEcho(echo, contacts, tenant = { id: 1 }) {
  const tenantId = tenant.id || 1;
  const waId = echo.id || null;
  // En un echo, el destinatario (cliente) es 'to'; el remitente es la línea del negocio.
  const customerPhone = echo.to || echo.recipient_id || null;
  if (!customerPhone) return;

  // Dedup: si ya existe ese wa_message_id (p.ej. lo mandó Aitana por API), salir.
  if (waId) {
    const dup = await db.query('SELECT 1 FROM messages WHERE wa_message_id = $1 LIMIT 1', [waId]).catch(() => ({ rows: [] }));
    if (dup.rows.length) return;
  }

  const type = echo.type || 'text';
  const { body, mediaCaption } = extractContent(echo, type);
  const text = body || mediaCaption || (type !== 'text' ? `[${type}]` : null);

  const contactName = (contacts.find(c => c.wa_id === customerPhone)?.profile?.name) || null;
  const convRes = await db.query(
    `INSERT INTO conversations (tenant_id, phone, contact_name, mode, status, last_message_at, line_id)
     VALUES ($1, $2, $3, 'human', 'open', NOW(), $4)
     ON CONFLICT (tenant_id, phone, COALESCE(line_id, 0)) DO UPDATE
       SET contact_name = COALESCE(conversations.contact_name, EXCLUDED.contact_name),
           last_message_at = NOW(),
           mode = 'human',  -- el dueño está atendiendo desde su teléfono
           status = CASE WHEN conversations.status = 'archived' THEN 'open' ELSE conversations.status END
     RETURNING *`,
    [tenantId, customerPhone, contactName, tenant.line_id || null]
  ).catch(async (e) => {
    if (!/line_id/.test(e.message)) throw e;
    return db.query(
      `INSERT INTO conversations (tenant_id, phone, contact_name, mode, status, last_message_at)
       VALUES ($1, $2, $3, 'human', 'open', NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET last_message_at = NOW(), mode = 'human',
             status = CASE WHEN conversations.status = 'archived' THEN 'open' ELSE conversations.status END
       RETURNING *`,
      [tenantId, customerPhone, contactName]
    );
  });
  const conv = convRes.rows[0];

  await db.query(
    `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status)
     VALUES ($1, $2, 'outgoing', 'human', $3, $4, 'sent')`,
    [conv.id, waId, type, text]
  ).catch(e => console.error('echo insert:', e.message));
  console.log(`📲 [coexistence] mensaje del dueño (su app) → CRM: conv=${conv.id} to=${customerPhone}`);

  // v0.9.495 — TRANSCRIBIR también los audios SALIENTES (nota de voz que el dueño
  // manda desde SU app de WhatsApp). Antes quedaban como "[audio]" mudo en el CRM:
  // el equipo no sabía qué se le dijo al cliente, y la IA tampoco (contexto ciego).
  // Mismo pipeline que los entrantes (descarga con el token de la línea → R2 →
  // Gemini), pero en 2do plano: el echo se registra al toque y la transcripción
  // llega unos segundos después vía UPDATE (el panel ya muestra `transcription`
  // para cualquier dirección). Best-effort: si falla, el mensaje queda como antes.
  const _echoMediaId = (type === 'audio' && echo.audio && echo.audio.id) ? echo.audio.id : null;
  if (_echoMediaId && waId) {
    setImmediate(async () => {
      try {
        const mediaCtx = await getConversationMetaCtx({ line_id: tenant.line_id || null, tenant_id: tenantId }).catch(() => null);
        const mediaData = await meta.downloadMedia(_echoMediaId, mediaCtx);
        if (!mediaData || !mediaData.buffer) return;
        let mediaUrl = null;
        if (r2.isConfigured()) {
          try {
            const mime = mediaData.mimeType || (echo.audio && echo.audio.mime_type) || 'audio/ogg';
            const up = await r2.upload({ buffer: mediaData.buffer, mimeType: mime, prefix: 'outgoing', filename: `audio-${Date.now()}.${mimeToExtension(mime, 'audio')}` });
            mediaUrl = up.url;
          } catch (e) { /* sin R2 no hay reproductor, pero la transcripción va igual */ }
        }
        const txt = await analyzeMediaWithGeminiBuffer(
          mediaData.buffer, mediaData.mimeType || 'audio/ogg', 'audio',
          { tenantId, conversationId: conv.id, phone: customerPhone }
        );
        if (txt || mediaUrl) {
          await db.query(
            `UPDATE messages SET transcription = COALESCE($1, transcription), media_url = COALESCE($2, media_url), media_id = $3, media_mime_type = COALESCE($4, media_mime_type) WHERE wa_message_id = $5`,
            [txt || null, mediaUrl, _echoMediaId, mediaData.mimeType || null, waId]);
          console.log(`🎙️  [coexistence] audio saliente transcrito (conv=${conv.id}, ${txt ? txt.length + ' chars' : 'sin texto'})`);
        }
      } catch (e) { console.warn('⚠️  [coexistence] transcripción de audio saliente falló:', e.message); }
    });
  }
  // v0.9.114 — si la convo es de soporte, registrar la 1ª respuesta humana (idempotente).
  if (conv && conv.plane === 'soporte') {
    try { await supportTickets.recordFirstResponse({ tenantId: conv.tenant_id, conversationId: conv.id }); } catch (e) {}
  }
}

// v0.9.57 — COEXISTENCE: backfill de historial al conectar el número (hasta 180d).
// value.history es un array de objetos con threads; cada thread tiene messages.
// Best-effort: insertamos lo que se pueda, deduplicando por wa_message_id.
// v0.9.69 (auditoría 12-jun P1#9): el backfill ya NO pisa last_message_at con
// NOW() (reordenaba todo el inbox y metía contactos de hace meses en las
// audiencias "todos"/"inactivos") — usa el timestamp ORIGINAL del mensaje.
// Además: tope de mensajes por sync (Meta puede mandar 180 días de historial)
// y las conversaciones importadas nacen ARCHIVADAS (el dueño las ve en
// Archivadas; si el cliente vuelve a escribir, el flujo normal la reabre).
const HISTORY_SYNC_MAX_MSGS = parseInt(process.env.HISTORY_SYNC_MAX_MSGS || '2000', 10);
// v0.9.518 — BACKFILL GENTIL. Antes esto hacía, por CADA mensaje (hasta 2000), un
// SELECT de duplicado + un INSERT, todo secuencial: ~4000 consultas seguidas que
// inundaban la base justo cuando el dueño recién conectado usaba el wizard, y le
// dejaban las requests haciendo cola en una base saturada (por eso el wizard se
// "colgaba"). Ahora:
//   · el SELECT de duplicado se ELIMINA — wa_message_id ya es UNIQUE, así que la
//     base rechaza los repetidos sola con ON CONFLICT DO NOTHING;
//   · los mensajes entran en LOTES (multi-fila) en vez de uno por uno;
//   · entre lote y lote se cede un instante para no monopolizar la conexión.
// La carga cae >90% y el historial deja de competir con el resto del panel.
const HISTORY_BATCH = 200;

async function _insertMessageBatch(rows) {
  if (!rows.length) return 0;
  // 8 columnas por fila; 'sent' va literal (no parametrizado) para no gastar placeholders.
  const vals = [];
  const params = [];
  let i = 0;
  for (const r of rows) {
    vals.push(`($${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, 'sent', $${i + 7})`);
    params.push(r.conversation_id, r.wa_message_id, r.direction, r.sender_type, r.type, r.body, r.created_at);
    i += 7;
  }
  const q = `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, status, created_at)
             VALUES ${vals.join(', ')} ON CONFLICT (wa_message_id) DO NOTHING`;
  const r = await db.query(q, params).catch((e) => { console.warn('[coexistence] batch insert:', e.message); return { rowCount: 0 }; });
  return r.rowCount || 0;
}

async function processHistorySync(historyArr, tenant = { id: 1 }) {
  const tenantId = tenant.id || 1;
  let inserted = 0, threads = 0, capped = false, considerados = 0;
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    inserted += await _insertMessageBatch(batch);
    batch = [];
    // Ceder el turno: deja que las consultas del wizard (y del resto) pasen entre lotes.
    await new Promise((res) => setTimeout(res, 25));
  };

  for (const h of historyArr) {
    for (const thread of h.threads || []) {
      if (considerados >= HISTORY_SYNC_MAX_MSGS) { capped = true; break; }
      threads++;
      const customerPhone = thread.id || thread.wa_id || null;
      if (!customerPhone) continue;

      const msgs = thread.messages || [];
      let maxTs = null;
      for (const m of msgs) {
        const t = m.timestamp ? parseInt(m.timestamp) * 1000 : null;
        if (t && (!maxTs || t > maxTs)) maxTs = t;
      }
      const lastAt = maxTs ? new Date(maxTs) : new Date(0);

      const conv = await db.query(
        `INSERT INTO conversations (tenant_id, phone, mode, status, last_message_at, line_id)
         VALUES ($1, $2, 'human', 'archived', $3, $4)
         ON CONFLICT (tenant_id, phone, COALESCE(line_id, 0)) DO UPDATE
           SET last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at)
         RETURNING id`,
        [tenantId, customerPhone, lastAt, tenant.line_id || null]
      ).then(r => r.rows[0]).catch(() => null);
      if (!conv) continue;

      for (const m of msgs) {
        if (considerados >= HISTORY_SYNC_MAX_MSGS) { capped = true; break; }
        considerados++;
        const waId = m.id || null;
        const type = m.type || 'text';
        const { body, mediaCaption } = extractContent(m, type);
        const text = body || mediaCaption || (type !== 'text' ? `[${type}]` : null);
        const fromCustomer = m.from && String(m.from) === String(customerPhone);
        const ts = m.timestamp ? new Date(parseInt(m.timestamp) * 1000) : new Date();
        batch.push({
          conversation_id: conv.id, wa_message_id: waId,
          direction: fromCustomer ? 'incoming' : 'outgoing',
          sender_type: fromCustomer ? 'customer' : 'human',
          type, body: text, created_at: ts,
        });
        if (batch.length >= HISTORY_BATCH) await flush();
      }
    }
    if (capped) break;
  }
  await flush();
  console.log(`🕓 [coexistence] history sync: ${threads} conversaciones, ${inserted} mensajes importados (tenant ${tenantId})${capped ? ` — TOPE ${HISTORY_SYNC_MAX_MSGS} alcanzado, resto omitido` : ''}`);
}


// v0.9.364 — Extraer el puntaje CSAT de CUALQUIER formato en que WhatsApp entregue la respuesta:
//   a) interactive.button_reply.id = "csat:N" (tap normal)
//   b) message.button.payload/text (formato legacy — pasa con taps sobre encuestas viejas)
//   c) texto plano "😀 Buena" / "Regular" / "😞 Mala" (algunos clientes degradan el tap a texto)
//   d) texto "1".."5"
// Devuelve '1'..'5' o null. El caso (c) solo matchea el texto EXACTO de los botones CSAT.
function _csatScoreFromMessage(message, body) {
  const ir = message && message.interactive && message.interactive.button_reply;
  let m = String((ir && ir.id) || '').match(/^csat:([1-5])$/);
  if (m) return m[1];
  const lb = message && message.button; // legacy
  m = String((lb && lb.payload) || '').match(/^csat:([1-5])$/);
  if (m) return m[1];
  const texts = [ir && ir.title, lb && lb.text, body];
  for (const t of texts) {
    const s = String(t || '').trim();
    if (!s) continue;
    if (/^([1-5])$/.test(s)) return s.match(/^([1-5])$/)[1];
    const clean = s.replace(/^[^A-Za-zÁÉÍÓÚáéíóúÑñ]*/, '').toLowerCase(); // saca el emoji/espacios del inicio
    if (clean === 'buena') return '5';
    if (clean === 'regular') return '3';
    if (clean === 'mala') return '1';
  }
  return null;
}

// v0.9.521 — REFERRAL TARDÍO DE ANUNCIO. Caso real confirmado (leads Lux Tower /
// Delta, tenant 12 línea 14): Meta reenvía el MISMO wa_message_id de un lead de
// Click-to-WhatsApp primero como tipo 'unsupported' (SIN referral) y ~1s después
// como 'text' CON el referral completo ({source_type:'ad', ctwa_clid, source_url…}).
// La 1ra copia insertó el mensaje y —en líneas ads_only— dejó el chat en "humano
// silencioso" por no ver anuncio; la 2da copia caía en el dedup de idempotencia y el
// origen-anuncio se perdía → el lead nunca era atendido por Aitana. Acá, si una copia
// duplicada trae un referral de anuncio, lo aplicamos igual: guardamos referral,
// marcamos ai_origin='ads', matcheamos el inmueble y —si el chat estaba silenciado
// sin toma humana explícita— lo promovemos a BOT y despachamos para que Aitana
// conteste al instante. Devuelve true si promovió.
async function applyLateAdReferral(message, tenantId, from, lineId) {
  const _ref = message && message.referral;
  if (!_ref || !(_ref.source_type || _ref.source_url || _ref.ctwa_clid)) return false;
  let conv;
  try {
    const cr = await db.query(
      `SELECT * FROM conversations
        WHERE tenant_id = $1 AND phone = $2 AND COALESCE(line_id, 0) = COALESCE($3, 0)
        LIMIT 1`, [tenantId, from, lineId || null]);
    conv = cr.rows[0];
  } catch (e) { console.warn('[ads-late-referral] lookup', e.message); return false; }
  if (!conv) return false;
  const _prevOrigin = conv.ai_origin || null;
  if (_prevOrigin === 'ads' && conv.mode === 'bot') return false; // ya estaba aplicado

  await db.query(
    `UPDATE conversations SET referral = COALESCE(conversations.referral, $1::jsonb), ai_origin = 'ads' WHERE id = $2`,
    [JSON.stringify(_ref), conv.id]).catch(() => {});
  conv.ai_origin = 'ads';

  // Match anuncio ↔ inmueble del catálogo (igual que el flujo normal)
  if (_prevOrigin !== 'ads' && !conv.ad_property_id) {
    try {
      const { matchAdToProperty } = require('./catalog-matcher');
      const _m = await matchAdToProperty(db, conv.tenant_id, _ref);
      if (_m) {
        await db.query(`UPDATE conversations SET ad_property_id = $1 WHERE id = $2`, [_m.id, conv.id]).catch(() => {});
        conv.ad_property_id = _m.id;
        console.log(`📣 [ads-match·tardío] conv ${conv.id}: anuncio ↔ inmueble ${_m.id} "${String(_m.title || '').slice(0, 60)}" (score ${_m.score})`);
      }
    } catch (e) { console.warn('[ads-match·tardío]', e.message); }
  }

  // Promoción a BOT si el chat estaba en "humano silencioso" (no explícito) de una línea ads_only.
  let promoted = false;
  if (conv.mode === 'human') {
    const _sc = await _aiScopeFor(conv.tenant_id, conv.line_id);
    if (_sc === 'ads_only') {
      let _explicitHuman = false;
      try {
        const _h = await db.query(
          `SELECT reason FROM handover_requests
            WHERE conversation_id = $1 AND reason IN ('admin_takeover', 'returned_to_bot', 'client_requested_human')
            ORDER BY id DESC LIMIT 1`, [conv.id]);
        _explicitHuman = _h.rows.length > 0 && _h.rows[0].reason !== 'returned_to_bot';
      } catch (_) { /* tabla ausente → promueve */ }
      if (_explicitHuman) {
        console.log(`📣 [ads-only·tardío] conv ${conv.id}: referral tardío pero control humano explícito — se queda en humano`);
      } else {
        await db.query(`UPDATE conversations SET mode = 'bot' WHERE id = $1`, [conv.id]).catch(() => {});
        conv.mode = 'bot';
        promoted = true;
        console.log(`📣 [ads-only·tardío] conv ${conv.id}: el referral llegó en el 2do webhook → promovido a BOT`);
      }
    }
  }

  // Si quedó en bot por esta promoción y la IA está activa, que Aitana conteste YA
  // (el cliente ya mandó su mensaje; si no despachamos, el bot esperaría uno nuevo).
  if (promoted && conv.mode === 'bot') {
    if (await aiEnabled(conv.tenant_id, conv)) {
      dispatchToN8n(conv).catch(e => console.error('Error dispatch n8n (referral tardío):', e));
    } else {
      console.log(`✋ IA en pausa (master switch) — referral tardío no despacha conv ${conv.id}`);
    }
  }
  return promoted;
}

async function processIncomingMessage(message, contacts, tenant = { id: 1 }) {
  const tenantId = tenant.id;
  const waMessageId = message.id;
  const from = message.from;
  const type = message.type || 'text';

  if (!waMessageId || !from) return;

  // Idempotencia: si ya existe este wa_message_id, ignorar
  const exists = await db.query(
    'SELECT id FROM messages WHERE wa_message_id = $1',
    [waMessageId]
  );
  if (exists.rows.length > 0) {
    // v0.9.521 — EXCEPCIÓN: si esta copia duplicada trae el referral de anuncio que
    // la 1ra (unsupported) no tenía, aplicalo igual antes de salir (captura + promoción
    // a bot + dispatch). Ver applyLateAdReferral. Sin esto, el lead de anuncio queda
    // silenciado para siempre en líneas ads_only.
    if (message.referral) {
      try { await applyLateAdReferral(message, tenantId, from, tenant.line_id || null); }
      catch (e) { console.warn('[ads-late-referral]', e.message); }
    }
    console.log(`⏭ Mensaje ${waMessageId} ya procesado, ignorando`);
    return;
  }

  const contactName = contacts.find(c => c.wa_id === from)?.profile?.name || null;

  // Crear o recuperar conversación
  // v0.9.0: si llega un mensaje a una conversación archivada, se REACTIVA
  // automáticamente (status vuelve a 'open', archived_at se limpia).
  // CASE preserva 'closed' si estuviera cerrada manualmente; solo reabre 'archived'.
  // v0.9.13: se guarda por cuál LÍNEA entró (tenant.line_id, resuelto en el
  // webhook).
  // v0.9.457: la línea que RECIBIÓ el mensaje manda. Antes era
  // COALESCE(conversations.line_id, EXCLUDED.line_id), o sea que la
  // conversación quedaba clavada a su primera línea para siempre: si un
  // contacto conocido escribía a otro número de la org, el mensaje se
  // archivaba bajo la línea vieja (invisible en el filtro de la nueva) y
  // peor, se le respondía DESDE el número equivocado. Ahora se mueve a la
  // línea real y solo se conserva la anterior si el webhook no resolvió
  // ninguna (pre-migración).
  const lineId = tenant.line_id || null;
  let convResult;
  try {
    // v0.9.466 — CONVERSACIONES POR LÍNEA: la clave es (tenant, phone, línea). Un contacto
    // que escribe a DOS números de la org tiene DOS conversaciones separadas — como en
    // WhatsApp real. Se acabó la "mudanza" de línea (v0.9.457) y la contaminación de
    // historial/modo entre líneas (caso real 29-jul). Cada conversación queda clavada a
    // su línea y las respuestas salen SIEMPRE por esa línea (getConversationMetaCtx).
    convResult = await db.query(
      `INSERT INTO conversations (tenant_id, phone, contact_name, mode, status, last_message_at, line_id)
       VALUES ($1, $2, $3, 'bot', 'open', NOW(), $4)
       ON CONFLICT (tenant_id, phone, COALESCE(line_id, 0)) DO UPDATE
         SET contact_name = COALESCE(conversations.contact_name, EXCLUDED.contact_name),
             last_message_at = NOW(),
             status = CASE WHEN conversations.status = 'archived' THEN 'open' ELSE conversations.status END,
             archived_at = CASE WHEN conversations.status = 'archived' THEN NULL ELSE conversations.archived_at END
       RETURNING *`,
      [tenantId, from, contactName, lineId]
    );
  } catch (e) {
    // Retrocompat: si la columna line_id aún no existe (migración pendiente)
    if (!/line_id/.test(e.message)) throw e;
    convResult = await db.query(
      `INSERT INTO conversations (tenant_id, phone, contact_name, mode, status, last_message_at)
       VALUES ($1, $2, $3, 'bot', 'open', NOW())
       ON CONFLICT (tenant_id, phone) DO UPDATE
         SET contact_name = COALESCE(conversations.contact_name, EXCLUDED.contact_name),
             last_message_at = NOW(),
             status = CASE WHEN conversations.status = 'archived' THEN 'open' ELSE conversations.status END,
             archived_at = CASE WHEN conversations.status = 'archived' THEN NULL ELSE conversations.archived_at END
       RETURNING *`,
      [tenantId, from, contactName]
    );
  }
  const conversation = convResult.rows[0];
  if (conversation) delete conversation.prev_line_id; // columna sintética del CTE

  // v0.9.114 — Mesa de soporte (BPO): plano + ventana 24h + alta de ticket.
  // DEFENSIVO: gateado por support_enabled y en try/catch — NUNCA corta la ingesta.
  // Para un tenant con la mesa prendida, toda conversación es de soporte (operación
  // de soporte pura, tipo Yango); el modelo mixto venta+soporte por línea es de una
  // fase posterior. Para tenants de venta este bloque es un lookup cacheado y sale.
  try {
    if (await tenantSupportEnabled(conversation.tenant_id)) {
      // v0.9.120 — mesa prendida ⇒ la convo es de soporte (capa de tickets, `plane`)
      // Y Aitana atiende con el PROMPT DE SOPORTE (`stage=postventa`). Sin el stage,
      // el bot-prompt-builder usa el prompt de venta aunque haya ticket → Aitana
      // seguiría vendiendo en vez de atender. Por eso seteamos los dos.
      if (conversation.plane !== 'soporte' || conversation.stage !== 'postventa') {
        await db.query(
          `UPDATE conversations SET plane = 'soporte', stage = 'postventa'
             WHERE id = $1 AND (plane <> 'soporte' OR stage IS DISTINCT FROM 'postventa')`,
          [conversation.id]
        );
        conversation.plane = 'soporte';
        conversation.stage = 'postventa';
      }
      await supportTickets.touchWindow({ conversationId: conversation.id });
      // v0.9.334 — NO crear/reabrir ticket si el mensaje es una respuesta de la encuesta CSAT
      // (botón csat:N o el comentario que sigue al puntaje) — si no, el toque abría un ticket nuevo.
      // v0.9.364 — detección ROBUSTA: el tap de un botón viejo (horas después) puede llegar como
      // message.button (formato legacy) o hasta como texto "😀 Buena" — no solo interactive.button_reply.
      // v0.9.366 — FIX CRÍTICO: acá `body` de extractContent AÚN NO EXISTE (se declara más abajo) →
      // ReferenceError silencioso en el catch → NINGÚN inbound de soporte creaba ticket desde el 364.
      // El texto se saca directo del message (suficiente para detectar una respuesta CSAT).
      const _gateBody = (message && message.text && message.text.body) || null;
      const _csatBtn = _csatScoreFromMessage(message, _gateBody) != null;
      const _csatReply = _csatBtn || await supportTickets.hasPendingCsatComment({ tenantId: conversation.tenant_id, conversationId: conversation.id }).catch(() => false);
      if (!_csatReply) await supportTickets.createTicketIfNone({ tenantId: conversation.tenant_id, conversationId: conversation.id });
    }
  } catch (e) { console.error('⚠️  hook mesa soporte (inbound):', e.message); }

  // Extraer contenido del mensaje según tipo
  const { body, mediaId, mediaMime, mediaCaption } = extractContent(message, type);

  // v0.9.46: opt-out automático — si el cliente responde una palabra de baja
  // (BAJA, STOP, CANCELAR, NO MOLESTAR, UNSUBSCRIBE), se agrega a la lista de
  // exclusión del tenant y nunca más recibe campañas (cumplimiento Meta).
  if (body) {
    const norm = body.trim().toLowerCase().replace(/[.!¡¿?]/g, '');
    if (/^(baja|stop|cancelar|cancela|unsubscribe|no molestar|no quiero (mas|más)( mensajes)?|dar de baja|salir)$/.test(norm)) {
      try {
        await db.query(
          `INSERT INTO campaign_optout (tenant_id, phone, reason, created_by)
           VALUES ($1, $2, 'Respondió "' || $3 || '"', 'auto')
           ON CONFLICT (tenant_id, phone) DO NOTHING`,
          [conversation.tenant_id, from, body.trim().slice(0, 40)]
        );
        // v0.9.68 (auditoría 12-jun P1#5): BAJA también apaga los follow-ups de
        // Aitana — antes quedaba en la lista de exclusión de campañas pero el
        // bot lo seguía persiguiendo con re-enganches.
        await db.query(
          `UPDATE conversations SET follow_up_enabled = FALSE WHERE id = $1`,
          [conversation.id]
        ).catch(() => {});
        console.log(`🚫 Opt-out automático: ${from} (tenant ${conversation.tenant_id}) — "${norm}" (campañas + follow-ups)`);
      } catch (e) {
        if (!/campaign_optout/.test(e.message)) console.error('opt-out auto:', e.message);
      }
    }
  }

  // v0.9.115/331 — Mesa de soporte: captura de CSAT. Acepta botón interactivo (csat:N) o texto "1".."5",
  // + comentario abierto opcional que sigue al puntaje. Gated por plane=soporte; idempotente; defensivo.
  let csatHandled = false;
  if (conversation.plane === 'soporte') {
    const score = _csatScoreFromMessage(message, body); // v0.9.364: button_reply + button legacy + texto del botón + "1".."5"
    if (score) {
      try {
        const rid = await supportTickets.recordCsat({ tenantId: conversation.tenant_id, conversationId: conversation.id, score });
        if (rid) {
          csatHandled = true;
          try { await supportTickets.transitionStatus({ ticketId: rid, tenantId: conversation.tenant_id, toStatus: 'closed', actorKind: 'system' }); } catch (e) {}
          try {
            const { getConversationMetaCtx } = require('./tenant-resolver');
            const cctx = await getConversationMetaCtx(conversation);
            await meta.sendText(conversation.phone, '¡Gracias por tu respuesta! 🙏 Si querés, contanos algo más para ayudarnos a mejorar.', false, cctx);
          } catch (e) {}
        }
      } catch (e) {}
    } else if (body) {
      try {
        const cid = await supportTickets.recordCsatComment({ tenantId: conversation.tenant_id, conversationId: conversation.id, comment: body });
        if (cid) csatHandled = true;
      } catch (e) {}
    }
  }

  // Detectar campaign_ref si es el primer mensaje (regex REF-XXX)
  let campaignRef = conversation.campaign_ref;
  if (!campaignRef && body) {
    const match = body.match(/\bREF-[A-Z0-9-]+/i);
    if (match) {
      campaignRef = match[0];
      await db.query(
        'UPDATE conversations SET campaign_ref = $1 WHERE id = $2',
        [campaignRef, conversation.id]
      );
    }
  }

  // v0.7.8 P1 — Detectar template de entrada (anuncio FB, etc) y guardar contexto.
  // Solo intenta matchear si la conversación todavía no tiene entry_context
  // (o sea, en el primer mensaje del cliente). Idempotente.
  if (!conversation.entry_context && body) {
    try {
      const matched = await matchEntryTemplate(body, conversation.tenant_id); // v0.9.44: por tenant
      if (matched) {
        await db.query(
          'UPDATE conversations SET entry_context = $1 WHERE id = $2',
          [matched.entry_context, conversation.id]
        );
        console.log(`🎯 Entry template matched: "${matched.name}" — contexto inyectado`);
      }
    } catch (e) {
      // No bloquear el flujo si la tabla no existe aún (primer deploy antes de migrar)
      console.warn('⚠️  matchEntryTemplate falló (¿migración pendiente?):', e.message);
    }
  }

  // Procesar multimedia: descargar UNA vez, usar para R2 + Gemini
  let transcription = null;
  let analyzedCaption = mediaCaption;
  let mediaUrl = null;  // URL pública de R2 para que el panel pueda renderizar

  if (mediaId && (type === 'audio' || type === 'image' || type === 'video' || type === 'document')) {
    try {
      // 1. Descargar el binario UNA sola vez
      // v0.9.67 (auditoría 12-jun P1#2): con el token de la LÍNEA/tenant del
      // mensaje — el media de tenants con token propio NO se puede bajar con
      // el token global (fallaba silencioso: sin imagen en panel ni transcripción).
      console.log(`⬇️  Descargando ${type} de Meta...`);
      const mediaCtx = await getConversationMetaCtx({ line_id: tenant.line_id || null, tenant_id: tenantId }).catch(() => null);
      const mediaData = await meta.downloadMedia(mediaId, mediaCtx);

      if (mediaData && mediaData.buffer) {
        // 2. Subir a R2 (si está configurado)
        if (r2.isConfigured()) {
          try {
            // Generar filename con extensión correcta según MIME type
            // Esto es CRÍTICO: sin extensión, el navegador descarga en vez de mostrar
            const detectedMime = mediaData.mimeType || mediaMime || 'application/octet-stream';
            const ext = mimeToExtension(detectedMime, type);
            const safeFilename = `${type}-${Date.now()}.${ext}`;

            const uploadResult = await r2.upload({
              buffer: mediaData.buffer,
              mimeType: detectedMime,
              prefix: 'incoming',
              filename: safeFilename,
            });
            mediaUrl = uploadResult.url;
            console.log(`☁️  ${type} subido a R2: ${mediaUrl}`);
          } catch (e) {
            console.error(`⚠️  Error subiendo ${type} a R2:`, e.message);
          }
        }

        // 3. Análisis con Gemini (audio/image/video, y v0.9.500: PDF).
        // v0.9.500 — los DOCUMENTOS PDF ahora también se "leen": el cliente inmobiliario
        // manda planos, títulos, boletas y cotizaciones en PDF y el bot/asesor quedaba
        // ciego (solo un link de descarga). Gemini lee el PDF y deja un resumen en
        // `transcription`, que el panel muestra bajo el documento y el bot usa de contexto.
        // Solo PDF: doc/xls/otros formatos binarios no los procesamos (link de descarga).
        const _isPdfDoc = type === 'document' && /pdf/i.test(mediaData.mimeType || mediaMime || '');
        // v0.9.532 — AHORRO DE IA: la nota de voz SOLO se transcribe al llegar si el chat va al
        // bot (Aitana necesita el texto para responder al instante). En chats humanos se DIFIERE:
        // se transcribe recién cuando el asesor ABRE el chat (lazy — ver GET /admin/.../messages).
        // Así no gastamos Gemini transcribiendo audios de conversaciones que quizá nadie mire.
        // Imágenes / video / PDF no cambian (se analizan al llegar como siempre).
        const _deferAudio = type === 'audio' && conversation.mode !== 'bot';
        if (_deferAudio) console.log(`💤 [ahorro-ia] audio en modo ${conversation.mode} — transcripción diferida hasta abrir el chat (conv ${conversation.id})`);
        if ((type === 'audio' || type === 'image' || type === 'video' || _isPdfDoc) && !_deferAudio) {
          try {
            const _analyzeType = _isPdfDoc ? 'document' : type;
            console.log(`🎙️  Analizando ${_analyzeType} con Gemini...`);
            const result = await analyzeMediaWithGeminiBuffer(
              mediaData.buffer,
              mediaData.mimeType || mediaMime,
              _analyzeType,
              // v0.9.151 — contexto para registrar el consumo de tokens en ai_usage
              { tenantId: conversation.tenant_id, conversationId: conversation.id, phone: conversation.phone }
            );
            if (result) {
              if (type === 'audio') {
                transcription = result;
                console.log(`✅ Audio transcrito (${result.length} chars)`);
              } else if (_isPdfDoc) {
                transcription = result; // resumen del PDF, mismo campo que la voz
                console.log(`✅ PDF leído (${result.length} chars)`);
              } else {
                analyzedCaption = result;
                console.log(`✅ ${type} analizado (${result.length} chars)`);
              }
            }
          } catch (err) {
            console.error(`⚠️  Error analizando ${type}:`, err.message);
          }
        }
      }
    } catch (err) {
      console.error(`⚠️  Error procesando ${type}:`, err.message);
      // No bloquear el flujo, solo registrar
    }
  }

  // Guardar mensaje (incluye media_url ahora).
  // v0.9.239: ON CONFLICT (wa_message_id) DO NOTHING — durante el history sync de coexistence
  // Meta reenvía mensajes/echoes SOLAPADOS; el chequeo SELECT de arriba tiene CARRERA con
  // eventos en paralelo → antes pegaba "duplicate key messages_wa_message_id_key" (ERROR en log).
  // Ahora, si ya existe, no inserta y cortamos sin re-procesar (evita doble unread/dispatch).
  const insertResult = await db.query(
    `INSERT INTO messages
     (tenant_id, conversation_id, wa_message_id, direction, sender_type, type, body,
      media_id, media_url, media_mime_type, media_caption, transcription, raw_payload, status)
     VALUES ($1, $2, $3, 'incoming', 'client', $4, $5, $6, $7, $8, $9, $10, $11, 'delivered')
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [tenantId, conversation.id, waMessageId, type, body, mediaId, mediaUrl, mediaMime, analyzedCaption,
     transcription, JSON.stringify(message)]
  );
  if (!insertResult.rows.length) { console.log(`⏭ Mensaje ${waMessageId} duplicado (carrera) — ignorado`); return; }
  const insertedMessageId = insertResult.rows[0].id;

  // Incrementar unread_count
  await db.query(
    'UPDATE conversations SET unread_count = unread_count + 1 WHERE id = $1',
    [conversation.id]
  );

  // v0.9.192 — PUSH al asesor asignado cuando entra un mensaje en SU chat (evento
  // new_message_assigned). Defensivo, con debounce 90s por conversación para no spamear,
  // y gateado por las prefs del tenant + el rol del asignado. Nunca corta la ingesta.
  try {
    if (conversation.assigned_to) {
      const now = Date.now();
      const last = _lastAssignedMsgPush.get(conversation.id) || 0;
      if (now - last >= 90000) {
        const ev = (await require('./notify-prefs').getNotifPrefs(conversation.tenant_id)).new_message_assigned;
        if (ev.push_roles.length) {
          const ur = await db.query('SELECT role FROM tenant_users WHERE id = $1 AND tenant_id = $2', [conversation.assigned_to, conversation.tenant_id]);
          const role = ur.rows[0] && ur.rows[0].role;
          if (role && ev.push_roles.includes(role)) {
            const pushNotifier = require('./push-notifier');
            if (pushNotifier.isConfigured()) {
              _lastAssignedMsgPush.set(conversation.id, now);
              if (_lastAssignedMsgPush.size > 5000) _lastAssignedMsgPush.clear(); // guard memoria
              const preview = (body || (type !== 'text' ? `[${type}]` : '') || '').toString().slice(0, 80);
              pushNotifier.broadcast({
                title: `💬 ${conversation.contact_name || from}`,
                body: preview || 'Nuevo mensaje en tu chat',
                url: `/panel/?conv=${encodeURIComponent(conversation.phone || from)}`,
                conversation_phone: conversation.phone || from,
              }, conversation.tenant_id, { userIds: [conversation.assigned_to] }).catch(() => {});
            }
          }
        }
      }
    }
  } catch (e) { /* push best-effort, nunca corta el webhook */ }

  // v0.9.316 — CLIENTE VIP: si el número está tageado como VIP, avisar al equipo (push + WhatsApp
  // por línea) con prioridad, EN PARALELO (el bot igual responde). Anti-spam 30 min. Nunca corta.
  try {
    const _vip = await db.query('SELECT 1 FROM vip_contacts WHERE tenant_id = $1 AND phone = $2 LIMIT 1', [conversation.tenant_id, conversation.phone]).catch(() => ({ rows: [] }));
    if (!csatHandled && _vip.rows.length) {
      const _prev = (body || transcription || (type !== 'text' ? `[${type}]` : '')).toString().slice(0, 160);
      notifyVipInbound(conversation, _prev).catch((e) => console.warn('[vip] aviso falló:', e.message));
    }
  } catch (e) { /* VIP best-effort, nunca corta el webhook */ }

  // v0.7.22: Stop-words + tracking de respuestas a follow-ups (non-fatal)
  // Si algo del módulo follow-up falla, no se rompe el webhook principal.
  try {
    const { handleStopWords } = require('./follow-up/stop-word-detector');
    const { markFollowUpResponse } = require('./follow-up/follow-up-routes');
    await markFollowUpResponse({
      db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      message_id: insertedMessageId,
    });
    await handleStopWords({
      db,
      tenant_id: tenantId,
      conversation_id: conversation.id,
      phone: conversation.phone,
      body: body || transcription || '',
    });
  } catch (e) {
    console.error('[follow-up handlers] non-fatal error:', e.message);
  }

  // Visto azul (marcar leído en WhatsApp)
  // v0.9.312: en modo BOT lo pone el typing indicator (más abajo) justo antes de responder.
  // v0.9.460 FIX (tenant Arzabe): en modo HUMANO ya NO se marca leído al recibir — un agente
  // que trabaja desde su teléfono/panel veía todos sus chats con visto azul sin haberlos leído,
  // y el cliente veía "leído" sin respuesta. Ahora el visto azul en chats humanos lo pone el
  // panel recién cuando el agente RESPONDE (api.js /admin/conversations/:phone/send).
  // Si el bot no va a responder (modo human, IA en pausa, OTP), no se marca nada.

  // 🔔 Push notification al panel (PWA).
  // v0.9.526 — FIX del "no enviar que igual enviaba" (caso iPhone tenant 14): antes esto
  // era un BLAST a TODOS los dispositivos del tenant en CADA mensaje, SIN mirar ninguna
  // preferencia ("notificamos siempre"). Por eso la config de notificaciones no tenía
  // efecto y la PWA de iOS (Web Push de Apple) recibía cada conversación. Ahora:
  //   · Los chats ASIGNADOS ya recibieron push arriba (new_message_assigned, al asesor
  //     asignado y gateado por prefs) → acá NO se repite.
  //   · Los chats SIN asignar notifican SOLO a los roles configurados en la preferencia
  //     new_message_assigned, y SOLO si esa preferencia tiene roles (si el dueño la puso
  //     en "no enviar", push_roles queda vacío y no se manda NADA). Debounce 90s por chat.
  try {
    if (!conversation.assigned_to) {
      const now = Date.now();
      const last = _lastUnassignedMsgPush.get(conversation.id) || 0;
      if (now - last >= 90000) {
        const ev = (await require('./notify-prefs').getNotifPrefs(tenantId)).new_message_assigned;
        if (ev && Array.isArray(ev.push_roles) && ev.push_roles.length) {
          const pushNotifier = require('./push-notifier');
          if (pushNotifier.isConfigured()) {
            _lastUnassignedMsgPush.set(conversation.id, now);
            if (_lastUnassignedMsgPush.size > 5000) _lastUnassignedMsgPush.clear();
            const contactName = conversation.contact_name || conversation.phone || 'Cliente';
            const previewText = (body || transcription || `[${type}]`).substring(0, 120);
            pushNotifier.broadcast({
              title: `💬 ${contactName}`,
              body: previewText,
              url: `/panel/?conv=${encodeURIComponent(conversation.phone)}`,
              conversation_phone: conversation.phone,
            }, tenantId, { roles: ev.push_roles }).catch(e => console.warn('Push broadcast error:', e.message));
          }
        }
      }
    }
  } catch (e) {
    // Si push-notifier / notify-prefs no cargan, seguimos sin push
  }

  // Si está en modo bot, dispatch a n8n
  const refreshed = await db.query(
    'SELECT * FROM conversations WHERE id = $1',
    [conversation.id]
  );
  const conv = refreshed.rows[0];

  // v0.9.331 — si el mensaje fue una respuesta de la encuesta CSAT (puntaje o comentario),
  // ya lo procesamos arriba: no lo mandamos al bot.
  if (csatHandled) {
    console.log(`🙂 [csat] respuesta de encuesta en conv ${conv.id} — no se dispatcha al bot`);
    return;
  }

  // ============================================================
  // v0.9.439 — IA SOLO PARA ANUNCIOS. El agente con número personal quiere
  // que Aitana atienda únicamente los chats que NACEN de un anuncio Meta
  // (Click-to-WhatsApp). Señales: message.referral (oficial) o campaign_ref
  // (REF-XXX). El referral se guarda SIEMPRE (atribución ctwa_clid, fase 3).
  // ============================================================
  try {
    const _ref = message.referral || null;
    if (_ref && (_ref.source_type || _ref.source_url || _ref.ctwa_clid)) {
      const _prevOrigin = conv.ai_origin || null;
      await db.query(`UPDATE conversations SET referral = COALESCE(conversations.referral, $1::jsonb), ai_origin = 'ads' WHERE id = $2`, [JSON.stringify(_ref), conv.id]).catch(() => {});
      conv.referral = conv.referral || _ref;
      conv.ai_origin = 'ads';
      // v0.9.440 — match anuncio ↔ inmueble del catálogo (una sola vez por conversación)
      if (_prevOrigin !== 'ads' && !conv.ad_property_id) {
        try {
          const { matchAdToProperty } = require('./catalog-matcher');
          const _m = await matchAdToProperty(db, conv.tenant_id, _ref);
          if (_m) {
            await db.query(`UPDATE conversations SET ad_property_id = $1 WHERE id = $2`, [_m.id, conv.id]).catch(() => {});
            conv.ad_property_id = _m.id;
            console.log(`📣 [ads-match] conv ${conv.id}: anuncio ↔ inmueble ${_m.id} "${String(_m.title || '').slice(0, 60)}" (score ${_m.score})`);
          } else {
            console.log(`📣 [ads-match] conv ${conv.id}: el anuncio no matcheó claro con el catálogo — Aitana preguntará`);
          }
        } catch (e) { console.warn('[ads-match]', e.message); }
      }
      // Promoción: un chat que era ORGÁNICO (humano silencioso) tocó un anuncio → es un lead, pasa al bot.
      // Solo en la primera transición (si el dueño después lo pasa a mano a 'human', se respeta).
      if (_prevOrigin !== 'ads' && conv.mode === 'human') {
        const _sc = await _aiScopeFor(conv.tenant_id, conv.line_id);
        if (_sc === 'ads_only') {
          // v0.9.464 — GUARD: el modo humano EXPLÍCITO no se pisa. "Humano silencioso" (default del
          // alcance solo-ads) sí se promueve; pero si un agente tomó control desde el panel
          // (admin_takeover) o el cliente pidió humano, el click en un anuncio NO le quita el chat.
          // Caso real 29-jul: chat atendido a mano por el agente → cliente tocó un ad → Aitana se
          // metió en medio de la conversación humana.
          let _explicitHuman = false;
          try {
            const _h = await db.query(
              `SELECT reason FROM handover_requests
                WHERE conversation_id = $1
                  AND reason IN ('admin_takeover', 'returned_to_bot', 'client_requested_human')
                ORDER BY id DESC LIMIT 1`, [conv.id]);
            _explicitHuman = _h.rows.length > 0 && _h.rows[0].reason !== 'returned_to_bot';
          } catch (_) { /* tabla ausente → comportamiento previo (promueve) */ }
          if (_explicitHuman) {
            console.log(`📣 [ads-only] conv ${conv.id}: tocó un anuncio pero el control humano fue explícito (takeover/pedido del cliente) — se queda en humano`);
          } else {
            await db.query(`UPDATE conversations SET mode = 'bot' WHERE id = $1`, [conv.id]).catch(() => {});
            conv.mode = 'bot';
            console.log(`📣 [ads-only] conv ${conv.id}: tocó un anuncio → promovido a BOT`);
          }
        }
      }
    }
    // v0.9.466 — el guard de "mudanza de línea" (v0.9.464) quedó OBSOLETO: las
    // conversaciones ya no se mudan — cada línea tiene la suya (clave tenant+phone+línea),
    // así que la promoción por anuncio queda naturalmente contenida en SU conversación.
    if (conv.mode === 'bot') {
      const _scope = await _aiScopeFor(conv.tenant_id, conv.line_id);
      if (_scope === 'ads_only') {
        const _fromAds = conv.ai_origin === 'ads' || conv.ai_origin === 'campaign' || !!conv.referral || !!conv.campaign_ref || !!campaignRef; // v0.9.442: respuestas a campañas salientes también son del bot
        if (!_fromAds) {
          // Contacto orgánico/personal → humano SILENCIOSO (sin typing, sin saludo). Decisión pegajosa.
          await db.query(`UPDATE conversations SET mode = 'human', ai_origin = COALESCE(conversations.ai_origin, 'organic') WHERE id = $1`, [conv.id]).catch(() => {});
          conv.mode = 'human';
          conv.ai_origin = conv.ai_origin || 'organic';
          console.log(`📣 [ads-only] conv ${conv.id}: chat orgánico en alcance solo-anuncios → humano silencioso`);
        } else if (!conv.ai_origin) {
          await db.query(`UPDATE conversations SET ai_origin = 'ads' WHERE id = $1`, [conv.id]).catch(() => {});
          conv.ai_origin = 'ads';
        }
      }
    }
  } catch (e) { console.warn('[ads-only]', e.message); }

  if (conv.mode === 'bot') {
    // Filtro anti-OTP: si el mensaje parece un código de verificación, no dispatchar a Aitana
    if (looksLikeOTP(body)) {
      console.log(`🔐 Mensaje detectado como OTP/código de verificación, omitiendo dispatch a n8n. Conv ${conv.id}`);
      return;
    }
    // v0.9.155 — MASTER SWITCH de IA: si el owner pausó la IA, el mensaje ya quedó
    // guardado pero NO dispatchamos al bot (los humanos responden desde el panel).
    if (!(await aiEnabled(conv.tenant_id, conv))) {
      console.log(`✋ IA en pausa (master switch) tenant ${conv.tenant_id} — no se dispatcha conv ${conv.id}`);
      return;
    }
    // v0.9.279 — "escribiendo…": mostramos el typing bubble apenas el bot va a responder, así el cliente
    // ve "escribiendo…" mientras Aitana (n8n) genera la respuesta — como una persona real. Non-fatal.
    try {
      const { getConversationMetaCtx } = require('./tenant-resolver');
      const typingCtx = await getConversationMetaCtx(conv);
      // v0.9.312 — el typing marca leído + muestra "escribiendo…". Si falla, fallback a markAsRead
      // para no perder el visto azul.
      meta.sendTypingIndicator(waMessageId, typingCtx)
        .then((ok) => { if (!ok) meta.markAsRead(waMessageId, typingCtx).catch(() => {}); })
        .catch(() => { meta.markAsRead(waMessageId, typingCtx).catch(() => {}); });
    } catch (e) { /* non-fatal */ }
    dispatchToN8n(conv).catch(e => console.error('Error dispatch n8n:', e));
  } else {
    console.log(`✋ Conversación ${conv.id} en modo human, no se manda al bot`);
  }
}

/**
 * v0.9.316 — Aviso de CLIENTE VIP al equipo. Push a los roles configurados (por línea) +
 * WhatsApp al número de alertas (texto normal <24h, plantilla `cliente_vip` si no). El chat ya
 * sube al tope del inbox por el JOIN vip_contacts. Anti-spam via handover_requests(reason='vip').
 */
async function notifyVipInbound(conversation, preview) {
  const tenantId = (conversation && conversation.tenant_id) || 1;
  const conversationId = conversation && conversation.id;
  if (!conversationId) return;
  const lineId = (conversation && conversation.line_id != null) ? conversation.line_id : null;
  const phone = conversation.phone;
  const contactName = conversation.contact_name || phone;

  const recent = await db.query(
    `SELECT 1 FROM handover_requests WHERE conversation_id = $1 AND reason = 'vip' AND created_at > NOW() - INTERVAL '30 minutes' LIMIT 1`,
    [conversationId]).catch(() => ({ rows: [] }));
  if (recent.rows.length > 0) return;

  const notifyPrefs = require('./notify-prefs');
  let cfg = { push_roles: ['owner', 'supervisor', 'agent'], whatsapp: true, phone: '' };
  try { cfg = notifyPrefs.resolveVipMessage(await notifyPrefs.getNotifPrefs(tenantId), lineId); } catch (e) { /* defaults */ }

  const _prev = (preview && String(preview).trim()) ? String(preview).trim().slice(0, 160) : '';

  // PUSH a los roles configurados (por línea)
  try {
    const pushNotifier = require('./push-notifier');
    if (pushNotifier.isConfigured() && cfg.push_roles && cfg.push_roles.length) {
      pushNotifier.broadcast({
        title: `⭐ VIP: ${contactName}`,
        body: _prev || 'Cliente VIP escribió — atención prioritaria',
        url: `/panel/?conv=${encodeURIComponent(phone)}`,
        conversation_phone: phone,
      }, tenantId, { roles: cfg.push_roles }).catch((e) => console.warn('[vip] push falló:', e.message));
    }
  } catch (e) { /* best-effort */ }

  // WhatsApp a un número específico (fallback: alert_phone de la org)
  if (cfg.whatsapp) {
    let target = (cfg.phone && cfg.phone.trim()) || null;
    if (!target) {
      try { const t = await db.query('SELECT alert_phone FROM tenants WHERE id = $1', [tenantId]); target = t.rows[0] ? (t.rows[0].alert_phone || null) : null; } catch (e) {}
      if (!target && tenantId === 1) target = process.env.OWNER_PHONE || null;
    }
    if (target) {
      const ctx = await getConversationMetaCtx(conversation || { tenant_id: tenantId }).catch(() => null);
      const digits = String(phone || '').replace(/[^0-9]/g, '');
      const panelBase = process.env.PANEL_PUBLIC_URL || 'https://app.sg-ventas.com/panel/';
      const panelUrl = `${panelBase}${panelBase.includes('?') ? '&' : '?'}conv=${encodeURIComponent(phone)}`;
      const text = `⭐ *CLIENTE VIP*\n\n${contactName} necesita atención prioritaria — acaba de escribir.\nTeléfono: ${phone}${_prev ? '\n\n💬 "' + _prev + '"' : ''}\n\n🖥️ Abrir en el CRM:\n${panelUrl}\n\n📞 Llamar por WhatsApp: https://wa.me/${digits}`;
      const tplName = (cfg.template && cfg.template.trim()) || process.env.VIP_ALERT_TEMPLATE_NAME || 'cliente_vip';
      const _comps = [{ type: 'body', parameters: [
        { type: 'text', text: String(contactName) },
        { type: 'text', text: String(phone) },
      ] }];
      // v0.9.325 — regla de 24h: destinatario con inbound <24h → texto libre; si no → plantilla.
      const _within = await notifyPrefs.recipientWithin24h(tenantId, target).catch(() => false);
      if (_within) {
        let result = null;
        try { result = await meta.sendText(target, text, true, ctx); } catch (e) { result = { success: false, error: e.message }; }
        if (result && result.success === false && /re-?engagement|131047|24/i.test(String(result.error || ''))) {
          try { const tr = await meta.sendTemplate(target, tplName, 'es', _comps, ctx); if (!tr.success) console.warn(`⚠️  [vip] plantilla ${tplName} falló:`, tr.error); } catch (e) { console.warn('⚠️  [vip] fallback plantilla:', e.message); }
        }
      } else {
        try { const tr = await meta.sendTemplate(target, tplName, 'es', _comps, ctx); if (!tr.success) console.warn(`⚠️  [vip] plantilla ${tplName} falló:`, tr.error); } catch (e) { console.warn('⚠️  [vip] plantilla falló:', e.message); }
      }
    }
  }

  await db.query(
    `INSERT INTO handover_requests (conversation_id, reason, triggered_by, notified_owner, notified_at) VALUES ($1, 'vip', 'vip', TRUE, NOW())`,
    [conversationId]).catch(() => {});
}

/**
 * Detecta si un mensaje entrante parece ser un código de verificación
 * o un mensaje sistémico de Meta/Facebook/WhatsApp para no dispatchar a Aitana.
 */
function looksLikeOTP(body) {
  if (!body || typeof body !== 'string') return false;
  const text = body.toLowerCase();

  // Patrones de mensajes de verificación
  const otpKeywords = [
    'código de verificación',
    'codigo de verificación',
    'codigo de verificacion',
    'verification code',
    'tu código es',
    'tu codigo es',
    'your code is',
    'your verification',
    'meta business',
    'whatsapp business',
    'facebook business',
    'no compartas este código',
    'do not share this code',
    'one-time password',
    'otp:',
    'security code',
    'two-factor',
    'two factor',
    'is your',
  ];

  const matchedKeyword = otpKeywords.some(kw => text.includes(kw));
  if (matchedKeyword) return true;

  // Heurística adicional: mensajes muy cortos que son solo un código numérico de 4-8 dígitos
  // (raro que un cliente real solo escriba números así sin contexto, salvo que reenvíen un OTP)
  const trimmed = body.trim();
  if (/^\d{4,8}$/.test(trimmed)) return true;
  if (/^\d{3}-?\d{3}$/.test(trimmed)) return true; // formato 123-456

  return false;
}

/**
 * Extrae body / media_id según tipo de mensaje
 */
function extractContent(message, type) {
  let body = null, mediaId = null, mediaMime = null, mediaCaption = null;

  switch (type) {
    case 'text':
      body = message.text?.body || null;
      break;
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker':
      mediaId = message[type]?.id || null;
      mediaMime = message[type]?.mime_type || null;
      mediaCaption = message[type]?.caption || null;
      body = mediaCaption;
      // v0.9.500 — el documento sin caption mostraba "documento" genérico. Meta trae el
      // nombre del archivo (planos-lote-45.pdf, título.pdf) → lo usamos como cuerpo.
      if (type === 'document' && !mediaCaption) body = message.document?.filename || 'documento';
      break;
    case 'location': {
      // v0.9.500 — antes: "Ubicación: lat, lon" (crudo). Ahora un link de mapa clickeable.
      const loc = message.location || {};
      body = (loc.latitude != null && loc.longitude != null)
        ? `📍 Ubicación: https://www.google.com/maps?q=${loc.latitude},${loc.longitude}${loc.name ? ' — ' + loc.name : ''}${loc.address ? ' (' + loc.address + ')' : ''}`
        : '📍 Ubicación compartida';
      break;
    }
    case 'contacts': {
      // v0.9.500 — HABILITADO. Meta SÍ manda la tarjeta de contacto (vCard) completa;
      // solo no la estábamos leyendo → salía "[Mensaje tipo contacts no soportado]".
      const cs = Array.isArray(message.contacts) ? message.contacts : [];
      const parts = cs.map((c) => {
        const nm = (c.name && (c.name.formatted_name || [c.name.first_name, c.name.last_name].filter(Boolean).join(' ').trim())) || 'Contacto';
        const ph = (c.phones && c.phones[0] && c.phones[0].phone) || '';
        return ph ? `${nm} · ${ph}` : nm;
      });
      body = parts.length ? '📇 Contacto: ' + parts.join(' / ') : '📇 Contacto compartido';
      break;
    }
    case 'order': {
      // v0.9.500 — pedido desde el catálogo de WhatsApp.
      const o = message.order || {};
      const n = Array.isArray(o.product_items) ? o.product_items.length : 0;
      body = `🛒 Pedido de catálogo (${n} ${n === 1 ? 'ítem' : 'ítems'})${o.text ? ' — ' + o.text : ''}`;
      break;
    }
    case 'system':
      // v0.9.500 — el cliente cambió de número (Meta migra el hilo).
      body = message.system?.body || 'El cliente actualizó su cuenta de WhatsApp (cambió de número).';
      break;
    case 'button':
      body = message.button?.text || message.button?.payload || '[botón]';
      break;
    case 'interactive': {
      const _ir = message.interactive || {};
      body = (_ir.button_reply && _ir.button_reply.title) || (_ir.list_reply && _ir.list_reply.title) || _ir.text || '[interactivo]';
      break;
    }
    case 'reaction':
      // v0.7.5: Meta envía { reaction: { message_id, emoji } }.
      // emoji null/vacío significa que el cliente quitó la reacción.
      // Guardamos el emoji crudo en `body` para que el panel lo renderice
      // como burbuja chiquita gris. Si quitó la reacción, body = '__removed__'
      // (sentinel que el panel detecta).
      const reaction = message.reaction || {};
      body = reaction.emoji && reaction.emoji.trim() ? reaction.emoji : '__removed__';
      break;
    case 'unsupported': {
      // v0.9.500 — Meta marca 'unsupported' cuando el tipo NO existe en la Cloud API
      // (foto/video de "ver una vez", encuestas, mensajes de pago/evento, o un tipo más
      // nuevo que la versión del API). En esos casos Meta NO entrega el contenido: no hay
      // nada que descargar ni transcribir. Mostramos un aviso claro y logueamos el crudo
      // (con el código de error de Meta) para identificar EXACTAMENTE qué llega en producción.
      const e = (message.errors && message.errors[0]) || {};
      body = '⚠️ El cliente envió un mensaje que WhatsApp no permite mostrar acá (por ejemplo una foto/video de "ver una vez", una encuesta, o un tipo nuevo). Pedile que lo reenvíe como texto o foto normal.';
      try { console.warn(`[webhook] type=unsupported from=${message.from || '?'} code=${e.code != null ? e.code : '?'} title="${e.title || ''}" raw=${JSON.stringify(message).slice(0, 700)}`); } catch (_) {}
      break;
    }
    default:
      // v0.9.500 — cualquier tipo que no manejemos: aviso legible + log del crudo para
      // enterarnos si Meta empieza a mandar algo nuevo, en vez de tragarlo en silencio.
      body = `📎 Mensaje de tipo "${type}" (todavía no se muestra en el panel).`;
      try { console.warn(`[webhook] tipo entrante NO manejado type=${type} from=${message.from || '?'} raw=${JSON.stringify(message).slice(0, 700)}`); } catch (_) {}
  }

  return { body, mediaId, mediaMime, mediaCaption };
}

/**
 * Procesa status updates (sent/delivered/read/failed)
 * @param {Object} status - status update de Meta
 * @param {Object} tenant - tenant resuelto (Step 2b). Solo informativo por ahora.
 */
async function processStatusUpdate(status, tenant = { id: 1 }) {
  const waMessageId = status.id;
  const statusValue = status.status;

  if (!waMessageId || !statusValue) return;

  const map = {
    sent: 'sent',
    delivered: 'delivered',
    read: 'read',
    failed: 'failed',
  };
  const newStatus = map[statusValue];
  if (!newStatus) return;

  let errorMsg = null;
  if (statusValue === 'failed') {
    const err = (status.errors && status.errors[0]) || {};
    errorMsg = err.message || err.title || 'Failed';
    // v0.9.393 — VISIBILIDAD del motivo real de Meta. Antes se perdía en silencio cuando el
    // mensaje saliente no estaba en `messages` (ej. la nota de voz de PRUEBA). Códigos típicos:
    //   131047 = fuera de la ventana de 24h · 131053 = media no descargable/formato · 130472 = usuario no válido.
    console.warn(`[wa-status] FAILED wamid=${waMessageId} code=${err.code != null ? err.code : '?'} title="${err.title || ''}" msg="${err.message || ''}" details="${(err.error_data && err.error_data.details) || ''}"`);
  }

  await db.query(
    'UPDATE messages SET status = $1, error_message = $2 WHERE wa_message_id = $3',
    [newStatus, errorMsg, waMessageId]
  );
}

/**
 * Reenvía la conversación + mensaje + histórico + media catalog a n8n
 */
// v0.9.130 — OMNICANAL (#1): ingesta de Instagram DM / Facebook Messenger.
// Fase 1: resuelve el tenant por la página/cuenta, guarda la conversación y el
// mensaje (aparece en el inbox). El DISPATCH al bot + el envío de la respuesta por
// canal (meta.sendMessengerText) van en Fase 1b, para no tocar el envío WhatsApp en vivo.
async function resolveTenantByChannel(channel, pageOrIgId) {
  if (!pageOrIgId) return null;
  try {
    const r = await db.query(
      `SELECT t.* FROM tenant_channels tc JOIN tenants t ON t.id = tc.tenant_id
        WHERE tc.active = TRUE AND tc.channel = $1 AND (tc.page_id = $2 OR tc.ig_id = $2) LIMIT 1`,
      [channel, String(pageOrIgId)]
    );
    return r.rows[0] || null;
  } catch (e) {
    if (/tenant_channels/.test(e.message)) return null; // tabla no migrada todavía
    throw e;
  }
}

async function upsertChannelConversation(tenantId, channel, channelUserId, contactName) {
  const upd = await db.query(
    `UPDATE conversations SET last_message_at = NOW(), unread_count = unread_count + 1
       WHERE tenant_id = $1 AND channel = $2 AND channel_user_id = $3 RETURNING *`,
    [tenantId, channel, String(channelUserId)]
  );
  if (upd.rows[0]) return upd.rows[0];
  const ins = await db.query(
    `INSERT INTO conversations (tenant_id, channel, channel_user_id, contact_name, mode, status, unread_count, last_message_at)
     VALUES ($1, $2, $3, $4, 'bot', 'open', 1, NOW()) RETURNING *`,
    [tenantId, channel, String(channelUserId), contactName || null]
  );
  return ins.rows[0];
}

async function handleMessengerWebhook(body) {
  const channel = body.object === 'instagram' ? 'instagram' : 'messenger';
  for (const entry of body.entry || []) {
    const recipientPageId = entry.id; // página / cuenta IG del negocio
    for (const ev of entry.messaging || []) {
      try {
        if (ev.message?.is_echo) continue;          // lo que mandó el negocio
        const senderId = ev.sender?.id;             // PSID / IGSID del cliente
        if (!senderId || !ev.message) continue;     // ignorar entregas/lecturas/postbacks por ahora
        const tenant = await resolveTenantByChannel(channel, ev.recipient?.id || recipientPageId);
        if (!tenant) {
          console.error(`🚨 [webhook ${channel}] id="${ev.recipient?.id || recipientPageId}" no matchea ningún tenant — DESCARTADO`);
          continue;
        }
        const text = ev.message.text || null;
        const hasAttach = Array.isArray(ev.message.attachments) && ev.message.attachments.length > 0;
        if (!text && !hasAttach) continue;
        const conv = await upsertChannelConversation(tenant.id, channel, senderId, null);
        // v0.9.237 — resolver el NOMBRE real del contacto (Messenger/IG) en segundo plano,
        // solo si la conversación todavía no tiene nombre. Best-effort, NO bloquea el mensaje.
        if (!conv.contact_name) {
          (async () => {
            try {
              const _tc = await db.query(
                `SELECT page_token_enc FROM tenant_channels WHERE tenant_id=$1 AND channel=$2 AND (page_id=$3 OR ig_id=$3) AND active=TRUE AND page_token_enc IS NOT NULL LIMIT 1`,
                [tenant.id, channel, String(ev.recipient?.id || recipientPageId)]);
              const _enc = _tc.rows[0] && _tc.rows[0].page_token_enc;
              if (!_enc) return;
              const _tok = decryptSafe(_enc);
              if (!_tok) return;
              const _prof = await meta.getChannelUserProfile(channel, senderId, _tok);
              if (_prof && _prof.name) {
                await db.query(`UPDATE conversations SET contact_name=$2 WHERE id=$1 AND (contact_name IS NULL OR contact_name='')`, [conv.id, String(_prof.name).slice(0, 120)]);
                console.log(`🪪 [${channel}] nombre resuelto: ${_prof.name} (conv ${conv.id})`);
              }
            } catch (e) { /* best-effort: si falla, queda el nombre del canal */ }
          })();
        }
        await db.query(
          `INSERT INTO messages (conversation_id, wa_message_id, direction, sender_type, type, body, created_at)
           VALUES ($1, $2, 'incoming', 'client', $3, $4, NOW())
           ON CONFLICT (wa_message_id) DO NOTHING`,
          [conv.id, ev.message.mid || null, text ? 'text' : 'image', text || '[adjunto]']
        );
        console.log(`📥 [${channel}] mensaje de ${senderId} → tenant ${tenant.id} (conv ${conv.id})`);
        // v0.9.155 — MASTER SWITCH de IA: el mensaje ya quedó guardado arriba; si el
        // owner pausó la IA, no dispatchamos (los humanos responden desde el panel).
        if (!(await aiEnabled(tenant.id, conv))) {
          console.log(`✋ IA en pausa (master switch) tenant ${tenant.id} — no se dispatcha conv ${conv.id} (${channel})`);
          continue;
        }
        // v0.9.131: disparar a Aitana (n8n). El envío de la respuesta lo rutea
        // /whatsapp/send según conversation.channel (Send API de la página).
        dispatchToN8n(conv).catch(e => console.error(`Error dispatch n8n (${channel}):`, e.message));
      } catch (e) { console.error(`[webhook ${channel}] evento:`, e.message); }
    }
    // v0.9.142 — comentarios (FB feed / IG comments) llegan por entry.changes[]
    for (const change of entry.changes || []) {
      handleCommentChange(channel, recipientPageId, change).catch(e => console.error(`[webhook ${channel} comment]`, e.message));
    }
  }
}

// v0.9.142 — Ingesta de comentarios (FB Page feed + IG comments). Guarda el
// comentario y le manda un DM privado al que comentó (private reply) para pasarlo
// a conversación, donde Aitana lo atiende como un lead más.
async function handleCommentChange(channel, entryId, change) {
  const field = change.field;
  const v = change.value || {};
  let commentChannel, commentId, fromId, fromName, text, postId, parentId;
  if (field === 'feed' && v.item === 'comment' && (v.verb === 'add' || v.verb === 'edited')) {
    commentChannel = 'facebook';
    commentId = v.comment_id; fromId = v.from?.id; fromName = v.from?.name || null;
    text = v.message || ''; postId = v.post_id || null; parentId = v.parent_id || null;
  } else if (field === 'comments') {
    commentChannel = 'instagram';
    commentId = v.id; fromId = v.from?.id; fromName = v.from?.username || null;
    text = v.text || ''; postId = v.media?.id || null; parentId = v.parent_id || null;
  } else {
    return; // change que no es comentario
  }
  if (!commentId || !fromId) return;

  const chForResolve = commentChannel === 'instagram' ? 'instagram' : 'messenger';
  const tcRes = await db.query(
    `SELECT tenant_id, page_id, ig_id, page_token_enc FROM tenant_channels
       WHERE active = TRUE AND channel = $1 AND (page_id = $2 OR ig_id = $2) LIMIT 1`,
    [chForResolve, String(entryId)]
  ).catch(() => ({ rows: [] }));
  const tc = tcRes.rows[0];
  if (!tc) { console.error(`🚨 [comment ${commentChannel}] entry=${entryId} sin tenant`); return; }
  // ignorar comentarios de la propia página/cuenta
  if (String(fromId) === String(tc.page_id) || (tc.ig_id && String(fromId) === String(tc.ig_id))) return;

  // guardar idempotente por comment_id
  const ins = await db.query(
    `INSERT INTO channel_comments (tenant_id, channel, page_id, comment_id, parent_id, post_id, from_id, from_name, text, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new')
     ON CONFLICT (comment_id) DO NOTHING RETURNING id`,
    [tc.tenant_id, commentChannel, tc.page_id, String(commentId), parentId ? String(parentId) : null, postId ? String(postId) : null, String(fromId), fromName, text]
  );
  if (!ins.rows.length) return; // ya procesado → no responder dos veces
  console.log(`💬 [comment ${commentChannel}] de ${fromName || fromId} (tenant ${tc.tenant_id}): ${String(text).slice(0, 60)}`);

  // auto-acción: DM privado al que comentó (lo pasa a conversación)
  const token = decryptSafe(tc.page_token_enc);
  if (!token) return;
  let dmText = `¡Hola${fromName ? ' ' + fromName : ''}! Vi tu comentario 🙌 Te escribo por acá para ayudarte mejor. ¿Qué estás buscando?`;
  // v0.9.566 — RESPUESTA PÚBLICA opcional sobre el comentario (switch por tenant).
  // FB: POST /{comment_id}/comments · IG: POST /{comment_id}/replies. Best-effort: si falla, el DM sigue.
  // v0.9.568 — la respuesta la REDACTA LA IA con contexto (post + comentario + negocio +
  // antirrepetición). El texto fijo del dueño pasa a ser indicación de estilo y respaldo.
  try {
    const cfg = await db.query(`SELECT COALESCE((to_jsonb(tenants)->>'comment_public_reply_enabled')::boolean, FALSE) AS on,
        NULLIF(to_jsonb(tenants)->>'comment_public_reply_text','') AS txt,
        COALESCE(NULLIF(to_jsonb(tenants)->>'comment_public_reply_mode',''),'ai') AS mode FROM tenants WHERE id = $1`, [tc.tenant_id]);
    const c = cfg.rows[0] || {};
    const wantPublic = !!c.on;
    let pubText = null;

    // 1) IA (una sola llamada devuelve el texto público y el DM personalizado)
    let ai = null;
    {
      try {
        ai = await require('./comment-reply-ai').generate({
          tenantId: tc.tenant_id, channel: commentChannel, commentText: text,
          fromName, postId, token, styleHint: c.txt || null,
          wantPublic: wantPublic && c.mode !== 'fixed',
        });
      } catch (e) { console.warn(`[comment-ai] generate falló: ${e.message}`); }
    }
    if (ai && ai.privado) dmText = ai.privado;
    if (wantPublic) {
      if (c.mode === 'fixed') pubText = c.txt || '¡Hola! 🙌 Te escribimos por mensaje privado para ayudarte mejor.';
      else if (ai) pubText = ai.publica; // null = spam/insulto → a propósito no se responde en público
      else pubText = c.txt || '¡Hola! 🙌 Te escribimos por mensaje privado para ayudarte mejor.'; // IA caída → respaldo
      if (ai && ai.tipo === 'spam') console.log(`🤐 [comment ${commentChannel}] clasificado spam/provocación → sin respuesta pública`);
    }

    // 2) Publicar. v0.9.569 — el resultado se GUARDA en el tenant: si Meta lo rechaza
    // (típicamente por falta de pages_manage_engagement), el dueño lo ve en el panel
    // en vez de creer que está respondiendo cuando no lo está.
    if (wantPublic && pubText) {
      const _cra = require('./comment-reply-ai');
      const edge = commentChannel === 'instagram' ? 'replies' : 'comments';
      const axios = require('axios');
      try {
        await axios.post(`https://graph.facebook.com/v21.0/${encodeURIComponent(String(commentId))}/${edge}`,
          { message: pubText }, { params: { access_token: token }, timeout: 10000 });
        await db.query(`UPDATE channel_comments SET status = 'public_replied', reply_text = $2 WHERE comment_id = $1 AND status NOT IN ('dm_sent')`, [String(commentId), pubText]).catch(() => {});
        await db.query(`UPDATE tenants SET comment_public_reply_error = NULL, comment_public_reply_error_at = NULL WHERE id = $1 AND comment_public_reply_error IS NOT NULL`, [tc.tenant_id]).catch(() => {});
        console.log(`📣 [comment ${commentChannel}] respuesta pública ${ai && ai.publica === pubText ? 'IA' : 'fija'}: ${pubText.slice(0, 70)}`);
      } catch (pubErr) {
        const raw = pubErr.response?.data?.error?.message || pubErr.message;
        const human = _cra.explainMetaError(raw, commentChannel);
        await db.query(`UPDATE channel_comments SET status = 'public_reply_denied' WHERE comment_id = $1 AND status NOT IN ('dm_sent')`, [String(commentId)]).catch(() => {});
        await db.query(`UPDATE tenants SET comment_public_reply_error = $2, comment_public_reply_error_at = NOW() WHERE id = $1`, [tc.tenant_id, human.slice(0, 500)]).catch(async () => {
          try { await require('./comment-reply-ai').ensureSchema(); } catch (e2) {}
        });
        console.warn(`🚫 [comment ${commentChannel}] Meta RECHAZÓ la respuesta pública (el DM privado igual sale): ${raw}`);
      }
    }
  } catch (e) { console.warn(`⚠️ [comment ${commentChannel}] respuesta pública falló:`, e.response?.data?.error?.message || e.message); }
  const pr = await meta.sendPrivateReplyToComment(tc.page_id, String(commentId), dmText, token);
  if (pr.success) {
    await db.query(`UPDATE channel_comments SET status = 'dm_sent', replied_at = NOW() WHERE comment_id = $1`, [String(commentId)]);
    console.log(`📩 [comment ${commentChannel}] DM privado → ${fromId}`);
  } else {
    await db.query(`UPDATE channel_comments SET status = 'dm_failed' WHERE comment_id = $1`, [String(commentId)]).catch(() => {});
    console.warn(`⚠️ [comment ${commentChannel}] DM falló: ${pr.error}`);
  }
}

async function dispatchToN8n(conversation) {
  if (!N8N_WEBHOOK_URL) {
    console.warn('⚠️ N8N_WEBHOOK_URL no configurado, saltando dispatch');
    return;
  }

  // Histórico de mensajes
  // v0.9.26: si la conversación tiene context_reset_at, Aitana solo "recuerda"
  // lo posterior al reset (los mensajes viejos siguen visibles en el panel).
  const historyRes = await db.query(
    `SELECT direction, sender_type, type, body, transcription, media_caption, created_at
     FROM messages
     WHERE conversation_id = $1
       AND ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
     ORDER BY created_at DESC
     LIMIT $2`,
    [conversation.id, HISTORY_SIZE, conversation.context_reset_at || null]
  );
  const history = historyRes.rows.reverse();

  // Último mensaje (el que acabamos de recibir)
  const lastMsgRes = await db.query(
    `SELECT * FROM messages
     WHERE conversation_id = $1 AND direction = 'incoming'
     ORDER BY created_at DESC LIMIT 1`,
    [conversation.id]
  );
  const lastMessage = lastMsgRes.rows[0] || null;

  // Catálogo de media disponible para que el bot decida qué enviar.
  // v0.9.22d: FIX multi-tenant — antes traía los assets de TODOS los tenants.
  // Ahora solo los de la org de la conversación (incluye los globales tenant 1
  // por compatibilidad, ya que SG Bolivia es el dueño de los assets base).
  // v0.9.27: assets filtrados por modo de venta — un asset viaja a Aitana solo
  // si es 'todos' o si el modo correspondiente está habilitado en la org.
  // Fallback al query viejo si la columna sale_mode aún no existe.
  let mediaRes;
  try {
    mediaRes = await db.query(
      `SELECT ma.asset_id, ma.type, ma.vertical, ma.triggers, ma.description
       FROM media_assets ma
       CROSS JOIN (SELECT software_bot_enabled, inventory_bot_enabled, realestate_bot_enabled,
                          COALESCE(to_jsonb(tenants) ->> 'services_bot_enabled', 'false')::boolean AS services_bot_enabled,
                          COALESCE(to_jsonb(tenants) ->> 'active_prompt_mode', 'software') AS active_prompt_mode
                   FROM tenants WHERE id = $1) tg
       WHERE ma.active = true AND (ma.tenant_id = $1 OR ($1 = 1 AND ma.tenant_id IS NULL))
         AND (
           COALESCE(ma.sale_mode, 'todos') = 'todos'
           OR (ma.sale_mode = 'software'  AND COALESCE(tg.software_bot_enabled, TRUE))
           OR (ma.sale_mode = 'articulos' AND COALESCE(tg.inventory_bot_enabled, FALSE))
           OR (ma.sale_mode = 'inmuebles' AND COALESCE(tg.realestate_bot_enabled, FALSE))
           OR (ma.sale_mode = 'servicios' AND tg.services_bot_enabled)
           -- v0.9.70: assets etiquetados con un RUBRO (salud/belleza/restaurante)
           -- viajan solo cuando ESE rubro es el modo activo
           OR (ma.sale_mode = tg.active_prompt_mode)
         )
       ORDER BY ma.vertical, ma.asset_id`,
      [conversation.tenant_id]
    );
  } catch (e) {
    // Columna sale_mode no migrada todavía → comportamiento anterior
    mediaRes = await db.query(
      `SELECT asset_id, type, vertical, triggers, description
       FROM media_assets
       WHERE active = true AND (tenant_id = $1 OR ($1 = 1 AND tenant_id IS NULL))
       ORDER BY vertical, asset_id`,
      [conversation.tenant_id]
    );
  }

  // v0.9.346: tasa BCB para inyectar cada precio en AMBAS monedas (price_ref).
  // Motivo (test en vivo 8-jul): la IA comparaba "Bs 650.000" contra un presupuesto
  // de "USD 120.000" sin convertir → decía que no había nada dentro del presupuesto.
  let _usdBs = 0;
  try { _usdBs = await getUsdToBsRate(db); } catch (e) { /* sin tasa → sin price_ref */ }
  const _fmtN = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const _priceRef = (price, currency) => {
    const p = Number(price);
    if (!p || !_usdBs) return null;
    const cur = String(currency || 'Bs').trim().toUpperCase();
    if (cur === 'USD' || cur === 'US$' || cur === '$US' || cur === '$') return `USD ${_fmtN(p)} (≈ Bs ${_fmtN(p * _usdBs)})`;
    return `Bs ${_fmtN(p)} (≈ USD ${_fmtN(p / _usdBs)})`;
  };
  // v0.9.346: los Excel C21 traen "Precio: $us. 93.000.-" DENTRO de la descripción →
  // ficha con precio doble (y a veces contradictorio con el campo price). Se filtra
  // al vuelo acá (y la migración v0946 limpia la DB).
  const _stripPriceLines = (desc) => {
    if (!desc) return desc;
    const out = String(desc).split(/\r?\n/).filter((l) => !/^\s*precio(\s+de\s+\S+)?\s*[:.]/i.test(l.trim())).join('\n').trim(); // v0.9.348: también "Precio de alquiler:/de venta:"
    return out || null;
  };

  // v0.9.21: catálogo de inventario para el bot SOLO si la org lo habilitó.
  // CLAVE: se manda `in_stock` (booleano), NUNCA el número de existencias →
  // Aitana sabe si ofrecer el artículo pero no puede revelar cantidades.
  let _lineSaleMode = null; // v0.9.549 — modo de la línea, visible para inventario E inmuebles
  let inventoryCatalog = [];
  try {
    const flag = await db.query(`SELECT COALESCE(to_jsonb(tenants) ->> 'inventory_bot_enabled','false')::boolean AS inv, COALESCE(to_jsonb(tenants) ->> 'vehiculos_bot_enabled','false')::boolean AS veh, COALESCE(to_jsonb(tenants) ->> 'restaurante_bot_enabled','false')::boolean AS resto FROM tenants WHERE id = $1`, [conversation.tenant_id]);
    const _fr = (flag.rows[0] || {});
    // v0.9.549 — MODO POR LÍNEA: la línea de ESTA conversación manda sobre los flags del tenant.
    try {
      if (conversation.line_id) {
        const _lmq = await db.query(`SELECT to_jsonb(tenant_lines)->>'sale_mode' AS m FROM tenant_lines WHERE id=$1`, [conversation.line_id]);
        _lineSaleMode = (_lmq.rows[0] && _lmq.rows[0].m) || null;
      }
      if (_lineSaleMode) { _fr.inv = _lineSaleMode === 'articulos'; _fr.veh = _lineSaleMode === 'vehiculos'; _fr.resto = _lineSaleMode === 'restaurante'; }
    } catch (e) { /* columna sin migrar → hereda */ }
    // v0.9.406 — Concesionaria (vehiculos) usa la tabla inventory_items pero es un MODE_FLAG exclusivo
    // (prenderlo apaga inventory_bot_enabled) → el webhook nunca armaba el catálogo y el bot quedaba sin
    // autos. Ahora vehiculos_bot_enabled TAMBIÉN dispara la carga del catálogo (misma tabla inventory_items).
    // v0.9.545 — CATÁLOGO EN VIVO desde el sistema de Inventario (solo modo artículos, solo si
    // el tenant vinculó su cuenta). Si Inventario no responde, cae al catálogo local de siempre.
    // Inmuebles no pasa por acá (usa realestateCatalog más abajo).
    if (_fr.inv && !inventoryCatalog.length) {
      try {
        const _live = await require('./inventario-link').getLiveCatalog(conversation.tenant_id);
        if (_live && _live.length) {
          inventoryCatalog = _live;
          console.log(`🔗 [inv-link] catálogo VIVO de Inventario (${_live.length} productos) para tenant ${conversation.tenant_id}`);
        }
      } catch (e) { /* sin vínculo o módulo → catálogo local */ }
    }
    if (!inventoryCatalog.length && (_fr.inv || _fr.veh || _fr.resto)) {
      // v0.9.452 — cada modo lee SU tabla: vehiculos ya no comparte inventory_items con artículos.
      const _invTbl = _fr.resto ? 'catalog_restaurante' : (_fr.veh ? 'catalog_vehiculos' : 'inventory_items');
      // v0.9.42: ficha completa — marca/categoría/características + fotos por
      // etiqueta + docs_count, igual que inmuebles. to_jsonb = tolerante si la
      // migración v0.9.42 no corrió todavía.
      const inv = await db.query(
        `SELECT id, code, name, description, price, currency, (stock > 0) AS in_stock,
                to_jsonb(${_invTbl}) ->> 'brand'    AS brand,
                to_jsonb(${_invTbl}) ->> 'category' AS category,
                to_jsonb(${_invTbl}) ->> 'subcategory' AS subcategory,
                to_jsonb(${_invTbl}) ->> 'features' AS features,
                COALESCE(to_jsonb(${_invTbl}) -> 'image_urls',   '[]'::jsonb) AS image_urls,
                COALESCE(to_jsonb(${_invTbl}) -> 'image_labels', '{}'::jsonb) AS image_labels,
                COALESCE(jsonb_array_length(COALESCE(to_jsonb(${_invTbl}) -> 'file_urls', '[]'::jsonb)), 0) AS docs_count,
                image_url
         FROM ${_invTbl}
         WHERE tenant_id = $1 AND active = TRUE
         ORDER BY LOWER(name) LIMIT 300`,
        [conversation.tenant_id]
      );
      // Lista de vistas fotografiadas (sin URLs — Aitana pide por etiqueta con
      // photo_label y el backend resuelve). 'foto N' si no tiene etiqueta.
      inventoryCatalog = inv.rows.map(row => {
        const urls = (Array.isArray(row.image_urls) && row.image_urls.length) ? row.image_urls : (row.image_url ? [row.image_url] : []);
        const lbls = (row.image_labels && typeof row.image_labels === 'object') ? row.image_labels : {};
        const photos = urls.map((u, idx) => lbls[u] || `foto ${idx + 1}`);
        const { image_urls, image_labels, image_url, ...rest } = row;
        return { ...rest, photos, price_ref: _priceRef(row.price, row.currency) }; // v0.9.346
      });
    }
  } catch (e) {
    // inventario aún no migrado → catálogo vacío, no rompe el dispatch
  }

  // v0.9.22: catálogo de inmuebles para el bot SOLO si la org lo habilitó.
  // En inmuebles SÍ se muestran precio/zona/detalles (es el objetivo), solo los disponibles.
  let realestateCatalog = [];
  try {
    const flag = await db.query('SELECT realestate_bot_enabled FROM tenants WHERE id = $1', [conversation.tenant_id]);
    if (flag.rows[0] && (typeof _lineSaleMode === 'string' && _lineSaleMode ? _lineSaleMode === 'inmuebles' : flag.rows[0].realestate_bot_enabled)) { // v0.9.549
      // v0.9.431 — selección por RELEVANCIA (catalog-matcher): con 5.000+ propiedades
      // el LIMIT 200 por recencia dejaba al modelo ciego al inventario real (B-01).
      // Con search_profile del lead viajan los top relevantes; sin perfil, recencia.
      const { selectRelevantProperties } = require('./catalog-matcher');
      const pr = { rows: await selectRelevantProperties(db, {
        tenantId: conversation.tenant_id,
        lineId: conversation.line_id || null,
        searchProfile: conversation.search_profile,
      }) };
      // v0.9.35: lista de ambientes fotografiados (sin URLs — Aitana pide por
      // etiqueta con photo_label y el backend resuelve). 'foto N' si no tiene.
      realestateCatalog = pr.rows.map(row => {
        const urls = Array.isArray(row.image_urls) ? row.image_urls : [];
        const lbls = (row.image_labels && typeof row.image_labels === 'object') ? row.image_labels : {};
        const photos = urls.map((u, idx) => lbls[u] || `foto ${idx + 1}`);
        // v0.9.244: el `code` es INTERNO (referencia del asesor) → NO se manda a la IA, así no
        // lo nombra al cliente sin que se lo pidan (era el "P450" que aparecía en la respuesta).
        const { image_urls, image_labels, code, promotions, ...rest } = row;
        rest.description = _stripPriceLines(rest.description); // v0.9.346: sin "Precio:" duplicado del C21
        // v0.9.570 — PROMOS: a la IA le llegan SOLO las vigentes hoy y sin fechas comparables
        // (el vencimiento ya viene como texto "31 de agosto"). No puede ofrecer una vencida.
        const _pms = require('./promos').forAI(promotions);
        return { ...rest, photos, price_ref: _priceRef(row.price, row.currency), ...(_pms.length ? { promociones: _pms } : {}) }; // v0.9.346
      });
      // v0.9.440 — el inmueble matcheado con el ANUNCIO de origen viaja SIEMPRE (y primero),
      // aunque la selección por relevancia no lo hubiera elegido.
      const _apid = Number(conversation.ad_property_id) || null;
      if (_apid && !realestateCatalog.some((r) => r.id === _apid)) {
        try {
          const ap = await db.query(
            `SELECT id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, description,
                    maps_url, COALESCE(jsonb_array_length(file_urls), 0) AS docs_count,
                    to_jsonb(properties) ->> 'availability' AS availability,
                    COALESCE(to_jsonb(properties) -> 'promotions', '[]'::jsonb) AS promotions,
                    image_urls, COALESCE(to_jsonb(properties) -> 'image_labels', '{}'::jsonb) AS image_labels
             FROM properties WHERE id = $1 AND tenant_id = $2 AND active = TRUE`, [_apid, conversation.tenant_id]);
          if (ap.rows[0]) {
            const row = ap.rows[0];
            const urls = Array.isArray(row.image_urls) ? row.image_urls : [];
            const lbls = (row.image_labels && typeof row.image_labels === 'object') ? row.image_labels : {};
            const photos = urls.map((u, idx) => lbls[u] || `foto ${idx + 1}`);
            const { image_urls, image_labels, code, promotions, ...rest } = row;
            rest.description = _stripPriceLines(rest.description);
            const _pms = require('./promos').forAI(promotions); // v0.9.570
            realestateCatalog.unshift({ ...rest, photos, price_ref: _priceRef(row.price, row.currency), ...(_pms.length ? { promociones: _pms } : {}) });
          }
        } catch (e) { /* best-effort */ }
      }
    }
  } catch (e) { /* no migrado → vacío */ }

  // v0.9.49: catálogo de SERVICIOS para el bot SOLO si la org habilitó el modo.
  let servicesCatalog = [];
  try {
    const flag = await db.query(`SELECT COALESCE(to_jsonb(tenants) ->> 'services_bot_enabled','false')::boolean AS svc, COALESCE(to_jsonb(tenants) ->> 'salud_bot_enabled','false')::boolean AS salud, COALESCE(to_jsonb(tenants) ->> 'belleza_bot_enabled','false')::boolean AS belleza, COALESCE(to_jsonb(tenants) ->> 'arquitectura_bot_enabled','false')::boolean AS arq FROM tenants WHERE id = $1`, [conversation.tenant_id]);
    const _fs = (flag.rows[0] || {});
    if (_fs.svc || _fs.salud || _fs.belleza || _fs.arq) { // v0.9.122: arquitectura lee `services`
      const _svcTbl = _fs.salud ? 'catalog_salud' : (_fs.belleza ? 'catalog_belleza' : (_fs.arq ? 'catalog_arquitectura' : 'services')); // v0.9.452: arquitectura con tabla propia
      const sv = await db.query(
        `SELECT id, code, name, category, description, price, currency, price_unit, duration_minutes,
                capacity, features, schedule_notes, booking_url, image_urls, image_labels,
                COALESCE(jsonb_array_length(file_urls), 0) AS docs_count
         FROM ${_svcTbl} WHERE tenant_id = $1 AND active = TRUE
         ORDER BY LOWER(name) LIMIT 200`,
        [conversation.tenant_id]
      );
      servicesCatalog = sv.rows.map(row => {
        const urls = Array.isArray(row.image_urls) ? row.image_urls : [];
        const lbls = (row.image_labels && typeof row.image_labels === 'object') ? row.image_labels : {};
        const photos = urls.map((u, idx) => lbls[u] || `foto ${idx + 1}`);
        const { image_urls, image_labels, ...rest } = row;
        return { ...rest, photos };
      });
    }
  } catch (e) { /* tabla services no migrada → vacío */ }

  const payload = {
    event: 'message.incoming',
    conversation: {
      id: conversation.id,
      phone: conversation.phone,
      tenant_id: conversation.tenant_id,              // v0.9.131: para resolver el prompt sin teléfono (IG/Messenger)
      channel: conversation.channel || 'whatsapp',    // v0.9.131
      channel_user_id: conversation.channel_user_id || null, // v0.9.131
      // v0.9.375 — SOLO el primer nombre al bot: con "Jose" en vez de "Jose Said" el modelo
      // no puede abusar del nombre completo (pedido de José: lo repetía cada 2-3 mensajes).
      // El CRM/panel conservan el nombre completo; esto es solo lo que VE el bot.
      contact_name: String(conversation.contact_name || '').trim().split(/\s+/)[0] || conversation.contact_name,
      campaign_ref: conversation.campaign_ref,
      vertical: conversation.vertical,
      mode: conversation.mode,
      bant_progress: conversation.bant_progress || {},
      spin_progress: conversation.spin_progress || {},
      current_score: conversation.current_score || 0,
      stage: conversation.stage || 'venta', // v0.9.26: venta | postventa
      search_profile: conversation.search_profile || {}, // v0.9.349: perfil ACUMULADO al prompt (n8n v3.13 lo imprime; versiones viejas lo ignoran)
      sl_state: conversation.sl_state || {}, // v0.9.369: STRAIGHT LINE acumulado (n8n v3.15 lo imprime; versiones viejas lo ignoran)
    },
    last_message: lastMessage ? {
      id: lastMessage.id,
      type: lastMessage.type,
      body: lastMessage.body,
      transcription: lastMessage.transcription,
      media_id: lastMessage.media_id,
      media_mime_type: lastMessage.media_mime_type,
      media_caption: lastMessage.media_caption,
      received_at: lastMessage.created_at,
    } : null,
    history: history.map(h => ({
      direction: h.direction,
      sender_type: h.sender_type,
      type: h.type,
      body: h.body || h.transcription || h.media_caption,
      created_at: h.created_at,
    })),
    media_catalog: mediaRes.rows,
    inventory_catalog: inventoryCatalog, // v0.9.21 (vacío si el toggle está OFF)
    realestate_catalog: realestateCatalog, // v0.9.22 (vacío si el toggle está OFF)
    services_catalog: servicesCatalog, // v0.9.49 (vacío si el toggle está OFF)
  };

  // v0.9.571 — REINTENTO CON BACKOFF. Antes UN solo intento: si n8n devolvía 503
  // ("Database is not ready!" tras reiniciar su Postgres) el mensaje se DESCARTABA y
  // el lead nunca recibía respuesta. Ahora 3 intentos escalonados; el 90% de las
  // caídas de n8n dura segundos y se resuelve acá sin que nadie se entere.
  let _lastErr = null;
  for (let intento = 1; intento <= N8N_TRIES; intento++) {
    try {
      await postToN8n(payload);
      console.log(`📤 Dispatched to n8n: conv=${conversation.id} phone=${conversation.phone}${intento > 1 ? ` (intento ${intento})` : ''}`);
      _n8nFailStreak = 0; // v0.9.354: dispatch OK → resetea la racha de fallos
      return;
    } catch (e) {
      _lastErr = e;
      const st = e.response?.status || e.code || 's/r';
      if (intento < N8N_TRIES) {
        console.warn(`⏳ n8n intento ${intento}/${N8N_TRIES} falló (HTTP ${st}) — reintento en ${N8N_BACKOFF_MS[intento - 1] / 1000}s`);
        await new Promise((r) => setTimeout(r, N8N_BACKOFF_MS[intento - 1]));
      }
    }
  }
  {
    const e = _lastErr;
    console.error('❌ n8n dispatch error:', e.response?.status, e.response?.data || e.message);
    // v0.9.571 — el mensaje NO se pierde: queda en cola y el watchdog lo reintenta
    // cuando n8n vuelva. Si expira, se escala a un humano en vez de morir en silencio.
    try { await require('./n8n-watchdog').enqueue(conversation, payload, e.response?.data ? JSON.stringify(e.response.data) : e.message); }
    catch (qe) { console.error('[n8n] encolar falló:', qe.message); }
    // v0.9.354 — ALERTA BOT CAÍDO (hallazgo pruebas redondas 9-jul: un workflow mal activado
    // dejó a Aitana MUDA para todos los tenants y solo se veía en el log). 3 fallos SEGUIDOS
    // de dispatch (404 = webhook n8n no registrado / 5xx / timeout) → aviso a José por
    // push + WhatsApp, con cooldown de 30 min para no spamear mientras siga caído.
    _n8nFailStreak++;
    if (_n8nFailStreak >= 3 && Date.now() - _n8nDownAlertAt > 30 * 60 * 1000) {
      _n8nDownAlertAt = Date.now();
      notifyOwnerBotDown(`El dispatch a n8n lleva ${_n8nFailStreak} fallos seguidos (HTTP ${e.response?.status || e.code || 's/r'}). Aitana NO está respondiendo a los clientes de NINGÚN tenant. Los mensajes quedan EN COLA y se reintentan solos cuando vuelva. Causa típica: n8n zombi tras reiniciar su Postgres (503 "Database is not ready!"), workflow inactivo, o n8n caído.`)
        .catch((err) => console.warn('[bot-down] alerta falló:', err.message));
    }
  }
}

// v0.9.571 — POST crudo a n8n (lo usan el dispatch y el drenaje de la cola).
const N8N_TRIES = 3;
const N8N_BACKOFF_MS = [1500, 5000];
async function postToN8n(payload) {
  await axios.post(N8N_WEBHOOK_URL, payload, {
    headers: { 'Content-Type': 'application/json', 'X-CRM-Secret': N8N_SHARED_SECRET },
    timeout: 30000,
  });
}

// v0.9.354 — aviso a JOSÉ (dueño de plataforma) cuando el BOT queda mudo/degradado.
// Mismo patrón que notifyOwnerLineDown de api.js: push a owners del tenant 1 + WhatsApp a OWNER_PHONE.
let _n8nFailStreak = 0;
let _n8nDownAlertAt = 0;
async function notifyOwnerBotDown(detail) {
  // v0.9.572 — EMAIL primero: es el canal que NO depende del navegador (push) ni del
  // propio CRM (WhatsApp). En el incidente del 10-ago no llegó ningún aviso en 30 min.
  try {
    const _ok = /volvió|recuperad/i.test(String(detail || ''));
    await require('./mailer').alert(_ok ? 'bot-up' : 'bot-down', {
      title: _ok ? 'Aitana volvió a responder' : 'Aitana está MUDA',
      detail,
      severity: _ok ? 'ok' : 'error',
    });
  } catch (e) { console.warn('[bot-down] email falló:', e.message); }
  try {
    const pushNotifier = require('./push-notifier');
    await pushNotifier.broadcast({
      title: '🤖🔴 Bot caído',
      body: detail.slice(0, 180),
      url: '/panel/',
    }, 1, { roles: ['owner'] });
  } catch (e) { console.warn('[bot-down] push falló:', e.message); }
  // v0.9.572 — VENTANA DE 24 h. Descubierto en el incidente del 10-ago: la alerta por
  // WhatsApp NUNCA llegó porque el mensaje libre solo se puede mandar si el destinatario
  // escribió en las últimas 24 h. Y una alerta, por definición, salta cuando NADIE está
  // chateando: el canal estaba roto justo cuando hacía falta.
  //   · Con ALERT_TEMPLATE_NAME configurado (plantilla aprobada por Meta, 1 parámetro de
  //     texto en el body) → se manda como PLANTILLA, que sí sale fuera de la ventana.
  //   · Sin plantilla → se intenta el mensaje libre y, si Meta lo rechaza por la ventana,
  //     se dice con todas las letras en el log. El EMAIL de arriba ya salió igual.
  try {
    let phone = process.env.OWNER_PHONE || null;
    if (!phone) { const _ap = (await db.query('SELECT alert_phone FROM tenants WHERE id = 1')).rows[0]; phone = _ap && _ap.alert_phone; }
    if (!phone) return;
    const ctx = await getConversationMetaCtx({ tenant_id: 1 });
    const tpl = process.env.ALERT_TEMPLATE_NAME || null;
    let r;
    if (tpl) {
      const _txt = String(detail).replace(/\s+/g, ' ').slice(0, 900);
      r = await meta.sendTemplate(phone, tpl, process.env.ALERT_TEMPLATE_LANG || 'es',
        [{ type: 'body', parameters: [{ type: 'text', text: _txt }] }], ctx);
      if (!r || !r.success) console.warn(`[bot-down] plantilla "${tpl}" falló: ${r && r.error}. Revisá que esté APROBADA y con 1 parámetro en el body.`);
    } else {
      r = await meta.sendText(phone, `🤖🔴 *Bot caído / degradado*\n\n${detail}`, false, ctx);
      if (r && !r.success && /24 hours|131047|re-?engagement|outside/i.test(String(r.error || ''))) {
        console.warn('[bot-down] ⚠️ WhatsApp NO salió: la ventana de 24 h está cerrada (es lo normal en una alerta). Configurá ALERT_TEMPLATE_NAME con una plantilla aprobada. El email SÍ se envió.');
      }
    }
  } catch (e) { console.warn('[bot-down] WhatsApp falló:', e.message); }
}
// (notifyOwnerBotDown se exporta abajo, en el module.exports final)

/**
 * Analiza multimedia con Gemini:
 * - Audio: transcribe a texto
 * - Imagen: describe el contenido relevante para venta
 * - Video: describe los frames clave
 *
 * Retorna el texto resultante o null si falla.
 */
async function analyzeMediaWithGeminiBuffer(buffer, mimeType, type, usageCtx = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('ℹ️  GEMINI_API_KEY no configurado, no se procesa multimedia');
    return null;
  }

  if (!buffer) {
    console.error('analyzeMediaWithGeminiBuffer: buffer vacío');
    return null;
  }
  const base64Data = buffer.toString('base64');

  // 2. Construir prompt según tipo de multimedia
  let prompt;
  if (type === 'audio') {
    prompt = 'Transcribe el siguiente audio en español. Devuelve SOLO la transcripción exacta de lo que se dice, sin comentarios, sin formato, sin agregar contexto. Si el audio no es entendible o está vacío, responde con el texto: [audio inaudible]';
  } else if (type === 'image') {
    prompt = 'Describe en español, en máximo 2 líneas, el contenido relevante de esta imagen desde la perspectiva de un asesor de ventas que necesita entender qué pregunta o muestra el cliente. Si es una captura de pantalla, menciona qué se ve. Si es una foto de un producto/lugar/persona, describe qué hay. Responde directo, sin frases como "la imagen muestra".';
  } else if (type === 'video') {
    prompt = 'Describe en español, en máximo 2 líneas, el contenido relevante de este video desde la perspectiva de un asesor de ventas. Responde directo, sin frases introductorias.';
  } else if (type === 'document') {
    // v0.9.500 — resumen de PDF entrante (plano, título, boleta, cotización, contrato).
    prompt = 'Resumí en español, en 2 a 4 líneas, de qué trata este documento desde la perspectiva de un asesor inmobiliario. Indicá el tipo (ej: plano, título de propiedad, boleta, cotización, contrato, folleto) y los datos clave que contiene (dirección, superficie, precio, nombres, fechas) si aparecen. Directo, sin "el documento muestra".';
  } else {
    return null;
  }

  // 3. Llamar a Gemini con el archivo en base64
  const model = process.env.GEMINI_MODEL_PRIMARY || _GEM_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  // Normalizar MIME type
  let geminiMimeType = mimeType || 'application/octet-stream';
  if (type === 'document' && !/pdf/i.test(geminiMimeType)) {
    geminiMimeType = 'application/pdf'; // v0.9.500 — solo llegamos acá con PDF
  }
  if (type === 'audio' && !geminiMimeType.startsWith('audio/')) {
    geminiMimeType = 'audio/ogg'; // WhatsApp manda OGG por default
  }

  const requestBody = {
    contents: [{
      parts: [
        { text: prompt },
        {
          inline_data: {
            mime_type: geminiMimeType,
            data: base64Data,
          },
        },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 500,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  // v0.9.151 — log de tokens en ai_usage (cierra el gap: hasta ahora solo n8n
  // poblaba ai_usage; las llamadas a Gemini del BACKEND no se cobraban). Best-effort:
  // NUNCA rompe el flujo de análisis de multimedia si falla el log.
  async function logGeminiUsage(usageMetadata, usedModel) {
    try {
      if (!usageCtx || !usageCtx.tenantId || !usageMetadata) return;
      const promptTokens = Number(usageMetadata.promptTokenCount) || 0;
      const outputTokens = Number(usageMetadata.candidatesTokenCount) || 0;
      const totalTokens = Number(usageMetadata.totalTokenCount) || (promptTokens + outputTokens);
      await db.query(
        `INSERT INTO ai_usage (tenant_id, conversation_id, phone, model, prompt_tokens, output_tokens, total_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [usageCtx.tenantId, usageCtx.conversationId || null, usageCtx.phone || null,
         usedModel || null, promptTokens, outputTokens, totalTokens]
      );
    } catch (e) {
      console.warn('[ai_usage] log multimedia falló (no bloqueante):', e.message);
    }
  }

  try {
    const resp = await axios.post(url, requestBody, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    await logGeminiUsage(resp.data?.usageMetadata, model);
    const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('Gemini error:', err.response?.status, err.response?.data?.error?.message || err.message);
    // Fallback a 1.5-flash si 2.5 falla
    if (model.includes('2.5')) {
      try {
        const fallbackUrl = `https://generativelanguage.googleapis.com/v1beta/models/${_GEM_FALLBACK}:generateContent?key=${apiKey}`;
        const respFb = await axios.post(fallbackUrl, requestBody, {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json' },
        });
        await logGeminiUsage(respFb.data?.usageMetadata, _GEM_FALLBACK);
        return respFb.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
      } catch (fbErr) {
        console.error('Gemini 1.5 fallback también falló:', fbErr.message);
        return null;
      }
    }
    return null;
  }
}

/**
 * v0.9.532 — Transcripción DIFERIDA de una nota de voz. Se llama cuando el asesor ABRE el chat
 * (lazy), para no gastar Gemini transcribiendo audios de conversaciones humanas que quizá nadie
 * mire. Baja el audio desde R2 (media_url), lo transcribe y lo guarda. Idempotente (guard
 * transcription IS NULL) y best-effort. Devuelve la transcripción o null.
 */
async function transcribeAudioMessage(msg, usageCtx = null) {
  try {
    if (!msg || msg.type !== 'audio' || !msg.media_url || msg.transcription) return null;
    const resp = await axios.get(msg.media_url, { responseType: 'arraybuffer', timeout: 20000 });
    const buffer = Buffer.from(resp.data);
    if (!buffer.length) return null;
    const txt = await analyzeMediaWithGeminiBuffer(buffer, msg.media_mime_type || 'audio/ogg', 'audio', usageCtx);
    if (!txt) return null;
    await db.query(`UPDATE messages SET transcription = $1 WHERE id = $2 AND transcription IS NULL`, [txt, msg.id]).catch(() => {});
    console.log(`🎙️  [lazy] audio transcrito al abrir el chat (msg=${msg.id}, ${txt.length} chars)`);
    return txt;
  } catch (e) {
    console.warn('[lazy-transcribe] falló:', e.message);
    return null;
  }
}

/**
 * Mapea MIME type a extensión de archivo apropiada.
 * Crítico para que el navegador renderice imagen/video/audio en vez de descargarlo.
 */
function mimeToExtension(mimeType, fallbackType) {
  const mime = (mimeType || '').toLowerCase();
  const map = {
    // Imágenes
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/heic': 'heic',
    // Videos
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
    'video/3gpp': '3gp',
    // Audios
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/ogg': 'ogg',
    'audio/ogg; codecs=opus': 'ogg',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/aac': 'aac',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/webm': 'webm',
    // Documentos
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'text/csv': 'csv',
  };
  if (map[mime]) return map[mime];
  // Si MIME no está mapeado, usar fallback genérico según tipo
  if (mime.startsWith('image/')) return 'jpg';
  if (mime.startsWith('video/')) return 'mp4';
  if (mime.startsWith('audio/')) return 'ogg'; // WhatsApp default
  if (fallbackType === 'image') return 'jpg';
  if (fallbackType === 'video') return 'mp4';
  if (fallbackType === 'audio') return 'ogg';
  return 'bin';
}

// =============================================================
// v0.7.8 P1 — matchEntryTemplate
// Busca un template de entrada que matchee con el primer mensaje
// del cliente. Devuelve { name, entry_context } si encuentra match,
// null si no.
// =============================================================
async function matchEntryTemplate(body, tenantId = 1) {
  if (!body || !body.trim()) return null;
  const normalized = body.trim().toLowerCase();

  // v0.9.44 (auditoría F3): filtrar por tenant — antes un pattern de un tenant
  // disparaba en TODOS (entry_context equivocado). Lectura vía to_jsonb:
  // si la columna tenant_id no existe (pre-migración v0.9.7), todos pasan (global).
  const res = await db.query(
    `SELECT name, pattern, match_type, entry_context
     FROM bot_entry_templates
     WHERE active = TRUE
       AND ((to_jsonb(bot_entry_templates) ->> 'tenant_id') IS NULL
            OR (to_jsonb(bot_entry_templates) ->> 'tenant_id')::int = $1)
     ORDER BY id ASC`,
    [Number(tenantId) || 1]
  );

  for (const t of res.rows) {
    const pat = (t.pattern || '').toLowerCase();
    if (!pat) continue;
    let isMatch = false;
    if (t.match_type === 'exact') {
      isMatch = normalized === pat;
    } else if (t.match_type === 'contains') {
      isMatch = normalized.includes(pat);
    } else if (t.match_type === 'regex') {
      try {
        isMatch = new RegExp(t.pattern, 'i').test(body);
      } catch (e) {
        // patrón inválido, skip
      }
    } else {
      // default: starts_with
      isMatch = normalized.startsWith(pat);
    }
    if (isMatch) {
      return { name: t.name, entry_context: t.entry_context };
    }
  }
  return null;
}


// v0.9.281 — OMNICANAL: ingesta de Telegram. Espeja handleMessengerWebhook + el path
// de media de WhatsApp (getFile → R2 → Gemini). Resuelve el tenant por el secret del
// webhook (uno por bot). ACK inmediato, procesa en segundo plano.
async function _resolveTelegramTenant(secret) {
  const r = await db.query(
    `SELECT t.*, tc.page_token_enc, tc.page_id AS bot_id,
            tc.business_owner_id, tc.business_connection_id
       FROM tenant_channels tc JOIN tenants t ON t.id = tc.tenant_id
      WHERE tc.channel = 'telegram' AND tc.active = TRUE AND tc.webhook_secret = $1 AND t.active = TRUE
      LIMIT 1`, [secret]).catch(() => ({ rows: [] }));
  return r.rows[0] || null;
}

async function handleTelegramWebhook(req, res) {
  res.sendStatus(200); // ACK inmediato (Telegram reintenta si no)
  try {
    const secret = req.params.secret;
    const hdr = req.get('X-Telegram-Bot-Api-Secret-Token');
    const upd = req.body || {};

    const tenant = await _resolveTelegramTenant(secret);
    if (!tenant || (hdr && hdr !== secret)) {
      console.error('🚨 [telegram] secret no matchea ningún bot activo — DESCARTADO');
      return;
    }
    const botToken = decryptSafe(tenant.page_token_enc);

    // v0.9.282 — Telegram Business: el dueño enlazó/desenlazó su cuenta personal al bot.
    if (upd.business_connection) { await _handleTgBusinessConnection(tenant, upd.business_connection); return; }

    // Mensaje normal (al bot) o de negocio (DM a la cuenta personal del dueño).
    const isBiz = !!upd.business_message;
    const msg = upd.message || upd.business_message;
    if (!msg || !msg.chat) return;
    const businessConnId = isBiz ? (msg.business_connection_id || null) : null;
    const ownerId = tenant.business_owner_id ? String(tenant.business_owner_id) : null;
    const fromOwner = !!(isBiz && ownerId && msg.from && String(msg.from.id) === ownerId);
    const chatId = String(msg.chat.id);
    // Para business, el "cliente" es el chat (msg.from puede ser el dueño respondiendo).
    const who = isBiz ? msg.chat : (msg.from || msg.chat);
    const name = [who && who.first_name, who && who.last_name].filter(Boolean).join(' ') || (who && who.username) || null;
    const conv = await upsertChannelConversation(tenant.id, 'telegram', chatId, name);
    if (businessConnId) {
      await db.query(`UPDATE conversations SET tg_business_connection_id = $1 WHERE id = $2 AND (tg_business_connection_id IS DISTINCT FROM $1)`, [businessConnId, conv.id]).catch(() => {});
    }

    // Clasificar (texto / media)
    let type = 'text', body = msg.text || null, caption = msg.caption || null, fileId = null, tgMime = null;
    if (msg.photo && msg.photo.length) { type = 'image'; fileId = msg.photo[msg.photo.length - 1].file_id; tgMime = 'image/jpeg'; }
    else if (msg.voice) { type = 'audio'; fileId = msg.voice.file_id; tgMime = msg.voice.mime_type || 'audio/ogg'; }
    else if (msg.audio) { type = 'audio'; fileId = msg.audio.file_id; tgMime = msg.audio.mime_type || 'audio/mpeg'; }
    else if (msg.video) { type = 'video'; fileId = msg.video.file_id; tgMime = msg.video.mime_type || 'video/mp4'; }
    else if (msg.video_note) { type = 'video'; fileId = msg.video_note.file_id; tgMime = 'video/mp4'; }
    else if (msg.document) { type = 'document'; fileId = msg.document.file_id; tgMime = msg.document.mime_type || 'application/octet-stream'; }
    else if (msg.sticker) { type = 'image'; fileId = msg.sticker.file_id; tgMime = 'image/webp'; }
    else if (!body) return; // location/contact/etc → ignorar por ahora

    // Media: descargar → R2 + Gemini (mismo camino que WhatsApp)
    let transcription = null, analyzedCaption = caption, mediaUrl = null, mediaMime = tgMime;
    if (fileId && botToken) {
      try {
        const dl = await tg.downloadFile(botToken, fileId);
        if (dl && dl.buffer) {
          mediaMime = dl.mimeType || tgMime;
          if (r2.isConfigured()) {
            try {
              const ext = mimeToExtension(mediaMime, type);
              const up = await r2.upload({ buffer: dl.buffer, mimeType: mediaMime, prefix: 'incoming', filename: `${type}-${Date.now()}.${ext}` });
              mediaUrl = up && up.url;
            } catch (e) { console.error(`⚠️  [telegram] R2 ${type}:`, e.message); }
          }
          if (type === 'audio' || type === 'image' || type === 'video') {
            try {
              const result = await analyzeMediaWithGeminiBuffer(dl.buffer, mediaMime, type, { tenantId: tenant.id, conversationId: conv.id });
              if (result) { if (type === 'audio') transcription = result; else analyzedCaption = result; }
            } catch (e) { console.error(`⚠️  [telegram] Gemini ${type}:`, e.message); }
          }
        }
      } catch (e) { console.error(`⚠️  [telegram] media ${type}:`, e.message); }
    }

    // Dedup por chat+message_id reusando wa_message_id UNIQUE
    const dedupId = `tg:${chatId}:${msg.message_id}`;

    // v0.9.282 — Business: si el mensaje lo mandó el DUEÑO desde su Telegram personal, lo
    // guardamos como SALIENTE (humano) para sincronizar el hilo y NO disparamos IA.
    if (fromOwner) {
      const insO = await db.query(
        `INSERT INTO messages
          (tenant_id, conversation_id, wa_message_id, direction, sender_type, type, body,
           media_url, media_mime_type, media_caption, transcription, raw_payload, status, created_at)
         VALUES ($1,$2,$3,'outgoing','human',$4,$5,$6,$7,$8,$9,$10,'sent',NOW())
         ON CONFLICT (wa_message_id) DO NOTHING
         RETURNING id`,
        [tenant.id, conv.id, dedupId, type, body, mediaUrl, mediaMime, analyzedCaption, transcription, JSON.stringify(upd)]
      );
      if (insO.rows.length) await db.query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conv.id]).catch(() => {});
      console.log(`📤 [telegram/biz] eco del dueño → conv ${conv.id} (sin IA)`);
      return;
    }

    // Guardar mensaje entrante
    const ins = await db.query(
      `INSERT INTO messages
        (tenant_id, conversation_id, wa_message_id, direction, sender_type, type, body,
         media_url, media_mime_type, media_caption, transcription, raw_payload, status, created_at)
       VALUES ($1,$2,$3,'incoming','client',$4,$5,$6,$7,$8,$9,$10,'delivered',NOW())
       ON CONFLICT (wa_message_id) DO NOTHING
       RETURNING id`,
      [tenant.id, conv.id, dedupId, type, body, mediaUrl, mediaMime, analyzedCaption, transcription, JSON.stringify(upd)]
    );
    if (!ins.rows.length) { console.log(`⏭ [telegram] ${dedupId} duplicado — ignorado`); return; }

    await db.query('UPDATE conversations SET unread_count = unread_count + 1, last_message_at = NOW() WHERE id = $1', [conv.id]);
    console.log(`📥 [telegram${isBiz ? '/biz' : ''}] ${type} de ${chatId} → tenant ${tenant.id} (conv ${conv.id})`);

    if (!(await aiEnabled(tenant.id, conv))) {
      console.log(`✋ IA en pausa (master switch) tenant ${tenant.id} — no dispatch conv ${conv.id} (telegram)`);
      return;
    }
    dispatchToN8n(conv).catch(e => console.error('Error dispatch n8n (telegram):', e.message));
  } catch (e) { console.error('[telegram webhook] error:', e.message); }
}

// v0.9.282 — Telegram Business: registra/limpia la conexión del bot con la cuenta personal del dueño.
async function _handleTgBusinessConnection(tenant, bc) {
  try {
    const connId = bc.id || null;
    const ownerId = bc.user && bc.user.id ? String(bc.user.id) : null;
    // can_reply: API vieja = bc.can_reply; nueva (9.0+) = bc.rights.can_reply
    const canReply = (bc.rights && typeof bc.rights.can_reply === 'boolean') ? bc.rights.can_reply
      : (typeof bc.can_reply === 'boolean' ? bc.can_reply : true);
    const enabled = bc.is_enabled !== false;
    if (enabled && connId) {
      await db.query(
        `UPDATE tenant_channels SET business_connection_id = $1, business_owner_id = $2, business_can_reply = $3
           WHERE tenant_id = $4 AND channel = 'telegram' AND page_id = $5`,
        [connId, ownerId, canReply, tenant.id, String(tenant.bot_id)]);
      console.log(`🔗 [telegram] Business conectado (tenant ${tenant.id}, owner ${ownerId}, reply=${canReply})`);
    } else {
      await db.query(
        `UPDATE tenant_channels SET business_connection_id = NULL, business_can_reply = FALSE
           WHERE tenant_id = $1 AND channel = 'telegram' AND page_id = $2`,
        [tenant.id, String(tenant.bot_id)]);
      console.log(`🔌 [telegram] Business desconectado (tenant ${tenant.id})`);
    }
  } catch (e) { console.error('[telegram business_connection] error:', e.message); }
}

// v0.9.326 — WORKER de recuperación de la cola durable. Reprocesa payloads que quedaron
// 'pending' (el server se reinició mientras procesaba) o 'processing' colgados (>10 min).
// Idempotente (dedup por wa_message_id en processIncomingMessage). Claim ATÓMICO con
// FOR UPDATE SKIP LOCKED → seguro con múltiples instancias. Lo corre un setInterval en server.js.
let _webhookRecoveryRunning = false;
async function runWebhookQueueRecovery() {
  if (_webhookRecoveryRunning) return { skipped: 'overlap' };
  _webhookRecoveryRunning = true;
  let recovered = 0, failed = 0;
  try {
    const claimed = await db.query(`
      UPDATE webhook_events SET status = 'processing', attempts = attempts + 1, claimed_at = NOW()
       WHERE id IN (
         SELECT id FROM webhook_events
          WHERE ((status = 'pending'    AND created_at < NOW() - INTERVAL '2 minutes')
              OR (status = 'processing' AND claimed_at < NOW() - INTERVAL '10 minutes'))
            AND attempts < 5
          ORDER BY id ASC LIMIT 50
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, payload`).catch((e) => {
        if (!/webhook_events|does not exist|relation/.test(e.message)) console.error('[webhook-recovery] claim:', e.message);
        return { rows: [] };
      });
    for (const r of claimed.rows) {
      try {
        await processWebhookPayload(r.payload);
        await db.query(`UPDATE webhook_events SET status = 'done', processed_at = NOW() WHERE id = $1`, [r.id]).catch(() => {});
        recovered++;
      } catch (e) {
        failed++;
        await db.query(
          `UPDATE webhook_events SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END, last_error = $2 WHERE id = $1`,
          [r.id, String((e && e.message) || e).slice(0, 300)]).catch(() => {});
      }
    }
    if (recovered || failed) console.log(`♻️  [webhook-recovery] ${recovered} reprocesados, ${failed} con error`);
    // Prune: 'done' con >3 días se borran (la tabla no crece indefinidamente).
    await db.query(`DELETE FROM webhook_events WHERE status = 'done' AND processed_at < NOW() - INTERVAL '3 days'`).catch(() => {});
    return { recovered, failed };
  } catch (e) {
    console.error('[webhook-recovery] error:', e.message);
    return { error: e.message };
  } finally { _webhookRecoveryRunning = false; }
}

module.exports = {
  verifyWebhook,
  handleWebhook,
  handleTelegramWebhook,
  runWebhookQueueRecovery,
  notifyOwnerBotDown, // v0.9.354: la usa /whatsapp/send (api.js) para alertar "Gemini degradado"
  transcribeAudioMessage, // v0.9.532: transcripción diferida de audio (la usa GET /admin/.../messages)
  postToN8n, // v0.9.571: lo usa el watchdog para drenar la cola de mensajes pendientes
};

