/**
 * baneco.js — Cliente de la API "BEC QR CONNECT" del Banco Económico (v0.9.231)
 * ----------------------------------------------------------------------------
 * Cobros por QR dinámico + acreditación automática vía webhook notifyPaymentQR.
 * Spec: "Api Market Baneco v1.3.0".
 *
 * Config por entorno (NO hardcodear llaves de producción):
 *   BANECO_BASE_URL   ej. https://apimkt.baneco.com.bo/ApiGateway/   (prod)
 *                     ej. https://apimktdesa.baneco.com.bo/ApiGateway/ (certificación)
 *   BANECO_USER       usuario asignado por el banco
 *   BANECO_PASSWORD   contraseña (se envía cifrada)
 *   BANECO_AES_KEY    llave AES de 32 caracteres (256 bits)
 *   BANECO_ACCOUNT    cuenta para abonos (se envía cifrada como accountCredit)
 *   BANECO_ENABLED    "true" para habilitar (si falta config, queda deshabilitado)
 *
 * Cifrado: AES-256-CBC, IV aleatorio de 16 bytes antepuesto, salida base64.
 * La llave de 32 chars se usa tal cual como bytes UTF-8 (= 32 bytes = AES-256).
 */
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Lee las variables de entorno en CADA llamada (no al cargar el módulo), para no
// depender del orden con dotenv y reflejar cambios de env sin tocar el código.
function cfg() {
  return {
    base: process.env.BANECO_BASE_URL || '',
    user: process.env.BANECO_USER || '',
    password: process.env.BANECO_PASSWORD || '',
    aesKey: process.env.BANECO_AES_KEY || '',
    account: process.env.BANECO_ACCOUNT || '',
  };
}
function isConfigured() {
  const c = cfg();
  return !!(c.base && c.user && c.password && c.aesKey && c.aesKey.length === 32);
}

// ---------- AES-256-CBC ----------
function _key() {
  const k = Buffer.from(cfg().aesKey, 'utf8');
  if (k.length !== 32) throw new Error('BANECO_AES_KEY debe tener 32 caracteres (256 bits)');
  return k;
}
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', _key(), iv);
  const e = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return Buffer.concat([iv, e]).toString('base64');
}
function decrypt(b64) {
  const raw = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', _key(), raw.subarray(0, 16));
  return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8');
}

// ---------- HTTP helper (sin dependencias) ----------
function _request(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(cfg().base.replace(/\/+$/, '/') + path.replace(/^\//, '')); }
    catch (e) { return reject(new Error('BANECO_BASE_URL inválida')); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opt = {
      method, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, timeout: 20000,
      headers: Object.assign({ Accept: 'application/json' }, headers || {}),
    };
    if (data) { opt.headers['Content-Type'] = 'application/json'; opt.headers['Content-Length'] = data.length; }
    const r = lib.request(opt, res => {
      let b = ''; res.on('data', d => b += d);
      res.on('end', () => { let p = null; try { p = b ? JSON.parse(b) : {}; } catch (e) { p = { _raw: b }; } resolve({ status: res.statusCode, data: p }); });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('BANECO timeout')));
    if (data) r.write(data);
    r.end();
  });
}

// ---------- Token (cacheado) ----------
let _token = null, _tokenExp = 0;
async function getToken(force) {
  const now = Date.now();
  if (!force && _token && now < _tokenExp - 60000) return _token; // margen 60s
  if (!isConfigured()) throw new Error('BANECO no está configurado (faltan variables de entorno)');
  const c = cfg();
  const r = await _request('POST', 'api/authentication/authenticate', { userName: c.user, password: encrypt(c.password) });
  if (r.data && r.data.responseCode === 0 && r.data.token) {
    _token = r.data.token;
    // exp del JWT si se puede leer; si no, asumimos 25 min
    try {
      const payload = JSON.parse(Buffer.from(_token.split('.')[1], 'base64').toString('utf8'));
      _tokenExp = payload.exp ? payload.exp * 1000 : now + 25 * 60000;
    } catch (e) { _tokenExp = now + 25 * 60000; }
    return _token;
  }
  throw new Error('BANECO auth falló: ' + (r.data && r.data.message ? r.data.message : 'HTTP ' + r.status));
}
async function _authed(method, path, body) {
  let token = await getToken();
  let r = await _request(method, path, body, { Authorization: 'Bearer ' + token });
  if (r.status === 401) { token = await getToken(true); r = await _request(method, path, body, { Authorization: 'Bearer ' + token }); }
  return r;
}

// ---------- QR Simple ----------
/**
 * Genera un QR de cobro. Devuelve { qrId, qrImage(base64 PNG) }.
 * opts: { transactionId, amount, currency='BOB', description, dueDate(YYYY-MM-DD),
 *         singleUse=true, modifyAmount=false, accountCredit?(texto plano, se cifra acá), branchCode? }
 */
async function generateQR(opts) {
  if (!opts || !opts.transactionId || !(opts.amount > 0)) throw new Error('generateQR: transactionId y amount son requeridos');
  const accountPlain = opts.accountCredit || cfg().account;
  if (!accountPlain) throw new Error('generateQR: falta accountCredit / BANECO_ACCOUNT');
  const body = {
    transactionId: String(opts.transactionId).slice(0, 30),
    accountCredit: encrypt(accountPlain),
    currency: opts.currency || 'BOB',
    amount: Number(opts.amount),
    description: (opts.description || '').slice(0, 100),
    dueDate: opts.dueDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    singleUse: opts.singleUse !== false,
    modifyAmount: opts.modifyAmount === true,
  };
  if (opts.branchCode) body.branchCode = String(opts.branchCode).slice(0, 5);
  const r = await _authed('POST', 'api/qrsimple/generateQR', body);
  if (r.data && r.data.responseCode === 0) return { qrId: r.data.qrId, qrImage: r.data.qrImage };
  throw new Error('BANECO generateQR: ' + (r.data && r.data.message ? r.data.message : 'HTTP ' + r.status));
}

// statusQRCode: 0 pendiente, 1 pagado, 9 anulado
async function getStatus(qrId) {
  const r = await _authed('GET', 'api/qrsimple/v2/statusQR/' + encodeURIComponent(qrId));
  if (r.data && (r.data.responseCode === 0 || r.data.statusQrCode !== undefined)) {
    return { statusQrCode: r.data.statusQrCode, payment: r.data.payment || [] };
  }
  throw new Error('BANECO statusQR: ' + (r.data && r.data.message ? r.data.message : 'HTTP ' + r.status));
}
async function cancelQR(qrId) {
  const r = await _authed('DELETE', 'api/qrsimple/cancelQR', { qrId });
  if (r.data && r.data.responseCode === 0) return true;
  throw new Error('BANECO cancelQR: ' + (r.data && r.data.message ? r.data.message : 'HTTP ' + r.status));
}
async function listPaid(yyyymmdd) {
  const r = await _authed('GET', 'api/qrsimple/v2/paidQR/' + encodeURIComponent(yyyymmdd));
  if (r.data && r.data.responseCode === 0) return r.data.paymentList || [];
  throw new Error('BANECO paidQR: ' + (r.data && r.data.message ? r.data.message : 'HTTP ' + r.status));
}

module.exports = { isConfigured, encrypt, decrypt, getToken, generateQR, getStatus, cancelQR, listPaid, cfg };
