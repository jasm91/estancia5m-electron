/**
 * test-tenant-isolation.js — v0.8.0 Sprint 1
 *
 * Tests CRÍTICOS de aislamiento entre tenants. Si alguno falla, NO se puede
 * deployar a producción.
 *
 * Probamos:
 *   1. Insertar datos como tenant_1
 *   2. Insertar datos como tenant_2 (creamos uno de prueba)
 *   3. Verificar que queries con qt(1) NUNCA devuelven datos de tenant_2
 *   4. Verificar que queries con qt(2) NUNCA devuelven datos de tenant_1
 *   5. Verificar que el middleware bloquea tokens cruzados
 *
 * Uso:
 *   node test-tenant-isolation.js
 *
 * NO usar en producción — esto crea/borra datos de prueba.
 * SOLO en staging o con DATABASE_URL apuntando a una DB de test.
 */

const bcrypt = require('bcryptjs');
const db = require('./db');
const { qt, findTenantByToken } = require('./tenant-resolver');

const TEST_PHONE_T1 = '+9991111111';
const TEST_PHONE_T2 = '+9992222222';
const TEST_TENANT_2_SLUG = '__test_tenant_2__';

let testsRun = 0;
let testsPassed = 0;
let testsFailed = [];

function assert(condition, label) {
  testsRun++;
  if (condition) {
    testsPassed++;
    console.log(`  ✅ ${label}`);
  } else {
    testsFailed.push(label);
    console.log(`  ❌ FAIL: ${label}`);
  }
}

async function setup() {
  console.log('\n▶ Setup: crear tenant_2 de prueba');

  // Verificar que tenant_1 existe (creado por migrate-seed-default-tenant)
  const t1 = await db.query('SELECT id FROM tenants WHERE id = 1');
  if (t1.rows.length === 0) {
    throw new Error('tenant_1 no existe. Correr migrate-seed-default-tenant.js primero.');
  }

  // Eliminar tenant de prueba si quedó de una corrida anterior
  await db.query('DELETE FROM tenants WHERE slug = $1', [TEST_TENANT_2_SLUG]);

  // Crear tenant_2 con token de prueba
  const testToken = 'test_isolation_token_xyz_2026';
  const tokenHash = await bcrypt.hash(testToken, 10);
  const tokenHint = testToken.slice(0, 8);

  const r = await db.query(`
    INSERT INTO tenants (slug, name, token_hash, token_lookup_hint, plan, r2_prefix)
    VALUES ($1, 'TEST Tenant 2 (isolation)', $2, $3, 'trial', 'tenants/__test_2__')
    RETURNING id
  `, [TEST_TENANT_2_SLUG, tokenHash, tokenHint]);

  const tenant2Id = r.rows[0].id;
  console.log(`   tenant_2 creado con id=${tenant2Id}`);

  // Limpiar conversaciones de prueba previas
  await db.query('DELETE FROM conversations WHERE phone IN ($1, $2)', [TEST_PHONE_T1, TEST_PHONE_T2]);

  return { tenant2Id, testToken };
}

async function cleanup({ tenant2Id }) {
  console.log('\n▶ Cleanup');
  // Eliminar conversaciones de prueba
  await db.query('DELETE FROM conversations WHERE phone IN ($1, $2)', [TEST_PHONE_T1, TEST_PHONE_T2]);
  // Eliminar tenant_2
  await db.query('DELETE FROM tenants WHERE id = $1', [tenant2Id]);
  console.log('   ✅ Datos de test eliminados');
}

