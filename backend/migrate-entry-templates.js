/**
 * migrate-entry-templates.js — v0.7.8
 *
 * P1 — Detección de canal de entrada
 *
 * Crea tabla `bot_entry_templates` (key-value) que mapea patrones del
 * primer mensaje del cliente a "contexto de entrada" que se inyecta en
 * el prompt de Aitana para que arranque más informada.
 *
 * También agrega columna `entry_context TEXT` a `conversations` para
 * persistir qué template matcheó (si alguno), una vez detectado.
 *
 * Default seed: el template más común visto en producción (anuncios
 * Facebook/Instagram con CTA "Send message" pre-rellenado para
 * consultorios). El usuario puede agregar más templates desde el panel.
 */

const db = require('./db');

(async () => {
  try {
    console.log('▶ Creando bot_entry_templates...');
    await db.query(`
      CREATE TABLE IF NOT EXISTS bot_entry_templates (
        id           SERIAL PRIMARY KEY,
        name         VARCHAR(80) NOT NULL UNIQUE,
        pattern      TEXT NOT NULL,
        match_type   VARCHAR(20) NOT NULL DEFAULT 'starts_with',
        entry_context TEXT NOT NULL,
        active       BOOLEAN NOT NULL DEFAULT TRUE,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // match_type permitidos: 'starts_with', 'exact', 'contains', 'regex'

    console.log('▶ Agregando columna entry_context a conversations...');
    await db.query(`
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_context TEXT;
    `);

    console.log('▶ Seedeando template default (anuncio FB consultorios)...');
    await db.query(`
      INSERT INTO bot_entry_templates (name, pattern, match_type, entry_context, active)
      VALUES (
        'fb_ad_consultorios_dental',
        'hola quisiera mas informacion del producto de gestion de consultorios',
        'starts_with',
        'CONTEXTO DEL CANAL: El cliente llega desde un anuncio de Facebook/Instagram dirigido a consultorios médicos. El anuncio prometió un sistema de gestión para consultorios. Por estadística histórica el 80% son consultorios dentales/odontológicos. ARRANQUE OPTIMIZADO: NO preguntes "¿qué tipo de consultorio?" — asumí dental por default, pasá directo al SPIN de problema. Ejemplo de primer turno: "¡Hola! Soy Aitana de SG Bolivia. Te ayudo con la información sobre nuestro sistema para consultorios dentales. Para entender bien qué necesitás, ¿cuál es el principal dolor de cabeza que querés resolver hoy: agenda, historias clínicas, presupuestos, o algo más?". Si el cliente corrige el rubro (no es dental), seguí el flow normal de descubrimiento.',
        TRUE
      )
      ON CONFLICT (name) DO NOTHING;
    `);

    console.log('✅ bot_entry_templates lista');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error en migrate-entry-templates:', err);
    process.exit(1);
  }
})();
