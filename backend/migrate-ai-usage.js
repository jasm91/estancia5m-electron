/**
 * Migración v0.9.8 — Tabla ai_usage
 *
 * Registra el consumo de tokens de la IA (Gemini) por tenant, para poder
 * cobrar a fin de mes según uso real.
 *
 * Cada fila = una llamada a la IA (una respuesta generada).
 * n8n reporta acá el usageMetadata de Gemini después de cada respuesta.
 *
 * Uso:
 *   DATABASE_URL="..." node migrate-ai-usage.js
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 Creando tabla ai_usage...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS ai_usage (
      id              BIGSERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL,
      conversation_id INTEGER,             -- opcional, si n8n lo manda
      phone           TEXT,                -- opcional, número del cliente
      model           TEXT,                -- ej "gemini-2.5-flash"
      prompt_tokens   INTEGER NOT NULL DEFAULT 0,   -- tokens de entrada (promptTokenCount)
      output_tokens   INTEGER NOT NULL DEFAULT 0,   -- tokens de salida (candidatesTokenCount)
      total_tokens    INTEGER NOT NULL DEFAULT 0,   -- totalTokenCount
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Índice para las consultas del panel: por tenant y por fecha (filtro mensual)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_ai_usage_tenant_date
    ON ai_usage (tenant_id, created_at);
  `);

  console.log('✅ Tabla ai_usage creada (con índice tenant + fecha).');
  process.exit(0);
}

migrate().catch((e) => {
  console.error('❌ Error en migración:', e.message);
  process.exit(1);
});
