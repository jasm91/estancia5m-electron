/**
 * SG Ventas - Backend
 * Recibe webhooks de Meta, expone API para n8n y panel admin.
 *
 * Histórico de versiones:
 *   v0.1.0 — base inicial
 *   v0.2.0 — fix UNIQUE constraint en leads + notify owner
 *   v0.3.0 — análisis multimedia (audio/imagen) con Gemini + filtro anti-OTP
 *   v0.4.0 — consola de configuración dinámica de Aitana (live)
 *   v0.4.1 — endpoints livianos para polling + send retorna mensaje creado
 *   v0.5.0 — Cloudflare R2 storage, upload de archivos desde panel,
 *            multimedia entrante con URL pública, notas, búsqueda, CRUD assets
 *   v0.5.1 — solo bump de versión para alinear con panel
 *   v0.5.2 — fix: media entrante usa extensión correcta (.jpg/.mp4/.ogg etc)
 *   v0.5.3 — fix: POST /admin/assets auto-detecta type del MIME + upsert
 *   v0.5.4 — DELETE /admin/assets/:id?permanent=true → hard delete + R2
 *   v0.6.0 — PWA: instalable + Web Push notifications con backend
 *   v0.7.0 — endpoint export conversaciones a JSON con rango de fechas
 *   v0.7.1 — fix: export usa columnas reales de leads (bant/spin como JSON)
 *   v0.7.22 — Módulo Follow-up automático (rutas montadas + stop-words en webhook)
 *   v0.8.0-pre-sprint2 — Sprint 2 step 1: tenant-resolver activo + /api/admin/me
 *                        (api.js + webhook.js refactor pendiente en sub-fases)
 *   v0.8.2 — Cal.com webhook integrado (appointments)
 *   v0.8.3 — Prompt v7 con thresholds de score (70-85 invitación, ≥85 call_now)
 *   v0.9.0 — Prompt v8 (apertura leads anuncio + vertical + memoria)
 *            + Archivar conversaciones (manual + auto 3d + reactivación)
 *   v0.9.1 — Dashboard Analytics (KPIs + embudo + verticales + tendencias)
 *   v0.9.2 — UX leads: chips de estado en lugar de dropdowns (modal + tabla)
 *   v0.9.3 — Notas de seguimiento en modal de lead (reusa conversation_notes)
 *   v0.9.5 — Sistema de tareas/recordatorios (worker + auto-creación score >=85)
 *   v0.9.6 — Embedded Signup: onboarding.js + meta.js multi-tenant + landing page
 *   v0.9.7–v0.9.24b — multi-tenant completo (ver handoffs): config/prompts/
 *            usuarios/líneas/modos de venta/inventario/inmuebles por tenant
 *   v0.9.24c — follow-ups con auth multi-tenant; panel no expulsa por 403/401 legacy
 *   v0.9.24d — ventana TEST con catálogos reales + reset al cambiar prompt
 *   v0.9.25  — billing super-admin (overview/cobros/pagos/packs) + saldo de masivos
 *   v0.9.26  — reset de contexto por conversación + etapas venta/post-venta
 *   v0.9.27  — assets por modo de venta + fix leak /whatsapp/media-assets
 *   v0.9.28  — modos de venta excluyentes + bloque de capacidades en prompt
 *   v0.9.29  — usuarios (agentes) con alcance por etapa + assets agrupados
 *   v0.9.30  — reportes por etapa + fix lectura follow-up config + leak demo_credentials
 *   v0.9.30c — Cal API key verificada al guardar + red de seguridad anti-crash async
 *   v0.9.31  — link de agenda (calcom_event_url) en TODOS los modos + UI en Reservas
 *   v0.9.31b — perfil general ({{vars}}) aplica en todos los modos + anti-desborde móvil
 *   v0.9.32  — edición completa de inmuebles (todos los campos + fotos), antes solo precio/estado
 *   v0.9.33  — inmuebles: maps_url + documentos PDF (file_urls); ficha con mapa + docs
 *   v0.9.34  — post-venta = atención: dashboard de servicio, bot no califica, sin follow-ups
 *   v0.9.34b — fix orden applyServiceView + window.state inexistente (afectaba
 *              vista de servicio, stage en sellers y tenant_id super-admin en /admin/bot/*)
 *   v0.9.35  — fotos de inmuebles con descripción por ambiente: image_labels,
 *              hasta 20 fotos, Aitana manda la foto pedida (photo_label) y el
 *              catálogo n8n lista los ambientes; quitar fotos desde el panel
 *   v0.9.35b — miniaturas con preview + lightbox en el modal de fotos
 *   v0.9.36  — picker 📎 del chat organizado por modo: primero lo que Aitana ve
 *              (modo activo + universales), el resto colapsado con aviso
 *   v0.9.37  — PDFs de inmuebles SOLO a pedido (send_docs) — ya no van con
 *              cada ficha; el prompt instruye mandarlos solo si piden catálogo
 *   v0.9.38  — cambio de chat instantáneo: caché por conversación en el panel
 *              + refresco incremental (?since=) en segundo plano
 *   v0.9.39  — Graph API v21→v25 (defaults): habilita la opción de COEXISTENCE
 *              ("Connect a WhatsApp Business App") en el Embedded Signup
 *   v0.9.40  — Embedded Signup lanza con featureType whatsapp_business_app_onboarding
 *              + sessionInfoVersion 3; listener acepta FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING
 *   v0.9.41  — Redirect forzado HTTP→HTTPS + HSTS (Railway sirve http plano sin redirigir;
 *              Chrome marcaba "No seguro" y el SDK de FB no abre sobre http)
 *   v0.9.42  — Productos comerciales con ficha completa: marca/categoría/características,
 *              hasta 20 fotos etiquetadas (photo_label), PDFs solo a pedido (send_docs),
 *              modal de edición completo — mismo patrón que inmuebles. FIX: el GET de
 *              inmuebles no devolvía image_labels/maps_url/file_urls y el modal los pisaba.
 *   v0.9.43  — Tareas dinámicas: asignación a agentes (bandeja 📥 + badge), estado
 *              in_progress, vistas Kanban (drag&drop) y Gantt (start_at→due_at),
 *              alcance por rol (el agente solo ve/toca lo suyo)
 */
/*
 *   v0.9.45  — Hardening (P1): multer fileFilter, historial de prompts por tenant,
 *              express.json 2mb; workflow n8n v3.4 con photo_label/send_docs
 *   v0.9.46  — Módulo de Campañas outbound: pestaña dedicada (KPIs, historial, wizard,
 *              CSV/lista manual, programación con worker, lista de exclusión/opt-out)
 */
/*
 *   v0.9.44  — Hardening de auditoría (P0): XSS de media_url/sent_by_name en el panel,
 *              webhook sin fallback a tenant 1 + fail-closed sin APP_SECRET, tokens
 *              timing-safe, /whatsapp/lead+progress por conversación más reciente,
 *              tarea automática con tenant correcto, push/auto-archive con auth moderna,
 *              entry templates por tenant, headers de seguridad (nosniff/XFO/Referrer)
 *   v0.9.47  — Follow-ups MULTI-TENANT (antes solo tenant 1), analítica de campañas
 *              (entregas/lecturas/respuestas), rate limit en login, JWT 24h, CORS
 *              por dominio, pack de plantillas promocionales
 *   v0.9.60  — FIX onboarding público (r2_prefix NOT NULL rompía el INSERT → 500;
 *              ahora crea tenant + línea default en transacción, anti-spoof, dup-check
 *              vs tenant_lines, éxito apunta al login con Facebook) + CORS: se suma el
 *              panel de cobros (Netlify) y env CORS_EXTRA_ORIGINS para orígenes extra
 *   v0.9.61  — Login FB diagnosticable: NO_TENANT loguea fb_user + WABAs del token +
 *              granular_scopes (si no hay WABAs → falta whatsapp_business_management
 *              en la config de login de Meta); PATCH /admin/tenants/:id acepta
 *              fb_user_id (vinculación manual owner↔tenant por super-admin)
 *   v0.9.62  — Login FB: fallback 3c "probe de WABA" — si los granular_scopes no
 *              traen target_ids, se prueba con Graph si el usuario puede leer la
 *              WABA de algún tenant (rol sobre el asset = es su org) y se
 *              auto-vincula. El owner recién onboardeado entra solo, sin curl.
 *   v0.9.63  — REGISTRO del número en Cloud API tras onboarding/add-line (el ES
 *              conecta pero no registra → quedaba "Pendiente" sin poder enviar);
 *              PIN cifrado en tenant_lines.pin_enc + POST /admin/lines/:id/register;
 *              eventos benignos (PARTNER_APP_INSTALLED etc.) ya no disparan el
 *              banner 🚨 ni se filtran entre tenants (quality_alert por tenant)
 *   v0.9.64  — Cache-Control: no-store en /api/* (Cloudflare cacheaba GETs de la
 *              API en el dominio: /api/version y /api/auth/config servían stale)
 *   v0.9.65  — FIN del leak cross-tenant de prompts: tenant sin prompt propio ya
 *              NO hereda el de tenant 1 (vendía SG Bolivia desde el número del
 *              cliente) → prompt NEUTRO de recepción; default-mode-prompts.js
 *              única fuente de prompts default (incluye inmobiliario AVANZADO);
 *              el onboarding pre-carga articulos/inmuebles/servicios al crear tenant
 *   v0.9.66  — Panel: indicador de línea en uso en el header (etiqueta + número;
 *              refleja el filtro de línea; multi-línea muestra default + cuántas más)
 *   v0.9.67  — Auditoría 12-jun batch 1 (P0+seguridad): /whatsapp/send por
 *              conversation_id sin fallback a tenant 1 (cross-tenant), media
 *              entrante con token de la línea, ADMIN_TOKEN fuera de WhatsApp,
 *              push de tareas/test/unsubscribe por tenant, no-store cubre
 *              /api/version y /admin/me, bot/history por tenant, timing-safe
 *              en los 4 middlewares que faltaban
 *   v0.9.68  — Auditoría 12-jun batch 2 (negocio de campañas): saldo de packs
 *              ENFORCED en broadcast/send-bulk/worker (tenant 1 exento), opt-out
 *              respetado en send-bulk + follow-ups + reintentos, BAJA apaga
 *              follow-ups y es stop-word, retries solo con rechazo explícito de
 *              Meta (timeouts ya no duplican), quality grave con \b solo sobre
 *              event + pausa también campañas running (el loop corta), worker
 *              no corre tenants suspendidos, waba de líneas resuelve tenant
 *   v0.9.69  — Auditoría 12-jun batch 3 (ops/UX): badge del panel muestra la
 *              versión del BACKEND, SW CACHE_VERSION bumpeado (auto-update del
 *              panel revive), rate limit en exchange-code//r/:code/connect-fb,
 *              contrato unificado "respuesta" (servicios + plantillas de rubro
 *              + Test con compat reply), /admin/stats con scope de agente,
 *              validación al guardar prompts (anti texto-del-modal / sin
 *              contrato), history sync con timestamps reales + tope + archivadas
 *   v0.9.71  — FIX: chip 📎 Assets de las tarjetas de modo abría una vista en
 *              blanco (setTab('assets') no existe — es setConfigSection)
 *   v0.9.72  — Aislamiento: IDOR de assets en envío (3 SELECT por asset_id sin
 *              tenant), assets por rubro (whitelist sale_mode), quick-replies JOIN
 *              por tenant, DELETE de tareas con scope de agente; 500 kanban = transitorio
 *   v0.9.70  — RUBROS de primera clase: Salud/Belleza/Restaurante son modos de
 *              venta con tarjeta, prompt propio (auto-sembrado), catálogo (motor
 *              servicios/artículos) y assets propios; activación de UN clic;
 *              REGLA DURA anti "te lo mando" sin acción en el JSON (caso real);
 *              assets por rubro viajan solo con su rubro activo; plantillas de
 *              rubro del editor reemplazadas; filtro de línea con etiqueta clara
 */
