/**
 * migrate-straight-line-v0947.js — v0.9.369
 * STRAIGHT LINE (Jordan Belfort) sobre el CRM: calificación por los TRES DIECES
 * (P=producto, V=vendedor, E=empresa, 0-10), ARQUETIPO de comprador
 * (ready | shopping | curious | dragged), UMBRAL DE ACCIÓN (low|medium|high)
 * e INTELIGENCIA de las 7 preguntas (likes/dislikes/pain/why/ideal/decisive_factor).
 *
 * Todo vive en UN JSONB por tabla (sin columnas sueltas):
 *   conversations.sl_state — acumulado turno a turno por /progress (merge strip-nulls)
 *   leads.sl_state         — heredado/sincronizado al lead (igual que search_profile)
 *
 * BANT/SPIN/score NO se tocan: el SL es una capa encima (compatibilidad total).
 * Idempotente.
 */
const db = require('./db');
async function migrate() {
  console.log('🔧 v0.9.369 — Straight Line: conversations.sl_state + leads.sl_state…');
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sl_state JSONB;`);
  await db.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS sl_state JSONB;`);
  console.log('✅ sl_state listo en conversations y leads.');
  console.log('🎉 Migración v0.9.369 completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
