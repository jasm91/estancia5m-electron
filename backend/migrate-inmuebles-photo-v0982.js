/**
 * migrate-inmuebles-photo-v0982.js — v0.9.82
 *
 * Propaga a los tenants EXISTENTES (cuyo prompt vive en tenant_mode_prompts) el
 * cambio de "no mandar todas las fotos de golpe": la ficha manda la foto
 * PRINCIPAL y Aitana ofrece ver un ambiente puntual / el brochure / todas las
 * fotos (photo_label "todas").
 *
 * Parchea secciones DISTINTAS a las del cierre (migrate-inmuebles-prompt-patch),
 * así que ambas migraciones componen en cualquier orden.
 *
 * SEGURO + IDEMPOTENTE: cada parche solo se aplica si el texto viejo está
 * presente. Si el prompt fue personalizado (o ya se aplicó), se deja intacto.
 */

const db = require('./db');

const PATCHES = [
  // P1 — sección "3) PRESENTAR": ficha = foto principal + ofrecer
  {
    old: `- Cuando tengas operación + zona o presupuesto, mostrá LA mejor opción con property_to_send (esto manda la ficha con foto — UNA sola vez). UNA propiedad por mensaje; mencioná que hay más opciones similares.`,
    neu: `- Cuando tengas operación + zona o presupuesto, mostrá LA mejor opción con property_to_send (esto manda la ficha con la foto PRINCIPAL — UNA sola vez). UNA propiedad por mensaje; mencioná que hay más opciones similares.
- Después de mandar la ficha, OFRECÉ ver más sin saturar (NO mandes todas las fotos de una): "¿Querés que te muestre algún ambiente puntual (sala, cocina, baño…), el brochure completo, o todas las fotos?".`,
  },
  // P2a — sección "📤 ENVÍO": ficha manda solo la principal
  {
    old: `- property_to_send a secas manda la FICHA COMPLETA (foto + datos + precio). Va UNA vez: el mensaje en que presentás ese inmueble. Después NO la repitas.`,
    neu: `- property_to_send a secas manda la FICHA con la foto PRINCIPAL + datos + precio (ya NO manda todas las fotos de golpe). Va UNA vez: el mensaje en que presentás ese inmueble. Después NO la repitas.`,
  },
  // P2b — sección "📤 ENVÍO": agregar regla de "todas las fotos"
  {
    old: `- Foto de un ambiente: property_to_send: <id> + photo_label: "<ambiente>" → va SOLO esa foto, no la ficha.`,
    neu: `- Foto de un ambiente: property_to_send: <id> + photo_label: "<ambiente>" → va SOLO esa foto, no la ficha.
- TODAS las fotos (a pedido): property_to_send: <id> + photo_label: "todas" → manda el set completo. Solo si el cliente lo pide ("quiero ver todas", "mostrame todas las fotos"), NUNCA por iniciativa.`,
  },
  // P3 — EJEMPLOS: agregar ejemplo de "todas"
  {
    old: `- "muéstrame el baño" → property_to_send: <id> + photo_label "baño" (manda SOLO esa foto, no la ficha; si no está en su lista photos, ofrecé los ambientes que sí hay).`,
    neu: `- "muéstrame el baño" → property_to_send: <id> + photo_label "baño" (manda SOLO esa foto, no la ficha; si no está en su lista photos, ofrecé los ambientes que sí hay).
- "quiero ver todas las fotos" / "mostrame todas" → property_to_send: <id> + photo_label "todas" (manda el set completo). Si pide un ambiente puntual, photo_label "<ambiente>"; si pide el brochure y existe, send_docs true.`,
  },
];

(async () => {
  try {
    console.log("▶ Parche de fotos (flujo no-saturar) en prompts 'inmuebles'...");
    const rows = await db.query(`SELECT tenant_id, content FROM tenant_mode_prompts WHERE mode = 'inmuebles'`);
    let touched = 0, alreadyOk = 0, notMatched = 0;
    for (const r of rows.rows) {
      const c = r.content || '';
      let nc = c;
      for (const p of PATCHES) {
        // guard doble: aplica solo si el texto viejo está y el nuevo todavía NO
        // (los parches aditivos contienen el viejo como prefijo → sin esto se duplicarían)
        if (!nc.includes(p.neu) && nc.includes(p.old)) nc = nc.replace(p.old, p.neu);
      }
      if (nc === c) {
        if (c.includes('OFRECÉ ver más sin saturar')) alreadyOk++;
        else notMatched++;
        continue;
      }
      await db.query(`UPDATE tenant_mode_prompts SET content = $1 WHERE tenant_id = $2 AND mode = 'inmuebles'`, [nc, r.tenant_id]);
      touched++;
      console.log(`   ✅ tenant ${r.tenant_id}: prompt inmuebles (fotos) actualizado.`);
    }
    console.log(`✅ Listo. Actualizados: ${touched} · ya tenían el parche: ${alreadyOk} · sin coincidencia (personalizado/versión vieja, intacto): ${notMatched}`);
    if (notMatched > 0) {
      console.log("   ⚠️  Tenants con prompt personalizado no tocados. Reaplicá desde el panel (⚙️ Config → Modo de venta → 📝 Prompt) si querés el flujo nuevo de fotos.");
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-inmuebles-photo-v0982:', err);
    process.exit(1);
  }
})();
