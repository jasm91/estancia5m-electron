/**
 * migrate-vip-contacts-v0928m.js — v0.9.316
 * Clientes VIP: números "tageados" que deben recibir atención prioritaria de un asesor.
 * Cuando un VIP escribe, el equipo recibe aviso (push + WhatsApp por línea) y el chat
 * sube al tope del inbox con badge ⭐. Fuente de verdad por (tenant_id, phone). Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.316 — vip_contacts (clientes VIP prioritarios)…');
  await db.query(`
    CREATE TABLE IF NOT EXISTS vip_contacts (
      id          BIGSERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      phone       TEXT NOT NULL,
      label       TEXT,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_vip_tenant_phone ON vip_contacts (tenant_id, phone);`);
  await db.query(`CREATE INDEX IF NOT EXISTS ix_vip_tenant ON vip_contacts (tenant_id);`);
  console.log('✅ vip_contacts listo.');
  console.log('🎉 Migración v0.9.316 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
