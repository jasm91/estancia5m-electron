# SG Ventas — Módulo Follow-up Automático v1.0

## Qué hace

Cada 15 minutos, un worker en n8n revisa todas las conversaciones de todos los tenants. Para los leads que cumplen estas condiciones:

- ✅ Score ≥ 70 (configurable)
- ✅ Mode = `bot` (si tomaste el control, no se manda follow-up automático)
- ✅ Status conversation = `open`, lead status NOT IN (`lost`, `won`)
- ✅ Último mensaje fue del bot
- ✅ Última actividad del cliente: entre 22 y 23 horas atrás
- ✅ No tiene follow-up activo en últimos 7 días
- ✅ Conversation tiene `follow_up_enabled = TRUE` (override por conversación)
- ✅ Está fuera de quiet hours (default 20:00 - 09:00 hora Bolivia)
- ✅ No es sábado/domingo (configurable)
- ✅ El cliente NUNCA ha dicho "stop", "no me escriban más", "déjenme en paz", etc.

...Gemini genera un mensaje personalizado contextual y lo envía vía Meta WhatsApp API.

**Importante:** la ventana de 22-23h está calculada para caer SIEMPRE antes de las 24h que Meta exige para mensajes libres (sin template). No hay riesgo de "window expired".

## Archivos incluidos

| Archivo | Para qué |
|---|---|
| `migrate-follow-up-log.js` | Crea tabla `follow_up_log` + columna `follow_up_enabled` en `conversations` |
| `migrate-add-followup-config.js` | Agrega settings `follow_up` al JSONB de `bot_global_config` |
| `follow-up-routes.js` | Endpoints HTTP del backend (admin + bot-secret) |
| `stop-word-detector.js` | Detector automático de stop words (regex en español) |
| `test-stop-word-detector.js` | Tests del detector (33/33 pasan) |
| `SG_Ventas_Followup_Worker_v1.0.json` | Workflow n8n para importar |

## Setup paso a paso

### 1. Migraciones de DB (Railway Shell)

```bash
node migrate-follow-up-log.js
node migrate-add-followup-config.js
```

Verificar:
```sql
SELECT COUNT(*) FROM follow_up_log;  -- debe ser 0
SELECT column_name FROM information_schema.columns
  WHERE table_name='conversations' AND column_name='follow_up_enabled';  -- debe existir
SELECT config->'follow_up' FROM bot_global_config WHERE tenant_id=1;  -- debe tener config
```

### 2. Integrar routes en el backend

En tu archivo principal (probablemente `index.js` o `server.js`):

```js
const followUpRoutes = require('./follow-up-routes');

// Routes admin (requieren tenant token) — montadas en raíz, ya tienen prefix /admin/...
app.use(requireTenantToken, followUpRoutes);

// Routes bot (requieren bot secret) — el mismo router maneja ambas
// porque cada route ya tiene su prefix (/admin/... o /bot/...).
// El middleware requireBotSecret debe permitir solo las rutas /bot/* y rechazar las /admin/*
app.use(requireBotSecret, followUpRoutes);
```

**Mejor opción** (más seguro): separar los routes:

```js
// follow-up-admin-routes.js: solo las rutas /admin/*
// follow-up-bot-routes.js: solo las rutas /bot/*
app.use('/api', requireTenantToken, followUpAdminRoutes);
app.use('/api', requireBotSecret, followUpBotRoutes);
```

### 3. Integrar stop-word detection + response tracking en el webhook

En el handler del webhook de Meta (donde guardás mensajes entrantes):

```js
const { handleStopWords } = require('./stop-word-detector');
const { markFollowUpResponse } = require('./follow-up-routes');

// Después de guardar el mensaje entrante (con direction='incoming'):
if (msg.direction === 'incoming') {
  // 1. Marcar follow-ups previos como respondidos (si los hubo)
  await markFollowUpResponse({
    db,
    tenant_id: conversation.tenant_id,
    conversation_id: conversation.id,
    message_id: savedMsg.id
  });

  // 2. Detectar stop words ("no me escriban más", etc.)
  await handleStopWords({
    db,
    tenant_id: conversation.tenant_id,
    conversation_id: conversation.id,
    phone: conversation.phone,
    body: msg.body || ''
  });
}
```