// v0.9.156 — Follow-ups movido de tab de Config a item de la barra lateral (sidebar).
// v0.9.157 — mensajes: hora exacta (HH:MM) + motivo de envío fallido visible en el panel.
// v0.9.158 — chat: separador de día sticky (Hoy/Ayer/día/fecha), estilo WhatsApp.
// v0.9.159 — Config→Prompt: mejorador con IA (instrucción en lenguaje natural → Gemini reescribe; tokens a ai_usage).
// v0.9.160 — Soporte: tickets de plataforma (cliente reporta → cola super-admin → análisis IA). + copiloto KB al día.
// v0.9.161 — fix tickets: asegurar columnas de platform_tickets en runtime (la tabla preexistía con otro esquema).
// v0.9.162 — fix tickets: usar tabla nueva platform_bug_reports (la vieja platform_tickets tenía otro esquema/constraints).
// v0.9.163 — Cal.com POR USUARIO: cada vendedor conecta su Cal (su calendario + su link); Aitana manda el del vendedor asignado.
// v0.9.164 — Agenda del equipo (solo dueño): KPIs y citas por vendedor agregando todas las agendas de Cal.
// v0.9.165 — AGENDADOR PROPIO (reemplaza Cal): disponibilidad por vendedor + página pública /agendar/:token + citas en la DB.
// v0.9.166 — Agendador: pausa diaria + bloqueos puntuales (ausencias/vacaciones); se quita la UI de conectar Cal.
// v0.9.167 — Agendador: recordatorio automático de cita por WhatsApp (~3h antes), vía el cron de follow-ups.
// v0.9.168 — Agendas ACTIVAS por defecto para todos + Aitana usa la agenda del dueño cuando la conversación no está asignada (ya no manda Cal).
// v0.9.169 — Reservas en 3 sub-pestañas (Calendario/Disponibilidad/Bloqueos) + la página de agenda autollena nombre y WhatsApp del lead.
// v0.9.170 — Endpoint POST /api/bot/book-appointment: Aitana agenda directo desde el chat (valida disponibilidad y reserva, o da alternativas).
// v0.9.171 — Regla "agendar" en el system prompt + workflow n8n que llama al endpoint y arma el mensaje (agendado directo end-to-end).
// v0.9.172 — Fix agendado: a Aitana se le inyecta el CALENDARIO real (hoy + 10 días con fecha) para que no adivine qué día es "lunes"; regla reforzada (día+hora SIEMPRE → "agendar", nunca link); alternativas = 4 huecos más cercanos a lo pedido.
// v0.9.173 — Confirmación de cita con nombre del asesor + teléfono de contacto (configurable por usuario en Reservas→Disponibilidad); el backend arma el mensaje y n8n solo lo reproduce.
// v0.9.174 — Fix: la agenda por defecto (cuando la conversación no está asignada) prefiere la cuenta con NOMBRE REAL sobre cuentas placeholder ("Dueño"/"Admin"), así la cita queda con el nombre + teléfono del asesor real (no la cuenta genérica).
// v0.9.175 — POOL de citas: Aitana crea una cita PENDIENTE (sin dueño) con la hora pedida y notifica al equipo (push); cualquier asesor la "toma" o el dueño la asigna desde Reservas→Por tomar. Reemplaza el agendado directo a la agenda por defecto.
// v0.9.176 — (panel) "Por tomar" movido al rail lateral antes de Tareas.
// v0.9.177 — Cita EDITABLE: modal con datos del contacto, historial de notas, fotos de la visita (R2) y estado (Pendiente/Asignada/Realizada); endpoints GET/PATCH/notes/images.
// v0.9.178 — (#1) prompt refuerza FOTOS POR ETIQUETA (Aitana manda la foto del parqueo/ambiente por photo_label, no dice "no tengo"); (#7, panel) login móvil: botón Instalar app + Facebook oculto en móvil.
// v0.9.179 — (#2) el copiloto del panel ahora ve la AGENDA en su snapshot (citas por tomar, próximas, de hoy, realizadas + lista de próximas con hora local) → responde "¿tengo citas pendientes?" con datos reales.
// v0.9.180 — (#4 fase A) AUDITORÍA automática: un middleware registra toda mutación (quién/qué/tenant/recurso/resumen) en audit_logs; GET /admin/audit-logs (+ /export CSV) y pestaña Auditoría en el super-admin.
// v0.9.181 — (#4 fase B) SNAPSHOTS: respaldo por tenant (dump de todas las tablas con tenant_id → JSON gzip en la DB, privado) + crear/listar/descargar/borrar + cron diario (inicio/fin) + pestaña Snapshots en el super-admin.
// v0.9.182 — (#4 cierre) RESTORE de snapshots: POST /admin/snapshots/:id/restore — snapshot de seguridad previo + restaura en transacción ordenando por FKs (padres antes que hijos) + confirma por nombre del negocio. Botón "🔄 Restaurar" en el super-admin. #4 COMPLETA.
// v0.9.184 — BUGS del bot: (2) la ficha de inmueble con descripción larga quedaba "no entregado" (caption de imagen > ~1024 de WhatsApp) → ahora foto con caption corto + descripción como texto aparte; (1) prompt reforzado: ante pedido de UN ambiente SIEMPRE photo_label (1 foto), nunca property_to_send solo (que manda la ficha entera).
// v0.9.185 — Modal de cita: botón "💬 Abrir chat CRM" (abre la conversación en el inbox) + las fotos de la visita guardan GPS opcional (lat/lng) para verificar presencia en sitio, con pin 📍 al mapa.
// v0.9.186 — Super-admin: fix Auditoría/Snapshots 500 (self-heal de audit_logs/db_snapshots con ALTER ADD COLUMN IF NOT EXISTS) + dropdown de tenants activos + estilo. Follow-ups: candado (h) no seguir a quien ya tiene cita pendiente/agendada. Recordatorio de cita: pasa a ~2h antes (antes 3h). (Aclaración: follow-up = reactivar charla; recordatorio = aviso 2h antes de la visita — son cosas distintas.)
// v0.9.188 — UX agente móvil: los vendedores (agentes) en móvil arrancan en Reservas; al TOMAR o ASIGNAR una cita se asigna la conversación a ese usuario (filtro "Yo"); el inbox sube y destaca (borde + 📅) las conversaciones con cita activa (conversations devuelve has_appt).
// v0.9.190 — Fotos por etiqueta con MATCH FLEXIBLE: "baños" ahora matchea "Baño"/"Baño Suite" (singular/plural, sin acentos, por palabras + sinónimos garaje≈parqueo, cuarto≈dormitorio…) y manda TODAS las que matchean; si no hay match NO manda la ficha/Fachada (arregla "manda fotos equivocadas"). Aplica a inmuebles, productos y servicios.
// v0.9.191 — Fix crash-loop bot_global_config (migrate-bot-config seed pasa a WHERE NOT EXISTS, sin ON CONFLICT config_key) + multi-tenant definitivo (suelta el unique de config_key, deja el compuesto). Cierra el 500 al guardar follow-up en tenants ≠1.
// v0.9.192 — Notificaciones configurables por rol (Config → 🔔 Notificaciones): por evento (lead caliente/escalación, cita por tomar, cita asignada, mensaje nuevo en chat asignado) se elige qué roles reciben PUSH + WhatsApp opcional en eventos de equipo. push-notifier con targeting por rol/usuario; tabla notification_prefs.
// v0.9.193 — Iconos de app/notificación en PNG teal (estilo panel) + badge monocromático; header MÓVIL muestra el nombre del usuario logueado (no el de la línea); FIX seguridad: el agente ya no ve/entra a Configuración (gate del botón del rail data-rail + guard en setTab/setTabMobile).
// v0.9.194 — Plataforma de ROLES Y PERMISOS (Config → 🔐): catálogo ampliado (Secciones nav_* + Acciones), override por usuario encima del rol (tabla user_permissions), endpoints my-permissions / user-permissions, y el panel se gobierna por permiso efectivo (applyRoleVisibility + guards de setTab por can()). El Dueño siempre ve todo.
// v0.9.195 — menú inferior móvil: la barra del contenido usaba EMOJI y la de Chats lucide → los iconos "cambiaban" al navegar. Unificadas a lucide minimalistas (no cambian). + botón "Probar follow-ups ahora" (run-now).
// v0.9.196 — FIX cron follow-ups: re-mandaba la etapa 0 cada 5 min (no escalonaba) porque el INSERT de follow_up_log usaba la columna `phone` que no existía → el log fallaba y el candado anti-duplicado quedaba vacío. Self-heal: ALTER follow_up_log ADD COLUMN phone.
// v0.9.197/198 — UX página Follow-ups: sub-pestañas UNA POR SECCIÓN (⚙️ Follow-up · 📶 Etapas · 🤖 Instrucción IA · 🧩 Plantillas · 📊 Actividad) + barra fija "💾 Guardar cambios" con confirmación, estado ("Guardando…/✅ Guardado HH:MM") y spinner; auto-guardado sigue como red de seguridad.
// v0.9.199 — AUDITORÍA REPORTES + FIX de integridad de datos: messages.tenant_id tenía DEFAULT 1 y los ~23 INSERT de mensajes SALIENTES en api.js no lo setean → todo lo saliente (bot, fichas, follow-ups) quedaba en tenant 1. Rompía métricas de Reportes basadas en mensajes (tiempo de respuesta=null, top assets vacío, mensajes subcontados) para tenants ≠1 y los snapshots por tenant. Fix en migrate-onboarding: backfill desde conversations (1ra vez) + trigger BEFORE INSERT que fuerza messages.tenant_id = el de su conversación (arregla los inserts sin tocar api.js). Las demás métricas (conversaciones/leads/citas/embudo) ya estaban correctas.
// v0.9.200 — Reportes → panel Vendedores con ATRIBUCIÓN HÍBRIDA: antes todo se medía por mensajes enviados a mano (sent_by_user_id) → como Aitana (bot) los manda todos, los vendedores salían en CERO. Ahora MSGS/1ª respuesta/sparkline 7d = esfuerzo manual del asesor, y conversaciones/leads/ganados = por asignación (conversations.assigned_to). Caption del panel actualizado.
// v0.9.201 — Menú (⋮): "Mi plan" y "Exportar conversaciones" ahora SOLO para el Dueño. Antes "Mi plan" lo veía el agente (no se gateaba) y "Exportar" lo veía también el supervisor. Gateado en applyRoleVisibility (desktop + móvil): Mi plan = owner real (oculto en super-admin por self-service), Exportar = owner/superadmin.
// v0.9.202 — Reservas: (1) botón "➕ Crear cita" → POST /admin/appointments crea cita manual en el calendario PROPIO del usuario (cualquier horario, avisa si choca y deja forzar; enlaza chat/lead por teléfono; nota opcional). (2) El calendario ahora MUESTRA las citas PENDIENTES de asignar (pool, status='pending', sin dueño) en ámbar (vs teal de asignadas) con leyenda, para que el pendiente salte a la vista; helper _fetchInhousePending sumado a /admin/reservations. (3) Al TOMAR/ASIGNAR una cita: se confirma al CLIENTE por WhatsApp con el nombre y teléfono del asesor en formato wa.me (contacto directo en el momento, se loguea en el chat) + push al asesor con el resumen del cliente (score/vertical/teléfono). Helper _notifyAppointmentAssigned en claim y assign.
// v0.9.203 — Agendado más confiable + horarios concretos (todo en bot-prompt-builder, sin tocar n8n):
//   (a) Aitana ofrece HORARIOS LIBRES reales del vendedor (asignado→agenda por defecto), restando citas tomadas + pausa, agrupados mañana/tarde (3 por franja) → ya no pregunta "¿mañana o tarde?" sin dar opciones (lead se enfriaba). Fallback a pedir día+hora si nadie tiene agenda activa.
//   (b) REGLAS DEL AGENDADO obligatorias: el campo "agendar" SIEMPRE debe acompañar la confirmación (si Aitana dice "dejo tu solicitud" sin el campo, la cita NO se creaba — era el bug); y SIEMPRE confirmar al cliente la FECHA y HORA exactas, nunca solo el día ni una franja vaga. Si el cliente da solo franja, ofrecer 3 horarios y esperar que elija (recién ahí emite "agendar").
// v0.9.204 — Rail lateral: set de iconos nuevo (lucide) que arregla colisiones de significado: Leads star→flame, Por tomar bell→calendar-clock, Tareas calendar-check→list-checks (saca el doble calendario), Follow-ups send→alarm-clock, Agenda equipo users→users-round. Reflejado en el nav inferior móvil (Leads). Solo iconos, sin cambios de lógica.
// v0.9.205 — Agenda del equipo: el filtro "Esta semana" era lunes-a-lunes y ocultaba citas a pocos días pero "de la otra semana" → un vendedor figuraba "sin citas" teniéndolas (caso real: hoy sáb, citas mar/jue). Ahora es ventana MÓVIL (hoy → +7 días), botón renombrado "Próx. 7 días". Además: el header de escritorio ahora muestra el NOMBRE del usuario conectado (👤) junto al nombre de la línea, para claridad. (No era bug de datos: las citas sí estaban asignadas al vendedor.)
// v0.9.206 — FIX: en móvil el agente seguía viendo "Mi plan" y "Exportar conversaciones" pese al gate de rol. Causa: la regla CSS `#mobileMenuDropdown .dropdown-item { display:flex }` (id+clase) le ganaba en especificidad a `.hidden` (display:none), así que agregar la clase no lo ocultaba. Fix: regla scoped `#mobileMenuDropdown .dropdown-item.hidden { display:none !important }`. (El gate por rol en applyRoleVisibility ya estaba bien desde v0.9.201.)
// v0.9.207 — Reservas en móvil: controles más compactos (botones con menos padding/tamaño, menos márgenes entre filas, celdas del calendario más bajas) para que el calendario se vea lo más completo posible. Solo CSS (media query móvil), sin cambios de lógica.
// v0.9.208 — PAGOS QR (Fase 0) · paso 1: modelo de datos. tenant_payments (anti-reuso por nro_comprobante UNIQUE), billing_ledger (cargos/abonos → saldo), tenants.billing_next_due_date + billing_balance_bs, platform_pricing.collection_* (cuenta+QR de cobro) + ocr_autoapprove_score. REUSA el billing_status existente (active/trial/past_due/suspended/cancelled): solo 'active' se cobra y puede pasar a 'past_due' (=vencido: alerta roja + banner); 'trial'/'suspended'/'cancelled' NO se cobran ni disparan alertas (trial muestra solo el monto que pagaría). Solo migración idempotente, sin lógica todavía.
// v0.9.209 — PAGOS QR (Fase 0) · paso 2: backend de comprobantes. POST /api/me/billing/upload-comprobante → sube a R2 + Gemini visión (inline_data) lee el comprobante → JSON {monto, cuenta, fecha, nro, score} → verifica (cuenta destino vs cuenta de cobro, monto≥esperado, fecha reciente, nº único anti-reuso, score≥umbral) → si todo OK auto-acredita (ledger + saldo + avanza vencimiento + saca de past_due); si no, queda 'pending' para revisión. /api/me/billing ahora devuelve saldo + vencimiento + QR/cuenta + is_trial (trial/suspended/cancelled no se cobran).
// v0.9.210 — PAGOS QR (Fase 0): config de la CUENTA DE COBRO. /api/admin/pricing-config (GET/PUT) ahora también lee/guarda collection_bank/account/holder/qr_url + ocr_autoapprove_score (lo que el motor compara contra el comprobante). Super-admin: tarjeta "Cuenta de cobro (pagos QR)" en Precios. Mientras estos campos estén vacíos, NADA se auto-aprueba (cae en pending) — seguro por defecto.
// v0.9.211 — PAGOS QR (Fase 0) · paso 4: "Mi plan" del cliente ahora tiene tarjeta de PAGO — muestra el QR + monto a pagar + vencimiento + saldo a favor + datos de la cuenta, y un botón "📤 Subir comprobante" que comprime la imagen en el cliente (para no pasar el body de 2mb) y la manda a /me/billing/upload-comprobante (Gemini lee + verifica + acredita). Banner rojo si está past_due; si es trial muestra solo el monto que pagaría. + super-admin: subida de la imagen del QR (a /api/media/upload-public).
// v0.9.212 — PAGOS QR fix: el comprobante aprobado no aparecía en ningún lado. (1) al auto-aprobar, además de acreditar, se inserta en billing_payments (la tabla que muestra "Mi plan": historial + "pagaste X de Y" + al día) — antes solo escribía en tenant_payments/ledger, desconectado de la UI. (2) /me/billing devuelve los comprobantes subidos (todos los estados) y "Mi plan" muestra una lista "Comprobantes enviados" (✅/⏳/⚠️) para que el cliente vea el seguimiento aunque el pago quede en revisión. (3) "saldo a favor" = pagado − esperado (no el balance crudo).
// v0.9.213 — PAGOS QR (Fase 0) · paso 5a: REVISIÓN de comprobantes. Helper _creditPayment (única fuente de verdad para acreditar, auto o manual). Endpoints super-admin: GET /api/admin/payments/pending (lista los 'pending'), POST /api/admin/payments/:id/approve (acredita; permite corregir el monto) y /reject. Super-admin: nueva pestaña "💳 Pagos" con la imagen del comprobante + datos del OCR + Aprobar/Rechazar. ASÍ se aprueban los pagos en revisión.
// v0.9.214 — PAGOS QR: ver la IMAGEN del comprobante en los dos lados. Cliente ("Mi plan" → Comprobantes enviados): columna "📎 Ver". Super-admin (pestaña "💳 Comprobantes"): /api/admin/payments/pending ahora devuelve TODOS (pendientes primero) → ves la imagen de los aprobados/rechazados también; acciones solo en los pendientes.
// v0.9.215 — Reservas: el calendario ahora tiene toggle Día / Semana / Mes. En MÓVIL arranca en "Semana" (la semana en curso). Semana = agenda de los 7 días (lun→dom) con sus turnos; Día = los turnos del día; Mes = la grilla de siempre. Navegación ‹ hoy › por vista. Solo panel.
// v0.9.216 — Reservas: controles compactos para priorizar las citas. Se eliminó la fila redundante "Calendario/Lista" (Lista pasó al selector de vista → Día/Semana/Mes/Lista), Refrescar es ahora un ícono ↻, menos márgenes. De 3 filas de botones a 2. Selector unificado setResMode.
// v0.9.217 — Pagos QR: (1) botón "📎 Ver" el comprobante directo en el HISTORIAL de pagos — tanto en "Mi plan" del cliente como en "Pagos registrados" del tenant en el super-admin (nueva columna billing_payments.receipt_url + backfill). La pestaña "Pagos" del super-admin vuelve a ser SOLO la cola de pendientes por aprobar (ver imágenes ya no necesita pestaña aparte). (2) Máxima compresión de la imagen del comprobante al subir (1080px / JPEG 0.6) → mucho menos peso en R2, sigue legible para el OCR.
// v0.9.218 — Snapshots: retención bajada de 20 a 6 por tenant. Al crear un snapshot, si el tenant ya tiene 6 se borra el más viejo (rota). Aplica al cron automático y a los manuales. Los que ya existen de más se purgan en el próximo snapshot de cada tenant.
// v0.9.219 — Retención de snapshots CONFIGURABLE por tenant: columna tenants.snapshot_retention (default 6, rango 1–50). _createSnapshot la lee por tenant; editable desde el super-admin (campo "Snapshots a guardar" en Configuración editable del tenant). Si está vacía/sin migrar usa 6.
// v0.9.220 — TRACE de onboarding para monitorear en vivo: log al ENTRAR a /onboarding/exchange-code (waba/phone/business/code sí-no), log en el 409 "ya conectado", y los cortes tempranos (exchange/verify número) ahora marcan onboarding_attempts como 'failed' con el motivo (antes quedaban en 'started'). El éxito y el error inesperado ya logueaban.
// v0.9.221 — (Mi plan) el banner de TRIAL ahora muestra, además del fijo en Bs, el consumo del mes en USD: "pagarías Bs X/mes + USD Y de consumo de IA" (usa _consUsd ya calculado en renderMyBilling). Solo texto del banner; el detalle (tokens + mensajes) ya estaba en la tarjeta "Consumo del mes (USD)".
// v0.9.222 — (Mi plan) fallback del QR de pago: si la imagen no carga (móvil con red lenta / imagen pesada de R2), muestra los datos de la cuenta en vez del ícono roto (qrImgError). El síntoma "QR roto en móvil" era la imagen cross-origin que no bajaba aunque la API same-origin sí.
// v0.9.223 — usuarios NO facturables: el super-admin puede marcar usuarios (p.ej. los de soporte que crea SG) para que NO se cuenten en el cobro del tenant. Flag tenant_users.billing_excluded + se excluye del conteo facturable en billingRows, detalle por tenant y /api/me/billing + endpoint PATCH /api/admin/tenants/:id/users/:userId.
// v0.9.224 — (1) Prompt de INMUEBLES reorientado a LOTES + regla anti-aluvión de fotos al tope (1 foto por turno) + ganchos de venta (plusvalía/cuotas/papeles/servicios). (2) NUEVO rubro CONCESIONARIA DE VEHÍCULOS (motor inventario): prompt + RUBROS + flag vehiculos_bot_enabled + tarjeta en el panel + pre-carga en onboarding + validaciones de modo (api-bot-config).
// v0.9.225 — FIX coexistence HISTORY: Meta NO manda el webhook 'history' solo; hay que PEDIRLO con POST /{phone_number_id}/smb_app_data sync_type=history (+ contactos smb_app_state_sync). Antes solo suscribíamos el field → nunca llegaba. Ahora el onboarding lo solicita en coexistence (meta.requestCoexistenceSync) + endpoint POST /api/admin/lines/:id/sync-history para líneas ya conectadas (David/MERCALOTES). Descubierto comparando con un backend de referencia (Laravel).
// v0.9.226 — OCULTAR usuarios del tenant: flag tenant_users.hidden_from_tenant (super-admin) → el usuario (p.ej. soporte de SG) NO aparece en los listados que ve el tenant (equipo /admin/users, vendedores, agenda del equipo, permisos). Toggle generalizado (billing_excluded + hidden_from_tenant) en el mismo endpoint.
// v0.9.227 — "A pagar" ahora incluye el CONSUMO (USD: IA + mensajes/campañas) convertido a Bs al valor referencial de VENTA del dólar del BCB. Tasa auto-actualizada por cron (baja valor_referencial_venta_svg.php del BCB con Referer, parsea "Bs X,XX/$us", guarda en platform_pricing.usd_to_bs_rate; fail-safe). Mi plan muestra el total en Bs + el desglose con el consumo en USD y su conversión. Override manual en super-admin.
// v0.9.228 — el rubro Vehículos faltaba en el whitelist ALLOWED del PATCH /api/admin/tenants/:id/modes (visibilidad de modos del super-admin) → no se podía ocultar/mostrar en el panel del cliente. Agregado + checkbox en la tarjeta "Visibilidad de modos" del super-admin.
// v0.9.229 — INMUEBLES: set DESTACADO de fotos. El dueño marca con un checkbox "ficha" qué fotos manda Aitana al presentar el inmueble (image_featured); si no marca ninguna, va SOLO la principal. Antes la ficha mandaba las primeras 5 = bombardeo. El resto de la galería sigue yendo a pedido ("muéstrame la cocina").
// v0.9.230 — HISTORIAL DE VERSIONES del prompt de Aitana (por modo): cada guardado/mejora con IA/restauración deja una versión (tenant_prompt_history, tope 15 por tenant+modo). Panel: sección "Historial de versiones" con Ver/Restaurar + DIFF línea por línea (verde=agregado, rojo=quitado). Endpoints GET/POST /admin/bot/prompt-history(/restore). + Visibilidad de modos: el PATCH ahora hace MERGE (un front viejo no borra otras claves).
// v0.9.231 — COBROS QR (BANECO "BEC QR CONNECT"): módulo backend/baneco.js (AES-256-CBC, env-driven) + endpoints super-admin /api/admin/baneco/{health, qr, qr/:id/status, DELETE qr/:id}. Se monta PRIMERO en el super-admin (vista "Cobros QR") para generar QR por monto / ver estado; después se wirea a Mi plan. Credenciales SOLO por entorno (BANECO_BASE_URL/USER/PASSWORD/AES_KEY/ACCOUNT).
// v0.9.232 — COBROS QR por TENANT (BANECO) con acreditación AUTOMÁTICA: tabla tenant_payment_qr (mapea QR→tenant+período), POST/GET /api/admin/tenants/:id/baneco-qr (genera por el "A pagar" exacto), y un poller (cron cada 3 min) que consulta statusQR y acredita por _applyPaymentCredit → baja el saldo del tenant. Anti-doble (marca paid antes de acreditar). Super-admin: selector de tenant en "Cobros QR".
// v0.9.233 — Mi plan: el TENANT genera su propio QR de pago (BANECO) por su "A pagar" exacto. POST /api/me/billing/baneco-qr + GET /api/me/billing/baneco-qr/:id/status (verifica dueño y acredita on-demand al pagarse). En Mi plan: botón "💸 Pagar al instante con QR" + polling que refresca el saldo al acreditarse. El comprobante manual queda como respaldo.
// v0.9.234 — Tablero de RENDIMIENTO en Mi plan: costo por Cliente Activo (conversación con actividad en el mes), por Lead Calificado (score≥70) y por Cita Agendada, sobre el total "A pagar" del mes. /api/me/billing devuelve `performance` (cuentas con try/catch defensivo) y el panel muestra 3 tarjetas arriba de Mi plan.
// v0.9.235 — FIX "A pagar" en Mi plan: cuando el período ya está pagado (pending=0) mostraba el total en vez de Bs 0. Ahora muestra Bs 0 en verde + "🎉 Ya estás al día este mes", oculta el QR y los botones de pago, y el vencimiento dice "Próximo cobro". (Era `pending>0 ? pending : total` → caía al total al estar pagado.)
// v0.9.236 — FIX fotos: cuando el cliente pide "todas las fotos", el prompt manda photo_label "todas" pero el backend lo trataba como una etiqueta puntual → no matcheaba → mandaba SOLO el texto ("Aquí tienes todas las fotos") sin fotos. Ahora _sendSpecificPhotos reconoce "todas/todos/all/ver todas" y envía toda la galería (cap 10).
// v0.9.237 — NOMBRE real de contactos de Messenger/Instagram: al entrar un DM, si la conversación no tiene nombre, se consulta el perfil en la Graph API (PSID→first_name/last_name, IGSID→name/@username) con el token de la página y se guarda en contact_name (en segundo plano, best-effort). Antes mostraba solo "Messenger"/"Instagram". meta.getChannelUserProfile + resolución en webhook.handleMessengerWebhook. (La foto de perfil queda para después: necesita columna avatar_url + render.)
// v0.9.238 — atajo para pedir el historial (coexistence) por TENANT: POST /api/admin/tenants/:id/sync-history recorre las líneas del tenant y llama requestCoexistenceSync por cada una (el line id no siempre está a mano; el tenant id sí). Botón en el super-admin.
// v0.9.239 — limpieza del history sync: el insert de mensajes entrantes ahora usa ON CONFLICT (wa_message_id) DO NOTHING + corta si fue duplicado. Mata los "Error procesando mensaje: duplicate key messages_wa_message_id_key" que aparecían durante el backfill de coexistence (Meta reenvía mensajes/echoes solapados y el chequeo SELECT tenía carrera). No se pierde nada (eran duplicados); se limpia el log y se evita doble unread/dispatch.
// v0.9.240 — número real de las líneas en el super-admin: GET /api/admin/tenants/:id/line-info trae el display_phone_number (+591 ...) + verified_name de cada línea consultándolo a Meta por el phone_number_id (la DB a veces guarda solo el nombre, ej "MERCALOTES"). meta.getPhoneNumberInfo.
// v0.9.241 — cambiar contraseña de un usuario del tenant desde el super-admin: el PATCH /api/admin/tenants/:id/users/:userId ahora acepta { password } → bcrypt.hash → password_hash (nunca en texto plano ni en logs). Botón 🔑 por usuario en la tabla Usuarios del detalle. (Reset de clave self-service queda en backlog.)
// v0.9.242 — Reservas: vista DÍA rediseñada tipo agenda (móvil): franja de días arriba (tap para cambiar), grilla horaria con eventos posicionados por hora inicio/fin, columnas para citas solapadas, línea "ahora" y scroll a la hora actual. Default móvil = Día. Citas siguen clickeables (modal in-house / link Cal).
// v0.9.243 — descripción del QR de cobro = "Nombre del tenant + Mes" (ej. "MERCALOTES Junio") en el QR self-service de Mi plan y en el cobro por tenant del super-admin (antes decía "Pago plan SG Ventas <período>"). Helper _monthEs.
// v0.9.244 — (1) el `code` interno del inmueble YA NO se le pasa a la IA en el catálogo (webhook.js + preview): era el "P450" que Aitana nombraba al cliente sin que se lo pidan. (2) prompt INMUEBLES por defecto: al presentar, la respuesta es un lead-in CORTO y NO repite zona/medidas/precio (eso lo muestra la ficha) — evita el texto duplicado con la ficha.
// v0.9.245 — en MÓVIL el header "Configuración de Aitana" (título + subtítulo + Recargar) se OCULTA: la pantalla va directo al contenido (la agenda/calendario), como un calendario nativo. En desktop se mantiene. (El refresco en móvil ya está dentro de Reservas.)
// v0.9.246 — Reservas en MÓVIL: además del header de Config, se ocultan el título/subtítulo de la sección Reservas y el botón "Crear cita" inline → la agenda arranca arriba. "Crear cita" pasa a botón FLOTANTE (FAB) abajo-derecha. El ocultamiento del header de Config ahora usa el breakpoint real del panel (767px), no 640px — por eso antes reaparecía en pantallas medianas.
// v0.9.247 — el FAB de Reservas en MÓVIL ahora es un SPEED-DIAL: al tocarlo se despliega un menú con Crear cita, Calendario, Disponibilidad y Bloqueos. La fila de sub-tabs (Calendario/Disponibilidad/Bloqueos) se OCULTA en móvil (vive en el FAB) — gana espacio para la agenda. En desktop se mantiene la fila de sub-tabs y NO aparece el FAB.
// v0.9.248 — vista SEMANA reescrita como GRILLA tipo calendario (7 columnas lun–dom × horas) con eventos posicionados por hora, solapados en sub-columnas y línea "ahora", igual de prolija que la vista Día (antes era una lista plana que se veía floja/cortada al borde). Cabecera de días con "hoy" en teal; tap en un día abre la vista Día.
// v0.9.249 — (1) la limpieza de Reservas que hicimos en móvil ahora aplica TAMBIÉN en escritorio (todos los anchos): header de Config + intro de Reservas + sub-tabs + "Crear cita" inline ocultos; sub-tabs y Crear cita viven en el FAB speed-dial (en escritorio flota abajo-derecha, sin bottom-nav). (2) FIX vista LISTA: salía "Sin reservas próximas" porque pedía sin rango → ahora pide HOY 00:00 → +60 días, ordenado.
// v0.9.250 — banner de "evento de calidad" de Meta en Campañas: ya NO se dispara por HISTORY_RECEIVED (es el audit de la sync de historial de coexistencia, field='history', NO afecta la cuenta) ni por recuperaciones (UN*, ej. UNFLAGGED). El banner rojo queda SOLO para eventos que realmente afectan la cuenta (FLAGGED/RESTRICTED/etc.). Fix en la query de quality_alert (api.js).
// v0.9.251 — CITA + CHAT PRIORITARIO (perfil asesor): (1) panel de cita PENDIENTE muestra resumen de la conversación + un botón "Tomar cita" (oculta los estados) que reclama, avisa al cliente por WhatsApp con el nombre del asesor ("se va a contactar en breve para coordinar los detalles"), asigna la conversación y ABRE el chat (opción A). (2) al tomar/asignar, la conversación queda FIJADA arriba del inbox (conversations.prioritized_at + 📌) hasta que la oportunidad se marque GANADA/PERDIDA → ahí pasa a ARCHIVADA y se despinea. (3) push de "cita por tomar" robusto: si el filtro por rol no encuentra suscripciones (subs viejas sin user_id), cae a todo el tenant. (4) el ASESOR abre Reservas en SEMANA por defecto. Migración: conversations.prioritized_at.
// v0.9.252 — el push de "Nueva cita por tomar" ahora va a TODAS las suscripciones del tenant (no filtra por rol): si la suscripción del asesor quedó sin user_id, el filtro por rol no la alcanzaba y no le llegaba. + logs del resultado del push (enviados/fallidos) en /bot/book-appointment para diagnosticar.
// v0.9.253 — diagnóstico de push: el broadcast ahora loguea a qué dispositivos va (host del push service + cola del endpoint), para distinguir si el push llega al device del asesor o no. (El server ya enviaba bien: el corte está en la entrega/visualización del dispositivo.)
// v0.9.254 — FIX REAL del push de cita que "no llegaba": la notif de "cita por tomar" usaba el TELÉFONO del cliente como `tag` (igual que las notifs del chat), así que las notificaciones de los mensajes de esa misma conversación la COLAPSABAN/reemplazaban (Samsung no respeta renotify → reemplazo silencioso). Ahora la cita lleva un `tag` ÚNICO ("appt-N") y el service worker respeta `data.tag`. La prueba siempre se veía porque usa otro tag. Aplica a "cita por tomar" y a "cita confirmada".
// v0.9.255 — el fix del push de cita NO debe depender de que el dispositivo actualice el service worker: el push de "cita por tomar" ahora va SIN conversation_phone → en el SW viejo cae al tag genérico (no choca con las notifs del chat) y en el SW nuevo usa el tag único. Antes seguía sin verse porque el SW del device aún no tomaba el data.tag de v0.9.254.
// v0.9.256 — DIAGNÓSTICO CLAVE: la prueba de Perfil es una notif LOCAL (reg.showNotification, siempre anda) y la de Config es el push REAL del server vía FCM (no llegaba) → el corte es la ENTREGA de FCM al device (típico de Samsung en ahorro de batería), no el código. Mejora: el push ahora va con urgency 'high' + TTL 24h (antes 60s) para que FCM lo entregue aunque el equipo esté en doze/restringido. (El fix real definitivo es eximir Chrome/PWA de la optimización de batería en el celular.)
// v0.9.257 — NOTIFICACIÓN LOCAL de "cita por tomar": con la app abierta, el panel detecta cada cita pendiente nueva (poll cada 30s) y dispara reg.showNotification (notif local del SW, la misma que sí funciona en la prueba de Perfil) → no depende de FCM ni de la optimización de batería de Samsung. Para app cerrada queda el push real (urgency alta). Cero pasos de configuración para el usuario.
// v0.9.258 — PROMPT POR LÍNEA + VISIBILIDAD DE INMUEBLES POR LÍNEA. (1) El prompt de Aitana ahora puede tener una versión por LÍNEA: tenant_mode_prompts.line_id (NULL = Default del tenant que heredan todas; =X = override de esa línea), con fallback en la resolución y cache por (tenant+modo+línea). El editor: el dropdown "Editando" ahora lista Default + cada línea (con badge Heredado/Propio, historial por línea, "Volver a heredar"). El MODO sigue siendo uno por organización. (2) Cada inmueble tiene visible_lines: en el modal, checkboxes "¿Qué líneas pueden ver este inmueble?" (sin tildar = todas); el catálogo del bot se filtra por la línea de la conversación. Todo aditivo y retrocompatible (line_id NULL / visible_lines NULL = comportamiento actual).
// v0.9.259 — DASHBOARD MACRO POR LÍNEA en Reportes: una tarjeta por número con conversaciones, leads (calificados/ganados), citas (por tomar/agendadas/realizadas), mensajes in/out y % de conversión, agrupado por conversations.line_id. + AUDITORÍA de aislamiento por tenant/línea: todo OK, y se arregló el autotune de "oportunidades perdidas" que escribía el prompt sin filtrar line_id (habría pisado los overrides de línea) → ahora opera SOLO sobre el Default (line_id IS NULL).
// v0.9.260 — el "Mejorar con IA" del prompt ahora devuelve un RESUMEN de qué entendió la IA y qué cambió (la IA responde "RESUMEN: ... ===PROMPT=== <prompt>"; el backend separa). El panel muestra ese feedback debajo del mejorador + un toggle "Ver cambios exactos" con el diff línea por línea (antes solo se veía que "algo cambió").
// v0.9.261 — FIX prompt por línea en modo SOFTWARE: el override de cada línea se guardaba/leía como el Default (bot_prompt_base, una fila por tenant) → TODAS las líneas compartían el mismo prompt. Ahora el override por línea en software vive en tenant_mode_prompts (mode='software', line_id=X) y el bot lo resuelve en runtime; bot_prompt_base queda como Default heredable. Los demás modos (inmuebles/artículos/servicios/etc.) ya eran por línea desde v0.9.258 — sin cambios.
// v0.9.262 — FIX vista Lista de Reservas (móvil/desktop): las tarjetas ahora muestran el ESTADO (⏳ por asignar en ámbar) y abren el detalle al tocar (openApptModal → permite "Tomar cita"), igual que las vistas Día/Semana/Mes. Antes eran tarjetas muertas sin estado ni click.
// v0.9.263 — FIX fotos "no entregado" (tenant con fotos pesadas): las imágenes se mandan a WhatsApp por URL y Meta NO entrega las que pesan > ~5 MB; el uploader aceptaba hasta 25 MB SIN comprimir. Ahora se comprimen al subir (image-tools.js con sharp: máx 1600px, JPEG q82, <5MB; docs/video/GIF/animadas sin tocar; si sharp falla, sube el original). + script reprocess-images-r2.js para recomprimir las pesadas YA en R2 (misma key → la URL no cambia, la BD no se toca).
// v0.9.264 — RECHAZO de archivos que exceden el límite de Meta, con feedback claro al usuario: media-limits.js (límites por tipo) + middleware metaMediaGuard en TODAS las rutas de subida → video/audio > 16 MB (y demás) se rechazan con 422 + mensaje explicando el por qué. Las IMÁGENES no se rechazan (se comprimen solas, v0.9.263). El error handler global traduce los errores de multer/fileFilter (tamaño/tipo bloqueado) a mensajes amigables en vez de 500.
// v0.9.265 — Super-admin: editar/eliminar pagos registrados a mano. Nuevos endpoints PATCH y DELETE /api/admin/billing-payments/:id (requireAdmin) sobre billing_payments; el resumen de facturación se recalcula solo. (Los BOTONES van en la app super-admin de Netlify, aparte.)
// v0.9.266 — TASA USD→Bs ahora toma el TIPO DE CAMBIO OFICIAL (TCO) del BCB (tco_reporte_ultima_cotizacion.php = promedio ponderado de compra de los bancos, el "tipo de cambio oficial" de la portada) en vez del valor referencial de venta. Parser endurecido (quita tags HTML, anda con el TCO en HTML). Mi plan ahora dice "tipo de cambio oficial del BCB".
// v0.9.267 — la tasa BCB (TCO) ahora muestra la fecha de CONSULTA del dato (cuando el cron lo baja, en hora de Bolivia) en vez de la "fecha de publicación" del BCB que venía con atraso.
// v0.9.268 — DEUDA ACUMULADA: la deuda de cada mes (fijo + consumo − pagado) se acumula mes a mes hasta que se "salda" el mes. Tabla billing_settlements (mes cerrado SIN pago → deja de acumular) + endpoints settle-month + el super-admin muestra "Deuda acumulada" y el botón "Saldar deuda del mes". Gate de trial: los trials NO acumulan (solo el mes actual = sin cambios hoy). NOTA: el cobro al tenant (Mi plan/QR) sigue por período — wiring del cargo acumulado queda como paso siguiente.
// v0.9.269 — COBRO ACUMULADO: el "A pagar" de Mi plan y el monto del QR ahora cobran la DEUDA ACUMULADA (meses no saldados), no solo el mes actual. _amountDueBs y /api/me/billing usan el mismo helper (mismo número). FIX (auditoría): _monthlyExpectedBs ahora filtra líneas activas + usuarios facturables (antes el QR cobraba de más que el "A pagar" mostrado). Gate de trial intacto (trials no acumulan).
// v0.9.270 — al activar un tenant, además del push se manda un WhatsApp al dueño (alert_phone) con el recordatorio de cobro a fin de mes (fijo + consumo IA, ver Mi plan). Best-effort (free-form; fuera de 24h Meta exige plantilla aprobada).
// v0.9.271 — FIX huérfanos de almacenamiento: la detección de "huérfanos" solo miraba properties/services/inventory/media_assets, así que los objetos de catálogos de rubro (salud/belleza/restaurante/vehículos), la media de chat (messages.media_url) y los comprobantes se contaban como huérfanos → el conteo se inflaba y "Purgar huérfanos" los habría BORRADO. Ahora R2_URL_QUERIES incluye todas esas fuentes (purge usa la misma lista → seguro).
const APP_VERSION = 'v0.9.580';
const APP_BUILD_DATE = '2026-07-29';

