/**
 * migrate-all.js
 *
 * Runner secuencial de todas las migraciones del backend.
 * Se ejecuta automáticamente en cada deploy de Railway (start script).
 *
 * Fases:
 *   FASE 1 — Migraciones legacy (crean tablas base)
 *   FASE 2 — Multi-tenant base Sprint 1 (tenants + tenant_id en tablas existentes)
 *   FASE 3 — Follow-up automático (follow_up_log + config)
 *   FASE 4 — Sprint 2 Step 2: UNIQUE compuesto en conversations
 *
 * Cada migración debe ser IDEMPOTENTE (chequear "ya existe" antes de aplicar).
 */

require('dotenv').config();
const path = require('path');
const { spawn } = require('child_process');

function runScript(scriptPath) {
  return new Promise((resolve, reject) => {
    console.log('\n========================================');
    console.log(`▶ Ejecutando: ${path.basename(scriptPath)}`);
    console.log('========================================');

    const child = spawn('node', [scriptPath], {
      stdio: 'inherit',
      env: process.env,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Script ${scriptPath} exited with code ${code}`));
      }
    });

    child.on('error', reject);
  });
}

(async () => {
  try {
    // === FASE 1: Migraciones legacy ===
    console.log('\n📦 FASE 1: Migraciones base (legacy)');
    await runScript(path.join(__dirname, 'migrate.js'));
    await runScript(path.join(__dirname, 'migrate-bot-config.js'));
    await runScript(path.join(__dirname, 'migrate-push-subs.js'));
    await runScript(path.join(__dirname, 'migrate-conversation-notes.js'));
    await runScript(path.join(__dirname, 'migrate-demo-credentials.js'));
    await runScript(path.join(__dirname, 'migrate-prompt-base-v2.js'));
    await runScript(path.join(__dirname, 'migrate-entry-templates.js'));
    await runScript(path.join(__dirname, 'migrate-price-range-keys.js'));
    await runScript(path.join(__dirname, 'migrate-prompt-base-v3.js'));
    await runScript(path.join(__dirname, 'migrate-entry-templates-v2.js'));
    await runScript(path.join(__dirname, 'migrate-prompt-base-v4.js'));
    await runScript(path.join(__dirname, 'migrate-prompt-base-v5.js'));

    // === FASE 2: Multi-tenant Sprint 1 (v0.8.0) ===
    console.log('\n🏢 FASE 2: Multi-tenant base (Sprint 1)');
    await runScript(path.join(__dirname, 'migrate-tenants.js'));
    await runScript(path.join(__dirname, 'migrate-tenant-requests.js'));
    await runScript(path.join(__dirname, 'migrate-audit-logs.js'));
    await runScript(path.join(__dirname, 'migrate-backup-snapshots.js'));
    await runScript(path.join(__dirname, 'migrate-support-tickets.js'));
    await runScript(path.join(__dirname, 'migrate-seed-default-tenant.js'));
    await runScript(path.join(__dirname, 'migrate-add-tenant-id-to-existing.js'));

    // === FASE 3: Follow-up automático (v0.7.22) ===
    console.log('\n📤 FASE 3: Módulo Follow-up automático');
    await runScript(path.join(__dirname, 'migrate-follow-up-log.js'));
    await runScript(path.join(__dirname, 'migrate-add-followup-config.js'));

    // === FASE 4: Sprint 2 Step 2 — UNIQUE compuesto en conversations ===
    // Cambia UNIQUE (phone) → UNIQUE (tenant_id, phone) para permitir
    // que distintos tenants tengan conversaciones con el mismo numero.
    // Necesario antes de que webhook.js intente ON CONFLICT (tenant_id, phone).
    console.log('\n🔄 FASE 4: Sprint 2 Step 2 — UNIQUE compuesto conversations');
    await runScript(path.join(__dirname, 'migrate-conversations-tenant-phone-unique.js'));

    // === FASE 5: Sprint 2 Fase A — Columnas Embedded Signup ===
    // Agrega columnas a tenants para soportar Meta Embedded Signup multi-cliente:
    // meta_access_token, expires_at, business_portfolio_id, solution_id, etc.
    // Cero riesgo: todas nullable.
    console.log('\n🔌 FASE 5: Sprint 2 Fase A — Columnas Embedded Signup');
    await runScript(path.join(__dirname, 'migrate-tenants-embedded-signup.js'));

    // === FASE 6: Mesa de Soporte (BPO) — v0.9.113 ===
    // Desambigua la colisión de support_tickets y crea el esqueleto de la mesa.
    // ORDEN OBLIGATORIO: el rename va PRIMERO (libera el nombre support_tickets y
    // sus índices/secuencia/PK globales); recién después se crea la tabla de BPO.
    console.log('\n🎧 FASE 6: Mesa de Soporte (BPO) v0.9.113');
    await runScript(path.join(__dirname, 'migrate-support-rename-v09113.js'));
    await runScript(path.join(__dirname, 'migrate-support-bpo-v09113b.js'));

    // === FASE 7: Funnel del Embedded Signup + metadata de leads + análisis ===
    // onboarding_funnel (+ ip/geo/etc, v0.9.125) y lost_opportunity_analysis
    // (#2 oportunidades perdidas, v0.9.126). Idempotente; corre tras tenants+conversations.
    console.log('\n📊 FASE 7: Funnel de onboarding + metadata de leads + análisis IA');
    await runScript(path.join(__dirname, 'migrate-onboarding-funnel-v09111.js'));

    // === FASE 8: Canal Telegram (tenant_channels.webhook_secret) ===
    console.log('\n💬 FASE 8: Canal Telegram');
    await runScript(path.join(__dirname, 'migrate-telegram-v0928.js'));
    await runScript(path.join(__dirname, 'migrate-telegram-business-v0928b.js')); // v0.9.282
    await runScript(path.join(__dirname, 'migrate-comments-inbox-v0928c.js')); // v0.9.283
    await runScript(path.join(__dirname, 'migrate-channel-prompts-v0928d.js')); // v0.9.284
    await runScript(path.join(__dirname, 'migrate-agent-channel-scope-v0928e.js')); // v0.9.285
    await runScript(path.join(__dirname, 'migrate-ai-scope-v0928f.js')); // v0.9.285
    await runScript(path.join(__dirname, 'migrate-lead-search-profile-v0928g.js')); // v0.9.299
    await runScript(path.join(__dirname, 'migrate-tenant-ui-overrides-v0928h.js')); // v0.9.300
    await runScript(path.join(__dirname, 'migrate-knowledge-base-v0928i.js')); // v0.9.302
    await runScript(path.join(__dirname, 'migrate-lead-nurture-v0928j.js')); // v0.9.304
    await runScript(path.join(__dirname, 'migrate-conv-search-profile-v0928k.js')); // v0.9.305
    await runScript(path.join(__dirname, 'migrate-ticket-idle-resolve-v0928l.js')); // v0.9.313
    await runScript(path.join(__dirname, 'migrate-vip-contacts-v0928m.js')); // v0.9.316
    await runScript(path.join(__dirname, 'migrate-webhook-queue-v0928n.js')); // v0.9.326
    await runScript(path.join(__dirname, 'migrate-password-resets-v0928o.js')); // v0.9.327
    await runScript(path.join(__dirname, 'migrate-wa-catalog-v0928p.js')); // v0.9.328
    await runScript(path.join(__dirname, 'migrate-csat-survey-v0928q.js')); // v0.9.331
    await runScript(path.join(__dirname, 'migrate-clean-properties-v0938.js')); // v0.9.338
    await runScript(path.join(__dirname, 'migrate-conv-topics-v0945.js')); // v0.9.345
    await runScript(path.join(__dirname, 'migrate-clean-prop-price-lines-v0946.js')); // v0.9.346
    await runScript(path.join(__dirname, 'migrate-straight-line-v0947.js')); // v0.9.369 Straight Line
    await runScript(path.join(__dirname, 'migrate-humanize-typing-v0948.js')); // v0.9.372 typing humanizado
    await runScript(path.join(__dirname, 'migrate-c21-agents-v09384.js')); // v0.9.384 asesor asignado C21 + directorio
    await runScript(path.join(__dirname, 'migrate-voice-notes-v09391.js')); // v0.9.391 notas de voz: voz por línea + config
    await runScript(path.join(__dirname, 'migrate-voice-billing-v09392.js')); // v0.9.392 billing ElevenLabs: tarifa + voice_usage
    await runScript(path.join(__dirname, 'migrate-bot-buttons-v09397.js')); // v0.9.397 master switch de botones interactivos
    await runScript(path.join(__dirname, 'migrate-vehicle-fields-v09400.js')); // v0.9.400 campos de vehículo en inventory_items (Concesionaria)

    console.log('\n🎉 Todas las migraciones completadas exitosamente\n');
    console.log('   Verificación recomendada:');
    console.log('   - SELECT COUNT(*) FROM tenants;  // debe ser 1');
    console.log('   - SELECT COUNT(*) FROM conversations WHERE tenant_id IS NULL;  // debe ser 0');
    console.log('   - SELECT config_value FROM bot_global_config WHERE config_key = \'follow_up_config\';  // debe existir');
    console.log('   - SELECT indexname FROM pg_indexes WHERE tablename = \'conversations\' AND indexname LIKE \'%tenant_phone%\';');
    console.log('     // debe mostrar conversations_tenant_phone_line_key (unicidad POR LÍNEA, v0.9.470+)');

    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error en migraciones:', err.message);
    process.exit(1);
  }
})();