**Qué hace cada uno:**

- `markFollowUpResponse`: si en los últimos 7 días se mandó un follow-up automático y ahora el cliente respondió, se marca `response_received=TRUE` para que la métrica de "tasa de respuesta" funcione.

- `handleStopWords`: corre regex en español sobre el body. Si detecta patterns tipo "no me escriban", "déjenme en paz", "basta", "ya no me interesa", etc.:
  1. Setea `conversations.follow_up_enabled = FALSE` (no más follow-ups para esa persona)
  2. Cancela cualquier follow-up programado (status='scheduled' → 'cancelled')
  3. Loguea a stdout

**Test del detector** antes de deployar:
```bash
node test-stop-word-detector.js
# debe imprimir "33/33 pasaron"
```

### 4. Importar workflow en n8n

1. Abrir n8n
2. Click en **Workflows** → **Import from File**
3. Seleccionar `SG_Ventas_Followup_Worker_v1.0.json`
4. Configurar credencial **BOT_SECRET_SGVENTAS** (Header Auth):
   - Name: `X-Bot-Secret`
   - Value: `<tu BOT_SECRET_SGVENTAS>`
5. Configurar variables de entorno n8n (Settings → Environment):
   - `SG_VENTAS_API_URL` = `https://sg-ventas-production-5db2.up.railway.app/api`
   - `META_WHATSAPP_TOKEN` = `<tu Meta token>`
   - `GEMINI_API_KEY` = `<tu Gemini API key>`
6. **NO activar todavía**. Probar manualmente primero (próximo paso).

### 5. Test manual (sin activar)

En n8n, abrir el workflow y click **Execute Workflow** (botón en la parte superior).

Esto corre la lógica una vez sin esperar el schedule. Mirá:

- Si "GET candidates" devuelve `count: 0` → no hay leads que califiquen ahora mismo (normal si no tenés leads recientes con score alto). Esperá a tener un caso real.
- Si devuelve candidatos → verás cada uno pasar por Gemini → ver mensaje generado → enviarse. Revisá el mensaje en tu WhatsApp antes de activar.

### 6. Activar desde el panel

El panel v0.7.22 tiene la sección **Configuración → 📤 Follow-ups** donde podés:
- Toggle global on/off
- Slider min_score (50-100)
- Quiet hours (start/end)
- Toggle skip weekends
- Ver últimos 50 follow-ups con status, mensaje, respuesta
- Cancelar follow-ups programados
- Stats últimos 30 días: enviados, respondidos, tasa, fallidos

**Para activar el sistema completo:**
1. En el panel: tab Follow-ups → toggle "Follow-up automático" ON
2. En n8n: toggle **Active** del workflow

A partir de ahí, cada 15 min n8n revisa, y solo manda si hay candidatos elegibles.

### 7. Monitoreo

En n8n → Executions: vas a ver cada ejecución, con qué leads procesó y resultado.

En el panel → Follow-ups → Stats: tasa de respuesta de últimos 30 días.

Query SQL directa para auditoría:
```sql
SELECT
  DATE(sent_at) as dia,
  COUNT(*) as enviados,
  COUNT(*) FILTER (WHERE response_received) as respondidos,
  ROUND(100.0 * COUNT(*) FILTER (WHERE response_received) / NULLIF(COUNT(*),0), 1) as tasa
FROM follow_up_log
WHERE tenant_id = 1
  AND sent_at >= NOW() - INTERVAL '30 days'
GROUP BY dia
ORDER BY dia DESC;
```

## Tuning recomendado

### Primera semana (observación)
- `min_score: 70` (default)
- Revisar diariamente en el panel:
  - Cuántos se enviaron
  - Qué mensajes generó Gemini (preview en la lista)
  - Tasa de respuesta
  - Quiénes respondieron y qué dijeron

### Si la tasa de respuesta es <10%
- Probablemente el min_score es muy bajo. Subir slider a 80.
- O el mensaje no está bien. Iterar el prompt en el node "Build Gemini Prompt" del workflow.

### Si la tasa es >30%
- 🎉 está funcionando. Considerar bajar slider a 60 para perseguir más leads.

