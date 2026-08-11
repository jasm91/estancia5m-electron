/**
 * migrate-lead-nurture-v0928j.js — v0.9.304
 * Nurturing por comportamiento: cuando entra al catálogo un ítem que matchea el
 * search_profile de un lead, se lo re-engancha por WhatsApp. OPT-IN (apagado por defecto).
 * lead_nurtures = log anti-repetición + tope de frecuencia. Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.304 — nurturing por comportamiento (lead_nurtures + toggle)…');
  await db.query(`
    CREATE TABLE IF NOT EXISTS lead_nurtures (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      lead_id   INTEGER NOT NULL,
      item_kind TEXT NOT NULL,
      item_id   INTEGER NOT NULL,
      score     INTEGER,
      channel   TEXT DEFAULT 'whatsapp',
      mode      TEXT,
      sent_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lead_nurtures_lead ON lead_nurtures (lead_id, sent_at DESC);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_lead_nurtures_item ON lead_nurtures (lead_id, item_kind, item_id);`);
  // OPT-IN: nadie recibe nurturing hasta que el dueño lo prenda.
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nurture_enabled BOOLEAN NOT NULL DEFAULT FALSE;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nurture_min_score INTEGER DEFAULT 60;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nurture_cooldown_days INTEGER DEFAULT 3;`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS nurture_template TEXT;`);
  console.log('✅ lead_nurtures + tenants.nurture_enabled/min_score/cooldown_days/template.');
  console.log('🎉 Migración v0.9.304 (nurturing) completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
