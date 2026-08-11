/**
 * create-test-tenant-v1.js — Tenant de PRUEBA para validar aislamiento multi-tenant
 *
 * Crea (o actualiza, idempotente) un tenant de prueba con:
 *   - token sgv_ (mismo formato que onboarding) + hash bcrypt
 *   - credenciales Meta PLACEHOLDER (NO envía mensajes reales — el phone_number_id
 *     y el token son falsos a propósito, para no disparar nada por accidente)
 *   - 2 conversaciones de prueba con mensajes
 *   - un JWT de tenant válido 7 días, para entrar al panel COMO este tenant
 *
 * Sirve para confirmar que, logueado como tenant_2, NO ves los datos de SG Bolivia.
 *
 * Requiere envs: DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY
 *
 * Uso (un bloque):
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *   JWT_SECRET="$(railway variables --service sg-ventas --kv | grep '^JWT_SECRET=' | cut -d= -f2-)" \
 *   ENCRYPTION_KEY="$(railway variables --service sg-ventas --kv | grep '^ENCRYPTION_KEY=' | cut -d= -f2-)" \
 *   node backend/create-test-tenant-v1.js
 */
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { encrypt } = require('./crypto');

const SLUG = 'prueba-tenant-2';
const NAME = 'PRUEBA Tenant 2 (aislamiento)';
const FAKE_PHONE_ID = '100000000000002';   // falso, único, NO es el de SG Bolivia
const FAKE_WABA_ID = '200000000000002';
const TEST_PHONES = ['90000000001', '90000000002'];

async function main() {
  if (!process.env.JWT_SECRET) throw new Error('Falta JWT_SECRET en el entorno');
  if (!process.env.ENCRYPTION_KEY) throw new Error('Falta ENCRYPTION_KEY en el entorno');

  // Token de tenant (mismo formato que onboarding) — el panel nuevo usa JWT,
  // pero lo dejamos por compatibilidad / referencia.
  const plain = 'sgv_' + crypto.randomBytes(24).toString('hex');
  const hash = await bcrypt.hash(plain, 10);
  const hint = plain.substring(0, 8);
  const tokenEnc = encrypt('PLACEHOLDER_NO_REAL_TOKEN'); // token Meta falso a propósito

  // Upsert del tenant por slug (id estable entre corridas)
  let tenantId;
  const existing = await db.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
  if (existing.rows.length) {
    tenantId = existing.rows[0].id;
    await db.query(
      `UPDATE tenants
         SET name=$2, token_hash=$3, token_lookup_hint=$4, active=TRUE,
             meta_phone_number_id=$5, waba_id=$6, phone_display=$7,
             meta_token_enc=$8, meta_verify_token=$9, updated_at=NOW()
       WHERE id=$1`,
      [tenantId, NAME, hash, hint, FAKE_PHONE_ID, FAKE_WABA_ID, '+591 700 00002', tokenEnc, 'verify_test_2']
    );
    console.log(`↻ Tenant de prueba ya existía — actualizado. id=${tenantId}`);
  } else {
    const ins = await db.query(
      `INSERT INTO tenants
        (slug, name, token_hash, token_lookup_hint, active, plan, billing_status,
         meta_phone_number_id, waba_id, phone_display, meta_token_enc, meta_verify_token, r2_prefix)
       VALUES ($1,$2,$3,$4,TRUE,'trial','trial',$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [SLUG, NAME, hash, hint, FAKE_PHONE_ID, FAKE_WABA_ID, '+591 700 00002', tokenEnc, 'verify_test_2', 'tenants/' + SLUG]
    );
    tenantId = ins.rows[0].id;
    console.log(`✅ Tenant de prueba creado. id=${tenantId}`);
  }

  // Limpiar conversaciones de prueba anteriores (idempotente) y re-sembrar
  await db.query('DELETE FROM conversations WHERE tenant_id=$1 AND phone = ANY($2::text[])', [tenantId, TEST_PHONES]);
  const seed = [
    { phone: TEST_PHONES[0], name: 'Cliente Prueba Uno', score: 80, msgs: [
      ['incoming', 'client', 'Hola, me interesa el sistema'],
      ['outgoing', 'bot', '¡Hola! Soy Aitana 👋 ¿Para qué rubro lo necesitás?'],
    ]},
    { phone: TEST_PHONES[1], name: 'Cliente Prueba Dos', score: 40, msgs: [
      ['incoming', 'client', '¿Cuánto cuesta?'],
    ]},
  ];
  for (const c of seed) {
    const cr = await db.query(
      `INSERT INTO conversations (phone, contact_name, mode, tenant_id, last_message_at, current_score, status)
       VALUES ($1,$2,'bot',$3,NOW(),$4,'open') RETURNING id`,
      [c.phone, c.name, tenantId, c.score]
    );
    const convId = cr.rows[0].id;
    for (const m of c.msgs) {
      await db.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, type, body, status)
         VALUES ($1,$2,$3,'text',$4,'sent')`,
        [convId, m[0], m[1], m[2]]
      );
    }
  }
  console.log(`✅ Sembradas ${seed.length} conversaciones de prueba (tenant ${tenantId}).`);

  // JWT de tenant_2 (mismo payload que issueSession del backend)
  const token = jwt.sign(
    { tenant_id: tenantId, slug: SLUG, fb_user_id: null },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );

  console.log('\n════════════════ DATOS DE PRUEBA ════════════════');
  console.log('tenant_id :', tenantId);
  console.log('slug      :', SLUG);
  console.log('token sgv_:', plain);
  console.log('\nJWT (7 días) — para entrar al panel COMO este tenant:');
  console.log(token);
  console.log('\n──────── Cómo verificar el aislamiento ────────');
  console.log('1) Abrí  https://app.sg-ventas.com/panel/');
  console.log('2) Consola del navegador (Cmd+Opt+J) y pegá:');
  console.log("     localStorage.setItem('sg-ventas-session-jwt', 'PEGA_EL_JWT_DE_ARRIBA')");
  console.log('3) Recargá la página (Cmd+R).');
  console.log('   → Deberías ver SOLO 2 conversaciones (las de prueba),');
  console.log('     NO las ~115 de SG Bolivia. Eso confirma el aislamiento. ✅');
  console.log('\nPara volver a tu sesión normal:');
  console.log("     localStorage.removeItem('sg-ventas-session-jwt')  y recargá (o re-login con Facebook).");
  console.log('═══════════════════════════════════════════════════');
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
