/**
 * migrate-price-range-keys.js — v0.7.8
 *
 * Agrega keys min_plan_bs y max_plan_bs a bot_global_config.
 * Las usa el prompt v3 para responder rápido cuando el cliente
 * está impaciente por el precio (regla de impaciencia P3).
 *
 * Idempotente: ON CONFLICT DO NOTHING.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Asegurando keys min_plan_bs y max_plan_bs...');

    await db.query(
      `INSERT INTO bot_global_config (config_key, config_value, description, data_type)
       SELECT $1::text, $2::text, $3::text, 'number'
       WHERE NOT EXISTS (SELECT 1 FROM bot_global_config WHERE config_key = $1::text)`,
      ['min_plan_bs', '250', 'Precio mensual del plan más barato. Usado por Aitana para dar rango cuando el cliente pregunta precio sin haber calificado.']
    );

    await db.query(
      `INSERT INTO bot_global_config (config_key, config_value, description, data_type)
       SELECT $1::text, $2::text, $3::text, 'number'
       WHERE NOT EXISTS (SELECT 1 FROM bot_global_config WHERE config_key = $1::text)`,
      ['max_plan_bs', '700', 'Precio mensual del plan más caro. Usado por Aitana para dar rango.']
    );

    console.log('✅ Keys de rango de precio listas');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-price-range-keys:', err);
    process.exit(1);
  }
})();
