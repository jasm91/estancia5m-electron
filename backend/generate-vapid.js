/**
 * v0.9.20 — Genera un par de claves VAPID (Web Push) sin dependencias.
 * Formato exacto que espera la librería web-push:
 *   pública  = base64url del punto EC P-256 sin comprimir (65 bytes)
 *   privada  = base64url del escalar d (32 bytes)
 *
 * Imprime JSON {"publicKey":"...","privateKey":"..."} a stdout.
 * ⚠️ NO regenerar si ya existen en Railway: las suscripciones viejas morirían.
 */
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

// SPKI DER: los últimos 65 bytes son el punto sin comprimir (0x04 || X || Y)
const spki = publicKey.export({ type: 'spki', format: 'der' });
const pubRaw = spki.subarray(spki.length - 65);
if (pubRaw[0] !== 0x04) {
  console.error('Formato inesperado de clave pública');
  process.exit(1);
}
const jwk = privateKey.export({ format: 'jwk' }); // d ya viene en base64url

console.log(JSON.stringify({
  publicKey: Buffer.from(pubRaw).toString('base64url'),
  privateKey: jwk.d,
}));
