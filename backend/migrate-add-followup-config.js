/**
 * migrate-add-followup-config.js — v0.7.22 Follow-up automático
 *
 * Inserta 1 row en bot_global_config con config_key='follow_up_config'
 * y config_value como JSON serializado con los settings default.
 *
 * El panel lee/escribe este JSON entero. Es atómico: 1 UPDATE actualiza
 * todos los settings juntos.
 *
 * IDEMPOTENTE: ON CONFLICT (tenant_id, config_key) DO NOTHING.
 * Si ya existe, no se sobreescribe (preserva cambios manuales hechos en panel).
 */

const db = require('./db');

// v0.9.154 — Follow-ups multi-etapa por CRON backend (sin n8n).
//   · stages: secuencia configurable (offset_minutes + mode 'ai'|'template').
//     Dentro de 24h del último mensaje del cliente → mode 'ai' (texto generado
//     por Gemini con contexto). Pasadas las 24h → mode 'template' obligatorio
//     (lo exige Meta). template_name=null en una etapa de plantilla → se salta.
//   · ai_prompt: prompt CONFIGURABLE para el mensaje IA (editable desde el panel).
// Se reemplazó window_hours_min/max (legacy del worker n8n single-touch) por stages.
const DEFAULT_CONFIG = {
  enabled: false,                    // master switch (OFF por default — vos lo activás cuando estés listo)
  min_score: 70,                     // score mínimo para perseguir lead
  stages: [
    { offset_minutes: 15,   mode: 'ai' },
    { offset_minutes: 60,   mode: 'ai' },
    { offset_minutes: 240,  mode: 'ai' },
    { offset_minutes: 1440, mode: 'template', template_name: null, language: 'es' },
  ],
  ai_prompt: `Sos Aitana, la asistente de ventas del negocio por WhatsApp. Escribí UN mensaje de seguimiento para un cliente que mostró interés y dejó de responder. Tenés el contexto de la conversación abajo.

Reglas:
- Español boliviano, cálido y cercano, de tú/vos según cómo venía la charla. NADA de sonar a robot ni a plantilla.
- MUY breve (1 a 3 frases, como un WhatsApp real). Sin saludos largos ni firmas.
- Retomá lo ÚLTIMO que se habló o lo que el cliente estaba mirando/preguntando (producto, inmueble, servicio, precio, lo que aplique). Personalizá con su nombre si lo tenés.
- Invitá suavemente a retomar: una pregunta corta, ofrecer ayuda concreta, o proponer agendar/coordinar. Sin presión ni urgencia falsa.
- No inventes datos, precios ni promociones que no estén en el contexto. No repitas textual lo que ya dijiste antes.
- Devolvé SOLO el texto del mensaje, sin comillas, sin explicaciones, sin emojis excesivos (como mucho uno).`,
  quiet_hours_start: '20:00',        // No molestar desde
  quiet_hours_end: '09:00',          // No molestar hasta
  skip_weekends: true,               // Saltear sáb/dom
  timezone: 'America/La_Paz',
  gemini_model: 'gemini-2.5-flash',
};

(async () => {
  try {
    console.log('▶ Insertando follow_up_config en bot_global_config...');

    const result = await db.query(`
      INSERT INTO bot_global_config (config_key, config_value, description, data_type, tenant_id)
      VALUES ($1, $2, $3, 'json', 1)
      ON CONFLICT (tenant_id, config_key) DO NOTHING
      RETURNING config_key
    `, [
      'follow_up_config',
      JSON.stringify(DEFAULT_CONFIG),
      'Configuración del módulo Follow-up automático (JSON serializado)',
    ]);

    if (result.rows.length > 0) {
      console.log('✅ follow_up_config insertado con defaults (enabled=FALSE)');
      console.log('   Para activarlo: desde el panel → tab Follow-ups → toggle ON');
    } else {
      console.log('⏭ follow_up_config ya existe, no se sobreescribe');
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-add-followup-config:', err);
    process.exit(1);
  }
})();
