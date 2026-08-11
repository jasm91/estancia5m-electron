/**
 * link-fb-user.js — v0.9.8
 *
 * Vincula un fb_user_id a un tenant existente. Necesario una sola vez para
 * tenants que se crearon ANTES de que el onboarding guardara el fb_user_id
 * (ej. SG Bolivia / tenant 1).
 *
 * Cómo obtener tu fb_user_id:
 *   1. Andá a app.sg-ventas.com e intentá "Iniciar sesión con Facebook"
 *   2. El login va a fallar con "tu cuenta todavía no está vinculada"
 *   3. Abrí la consola del navegador (F12 → Network → la request a facebook-login)
 *      y mirá la respuesta: trae "fb_user_id": "..."  ← ese número
 *   (o pedímelo y te digo dónde verlo)
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node link-fb-user.js <TENANT_ID> <FB_USER_ID>
 *
 * Ejemplo (vincular tu Facebook al tenant 1 = SG Bolivia):
 *   ... node link-fb-user.js 1 1234567890
 */

const db = require('./db');

(async () => {
  const tenantId = process.argv[2];
  const fbUserId = process.argv[3];

  if (!tenantId || !fbUserId) {
    console.error('❌ Uso: node link-fb-user.js <TENANT_ID> <FB_USER_ID>');
    console.error('   Ejemplo: node link-fb-user.js 1 1234567890');
    process.exit(1);
  }

  try {
    // Verificar que el tenant existe
    const t = await db.query('SELECT id, name, fb_user_id FROM tenants WHERE id = $1', [tenantId]);
    if (t.rows.length === 0) {
      console.error(`❌ No existe el tenant ${tenantId}`);
      process.exit(1);
    }
    const tenant = t.rows[0];

    if (tenant.fb_user_id && tenant.fb_user_id !== fbUserId) {
      console.log(`⚠️  El tenant ${tenantId} (${tenant.name}) ya tiene otro fb_user_id (${tenant.fb_user_id}).`);
      console.log(`   Lo voy a reemplazar por ${fbUserId}.`);
    }

    // Verificar que ese fb_user_id no esté ya en otro tenant
    const dup = await db.query('SELECT id, name FROM tenants WHERE fb_user_id = $1 AND id != $2', [fbUserId, tenantId]);
    if (dup.rows.length > 0) {
      console.error(`❌ Ese fb_user_id ya está vinculado al tenant ${dup.rows[0].id} (${dup.rows[0].name}).`);
      console.error('   Un Facebook solo puede estar en un tenant. Abortando.');
      process.exit(1);
    }

    await db.query('UPDATE tenants SET fb_user_id = $1 WHERE id = $2', [fbUserId, tenantId]);
    console.log(`✅ Vinculado: fb_user_id ${fbUserId} → tenant ${tenantId} (${tenant.name})`);
    console.log('   Ahora ya podés iniciar sesión con Facebook en el panel.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  }
})();
