/**
 * Meta WhatsApp Cloud API client
 * Envía texto, video, imagen, documento, audio.
 *
 * v0.9.6 — Soporte multi-tenant RETROCOMPATIBLE:
 *   Cada función acepta un parámetro opcional `ctx` al final:
 *     ctx = { phoneNumberId, accessToken }
 *   Si NO se pasa ctx (todos los call sites legacy), usa las env vars globales
 *   (META_PHONE_NUMBER_ID + META_ACCESS_TOKEN) = comportamiento idéntico al anterior.
 *   Cuando se pasa ctx (tenants nuevos con su propio WABA), usa esas credenciales.
 *
 *   Esto permite que SG Bolivia (tenant 1, sin token propio) siga funcionando
 *   exactamente igual, mientras los tenants onboarded vía Embedded Signup usan
 *   su propio phone_number_id + access_token.
 */

const axios = require('axios');

const META_GRAPH_BASE = process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com';
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v25.0';
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;

const baseUrl = `${META_GRAPH_BASE}/${META_GRAPH_VERSION}`;

/**
 * Resuelve las credenciales a usar. Si ctx trae phoneNumberId + accessToken,
 * usa esos (tenant con WABA propio). Si no, cae a las globales (SG Bolivia / legacy).
 */
function _resolveCreds(ctx) {
  const phoneNumberId = ctx?.phoneNumberId || META_PHONE_NUMBER_ID;
  const accessToken = ctx?.accessToken || META_ACCESS_TOKEN;
  return { phoneNumberId, accessToken };
}

function _authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
}

async function sendText(to, text, previewUrl = true, ctx = null, replyTo = null) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: previewUrl, body: text },
  };
  // v0.9.377 — reply-quote: el mensaje sale CITANDO un mensaje del cliente (fichas).
  if (replyTo) payload.context = { message_id: replyTo };
  return _post(payload, ctx);
}

// v0.9.331 — Mensaje INTERACTIVO con botones de respuesta rápida (hasta 3). Solo dentro de la
// ventana de 24h (igual que el texto). buttons = [{ id, title }] (title <= 20 chars).
async function sendInteractiveButtons(to, bodyText, buttons, ctx = null) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: String(bodyText || '').slice(0, 1024) },
      action: {
        buttons: (buttons || []).slice(0, 3).map((b) => ({
          type: 'reply',
          reply: { id: String(b.id).slice(0, 256), title: String(b.title).slice(0, 20) },
        })),
      },
    },
  };
  return _post(payload, ctx);
}

// v0.9.344 — LIST MESSAGE de WhatsApp: menú desplegable de hasta 10 opciones
// (para elecciones entre muchas alternativas, donde 3 botones no alcanzan).
// rows = [{ id, title }] · title ≤24 chars · solo dentro de la ventana de 24h.
async function sendInteractiveList(to, bodyText, buttonLabel, rows, ctx = null) {
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: String(bodyText || '').slice(0, 1024) },
      action: {
        button: String(buttonLabel || 'Ver opciones').slice(0, 20),
        sections: [{
          rows: (rows || []).slice(0, 10).map((r) => ({
            id: String(r.id).slice(0, 200),
            title: String(r.title).slice(0, 24),
          })),
        }],
      },
    },
  };
  return _post(payload, ctx);
}

async function sendVideo(to, mediaUrl, caption = null, ctx = null) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'video',
    video: { link: mediaUrl, ...(caption && { caption }) },
  };
  return _post(payload, ctx);
}

