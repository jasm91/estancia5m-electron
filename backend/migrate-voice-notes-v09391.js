/**
 * Migración v0.9.391 — Notas de voz (ElevenLabs): voz por línea + config por tenant
 *
 * 1. tenant_lines.voice_id: cada línea de WhatsApp puede tener SU propia voz de
 *    ElevenLabs (NULL = usa la voz por defecto del tenant; si tampoco hay, cae a
 *    la global ELEVEN_VOICE_ID del entorno). Elegida por NOMBRE desde el panel.
 * 2. tenants.voice_notes_config JSONB: master switch + toggles por MOMENTO
 *    (saludo, cita, ficha estrella, reactivación) + voz por defecto + modelo.
 *    Shape: { enabled, greeting, appointment, ficha, reactivation, default_voice_id, model }
 *
 * La API key NUNCA se guarda acá: vive solo en el entorno (ELEVENLABS_API_KEY).
 * Idempotente. Registrada en migrate-all.js.
 *
 * Uso: DATABASE_URL="..." node migrate-voice-notes-v09391.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.391 — notas de voz: voz por línea + config por tenant...');

  // 1. Voz por línea
  await db.query(`ALTER TABLE tenant_lines ADD COLUMN IF NOT EXISTS voice_id TEXT;`);
  console.log('✅ tenant_lines.voice_id');

  // 2. Config de notas de voz por tenant (master + momentos + voz por defecto + modelo)
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS voice_notes_config JSONB NOT NULL DEFAULT '{}'::jsonb;`);
  console.log('✅ tenants.voice_notes_config');

  console.log('🎉 Migración v0.9.391 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración v0.9.391:', e.message);
  process.exit(1);
});
