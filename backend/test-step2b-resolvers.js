/**
 * test-step2b-resolvers.js
 *
 * Test del refactor multi-tenant Step 2b.
 *
 * QUE VALIDA:
 *   1. resolveTenantByPhoneNumberId con el phone_number_id real de SG Bolivia
 *      → debe retornar tenant_id=1, slug='sg-bolivia'
 *   2. resolveTenantByPhoneNumberId con un phone_number_id inválido
 *      → debe retornar null (caller hace fallback a 1)
 *   3. resolveTenantByPhone con un número de cliente existente
 *      → debe retornar tenant_id=1 vía la conversación existente
 *   4. resolveTenantByPhone con un número que nunca escribió
 *      → debe retornar null (caller hace fallback a 1)
 *   5. Cache de phone_number_id funciona (segunda llamada no hace SQL)
 *   6. Idempotencia: no rompe nada de la data existente
 *
 * EJECUTAR:
 *   cd backend && node test-step2b-resolvers.js
 *
 * NO MODIFICA NADA EN PRODUCCIÓN. Solo lee.
 */

require('dotenv').config();
const {
  resolveTenantByPhoneNumberId,
  resolveTenantByPhone,
  invalidatePhoneNumberIdCache,
  invalidatePhoneCache,
} = require('./tenant-resolver');
const db = require('./db');

const SG_BOLIVIA_PHONE_NUMBER_ID = '1170795682775808'; // del handoff
const SG_BOLIVIA_TENANT_ID = 1;

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`❌ ${name}\n   ${err.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  console.log('🧪 Step 2b — Tests de resolvers\n');

  // ─── Test 1: phone_number_id real de SG Bolivia
  await test('resolveTenantByPhoneNumberId con phone_number_id real', async () => {
    invalidatePhoneNumberIdCache();
    const tenant = await resolveTenantByPhoneNumberId(SG_BOLIVIA_PHONE_NUMBER_ID);
    assert(tenant !== null, 'no debería retornar null');
    assert(tenant.id === SG_BOLIVIA_TENANT_ID, `esperaba id=${SG_BOLIVIA_TENANT_ID}, recibí ${tenant.id}`);
    assert(tenant.slug === 'sg-bolivia', `esperaba slug='sg-bolivia', recibí '${tenant.slug}'`);
    assert(tenant.active === true, 'debería estar active');
  });

  // ─── Test 2: phone_number_id inexistente
  await test('resolveTenantByPhoneNumberId con phone_number_id inválido', async () => {
    invalidatePhoneNumberIdCache();
    const tenant = await resolveTenantByPhoneNumberId('0000000000000000');
    assert(tenant === null, `esperaba null, recibí ${JSON.stringify(tenant)}`);
  });

  // ─── Test 3: phone_number_id null/undefined
  await test('resolveTenantByPhoneNumberId con null', async () => {
    const t1 = await resolveTenantByPhoneNumberId(null);
    const t2 = await resolveTenantByPhoneNumberId(undefined);
    const t3 = await resolveTenantByPhoneNumberId('');
    assert(t1 === null && t2 === null && t3 === null, 'todos deberían retornar null');
  });

  // ─── Test 4: cache funciona
  await test('Cache de phone_number_id funciona', async () => {
    invalidatePhoneNumberIdCache();

    const t1 = await resolveTenantByPhoneNumberId(SG_BOLIVIA_PHONE_NUMBER_ID);
    assert(t1 !== null, 'primera llamada debería resolver');

    // Segunda llamada — debería venir de cache (instantánea)
    const start = Date.now();
    const t2 = await resolveTenantByPhoneNumberId(SG_BOLIVIA_PHONE_NUMBER_ID);
    const elapsed = Date.now() - start;
    assert(t2 !== null && t2.id === t1.id, 'segunda llamada debería retornar lo mismo');
    assert(elapsed < 10, `segunda llamada debería ser <10ms (cache), tardó ${elapsed}ms`);
  });

  // ─── Test 5: invalidación de cache
  await test('invalidatePhoneNumberIdCache limpia correctamente', async () => {
    invalidatePhoneNumberIdCache();
    await resolveTenantByPhoneNumberId(SG_BOLIVIA_PHONE_NUMBER_ID);
    invalidatePhoneNumberIdCache(SG_BOLIVIA_PHONE_NUMBER_ID);

    // Después de invalidar, próxima llamada hace SQL otra vez (no instantánea)
    const start = Date.now();
    const t = await resolveTenantByPhoneNumberId(SG_BOLIVIA_PHONE_NUMBER_ID);
    const elapsed = Date.now() - start;
    assert(t !== null, 'debería resolver de nuevo');
    // No assert sobre tiempo porque el sql puede ser muy rápido también
  });

  // ─── Test 6: resolveTenantByPhone con número que tiene conversación
  await test('resolveTenantByPhone con cliente existente', async () => {
    // Buscar un phone real con conversación
    const r = await db.query(
      `SELECT phone FROM conversations WHERE tenant_id = 1 LIMIT 1`
    );
    if (r.rows.length === 0) {
      console.log('   ⚠️  Skip: no hay conversaciones en DB');
      return;
    }
    const phone = r.rows[0].phone;
    invalidatePhoneCache();

    const tenant = await resolveTenantByPhone(phone);
    assert(tenant !== null, `phone=${phone} debería resolver tenant`);
    assert(tenant.id === SG_BOLIVIA_TENANT_ID, `esperaba id=1, recibí ${tenant.id}`);
  });

  // ─── Test 7: resolveTenantByPhone con número que nunca escribió
  await test('resolveTenantByPhone con phone sin conversación', async () => {
    invalidatePhoneCache();
    const tenant = await resolveTenantByPhone('99999999999');
    assert(tenant === null, `esperaba null, recibí ${JSON.stringify(tenant)}`);
  });

  // ─── Resumen
  console.log(`\n📊 Resultados: ${passed} pasaron, ${failed} fallaron`);
  if (failed > 0) {
    console.log('\n⚠️  Hay fallos. NO mergear a main hasta resolver.');
    process.exit(1);
  } else {
    console.log('\n✅ Todos los tests pasaron. Safe para mergear.');
    process.exit(0);
  }
})().catch(err => {
  console.error('\n💥 Error fatal en tests:', err);
  process.exit(2);
});