// v0.9.130 — OMNICANAL: enviar texto por Messenger / Instagram DM (Send API).
// Usa el token de la PÁGINA (no el de WhatsApp) y otro endpoint ({page-id}/messages).
// recipientId = PSID (Messenger) o IGSID (Instagram). Mismo Send API para ambos.
async function sendMessengerText(pageId, recipientId, text, pageToken) {
  try {
    const resp = await axios.post(
      `${baseUrl}/${pageId}/messages`,
      { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
      { headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return { success: true, data: resp.data, messageId: resp.data?.message_id || null };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta Send API error (messenger/ig):', errMsg);
    return { success: false, error: errMsg };
  }
}

// Enviar imagen por Messenger / IG (attachment por URL).
async function sendMessengerImage(pageId, recipientId, imageUrl, pageToken) {
  try {
    const resp = await axios.post(
      `${baseUrl}/${pageId}/messages`,
      { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: false } } } },
      { headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    return { success: true, data: resp.data, messageId: resp.data?.message_id || null };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta Send API error (messenger/ig image):', errMsg);
    return { success: false, error: errMsg };
  }
}

// v0.9.237 — Trae el PERFIL (nombre + foto) de quien escribe por Messenger / Instagram.
//  · Messenger: GET /{PSID}?fields=first_name,last_name,profile_pic
//  · Instagram: GET /{IGSID}?fields=name,username,profile_pic
// Usa el token de la PÁGINA + permiso (pages_messaging / instagram_manage_messages).
// Best-effort: si Meta no lo da (permiso no aprobado o privacidad), devuelve null.
async function getChannelUserProfile(channel, userId, pageToken) {
  if (!userId || !pageToken) return null;
  const fields = channel === 'instagram' ? 'name,username,profile_pic' : 'first_name,last_name,profile_pic';
  try {
    const resp = await axios.get(`${baseUrl}/${userId}`, { params: { fields, access_token: pageToken }, timeout: 8000 });
    const d = resp.data || {};
    let name = null;
    if (channel === 'instagram') name = (d.name && String(d.name).trim()) || (d.username ? '@' + d.username : null);
    else name = [d.first_name, d.last_name].filter(Boolean).join(' ').trim() || null;
    return { name: name || null, avatar_url: d.profile_pic || null, username: d.username || null };
  } catch (e) {
    console.warn(`[meta] getChannelUserProfile (${channel}) falló:`, e.response?.data?.error?.message || e.message);
    return null;
  }
}

// v0.9.240 — Trae el NÚMERO real (display_phone_number, ej "+591 7XXXXXXX") + verified_name
// de una línea, dado su phone_number_id. La DB a veces guarda solo el nombre/ID; Meta es la
// fuente del número humano. Best-effort: null si falla.
async function getPhoneNumberInfo(phoneNumberId, accessToken) {
  if (!phoneNumberId || !accessToken) return null;
  try {
    const r = await axios.get(`${baseUrl}/${phoneNumberId}`, {
      params: { fields: 'display_phone_number,verified_name', access_token: accessToken }, timeout: 8000,
    });
    return { display_phone_number: r.data?.display_phone_number || null, verified_name: r.data?.verified_name || null };
  } catch (e) {
    console.warn('[meta] getPhoneNumberInfo falló:', e.response?.data?.error?.message || e.message);
    return null;
  }
}

/**
 * v0.9.515 — SONDA DE CAMPOS. Paso previo al pre-flight de conexión.
 *
 * El problema: los fallos al conectar un número casi nunca son técnicos, son
 * condiciones de Meta (el número no está en el portafolio, tiene verificación en
 * dos pasos, el nombre sigue en revisión, ya está en otra WABA…). Para poder
 * avisarle al dueño ANTES de que intente, hay que leer esos estados. Pero no
 * todos los campos están disponibles siempre: dependen de la versión de Graph y
 * del nivel de acceso de la app, y cuando la app tiene Standard Access **Meta los
 * omite en silencio, sin error**. Construir el pre-flight sobre campos que
 * suponemos que existen es la forma de que falle en la cuenta de un cliente.
 *
 * Por eso esto NO decide nada: pide los campos de a uno y reporta cuáles contestó
 * Meta y cuáles ignoró. Es un instrumento de medición, no una feature.
 */
const PROBE_PHONE_FIELDS = [
  'id', 'display_phone_number', 'verified_name', 'status', 'quality_rating',
  'name_status', 'new_name_status', 'code_verification_status', 'platform_type',
  'throughput', 'account_mode', 'is_official_business_account', 'is_pin_enabled',
  'certificate', 'search_visibility', 'messaging_limit_tier', 'country_dial_code',
];
const PROBE_WABA_FIELDS = [
  'id', 'name', 'currency', 'timezone_id', 'message_template_namespace',
  'account_review_status', 'business_verification_status', 'country',
  'ownership_type', 'primary_funding_id', 'purchase_order_number', 'status',
  'is_enabled_for_insights', 'health_status',
];

async function _probeFields(nodeId, accessToken, campos) {
  const out = { disponibles: {}, ausentes: [], errores: {} };
  // Uno por uno a propósito: si se piden todos juntos y UNO no existe, Graph
  // devuelve un error para toda la request y no se aprende nada de los demás.
  for (const f of campos) {
    try {
      const r = await axios.get(`${baseUrl}/${nodeId}`, {
        params: { fields: f, access_token: accessToken }, timeout: 8000,
      });
      const v = r.data ? r.data[f] : undefined;
      if (v === undefined) out.ausentes.push(f); // 200 pero sin el campo = lo omitió
      else out.disponibles[f] = v;
    } catch (e) {
      const err = e.response && e.response.data && e.response.data.error;
      out.errores[f] = { message: (err && err.message) || e.message, code: err && err.code, subcode: err && err.error_subcode };
    }
    await new Promise((r) => setTimeout(r, 60)); // Graph se enoja con ráfagas
  }
  return out;
}

/** Sonda completa: token, WABA y cada número. Best-effort, nunca lanza. */
async function probeOnboardingFields(wabaId, accessToken) {
  const res = { waba_id: wabaId, graph_version: META_GRAPH_VERSION, token: null, waba: null, numeros: [] };
  try {
    const dbg = await axios.get(`${baseUrl}/debug_token`, {
      params: { input_token: accessToken, access_token: accessToken }, timeout: 10000,
    });
    const d = (dbg.data && dbg.data.data) || {};
    res.token = {
      tipo: d.type || null, app_id: d.app_id || null, valido: d.is_valid === true,
      expira: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
      scopes: d.scopes || [],
      granular_scopes: (d.granular_scopes || []).map((g) => ({ scope: g.scope, target_ids: g.target_ids || [] })),
    };
  } catch (e) {
    res.token = { error: (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message };
  }
  res.waba = await _probeFields(wabaId, accessToken, PROBE_WABA_FIELDS);
  let phones = [];
  try {
    const r = await axios.get(`${baseUrl}/${wabaId}/phone_numbers`, {
      params: { access_token: accessToken, limit: 25 }, timeout: 12000,
    });
    phones = (r.data && r.data.data) || [];
  } catch (e) {
    res.numeros_error = (e.response && e.response.data && e.response.data.error && e.response.data.error.message) || e.message;
  }
  for (const p of phones.slice(0, 5)) { // 5 alcanza para saber qué campos existen
    const probe = await _probeFields(p.id, accessToken, PROBE_PHONE_FIELDS);
    res.numeros.push({ id: p.id, display: p.display_phone_number || null, probe });
  }
  return res;
}

// v0.9.143 — Lee los webhook fields a los que está suscrita la página (diagnóstico).
async function getPageSubscribedFields(pageId, pageToken) {
  const resp = await axios.get(`${baseUrl}/${pageId}/subscribed_apps`, {
    params: { access_token: pageToken },
    timeout: 15000,
  });
  return resp.data?.data || [];
}

// v0.9.142 — Comentarios: DM privado al que comentó (private reply → abre conversación).
// FB e IG: POST /{page-or-ig-id}/messages con recipient.comment_id.
async function sendPrivateReplyToComment(pageId, commentId, text, pageToken) {
  try {
    const resp = await axios.post(
      `${baseUrl}/${pageId}/messages`,
      { recipient: { comment_id: commentId }, message: { text } },
      { headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return { success: true, data: resp.data, messageId: resp.data?.message_id || null };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta private reply error:', errMsg);
    return { success: false, error: errMsg };
  }
}

// v0.9.142 — Responder un comentario en PÚBLICO. FB: POST /{comment-id}/comments ·
// IG: POST /{ig-comment-id}/replies.
async function replyToCommentPublic(commentId, text, pageToken, isInstagram = false) {
  try {
    const edge = isInstagram ? 'replies' : 'comments';
    const resp = await axios.post(
      `${baseUrl}/${commentId}/${edge}`,
      { message: text },
      { headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return { success: true, data: resp.data, id: resp.data?.id || null };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta comment reply error:', errMsg);
    return { success: false, error: errMsg };
  }
}

/**
 * v0.9.580 — HILO COMPLETO de un comentario.
 * ─────────────────────────────────────────────────────────────────────────────
 * Hasta ahora el panel mostraba SOLO el comentario original y, como una línea
 * suelta, el texto de nuestra última respuesta. Todo lo demás del hilo era
 * invisible: las respuestas de la página no se guardan (el webhook descarta los
 * comentarios de la propia cuenta, para no auto-contestarse) y las respuestas
 * posteriores del cliente entran como filas sueltas sin relación visible.
 *
 * Acá se pide el hilo REAL a Meta en el momento de abrirlo, así se ve la
 * conversación completa y en orden, con quién dijo cada cosa.
 *
 * Requiere pages_read_user_content (FB): es justo el permiso para leer contenido
 * generado por usuarios en la página. En IG lo cubre instagram_manage_comments.
 */
async function getCommentThread(commentId, pageToken, isInstagram = false) {
  try {
    const fields = isInstagram
      ? 'id,text,timestamp,username,from,replies{id,text,timestamp,username,from}'
      : 'id,message,created_time,from,comments.limit(50){id,message,created_time,from}';
    const resp = await axios.get(`${baseUrl}/${commentId}`, {
      params: { fields, access_token: pageToken },
      timeout: 15000,
    });
    const d = resp.data || {};
    const norm = (x) => ({
      id: x.id || null,
      text: (isInstagram ? x.text : x.message) || '',
      from_id: x.from?.id || null,
      from_name: x.from?.name || x.from?.username || x.username || null,
      at: x.timestamp || x.created_time || null,
    });
    const root = norm(d);
    const hijos = (isInstagram ? d.replies?.data : d.comments?.data) || [];
    return { success: true, root, replies: hijos.map(norm) };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta comment thread error:', errMsg);
    return { success: false, error: errMsg };
  }
}

// v0.9.283 — Ocultar/mostrar un comentario. FB: POST /{comment-id} {is_hidden}. IG: POST /{ig-comment-id} {hide}.
async function hideComment(commentId, hide, pageToken, isInstagram = false) {
  try {
    const payload = isInstagram ? { hide: !!hide } : { is_hidden: !!hide };
    const resp = await axios.post(
      `${baseUrl}/${commentId}`, payload,
      { headers: { Authorization: `Bearer ${pageToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    return { success: true, data: resp.data };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta hide comment error:', errMsg);
    return { success: false, error: errMsg };
  }
}

// v0.9.144 — Dispara 1 llamada Graph de lectura por permiso que el uso normal NO
// cubre, para satisfacer "required API test calls" del App Review. Usa el page token
// guardado. Devuelve OK/err por permiso (las de mensajería se registran con el uso real).
async function runReviewTestCalls(pageId, igId, pageToken) {
  const out = {};
  const hit = async (key, edge, params) => {
    try {
      const r = await axios.get(`${baseUrl}/${edge}`, { params: { access_token: pageToken, ...(params || {}) }, timeout: 15000 });
      const d = r.data || {};
      out[key] = { ok: true, sample: Array.isArray(d.data) ? `${d.data.length} item(s)` : (Object.keys(d).join(',') || 'ok') };
    } catch (e) {
      out[key] = { ok: false, error: e.response?.data?.error?.message || e.message };
    }
  };
  await hit('pages_read_engagement', `${pageId}/feed`, { limit: 1, fields: 'message,created_time,permalink_url' });
  await hit('pages_manage_metadata', `${pageId}/subscribed_apps`, {});
  if (igId) {
    await hit('instagram_basic', `${igId}`, { fields: 'username,id' });
    await hit('instagram_manage_messages', `${igId}/conversations`, { platform: 'instagram', limit: 1 });
  }
  return out;
}

async function sendImage(to, mediaUrl, caption = null, ctx = null, replyTo = null) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'image',
    image: { link: mediaUrl, ...(caption && { caption }) },
  };
  if (replyTo) payload.context = { message_id: replyTo }; // v0.9.377 reply-quote
  return _post(payload, ctx);
}

async function sendDocument(to, mediaUrl, filename = 'documento.pdf', caption = null, ctx = null) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: {
      link: mediaUrl,
      filename,
      ...(caption && { caption }),
    },
  };
  return _post(payload, ctx);
}

async function sendAudio(to, mediaUrl, ctx = null) {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { link: mediaUrl },
  };
  return _post(payload, ctx);
}

// ─────────────────────────────────────────────────────────────────
// v0.9.390 — NOTAS DE VOZ (ElevenLabs TTS → OGG/Opus → WhatsApp)
// Aitana responde con un audio de voz humana. Pipeline: texto → ElevenLabs TTS (MP3)
// → ffmpeg a OGG/Opus mono ~24 kbps (formato de nota de voz de WhatsApp) → subir a
// Meta /media → enviar type:audio (voice:true = burbuja push-to-talk con onda).
// Todo best-effort: si algo falla, devuelve success:false y el que llama manda TEXTO.
// ─────────────────────────────────────────────────────────────────

// ElevenLabs TTS → Buffer MP3. Modelo Flash v2.5 por default (rápido + barato). Voz por env/opts.
async function _elevenTTS(text, opts = {}) {
  const apiKey = opts.apiKey || process.env.ELEVENLABS_API_KEY;
  const voiceId = opts.voiceId || process.env.ELEVEN_VOICE_ID;
  if (!apiKey || !voiceId) throw new Error('Falta ELEVENLABS_API_KEY o ELEVEN_VOICE_ID');
  const model = opts.model || process.env.ELEVEN_TTS_MODEL || 'eleven_flash_v2_5';
  const clean = String(text == null ? '' : text).trim().slice(0, 1200); // tope defensivo de créditos
  if (!clean) throw new Error('texto vacío para TTS');
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  const resp = await axios.post(url, {
    text: clean,
    model_id: model,
    voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true },
  }, { headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' }, responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(resp.data);
}

// MP3 (o cualquier audio) → OGG/Opus mono 24 kbps (nota de voz WhatsApp). Usa ffmpeg-static (binario bundleado).
function _toWhatsAppOgg(inputBuffer) {
  return new Promise((resolve, reject) => {
    let ffmpegPath;
    try { ffmpegPath = require('ffmpeg-static'); } catch (e) { return reject(new Error('ffmpeg-static no instalado (npm i ffmpeg-static)')); }
    const { spawn } = require('child_process');
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-f', 'ogg', 'pipe:1'];
    const ff = spawn(ffmpegPath, args);
    const out = [], err = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error('ffmpeg exit ' + code + ': ' + Buffer.concat(err).toString().slice(0, 200))));
    ff.stdin.on('error', () => {}); // guard EPIPE
    ff.stdin.write(inputBuffer);
    ff.stdin.end();
  });
}

// Sube un buffer a Meta /media y devuelve el media_id (multipart con FormData/Blob globales de Node 20+).
async function _uploadWaMedia(buffer, mimeType, filename, ctx = null) {
  const { phoneNumberId, accessToken } = _resolveCreds(ctx);
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mimeType);
  fd.append('file', new Blob([buffer], { type: mimeType }), filename);
  const resp = await axios.post(`${baseUrl}/${phoneNumberId}/media`, fd, {
    headers: { Authorization: `Bearer ${accessToken}` }, // NO seteamos Content-Type: axios pone el boundary del multipart
    timeout: 20000, maxBodyLength: Infinity, maxContentLength: Infinity,
  });
  return resp.data && resp.data.id;
}

// v0.9.414 — Normaliza el texto SOLO para la síntesis de voz (TTS): fechas, horas y "hs" a forma HABLADA,
// para que la nota de voz no lea "20/07 10:00 hs" literal (leerlo así delataba al bot). El texto que se
// muestra en el chat y se guarda en el CRM NO cambia — esto solo afecta lo que pronuncia ElevenLabs.
const _TTS_MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
// v0.9.420 — minutos hablados (1-59) para la hora en forma humana
function _ttsMin(n) {
  const u = ['', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
  if (n < 30) return u[n] || '';
  const tens = { 30: 'treinta', 40: 'cuarenta', 50: 'cincuenta' };
  const t = Math.floor(n / 10) * 10, r = n % 10;
  return r === 0 ? (tens[t] || '') : ((tens[t] || '') + ' y ' + u[r]);
}
// v0.9.420 — HH:MM (24h) → forma hablada humana: "dos de la tarde", "una y media de la tarde",
// "ocho de la mañana", "siete de la noche". Antes decía "las 14" (24h robótico → delataba al bot).
function _ttsHour12(h, m) {
  h = ((h % 24) + 24) % 24;
  const H = ['doce', 'una', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once'];
  const h12 = H[h % 12];
  let dp;
  if (h === 0) dp = 'de la noche';
  else if (h <= 4) dp = 'de la madrugada';
  else if (h <= 11) dp = 'de la mañana';
  else if (h === 12) dp = 'del mediodía';
  else if (h <= 18) dp = 'de la tarde';
  else dp = 'de la noche';
  let minp = '';
  if (m === 15) minp = ' y cuarto';
  else if (m === 30) minp = ' y media';
  else if (m !== 0) minp = ' y ' + _ttsMin(m);
  return h12 + minp + ' ' + dp;
}
function _ttsNormalize(text) {
  let s = String(text || '');
  // fecha DD/MM(/YYYY) → "DD de <mes>"
  s = s.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g, (m, d, mo) => { const mi = parseInt(mo, 10) - 1; return (mi >= 0 && mi < 12) ? (parseInt(d, 10) + ' de ' + _TTS_MESES[mi]) : m; });
  // hora HH:MM (24h, y consume un "hs/hrs" pegado) → forma hablada 12h con parte del día
  s = s.replace(/\b(\d{1,2}):(\d{2})(?:\s*(?:hs|hrs)\b\.?)?/gi, (m, h, mm) => {
    const H = parseInt(h, 10), M = parseInt(mm, 10);
    if (H > 23 || M > 59) return m;
    return _ttsHour12(H, M);
  });
  // "hs"/"hrs" sueltos restantes → "horas"
  s = s.replace(/\b(hs|hrs)\.?/gi, 'horas');
  // "a las una"/"las una" → "a la una"/"la una" (concordancia); las demás horas quedan con "las"
  s = s.replace(/\ba\s+las\s+una\b/gi, 'a la una');
  s = s.replace(/\blas\s+una\b/gi, 'la una');
  // evitar "las las" duplicado si el texto ya traía "a las" antes de la hora
  s = s.replace(/\blas\s+las\b/gi, 'las');
  return s;
}

// Envía una nota de voz. Devuelve el mismo shape que _post ({success, wa_message_id, error}).
// skipped:true = no está configurada la voz (el que llama debe mandar texto).
async function sendVoiceNote(to, text, ctx = null, opts = {}) {
  if (!process.env.ELEVENLABS_API_KEY || !(opts.voiceId || process.env.ELEVEN_VOICE_ID)) {
    return { success: false, skipped: true, error: 'voz no configurada (ELEVENLABS_API_KEY / ELEVEN_VOICE_ID)' };
  }
  const _t0 = Date.now();
  try {
    const mp3 = await _elevenTTS(_ttsNormalize(text), opts); // v0.9.414 — TTS lee fechas/horas en forma hablada
    const ogg = await _toWhatsAppOgg(mp3);
    if (!ogg || ogg.length < 200) throw new Error('audio vacío');
    if (ogg.length > 500 * 1024) throw new Error('audio > 500KB (WhatsApp lo mostraría como archivo)');
    const mediaId = await _uploadWaMedia(ogg, 'audio/ogg', 'aitana.ogg', ctx);
    if (!mediaId) throw new Error('Meta no devolvió media_id');
    // v0.9.403 — RETARDO NATURAL DE "GRABACIÓN": el audio NO debe salir instantáneo (pedido de José).
    // OJO: la WhatsApp Cloud API NO expone un indicador "grabando audio" (typing_indicator solo tiene
    // type:"text" = los "..."). Para NO mostrar unos "..." que engañan ("está escribiendo"), acá NO
    // mandamos typing y en su lugar SIMULAMOS el tiempo de grabar: esperamos un lapso proporcional al
    // largo del texto, DESCONTANDO lo que ya tardó la síntesis (así el total se siente natural, no se
    // suma). Cap a 8s para no acercarse al timeout de n8n (10s). Se puede saltar con opts.recordingDelay=false.
    if (opts.recordingDelay !== false) {
      const _target = Math.min(8000, Math.max(2200, String(text || '').length * 45));
      const _wait = _target - (Date.now() - _t0);
      if (_wait > 0) await new Promise((r) => setTimeout(r, _wait));
    }
    // voice:true = burbuja de nota de voz (push-to-talk). Si Meta rechaza el flag, reintentamos sin él (igual suena como nota de voz por ser OGG/Opus).
    let r = await _post({ messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId, voice: true } }, ctx);
    if (!r.success && /voice|param/i.test(r.error || '')) {
      r = await _post({ messaging_product: 'whatsapp', to, type: 'audio', audio: { id: mediaId } }, ctx);
    }
    return r;
  } catch (e) {
    console.error('[voice-note]', e.message);
    return { success: false, error: e.message };
  }
}

async function sendLinkBundle(to, caption, url, credentialsBlock, ctx = null) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const results = [];
  let firstError = null;

  const send = async (text, previewUrl = false) => {
    if (!text || !text.trim()) return null;
    const r = await sendText(to, text.trim(), previewUrl, ctx);
    results.push(r);
    if (!r.success && !firstError) firstError = r.error;
    return r;
  };

  const r1 = await send(caption, false);
  if (r1) await sleep(400);

  const r2 = await send(url, true);
  if (r2) await sleep(400);

  const r3 = await send(credentialsBlock, false);

  return {
    success: !firstError,
    error: firstError,
    parts: { caption: r1, url: r2, credentials: r3 },
    wa_message_id: r3?.wa_message_id || r2?.wa_message_id || r1?.wa_message_id || null,
  };
}

async function markAsRead(waMessageId, ctx = null) {
  const { phoneNumberId, accessToken } = _resolveCreds(ctx);
  try {
    await axios.post(
      `${baseUrl}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
      },
      { headers: _authHeaders(accessToken), timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.warn('markAsRead falló:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

// v0.9.279 — Indicador "escribiendo…" (WhatsApp Cloud API). En la MISMA llamada marca el mensaje como
// leído (visto azul) y muestra el typing bubble al cliente. Dura hasta 25s o hasta que enviamos un
// mensaje (lo que pase primero). Se dispara cuando el bot va a responder → el cliente ve "escribiendo…"
// mientras Aitana piensa, como una persona real. Requiere el wa_message_id del ÚLTIMO mensaje entrante.
async function sendTypingIndicator(waMessageId, ctx = null) {
  if (!waMessageId) return false;
  const { phoneNumberId, accessToken } = _resolveCreds(ctx);
  try {
    await axios.post(
      `${baseUrl}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: waMessageId,
        typing_indicator: { type: 'text' },
      },
      { headers: _authHeaders(accessToken), timeout: 10000 }
    );
    return true;
  } catch (e) {
    console.warn('sendTypingIndicator falló:', e.response?.data?.error?.message || e.message);
    return false;
  }
}

async function downloadMedia(mediaId, ctx = null) {
  const { accessToken } = _resolveCreds(ctx);
  try {
    const metaResp = await axios.get(`${baseUrl}/${mediaId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });
    const fileUrl = metaResp.data.url;
    const mimeType = metaResp.data.mime_type;

    const fileResp = await axios.get(fileUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    return {
      buffer: Buffer.from(fileResp.data),
      mimeType,
      sizeBytes: fileResp.data.byteLength,
    };
  } catch (e) {
    console.error('downloadMedia falló:', e.response?.data || e.message);
    return null;
  }
}

async function _post(payload, ctx = null) {
  const { phoneNumberId, accessToken } = _resolveCreds(ctx);
  try {
    const resp = await axios.post(
      `${baseUrl}/${phoneNumberId}/messages`,
      payload,
      { headers: _authHeaders(accessToken), timeout: 15000 }
    );
    const wamid = resp.data?.messages?.[0]?.id || null;
    return { success: true, wa_message_id: wamid, error: null, raw: resp.data };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta API error:', errMsg, JSON.stringify(e.response?.data || {}).substring(0, 500));
    return {
      success: false,
      wa_message_id: null,
      error: errMsg,
      raw: e.response?.data || {},
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// v0.9.9 — Plantillas de WhatsApp (Meta-approved templates)
// ─────────────────────────────────────────────────────────────────

/**
 * Envía una plantilla aprobada. Única forma de escribir fuera de la
 * ventana de 24h. `components` = body/header params (puede ir vacío).
 */
async function sendTemplate(to, templateName, languageCode = 'es', components = [], ctx = null) {
  const tpl = { name: templateName, language: { code: languageCode } };
  if (Array.isArray(components) && components.length) tpl.components = components;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: tpl,
  };
  return _post(payload, ctx);
}

/**
 * Lista las plantillas de una WABA (necesita WABA id + token, NO phone_number_id).
 */
async function getMessageTemplates(wabaId, accessToken) {
  try {
    const resp = await axios.get(`${baseUrl}/${wabaId}/message_templates`, {
      headers: _authHeaders(accessToken),
      params: { fields: 'name,status,language,category,components', limit: 200 },
      timeout: 15000,
    });
    return { success: true, templates: resp.data?.data || [], error: null };
  } catch (e) {
    const errMsg = e.response?.data?.error?.message || e.message;
    console.error('Meta templates error:', errMsg);
    return { success: false, templates: [], error: errMsg };
  }
}

/**
 * Crea una plantilla y la envía a aprobación de Meta (equivalente al curl post_tpl).
 * templateDef = { name, language, category, components: [{ type:'BODY', text, example? }] }
 * Devuelve { success, id, status, category, error } — status suele ser 'PENDING'.
 */
async function createMessageTemplate(wabaId, accessToken, templateDef) {
  try {
    const resp = await axios.post(`${baseUrl}/${wabaId}/message_templates`, templateDef, {
      headers: _authHeaders(accessToken),
      timeout: 15000,
    });
    return {
      success: true,
      id: resp.data?.id || null,
      status: resp.data?.status || 'PENDING',
      category: resp.data?.category || templateDef.category || null,
      error: null,
    };
  } catch (e) {
    // Meta a veces da un mensaje más claro en error_user_msg
    const err = e.response?.data?.error || {};
    const errMsg = err.error_user_msg || err.message || e.message;
    console.error('Meta create template error:', errMsg);
    return { success: false, id: null, status: null, category: null, error: errMsg };
  }
}

// ─────────────────────────────────────────────────────────────────
// v0.9.6 — Embedded Signup helpers
// ─────────────────────────────────────────────────────────────────

async function exchangeCodeForToken(code) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID y META_APP_SECRET deben estar configurados');
  }
  const resp = await axios.get(`${baseUrl}/oauth/access_token`, {
    params: { client_id: appId, client_secret: appSecret, code },
    timeout: 15000,
  });
  return resp.data;
}

/**
 * Intercambia el code del login (panel, flujo redirect) por un token.
 * El redirect_uri DEBE ser idéntico al usado en el diálogo OAuth, por eso
 * lo recibe como parámetro (lo manda el frontend).
 */
async function exchangeLoginCodeForToken(code, redirectUri) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID y META_APP_SECRET deben estar configurados');
  }
  const resp = await axios.get(`${baseUrl}/oauth/access_token`, {
    params: {
      client_id: appId,
      client_secret: appSecret,
      code,
      redirect_uri: redirectUri || '',
    },
    timeout: 15000,
  });
  return resp.data;
}

async function getSharedWABAs(accessToken) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const resp = await axios.get(`${baseUrl}/debug_token`, {
    params: { input_token: accessToken, access_token: `${appId}|${appSecret}` },
    timeout: 15000,
  });
  return resp.data?.data || {};
}

/**
 * v0.9.457 — TODAS las WABAs del PORTAFOLIO al que llega el token.
 * debug_token solo devuelve las WABAs que quedaron en los granular_scopes de ESE
 * login; un token de portafolio (system user, o el Embedded Signup hecho a nivel
 * negocio) puede tener acceso a WABAs que no figuran ahí — que es justo el caso
 * de "agregar otra línea con el mismo token". Recorre /me/businesses y, por cada
 * negocio, las WABAs propias y las cedidas por clientes. Best-effort: nunca lanza.
 */
async function getPortfolioWABAs(accessToken) {
  const ids = new Set();
  if (!accessToken) return [];
  let businesses = [];
  try {
    const r = await axios.get(`${baseUrl}/me/businesses`, {
      params: { fields: 'id,name', limit: 50, access_token: accessToken },
      timeout: 15000,
    });
    businesses = r.data?.data || [];
  } catch (e) { /* el token puede no tener business_management → sin portafolio */ }
  for (const b of businesses) {
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      try {
        const r = await axios.get(`${baseUrl}/${b.id}/${edge}`, {
          params: { fields: 'id,name', limit: 100, access_token: accessToken },
          timeout: 15000,
        });
        for (const w of (r.data?.data || [])) if (w && w.id) ids.add(String(w.id));
      } catch (e) { /* sin permiso sobre ese edge → seguimos con el resto */ }
    }
  }
  return Array.from(ids);
}

/**
 * v0.9.62 — ¿Puede este usuario (token de LOGIN) leer esta WABA?
 * Graph solo devuelve el nodo si el usuario tiene un rol sobre el asset, así
 * que un GET exitoso = "esta WABA es de este usuario". Se usa como fallback
 * de matching en el login cuando los granular_scopes no traen target_ids.
 * Devuelve true/false, nunca lanza.
 */
async function canAccessWABA(wabaId, userAccessToken) {
  if (!wabaId || !userAccessToken) return false;
  try {
    const resp = await axios.get(`${baseUrl}/${wabaId}`, {
      params: { fields: 'id', access_token: userAccessToken },
      timeout: 10000,
    });
    return String(resp.data?.id || '') === String(wabaId);
  } catch (e) {
    return false;
  }
}

async function getPhoneNumbers(wabaId, accessToken) {
  const resp = await axios.get(`${baseUrl}/${wabaId}/phone_numbers`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return resp.data?.data || [];
}

async function subscribeWABA(wabaId, accessToken) {
  const resp = await axios.post(
    `${baseUrl}/${wabaId}/subscribed_apps`,
    {},
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
  );
  return resp.data;
}

/**
 * v0.9.280 — Des-suscribe la app del WABA (DELETE /{waba}/subscribed_apps).
 * Meta deja de enviar webhooks de esa WhatsApp Business Account. Espejo de subscribeWABA.
 */
async function unsubscribeWABA(wabaId, accessToken) {
  const resp = await axios.delete(
    `${baseUrl}/${wabaId}/subscribed_apps`,
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
  );
  return resp.data;
}

/**
 * v0.9.17 — Perfil de WhatsApp Business del número (foto, about, etc).
 * La profile_picture_url que devuelve Meta es una URL firmada TEMPORAL:
 * el caller debe cachearla y refrescarla (api.js usa TTL 12h).
 */
async function getBusinessProfile(phoneNumberId, accessToken) {
  const resp = await axios.get(`${baseUrl}/${phoneNumberId}/whatsapp_business_profile`, {
    params: { fields: 'about,profile_picture_url,vertical,websites' },
    headers: { Authorization: `Bearer ${accessToken || META_ACCESS_TOKEN}` },
    timeout: 15000,
  });
  return resp.data?.data?.[0] || null;
}

async function registerPhoneNumber(phoneNumberId, accessToken, pin = '000000') {
  const resp = await axios.post(
    `${baseUrl}/${phoneNumberId}/register`,
    { messaging_product: 'whatsapp', pin },
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000 }
  );
  return resp.data;
}

// v0.9.225 — COEXISTENCE: PEDIR explícitamente la sincronización de historial (+ contactos).
// Meta NO manda el webhook 'history' por su cuenta tras el onboarding: hay que
// SOLICITARLO con POST /{phone_number_id}/smb_app_data { sync_type: 'history' }.
// Sin este pedido, el backfill de chats (hasta ~6 meses) nunca llega aunque el
// field 'history' esté suscrito. Contactos = sync_type 'smb_app_state_sync'.
// El de contactos es best-effort (no bloquea); si el de history falla, se lanza
// para que el caller lo loguee. (Descubierto comparando con backend de referencia.)
async function requestCoexistenceSync(phoneNumberId, accessToken) {
  const url = `${baseUrl}/${phoneNumberId}/smb_app_data`;
  const headers = { Authorization: `Bearer ${accessToken}` };
  const out = {};
  try {
    const r1 = await axios.post(url, { messaging_product: 'whatsapp', sync_type: 'smb_app_state_sync' }, { headers, timeout: 15000 });
    out.contacts = r1.data || { ok: true };
  } catch (e) {
    out.contacts = { error: e.response?.data?.error?.message || e.message };
  }
  const r2 = await axios.post(url, { messaging_product: 'whatsapp', sync_type: 'history' }, { headers, timeout: 15000 });
  out.history = r2.data || { ok: true };
  return out;
}

// =====================================================================
// v0.9.8 — Login con Facebook (auth de clientes al panel)
// =====================================================================

/**
 * Valida un FB access token contra la app y devuelve su metadata.
 * Devuelve { is_valid, user_id, app_id, scopes, granular_scopes, expires_at }.
 * Usamos esto para: (1) confirmar que el token es de NUESTRA app,
 * (2) obtener el FB user_id que identifica al usuario.
 */
async function debugFacebookToken(userAccessToken) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID y META_APP_SECRET deben estar configurados');
  }
  const resp = await axios.get(`${baseUrl}/debug_token`, {
    params: { input_token: userAccessToken, access_token: `${appId}|${appSecret}` },
    timeout: 15000,
  });
  return resp.data?.data || {};
}

/**
 * Lista los WABAs (WhatsApp Business Accounts) que el usuario administra,
 * extraídos de los granular_scopes del token. Devuelve array de waba_ids.
 * Se usa en el PRIMER login para matchear el usuario con su tenant
 * (vía el waba_id que se guardó en el onboarding).
 */
function extractWABAIdsFromDebug(debugData) {
  const ids = new Set();
  const scopes = debugData?.granular_scopes || [];
  for (const s of scopes) {
    // whatsapp_business_management / messaging traen target_ids = WABAs
    if (s.scope && s.scope.includes('whatsapp_business') && Array.isArray(s.target_ids)) {
      for (const id of s.target_ids) ids.add(String(id));
    }
  }
  return Array.from(ids);
}

// =====================================================================
// v0.9.132 — OMNICANAL Fase 2: conectar Páginas de Facebook / Instagram
// (Messenger + IG DM). Espeja el patrón de WhatsApp (exchange + subscribe),
// pero para Páginas: token largo de usuario → page access token (permanente)
// → suscripción de la página al webhook (messages + messaging_postbacks).
// =====================================================================

/**
 * Cambia un user access token de corta duración por uno de larga duración.
 * Los page tokens derivados de un user token de larga duración son permanentes.
 * Devuelve el long-lived user token (string) o null.
 */
async function exchangeForLongLivedUserToken(userToken) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID y META_APP_SECRET deben estar configurados');
  }
  const resp = await axios.get(`${baseUrl}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: userToken,
    },
    timeout: 15000,
  });
  return resp.data?.access_token || null;
}

/**
 * Lista las Páginas que administra el usuario (para el selector del panel).
 * No pedimos el page access_token acá: el selector solo muestra nombres.
 * El token de la página se obtiene server-side en getPageDetails().
 */
async function getUserPages(userAccessToken) {
  const resp = await axios.get(`${baseUrl}/me/accounts`, {
    params: {
      // v0.9.141: incluye access_token (el token de cada página). /me/accounts lo
      // devuelve con pages_show_list — NO requiere pages_read_engagement (que sí
      // exige GET /{page-id}). El caller debe NO mandar este token al frontend.
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      limit: 100,
      access_token: userAccessToken,
    },
    timeout: 15000,
  });
  return resp.data?.data || [];
}

/**
 * Trae el detalle de UNA página con su page access token (permanente si el
 * userAccessToken es de larga duración) + la cuenta de Instagram vinculada.
 * El GET solo devuelve el nodo si el usuario administra la página → sirve como
 * verificación anti-spoof (igual que canAccessWABA con las WABAs).
 */
async function getPageDetails(pageId, userAccessToken) {
  const resp = await axios.get(`${baseUrl}/${pageId}`, {
    params: {
      fields: 'id,name,access_token,instagram_business_account{id,username}',
      access_token: userAccessToken,
    },
    timeout: 15000,
  });
  return resp.data || {};
}

/**
 * Suscribe la Página a la app (webhook) para recibir mensajes de Messenger e
 * Instagram. subscribed_fields cubre DMs y postbacks. Usa el page access token.
 */
async function subscribePageToApp(pageId, pageAccessToken) {
  const resp = await axios.post(
    `${baseUrl}/${pageId}/subscribed_apps`,
    null,
    {
      params: {
        // v0.9.142: + feed (comentarios de la página → comment monitoring)
        subscribed_fields: 'messages,messaging_postbacks,messaging_optins,message_reactions,feed',
        access_token: pageAccessToken,
      },
      timeout: 15000,
    }
  );
  return resp.data;
}

/**
 * Desuscribe la Página de la app (al desconectar el canal). Warn-only en el caller.
 */
async function unsubscribePageFromApp(pageId, pageAccessToken) {
  const resp = await axios.delete(`${baseUrl}/${pageId}/subscribed_apps`, {
    params: { access_token: pageAccessToken },
    timeout: 15000,
  });
  return resp.data;
}

// v0.9.328 — CATÁLOGO DE WHATSAPP COMMERCE. Lee el catálogo del negocio (Graph) para importarlo
// al inventario que usa Aitana. Requiere el permiso catalog_management en el token.
async function getWabaCatalogs(wabaId, accessToken) {
  try {
    const resp = await axios.get(`${baseUrl}/${wabaId}/product_catalogs`, {
      params: { fields: 'id,name,product_count', limit: 50, access_token: accessToken }, timeout: 15000,
    });
    return { success: true, catalogs: resp.data?.data || [], error: null };
  } catch (e) {
    return { success: false, catalogs: [], error: e.response?.data?.error?.message || e.message };
  }
}

async function getCatalogProducts(catalogId, accessToken) {
  const out = [];
  let url = `${baseUrl}/${catalogId}/products`;
  let params = { fields: 'id,retailer_id,name,description,price,currency,image_url,availability,brand,category,product_type,url', limit: 100, access_token: accessToken };
  try {
    for (let page = 0; page < 50; page++) { // tope 5000 productos
      const resp = await axios.get(url, { params, timeout: 20000 });
      const data = resp.data?.data || [];
      for (const it of data) out.push(it);
      const next = resp.data?.paging?.next;
      if (!next || !data.length) break;
      url = next; params = undefined; // el 'next' ya incluye el token en la URL
    }
    return { success: true, products: out, error: null };
  } catch (e) {
    return { success: false, products: out, error: e.response?.data?.error?.message || e.message };
  }
}

module.exports = {
  sendText,
  sendInteractiveButtons,
  sendInteractiveList, // v0.9.344 list message
  sendTemplate,
  getMessageTemplates,
  getWabaCatalogs,
  getCatalogProducts,
  createMessageTemplate,
  sendVideo,
  sendImage,
  sendDocument,
  sendAudio,
  sendVoiceNote, // v0.9.390 nota de voz (ElevenLabs)
  sendLinkBundle,
  sendMessengerText,
  sendMessengerImage,
  getChannelUserProfile,
  getPhoneNumberInfo,
  markAsRead,
  sendTypingIndicator,
  downloadMedia,
  exchangeCodeForToken,
  exchangeLoginCodeForToken,
  getSharedWABAs,
  getPortfolioWABAs, // v0.9.457 WABAs del portafolio (más allá de los granular_scopes)
  probeOnboardingFields, // v0.9.515 sonda: qué campos contesta Meta de verdad
  PROBE_PHONE_FIELDS, PROBE_WABA_FIELDS,
  canAccessWABA,
  getPhoneNumbers,
  getBusinessProfile,
  subscribeWABA,
  unsubscribeWABA,
  registerPhoneNumber,
  requestCoexistenceSync, // v0.9.225 coexistence: pedir history backfill + contactos
  debugFacebookToken,
  extractWABAIdsFromDebug,
  exchangeForLongLivedUserToken, // v0.9.132 omnicanal Fase 2
  getUserPages,
  getPageDetails,
  subscribePageToApp,
  unsubscribePageFromApp,
  sendPrivateReplyToComment, // v0.9.142 comentarios
  replyToCommentPublic,
  getCommentThread, // v0.9.580 — hilo completo del comentario
  hideComment, // v0.9.283
  getPageSubscribedFields, // v0.9.143
  runReviewTestCalls, // v0.9.144 App Review: required API test calls
};
