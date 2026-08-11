/**
 * migrate-seed-default-tenant.js — v0.8.0 Sprint 1 (ADAPTADO para sg-ventas)
 *
 * Inserta el tenant id=1 "SG Bolivia" usando las credenciales actuales
 * que están en variables de entorno. Esto convierte tu instalación actual
 * en el primer tenant del sistema sin romper nada.
 *
 * ADAPTACIÓN para tu setup real:
 *   - Lee META_ACCESS_TOKEN (no META_TOKEN)
 *   - Lee META_WABA_ID (no WABA_ID)
 *   - Lee ADMIN_TOKEN como el token_hash del tenant (compatibilidad)
 *   - ENCRYPTION_KEY es opcional (si falta, no cifra los secrets — los guarda NULL)
 *
 * IDEMPOTENTE: ON CONFLICT (id=1) DO NOTHING. Si el tenant ya existe,
 * NO se sobreescribe (preservamos cambios manuales hechos en el panel admin).
 */

const db = require('./db');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function encrypt(plaintext) {
  if (!plaintext) return null;
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    console.warn('   ⚠️  ENCRYPTION_KEY no configurada o inválida. Se guardará NULL en columnas _enc.');
    console.warn('      Generar con: openssl rand -hex 32 y agregar a Railway env vars.');
    return null;
  }
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function generateSecureToken(length = 32) {
  return crypto.randomBytes(length).toString('hex').slice(0, length);
}

function tokenToShow(t) {
  if (!t || t.length < 12) return '***';
  return t.slice(0, 4) + '***' + t.slice(-4);
}

(async () => {
  try {
    console.log('▶ Verificando si tenant id=1 ya existe...');
    const existing = await db.query('SELECT id, name, slug FROM tenants WHERE id = 1');
    if (existing.rows.length > 0) {
      console.log(`⏭  Tenant id=1 ya existe: "${existing.rows[0].name}" (slug=${existing.rows[0].slug})`);
      console.log('   No se sobreescribe. Para forzar: DELETE FROM tenants WHERE id = 1; y volver a correr.');
      process.exit(0);
    }

    // Reusa tu ADMIN_TOKEN actual como token del tenant 1. Si no existe, genera nuevo.
    const tenantToken = process.env.ADMIN_TOKEN || generateSecureToken(32);
    const tokenHash = await bcrypt.hash(tenantToken, 10);
    const tokenHint = tenantToken.slice(0, 8);

    // Cifrar secretos sensibles antes de meter a DB (si hay ENCRYPTION_KEY)
    const metaTokenEnc = encrypt(process.env.META_ACCESS_TOKEN);
    const metaSecretEnc = encrypt(process.env.META_APP_SECRET);
    const geminiKeyEnc = encrypt(process.env.GEMINI_API_KEY);

    console.log('▶ Insertando tenant id=1 "SG Bolivia"...');
    await db.query(`
      INSERT INTO tenants (
        id, slug, name,
        token_hash, token_lookup_hint,
        active, read_only,
        plan, billing_email, billing_status,
        meta_phone_number_id, waba_id, phone_display,
        meta_token_enc, meta_app_secret_enc, meta_verify_token,
        gemini_api_key_enc,
        r2_prefix,
        n8n_webhook_url,
        owner_phone,
        notes
      ) VALUES (
        1, $1, $2,
        $3, $4,
        TRUE, FALSE,
        'enterprise', $5, 'active',
        $6, $7, $8,
        $9, $10, $11,
        $12,
        'tenants/sg-bolivia',
        $13,
        $14,
        'Tenant primario - SG Bolivia (cuenta del propio vendor)'
      )
    `, [
      'sg-bolivia',
      'SG Bolivia (Aitana - cuenta vendor)',
      tokenHash,
      tokenHint,
      process.env.OWNER_EMAIL || 'jose_said_m@hotmail.com',
      process.env.META_PHONE_NUMBER_ID || null,
      process.env.META_WABA_ID || null,
      process.env.PHONE_DISPLAY || '+591 615 26996',
      metaTokenEnc,
      metaSecretEnc,
      process.env.META_VERIFY_TOKEN || null,
      geminiKeyEnc,
      process.env.N8N_WEBHOOK_URL || null,
      process.env.OWNER_PHONE || null,
    ]);

    // Resetear la secuencia para que el próximo tenant sea id=2
    await db.query(`SELECT setval(pg_get_serial_sequence('tenants', 'id'), GREATEST(1, (SELECT MAX(id) FROM tenants)));`);

    console.log('\n✅ Tenant id=1 "SG Bolivia" creado exitosamente.');
    console.log('');
    console.log('🔑 Token del tenant 1:');
    if (process.env.ADMIN_TOKEN) {
      console.log('   Reusa tu ADMIN_TOKEN existente: ' + tokenToShow(process.env.ADMIN_TOKEN));
      console.log('   ✅ Tu panel actual sigue funcionando sin cambios.');
    } else {
      console.log('   TENANT_TOKEN_SGBOLIVIA = ' + tenantToken);
      console.log('   ⚠️  GUARDÁ este token, no se vuelve a mostrar.');
      console.log('   Agregalo a Railway env: ADMIN_TOKEN=' + tenantToken);
    }
    console.log('');
    console.log('📋 Verificación:');
    console.log('   1. Tu panel sigue funcionando con tu token actual');
    console.log('   2. tenant_id=1 ahora etiqueta TODAS las conversaciones/leads existentes');
    console.log('   3. Cuando llegue cliente nuevo: crear tenant_id=2 con su propio token');

    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-seed-default-tenant:', err);
    process.exit(1);
  }
})();
