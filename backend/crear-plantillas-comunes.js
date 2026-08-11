/**
 * Crea el "Pack de ventas/CRM" de plantillas en una WABA vía Meta Graph API.
 * Idempotente: si una plantilla ya existe, Meta la rechaza y el script lo reporta como OK.
 *
 * Uso (pasás la WABA destino y un token con acceso a esa WABA):
 *   WABA_ID="994808429581710" TOKEN="EAAxxxxx" node crear-plantillas-comunes.js
 *
 * El token debe tener permiso whatsapp_business_management sobre esa WABA.
 * (Meta Business Settings → Usuarios del sistema → generar token, o el token
 *  del onboarding de esa cuenta.)
 *
 * Opcional: GRAPH_VERSION (default v21.0), LANG (default es).
 */
const axios = require('axios');

const WABA_ID = process.env.WABA_ID;
const TOKEN = process.env.TOKEN || process.env.ACCESS_TOKEN;
const GRAPH = process.env.GRAPH_VERSION || 'v21.0';
const LANG = process.env.LANG_CODE || 'es';
const BIZ = process.env.BIZ || 'SG Digital Solutions'; // nombre del negocio en los textos

if (!WABA_ID || !TOKEN) {
  console.error('❌ Faltan variables. Uso:\n   WABA_ID="<id>" TOKEN="<token>" node crear-plantillas-comunes.js');
  process.exit(1);
}

// ── Pack de ventas/CRM ──────────────────────────────────────────────
// MARKETING = promo/re-enganche · UTILITY = aviso/transaccional.
// {{1}}, {{2}}… son variables; Meta exige un ejemplo por cada una.
const TEMPLATES = [
  {
    name: 'reenganche_suave',
    category: 'MARKETING',
    body: `Hola {{1}} 👋 Te escribo de ${BIZ} para retomar nuestra conversación. ¿Seguís interesado en mejorar la gestión de tu negocio? Cuando quieras coordinamos una demo rápida.`,
    examples: ['María'],
  },
  {
    name: 'seguimiento_demo',
    category: 'MARKETING',
    body: 'Hola {{1}}, ¿pudiste ver la demo que te compartí? Me encantaría saber qué te pareció y resolver cualquier duda. ¿Avanzamos?',
    examples: ['María'],
  },
  {
    name: 'recordatorio_cita',
    category: 'UTILITY',
    body: 'Hola {{1}}, te recuerdo nuestra reunión agendada para el {{2}}. Si necesitás reprogramar, avisame con tiempo. ¡Te espero!',
    examples: ['María', 'martes 10 a las 15:00'],
  },
  {
    name: 'bienvenida',
    category: 'UTILITY',
    body: `¡Hola {{1}}! Gracias por escribir a ${BIZ}. En breve te atiende nuestro equipo. ¿En qué te podemos ayudar hoy?`,
    examples: ['María'],
  },
  {
    name: 'propuesta_enviada',
    category: 'UTILITY',
    body: 'Hola {{1}}, te acabo de enviar la propuesta que conversamos. Quedo atento a tus comentarios. ¿La pudiste revisar?',
    examples: ['María'],
  },
  {
    name: 'cierre_seguimiento',
    category: 'MARKETING',
    body: 'Hola {{1}}, no quiero insistir de más 🙂 Si por ahora no es el momento, sin problema. Cuando quieras retomar, escribime y seguimos. ¡Éxitos!',
    examples: ['María'],
  },
];

function buildComponents(t) {
  const comp = [{ type: 'BODY', text: t.body }];
  if (t.examples && t.examples.length) {
    comp[0].example = { body_text: [t.examples] };
  }
  return comp;
}

async function createOne(t) {
  const url = `https://graph.facebook.com/${GRAPH}/${WABA_ID}/message_templates`;
  try {
    const r = await axios.post(url, {
      name: t.name,
      language: LANG,
      category: t.category,
      components: buildComponents(t),
    }, { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, timeout: 20000 });
    console.log(`  ✅ ${t.name} (${t.category}) → enviada (id ${r.data?.id}, estado ${r.data?.status || 'PENDING'})`);
    return true;
  } catch (e) {
    const err = e.response?.data?.error || {};
    const msg = err.error_user_msg || err.message || e.message;
    if (/already exists|existe|duplicate/i.test(msg)) {
      console.log(`  ⏭  ${t.name} ya existía`);
      return true;
    }
    console.error(`  ❌ ${t.name}: ${msg}`);
    return false;
  }
}

async function main() {
  console.log(`📤 Creando ${TEMPLATES.length} plantillas en WABA ${WABA_ID} (idioma ${LANG})...`);
  let ok = 0;
  for (const t of TEMPLATES) { if (await createOne(t)) ok++; await new Promise(r => setTimeout(r, 600)); }
  console.log(`\n🎉 Listo — ${ok}/${TEMPLATES.length} procesadas. Meta revisa cada una (de minutos a horas).`);
  console.log('   Seguí el estado en WhatsApp Manager → Message templates, o en tu panel → 🧩 Plantillas.');
  process.exit(ok === TEMPLATES.length ? 0 : 1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