require('dotenv').config();

// v0.9.30c — Red de seguridad contra crashes por errores async.
// Express 4 NO captura throws dentro de handlers async → unhandled rejection
// → Node mata el proceso → Railway responde 502 a TODO mientras reinicia
// (caso real: encryptToken() con ENCRYPTION_KEY mal seteada al guardar la
// API key de Cal). Logueamos y seguimos vivos; uncaughtException sí reinicia
// (estado impredecible), pero deja el stack en los logs de Railway.
process.on('unhandledRejection', (reason) => {
  console.error('🔥 unhandledRejection (no fatal):', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('🔥 uncaughtException (reiniciando):', err && err.stack ? err.stack : err);
  process.exit(1);
});
const express = require('express');
const cors = require('cors');
const path = require('path');

const webhook = require('./webhook');
const api = require('./api');
const csat = require('./csat'); // v0.9.331 — encuesta de satisfacción (CSAT) BPO
const db = require('./db');
const { resolveTenant } = require('./tenant-resolver'); // Sprint 2

const app = express();
const PORT = process.env.PORT || 3000;

// =============================================================
// Middlewares
// =============================================================

// v0.9.41 — Forzar HTTPS detrás del edge de Railway.
// Railway sirve los dominios también por HTTP plano y NO redirige solo:
// entrar por http:// muestra "No seguro" en Chrome y, peor, el SDK de
// Facebook se niega a abrir el Embedded Signup sobre http → un cliente
// que llegue así no puede conectar su WhatsApp. El edge nos pasa
// x-forwarded-proto: si vino 'http' redirigimos (301 GET, 308 resto,
// que preserva método y body). Los healthchecks internos de Railway no
// traen el header → no se tocan.
app.use((req, res, next) => {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (proto === 'http') {
    const code = (req.method === 'GET' || req.method === 'HEAD') ? 301 : 308;
    return res.redirect(code, `https://${req.headers.host}${req.originalUrl}`);
  }
  if (proto === 'https') {
    // HSTS: el navegador recuerda 1 año que este dominio va siempre por https
    // v0.9.44 (auditoría M-4): + includeSubDomains (app/conectar/audit)
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // v0.9.44 (auditoría M-5): headers de seguridad básicos.
  // nosniff: no adivinar content-types (bloquea servir uploads como HTML).
  // X-Frame-Options: nadie puede meter el panel en un iframe (clickjacking).
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// v0.9.47 (auditoría M-3): CORS restringido a dominios propios (antes '*').
// Requests sin Origin (n8n, curl, healthchecks, apps nativas) pasan igual.
// v0.9.60: + panel de cobros super-admin (Netlify), que el hardening dejó afuera
// (CORS bloqueaba el preflight → "Failed to fetch" al entrar). Y para no tocar
// código la próxima vez: CORS_EXTRA_ORIGINS (env, hostnames separados por coma).
const CORS_ALLOW = [
  /(^|\.)sg-ventas\.com$/i,
  /\.up\.railway\.app$/i,
  /^https?:\/\/localhost(:\d+)?$/i,
  /^crm-aitana-admin-panel\.netlify\.app$/i, // panel de cobros v0.2.x
];
const CORS_EXTRA = String(process.env.CORS_EXTRA_ORIGINS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    let host = origin;
    try { host = new URL(origin).hostname; } catch (e) {}
    const allowed = CORS_ALLOW.some(rx => rx.test(host) || rx.test(origin)) ||
      CORS_EXTRA.includes(String(host).toLowerCase());
    cb(null, allowed);
  },
  credentials: false,
}));

// Capturar rawBody para verificación de firma de Meta
// v0.9.45 (auditoría A-7): 2mb alcanza para webhooks y broadcasts (los archivos
// van por multer, que tiene su propio límite de 25mb) — antes 10mb = DoS de memoria.
app.use(express.json({
  limit: '2mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));

// Logging básico
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    console.log(`${req.method} ${req.url} → ${res.statusCode} (${dur}ms)`);
  });
  next();
});