async function testIsolation({ tenant2Id, testToken }) {
  console.log('\n▶ Test 1: INSERT por tenant - cada uno guarda su conversación');

  await db.query(`
    INSERT INTO conversations (tenant_id, phone, contact_name, status, last_message_at)
    VALUES (1, $1, 'Cliente Tenant 1', 'open', NOW())
  `, [TEST_PHONE_T1]);

  await db.query(`
    INSERT INTO conversations (tenant_id, phone, contact_name, status, last_message_at)
    VALUES ($1, $2, 'Cliente Tenant 2', 'open', NOW())
  `, [tenant2Id, TEST_PHONE_T2]);

  console.log('\n▶ Test 2: qt(1) NUNCA devuelve datos de tenant_2');

  const r1 = await qt(1, 'SELECT phone, contact_name FROM conversations WHERE phone IN ($1, $2)',
    [TEST_PHONE_T1, TEST_PHONE_T2]);

  assert(r1.rows.length === 1, 'tenant_1 ve exactamente 1 conversación');
  assert(r1.rows[0]?.phone === TEST_PHONE_T1, 'tenant_1 ve SU propia conversación');
  assert(!r1.rows.find(r => r.phone === TEST_PHONE_T2), 'tenant_1 NO ve la conversación de tenant_2');

  console.log('\n▶ Test 3: qt(tenant2Id) NUNCA devuelve datos de tenant_1');

  const r2 = await qt(tenant2Id, 'SELECT phone, contact_name FROM conversations WHERE phone IN ($1, $2)',
    [TEST_PHONE_T1, TEST_PHONE_T2]);

  assert(r2.rows.length === 1, 'tenant_2 ve exactamente 1 conversación');
  assert(r2.rows[0]?.phone === TEST_PHONE_T2, 'tenant_2 ve SU propia conversación');
  assert(!r2.rows.find(r => r.phone === TEST_PHONE_T1), 'tenant_2 NO ve la conversación de tenant_1');

  console.log('\n▶ Test 4: Resolución de token funciona correctamente');

  const found = await findTenantByToken(testToken);
  assert(found !== null, 'findTenantByToken encuentra al tenant con su token');
  assert(found?.id === tenant2Id, 'El tenant encontrado es el correcto');

  const wrong = await findTenantByToken('token_que_no_existe_xyz_123');
  assert(wrong === null, 'findTenantByToken devuelve null para tokens inexistentes');

  console.log('\n▶ Test 5: UNIQUE constraint permite mismo phone en distintos tenants');

  // Ambos tenants pueden tener un cliente con el mismo número (raro pero válido)
  try {
    await db.query(`
      INSERT INTO conversations (tenant_id, phone, contact_name, status, last_message_at)
      VALUES (1, $1, 'Mismo número', 'open', NOW())
    `, ['+9993333333']);

    await db.query(`
      INSERT INTO conversations (tenant_id, phone, contact_name, status, last_message_at)
      VALUES ($1, $2, 'Mismo número en otro tenant', 'open', NOW())
    `, [tenant2Id, '+9993333333']);

    assert(true, 'Mismo phone en distintos tenants funciona (constraint compuesta correcta)');

    // Cleanup
    await db.query('DELETE FROM conversations WHERE phone = $1', ['+9993333333']);
  } catch (e) {
    assert(false, `Mismo phone en distintos tenants falló: ${e.message}`);
  }

  console.log('\n▶ Test 6: UNIQUE constraint bloquea mismo phone en MISMO tenant');

  try {
    await db.query(`
      INSERT INTO conversations (tenant_id, phone, contact_name, status, last_message_at)
      VALUES (1, $1, 'Duplicado mismo tenant', 'open', NOW())
    `, [TEST_PHONE_T1]);
    assert(false, 'NO debería permitir duplicado de phone en mismo tenant');
  } catch (e) {
    assert(e.code === '23505' || e.message.includes('duplicate') || e.message.includes('unique'),
      'Bloquea duplicado de phone en mismo tenant');
  }
}

(async () => {
  try {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  TEST DE AISLAMIENTO MULTI-TENANT — Sprint 1');
    console.log('═══════════════════════════════════════════════════════');

    const ctx = await setup();
    await testIsolation(ctx);
    await cleanup(ctx);

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  RESULTADOS: ${testsPassed}/${testsRun} tests pasaron`);
    if (testsFailed.length > 0) {
      console.log('  ❌ FALLARON:');
      for (const f of testsFailed) console.log(`     - ${f}`);
      console.log('\n  NO PROCEDER CON EL DEPLOY. Arreglar primero.');
      process.exit(1);
    }
    console.log('  ✅ Aislamiento verificado. Sprint 1 listo para integrar.');
    console.log('═══════════════════════════════════════════════════════');

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error en tests:', err);
    process.exit(1);
  }
})();
