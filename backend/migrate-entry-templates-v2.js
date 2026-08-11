/**
 * migrate-entry-templates-v2.js — v0.7.11
 *
 * Los anuncios de Facebook cambiaron. Los disparadores actuales son:
 *   - "Quisiera mas informacion del software dental"  (~47% de leads post-deploy)
 *   - "Quisiera mas informacion del CRM"              (~35% de leads post-deploy)
 *
 * El template viejo ("Hola quisiera mas informacion del producto de gestion
 * de consultorios") ya NO matchea con los anuncios actuales. Estos seeds nuevos
 * detectan los patrones nuevos y dan contexto específico a Aitana.
 *
 * Idempotente: ON CONFLICT (name) DO NOTHING.
 * Si querés reemplazar el contexto de uno existente, podés correr:
 *   UPDATE bot_entry_templates SET entry_context = '...' WHERE name = 'fb_ad_dental_v2';
 */

const db = require('./db');

const TEMPLATE_DENTAL_V2 = `CONTEXTO DEL CANAL: Cliente viene de anuncio Facebook dirigido a clínicas/consultorios dentales.

ARRANQUE OPTIMIZADO:
- NO preguntes "¿qué tipo de consultorio?" — ya sabemos que es dental
- Saludá usando el nombre del cliente
- Asumí vertical = dental
- Pasá DIRECTO al SPIN de problema (no hagas SPIN abierto de Situación primero)

EJEMPLO de primer turno ideal:
"¡Hola {{nombre}}! Soy Aitana de SG Bolivia. Te ayudo con la información del sistema para consultorios dentales. Para mostrarte exactamente cómo te puede servir, ¿cuál es el principal dolor de cabeza que querés resolver hoy: agenda, historias clínicas, presupuestos, cobros, o algo más?"

REGLA DE FALLBACK: si el cliente corrige y dice que NO es dental (por ejemplo "no, es médico general"), seguí el flow normal de descubrimiento y considerá si su rubro está fuera de scope (handover inmediato).`;

const TEMPLATE_CRM_V2 = `CONTEXTO DEL CANAL: Cliente viene de anuncio Facebook que dice "CRM" sin especificar rubro.

PROBLEMA: el anuncio es AMBIGUO — el cliente puede ser de cualquier rubro (comercial, restaurante, lavadero, dental, club, o uno fuera de scope).

ARRANQUE OPTIMIZADO:
- NO hagas SPIN abierto "¿qué te gustaría mejorar?" porque sin saber el rubro las preguntas son genéricas y el cliente se desengancha
- La PRIMERA pregunta obligatoria es identificar la VERTICAL
- Saludá usando el nombre del cliente
- Listá las 5 verticales como opciones múltiples breves

EJEMPLO de primer turno ideal:
"¡Hola {{nombre}}! Soy Aitana de SG Bolivia. Para mostrarte el CRM que mejor te calza, ¿a qué se dedica tu negocio: comercio/tienda, restaurante, lavadero de autos, consultorio dental, club deportivo, u otro rubro?"

DESPUÉS DE CONOCER LA VERTICAL:
- Si entra en uno de los 5 verticales (comercial, restaurante, lavadero, dental, club): seguí con SPIN normal del problema
- Si NO es ninguno de los 5 (inmobiliaria, médico general, salones, escuelas, talleres, servicios profesionales, etc): escalá INMEDIATAMENTE con escalate_now: true y reason: "escalation_unknown_vertical". NO intentes calificar.

REGLA EXTRA: el anuncio "CRM" atrae mucha curiosidad de personas que vieron tu sistema Aitana y quieren UN BOT como Aitana para su negocio. Si el cliente dice "yo quiero un CRM con IA / un bot como vos / un agente que califique leads" o similar, esto es un caso especial: NO está en los 5 verticales estándar, escalá inmediatamente.`;

(async () => {
  try {
    console.log('▶ Asegurando templates v2 de anuncios Facebook actuales...');

    await db.query(
      `INSERT INTO bot_entry_templates (name, pattern, match_type, entry_context, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (name) DO NOTHING`,
      ['fb_ad_dental_v2', 'quisiera mas informacion del software dental', 'contains', TEMPLATE_DENTAL_V2]
    );

    await db.query(
      `INSERT INTO bot_entry_templates (name, pattern, match_type, entry_context, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (name) DO NOTHING`,
      ['fb_ad_crm_v2', 'quisiera mas informacion del crm', 'contains', TEMPLATE_CRM_V2]
    );

    console.log('✅ Templates v2 listos (fb_ad_dental_v2, fb_ad_crm_v2)');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-entry-templates-v2:', err);
    process.exit(1);
  }
})();