// =============================================================
// Rutas
// =============================================================

// Health check (sin auth)
app.get('/ping', (req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    version: APP_VERSION,
    build: APP_BUILD_DATE,
  });
});

// v0.9.64: la API NUNCA debe cachearse — Cloudflare estaba cacheando GETs de
// /api/* en el dominio (p.ej. /api/version servía una versión de un día antes,
// /api/auth/config devolvía config vieja). no-store le dice a CF y al browser
// que ni guarden ni sirvan copias. (Igual conviene una Cache Rule "Bypass"
// para /api/* en Cloudflare — esto es el cinturón, aquello los tiradores.)
// v0.9.67 (auditoría 12-jun P1#16): movido ARRIBA de /api/version y /api/admin/me
// — registrado después, justo esas dos rutas quedaban fuera del no-store.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Endpoint dedicado para versión (sin auth)
// v0.9.67: sin process.version (P2 auditoría — no exponer versión de Node)
app.get('/api/version', (req, res) => {
  res.json({
    service: 'sg-ventas-api',
    version: APP_VERSION,
    build: APP_BUILD_DATE,
  });
});

// =============================================================
// SPRINT 2: Endpoint de validación del tenant-resolver
// =============================================================

/**
 * GET /api/admin/me
 * Devuelve info del tenant resuelto por el token.
 * Útil para que el panel sepa qué tenant es, y para debugging.
 */
app.get('/api/admin/me', resolveTenant, (req, res) => {
  res.json({
    tenant: {
      id: req.tenant.id,
      slug: req.tenant.slug,
      name: req.tenant.name,
      plan: req.tenant.plan,
      active: req.tenant.active,
      billing_status: req.tenant.billing_status,
      read_only: req.tenant.read_only,
      meta_phone_number_id: req.tenant.meta_phone_number_id,
      waba_id: req.tenant.waba_id,
    },
    server_version: APP_VERSION,
    resolved_at: new Date().toISOString(),
  });
});

// Webhook de Meta
app.get('/api/meta/webhook', webhook.verifyWebhook);
app.post('/api/meta/webhook', webhook.handleWebhook);

// Webhook de Telegram (v0.9.281) — un secret por bot en el path
app.post('/api/telegram/webhook/:secret', webhook.handleTelegramWebhook);

// Endpoints internos (n8n + admin)
app.use('/api', api);

// Endpoints de configuración dinámica del bot (admin + n8n)
const botConfigApi = require('./api-bot-config');
app.use('/api', botConfigApi);

// v0.7.22: Módulo Follow-up automático
const followUpApi = require('./follow-up/follow-up-routes');
app.use('/api', followUpApi);

// v0.9.6: Módulo Onboarding (Meta Embedded Signup)
const onboardingApi = require('./onboarding');
app.use('/api', onboardingApi);

// v0.9.8: Login con Facebook (auth de clientes al panel)
const authModule = require('./auth');
app.use('/api', authModule.router);