### Si hay reportes de clientes molestos
- El stop-word detector ya cancela follow-ups cuando el cliente dice "basta" o similar
- Si querés ser más conservador: subí min_score a 85 o desactivá temporal con el toggle

## Costos estimados

Por cada follow-up enviado:
- Gemini 2.5 Flash: ~$0.001 (prompt ~800 tokens, response ~80 tokens)
- Meta WhatsApp: dentro de las 24h del último mensaje del cliente → **gratis** (no cuenta como "conversation")

Si tenés 20 follow-ups/día = **$0.60/mes** en Gemini. Despreciable.

## Limitaciones conocidas v1.0

- ❌ Un solo toque por lead (sin retry a 5 días). Si querés más, hay que extender la query del worker.
- ❌ No usa templates aprobados de Meta — solo mensajes libres dentro de 24h.
- ❌ Stop-word detection es regex, no LLM. Casos sofisticados ("preferiría que no me contactaran más, gracias") no se detectan. Pero los casos comunes sí.
- ❌ Si Gemini falla, manda un mensaje fallback genérico "Te escribo para retomar nuestra charla..."

## Rollback

Si algo sale mal:

1. **Pausar inmediatamente**: en n8n, toggle Active → OFF. O desde el panel, toggle "Follow-up automático" OFF.
2. **Desactivar a nivel DB para todos los tenants**:
   ```sql
   UPDATE bot_global_config
   SET config = jsonb_set(config, '{follow_up,enabled}', 'false'::jsonb);
   ```

La tabla `follow_up_log` y la columna `follow_up_enabled` se pueden dejar sin problema, no rompen nada si están sin uso.

---

**Versión**: v1.0
**Fecha**: 20-may-2026
**Autor**: Claude para SG Bolivia


## Setup paso a paso

### 1. Migraciones de DB (Railway Shell)

```bash
node migrate-follow-up-log.js
node migrate-add-followup-config.js
```

Verificar:
```sql
SELECT COUNT(*) FROM follow_up_log;  -- debe ser 0
SELECT column_name FROM information_schema.columns
  WHERE table_name='conversations' AND column_name='follow_up_enabled';  -- debe existir
SELECT config->'follow_up' FROM bot_global_config WHERE tenant_id=1;  -- debe tener config
```

### 2. Integrar routes en el backend

En tu archivo principal (probablemente `index.js` o `server.js`):

```js
const followUpRoutes = require('./follow-up-routes');

// Routes admin (requieren tenant token)
app.use(requireTenantToken, followUpRoutes);

// Routes bot (requieren bot secret) — registralas con prefix
app.use('/bot', requireBotSecret, followUpRoutes);
```

Y en el webhook handler de Meta (donde procesás mensajes entrantes), agregar:

```js
const { markFollowUpResponse } = require('./follow-up-routes');

// Después de guardar el mensaje entrante:
if (msg.direction === 'incoming') {
  await markFollowUpResponse({
    db,
    tenant_id: conversation.tenant_id,
    conversation_id: conversation.id,
    message_id: savedMsg.id
  });
}
```

Esto marca como "respondido" cualquier follow-up enviado en los últimos 7 días si el cliente vuelve a escribir.

### 3. Importar workflow en n8n

1. Abrir n8n
2. Click en **Workflows** → **Import from File**
3. Seleccionar `SG_Ventas_Followup_Worker_v1.0.json`
4. Configurar credenciales:
   - **BOT_SECRET_SGVENTAS** (Header Auth): nombre `X-Bot-Secret`, value `<tu BOT_SECRET_SGVENTAS>`
5. Configurar variables de entorno n8n (Settings → Environment):
   - `SG_VENTAS_API_URL` = `https://sg-ventas-production-5db2.up.railway.app/api`
   - `META_WHATSAPP_TOKEN` = `<tu Meta token>`
   - `GEMINI_API_KEY` = `<tu Gemini API key>`
6. **NO activar todavía**. Probar manualmente primero (próximo paso).

### 4. Test manual (sin activar)

En n8n, abrir el workflow y click **Execute Workflow** (botón en la parte superior).

