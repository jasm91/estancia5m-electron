/**
 * Migración v0.6.0 — Web Push subscriptions
 * Tabla para guardar las suscripciones push del navegador.
 */
const { Client } = require('pg');

async function run() {
  if (!process.env.DATABASE_URL) {
    console.log('⏭  DATABASE_URL no configurado, skip');
    return;
  }
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id SERIAL PRIMARY KEY,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_push_subs_endpoint
        ON push_subscriptions(endpoint);
    `);
    console.log('✅ push_subscriptions creada (o ya existía)');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().catch(e => {
    console.error('❌ Error en migración v0.6.0:', e.message);
    process.exit(1);
  });
}

module.exports = { run };
