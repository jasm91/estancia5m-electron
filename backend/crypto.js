/**
 * crypto.js — v0.8.0 Sprint 1
 *
 * Cifrado simétrico de campos sensibles (meta_token, app_secret, gemini_api_key)
 * antes de almacenarlos en DB. Usa AES-256-GCM (authenticated encryption).
 *
 * REQUIERE env var ENCRYPTION_KEY = 32 bytes (64 chars hex).
 * Generala con: openssl rand -hex 32
 *
 * Formato del ciphertext en DB (base64):
 *   [iv(12)] [auth_tag(16)] [encrypted_payload(variable)]
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;       // AES-GCM standard
const TAG_LEN = 16;

let _keyCache = null;

function getKey() {
  if (_keyCache) return _keyCache;
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY debe definirse como 32 bytes (64 chars hex). ' +
      'Generala con: openssl rand -hex 32'
    );
  }
  _keyCache = Buffer.from(keyHex, 'hex');
  return _keyCache;
}

/**
 * Cifra un string plano. Devuelve base64 con iv + tag + ciphertext concatenados.
 * Si plaintext es null/undefined/empty, devuelve null sin lanzar error.
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/**
 * Descifra el formato de encrypt(). Devuelve null si el input es null/empty.
 * Lanza error si el ciphertext está corrupto o la key es incorrecta.
 */
function decrypt(ciphertextB64) {
  if (!ciphertextB64) return null;
  const key = getKey();
  const buf = Buffer.from(ciphertextB64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext inválido: muy corto');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const encrypted = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Helper para descifrar de forma segura: si falla, devuelve null + loguea.
 * Útil para campos opcionales donde un fallo no debe tirar abajo el servidor.
 */
function decryptSafe(ciphertextB64) {
  if (!ciphertextB64) return null;
  try {
    return decrypt(ciphertextB64);
  } catch (e) {
    console.error('crypto.decryptSafe falló:', e.message);
    return null;
  }
}

/**
 * Re-cifrar: descifra con la key vieja y vuelve a cifrar con la actual.
 * Útil para rotación de keys. Si la key no cambió, igual genera un nuevo IV
 * (lo cual es bueno para "freshness" del ciphertext).
 */
function reEncrypt(ciphertextB64) {
  if (!ciphertextB64) return null;
  return encrypt(decrypt(ciphertextB64));
}

module.exports = { encrypt, decrypt, decryptSafe, reEncrypt };
