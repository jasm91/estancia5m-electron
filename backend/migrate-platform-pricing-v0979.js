/**
 * migrate-platform-pricing-v0979.js — v0.9.79
 *
 * Precios a NIVEL PLATAFORMA (lo que SG le cobra a cada tenant), configurables
 * desde el panel super-admin. Separado de bot_global_config (que es lo que el
 * bot le DICE a los leads, en Bs).
 *
 * Crea:
 *   - platform_pricing: tabla single-row (id=1) con los precios base por defecto
 *     y el catálogo de packs de mensajes. Los tenants NUEVOS heredan estos
 *     valores al crearse; los existentes mantienen su precio (override por tenant).
 *       · default_price_per_line   (Aitana $/mes por línea)      → 25
 *       · default_price_per_user   (usuario humano $/mes)        → 15
 *       · default_setup_fee        (incorporación de línea, una vez) → 149
 *       · message_packs JSONB      catálogo de packs prepagados  → [1k/89, 5k/399, 10k/749]
 *       · unlimited_monthly_price  precio plan "masivos ilimitados" $/mes → 0 (a convenir)
 *   - tenants.messages_unlimited BOOLEAN: si TRUE, el tenant tiene masivos sin
 *     tope (rienda suelta), no se le controla saldo de packs. Default FALSE.
 *
 * Idempotente: ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS /
 * INSERT ... ON CONFLICT DO NOTHING. No pisa valores ya guardados.
 */

const db = require('./db');

const DEFAULT_PACKS = JSON.stringify([
  { size: 1000, price: 89 },
  { size: 5000, price: 399 },
  { size: 10000, price: 749 },
]);

(async () => {
  try {
    console.log('▶ platform_pricing + tenants.messages_unlimited ...');

    // Tabla single-row de precios de plataforma
    await db.query(`
      CREATE TABLE IF NOT EXISTS platform_pricing (
        id                      INTEGER PRIMARY KEY DEFAULT 1,
        default_price_per_line  NUMERIC(10,2) NOT NULL DEFAULT 25,
        default_price_per_user  NUMERIC(10,2) NOT NULL DEFAULT 15,
        default_setup_fee       NUMERIC(10,2) NOT NULL DEFAULT 149,
        message_packs           JSONB         NOT NULL DEFAULT '${DEFAULT_PACKS}'::jsonb,
        unlimited_monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0,
        updated_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        CONSTRAINT platform_pricing_singleton CHECK (id = 1)
      );
    `);
    console.log('✅ tabla platform_pricing');

    // Sembrar la fila única (no pisa si ya existe)
    await db.query(
      `INSERT INTO platform_pricing (id, default_price_per_line, default_price_per_user, default_setup_fee, message_packs, unlimited_monthly_price)
       VALUES (1, 25, 15, 149, $1::jsonb, 0)
       ON CONFLICT (id) DO NOTHING`,
      [DEFAULT_PACKS]
    );
    console.log('✅ fila base sembrada (25 / 15 / 149 + packs 1k/5k/10k)');

    // Flag de masivos ilimitados por tenant
    await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS messages_unlimited BOOLEAN NOT NULL DEFAULT FALSE;`);
    console.log('✅ tenants.messages_unlimited (default FALSE)');

    console.log('✔ migrate-platform-pricing-v0979 OK');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-platform-pricing-v0979:', err);
    process.exit(1);
  }
})();