// v0.9.427 — Sync automático 21Online → catálogo de inmuebles (config + run-now)
// v0.9.428 — FIX panel: 'esc is not defined' al abrir el modal Sync 21Online; prompt INMUEBLES: prohibido anunciar fotos que no están en la lista photos (sin excusas de 'falla del sistema'), pivote honesto a visita.
// v0.9.429 — FIX modal Sync 21Online invisible (faltaba el wrapper fixed inset-0 → showModal lo inyectaba sin overlay); SYNC C21 ahora captura al ASESOR DE CAPTACIÓN por propiedad (nombre/celular/email desde la ficha de detalle, backfill en 2do plano con tope C21_ADVISOR_CAP=800/corrida) → assigned_agent_name + directorio c21_agents (nueva col email).
// v0.9.430 — Modal Sync 21Online: errores con MOTIVO real (run endpoint responde 200 ok:false en vez de 502, que api() convertía en null → 'Falló' seco) + validación previa de usuario/contraseña y aborto si el guardado falla.
// v0.9.431 — P0 batería 14-jul: CATÁLOGO POR RELEVANCIA. selectRelevantProperties (catalog-matcher) reemplaza el ORDER BY updated_at LIMIT 200 en webhook.js y test-message: con search_profile viajan los top 40 relevantes + 20 recientes (sin fuera-de-presupuesto); sin perfil, recencia como siempre. Panel de test acumula search_profile (paridad prod) y el catálogo de test ahora trae photos.
// v0.9.432 — Batería 14-jul (resto): calendario real en test-message (B-05, agendaba 2025; en prod ya iba por el enriquecimiento con phone); regla 📷 no describe el lugar al negar una foto (B-03 'camino transitable'); prohibido 'dejame verificar y te aviso' (B-06).
// v0.9.433 — HOTFIX selección por relevancia: pool 3.000 < 3.803 del sync (updated_at empatado → orden arbitrario) dejaba propiedades invisibles; pool 10.000 + cache 60s por tenant+línea (CATALOG_POOL_TTL_MS).
// v0.9.434 — 'Mantener sesión iniciada' (checkbox en el login, desktop+móvil por igual: el JWT vive en localStorage): opt-in JWT 30d (env JWT_REMEMBER_TTL) vs 24h default de A-5.
// v0.9.435 — TEXTURA HUMANA en el texto del bot (pedido 16-jul): sin muletillas de manual, menos signos, 1 typo sutil máx/conversación con candados (jamás en precios/fechas/nombres/citas). Flag tenants.humanize_text (default ON) + env HUMANIZE_TEXT=0.
// v0.9.436 — FIX scorer (raíz de B-01/B-02/B-04): normaliza operación (compra→venta, renta→alquiler) y DESCALIFICA mismatch venta/alquiler; el tipo pedido ('quinta') también matchea contra el título (el mapeo C21 lo convertía en type='casa' y nunca calzaba).
// v0.9.437 — Panel lead: dimensión P del Straight Line se llama '📦 Producto' en todos los modos; fix heurística _veh (attributes.tipo NO es señal de vehículo — inmuebles también usa tipo) que mostraba 'Vehículo/Compra-pago/Ciudad' en leads inmobiliarios.
// v0.9.438 — Sync C21 resiliente a parpadeos de red: reintentos con backoff (3x, 5-10-15s) en login, páginas del feed y detalle de asesor ante ENOTFOUND/ECONNRESET/ETIMEDOUT/EAI_AGAIN (caso 20-jul: getaddrinfo ENOTFOUND transitorio tumbó la corrida).
// v0.9.439 — IA SOLO PARA ANUNCIOS (F1): captura messages[].referral (CTWA, incl. ctwa_clid p/ atribución futura) → conversations.referral+ai_origin; alcance de IA 'all'|'ads_only' por tenant (master) y por línea (override); gate en webhook: chat orgánico en ads_only → humano silencioso, pegajoso, con promoción a bot si toca un anuncio; selector en menú IA + badge 📣 en header del chat.
// v0.9.440 — ADS F2: match anuncio↔inmueble (matchAdToProperty: tokens título×3 + descripción + zona + precio exacto; umbral conservador) → conversations.ad_property_id; el inmueble del anuncio viaja SIEMPRE primero en el catálogo del prompt; bloque 📣 en builder: primer turno = confirmar interés + ficha de ESE inmueble + Straight Line hacia la cita; sin match claro → preguntar.
// v0.9.441 — Inbox: filtro de Línea muestra SIEMPRE número + nombre (antes 'Principal' salía sin número).
// v0.9.442 — Alcance solo-anuncios × CAMPAÑAS: conversaciones creadas por un broadcast quedan con ai_origin='campaign' y el gate las deja al BOT (la campaña es un envío deliberado del negocio); chats que ya eran 'organic' (personales) se respetan y siguen humanos aunque reciban la campaña.
// v0.9.443 — Header del chat: badge 📨 para conversaciones nacidas de una campaña saliente del CRM (complementa el 📣 de anuncios).
// v0.9.444 — Badge 📨 con NOMBRE de la campaña: runBroadcast estampa conversations.origin_campaign (COALESCE name/template_name) en las convs nacidas del broadcast.
// v0.9.445 — CARPETAS DE CATÁLOGO + DESTACADAS: properties.category (auto desde el subtipo C21 en el sync — quinta/ganaderas/penthouse ya no caen en «otro»; mover a mano la marca en manual_fields y el sync la respeta) + properties.featured (⭐ orden en panel + bonus suave en el matcher); chips con conteo real y filtro server-side; endpoint /admin/properties-categories.
// v0.9.446 — Filtros por características en Inmuebles (server-side sobre toda la base): operación, dormitorios+, baños+, m² mín, precio máx; fila compacta bajo los chips de carpetas.
// v0.9.447 — POST /admin/properties-categorize: auto-clasificación por palabras clave de las propiedades SIN carpeta (una vez); el sync C21 refina después con el subtipo oficial.
// v0.9.448 — HOTFIX chips de carpetas: comillas de JSON.stringify rompían el onclick (no filtraba) → &quot;.
// v0.9.449 — UX filtros de Inmuebles: el grid no se borra al recargar (atenuado en su lugar) y el scroll se queda donde estaba.
// v0.9.450 — Filtro por Ciudad/Zona en Inmuebles (select con conteos reales, server-side).
// v0.9.451 — Filtro geográfico SEPARADO: Depto. (properties.state, nuevo — el municipio de C21 es la ZONA y la ciudad real es el estado del feed; el sync lo persiste) + Zona. El select de Depto aparece cuando hay datos (tras el primer sync post-deploy).
const c21Sync = require('./c21-sync');
app.use('/api', c21Sync.router);

// v0.9.495 — Conector de Claude (MCP remoto): los asesores cargan y consultan el
// catálogo conversando con su propia cuenta de Claude (URL: https://app.sg-ventas.com/mcp).
const mcpServer = require('./mcp-server');
app.use('/mcp', mcpServer.router);

// v0.9.512 — Link de subida de fotos. Va montado en la RAÍZ (/subir/:token) y no
// bajo /api porque el asesor abre esta URL a mano en el celular: cuanto más corta,
// mejor. Es público sin sesión — el token es la credencial (ver upload-links.js).
const uploadLinks = require('./upload-links');
app.use('/', uploadLinks.router);

// v0.9.25: Facturación para el panel super-admin (overview, cobros, packs).
// Solo super-admin (X-Admin-Token), mismo criterio que /api/admin/tenants.
function requireSuperAdminToken(req, res, next) {
  const token = String(req.headers['x-admin-token'] || req.query.token || '');
  const expected = process.env.ADMIN_TOKEN;
  // v0.9.44 (auditoría C-2): comparación en tiempo constante
  const crypto = require('crypto');
  const ok = expected && token &&
    crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(),
                           crypto.createHash('sha256').update(expected).digest());
  if (!ok) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
require('./admin-billing-routes-v0925')(app, { requireAdmin: requireSuperAdminToken });

// Página pública de onboarding (Embedded Signup)
app.use('/onboarding', express.static(path.join(__dirname, 'onboarding-page')));

