/**
 * migrate-demo-credentials.js
 *
 * Inserta la key 'demo_credentials_block' en bot_global_config con un valor
 * por defecto editable desde la consola Configuración → General.
 *
 * Esta key la usan los assets tipo "link" (v0.7.4): cuando se envía un asset
 * link, después del caption y la URL se manda este bloque como tercer mensaje.
 *
 * Idempotente: ON CONFLICT DO NOTHING para no pisar valores ya editados.
 */

const db = require('./db');

const DEFAULT_VALUE = `🔑 *Credenciales de prueba*

Usuario: demo
Contraseña: demo2026

Podés explorar todo el sistema sin compromiso. Cuando quieras tu propio ambiente, avisame y te lo creo.`;

(async () => {
  try {
    console.log('▶ Asegurando key demo_credentials_block en bot_global_config...');

    // v0.9.191b: sin ON CONFLICT (config_key) — ese unique single-tenant se elimina en la
    // migración multi-tenant. WHERE NOT EXISTS (casteado) no depende de ninguna constraint.
    await db.query(
      `INSERT INTO bot_global_config (config_key, config_value, description, data_type)
       SELECT $1::text, $2::text, $3::text, 'string'
       WHERE NOT EXISTS (SELECT 1 FROM bot_global_config WHERE config_key = $1::text)`,
      [
        'demo_credentials_block',
        DEFAULT_VALUE,
        'Bloque de credenciales que se envía como tercer mensaje cuando un asset tipo "link" se manda al cliente. Editable desde la consola.',
      ]
    );

    console.log('✅ demo_credentials_block lista (insert si no existía)');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-demo-credentials:', err);
    process.exit(1);
  }
})();
