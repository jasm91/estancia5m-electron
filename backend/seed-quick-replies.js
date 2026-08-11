/**
 * v0.9.20e — Siembra respuestas rápidas comunes (de la ORGANIZACIÓN) para un tenant.
 * Idempotente: no pisa las que ya existan con el mismo atajo.
 *
 * Uso:
 *   DATABASE_URL="..." node seed-quick-replies.js          # tenant 1
 *   DATABASE_URL="..." node seed-quick-replies.js 3        # otro tenant
 *
 * Son plantillas editables — José/el owner las ajusta desde el panel (⚡ Administrar).
 */
const db = require('./db');

const TENANT_ID = parseInt(process.argv[2]) || 1;

const REPLIES = [
  { shortcut: 'saludo', title: 'Saludo inicial',
    body: '¡Hola! 👋 Gracias por escribirnos. Soy parte del equipo de SG Ventas. ¿En qué te puedo ayudar hoy?' },
  { shortcut: 'demo', title: 'Agendar demo',
    body: '¡Genial! 🎯 Te dejo el link para que elijas el horario que mejor te quede. Son 30 minutos donde te muestro el sistema funcionando y resolvemos todas tus dudas: https://cal.com/sg-digital-solutions/demo-sg-sales' },
  { shortcut: 'precio', title: 'Consulta de precios',
    body: 'Con gusto te paso los planes. 💰 El precio depende del tamaño de tu operación y los módulos que necesites. ¿Querés que te arme una propuesta a medida? Contame un poco de tu negocio.' },
  { shortcut: 'info', title: 'Qué es / cómo funciona',
    body: 'Somos un asistente de ventas por WhatsApp con IA: atiende a tus clientes 24/7, califica leads y te avisa cuando hay uno caliente para que cierres vos. 🤖 ¿Te muestro cómo funcionaría en tu rubro?' },
  { shortcut: 'gracias', title: 'Cierre / agradecimiento',
    body: '¡Muchas gracias por tu tiempo! 🙌 Cualquier duda que te surja, escribime por acá. Quedo atento.' },
  { shortcut: 'seguimiento', title: 'Re-enganche suave',
    body: '¡Hola de nuevo! 😊 Te escribo para saber si pudiste revisar lo que te mandé. ¿Avanzamos con una demo rápida o preferís que te aclare algo primero?' },
  { shortcut: 'pago', title: 'Métodos de pago',
    body: 'Aceptamos transferencia bancaria, QR y tarjeta. 💳 Apenas confirmes el plan te paso los datos para la activación. ¿Con cuál te queda más cómodo?' },
  { shortcut: 'horario', title: 'Horario de atención',
    body: 'Nuestro equipo está disponible de lunes a viernes de 8:30 a 18:30. 🕐 Igual el bot atiende a tus clientes las 24 horas, todos los días.' },
  { shortcut: 'espera', title: 'Pedir un momento',
    body: 'Dame un momentito que reviso esto y te respondo enseguida. 🙏' },
  { shortcut: 'contacto', title: 'Dejar contacto',
    body: '¿Me pasás tu nombre y el rubro de tu negocio? Así te preparo una propuesta concreta y te contacto con todo listo. 📋' },
];

async function seed() {
  console.log(`🌱 Sembrando respuestas rápidas comunes para tenant ${TENANT_ID}...`);
  let created = 0, skipped = 0;
  for (const r of REPLIES) {
    try {
      const exists = await db.query(
        'SELECT 1 FROM quick_replies WHERE tenant_id = $1 AND owner_user_id IS NULL AND LOWER(shortcut) = LOWER($2)',
        [TENANT_ID, r.shortcut]
      );
      if (exists.rows.length > 0) { skipped++; console.log(`  ⏭  /${r.shortcut} ya existe`); continue; }
      await db.query(
        `INSERT INTO quick_replies (tenant_id, shortcut, title, body, owner_user_id, active)
         VALUES ($1, $2, $3, $4, NULL, TRUE)`,
        [TENANT_ID, r.shortcut, r.title, r.body]
      );
      created++; console.log(`  ✅ /${r.shortcut}`);
    } catch (e) {
      if (/quick_replies/.test(e.message) && /does not exist/.test(e.message)) {
        console.error('❌ Falta la migración v0.9.15 (tabla quick_replies). Corré los deploys primero.');
        process.exit(1);
      }
      console.error(`  ⚠️  /${r.shortcut}: ${e.message}`);
    }
  }
  console.log(`🎉 Listo — ${created} creadas, ${skipped} ya existían.`);
  process.exit(0);
}

seed().catch((e) => { console.error('❌', e.message); process.exit(1); });
