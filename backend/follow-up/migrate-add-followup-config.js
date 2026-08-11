/**
 * migrate-add-followup-config.js — Módulo Follow-up automático v1.0
 *
 * Agrega claves de configuración del follow-up al JSONB de bot_global_config.
 * Estructura final del JSONB:
 *
 *   {
 *     ...config existente...,
 *     "follow_up": {
 *       "enabled": true,
 *       "min_score": 70,
 *       "window_hours_min": 22,
 *       "window_hours_max": 23,
 *       "quiet_hours_start": "20:00",
 *       "quiet_hours_end": "09:00",
 *       "skip_weekends": true,
 *       "timezone": "America/La_Paz",
 *       "gemini_model": "gemini-2.5-flash"
 *     }
 *   }
 *
 * Solo agrega la sub-key "follow_up" si NO existe (idempotente).
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Agregando follow_up config a bot_global_config...');

    // Para cada tenant, mergear la nueva config si no la tiene aún
    const defaultFollowUp = {
      enabled: true,
      min_score: 70,
      window_hours_min: 22,
      window_hours_max: 23,
      quiet_hours_start: '20:00',
      quiet_hours_end: '09:00',
      skip_weekends: true,
      timezone: 'America/La_Paz',
      gemini_model: 'gemini-2.5-flash'
    };

    await db.query(`
      UPDATE bot_global_config
      SET config = jsonb_set(
        COALESCE(config, '{}'::jsonb),
        '{follow_up}',
        $1::jsonb,
        true
      )
      WHERE NOT (COALESCE(config, '{}'::jsonb) ? 'follow_up');
    `, [JSON.stringify(defaultFollowUp)]);

    const result = await db.query(`
      SELECT tenant_id, config->'follow_up' AS fu
      FROM bot_global_config
      WHERE config ? 'follow_up'
      ORDER BY tenant_id;
    `);

    console.log(`✅ Follow-up config aplicado a ${result.rows.length} tenant(s):`);
    result.rows.forEach(r => {
      console.log(`   tenant_id=${r.tenant_id}: ${JSON.stringify(r.fu)}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-add-followup-config:', err);
    process.exit(1);
  }
})();