Esto corre la lógica una vez sin esperar el schedule. Mirá:

- Si "GET candidates" devuelve `count: 0` → no hay leads que califiquen ahora mismo (normal si no tenés leads recientes con score alto). Esperá a tener un caso real.
- Si devuelve candidatos → verás cada uno pasar por Gemini → ver mensaje generado → enviarse. Revisá el mensaje en tu WhatsApp antes de activar.

### 5. Activar el workflow

Cuando confirmes que el mensaje generado por Gemini se ve bien:

1. En n8n, toggle **Active** del workflow (esquina superior derecha)
2. El cron arranca automáticamente

### 6. Configurar desde el panel del tenant

El panel admin (v0.7.22+) tiene una sección "Follow-ups" donde podés:
- ✅ Toggle global on/off (deshabilitar todo sin parar el worker)
- ✅ Ajustar min_score (default 70)
- ✅ Ver últimos follow-ups enviados y tasa de respuesta
- ✅ Cancelar follow-ups programados
- ✅ Por conversación: toggle `follow_up_enabled`

### 7. Monitoreo

En n8n → Executions: vas a ver cada ejecución, con qué leads procesó y resultado.

En el panel → Follow-ups → Stats: tasa de respuesta de últimos 30 días.

Query SQL directa para auditoría:
```sql
SELECT
  DATE(sent_at) as dia,
  COUNT(*) as enviados,
  COUNT(*) FILTER (WHERE response_received) as respondidos,
  ROUND(100.0 * COUNT(*) FILTER (WHERE response_received) / NULLIF(COUNT(*),0), 1) as tasa
FROM follow_up_log
WHERE tenant_id = 1
  AND sent_at >= NOW() - INTERVAL '30 days'
GROUP BY dia
ORDER BY dia DESC;
```

## Tuning recomendado

### Primera semana (observación)
- `min_score: 70` (default)
- Revisar diariamente:
  - Cuántos se enviaron
  - Qué mensajes generó Gemini
  - Tasa de respuesta
  - Reportes de clientes molestos (si hay)

### Si la tasa de respuesta es <10%
- Probablemente el min_score es muy bajo. Subir a 80.
- O el mensaje no está bien. Iterar el prompt en `Build Gemini Prompt`.

### Si la tasa es >30%
- 🎉 está funcionando. Considerar bajar min_score a 60 para perseguir más leads.

### Si hay reportes de clientes molestos
- Stop word handling: agregar logic en el webhook para detectar "no me escriban más", "basta", etc. y setear `follow_up_enabled = false`.

## Costos estimados

Por cada follow-up enviado:
- Gemini 2.5 Flash: ~$0.001 (prompt ~800 tokens, response ~80 tokens)
- Meta WhatsApp: dentro de las 24h del último mensaje del cliente → **gratis** (no cuenta como "conversation")

Si tenés 20 follow-ups/día = **$0.60/mes** en Gemini. Despreciable.

## Limitaciones conocidas v1.0

- ❌ Un solo toque por lead (sin retry a 5 días). Si querés más, hay que extender.
- ❌ No usa templates aprobados de Meta — solo mensajes libres dentro de 24h.
- ❌ El stop-word detection no está implementado en v1. Hay que agregarlo al webhook handler manualmente.
- ❌ El panel del tenant todavía no tiene la sección "Follow-ups" — viene en v0.7.22 del panel.

## Rollback

Si algo sale mal:

1. **Pausar inmediatamente**: en n8n, toggle Active → OFF
2. **Desactivar a nivel DB para todos los tenants**:
   ```sql
   UPDATE bot_global_config
   SET config = jsonb_set(config, '{follow_up,enabled}', 'false'::jsonb);
   ```
3. **Cancelar follow-ups programados** (si hubieras planificado a futuro, que ahora no aplica porque enviamos al instante):
   ```sql
   UPDATE follow_up_log SET status = 'cancelled' WHERE status = 'scheduled';
   ```

La tabla `follow_up_log` y la columna `follow_up_enabled` se pueden dejar sin problema, no rompen nada.

---

**Versión**: v1.0
**Fecha**: 20-may-2026
**Autor**: Claude para SG Bolivia
