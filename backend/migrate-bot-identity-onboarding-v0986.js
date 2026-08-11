/**
 * Migración v0.9.86 — Identidad de la IA + flag de onboarding guiado
 *
 *   tenants.bot_name            TEXT     — nombre con que se presenta la IA.
 *                                          NULL = "Aitana" (default, sin cambio).
 *   tenants.bot_tone            TEXT     — 'cercano' | 'profesional' | 'vendedor'.
 *                                          NULL = sin línea de tono (sin cambio).
 *   tenants.onboarding_completed BOOLEAN NOT NULL DEFAULT false
 *                                        — true cuando el dueño termina (o saltea)
 *                                          el wizard de primer login. NUEVOS tenants
 *                                          arrancan en false → ven el wizard.
 *
 * BACKFILL (una sola vez): todos los tenants que YA existían se marcan como
 * onboarding_completed = true, para que el wizard NO le aparezca a clientes
 * actuales (SG Bolivia, Asesor, etc.). El backfill corre SOLO la primera vez que
 * se crea la columna; en re-ejecuciones (deploy-latest re-corre todo) NO toca
 * filas → un tenant nuevo creado después no se marca como completado por error.
 *
 * Idempotente.  DATABASE_URL="..." node migrate-bot-identity-onboarding-v0986.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.86 — identidad de la IA + onboarding...');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bot_name TEXT;`);
  console.log('✅ tenants.bot_name');

  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS bot_tone TEXT;`);
  console.log('✅ tenants.bot_tone');

  // Detectar si la columna del flag ya existía ANTES de crearla → así el backfill
  // de "existentes = completados" corre exactamente una vez.
  const had = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'onboarding_completed' LIMIT 1`
  );
  if (had.rows.length === 0) {
    await db.query(`ALTER TABLE tenants ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT false;`);
    const up = await db.query(`UPDATE tenants SET onboarding_completed = true;`);
    console.log(`✅ tenants.onboarding_completed (+ backfill ${up.rowCount} tenant(s) existentes = true)`);
  } else {
    console.log('• tenants.onboarding_completed ya existía → sin backfill (correcto)');
  }

  console.log('🎉 Migración v0.9.86 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
