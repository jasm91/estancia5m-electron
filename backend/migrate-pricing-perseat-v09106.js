/**
 * migrate-pricing-perseat-v09106.js — v0.9.106
 * ---------------------------------------------------------------------------
 * Cambia el modelo de cobro de "planes por tier" a COBRO POR LÍNEA + POR
 * USUARIO (en Bs), con los mensajes salientes ILIMITADOS y cobrados a mes
 * vencido (metered, tarifa global Bs/mensaje).
 *
 * Qué hace (todo idempotente):
 *   1. platform_pricing.default_price_per_message  → tarifa Bs por mensaje
 *      saliente (NUMERIC, default 1.50).
 *   2. Setea los precios base GLOBALES al nuevo modelo:
 *        línea = 290 · usuario = 120 · setup = 490 · mensaje = 1.50 Bs
 *      (limpia message_packs → ya no hay packs prepago).
 *   3. Pone a TODOS los tenants en el modelo:
 *        price_per_line = 290 · price_per_user = 120 · setup_fee = 490
 *        messages_unlimited = TRUE
 *   4. Cambia el DEFAULT de tenants.messages_unlimited a TRUE, para que los
 *      tenants nuevos (onboarding) nazcan con mensajes ilimitados sin tocar
 *      el INSERT de onboarding.
 *
 * IMPORTANTE: correr ESTA migración ANTES de deployar el código nuevo
 * (admin-billing-routes-v0925.js lee default_price_per_message).
 *
 * Uso (con la DB pública de Railway):
 *   DATABASE_URL="$DATABASE_PUBLIC_URL" node migrate-pricing-perseat-v09106.js
 * ---------------------------------------------------------------------------
 */
const db = require('./db');

(async () => {
  try {
    console.log('▶ migrate-pricing-perseat-v09106 — modelo per-seat + mensajes metered');

    // 1) Tarifa por mensaje saliente en platform_pricing
    await db.query(`
      ALTER TABLE platform_pricing
        ADD COLUMN IF NOT EXISTS default_price_per_message NUMERIC(10,2) NOT NULL DEFAULT 1.50;
    `);
    console.log('  ✓ platform_pricing.default_price_per_message (default 1.50)');

    // 2) Precios base globales al nuevo modelo (upsert id = 1)
    await db.query(`
      INSERT INTO platform_pricing
        (id, default_price_per_line, default_price_per_user, default_setup_fee,
         default_price_per_message, message_packs, unlimited_monthly_price, updated_at)
      VALUES (1, 290, 120, 490, 1.50, '[]'::jsonb, 0, NOW())
      ON CONFLICT (id) DO UPDATE SET
        default_price_per_line    = 290,
        default_price_per_user    = 120,
        default_setup_fee         = 490,
        default_price_per_message = 1.50,
        message_packs             = '[]'::jsonb,
        updated_at                = NOW();
    `);
    console.log('  ✓ precios base globales = 290 / 120 / 490 Bs · mensaje 1.50 Bs · sin packs');

    // 3) Todos los tenants existentes al modelo per-seat + mensajes ilimitados
    const up = await db.query(`
      UPDATE tenants
         SET price_per_line     = 290,
             price_per_user     = 120,
             setup_fee          = 490,
             messages_unlimited = TRUE;
    `);
    console.log(`  ✓ ${up.rowCount} tenants → 290 / 120 / 490 Bs + mensajes ilimitados`);

    // 4) Nuevos tenants nacen con mensajes ilimitados (default de la columna)
    await db.query(`
      ALTER TABLE tenants
        ALTER COLUMN messages_unlimited SET DEFAULT TRUE;
    `);
    console.log('  ✓ tenants.messages_unlimited default → TRUE (para onboarding)');

    console.log('✔ migrate-pricing-perseat-v09106 OK');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-pricing-perseat-v09106:', err);
    process.exit(1);
  }
})();
