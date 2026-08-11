// v0.9.111 — funnel del Embedded Signup de FB (lanzó → eligió WABA → terminó).
// v0.9.189 (20-jun-2026) — + fix bot_global_config: soltar PK legacy (config_key)
//   y garantizar UNIQUE (tenant_id, config_key) → arregla el 500 al guardar la
//   config de follow-up en tenants ≠ 1 ("duplicate key ... bot_global_config_pkey").
// v0.9.191 (20-jun-2026) — el bloque ahora suelta CUALQUIER unique/índice sobre
//   config_key solo (incluido el del hotfix de emergencia) y garantiza el compuesto
//   PRIMERO. Va de la mano con migrate-bot-config.js v0.9.191 (su seed dejó de usar
//   ON CONFLICT (config_key), que era lo que crasheaba el deploy en loop).
const db = require('./db');
async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS onboarding_funnel (
      session_id TEXT PRIMARY KEY,
      stage TEXT NOT NULL DEFAULT 'launched',
      waba_id TEXT,
      phone_number_id TEXT,
      business_name TEXT,
      phone_display TEXT,
      coexistence BOOLEAN DEFAULT FALSE,
      launched_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_funnel_updated ON onboarding_funnel (updated_at DESC)`);
  // v0.9.125 — metadata para identificar/contactar leads que quedan a medio camino.
  // Aditivas e idempotentes (corre en cada deploy vía migrate-all).
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS ip          TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS user_agent  TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS referrer    TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS lang        TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS landing_url TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS geo_country TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS geo_city    TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS geo_region  TEXT`);
  await db.query(`ALTER TABLE onboarding_funnel ADD COLUMN IF NOT EXISTS geo_isp     TEXT`);
  console.log('✅ onboarding_funnel lista (+ metadata de leads v0.9.125)');

  // v0.9.126 — Feature #2: análisis IA de OPORTUNIDADES PERDIDAS.
  // (Se crea acá, una migración ya incluida en migrate-all que corre DESPUÉS de
  //  tenants y conversations, para no agregar un archivo nuevo de migración.)
  await db.query(`
    CREATE TABLE IF NOT EXISTS lost_opportunity_analysis (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sale_mode       TEXT,
      reason_category TEXT NOT NULL,
      breakpoint      TEXT,
      lost_signal     TEXT,
      aitana_could    TEXT,
      recoverable     BOOLEAN DEFAULT FALSE,
      reengage_msg    TEXT,
      confidence      INTEGER DEFAULT 0,
      model           TEXT,
      analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (conversation_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_loa_tenant ON lost_opportunity_analysis (tenant_id, analyzed_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_loa_reason ON lost_opportunity_analysis (tenant_id, reason_category)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_loa_mode   ON lost_opportunity_analysis (tenant_id, sale_mode)`);
  await db.query(`ALTER TABLE lost_opportunity_analysis ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ`); // v0.9.147: descartar leads que no valen la pena
  console.log('✅ lost_opportunity_analysis lista (#2 oportunidades perdidas)');

  // v0.9.128 — Feature #3: bitácora de AUTO-MEJORA de prompts por modo.
  await db.query(`
    CREATE TABLE IF NOT EXISTS prompt_autotune_log (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      sale_mode       TEXT NOT NULL,
      dominant_reason TEXT,
      status          TEXT NOT NULL DEFAULT 'applied',
      what_changed    TEXT,
      why             TEXT,
      expected_result TEXT,
      prompt_before   TEXT,
      prompt_after    TEXT,
      losses_n        INTEGER,
      model           TEXT,
      applied_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reverted_at     TIMESTAMPTZ
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pat_tenant ON prompt_autotune_log (tenant_id, applied_at DESC)`);
  console.log('✅ prompt_autotune_log lista (#3 auto-mejora de prompts)');

  // v0.9.130 — Feature #1: OMNICANAL (Instagram + Messenger). Aditivo: el camino
  // de WhatsApp queda intacto (channel default 'whatsapp', channel_user_id NULL).
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp'`);
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_user_id TEXT`);
  // phone deja de ser obligatorio: IG/Messenger no tienen teléfono (usan channel_user_id).
  // (Relaja, no rompe: las filas de WhatsApp existentes ya tienen phone seteado.)
  await db.query(`ALTER TABLE conversations ALTER COLUMN phone DROP NOT NULL`);
  // unicidad por canal SOLO para IG/Messenger (índice parcial). No toca el UNIQUE (tenant_id, phone) de WhatsApp.
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_channel_user ON conversations (tenant_id, channel, channel_user_id) WHERE channel_user_id IS NOT NULL`);

  // v0.9.251 — CHAT PRIORITARIO (fijado): al TOMAR una cita, la conversación queda
  // "fijada" arriba del inbox del asesor hasta que la oportunidad se marque ganada/
  // perdida (ahí pasa a archivada y se despinea). prioritized_at NULL = no fijada.
  await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS prioritized_at TIMESTAMPTZ`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_conversations_prioritized ON conversations (tenant_id, prioritized_at DESC) WHERE prioritized_at IS NOT NULL`);

  // v0.9.258 — PROMPT POR LÍNEA + VISIBILIDAD DE INMUEBLES POR LÍNEA (aditivo, retrocompatible).
  // tenant_mode_prompts.line_id: NULL = Default del tenant (lo que heredan todas las líneas); =X = override de la línea X.
  await db.query(`ALTER TABLE tenant_mode_prompts ADD COLUMN IF NOT EXISTS line_id INTEGER REFERENCES tenant_lines(id) ON DELETE CASCADE`).catch(e => { if (!/already exists|does not exist/i.test(e.message)) throw e; });
  // La PK era (tenant_id, mode); la reemplazamos por un único por (tenant, mode, línea) tratando NULL como 0.
  await db.query(`ALTER TABLE tenant_mode_prompts DROP CONSTRAINT IF EXISTS tenant_mode_prompts_pkey`).catch(() => {});
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tmp_tenant_mode_line ON tenant_mode_prompts (tenant_id, mode, COALESCE(line_id, 0))`);
  // Historial por línea (NULL = historial del Default).
  await db.query(`ALTER TABLE tenant_prompt_history ADD COLUMN IF NOT EXISTS line_id INTEGER`).catch(() => {});
  // Visibilidad de inmuebles por línea: NULL/vacío = TODAS las líneas; con ids = solo esas.
  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS visible_lines INTEGER[]`).catch(() => {});
  console.log('✅ v0.9.258: line_id en prompts/historial + visible_lines en properties');

  // v0.9.268 — DEUDA ACUMULADA: meses SALDADOS. Un período (tenant_id, period) marcado acá deja
  // de contar en la deuda acumulada (cierre del mes "sin pago"). Aditivo, idempotente.
  await db.query(`CREATE TABLE IF NOT EXISTS billing_settlements (
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER NOT NULL,
    period      TEXT NOT NULL,
    settled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    note        TEXT
  )`).catch(e => { if (!/already exists/i.test(e.message)) throw e; });
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_billing_settlements ON billing_settlements (tenant_id, period)`).catch(() => {});
  console.log('✅ v0.9.268: billing_settlements (meses saldados)');
  // conexión de página por tenant (FB Page / IG) + token cifrado
  await db.query(`
    CREATE TABLE IF NOT EXISTS tenant_channels (
      id             SERIAL PRIMARY KEY,
      tenant_id      INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel        TEXT NOT NULL,            -- instagram | messenger
      page_id        TEXT NOT NULL,            -- FB Page id
      ig_id          TEXT,                     -- Instagram business id (si IG)
      page_name      TEXT,
      page_token_enc TEXT NOT NULL,            -- page access token (cifrado)
      active         BOOLEAN NOT NULL DEFAULT TRUE,
      connected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (channel, page_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_channels_tenant ON tenant_channels (tenant_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_channels_page ON tenant_channels (page_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_channels_ig ON tenant_channels (ig_id) WHERE ig_id IS NOT NULL`);

  // v0.9.142 — Comentarios (FB feed + IG comments). Monitoreo + pase a DM.
  await db.query(`
    CREATE TABLE IF NOT EXISTS channel_comments (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      channel         TEXT NOT NULL,            -- instagram | facebook
      page_id         TEXT,                     -- página/cuenta dueña
      comment_id      TEXT NOT NULL,            -- id del comentario en Meta
      parent_id       TEXT,                     -- comentario padre (si es respuesta)
      post_id         TEXT,                     -- post / media comentado
      from_id         TEXT,                     -- id del que comentó (PSID/IGSID)
      from_name       TEXT,
      text            TEXT,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE SET NULL, -- si pasó a DM
      status          TEXT NOT NULL DEFAULT 'new', -- new | replied | dm_sent | ignored
      replied_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (comment_id)
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_comments_tenant ON channel_comments (tenant_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_channel_comments_status ON channel_comments (tenant_id, status)`);

  console.log('✅ omnicanal: conversations.channel + tenant_channels + channel_comments');

  // v0.9.151 — Nuevo modelo de BILLING: FIJO (Bs) + CONSUMO (USD).
  // (Va acá, en una migración que YA corre en cada release vía migrate-all,
  //  para no agregar un archivo nuevo de migración. 100% idempotente.)
  //
  //   FIJO (Bs)   = líneas×price_per_line + usuarios_excedentes×price_per_user
  //                 + canales_adicionales×price_per_channel
  //   CONSUMO(USD)= tokens (ai_usage, tarifa Gemini × markup)
  //                 + mensajes salientes (count × meta_cost_per_msg × markup)
  //
  // 1) platform_pricing: tarifas nuevas (canal en Bs + tarifas de consumo en USD).
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS default_price_per_channel NUMERIC(10,2)`);
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS gemini_in_usd_per_m       NUMERIC(12,4)`);
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS gemini_out_usd_per_m      NUMERIC(12,4)`);
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS meta_cost_per_msg_usd     NUMERIC(12,4)`);
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS consumption_markup        NUMERIC(6,3)`);

  // Asegurar que exista la fila única id=1 (no pisa si ya está).
  await db.query(`INSERT INTO platform_pricing (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // Defaults idempotentes: solo setean cuando la columna está NULL (recién agregada).
  // No pisan un valor ya configurado por el super-admin.
  await db.query(`UPDATE platform_pricing SET default_price_per_channel = 290  WHERE id = 1 AND default_price_per_channel IS NULL`);
  await db.query(`UPDATE platform_pricing SET gemini_in_usd_per_m       = 0.30 WHERE id = 1 AND gemini_in_usd_per_m       IS NULL`);
  await db.query(`UPDATE platform_pricing SET gemini_out_usd_per_m      = 2.50 WHERE id = 1 AND gemini_out_usd_per_m      IS NULL`);
  await db.query(`UPDATE platform_pricing SET meta_cost_per_msg_usd     = 0.05 WHERE id = 1 AND meta_cost_per_msg_usd     IS NULL`);
  await db.query(`UPDATE platform_pricing SET consumption_markup        = 1.20 WHERE id = 1 AND consumption_markup        IS NULL`);

  // 2) Por tenant: canal de comentarios (cobra como canal adicional) + override
  //    opcional del precio por canal (NULL → usa el default global de plataforma).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS comments_enabled BOOLEAN NOT NULL DEFAULT FALSE`);
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS price_per_channel NUMERIC(10,2)`); // NULL → COALESCE al default global

  console.log('✅ billing v0.9.151: platform_pricing (+canal Bs +tarifas USD +markup) + tenants.comments_enabled/price_per_channel');

  // v0.9.154 — Follow-ups multi-etapa por CRON backend (sin n8n).
  // Cada etapa de la secuencia se identifica con un stage_index (0,1,2,...)
  // contra el array `stages` del follow_up_config. El cron antiduplica
  // por (conversation_id, stage_index) para no mandar la misma etapa 2 veces.
  // Aditivo e idempotente (corre en cada deploy vía migrate-all, en FASE 7,
  // DESPUÉS de que migrate-follow-up-log.js (FASE 3) crea la tabla).
  await db.query(`ALTER TABLE follow_up_log ADD COLUMN IF NOT EXISTS stage_index INTEGER`);
  // v0.9.195 FIX: el INSERT de _logFollowUp usa la columna `phone`, que la tabla original
  // (v0.7.22) NO tenía → el INSERT reventaba ("column phone does not exist"), la etapa
  // NO se registraba y el candado anti-duplicado (stage ya enviada) quedaba vacío → el cron
  // re-mandaba la etapa 0 en CADA corrida (cada 5 min) en vez de escalonar. Self-heal:
  await db.query(`ALTER TABLE follow_up_log ADD COLUMN IF NOT EXISTS phone TEXT`);
  // Índice para el chequeo anti-dup del cron (conv + etapa ya enviada/programada).
  await db.query(`CREATE INDEX IF NOT EXISTS idx_fu_conv_stage ON follow_up_log (conversation_id, stage_index) WHERE stage_index IS NOT NULL`);
  console.log('✅ follow_up_log.stage_index + phone (v0.9.154/195 follow-ups multi-etapa por CRON)');

  // v0.9.155 — MASTER SWITCH de IA (owner-only). Interruptor global por tenant que
  // activa/desactiva TODAS las respuestas de Aitana. Con ai_enabled=FALSE el webhook
  // sigue guardando los mensajes entrantes pero NO dispatcha al bot (los humanos
  // responden igual desde el panel). Aditivo e idempotente. Default TRUE (no cambia
  // el comportamiento de tenants existentes).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT TRUE`);
  console.log('✅ tenants.ai_enabled (v0.9.155 master switch de IA)');

  // v0.9.160 — TICKETS DE PLATAFORMA: los clientes (tenants) reportan bugs/problemas
  // del programa a SG Ventas; se atienden en cola desde el panel super-admin y se
  // analizan con IA. SEPARADO de support_tickets (que es el BPO de cada tenant).
  // ROBUSTO: si la tabla YA existe de una versión anterior con otro esquema, el
  // CREATE no la toca, así que aseguramos CADA columna con ADD COLUMN IF NOT EXISTS
  // (nullable; las validaciones de NOT NULL viven en la API). Idempotente.
  await db.query(`CREATE TABLE IF NOT EXISTS platform_bug_reports (id SERIAL PRIMARY KEY)`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS tenant_id           INTEGER`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS reporter_user_id    INTEGER`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS reporter_name       TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS reporter_email      TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS title               TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS description         TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS area                TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS screenshot_url      TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS status              TEXT DEFAULT 'abierto'`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS priority            TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS ai_category         TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS ai_severity         TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS ai_summary          TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS ai_suggested_action TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS ai_analyzed_at      TIMESTAMPTZ`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS admin_reply         TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS admin_notes         TEXT`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ DEFAULT NOW()`);
  await db.query(`ALTER TABLE platform_bug_reports ADD COLUMN IF NOT EXISTS updated_at          TIMESTAMPTZ DEFAULT NOW()`);
  await db.query(`UPDATE platform_bug_reports SET status = 'abierto' WHERE status IS NULL`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_platform_bug_reports_status ON platform_bug_reports (status, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_platform_bug_reports_tenant ON platform_bug_reports (tenant_id, created_at DESC)`);
  console.log('✅ platform_bug_reports (v0.9.160 tickets de soporte; columnas aseguradas vía ADD COLUMN IF NOT EXISTS)');

  // v0.9.163 — Cal.com POR USUARIO: cada vendedor conecta su propia cuenta (ve su
  // calendario y tiene su propio link de agendado). La key va cifrada (AES-GCM).
  // Las columnas de tenant (tenants.cal_api_key / calcom_event_url) quedan como
  // FALLBACK. Aditivo e idempotente.
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS cal_api_key TEXT`);
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS calcom_event_url TEXT`);
  console.log('✅ tenant_users.cal_api_key + calcom_event_url (v0.9.163 Cal por usuario)');

  // v0.9.165 — AGENDADOR PROPIO (reemplaza Cal): disponibilidad + link de agenda por
  // vendedor; las citas van a la tabla `appointments` con provider 'inhouse'. El
  // booking_token se genera en la app (no pgcrypto). Aditivo e idempotente.
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS booking_token   TEXT`);
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS booking_enabled BOOLEAN DEFAULT FALSE`);
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS avail_days      TEXT DEFAULT '1,2,3,4,5'`); // 1=lun … 7=dom
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS avail_start     TEXT DEFAULT '09:00'`);
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS avail_end       TEXT DEFAULT '18:00'`);
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS slot_minutes    INTEGER DEFAULT 30`);
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS tz_offset_min   INTEGER DEFAULT -240`); // America/La_Paz (UTC-4, sin DST)
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS booking_contact_phone TEXT`); // v0.9.173: tel que Aitana le da al cliente al confirmar la cita
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_users_booking_token ON tenant_users (booking_token) WHERE booking_token IS NOT NULL`);
  await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS user_id INTEGER`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_appointments_user ON appointments (user_id, starts_at)`);
  console.log('✅ agendador propio (v0.9.165): tenant_users.avail_* + booking_token + appointments.user_id');

  // v0.9.166 — Agendador: PAUSA DIARIA (break) + BLOQUEOS puntuales (ausencias/vacaciones).
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS break_start TEXT`); // 'HH:MM' o NULL
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS break_end   TEXT`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_time_blocks (
      id         SERIAL PRIMARY KEY,
      tenant_id  INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      starts_at  TIMESTAMPTZ NOT NULL,
      ends_at    TIMESTAMPTZ NOT NULL,
      reason     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_user_time_blocks_user ON user_time_blocks (user_id, starts_at)`);
  console.log('✅ agendador v0.9.166: pausa diaria (break_*) + user_time_blocks');

  // v0.9.167 — recordatorios de citas: marca cuándo se envió el aviso (NULL = no enviado).
  await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`);
  console.log('✅ appointments.reminder_sent_at (v0.9.167 recordatorios de cita)');

  // v0.9.175 — POOL de citas por tomar: Aitana crea citas con status 'pending' (user_id NULL);
  // un asesor la "toma" (o el dueño la asigna) → user_id + status 'scheduled' + claimed_at.
  await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_appointments_pending ON appointments (tenant_id) WHERE status = 'pending'`);
  console.log('✅ appointments.claimed_at + índice pending (v0.9.175 pool de citas)');

  // v0.9.177 — CITA EDITABLE: imágenes de la visita + historial de notas. El estado
  // 'completed' (Realizada) es solo un valor más de la columna status (varchar), sin schema.
  await db.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS images JSONB DEFAULT '[]'::jsonb`);
  await db.query(`CREATE TABLE IF NOT EXISTS appointment_notes (
    id SERIAL PRIMARY KEY,
    tenant_id INTEGER NOT NULL DEFAULT 1,
    appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
    user_id INTEGER,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_appointment_notes_appt ON appointment_notes (appointment_id, created_at)`);
  console.log('✅ appointments.images + appointment_notes (v0.9.177 cita editable)');

  // v0.9.180 — AUDITORÍA: log automático de acciones (quién hizo qué, en qué tenant).
  await db.query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id   INTEGER,
    user_id     INTEGER,
    user_name   TEXT,
    method      TEXT,
    path        TEXT,
    resource    TEXT,
    action      TEXT,
    summary     TEXT,
    status_code INTEGER,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`);
  // v0.9.186: self-heal si audit_logs YA existía con otro esquema → evita "column a.user_id does not exist".
  for (const [c, t] of [['tenant_id', 'INTEGER'], ['user_id', 'INTEGER'], ['user_name', 'TEXT'], ['method', 'TEXT'], ['path', 'TEXT'], ['resource', 'TEXT'], ['action', 'TEXT'], ['summary', 'TEXT'], ['status_code', 'INTEGER'], ['created_at', 'TIMESTAMPTZ DEFAULT NOW()']]) {
    await db.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ${c} ${t}`).catch(() => {});
  }
  // v0.9.192: la tabla audit_logs ORIGINAL (migrate-audit-logs.js v0.8.0) tenía columnas
  // legacy NOT NULL (actor_type, action) que el middleware nuevo NO llena → el INSERT
  // reventaba en silencio (.catch) y la auditoría quedaba SIEMPRE vacía. Soltamos esos
  // NOT NULL para que el log automático pueda escribir. Idempotente.
  for (const c of ['actor_type', 'action', 'result', 'actor_id', 'entity']) {
    await db.query(`ALTER TABLE audit_logs ALTER COLUMN ${c} DROP NOT NULL`).catch(() => {});
  }
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs (tenant_id, created_at DESC)`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs (created_at DESC)`);
  console.log('✅ audit_logs (v0.9.180 auditoría automática)');

  // v0.9.181 — SNAPSHOTS: respaldos por tenant (JSON gzip guardado en la DB, privado — NO R2 público).
  await db.query(`CREATE TABLE IF NOT EXISTS db_snapshots (
    id BIGSERIAL PRIMARY KEY,
    tenant_id    INTEGER NOT NULL,
    trigger      TEXT DEFAULT 'manual',
    note         TEXT,
    data_gz      BYTEA,
    size_bytes   INTEGER,
    tables_count INTEGER,
    rows_count   INTEGER,
    created_by   TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
  )`);
  // v0.9.186: self-heal db_snapshots si ya existía con otro esquema.
  for (const [c, t] of [['tenant_id', 'INTEGER'], ['trigger', 'TEXT'], ['note', 'TEXT'], ['data_gz', 'BYTEA'], ['size_bytes', 'INTEGER'], ['tables_count', 'INTEGER'], ['rows_count', 'INTEGER'], ['created_by', 'TEXT'], ['created_at', 'TIMESTAMPTZ DEFAULT NOW()']]) {
    await db.query(`ALTER TABLE db_snapshots ADD COLUMN IF NOT EXISTS ${c} ${t}`).catch(() => {});
  }
  await db.query(`CREATE INDEX IF NOT EXISTS idx_db_snapshots_tenant ON db_snapshots (tenant_id, created_at DESC)`);
  // v0.9.219 — cuántos snapshots guardar por tenant (retención configurable; default 6).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS snapshot_retention INT NOT NULL DEFAULT 6`).catch(() => {});
  console.log('✅ db_snapshots (v0.9.181 respaldos por tenant) + snapshot_retention (v0.9.219)');

  // v0.9.189/191 — bot_global_config MULTI-TENANT. La tabla venía single-tenant con la
  // unicidad sobre `config_key` SOLO → guardar config (p.ej. follow_up) en un tenant ≠1
  // tiraba 500 "duplicate key ... bot_global_config_pkey". Pasamos la unicidad a
  // (tenant_id, config_key) y soltamos CUALQUIER PK/unique/índice sobre config_key solo
  // (incluido el índice que recreó el hotfix de emergencia v0.9.189b).
  // SEGURO desde v0.9.191: migrate-bot-config.js ya NO hace ON CONFLICT (config_key)
  // (ahora usa WHERE NOT EXISTS), así que nada depende del unique viejo. Idempotente.
  // ORDEN: primero garantizamos el compuesto, recién después soltamos el de config_key.
  await db.query(`DO $mt$
  DECLARE
    r record;
  BEGIN
    IF to_regclass('public.bot_global_config') IS NULL THEN
      RETURN;  -- otra migración crea la tabla; si aún no existe, nada que hacer
    END IF;

    -- 1) columna tenant_id (defensivo) + backfill de NULL → 1
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema='public' AND table_name='bot_global_config'
                     AND column_name='tenant_id') THEN
      ALTER TABLE bot_global_config ADD COLUMN tenant_id INTEGER;
    END IF;
    UPDATE bot_global_config SET tenant_id = 1 WHERE tenant_id IS NULL;

    -- 2) garantizar el UNIQUE (tenant_id, config_key) ANTES de soltar nada (lo usa el upsert)
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='bot_global_config' AND c.contype IN ('u','p')
        AND (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid=t.oid AND a.attnum=ANY(c.conkey)) = 'config_key,tenant_id'
    ) AND NOT EXISTS (
      SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='bot_global_config'
        AND indexdef ILIKE '%UNIQUE%(tenant_id, config_key)%'
    ) THEN
      CREATE UNIQUE INDEX bot_global_config_tenant_config_key_uq
        ON bot_global_config (tenant_id, config_key);
      RAISE NOTICE 'bot_global_config: UNIQUE (tenant_id, config_key) creado';
    END IF;

    -- 3) soltar CUALQUIER PK/UNIQUE (constraint) cuyas columnas sean SOLO config_key
    FOR r IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='bot_global_config' AND c.contype IN ('p','u')
        AND (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a
             WHERE a.attrelid=t.oid AND a.attnum=ANY(c.conkey)) = 'config_key'
    LOOP
      EXECUTE 'ALTER TABLE bot_global_config DROP CONSTRAINT ' || quote_ident(r.conname);
      RAISE NOTICE 'bot_global_config: constraint legacy % (config_key) soltada', r.conname;
    END LOOP;

    -- 4) soltar índices únicos (no-constraint) sobre SOLO config_key (incluye el del hotfix)
    FOR r IN
      SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='bot_global_config'
        AND indexdef ILIKE '%UNIQUE%(config_key)%' AND indexdef NOT ILIKE '%tenant_id%'
    LOOP
      EXECUTE 'DROP INDEX IF EXISTS ' || quote_ident(r.indexname);
      RAISE NOTICE 'bot_global_config: índice único legacy % (config_key) soltado', r.indexname;
    END LOOP;
  END $mt$;`);
  console.log('✅ bot_global_config multi-tenant: unique compuesto + sin config_key-solo (v0.9.191)');

  // v0.9.168 — AGENDA ACTIVA POR DEFECTO para todos. Los NUEVOS usuarios arrancan con la
  // agenda activa; y se activa + se da token (1 sola vez) a los que nunca la configuraron.
  // Guardado por `booking_token IS NULL` → NO re-activa a quien la desactivó a mano (esos ya
  // tienen token). Token vía md5(random) para no depender de pgcrypto.
  await db.query(`ALTER TABLE tenant_users ALTER COLUMN booking_enabled SET DEFAULT TRUE`);
  await db.query(`UPDATE tenant_users SET booking_enabled = TRUE, booking_token = md5(random()::text || clock_timestamp()::text || id::text) WHERE booking_token IS NULL`);
  console.log('✅ agendas activas por defecto para todos (v0.9.168)');

  // v0.9.192 — NOTIFICACIONES configurables por rol. Una fila por tenant con un JSON
  // de preferencias: por evento (hot_lead, pending_appointment, appointment_assigned,
  // new_message_assigned) qué roles reciben el push y si va también por WhatsApp.
  // Tabla propia (NO bot_global_config) para no cruzarse con el lío de config_key.
  await db.query(`CREATE TABLE IF NOT EXISTS notification_prefs (
    tenant_id  INTEGER PRIMARY KEY,
    prefs      JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  console.log('✅ notification_prefs (v0.9.192 notificaciones por rol)');

  // v0.9.194 — PERMISOS POR USUARIO (override encima del rol). El permiso efectivo de un
  // usuario = override de usuario › override de rol (role_permissions) › default del rol.
  await db.query(`CREATE TABLE IF NOT EXISTS user_permissions (
    tenant_id  INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    permission TEXT NOT NULL,
    allowed    BOOLEAN NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (tenant_id, user_id, permission)
  )`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions (tenant_id, user_id)`);
  console.log('✅ user_permissions (v0.9.194 permisos por usuario)');

  // v0.9.199 — FIX de integridad: messages.tenant_id.
  // La columna se creó con DEFAULT 1 (migrate-add-tenant-id, Sprint 1) y los ~23 INSERT
  // de mensajes SALIENTES en api.js NO setean tenant_id → TODO lo saliente (respuestas del
  // bot, fichas, fotos, follow-ups) quedaba con tenant_id=1 sin importar el tenant real.
  // Consecuencias auditadas en Reportes: para tenants ≠1 el "tiempo de respuesta" salía null,
  // "top assets" vacío y "mensajes totales" subcontado; para el tenant 1 sobrecontado (recibía
  // los salientes de todos). También afectaba snapshots por tenant (perdían lo saliente).
  // Fuente de verdad = la conversación. Solución en 2 partes, idempotente:
  //   (1) backfill: corrige el histórico desde conversations (solo la 1ra vez, guardado por
  //       la existencia del trigger para no re-escanear messages en cada deploy).
  //   (2) trigger BEFORE INSERT: fuerza messages.tenant_id = el de su conversación en cada
  //       insert futuro → arregla los 23 inserts (y cualquier otro) sin tocar api.js.
  {
    const trgExists = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_message_tenant'`
    ).catch(() => ({ rows: [] }));
    if (!trgExists.rows.length) {
      const bf = await db.query(`
        UPDATE messages m SET tenant_id = c.tenant_id
        FROM conversations c
        WHERE c.id = m.conversation_id AND m.tenant_id IS DISTINCT FROM c.tenant_id
      `);
      console.log(`   ↻ backfill messages.tenant_id desde conversations: ${bf.rowCount} filas`);
    }
    await db.query(`
      CREATE OR REPLACE FUNCTION _sync_message_tenant() RETURNS trigger AS $fn$
      DECLARE v_ct INTEGER;
      BEGIN
        IF NEW.conversation_id IS NOT NULL THEN
          SELECT c.tenant_id INTO v_ct FROM conversations c WHERE c.id = NEW.conversation_id;
          IF v_ct IS NOT NULL AND v_ct IS DISTINCT FROM NEW.tenant_id THEN
            NEW.tenant_id := v_ct;
          END IF;
        END IF;
        RETURN NEW;
      END;
      $fn$ LANGUAGE plpgsql
    `);
    await db.query(`DROP TRIGGER IF EXISTS trg_sync_message_tenant ON messages`);
    await db.query(`
      CREATE TRIGGER trg_sync_message_tenant
      BEFORE INSERT ON messages
      FOR EACH ROW EXECUTE FUNCTION _sync_message_tenant()
    `);
    console.log('✅ messages.tenant_id corregido (backfill + trigger) (v0.9.199)');
  }

  // v0.9.208 — PAGOS QR + SALDO + ESTADO DE VENCIMIENTO (Fase 0). El tenant paga por QR y sube
  // el comprobante; Gemini lo lee y, si el score es alto + el nº de comprobante es ÚNICO +
  // cuenta/monto OK, se acredita solo (el resto va a revisión). NO se suspende: al vencer solo
  // se marca 'vencido' (banner al tenant + alerta roja en el super-admin). Pagar de más = saldo a favor.
  {
    // (a) estado de billing por tenant. OJO: NO creamos billing_status nuevo — ya existe
    // (migrate-tenants.js, default 'trial') con estados active/trial/past_due/suspended/cancelled
    // y el super-admin ya lo edita. Reusamos esos: 'active'=se cobra, 'past_due'=vencido (alerta+banner),
    // 'trial'/'suspended'/'cancelled'=sin cobro ni alertas. Solo agregamos vencimiento + saldo.
    await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_next_due_date DATE`);
    await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_balance_bs NUMERIC(12,2) NOT NULL DEFAULT 0`);

    // (b) datos de cobro de SG (cuenta + QR) + umbral de auto-aprobado, en platform_pricing (fila única)
    await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS collection_bank TEXT`);
    await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS collection_account TEXT`);
    await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS collection_holder TEXT`);
    await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS collection_qr_url TEXT`);
    await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS ocr_autoapprove_score NUMERIC(4,2) NOT NULL DEFAULT 0.90`);

    // (c) comprobantes subidos. nro_comprobante ÚNICO global (parcial, ignora NULL) = anti-reuso.
    await db.query(`CREATE TABLE IF NOT EXISTS tenant_payments (
      id              SERIAL PRIMARY KEY,
      tenant_id       INTEGER NOT NULL,
      source          TEXT NOT NULL DEFAULT 'ocr',     -- ocr | manual | bank_webhook
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
      image_url       TEXT,
      amount_bs       NUMERIC(12,2),
      nro_comprobante TEXT,
      extracted       JSONB,
      confidence      NUMERIC(4,2),
      reason          TEXT,
      reviewed_by     INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      applied_at      TIMESTAMPTZ
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_payments_tenant ON tenant_payments (tenant_id, created_at DESC)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_payments_compro ON tenant_payments (nro_comprobante) WHERE nro_comprobante IS NOT NULL`);

    // (d) ledger: cargos (mensualidad) y abonos (pagos). saldo = SUM(amount_bs): credit +, charge -.
    await db.query(`CREATE TABLE IF NOT EXISTS billing_ledger (
      id          SERIAL PRIMARY KEY,
      tenant_id   INTEGER NOT NULL,
      type        TEXT NOT NULL,                       -- charge | credit | adjust
      amount_bs   NUMERIC(12,2) NOT NULL,              -- credit positivo, charge negativo
      description TEXT,
      ref         TEXT,                                -- payment_id / periodo (YYYY-MM)
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_billing_ledger_tenant ON billing_ledger (tenant_id, created_at DESC)`);
    console.log('✅ pagos QR + saldo + ledger (v0.9.208 Fase 0)');
  }

  // v0.9.217 — "Ver" el comprobante desde el historial de pagos: billing_payments.receipt_url
  // (URL de la imagen que originó el pago). Backfill desde la nota "Comprobante #<id>".
  await db.query(`ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS receipt_url TEXT`).catch(() => {});
  await db.query(`
    UPDATE billing_payments bp SET receipt_url = tp.image_url
      FROM tenant_payments tp
     WHERE bp.receipt_url IS NULL AND bp.note ~ '^Comprobante #[0-9]+$'
       AND tp.id = (regexp_replace(bp.note, '\\D', '', 'g'))::int AND tp.image_url IS NOT NULL
  `).catch(() => {});
  console.log('✅ billing_payments.receipt_url + backfill (v0.9.217)');

  // v0.9.223 — usuarios NO facturables: el super-admin puede marcar usuarios (p.ej. los
  // usuarios de soporte que crea SG para revisar) para que NO cuenten en el cobro del tenant.
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS billing_excluded BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  console.log('✅ tenant_users.billing_excluded (v0.9.223 usuarios no facturables)');

  // v0.9.224 — rubro Concesionaria de Vehículos: flag de activación (reusa el motor de inventario).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vehiculos_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  console.log('✅ tenants.vehiculos_bot_enabled (v0.9.224 rubro vehículos)');

  // v0.9.226 — usuarios OCULTOS para el tenant: el super-admin marca usuarios (p.ej. soporte de SG)
  // para que NO aparezcan en los listados que ve el tenant (equipo, vendedores, agenda, permisos).
  await db.query(`ALTER TABLE tenant_users ADD COLUMN IF NOT EXISTS hidden_from_tenant BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {});
  console.log('✅ tenant_users.hidden_from_tenant (v0.9.226 ocultar usuarios de soporte al tenant)');

  // v0.9.227 — tasa de conversión USD→Bs (valor referencial de VENTA del dólar, BCB),
  // actualizada a diario por cron. Se usa para convertir el consumo (USD) a Bs en el "A pagar".
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS usd_to_bs_rate NUMERIC(6,2)`).catch(() => {});
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS usd_rate_date TEXT`).catch(() => {});
  await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS usd_rate_updated_at TIMESTAMPTZ`).catch(() => {});
  // Seed con el último valor conocido (BCB 23-jun-2026 = 9,99) solo si está NULL; el cron lo va refrescando.
  await db.query(`UPDATE platform_pricing SET usd_to_bs_rate = 9.99, usd_rate_date = '2026-06-23' WHERE id = 1 AND usd_to_bs_rate IS NULL`).catch(() => {});
  console.log('✅ platform_pricing.usd_to_bs_rate (v0.9.227 conversión USD→Bs tasa referencial BCB)');

  // v0.9.229 — set DESTACADO de fotos del inmueble: cuáles van con la ficha (map url→true).
  // Si está vacío, la ficha manda solo la foto principal (antes mandaba las primeras 5).
  await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS image_featured JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
  console.log('✅ properties.image_featured (v0.9.229 set destacado de fotos para la ficha)');

  // v0.9.230 — HISTORIAL DE VERSIONES del prompt de Aitana (por tenant + modo).
  // Cada "Guardar este prompt" guarda una versión (source manual|ai|restore + nota
  // opcional con la instrucción de "Mejorar con IA"). Se conservan las últimas 15
  // por (tenant, mode); las más viejas se podan al insertar. Permite Ver/Restaurar.
  await db.query(`CREATE TABLE IF NOT EXISTS tenant_prompt_history (
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER NOT NULL,
    mode        TEXT NOT NULL,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'manual',   -- manual | ai | restore
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_prompt_history ON tenant_prompt_history (tenant_id, mode, created_at DESC)`).catch(() => {});
  console.log('✅ tenant_prompt_history (v0.9.230 historial de versiones del prompt, tope 15 por tenant+modo)');

  // v0.9.232 — COBROS QR por tenant (BANECO): mapea cada QR generado a un tenant + período
  // para acreditar AUTOMÁTICAMENTE cuando el banco confirma el pago (poller statusQR).
  await db.query(`CREATE TABLE IF NOT EXISTS tenant_payment_qr (
    id             SERIAL PRIMARY KEY,
    tenant_id      INTEGER NOT NULL,
    qr_id          TEXT UNIQUE,
    transaction_id TEXT,
    period         TEXT,
    amount_bs      NUMERIC(12,2),
    currency       TEXT NOT NULL DEFAULT 'BOB',
    status         TEXT NOT NULL DEFAULT 'pending',
    due_date       DATE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at        TIMESTAMPTZ,
    payment_json   JSONB
  )`).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tenant_payment_qr_status ON tenant_payment_qr (status, tenant_id)`).catch(() => {});
  console.log('✅ tenant_payment_qr (v0.9.232 cobros QR por tenant + acreditación automática)');

  // v0.9.274 — REFERIDOS + TRIAL 7 DÍAS CON CORTE AUTOMÁTICO (Fase 0: SOLO datos, aditivo, sin cambio de comportamiento).
  //   - trial_ends_at: fin del trial (created_at+7d). Lo setea el backend al ALTA de cuentas nuevas; los trials
  //     actuales quedan NULL → el cron de conversión NO los toca (protege a las cuentas viejas de pasar a pago de golpe).
  //   - billing_anchor_at: "fecha de corte" = ancla de acumulación + inicio del metering pago. Backfill = created_at
  //     SOLO para las cuentas que HOY se cobran (active/past_due) → no les cambia el período. El resto queda NULL.
  //   - referral_code / referred_by_tenant_id + referral_credits: programa de referidos (10% del total al CONVERTIR).
  for (const sql of [
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_anchor_at TIMESTAMPTZ`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_code TEXT`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referred_by_tenant_id INTEGER REFERENCES tenants(id)`,
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_variable_billed_at TIMESTAMPTZ`,
  ]) { await db.query(sql).catch(e => console.warn('  ⚠️ referidos/trial col:', e.message)); }

  // v0.9.275 — CURSOR del consumo VARIABLE: el variable se cuenta DESDE acá (avanza a NOW() al pagar el total).
  // Backfill seguro = el MÁS RECIENTE entre el corte y el inicio del mes en curso → al deployar, el variable
  // de las cuentas actuales arranca en el mes en curso (igual que el modelo viejo por-mes), sin shock; en el
  // próximo pago full el cursor salta a esa fecha y el modelo nuevo queda andando limpio.
  await db.query(`UPDATE tenants SET last_variable_billed_at = GREATEST(COALESCE(billing_anchor_at, created_at), date_trunc('month', NOW()))
                  WHERE last_variable_billed_at IS NULL`).catch(e => console.warn('  ⚠️ last_variable_billed_at backfill:', e.message));

  // v0.9.276 — HEALTH CHECK de líneas Meta: estado REAL de la conexión (validado contra Meta), no solo
  // "hay un token guardado". El cron lo actualiza; el super-admin lo muestra 🟢/🔴 en vez del verde engañoso.
  for (const sql of [
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS meta_health TEXT`,          // connected | disconnected | unknown
    `ALTER TABLE tenants ADD COLUMN IF NOT EXISTS meta_health_at TIMESTAMPTZ`,
  ]) { await db.query(sql).catch(e => console.warn('  ⚠️ meta_health col:', e.message)); }

  // v0.9.278 — flag por tenant: habilita la "Carga masiva Formato C21" en el panel del tenant
  // (Inmuebles). Lo prende/apaga el super-admin. Default FALSE (oculto).
  await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS c21_import_enabled BOOLEAN DEFAULT FALSE`)
    .catch(e => console.warn('  ⚠️ c21_import_enabled col:', e.message));

  // referral_code único: los existentes derivado del id (determinístico); los nuevos los genera el backend al crear.
  await db.query(`UPDATE tenants SET referral_code = 'SG-' || UPPER(SUBSTR(MD5(id::text || 'sgv-ref'), 1, 6))
                  WHERE referral_code IS NULL`).catch(e => console.warn('  ⚠️ referral_code backfill:', e.message));
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_referral_code ON tenants (referral_code)`).catch(e => console.warn('  ⚠️ referral_code uniq:', e.message));

  // billing_anchor_at = created_at solo para las cuentas que hoy se cobran → preserva su período actual.
  await db.query(`UPDATE tenants SET billing_anchor_at = created_at
                  WHERE billing_anchor_at IS NULL AND LOWER(COALESCE(billing_status,'')) IN ('active','past_due')`)
    .catch(e => console.warn('  ⚠️ billing_anchor backfill:', e.message));

  await db.query(`CREATE TABLE IF NOT EXISTS referral_credits (
    id                  SERIAL PRIMARY KEY,
    referrer_tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
    referred_tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
    status              TEXT NOT NULL DEFAULT 'pending',   -- pending | earned | applied | void
    pct                 NUMERIC NOT NULL DEFAULT 10,
    earned_at           TIMESTAMPTZ,
    applied_period      TEXT,                              -- YYYY-MM en que se aplicó
    applied_amount_bs   NUMERIC(12,2),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (referred_tenant_id)                            -- un referido cuenta UNA sola vez
  )`).catch(e => console.warn('  ⚠️ referral_credits:', e.message));
  await db.query(`CREATE INDEX IF NOT EXISTS idx_referral_credits_referrer ON referral_credits (referrer_tenant_id, status)`).catch(() => {});
  console.log('✅ referidos + trial/corte (v0.9.274 Fase 0: trial_ends_at, billing_anchor_at, referral_code, referred_by_tenant_id, referral_credits)');

  process.exit(0);
}
run().catch(e => { console.error('❌', e.message); process.exit(1); });
