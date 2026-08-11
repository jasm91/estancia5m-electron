// v0.9.110 — tabla para monitorear onboardings iniciados sin terminar.
const db = require('./db');
async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS onboarding_attempts (
      id SERIAL PRIMARY KEY,
      phone_number_id TEXT UNIQUE,
      waba_id TEXT,
      business_name TEXT,
      phone_display TEXT,
      fb_user_id TEXT,
      coexistence BOOLEAN DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'started',
      error TEXT,
      tenant_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_onb_status ON onboarding_attempts (status, updated_at DESC)`);
  console.log('✅ onboarding_attempts lista');
  process.exit(0);
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
