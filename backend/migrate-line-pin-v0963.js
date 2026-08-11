/**
 * Migración v0.9.63 — PIN de registro Cloud API por línea
 *
 * tenant_lines.pin_enc: PIN de 6 dígitos (cifrado AES-256-GCM) usado en
 * POST /<phone_number_id>/register. Meta lo setea como PIN de verificación
 * en dos pasos del número; lo guardamos para poder re-registrar.
 *
 * Idempotente. Uso:
 *   DATABASE_URL="..." node migrate-line-pin-v0963.js
 */
const db = require('./db');

(async () => {
  try {
    console.log('🔧 v0.9.63 — pin_enc en tenant_lines...');
    await db.query(`ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS pin_enc TEXT;`);
    console.log('✅ tenant_lines.pin_enc');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-line-pin-v0963:', err.message);
    process.exit(1);
  }
})();