// v0.9.165 — Página pública del AGENDADOR PROPIO. El lead abre /agendar/<token> (link
// que manda Aitana), elige un slot libre del vendedor y la cita se guarda en appointments.
// v0.9.327 — Página PÚBLICA de reseteo de contraseña (link generado por el dueño).
// El token viaja en ?token= y se lee del lado del cliente (sin interpolación server-side).
app.get('/reset', (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nueva contraseña — SG Ventas</title>
<style>
  :root{--tq:#14b8c4;--tq2:#0e8a93;--bg:#0f1720;--card:#172230;--mut:#8aa0b2;--bd:#27384a;--txt:#eaf2f7}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:440px;margin:0 auto;padding:36px 18px 40px}
  .hd{display:flex;align-items:center;gap:11px;margin-bottom:14px}
  .logo{width:42px;height:42px;border-radius:12px;background:linear-gradient(135deg,var(--tq),var(--tq2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:18px}
  h1{font-size:20px;margin:0} .sub{color:var(--mut);font-size:13px;margin:2px 0 18px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px}
  label{display:block;font-size:12px;color:var(--mut);margin:12px 0 5px}
  input{width:100%;background:#0f1a24;border:1px solid var(--bd);color:var(--txt);border-radius:10px;padding:12px;font-size:15px}
  .btn{width:100%;margin-top:18px;background:linear-gradient(135deg,var(--tq),var(--tq2));color:#fff;border:0;border-radius:11px;padding:13px;font-size:16px;font-weight:700;cursor:pointer}
  .btn:disabled{opacity:.5;cursor:default}
  .err{color:#fca5a5;font-size:13px;margin-top:10px;min-height:16px}
  .ok{text-align:center;padding:26px 8px} .ok .big{font-size:46px}
  .hint{color:var(--mut);font-size:12px;margin-top:10px}
</style></head><body><div class="wrap" id="app"><div class="card"><div class="sub">Cargando…</div></div></div>
<script>
  var Q = new URLSearchParams(location.search);
  var TOKEN = Q.get('token') || '';
  var API = location.origin + '/api/public';
  var app = document.getElementById('app');
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function invalid(){ app.innerHTML = '<div class="hd"><div class="logo">SG</div><h1>Link no válido</h1></div><div class="card"><div class="err" style="min-height:auto">Este link no es válido o ya expiró. Pedile uno nuevo al dueño de tu cuenta.</div></div>'; }
  function done(){ app.innerHTML = '<div class="card ok"><div class="big">✅</div><h1>¡Listo!</h1><p class="sub">Tu contraseña quedó actualizada. Ya podés cerrar esta página y entrar al panel con tu nueva clave.</p></div>'; }
  function form(name){
    app.innerHTML = '<div class="hd"><div class="logo">SG</div><div><h1>Nueva contraseña</h1></div></div>'
      + '<div class="sub">' + (name ? ('Hola, ' + esc(name) + '. ') : '') + 'Elegí tu contraseña para entrar al panel.</div>'
      + '<div class="card">'
      + '<label>Nueva contraseña</label><input id="p1" type="password" autocomplete="new-password" placeholder="mínimo 8 caracteres">'
      + '<label>Repetir contraseña</label><input id="p2" type="password" autocomplete="new-password" placeholder="repetila">'
      + '<button class="btn" id="go">Guardar contraseña</button>'
      + '<div class="err" id="err"></div>'
      + '<div class="hint">El link vence en 1 hora y se usa una sola vez.</div>'
      + '</div>';
    document.getElementById('go').addEventListener('click', submit);
    document.getElementById('p2').addEventListener('keydown', function(e){ if(e.key==='Enter') submit(); });
  }
  function submit(){
    var p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
    var err = document.getElementById('err'), btn = document.getElementById('go');
    err.textContent = '';
    if (p1.length < 8) { err.textContent = 'La contraseña debe tener al menos 8 caracteres.'; return; }
    if (p1 !== p2) { err.textContent = 'Las contraseñas no coinciden.'; return; }
    btn.disabled = true; btn.textContent = 'Guardando…';
    fetch(API + '/reset-password', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token: TOKEN, password: p1 }) })
      .then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
      .then(function(x){ if (x.ok && x.j && x.j.ok) { done(); } else { btn.disabled=false; btn.textContent='Guardar contraseña'; err.textContent = (x.j && x.j.error) || 'No se pudo actualizar.'; } })
      .catch(function(){ btn.disabled=false; btn.textContent='Guardar contraseña'; err.textContent='Error de red. Probá de nuevo.'; });
  }
  if (!TOKEN) { invalid(); }
  else {
    fetch(API + '/reset-info?token=' + encodeURIComponent(TOKEN))
      .then(function(r){ return r.json(); })
      .then(function(j){ if (j && j.valid) form(j.name); else invalid(); })
      .catch(function(){ invalid(); });
  }
</script></body></html>`);
});

// =====================================================================
// v0.9.340 — FICHA PÚBLICA de propiedad (mini-landing compartible).
// Link: /ficha/<id>-<firma HMAC de 10 hex> — sin migración ni tokens en DB, no enumerable.
// Pensada para compartir por WhatsApp/redes (trae OG tags → preview con foto).
// Solo muestra propiedades ACTIVAS; CTA = WhatsApp de la línea principal del tenant.
// =====================================================================
const _fichaCrypto = require('crypto');
function fichaSign(id) {
  const secret = process.env.JWT_SECRET || process.env.N8N_SHARED_SECRET || 'sg-ventas-ficha';
  return _fichaCrypto.createHmac('sha256', secret).update('ficha:' + String(id)).digest('hex').slice(0, 10);
}
app.locals.fichaSign = fichaSign; // api.js lo usa para generar el link desde el panel

app.get('/ficha/:token', async (req, res) => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const m = String(req.params.token || '').match(/^(\d+)-([a-f0-9]{10})$/);
  const notFound = () => res.status(404).set('Content-Type', 'text/html; charset=utf-8').send('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ficha no disponible</title></head><body style="margin:0;background:#0f1720;color:#eaf2f7;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;"><div><div style="font-size:52px;">🏠</div><h1 style="font-size:20px;">Esta ficha ya no está disponible</h1><p style="color:#8aa0b2;font-size:14px;">El inmueble pudo haberse vendido o retirado de la oferta.</p></div></body></html>');
  if (!m || fichaSign(m[1]) !== m[2]) return notFound();
  try {
    const db = require('./db');
    const pr = await db.query('SELECT * FROM properties WHERE id = $1 AND active = TRUE', [parseInt(m[1])]);
    const p = pr.rows[0];
    if (!p) return notFound();
    const tr = await db.query('SELECT name FROM tenants WHERE id = $1', [p.tenant_id]).catch(() => ({ rows: [] }));
    const business = (tr.rows[0] && tr.rows[0].name) || 'Inmobiliaria';
    const lr = await db.query('SELECT display_phone FROM tenant_lines WHERE tenant_id = $1 ORDER BY is_default DESC NULLS LAST, id ASC LIMIT 1', [p.tenant_id]).catch(() => ({ rows: [] }));
    const waDigits = String((lr.rows[0] && lr.rows[0].display_phone) || '').replace(/[^0-9]/g, '');
    const imgs = Array.isArray(p.image_urls) ? p.image_urls.filter(Boolean) : [];
    const price = (p.price != null) ? `${p.currency || 'USD'} ${Number(p.price).toLocaleString('es-BO', { maximumFractionDigits: 0 })}` : 'Consultar precio';
    const OP = { venta: 'En venta', alquiler: 'En alquiler', anticretico: 'Anticrético' };
    const chips = [OP[p.operation] || p.operation, p.type, p.zone].filter(Boolean);
    const specs = [
      p.area_m2 != null ? ['📐', `${Number(p.area_m2).toLocaleString('es-BO')} m²`] : null,
      p.bedrooms != null ? ['🛏', `${p.bedrooms} dorm.`] : null,
      p.bathrooms != null ? ['🚿', `${p.bathrooms} baños`] : null,
      p.garages != null ? ['🚗', `${p.garages} parqueos`] : null,
    ].filter(Boolean);
    const waText = encodeURIComponent(`Hola! Vi la ficha de "${p.title}"${p.code ? ' (cod ' + p.code + ')' : ''} y quiero más información.`);
    const waHref = waDigits ? `https://wa.me/${waDigits}?text=${waText}` : null;
    const pageUrl = `${process.env.PUBLIC_BASE_URL || 'https://app.sg-ventas.com'}/ficha/${m[1]}-${m[2]}`;
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.title)} — ${esc(business)}</title>
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc([price].concat(chips).join(' · '))}">
${imgs[0] ? `<meta property="og:image" content="${esc(imgs[0])}">` : ''}
<meta property="og:url" content="${esc(pageUrl)}"><meta property="og:type" content="website">
<style>
  :root{--tq:#14b8c4;--tq2:#0e8a93;--bg:#0f1720;--card:#172230;--mut:#8aa0b2;--bd:#27384a;--txt:#eaf2f7}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:0 0 96px}
  .gal{display:flex;overflow-x:auto;scroll-snap-type:x mandatory;gap:2px;background:#000}
  .gal img{width:100%;max-width:560px;height:300px;object-fit:cover;flex-shrink:0;scroll-snap-align:center}
  .noimg{height:200px;display:flex;align-items:center;justify-content:center;font-size:56px;background:var(--card)}
  .body{padding:18px}
  h1{font-size:21px;margin:0 0 6px;line-height:1.3}
  .price{font-size:24px;font-weight:800;color:var(--tq);margin:4px 0 10px}
  .chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .chip{background:var(--card);border:1px solid var(--bd);border-radius:999px;padding:4px 11px;font-size:12.5px;color:var(--mut);text-transform:capitalize}
  .specs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:0 0 16px}
  .spec{background:var(--card);border:1px solid var(--bd);border-radius:12px;padding:10px 12px;font-size:13.5px}
  .desc{font-size:14.5px;line-height:1.65;color:#c9d6e0;white-space:pre-wrap;margin-bottom:16px}
  .maps{display:inline-block;color:var(--tq);font-size:14px;margin-bottom:8px}
  .biz{color:var(--mut);font-size:12.5px;border-top:1px solid var(--bd);padding-top:14px;margin-top:6px}
  .cta{position:fixed;bottom:0;left:0;right:0;padding:12px 16px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(to top, var(--bg) 65%, transparent)}
  .cta a{display:flex;align-items:center;justify-content:center;gap:8px;max-width:560px;margin:0 auto;background:linear-gradient(135deg,#22c55e,#128c7e);color:#fff;text-decoration:none;font-weight:800;font-size:16.5px;padding:15px;border-radius:14px;box-shadow:0 6px 22px rgba(18,140,126,.45)}
</style></head><body><div class="wrap">
  ${imgs.length ? `<div class="gal">${imgs.map((u) => `<img src="${esc(u)}" alt="${esc(p.title)}" loading="lazy">`).join('')}</div>` : '<div class="noimg">🏠</div>'}
  <div class="body">
    <h1>${esc(p.title)}</h1>
    <div class="price">${esc(price)}</div>
    <div class="chips">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}${p.code ? `<span class="chip">cod ${esc(p.code)}</span>` : ''}</div>
    ${specs.length ? `<div class="specs">${specs.map((s) => `<div class="spec">${s[0]} ${esc(s[1])}</div>`).join('')}</div>` : ''}
    ${p.description ? `<div class="desc">${esc(p.description)}</div>` : ''}
    ${p.maps_url ? `<a class="maps" href="${esc(p.maps_url)}" target="_blank" rel="noopener">📍 Ver ubicación en Google Maps</a>` : ''}
    <div class="biz">Publicado por <b>${esc(business)}</b> · Ficha generada con SG Ventas</div>
  </div>
</div>
${waHref ? `<div class="cta"><a href="${esc(waHref)}">💬 Consultar por WhatsApp</a></div>` : ''}
</body></html>`);
  } catch (e) {
    console.error('[ficha] error:', e.message);
    return notFound();
  }
});

app.get('/agendar/:token', (req, res) => {
  const token = String(req.params.token || '').replace(/[^a-zA-Z0-9]/g, '');
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agendar visita</title>
<style>
  :root{--tq:#14b8c4;--tq2:#0e8a93;--bg:#0f1720;--card:#172230;--mut:#8aa0b2;--bd:#27384a;--txt:#eaf2f7}
  *{box-sizing:border-box} body{margin:0;background:var(--bg);color:var(--txt);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:520px;margin:0 auto;padding:20px 16px 40px}
  .hd{display:flex;align-items:center;gap:10px;margin-bottom:6px}
  .logo{width:40px;height:40px;border-radius:11px;background:linear-gradient(135deg,var(--tq),var(--tq2));display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff}
  h1{font-size:19px;margin:0} .sub{color:var(--mut);font-size:13px;margin:2px 0 16px}
  .day{margin:16px 0 6px;font-weight:700;font-size:14px}
  .slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px}
  .slot{background:var(--card);border:1px solid var(--bd);color:var(--txt);border-radius:10px;padding:10px 6px;font-size:14px;cursor:pointer}
  .slot.sel{background:var(--tq);border-color:var(--tq);color:#04222a;font-weight:700}
  .muted{color:var(--mut);font-size:13px;padding:24px 0;text-align:center}
  .form{margin-top:18px;background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:14px}
  label{display:block;font-size:12px;color:var(--mut);margin:8px 0 4px}
  input{width:100%;background:#0f1a24;border:1px solid var(--bd);color:var(--txt);border-radius:10px;padding:11px;font-size:15px}
  .btn{width:100%;margin-top:14px;background:linear-gradient(135deg,var(--tq),var(--tq2));color:#fff;border:0;border-radius:11px;padding:13px;font-size:16px;font-weight:700;cursor:pointer}
  .btn:disabled{opacity:.5} .ok{text-align:center;padding:30px 10px} .ok .big{font-size:46px}
  .err{color:#fca5a5;font-size:13px;margin-top:8px;min-height:16px}
</style></head><body><div class="wrap" id="app"><div class="muted">Cargando agenda…</div></div>
<script>
  var TOKEN=${JSON.stringify(token)};
  var API=location.origin+'/api/public/booking/'+TOKEN;
  var Q=new URLSearchParams(location.search); // v0.9.169: autollenado de nombre/WhatsApp desde el link
  var st={data:null,sel:null,name:Q.get('n')||'',phone:Q.get('p')||''};
  var DOW=['dom','lun','mar','mié','jue','vie','sáb'];
  var MON=['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'];
  function local(iso,off){return new Date(new Date(iso).getTime()+off*60000);}
  function hhmm(d){var h=d.getUTCHours(),m=d.getUTCMinutes();return (h<10?'0':'')+h+':'+(m<10?'0':'')+m;}
  function dlabel(d){return DOW[d.getUTCDay()]+' '+d.getUTCDate()+' '+MON[d.getUTCMonth()];}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}
  function render(){
    var d=st.data,off=d.tz_offset_min||-240;
    var h='<div class="hd"><div class="logo">'+esc(((d.business||'S')[0]||'S').toUpperCase())+'</div><div><h1>Agendá tu visita</h1><div class="sub">con '+esc(d.seller)+' · '+esc(d.business)+'</div></div></div>';
    if(!d.slots||!d.slots.length){h+='<div class="muted">No hay horarios disponibles por ahora. Escribinos por WhatsApp y coordinamos.</div>';document.getElementById('app').innerHTML=h;return;}
    var byday={},order=[];
    d.slots.forEach(function(iso){var dl=local(iso,off);var key=dl.getUTCFullYear()+'-'+dl.getUTCMonth()+'-'+dl.getUTCDate();if(!byday[key]){byday[key]={label:dlabel(dl),items:[]};order.push(key);}byday[key].items.push(iso);});
    order.forEach(function(k){h+='<div class="day">'+byday[k].label+'</div><div class="slots">';byday[k].items.forEach(function(iso){h+='<button class="slot'+(st.sel===iso?' sel':'')+'" data-iso="'+iso+'">'+hhmm(local(iso,off))+'</button>';});h+='</div>';});
    h+='<div class="form" id="form" style="'+(st.sel?'':'display:none')+'"><label>Tu nombre</label><input id="nm" placeholder="Nombre y apellido"><label>WhatsApp (opcional)</label><input id="ph" inputmode="tel" placeholder="Tu número"><button class="btn" id="go">Confirmar visita</button><div class="err" id="er"></div></div>';
    var app=document.getElementById('app');app.innerHTML=h;
    [].forEach.call(app.querySelectorAll('.slot'),function(b){b.onclick=function(){st.sel=b.getAttribute('data-iso');render();var f=document.getElementById('form');if(f)f.scrollIntoView({behavior:'smooth'});};});
    var go=document.getElementById('go');if(go)go.onclick=book;
    var nmI=document.getElementById('nm'),phI=document.getElementById('ph');
    if(nmI){nmI.value=st.name||'';nmI.oninput=function(){st.name=nmI.value;};}
    if(phI){phI.value=st.phone||'';phI.oninput=function(){st.phone=phI.value;};}
  }
  function book(){
    var nm=(document.getElementById('nm').value||'').trim(),ph=(document.getElementById('ph').value||'').trim(),er=document.getElementById('er');
    if(!nm){er.textContent='Poné tu nombre';return;}
    var go=document.getElementById('go');go.disabled=true;go.textContent='Confirmando…';er.textContent='';
    fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:nm,phone:ph,start:st.sel})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j};});}).then(function(x){
      if(!x.ok||x.j.error){er.textContent=x.j.error||'No se pudo agendar';go.disabled=false;go.textContent='Confirmar visita';if(x.j.error&&/disponible|ocup/.test(x.j.error))load();return;}
      var dl=local(x.j.start,st.data.tz_offset_min||-240);
      document.getElementById('app').innerHTML='<div class="ok"><div class="big">✅</div><h1>¡Listo, '+esc(nm)+'!</h1><div class="sub">Tu visita con '+esc(st.data.seller)+' quedó agendada para<br><b>'+dlabel(dl)+' '+hhmm(dl)+' hs</b>.</div></div>';
    }).catch(function(){er.textContent='Error de red, reintentá';go.disabled=false;go.textContent='Confirmar visita';});
  }
  function load(){fetch(API).then(function(r){return r.json();}).then(function(j){if(j.error){document.getElementById('app').innerHTML='<div class="muted">'+esc(j.error)+'</div>';return;}st.data=j;st.sel=null;render();}).catch(function(){document.getElementById('app').innerHTML='<div class="muted">No se pudo cargar la agenda.</div>';});}
  load();
</script></body></html>`);
});

// v0.9.355 — sw.js e index.html del panel SIEMPRE frescos (no-store). Sin esto el
// browser (sobre todo el móvil/PWA) cachea por heurística y puede alternar entre el
// sw.js viejo y el nuevo → el banner "Actualizar" reaparece en loop aunque lo toques.
// Los demás estáticos (íconos, manifest) sí pueden cachear.
app.use('/panel', (req, res, next) => {
  const p = req.path || '';
  if (p === '/' || p === '' || p.endsWith('sw.js') || p.endsWith('index.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});
// Servir el panel admin estático (cuando panel/ está dentro de backend/)
app.use('/panel', express.static(path.join(__dirname, 'panel')));
// Fallback: panel/ al lado de backend/ (estructura original)
app.use('/panel', express.static(path.join(__dirname, '..', 'panel')));

// Root — redirección por hostname (v0.9.6)
//   conectar.sg-ventas.com/  → /onboarding (landing de onboarding de clientes)
//   app.sg-ventas.com/        → /panel/     (panel de gestión)
//   cualquier otro host        → página informativa de la API
app.get('/', (req, res) => {
  const host = (req.hostname || req.headers.host || '').toLowerCase();

  // Subdominio de onboarding → landing de Embedded Signup
  if (host.startsWith('conectar.')) {
    return res.redirect(302, '/onboarding');
  }

  // Subdominio del panel → panel admin
  if (host.startsWith('app.')) {
    return res.redirect(302, '/panel/');
  }

  // v0.9.8: Subdominio de auditoría (super-admin) → mismo panel.
  // El panel detecta el hostname 'audit.' y activa modo super-admin.
  if (host.startsWith('audit.')) {
    return res.redirect(302, '/panel/');
  }

  // Default (URL de Railway u otros): página informativa
  res.send(`
    <h1>SG Ventas API ${APP_VERSION}</h1>
    <p>Status: <strong>OK</strong></p>
    <p>Build: ${APP_BUILD_DATE}</p>
    <ul>
      <li><a href="/ping">Health check</a></li>
      <li><a href="/api/version">Versión completa</a></li>
      <li><a href="/panel/">Panel admin</a></li>
      <li><a href="/onboarding">Onboarding</a></li>
    </ul>
  `);
});

// v0.9.52: CLICK TRACKING — redirección corta de campañas.
// app.sg-ventas.com/r/<code> registra el clic (1ra vez marca clicked_at) y
// redirige a la URL destino. Público por diseño (lo abre el cliente final).
app.get('/r/:code', async (req, res) => {
  try {
    // v0.9.69 (auditoría 12-jun P1#11): rate limit por IP — cada hit hace un
    // UPDATE; sin esto un bot infla los contadores de clics gratis.
    const { rateLimitOk, clientIp } = require('./auth');
    if (!rateLimitOk('rlink:' + clientIp(req), 30, 60 * 1000)) {
      return res.redirect(302, '/');
    }
    const code = String(req.params.code || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    if (!code) return res.redirect(302, '/');
    const r = await db.query(
      `UPDATE tracked_links
         SET clicks = clicks + 1, clicked_at = COALESCE(clicked_at, NOW())
       WHERE code = $1 RETURNING url`,
      [code]
    );
    if (!r.rows.length || !/^https?:\/\//i.test(r.rows[0].url || '')) return res.redirect(302, '/');
    return res.redirect(302, r.rows[0].url);
  } catch (e) {
    return res.redirect(302, '/');
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handler
app.use((err, req, res, next) => {
  // v0.9.264: errores de subida (multer / fileFilter) → mensaje claro al usuario, no 500.
  try {
    const { multerErrorMessage } = require('./media-limits');
    const msg = multerErrorMessage(err);
    if (msg) return res.status(422).json({ error: msg });
  } catch (_) { /* sigue al 500 genérico */ }
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// =============================================================
// Boot
// =============================================================

(async () => {
  try {
    // Verificar conexión a BD
    const r = await db.query('SELECT NOW() AS now');
    console.log('✅ PostgreSQL conectado:', r.rows[0].now);
  } catch (e) {
    console.error('❌ Error conectando a PostgreSQL:', e.message);
    console.error('Verifica DATABASE_URL en variables de entorno');
    process.exit(1);
  }

  // v0.9.161: asegurar el esquema de platform_tickets en el boot (defensa por si la
  // migración no corrió o la tabla preexistía con otro esquema). No bloquea el arranque.
  if (typeof api.ensurePlatformTicketsSchema === 'function') {
    api.ensurePlatformTicketsSchema().catch(e => console.error('ensurePlatformTicketsSchema boot:', e.message));
  }

  // v0.9.46: worker de campañas programadas — cada 60s dispara las que vencieron.
  // Autónomo (no depende de cron externo); la toma atómica con SKIP LOCKED evita
  // doble ejecución si hubiera más de una instancia.
  if (typeof api.runDueCampaigns === 'function') {
    setInterval(() => { api.runDueCampaigns().catch(e => console.error('runDueCampaigns interval:', e.message)); }, 60 * 1000);
    setTimeout(() => { api.runDueCampaigns().catch(() => {}); }, 15000); // primer pase a los 15s del boot
  }

  // v0.9.274 — CRON trial→pago: convierte los trials vencidos (trial_ends_at <= now) a cuenta de pago,
  // fija la fecha de corte (billing_anchor_at) y dispara el aviso. Diario (chequea 1×/día); primer pase
  // a los 5 min del boot. Solo toca cuentas con trial_ends_at seteado (altas nuevas por el connect).
  if (typeof api.runTrialConversions === 'function') {
    setInterval(() => { api.runTrialConversions().catch(e => console.error('runTrialConversions interval:', e.message)); }, 24 * 60 * 60 * 1000);
    setTimeout(() => { api.runTrialConversions().catch(() => {}); }, 5 * 60 * 1000);
  }

  // v0.9.276: HEALTH CHECK de líneas Meta — valida cada línea activa contra Meta (getPhoneNumberInfo)
  // y ALERTA a José (push + WhatsApp) cuando una CAE. Cada 2h; primer pase a los 2 min del boot para
  // reflejar el estado real ni bien arranca (reemplaza el falso verde "token configurado").
  if (typeof api.runMetaHealthChecks === 'function') {
    setInterval(() => { api.runMetaHealthChecks().catch(e => console.error('runMetaHealthChecks interval:', e.message)); }, 2 * 60 * 60 * 1000);
    setTimeout(() => { api.runMetaHealthChecks().catch(() => {}); }, 2 * 60 * 1000);
  }
  // v0.9.313 — auto-resolver tickets de soporte por inactividad del cliente (cada 30 min).
  if (typeof api.runTicketAutoResolve === 'function') {
    setInterval(() => { api.runTicketAutoResolve().catch(e => console.error('runTicketAutoResolve interval:', e.message)); }, 30 * 60 * 1000);
    setTimeout(() => { api.runTicketAutoResolve().catch(() => {}); }, 120000);
  }
  // v0.9.363 — SLA scan de tickets como cron interno (cada 15 min + 90s post-boot).
  // Antes dependía de un worker n8n externo que no está montado → "Dentro de SLA 100%" era falso verde.
  if (typeof api.runSlaBreachScan === 'function') {
    setInterval(() => { api.runSlaBreachScan().catch(e => console.error('runSlaBreachScan interval:', e.message)); }, 15 * 60 * 1000);
    setTimeout(() => { api.runSlaBreachScan().catch(() => {}); }, 90000);
  }

  // v0.9.345 — AUTO-TOPICS por IA: clasifica conversaciones activas en temas (30 min + 3 min post-boot).
  try {
    const topicClassifier = require('./topic-classifier');
    if (typeof topicClassifier.runTopicClassifier === 'function') {
      setInterval(() => { topicClassifier.runTopicClassifier().catch(e => console.error('runTopicClassifier interval:', e.message)); }, 30 * 60 * 1000);
      setTimeout(() => { topicClassifier.runTopicClassifier().catch(() => {}); }, 3 * 60 * 1000);
    }
  } catch (e) { console.warn('topic-classifier no cargado:', e.message); }

  // v0.9.331 — CSAT: barre tickets resueltos (BPO) y envía la encuesta de satisfacción (cada 2 min).
  if (typeof csat.runCsatSweep === 'function') {
    setInterval(() => { csat.runCsatSweep().catch(e => console.error('runCsatSweep interval:', e.message)); }, 2 * 60 * 1000);
    setTimeout(() => { csat.runCsatSweep().catch(() => {}); }, 60000);
  }
  // v0.9.326 — WORKER de la cola durable de ingestión: reprocesa webhooks que quedaron
  // 'pending' (server reiniciado mientras procesaba) → no se pierden mensajes. Cada 2 min + 45s post-boot.
  if (typeof webhook.runWebhookQueueRecovery === 'function') {
    setInterval(() => { webhook.runWebhookQueueRecovery().catch(e => console.error('runWebhookQueueRecovery interval:', e.message)); }, 2 * 60 * 1000);
    setTimeout(() => { webhook.runWebhookQueueRecovery().catch(() => {}); }, 45000);
  }

  // v0.9.528 — VENTA DE SOFTWARE (Inventario): Baneco no avisa cuando se paga, así que
  // un worker consulta el estado de los QR de venta pendientes cada 30s. Al pagarse,
  // provisiona la cuenta en el Inventario y le manda el acceso al cliente. Ver software-sales.js.
  try {
    const softwareSales = require('./software-sales');
    setInterval(() => { softwareSales.pollPendingSales().catch(e => console.error('pollPendingSales interval:', e.message)); }, 30 * 1000);
  } catch (e) { console.error('software-sales worker:', e.message); }

  // v0.9.154: CRON de follow-ups multi-etapa — cada 5 min revisa qué etapa toca
  // por conversación y la envía (IA dentro de 24h, plantilla fuera). El módulo
  // tiene flag anti-solapamiento y todos los candados de seguridad (ver
  // follow-up/follow-up-routes.js → runDueFollowUps). Aditivo: no toca n8n.
  if (typeof followUpApi.runDueFollowUps === 'function') {
    setInterval(() => { followUpApi.runDueFollowUps().catch(e => console.error('runDueFollowUps interval:', e.message)); }, 5 * 60 * 1000);
    setTimeout(() => { followUpApi.runDueFollowUps().catch(() => {}); }, 30000); // primer pase a los 30s del boot
  }
  // v0.9.427 — SYNC 21Online → catálogo (OPT-IN por tenant: c21_sync.enabled + c21_import_enabled).
  // Corre 1 vez al día ~3am Bolivia (07 UTC); cronTick chequea cada 20 min. Candado global: C21_SYNC_ENABLED=0.
  try {
    c21Sync.ensureSchema().catch(e => console.error('c21Sync.ensureSchema:', e.message));
    // v0.9.505 — tablas de cobros USDT (direcciones + pagos), idempotente.
    try { require('./usdt').ensureSchema().catch(e => console.error('usdt.ensureSchema:', e.message)); } catch (e) { console.error('usdt módulo:', e.message); }
    // v0.9.514 — parámetros de la agenda (organización + override por asesor).
    try { require('./agenda').ensureSchema(); } catch (e) { console.error('agenda módulo:', e.message); }
    // v0.9.528 — tabla software_sales (venta del Inventario por QR).
    try { require('./software-sales').ensureSchema(); } catch (e) { console.error('software-sales módulo:', e.message); }
    // v0.9.580 — columnas de la respuesta a comentarios (switch + modo IA/fijo).
    try { require('./comment-reply-ai').ensureSchema().catch(e => console.error('comment-reply-ai.ensureSchema:', e.message)); } catch (e) { console.error('comment-reply-ai módulo:', e.message); }
    // v0.9.580 — properties.promotions (promociones temporales con vigencia).
    try { require('./promos').ensureSchema().catch(e => console.error('promos.ensureSchema:', e.message)); } catch (e) { console.error('promos módulo:', e.message); }
    // v0.9.580 — AUTODEFENSA n8n: cola de reintentos + sonda de salud + auto-redeploy.
    try {
      const _wd = require('./n8n-watchdog');
      const _wh = require('./webhook');
      _wd.ensureSchema().catch(e => console.error('n8n-watchdog.ensureSchema:', e.message));
      // Drenaje de la cola cada 60 s (corre SIEMPRE, aunque la sonda esté apagada:
      // así los mensajes encolados salen igual cuando n8n vuelve).
      setInterval(() => { _wd.drain(_wh.postToN8n).catch(e => console.warn('[n8n-pending] drenaje:', e.message)); }, 60 * 1000);
      // Sonda de salud (opt-in con N8N_WATCHDOG_ENABLED=1 + N8N_HEALTH_URL).
      if (_wd.ENABLED) {
        setInterval(() => { _wd.tick(_wh.postToN8n, _wh.notifyOwnerBotDown).catch(e => console.warn('[n8n-watchdog]', e.message)); }, 60 * 1000);
        console.log(`🐕 [n8n-watchdog] ACTIVO — sonda cada 60s · reintento hasta ${_wd.MAX_MIN} min · auto-redeploy=${_wd.status().autoRestart ? 'SÍ' : 'no configurado'}`);
      } else {
        console.log('🐕 [n8n-watchdog] sonda APAGADA (seteá N8N_WATCHDOG_ENABLED=1 y N8N_HEALTH_URL) — la cola de reintentos SÍ está activa');
      }
    } catch (e) { console.error('n8n-watchdog módulo:', e.message); }
    // v0.9.517 — LA IA NACE EN PAUSA. Un tenant recién conectado empezaba a responder
    // en el mismo minuto, antes de que estuviera todo configurado. La columna
    // tenants.ai_enabled nace DEFAULT TRUE y ni onboarding ni el login de Facebook la
    // setean a mano, así que basta con cambiar el default: los tenants NUEVOS nacen con
    // el master switch OFF y se activa a mano cuando está todo listo. Los tenants que YA
    // existen no se tocan (ALTER COLUMN SET DEFAULT no cambia filas existentes).
    try { await db.query(`ALTER TABLE tenants ALTER COLUMN ai_enabled SET DEFAULT FALSE`); }
    catch (e) { console.error('schema ai_enabled default OFF:', e.message); }
    // v0.9.512 — links de subida de fotos (token efímero por inmueble).
    try {
      const _ul = require('./upload-links');
      _ul.ensureSchema().catch(e => console.error('uploadLinks.ensureSchema:', e.message));
      // Los vencidos se barren una vez por día; no hace falta más que eso.
      setInterval(() => { _ul.limpiarVencidos().catch(() => {}); }, 24 * 60 * 60 * 1000);
    } catch (e) { console.error('upload-links módulo:', e.message); }
    // v0.9.510 — MONEDA DE FACTURACIÓN por tenant + lista de precios de referencia en USDT.
    // OJO: por ahora esto es SOLO configuración. El cálculo del "A pagar" (_amountDueBs)
    // sigue siendo íntegramente en Bs. Se guarda la decisión comercial primero y se
    // migra el cálculo después, para no tocar el camino del dinero de los que ya facturan.
    (async () => {
      // 'BOB' | 'USDT'. Los tenants existentes quedan en BOB, que es lo que se les cobra hoy.
      try { await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_currency TEXT NOT NULL DEFAULT 'BOB'`); } catch (e) { console.error('schema billing_currency:', e.message); }
      // Lista de referencia en USDT. Son números propios, NO una conversión de los de Bs:
      // el que paga en cripto desde el exterior no tiene por qué pagar el precio boliviano
      // pasado por el tipo de cambio del BCB.
      for (const col of ['default_price_per_line_usdt', 'default_price_per_user_usdt', 'default_setup_fee_usdt',
                         'default_price_per_channel_usdt', 'unlimited_monthly_price_usdt']) {
        try { await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS ${col} NUMERIC(10,2)`); } catch (e) { console.error('schema ' + col + ':', e.message); }
      }
      // Markup propio para el consumo de los clientes en USDT. NULL = usar consumption_markup.
      // El consumo ya se calcula en USD, así que para un cliente USDT no hay conversión:
      // 1 USDT = 1 USD y este markup es el único ajuste.
      try { await db.query(`ALTER TABLE platform_pricing ADD COLUMN IF NOT EXISTS consumption_markup_usdt NUMERIC(6,3)`); } catch (e) { console.error('schema consumption_markup_usdt:', e.message); }
    })();
    // v0.9.439 — IA solo para anuncios: referral CTWA + origen del chat + alcance de la IA
    (async () => {
      try { await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS referral JSONB`); } catch (e) { console.error('schema referral:', e.message); }
      try { await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_origin TEXT`); } catch (e) { console.error('schema ai_origin:', e.message); }
      try { await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ad_property_id INTEGER`); } catch (e) { console.error('schema ad_property_id:', e.message); }
      try { await db.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS origin_campaign TEXT`); } catch (e) { console.error('schema origin_campaign:', e.message); }
      // v0.9.445 — carpetas de catálogo + destacadas
      try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS category TEXT`); } catch (e) { console.error('schema category:', e.message); }
      try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE`); } catch (e) { console.error('schema featured:', e.message); }
      try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS state TEXT`); } catch (e) { console.error('schema state:', e.message); }
      // v0.9.465 — disponibilidad texto libre por propiedad (pedido C21: "quedan 3 casas",
      // "solo modelos XL"). Vacío/NULL = disponible normal, la ficha y el bot no dicen nada.
      try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS availability TEXT`); } catch (e) { console.error('schema availability:', e.message); }
      // v0.9.469 — versión CONDENSADA de la descripción para el caption de WhatsApp (≤~900 chars).
      // La genera la IA al guardar cuando la descripción es tan larga que no entra en un caption
      // de imagen (WhatsApp corta en 1024). La descripción completa NO se toca; esto es solo para
      // que la ficha salga en UN mensaje sin perder datos esenciales.
      try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS ficha_caption TEXT`); } catch (e) { console.error('schema ficha_caption:', e.message); }
      // v0.9.480 — PROYECTOS: tipologías/formatos dentro de un mismo inmueble (ej. Luxe Tower con
      // Studio / 2 dorm / Penthouse). Array JSONB de {label, m2, dorm, price_from, availability}.
      // Vacío o null = inmueble normal (comportamiento idéntico al de siempre).
      try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS formats JSONB`); } catch (e) { console.error('schema formats:', e.message); }
      // v0.9.466 — CONVERSACIONES POR LÍNEA (fin de la "contaminación" entre líneas del
      // mismo tenant, caso real 29-jul: el chat con la línea del dueño y el chat con la
      // línea de la asesora se fusionaban en un solo hilo). La clave pasa de
      // (tenant, phone) a (tenant, phone, línea). COALESCE(line_id, 0) agrupa las
      // conversaciones sin línea (canales/legacy) en un único bucket, como antes.
      // ORDEN: primero el índice nuevo (garantiza unicidad SIEMPRE), después caen los
      // constraints viejos. Idempotente. Las conversaciones existentes no se tocan:
      // conservan su línea actual; la separación rige para lo que nace desde ahora.
      try {
        await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS conversations_tenant_phone_line_key ON conversations (tenant_id, phone, COALESCE(line_id, 0))`);
        await db.query(`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_tenant_phone_key`);
        await db.query(`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_phone_key`);
        await db.query(`DROP INDEX IF EXISTS conversations_phone_key`);
        // v0.9.467 — en prod el UNIQUE viejo se llamaba idx_conv_tenant_phone (nombre de una
        // migración vieja, no el que soltábamos arriba). Sobrevivió al deploy 466 y rebotaba
        // los webhooks de las líneas secundarias con "duplicate key ... idx_conv_tenant_phone".
        // Lo soltamos por nombre también, para que ninguna base se vuelva a trabar.
        await db.query(`DROP INDEX IF EXISTS idx_conv_tenant_phone`);
        console.log('🔀 [v0.9.466] conversaciones por línea: índice único (tenant, phone, línea) activo');
      } catch (e) { console.error('schema conversaciones por línea:', e.message); }
      try { await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ai_scope TEXT`); } catch (e) { console.error('schema tenants.ai_scope:', e.message); }
      try { await db.query(`ALTER TABLE IF EXISTS tenant_lines ADD COLUMN IF NOT EXISTS ai_scope TEXT`); } catch (e) { console.error('schema tenant_lines.ai_scope:', e.message); }
      try { await db.query(`ALTER TABLE IF EXISTS tenant_lines ADD COLUMN IF NOT EXISTS billing_excluded BOOLEAN NOT NULL DEFAULT FALSE`); } catch (e) { console.error('schema tenant_lines.billing_excluded:', e.message); } // v0.9.525 — líneas no facturables
      // v0.9.452 — AISLAMIENTO POR MODO DE VENTA: vehiculos y arquitectura dejan de
      // piggybackear la tabla del padre (inventory_items / services). Mismo patrón que
      // v0.9.87 (separación física total): clon LIKE INCLUDING ALL + secuencia propia +
      // FK a tenants + backfill que MUEVE las filas (idempotente: tras mover, quedan 0).
      try {
        const _clone = async (table, source) => {
          await db.query(`CREATE TABLE IF NOT EXISTS ${table} (LIKE ${source} INCLUDING ALL);`);
          await db.query(`CREATE SEQUENCE IF NOT EXISTS ${table}_id_seq;`);
          await db.query(`ALTER TABLE ${table} ALTER COLUMN id SET DEFAULT nextval('${table}_id_seq');`);
          await db.query(`ALTER SEQUENCE ${table}_id_seq OWNED BY ${table}.id;`);
          await db.query(`
            DO $$ BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_tenant_fk') THEN
                ALTER TABLE ${table} ADD CONSTRAINT ${table}_tenant_fk
                  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;
              END IF;
            END $$;
          `);
        };
        await _clone('catalog_vehiculos', 'inventory_items');
        await _clone('catalog_arquitectura', 'services');
        // Bug latente heredado: catalog_restaurante se clonó en v0.9.87, ANTES de que v0.9.400
        // agregara las columnas de vehículo a inventory_items — pero el INSERT del POST
        // /admin/inventory las nombra SIEMPRE → agregar un plato tiraba 500. Alinear columnas.
        for (const [c, ty] of [['model','TEXT'],['model_year','INTEGER'],['km','INTEGER'],['body_type','TEXT'],['fuel','TEXT'],['transmission','TEXT'],['condition','TEXT'],['version','TEXT'],['specs','JSONB']]) {
          await db.query(`ALTER TABLE catalog_restaurante ADD COLUMN IF NOT EXISTS ${c} ${ty};`).catch(() => {});
          await db.query(`ALTER TABLE catalog_vehiculos   ADD COLUMN IF NOT EXISTS ${c} ${ty};`).catch(() => {});
        }
        // v0.9.453 — SUBCATEGORÍA en los catálogos inventory-shaped (categoría + subcategoría + filtros del panel)
        for (const t of ['inventory_items', 'catalog_restaurante', 'catalog_vehiculos']) {
          await db.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS subcategory TEXT;`).catch(() => {});
        }
        // v0.9.454 — DES-CRUCE de prompts legacy: las "Plantillas de rubro" (v0.9.56, pre-v0.9.87)
        // montaban el texto de restaurante/salud/belleza SOBRE el prompt de articulos/servicios.
        // Si un tenant quedó con ese texto en un modo base, se restaura el default del modo.
        // Detección conservadora: solo si el ARRANQUE del prompt (200 chars) delata el preset;
        // prompts personalizados de verdad no matchean y no se tocan. Idempotente.
        try {
          const _dmp = require('./default-mode-prompts');
          const _fixes = [
            ['articulos', '%restaurante%', _dmp.ARTICULOS],
            ['servicios', '%centro de salud%', _dmp.SERVICIOS],
            ['servicios', '%salón de belleza%', _dmp.SERVICIOS],
          ];
          for (const [m, pat, def] of _fixes) {
            const r = await db.query(
              `UPDATE tenant_mode_prompts SET content = $3, updated_at = NOW()
               WHERE mode = $1 AND LEFT(content, 200) ILIKE $2
               RETURNING tenant_id, line_id`, [m, pat, def]);
            if (r.rowCount) console.log(`🧹 [v0.9.454] prompt de "${m}" des-cruzado (tenía preset de rubro): ${r.rows.map((x) => `t${x.tenant_id}${x.line_id ? '/l' + x.line_id : ''}`).join(', ')}`);
          }
        } catch (e) { console.error('fix cruce prompts (v0.9.454):', e.message); }
        // v0.9.459 — TENANT FANTASMA: modo elegido pero MOTOR APAGADO.
        // El panel tiene TRES nociones paralelas de "qué modo es este tenant":
        //   1) mode_visibility        → qué ve el cliente en su panel (cosmético)
        //   2) active_prompt_mode     → qué prompt usa Aitana
        //   3) <modo>_bot_enabled     → qué MOTOR corre (catálogo, topics, nurture, botones)
        // resolveActiveMode() repara (2) desde (1) y el PATCH de onboarding fija (1) desde (2),
        // pero NADIE fijaba (3): solo lo escribía applyMode() del wizard. Si el cliente tocó
        // "Saltar"/"hacer después", el tenant quedaba FANTASMA — prompt correcto, panel correcto,
        // motor muerto: sin rail de Propiedades, sin botón 🏠 en el composer y, lo grave,
        // webhook.js/bot-prompt-builder.js nunca le adjuntan el catálogo a Aitana.
        // (Caso real: tenant 12 carlos-arzabe-59b147 — mode_visibility.inmuebles=true,
        //  active_prompt_mode='inmuebles', prompt de 14.676 chars, y los 9 motores en FALSE.)
        // Reparación CONSERVADORA e idempotente: solo toca al tenant que terminó el onboarding,
        // tiene los 9 motores apagados, y cuya visibilidad marca UN solo modo de venta que además
        // coincide con active_prompt_mode. Nunca pisa una elección deliberada.
        try {
          const MODE_ENGINE = {
            software: 'software_bot_enabled',
            articulos: 'inventory_bot_enabled',
            inmuebles: 'realestate_bot_enabled',
            servicios: 'services_bot_enabled',
            salud: 'salud_bot_enabled',
            belleza: 'belleza_bot_enabled',
            restaurante: 'restaurante_bot_enabled',
            vehiculos: 'vehiculos_bot_enabled',
            arquitectura: 'arquitectura_bot_enabled',
          };
          const _allOff = Object.values(MODE_ENGINE)
            .map((c) => `COALESCE((to_jsonb(tenants)->>'${c}')::boolean, false)`)
            .join(' OR ');
          for (const [mode, col] of Object.entries(MODE_ENGINE)) {
            const r = await db.query(
              `UPDATE tenants SET ${col} = TRUE
                WHERE COALESCE((to_jsonb(tenants)->>'onboarding_completed')::boolean, false) = TRUE
                  AND COALESCE(to_jsonb(tenants)->>'active_prompt_mode', '') = $1::text
                  AND NOT (${_allOff})
                  AND COALESCE(to_jsonb(tenants)->'mode_visibility'->>($1::text), 'false') = 'true'
                  AND (SELECT COUNT(*) FROM jsonb_each(COALESCE(to_jsonb(tenants)->'mode_visibility', '{}'::jsonb)) e
                        WHERE e.key <> 'soporte' AND e.value = 'true'::jsonb) = 1
                RETURNING id, slug`,
              [mode]
            );
            if (r.rowCount) {
              console.log(`🔌 [v0.9.459] motor "${col}" ENCENDIDO (modo "${mode}" elegido pero wizard salteado): ${r.rows.map((x) => `t${x.id} ${x.slug}`).join(', ')}`);
            }
          }
        } catch (e) { console.error('fix motor apagado (v0.9.459):', e.message); }
        // Backfill VEHÍCULOS: (a) todo el inventario de tenants en modo vehiculos, y
        // (b) filas con campos de auto (model/body_type/año/km/fuel/transmission — solo
        // las escriben el importador NIBOL y el import por PDF) de CUALQUIER tenant:
        // un vehículo pertenece al catálogo de vehículos, no al de artículos.
        const mv = await db.query(`
          WITH moved AS (
            DELETE FROM inventory_items i
            WHERE i.tenant_id IN (
                    SELECT id FROM tenants
                    WHERE COALESCE((to_jsonb(tenants)->>'vehiculos_bot_enabled')::boolean, false)
                       OR COALESCE(to_jsonb(tenants)->>'active_prompt_mode','') = 'vehiculos')
               OR (to_jsonb(i) ->> 'model')      IS NOT NULL
               OR (to_jsonb(i) ->> 'body_type')  IS NOT NULL
               OR (to_jsonb(i) ->> 'model_year') IS NOT NULL
               OR (to_jsonb(i) ->> 'km')         IS NOT NULL
               OR (to_jsonb(i) ->> 'fuel')       IS NOT NULL
               OR (to_jsonb(i) ->> 'transmission') IS NOT NULL
            RETURNING i.*
          )
          INSERT INTO catalog_vehiculos SELECT * FROM moved;
        `);
        await db.query(`SELECT setval('catalog_vehiculos_id_seq', COALESCE((SELECT MAX(id) FROM catalog_vehiculos), 0) + 1, false);`);
        // Backfill ARQUITECTURA: paquetes de tenants en modo arquitectura.
        const ma = await db.query(`
          WITH moved AS (
            DELETE FROM services s
            WHERE s.tenant_id IN (
                    SELECT id FROM tenants
                    WHERE COALESCE((to_jsonb(tenants)->>'arquitectura_bot_enabled')::boolean, false)
                       OR COALESCE(to_jsonb(tenants)->>'active_prompt_mode','') = 'arquitectura')
            RETURNING s.*
          )
          INSERT INTO catalog_arquitectura SELECT * FROM moved;
        `);
        await db.query(`SELECT setval('catalog_arquitectura_id_seq', COALESCE((SELECT MAX(id) FROM catalog_arquitectura), 0) + 1, false);`);
        if (mv.rowCount || ma.rowCount) console.log(`🗂️ [v0.9.452] aislamiento por modo: ${mv.rowCount} vehículo(s) → catalog_vehiculos · ${ma.rowCount} paquete(s) → catalog_arquitectura`);
      } catch (e) { console.error('schema catalogos por modo (v0.9.452):', e.message); }
    })();
    setInterval(() => { try { c21Sync.cronTick(); } catch (e) { console.error('c21Sync cronTick:', e.message); } }, 20 * 60 * 1000);
    // v0.9.505 — watcher de cobros USDT: revisa la blockchain cada 2 minutos.
    // Es el equivalente al webhook de Baneco, pero preguntando en vez de esperar.
    try {
      const _usdt = require('./usdt');
      if (_usdt.isConfigured()) {
        setInterval(() => { try { _usdt.cronTick(); } catch (e) { console.error('usdt cronTick:', e.message); } }, 2 * 60 * 1000);
        console.log('   - Cobros USDT (Polygon): watcher activo cada 2 min');
      }
    } catch (e) { console.warn('[usdt] no se pudo montar el watcher:', e.message); }
  } catch (e) { console.warn('[c21-sync] no se pudo montar el cron:', e.message); }

  // v0.9.304 — NURTURING por comportamiento (OPT-IN). Cron cada 3h + 1er pase a los 90s del boot.
  try {
    const _nurture = require('./nurture');
    if (typeof _nurture.runNurtureScan === 'function') {
      setInterval(() => { _nurture.runNurtureScan().catch(e => console.error('runNurtureScan interval:', e.message)); }, 3 * 60 * 60 * 1000);
      setTimeout(() => { _nurture.runNurtureScan().catch(() => {}); }, 90000);
    }
  } catch (e) { console.warn('[nurture] no se pudo montar el cron:', e.message);
  }

  // v0.9.167: CRON de RECORDATORIOS de cita — cada 10 min avisa por WhatsApp ~3h antes
  // de cada cita in-house enlazada a una conversación. (follow-up-routes → runDueReminders)
  if (typeof followUpApi.runDueReminders === 'function') {
    setInterval(() => { followUpApi.runDueReminders().catch(e => console.error('runDueReminders interval:', e.message)); }, 10 * 60 * 1000);
    setTimeout(() => { followUpApi.runDueReminders().catch(() => {}); }, 45000);
  }

  // v0.9.272: CRON de MANTENIMIENTO de almacenamiento (para que la DB/R2 no crezcan infinito).
  // DOBLE CANDADO — no corre salvo STORAGE_MAINT_ENABLED=1, y aun corriendo es DRY-RUN (solo
  // loguea qué borraría) salvo STORAGE_MAINT_APPLY=1. Así un deploy nunca borra nada por sorpresa:
  // José prende ENABLED, mira los logs DRY-RUN, y recién entonces prende APPLY.
  //   - expireChatMedia: media de chat (incoming/+outgoing/) > CHAT_MEDIA_TTL_DAYS (def 90) — diario
  //   - purgeOrphans:    objetos de R2 sin referencia (usa r2-refs, misma lista del conteo) — semanal
  //   - pruneOldMessages: filas de `messages` > MSG_PRUNE_MONTHS (def 12), en lotes — semanal
  if (process.env.STORAGE_MAINT_ENABLED === '1') {
    try {
      const maint = require('./storage-maintenance');
      const DAY = 24 * 60 * 60 * 1000;
      // TTL de media de chat: primer pase a los 2 min, luego diario
      setTimeout(() => { maint.expireChatMedia().catch(e => console.error('expireChatMedia:', e.message)); }, 120000);
      setInterval(() => { maint.expireChatMedia().catch(e => console.error('expireChatMedia interval:', e.message)); }, DAY);
      // Purga de huérfanos: primer pase a los 3 min, luego semanal
      setTimeout(() => { maint.purgeOrphans().catch(e => console.error('purgeOrphans:', e.message)); }, 180000);
      setInterval(() => { maint.purgeOrphans().catch(e => console.error('purgeOrphans interval:', e.message)); }, 7 * DAY);
      // Poda de mensajes viejos: primer pase a los 4 min, luego semanal
      setTimeout(() => { maint.pruneOldMessages().catch(e => console.error('pruneOldMessages:', e.message)); }, 240000);
      setInterval(() => { maint.pruneOldMessages().catch(e => console.error('pruneOldMessages interval:', e.message)); }, 7 * DAY);
      console.log(`🧹 [maint] mantenimiento de almacenamiento ACTIVO — apply=${process.env.STORAGE_MAINT_APPLY === '1' ? 'SÍ (borra de verdad)' : 'NO (dry-run)'} · chatTTL=${maint.CHAT_TTL_DAYS}d · msgPrune=${maint.MSG_PRUNE_MONTHS}m`);
    } catch (e) {
      console.error('🧹 [maint] no se pudo iniciar storage-maintenance:', e.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`🚀 SG Ventas API ${APP_VERSION} (build ${APP_BUILD_DATE}) escuchando en puerto ${PORT}`);
    console.log(`   - Health: GET /ping`);
    console.log(`   - Versión: GET /api/version`);
    console.log(`   - Tenant info: GET /api/admin/me (multi-tenant)`);
    console.log(`   - Meta webhook: GET|POST /api/meta/webhook`);
    console.log(`   - Admin API: /api/admin/* (token requerido)`);
    console.log(`   - n8n API: /api/whatsapp/* (X-CRM-Secret requerido)`);
    console.log(`   - Follow-up API: /api/admin/follow-ups/* + /api/bot/follow-up/*`);
    console.log(`   - Panel: /panel/?token=...`);

    // v0.9.5: Worker de tareas/recordatorios
    try {
      const { startTasksWorker } = require('./tasks-worker');
      startTasksWorker();
    } catch (e) {
      console.warn('⚠️  Tasks worker no inició:', e.message);
    }
  });
})();

// Manejo de shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido, cerrando...');
  process.exit(0);
});
process.on('SIGINT', () => {
  console.log('SIGINT recibido, cerrando...');
  process.exit(0);
});
