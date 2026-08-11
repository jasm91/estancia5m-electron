/**
 * migrate-knowledge-base-v0928i.js — v0.9.302
 * Base de conocimiento (FAQ) por tenant, REUTILIZABLE en todos los modos de venta.
 * El bot responde estas preguntas frecuentes sin escalar a un humano; cada entrada puede
 * llevar apoyos visuales (imágenes/videos/links) en media JSONB [{type,url,label}].
 * Idempotente.
 */
const db = require('./db');

async function migrate() {
  console.log('🔧 v0.9.302 — knowledge_base (FAQ con medios, todos los modos)…');
  await db.query(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL,
      question   TEXT NOT NULL,
      answer     TEXT NOT NULL,
      media      JSONB,
      tags       TEXT,
      active     BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  // defensivo por si la tabla ya existía de una versión anterior
  await db.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS media JSONB;`);
  await db.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS tags TEXT;`);
  await db.query(`ALTER TABLE knowledge_base ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_kb_tenant_active ON knowledge_base (tenant_id) WHERE active;`);
  console.log('✅ knowledge_base lista (question, answer, media, tags, active, sort_order).');
  console.log('🎉 Migración v0.9.302 (knowledge_base) completa.');
  process.exit(0);
}
migrate().catch((e) => { console.error('❌ Error:', e.message); process.exit(1); });
