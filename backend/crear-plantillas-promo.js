/**
 * Pack de plantillas PROMOCIONALES para campañas outbound (módulo 📣 Campañas).
 * Crea las plantillas en la WABA vía Meta Graph API. Idempotente: si ya existe,
 * Meta la rechaza y el script lo reporta sin romper.
 *
 * ⚠️ ADECUÁ LOS TEXTOS antes de correrlo (BIZ y los cuerpos) — Meta aprueba
 * mejor textos concretos y con opción de baja ("Respondé BAJA...").
 *
 * Uso:
 *   WABA_ID="<id>" TOKEN="<token>" BIZ="Mi Negocio" node backend/crear-plantillas-promo.js
 *
 * Token con permiso whatsapp_business_management sobre esa WABA.
 * Opcional: GRAPH_VERSION (default v25.0), LANG_CODE (default es).
 */
const axios = require('axios');

const WABA_ID = process.env.WABA_ID;
const TOKEN = process.env.TOKEN || process.env.ACCESS_TOKEN;
const GRAPH = process.env.GRAPH_VERSION || 'v25.0';
const LANG = process.env.LANG_CODE || 'es';
const BIZ = process.env.BIZ || 'SG Digital Solutions';

if (!WABA_ID || !TOKEN) {
  console.error('❌ Faltan variables. Uso:\n   WABA_ID="<id>" TOKEN="<token>" BIZ="Mi Negocio" node backend/crear-plantillas-promo.js');
  process.exit(1);
}

// ── Pack promocional ────────────────────────────────────────────────
// Todas MARKETING (promo). {{1}}, {{2}}… variables; Meta exige ejemplo por cada una.
// La línea "Respondé BAJA…" alimenta el opt-out automático del CRM (v0.9.46).
const TEMPLATES = [
  {
    name: 'promo_descuento',
    category: 'MARKETING',
    body: `Hola {{1}} 👋 En ${BIZ} tenemos {{2}} de descuento en {{3}} hasta el {{4}}. ¿Querés que te reserve el tuyo? Respondé este mensaje y te paso todos los detalles.\n\nSi no querés recibir promos, respondé BAJA.`,
    examples: ['María', '20%', 'toda la colección de invierno', 'viernes 20'],
  },
  {
    name: 'nuevo_producto',
    category: 'MARKETING',
    body: `¡Hola {{1}}! Llegó algo nuevo a ${BIZ}: {{2}} 🎉 Pensamos en vos porque ya nos consultaste antes. ¿Te mando fotos y precios?\n\nPara no recibir novedades, respondé BAJA.`,
    examples: ['María', 'la nueva línea de zapatillas urbanas'],
  },
  {
    name: 'ultimas_unidades',
    category: 'MARKETING',
    body: `Hola {{1}}, te aviso que quedan POCAS unidades de {{2}} que habías consultado en ${BIZ}. Si lo querés, confirmame hoy y te lo guardo 🛒\n\nRespondé BAJA si no querés estos avisos.`,
    examples: ['María', 'el departamento de 2 dormitorios en Equipetrol'],
  },
  {
    name: 'reactivacion_oferta',
    category: 'MARKETING',
    body: `Hola {{1}} 👋 Hace tiempo no hablamos. En ${BIZ} tenemos una condición especial para vos este mes: {{2}}. ¿Retomamos la conversación?\n\nSi preferís no recibir más mensajes, respondé BAJA.`,
    examples: ['María', '10% extra y envío gratis en tu primera compra'],
  },
  {
    name: 'evento_invitacion',
    category: 'MARKETING',
    body: `¡Hola {{1}}! Te invitamos a {{2}} el {{3}} en {{4}}. Cupos limitados — confirmá tu lugar respondiendo este mensaje 🎟️\n\nRespondé BAJA para no recibir invitaciones.`,
    examples: ['María', 'la inauguración de nuestro showroom', 'sábado 21 a las 19:00', 'Av. San Martín 1234, Santa Cruz'],
  },
  {
    name: 'postventa_beneficio',
    category: 'MARKETING',
    body: `Hola {{1}}, ¡gracias por tu compra en ${BIZ}! Por ser cliente, tenés {{2}} en tu próxima compra durante {{3}}. ¿Te interesa? 😊\n\nRespondé BAJA si no querés recibir beneficios.`,
    examples: ['María', '15% de descuento', 'todo junio'],
  },
];

async function createTemplate(t) {
  const url = `https://graph.facebook.com/${GRAPH}/${WABA_ID}/message_templates`;
  const payload = {
    name: t.name,
    language: LANG,
    category: t.category,
    components: [
      {
        type: 'BODY',
        text: t.body,
        ...(t.examples && t.examples.length ? { example: { body_text: [t.examples] } } : {}),
      },
    ],
  };
  try {
    const r = await axios.post(url, payload, { headers: { Authorization: `Bearer ${TOKEN}` } });
    console.log(`✅ ${t.name} → creada (id ${r.data.id}, estado ${r.data.status || 'PENDING'})`);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    if (/already exists|ya existe/i.test(msg)) console.log(`☑️  ${t.name} → ya existía, OK`);
    else console.error(`❌ ${t.name} → ${msg}`);
  }
}

(async () => {
  console.log(`📣 Creando ${TEMPLATES.length} plantillas promocionales en WABA ${WABA_ID} (${LANG})...`);
  for (const t of TEMPLATES) await createTemplate(t);
  console.log('\n🎉 Listo. Meta tarda minutos u horas en aprobarlas (estado en ⚙️ Config → 🧩 Plantillas → 🔄 Refrescar).');
  console.log('   Una vez APROBADAS aparecen en 📣 Campañas → + Nueva campaña.');
})();
