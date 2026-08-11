-- =====================================================================
-- DIAGNÓSTICO: ¿por qué Aitana no contestó estos 3 chats?
-- Pegá esto en Railway → Postgres → pestaña "Query" y ejecutá.
-- No necesita deploy. Matchea por los últimos 8 dígitos (número local BO),
-- así que sirve pegando el número con o sin 591.
-- =====================================================================
WITH nums(local8) AS (
  VALUES ('62420210'), ('68534890'), ('77303552')
)
SELECT
  c.id                                   AS conv_id,
  c.tenant_id,
  t.name                                 AS tenant,
  c.phone,
  c.contact_name,
  c.line_id,
  tl.label                               AS linea,
  c.mode,                                -- 'bot' | 'human'
  c.status,
  -- alcance efectivo: la línea manda; si no, el tenant
  COALESCE(
    NULLIF(to_jsonb(tl) ->> 'ai_scope', ''),
    NULLIF(to_jsonb(t)  ->> 'ai_scope', ''),
    'all'
  )                                      AS ai_scope,
  COALESCE(t.ai_enabled,  TRUE)          AS master_switch_on,
  COALESCE(tl.ai_enabled, TRUE)          AS linea_ia_on,
  c.ai_origin,                           -- 'ads' | 'organic' | 'campaign' | NULL
  (c.referral IS NOT NULL)               AS tiene_referral,
  c.campaign_ref,
  c.ad_property_id,                      -- inmueble matcheado del anuncio (si hubo)
  -- ¿se detectó como anuncio? (misma lógica que el webhook)
  (c.ai_origin IN ('ads','campaign') OR c.referral IS NOT NULL OR c.campaign_ref IS NOT NULL) AS detectado_de_anuncio,
  -- último mensaje entrante y último handover explícito
  (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS ultimo_msg_cliente,
  (SELECT hr.reason FROM handover_requests hr
     WHERE hr.conversation_id = c.id
       AND hr.reason IN ('admin_takeover','returned_to_bot','client_requested_human')
     ORDER BY hr.id DESC LIMIT 1)        AS ultimo_handover,
  -- VEREDICTO en texto
  CASE
    WHEN COALESCE(t.ai_enabled, TRUE) = FALSE  THEN '❌ Master switch APAGADO (tenant)'
    WHEN COALESCE(tl.ai_enabled, TRUE) = FALSE THEN '❌ IA apagada en esta LÍNEA'
    WHEN COALESCE(NULLIF(to_jsonb(tl)->>'ai_scope',''), NULLIF(to_jsonb(t)->>'ai_scope',''), 'all') = 'ads_only'
         AND NOT (c.ai_origin IN ('ads','campaign') OR c.referral IS NOT NULL OR c.campaign_ref IS NOT NULL)
      THEN '🔇 HUMANO SILENCIOSO: línea ads_only y no se detectó anuncio'
    WHEN c.mode = 'human' THEN '✋ En modo HUMANO'
    ELSE '✅ Debería contestar (bot)'
  END                                    AS veredicto
FROM conversations c
JOIN nums        ON regexp_replace(c.phone, '[^0-9]', '', 'g') LIKE '%' || nums.local8
JOIN tenants t   ON t.id = c.tenant_id
LEFT JOIN tenant_lines tl ON tl.id = c.line_id
ORDER BY c.updated_at DESC NULLS LAST;
