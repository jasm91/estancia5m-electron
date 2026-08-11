/**
 * Migración v0.9.397 — Master switch de botones interactivos por tenant.
 *
 * tenants.bot_buttons_enabled: cuando es FALSE, Aitana NO usa botones/listas tocables de
 * WhatsApp (el bloque de botones no se anexa al prompt y, por las dudas, /whatsapp/send
 * degrada cualquier marcador a texto natural). Default TRUE (comportamiento actual).
 *
 * Idempotente. Registrada en migrate-all.js.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.397 — master switch de botones interactivos...');
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bot_buttons_enabled boolean NOT NULL DEFAULT true;`);
  console.log('✅ tenants.bot_buttons_enabled (default true)');
  console.log('🎉 Migración v0.9.397 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración v0.9.397:', e.message);
  process.exit(1);
});
