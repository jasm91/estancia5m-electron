/**
 * migrate-inmuebles-prompt-patch-v0981.js — v0.9.81
 *
 * El prompt de cada modo vive en `tenant_mode_prompts` (copia por tenant,
 * sembrada del default en el onboarding). Editar default-mode-prompts.js solo
 * afecta a tenants NUEVOS, no a los existentes.
 *
 * Esta migración propaga a los tenants EXISTENTES el cambio de "cierre más
 * agresivo ante interés en una publicación específica" (sección 5 + ejemplos),
 * aplicando los MISMOS reemplazos quirúrgicos sobre el contenido guardado.
 *
 * SEGURO + IDEMPOTENTE: solo toca filas del modo 'inmuebles' que todavía
 * contienen el texto viejo. Si el dueño personalizó su prompt (o ya se aplicó
 * el parche), el texto viejo no está → la fila se deja intacta.
 */

const db = require('./db');

// --- Parche 1: sección "5) CERRAR EN VISITA" ---
const OLD_5 = `5) CERRAR EN VISITA
- Apenas detectes interés real ("me gusta", "¿se puede ver?", pide la dirección): cierre por doble alternativa: "¿Te queda mejor entre semana o el fin de semana?" — nunca "¿querés visitarla?"
- Marcá calificado true + reason "qualified_lead" para que un asesor coordine.
- Si duda, bajá la vara: "Sin compromiso: en 20 minutos la ves y salís de la duda".`;

const NEW_5 = `5) CERRAR EN VISITA
- Apenas detectes interés real ("me gusta", "¿se puede ver?", pide la dirección): cierre por doble alternativa: "¿Te queda mejor entre semana o el fin de semana?" — nunca "¿querés visitarla?"
- 🔥 INTERÉS EN UNA PUBLICACIÓN ESPECÍFICA = CERRÁ FUERTE, sin más vueltas. Si el cliente nombra un inmueble puntual, pide verlo, te da un día/hora, o pregunta dirección/precio/condiciones de pago: DEJÁ de descubrir (basta de preguntas SPIN) y andá directo a cerrar la visita.
  · Si YA te dio día y hora ("quiero verlo mañana a las 10"): NO preguntes "¿querés agendar?" — tomalo como cerrado y confirmá asumiendo: "¡Listo, {nombre}! Te agendo mañana 10:00 para ver el {inmueble} 🔑 Confirmá tu cupo acá en 30 segundos y queda reservado: {link}".
  · Si mostró interés fuerte pero sin día/hora: doble alternativa CON urgencia honesta: "Esta zona se mueve rápido. ¿Te coordino la visita entre semana o el finde?".
  · Siempre empujá a COMPLETAR ahora, nunca a "avisame cuando agendes": "Agendá ahí y te queda el cupo asegurado — ¿lo hacés ahora así te lo confirmo?".
- Marcá calificado true + reason "qualified_lead" para que un asesor coordine.
- Si duda, bajá la vara: "Sin compromiso: en 20 minutos la ves y salís de la duda".`;

// --- Parche 2: ejemplo de "¿cómo agendo?" + ejemplo nuevo de día/hora ---
const OLD_EX = `- Ya le mostraste el depto y ahora pregunta "¿cómo agendo?" / "¿me pasás el link?" → SOLO texto con el siguiente paso (día de visita o link de agenda). property_to_send: null — no le repitas la ficha que ya tiene.`;

const NEW_EX = `- Ya le mostraste el depto y ahora pregunta "¿cómo agendo?" / "¿me pasás el link?" → cierre ASUMIDO + link como confirmación rápida, sin pedir permiso: "¡Perfecto! Te agendo para el {inmueble}. Confirmá acá en 30 seg y queda 🔑: {link}". property_to_send: null — no le repitas la ficha que ya tiene. calificado true, score 90+.
- "Quiero verlo mañana a las 10" (te dio día Y hora) → NO mandes un link genérico con "avisame cuando lo hayas agendado". Cerrá asumiendo el turno: "¡Listo, Juan! Te agendo mañana 10:00 para el Dúplex Rafaella 🔑 Confirmá tu cupo acá en 30 seg y queda reservado: {link}". property_to_send: null. calificado true, score 95+, reason "qualified_lead".`;

(async () => {
  try {
    console.log("▶ Parche de prompt 'inmuebles' en tenant_mode_prompts...");
    const rows = await db.query(`SELECT tenant_id, content FROM tenant_mode_prompts WHERE mode = 'inmuebles'`);
    let touched = 0, alreadyOk = 0, notMatched = 0;
    for (const r of rows.rows) {
      const c = r.content || '';
      let nc = c;
      if (nc.includes(OLD_5)) nc = nc.replace(OLD_5, NEW_5);
      if (nc.includes(OLD_EX)) nc = nc.replace(OLD_EX, NEW_EX);
      if (nc === c) {
        if (c.includes('INTERÉS EN UNA PUBLICACIÓN ESPECÍFICA')) alreadyOk++;
        else notMatched++;
        continue;
      }
      await db.query(`UPDATE tenant_mode_prompts SET content = $1 WHERE tenant_id = $2 AND mode = 'inmuebles'`, [nc, r.tenant_id]);
      touched++;
      console.log(`   ✅ tenant ${r.tenant_id}: prompt inmuebles actualizado.`);
    }
    console.log(`✅ Listo. Actualizados: ${touched} · ya tenían el parche: ${alreadyOk} · sin coincidencia (prompt personalizado o versión vieja, se dejó intacto): ${notMatched}`);
    if (notMatched > 0) {
      console.log("   ⚠️  Esos tenants con prompt personalizado/versión vieja no se tocaron. Si querés el cierre agresivo en ellos, reaplicá el prompt desde el panel (⚙️ Config → Modo de venta → 📝 Prompt).");
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-inmuebles-prompt-patch-v0981:', err);
    process.exit(1);
  }
})();
