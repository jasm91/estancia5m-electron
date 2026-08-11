/**
 * audit-tenant-state.js — solo lectura
 *
 * Inspecciona el estado actual de tenants, webhook routing, tokens y conversations.
 * NO modifica nada. Solo SELECT.
 *
 * Uso:
 *   DATABASE_URL="$(railway variables --service Postgres --kv | grep '^DATABASE_PUBLIC_URL=' | cut -d= -f2-)" \
 *     node audit-tenant-state.js
 */

const db = require('./db');

(async () => {
  try {
    console.log('🔍 AUDITORÍA DE TENANT STATE — solo lectura\n');

    // 1. Tenants existentes
    console.log('━━━ 1. TENANTS EXISTENTES ━━━');
    const tenants = await db.query(`
      SELECT id, slug, name, active, plan, billing_status,
             meta_phone_number_id, waba_id, phone_display,
             (meta_token_enc IS NOT NULL) AS has_token,
             meta_business_portfolio_id,
             meta_onboarding_completed_at,
             webhook_subscribed,
             created_at
      FROM tenants
      ORDER BY id
    `);
    console.log(`   Total: ${tenants.rows.length} tenant(s)`);
    tenants.rows.forEach(t => {
      console.log(`   • [${t.id}] ${t.name} (${t.slug})`);
      console.log(`     active=${t.active}, plan=${t.plan}, billing=${t.billing_status}`);
      console.log(`     phone_id=${t.meta_phone_number_id || 'NULL'}, waba=${t.waba_id || 'NULL'}`);
      console.log(`     display=${t.phone_display || 'NULL'}, has_token=${t.has_token}`);
      console.log(`     onboarding_completed=${t.meta_onboarding_completed_at || 'NULL'}`);
      console.log(`     webhook_subscribed=${t.webhook_subscribed}`);
      console.log('');
    });

    // 2. Distribución de conversations por tenant
    console.log('━━━ 2. CONVERSATIONS POR TENANT ━━━');
    const convs = await db.query(`
      SELECT tenant_id, COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status = 'open')::int AS open
      FROM conversations
      GROUP BY tenant_id
      ORDER BY tenant_id
    `);
    convs.rows.forEach(r => {
      console.log(`   tenant_id=${r.tenant_id}: ${r.total} convs (${r.open} abiertas)`);
    });
    console.log('');

    // 3. Tenant requests pendientes
    console.log('━━━ 3. TENANT REQUESTS ━━━');
    const reqs = await db.query(`
      SELECT id, status, name, vertical_interest, created_at
      FROM tenant_requests
      ORDER BY created_at DESC
      LIMIT 10
    `);
    if (reqs.rows.length === 0) {
      console.log('   (ninguna)');
    } else {
      reqs.rows.forEach(r => console.log(`   • [${r.id}] ${r.status} - ${r.name} (${r.vertical_interest})`));
    }
    console.log('');

    // 4. Columnas Meta en tenants
    console.log('━━━ 4. COLUMNAS META EN TENANTS ━━━');
    const cols = await db.query(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'tenants'
        AND column_name LIKE 'meta_%' OR column_name LIKE 'waba_%' OR column_name LIKE 'webhook_%'
      ORDER BY column_name
    `);
    cols.rows.forEach(c => console.log(`   ${c.column_name.padEnd(40)} ${c.data_type.padEnd(15)} nullable=${c.is_nullable}`));
    console.log('');

    // 5. Variables de entorno relevantes (sin mostrar valores secretos)
    console.log('━━━ 5. ENV VARS RELEVANTES ━━━');
    const checkEnv = (name) => {
      const v = process.env[name];
      console.log(`   ${name.padEnd(35)} ${v ? `✅ set (${v.length} chars)` : '❌ NOT SET'}`);
    };
    checkEnv('META_APP_ID');
    checkEnv('META_APP_SECRET');
    checkEnv('META_ACCESS_TOKEN');
    checkEnv('META_VERIFY_TOKEN');
    checkEnv('META_CONFIG_ID');
    checkEnv('META_EMBEDDED_SIGNUP_CONFIG_ID');
    checkEnv('TENANT_TOKEN_ENC_KEY');
    checkEnv('ENCRYPTION_KEY');

    console.log('\n✅ Auditoría completa');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err);
    process.exit(1);
  }
})();
