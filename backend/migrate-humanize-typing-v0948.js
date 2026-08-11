/**
 * migrate-humanize-typing-v0948.js — v0.9.372
 * TYPING HUMANIZADO: el bot escribe como persona (burbujas con "escribiendo…",
 * pausas aleatorias y tiempo proporcional al largo del texto). Toggle por tenant,
 * default ON. Kill-switch global: env HUMANIZE_TYPING=0. Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.372 — tenants.humanize_typing (typing humanizado)…');
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS humanize_typing BOOLEAN DEFAULT TRUE;`);
  console.log('✅ humanize_typing listo (default ON).');
  console.log('🎉 Migración v0.9.372 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
