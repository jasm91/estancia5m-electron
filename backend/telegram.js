/**
 * telegram.js — v0.9.282
 * Cliente mínimo de la Telegram Bot API (sin SDK). Espeja el rol de meta.js para el
 * canal 'telegram': recibir/responder + descarga de media (getFile + download).
 *
 * Cada tenant crea su bot en @BotFather → pega el token en el panel (Config → Canales).
 * Recepción por webhook (setWebhook a /api/telegram/webhook/:secret; el secret viaja en
 * el header X-Telegram-Bot-Api-Secret-Token). Sin App Review, sin tokens que vencen,
 * sin ventana de 24h ni plantillas (podés escribir a cualquiera que inició el chat).
 */
const axios = require('axios');

const API = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
const FILEURL = (token, filePath) => `https://api.telegram.org/file/bot${token}/${filePath}`;

// Valida el token y trae { id, username, first_name }.
async function getMe(token) {
  const r = await axios.get(API(token, 'getMe'), { timeout: 15000 });
  return r.data.result;
}

// Registra el webhook. El secret viaja como header en cada update (anti-spoof).
async function setWebhook(token, url, secret) {
  const r = await axios.post(API(token, 'setWebhook'), {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'business_connection', 'business_message'], // v0.9.282 — Telegram Business
  }, { timeout: 15000 });
  return r.data;
}

async function deleteWebhook(token) {
  const r = await axios.post(API(token, 'deleteWebhook'), {}, { timeout: 15000 });
  return r.data;
}

// Envía texto. Devuelve { success, error } (mismo shape que meta.sendMessengerText).
async function sendMessage(token, chatId, text, businessConnectionId) {
  try {
    const payload = { chat_id: chatId, text: String(text) };
    if (businessConnectionId) payload.business_connection_id = businessConnectionId; // v0.9.282 — responder como la cuenta personal
    const r = await axios.post(API(token, 'sendMessage'), payload, { timeout: 15000 });
    return { success: true, result: r.data.result };
  } catch (e) {
    return { success: false, error: e.response?.data?.description || e.message };
  }
}

// Envía una imagen por URL.
async function sendPhoto(token, chatId, photoUrl, caption, businessConnectionId) {
  try {
    const payload = { chat_id: chatId, photo: photoUrl, caption: caption || undefined };
    if (businessConnectionId) payload.business_connection_id = businessConnectionId; // v0.9.282
    const r = await axios.post(API(token, 'sendPhoto'), payload, { timeout: 20000 });
    return { success: true, result: r.data.result };
  } catch (e) {
    return { success: false, error: e.response?.data?.description || e.message };
  }
}

// Descarga un file_id: getFile → baja el binario. Devuelve { buffer, mimeType, filePath }.
async function downloadFile(token, fileId) {
  const gf = await axios.get(API(token, 'getFile'), { params: { file_id: fileId }, timeout: 15000 });
  const filePath = gf.data.result && gf.data.result.file_path;
  if (!filePath) return null;
  const bin = await axios.get(FILEURL(token, filePath), { responseType: 'arraybuffer', timeout: 30000 });
  return { buffer: Buffer.from(bin.data), mimeType: bin.headers['content-type'] || null, filePath };
}

module.exports = { getMe, setWebhook, deleteWebhook, sendMessage, sendPhoto, downloadFile };
