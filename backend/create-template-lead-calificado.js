/**
 * v0.9.19 — Crea y submitea a Meta la plantilla `nuevo_lead_calificado`
 * (UTILITY, español, 3 variables: nombre, score, teléfono).
 *
 * La usan las alertas de handoff cuando el número de alertas está fuera
 * de la ventana de 24h. Idempotente: si ya existe, Meta devuelve error de
 * duplicado y lo reportamos como OK.
 *
 * Uso (con las creds del WABA en env):
 *   META_WABA_ID=... META_ACCESS_TOKEN=... node create-template-lead-calificado.js
 */
const meta = require('./meta');

const TEMPLATE = {
  name: 'nuevo_lead_calificado',
  category: 'UTILITY',
  language: 'es',
  components: [
    {
      type: 'BODY',
      text: '🚨 Nuevo lead calificado en tu negocio:\n\nCliente: {{1}}\nScore: {{2}}/100\nWhatsApp: {{3}}\n\nEntrá a tu panel para atenderlo.',
      example: { body_text: [['María Pérez', '85', '59170000000']] },
    },
  ],
};

async function main() {
  const wabaId = process.env.META_WABA_ID;
  const token = process.env.META_ACCESS_TOKEN;
  if (!wabaId || !token) {
    console.error('❌ Faltan META_WABA_ID / META_ACCESS_TOKEN en el entorno');
    process.exit(1);
  }
  console.log(`🔧 Creando plantilla "${TEMPLATE.name}" en WABA ${wabaId}...`);
  const r = await meta.createMessageTemplate(wabaId, token, TEMPLATE);
  if (r.success) {
    console.log(`🎉 Plantilla enviada a aprobación de Meta (id=${r.id}, status=${r.status}). Suele tardar de minutos a horas.`);
    process.exit(0);
  }
  if (/already exists|ya existe|duplicate/i.test(String(r.error || ''))) {
    console.log('✅ La plantilla ya existía — nada que hacer.');
    process.exit(0);
  }
  console.error('❌ Meta rechazó la creación:', r.error);
  process.exit(1);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
