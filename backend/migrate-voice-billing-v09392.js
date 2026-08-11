/**
 * Migración v0.9.392 — Billing de notas de voz (ElevenLabs)
 *
 * El consumo de ElevenLabs se factura igual que los tokens de Gemini: costo en USD
 * (caracteres sintetizados × tarifa) × markup, convertido a Bs al TCO del BCB y sumado
 * al "A pagar". Requiere:
 * 1. platform_pricing.elevenlabs_usd_per_1k_chars: tarifa en USD por cada 1.000 caracteres
 *    (editable en el super-admin, card "Consumo (USD)"). Default 0.10.
 * 2. voice_usage: ledger de caracteres sintetizados por tenant (se acumula por período,
 *    igual que ai_usage con los tokens). kind = 'test' | 'auto'.
 *
 * Idempotente. Registrada en migrate-all.js.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.392 — billing de notas de voz (ElevenLabs)...');

  // 1. Tarifa ElevenLabs (USD por 1.000 caracteres) en la config de precios
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS elevenlabs_usd_per_1k_chars numeric;`);
  await db.query(`UPDATE platform_pricing SET elevenlabs_usd_per_1k_chars = 0.10 WHERE id = 1 AND elevenlabs_usd_per_1k_chars IS NULL;`);
  console.log('✅ platform_pricing.elevenlabs_usd_per_1k_chars (default 0.10)');

  // 2. Ledger de caracteres sintetizados por tenant
  await db.query(`
    CREATE TABLE IF NOT EXISTS voice_usage (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      chars      INTEGER NOT NULL DEFAULT 0,
      kind       TEXT,                         -- 'test' | 'auto'
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_voice_usage_tenant_date ON voice_usage (tenant_id, created_at);`);
  console.log('✅ voice_usage + índice (tenant_id, created_at)');

  console.log('🎉 Migración v0.9.392 completa.');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración v0.9.392:', e.message);
  process.exit(1);
});
