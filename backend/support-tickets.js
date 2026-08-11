/**
 * support-tickets.js — lógica de la Mesa de Soporte (BPO). Fase 1.
 *
 * Capa de dominio del ciclo de vida de ticket, AISLADA de api.js (que es enorme).
 * Las rutas Express solo llaman a estas funciones. Toda la lógica de estados,
 * presencia, SLA y audit (ticket_events) vive acá, así se testea sin levantar HTTP.
 *
 * Esquema: lo crea migrate-support-bpo-v09113b.js (v0.9.113). Todo gateado por
 * tenants.support_enabled (las rutas chequean el flag antes de llamar acá).
 *
 * Convención de tipos: tenants/conversations/tenant_users.id = SERIAL int4.
 */
const db = require('./db');

// ── Máquina de estados ──────────────────────────────────────────────────────
// open → in_progress → (pending ⇄ in_progress) → resolved → closed
// resolved/closed → in_progress (reopen). escalated es lateral desde in_progress/open.
const TRANSITIONS = {
  open:        ['in_progress', 'escalated', 'resolved', 'closed'],
  in_progress: ['pending', 'escalated', 'resolved', 'closed'],
  pending:     ['in_progress', 'resolved', 'closed'],
  escalated:   ['in_progress', 'resolved', 'closed'],
  resolved:    ['in_progress', 'closed'],        // in_progress = reapertura
  closed:      ['in_progress'],                   // reapertura
};
const ACTIVE = ['open', 'in_progress', 'pending', 'escalated']; // "vivo" (no resuelto/cerrado)

function canTransition(from, to) {
  return Array.isArray(TRANSITIONS[from]) && TRANSITIONS[from].includes(to);
}

// ── Transacción helper ──────────────────────────────────────────────────────
async function tx(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Audit: registrar evento del ticket (quién hizo qué) ─────────────────────
async function logEvent(q, { ticketId, tenantId, actorUserId = null, actorKind = 'system', eventType, from = null, to = null, meta = {} }) {
  await q.query(
    `INSERT INTO ticket_events (ticket_id, tenant_id, actor_user_id, actor_kind, event_type, from_value, to_value, meta)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [ticketId, tenantId, actorUserId, actorKind, eventType, from, to, JSON.stringify(meta)]
  );
}

// ── SLA: due-ats a partir de la categoría (snapshot al crear/categorizar) ────
async function slaDueAts(q, { tenantId, category, baseAt }) {
  const def = { first: 30, resolution: 240 }; // fallback si no hay categoría
  let mins = def;
  if (category) {
    const r = await q.query(
      `SELECT sla_first_response_min AS first, sla_resolution_min AS resolution
         FROM support_categories WHERE tenant_id = $1 AND key = $2`,
      [tenantId, category]
    );
    if (r.rows[0]) mins = r.rows[0];
  }
  return {
    firstDue: new Date(baseAt.getTime() + mins.first * 60000),
    resolutionDue: new Date(baseAt.getTime() + mins.resolution * 60000),
  };
}

// ── Presencia: ajustar el cache de chats activos del agente ─────────────────
async function bumpPresence(q, { tenantUserId, tenantId, delta }) {
  if (!tenantUserId) return;
  // upsert defensivo: si el agente no tiene fila de presencia, la crea.
  await q.query(
    `INSERT INTO agent_presence (tenant_user_id, tenant_id, active_chats)
       VALUES ($1, $2, GREATEST(0, $3))
     ON CONFLICT (tenant_user_id) DO UPDATE
       SET active_chats = GREATEST(0, agent_presence.active_chats + $3)`,
    [tenantUserId, tenantId, delta]
  );
}

// ── Crear ticket si no hay uno activo en la conversación (idempotente) ──────
// Se apoya en el unique parcial uq_tickets_open_per_conversation para blindar
// carreras (dos inbounds casi simultáneos). Devuelve { ticket, created }.
async function createTicketIfNone(opts) {
  const { tenantId, conversationId, category = null, priority = 'normal',
          handledBy = 'bot', triage = {}, actorKind = 'bot', actorUserId = null } = opts;
  return tx(async (q) => {
    const existing = await q.query(
      `SELECT * FROM support_tickets
        WHERE conversation_id = $1 AND status = ANY($2) LIMIT 1`,
      [conversationId, ACTIVE]
    );
    if (existing.rows[0]) return { ticket: existing.rows[0], created: false };

    const now = new Date();
    const { firstDue, resolutionDue } = await slaDueAts(q, { tenantId, category, baseAt: now });
    let ins;
    try {
      ins = await q.query(
        `INSERT INTO support_tickets
           (tenant_id, conversation_id, status, handled_by, category, priority,
            ai_summary, ai_reasoning, ai_confidence, sentiment,
            sla_first_response_due_at, sla_resolution_due_at)
         VALUES ($1,$2,'open',$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [tenantId, conversationId, handledBy, category, priority,
         triage.summary || null, triage.reasoning || null, triage.confidence || null, triage.sentiment || null,
         firstDue, resolutionDue]
      );
    } catch (e) {
      // carrera: otro proceso creó el ticket activo entre el SELECT y el INSERT.
      if (/uq_tickets_open_per_conversation|duplicate key/i.test(e.message)) {
        const again = await q.query(
          `SELECT * FROM support_tickets WHERE conversation_id = $1 AND status = ANY($2) LIMIT 1`,
          [conversationId, ACTIVE]
        );
        if (again.rows[0]) return { ticket: again.rows[0], created: false };
      }
      throw e;
    }
    const ticket = ins.rows[0];
    await logEvent(q, { ticketId: ticket.id, tenantId, actorUserId, actorKind, eventType: 'created', to: 'open', meta: { category, handledBy } });
    return { ticket, created: true };
  });
}

// ── Tomar (claim): open/pending/escalated → in_progress, asignado a mí ───────
async function claimTicket({ ticketId, tenantId, userId }) {
  return tx(async (q) => {
    const cur = await q.query(`SELECT * FROM support_tickets WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [ticketId, tenantId]);
    const t = cur.rows[0];
    if (!t) throw new Error('TICKET_NOT_FOUND');
    if (!canTransition(t.status, 'in_progress')) throw new Error(`BAD_TRANSITION_${t.status}_in_progress`);

    const prevAgent = t.assigned_agent_id;
    const upd = await q.query(
      `UPDATE support_tickets
          SET status='in_progress', handled_by='agent', assigned_agent_id=$1,
              assigned_at=NOW(), updated_at=NOW()
        WHERE id=$2 RETURNING *`,
      [userId, ticketId]
    );
    if (prevAgent && prevAgent !== userId) await bumpPresence(q, { tenantUserId: prevAgent, tenantId, delta: -1 });
    await bumpPresence(q, { tenantUserId: userId, tenantId, delta: +1 });
    await logEvent(q, { ticketId, tenantId, actorUserId: userId, actorKind: 'agent', eventType: 'assigned', from: t.status, to: 'in_progress', meta: { self: true } });
    return upd.rows[0];
  });
}

// ── Asignar/transferir (supervisor o cesión entre agentes) ──────────────────
async function assignTicket({ ticketId, tenantId, toUserId, byUserId, actorKind = 'supervisor' }) {
  return tx(async (q) => {
    const cur = await q.query(`SELECT * FROM support_tickets WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [ticketId, tenantId]);
    const t = cur.rows[0];
    if (!t) throw new Error('TICKET_NOT_FOUND');
    const prevAgent = t.assigned_agent_id;
    const nextStatus = ACTIVE.includes(t.status) ? 'in_progress' : t.status;
    const upd = await q.query(
      `UPDATE support_tickets
          SET assigned_agent_id=$1, status=$2, handled_by='agent', assigned_at=NOW(), updated_at=NOW()
        WHERE id=$3 RETURNING *`,
      [toUserId, nextStatus, ticketId]
    );
    if (prevAgent && prevAgent !== toUserId) await bumpPresence(q, { tenantUserId: prevAgent, tenantId, delta: -1 });
    await bumpPresence(q, { tenantUserId: toUserId, tenantId, delta: +1 });
    await logEvent(q, { ticketId, tenantId, actorUserId: byUserId, actorKind, eventType: prevAgent ? 'transferred' : 'assigned', from: String(prevAgent || ''), to: String(toUserId), meta: {} });
    return upd.rows[0];
  });
}

// ── Cambio de estado genérico (pending/escalated/resolved/closed) ───────────
async function transitionStatus({ ticketId, tenantId, toStatus, actorUserId = null, actorKind = 'agent' }) {
  return tx(async (q) => {
    const cur = await q.query(`SELECT * FROM support_tickets WHERE id=$1 AND tenant_id=$2 FOR UPDATE`, [ticketId, tenantId]);
    const t = cur.rows[0];
    if (!t) throw new Error('TICKET_NOT_FOUND');
    if (!canTransition(t.status, toStatus)) throw new Error(`BAD_TRANSITION_${t.status}_${toStatus}`);

    const sets = [`status=$1`, `updated_at=NOW()`];
    const vals = [toStatus];
    if (toStatus === 'resolved') sets.push(`resolved_at=NOW()`);
    if (toStatus === 'closed')   sets.push(`closed_at=NOW()`);
    // reapertura: si vuelve a in_progress desde resolved/closed, contar y limpiar timestamps.
    const isReopen = (t.status === 'resolved' || t.status === 'closed') && toStatus === 'in_progress';
    if (isReopen) { sets.push(`reopened_count = reopened_count + 1`, `resolved_at=NULL`, `closed_at=NULL`); }

    const upd = await q.query(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id=$${vals.length + 1} RETURNING *`, [...vals, ticketId]);

    // presencia: liberar al salir de "vivo" (resolved/closed); re-ocupar al volver
    // a "vivo" en una reapertura (si el ticket sigue con agente asignado).
    const leftActive = ACTIVE.includes(t.status) && !ACTIVE.includes(toStatus);
    const enteredActive = !ACTIVE.includes(t.status) && ACTIVE.includes(toStatus);
    if (leftActive && t.assigned_agent_id) await bumpPresence(q, { tenantUserId: t.assigned_agent_id, tenantId, delta: -1 });
    if (enteredActive && t.assigned_agent_id) await bumpPresence(q, { tenantUserId: t.assigned_agent_id, tenantId, delta: +1 });

    await logEvent(q, { ticketId, tenantId, actorUserId, actorKind,
      eventType: isReopen ? 'reopened' : (toStatus === 'resolved' ? 'resolved' : (toStatus === 'closed' ? 'closed' : 'status_change')),
      from: t.status, to: toStatus });
    return upd.rows[0];
  });
}

// ── Primera respuesta humana: setear first_response_at + evaluar SLA ────────
// Llamar desde el camino de envío humano (panel/send y echo del webhook).
async function recordFirstResponse({ tenantId, conversationId, actorUserId = null }) {
  return tx(async (q) => {
    const cur = await q.query(
      `SELECT * FROM support_tickets
        WHERE conversation_id=$1 AND status=ANY($2) AND first_response_at IS NULL
        ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [conversationId, ACTIVE]
    );
    const t = cur.rows[0];
    if (!t) return null; // no hay ticket vivo sin primera respuesta → nada que hacer
    const breached = t.sla_first_response_due_at && new Date() > new Date(t.sla_first_response_due_at);
    await q.query(
      `UPDATE support_tickets
          SET first_response_at=NOW(), updated_at=NOW(),
              sla_breached = sla_breached OR $2,
              breach_kind = CASE WHEN $2 AND breach_kind IS NULL THEN 'first_response' ELSE breach_kind END
        WHERE id=$1`,
      [t.id, !!breached]
    );
    await logEvent(q, { ticketId: t.id, tenantId, actorUserId, actorKind: 'agent', eventType: 'first_response', meta: { breached: !!breached } });
    if (breached) await logEvent(q, { ticketId: t.id, tenantId, actorKind: 'system', eventType: 'sla_breach', to: 'first_response' });
    return t.id;
  });
}

// ── Ventana de servicio de WhatsApp: último inbound + 24h ────────────────────
async function touchWindow({ conversationId, baseAt = new Date() }) {
  await db.query(
    `UPDATE conversations SET window_expires_at = $2 WHERE id = $1`,
    [conversationId, new Date(baseAt.getTime() + 24 * 3600 * 1000)]
  );
}

// ── Scanner de SLA (lo llama el worker de n8n por endpoint) ──────────────────
// Marca breaches de resolución de tickets vivos cuyo due ya pasó. Devuelve IDs.
async function scanSlaBreaches({ tenantId }) {
  const r = await db.query(
    `UPDATE support_tickets
        SET sla_breached = TRUE,
            breach_kind = COALESCE(breach_kind, 'resolution')
      WHERE tenant_id = $1
        AND status NOT IN ('resolved','closed')
        AND sla_breached = FALSE
        AND sla_resolution_due_at IS NOT NULL
        AND NOW() > sla_resolution_due_at
      RETURNING id`,
    [tenantId]
  );
  return r.rows.map((x) => x.id);
}

// ── Auto-ruteo (Fase 2): asigna al mejor agente ONLINE con capacidad ────────
// Estrategia: menor carga (active_chats) primero; desempate por last_seen_at.
// Si no hay nadie disponible, devuelve null y el ticket queda en la cola (open).
// NO silencia al bot (eso es solo el claim/Tomar control): el agente queda como
// dueño del caso mientras Aitana sigue resolviendo el primer nivel.
async function autoAssign({ tenantId, ticketId, byUserId = null }) {
  const cand = await db.query(
    `SELECT tenant_user_id FROM agent_presence
      WHERE tenant_id = $1 AND status = 'online' AND active_chats < max_concurrent
      ORDER BY active_chats ASC, last_seen_at ASC NULLS LAST
      LIMIT 1`,
    [tenantId]
  );
  if (!cand.rows[0]) return null;
  const toUserId = cand.rows[0].tenant_user_id;
  await assignTicket({ ticketId, tenantId, toUserId, byUserId, actorKind: 'system' });
  return toUserId;
}

// ── Auto-cierre (Fase 2): cierra tickets resueltos hace > N días (worker n8n) ─
async function autoCloseResolved({ tenantId, days = 3 }) {
  const r = await db.query(
    `UPDATE support_tickets
        SET status = 'closed', closed_at = NOW(), updated_at = NOW()
      WHERE tenant_id = $1 AND status = 'resolved'
        AND resolved_at IS NOT NULL
        AND resolved_at < NOW() - make_interval(days => $2::int)
      RETURNING id`,
    [tenantId, days]
  );
  for (const row of r.rows) {
    await logEvent(db, { ticketId: row.id, tenantId, actorKind: 'system', eventType: 'closed', from: 'resolved', to: 'closed', meta: { auto: true, after_days: days } });
  }
  return r.rows.map((x) => x.id);
}

// ── Captura de CSAT (Fase 2): el cliente respondió 1-5 a la encuesta ────────
// Escribe csat en el último ticket resuelto/cerrado de la conversación (sin csat
// aún) dentro de una ventana corta. Idempotente. Devuelve el ticket id o null.
async function recordCsat({ tenantId, conversationId, score }) {
  const s = parseInt(score, 10);
  if (!(s >= 1 && s <= 5)) return null;
  const r = await db.query(
    `UPDATE support_tickets SET csat = $3, updated_at = NOW()
      WHERE id = (
        SELECT id FROM support_tickets
         WHERE tenant_id = $1 AND conversation_id = $2 AND csat IS NULL
           AND status IN ('resolved','closed')
           AND COALESCE(resolved_at, updated_at) > NOW() - interval '3 days'
         ORDER BY COALESCE(resolved_at, updated_at) DESC LIMIT 1)
      RETURNING id`,
    [tenantId, conversationId, s]
  );
  if (!r.rows[0]) return null;
  await logEvent(db, { ticketId: r.rows[0].id, tenantId, actorKind: 'client', eventType: 'csat', to: String(s) });
  return r.rows[0].id;
}

// v0.9.331 — comentario abierto opcional del cliente, justo despues del puntaje.
// Escribe en el ultimo ticket con csat puesto y comentario nulo, respondido hace <15 min.
async function recordCsatComment({ tenantId, conversationId, comment }) {
  const c = String(comment || '').trim().slice(0, 2000);
  if (!c) return null;
  const r = await db.query(
    `UPDATE support_tickets SET csat_comment = $3, updated_at = NOW()
      WHERE id = (
        SELECT id FROM support_tickets
         WHERE tenant_id = $1 AND conversation_id = $2
           AND csat IS NOT NULL AND csat_comment IS NULL
           AND updated_at > NOW() - interval '15 minutes'
         ORDER BY updated_at DESC LIMIT 1)
      RETURNING id`,
    [tenantId, conversationId, c]
  );
  return r.rows[0] ? r.rows[0].id : null;
}

// v0.9.334 — ¿hay un CSAT recién respondido esperando comentario? (para NO crear ticket nuevo
// cuando el cliente escribe el comentario justo después de calificar).
async function hasPendingCsatComment({ tenantId, conversationId }) {
  const r = await db.query(
    `SELECT 1 FROM support_tickets
      WHERE tenant_id = $1 AND conversation_id = $2
        AND csat IS NOT NULL AND csat_comment IS NULL
        AND updated_at > NOW() - interval '15 minutes' LIMIT 1`,
    [tenantId, conversationId]
  );
  return r.rows.length > 0;
}

// v0.9.313 — auto-resolver tickets ACTIVOS por inactividad del cliente (última respuesta del
// cliente > N horas). Pasa a 'resolved' con actor 'system'. Devuelve los ids resueltos.
async function autoResolveIdleTickets({ tenantId, hours = 24 }) {
  const h = parseInt(hours, 10);
  if (!(h > 0)) return [];
  const r = await db.query(
    `SELECT st.id
       FROM support_tickets st
      WHERE st.tenant_id = $1
        AND st.status = ANY($2)
        AND COALESCE(
              (SELECT MAX(m.created_at) FROM messages m
                WHERE m.conversation_id = st.conversation_id AND m.direction = 'incoming'),
              st.created_at
            ) < NOW() - make_interval(hours => $3::int)`,
    [tenantId, ACTIVE, h]
  );
  const ids = [];
  for (const row of r.rows) {
    try {
      await transitionStatus({ ticketId: row.id, tenantId, toStatus: 'resolved', actorKind: 'system' });
      await logEvent(db, { ticketId: row.id, tenantId, actorKind: 'system', eventType: 'resolved', to: 'resolved', meta: { auto: true, reason: 'idle', after_hours: h } });
      ids.push(row.id);
    } catch (e) { /* transición inválida → skip */ }
  }
  return ids;
}

module.exports = {
  TRANSITIONS, ACTIVE, canTransition,
  logEvent, slaDueAts, bumpPresence,
  createTicketIfNone, claimTicket, assignTicket, transitionStatus,
  recordFirstResponse, touchWindow, scanSlaBreaches,
  autoAssign, autoCloseResolved, autoResolveIdleTickets, recordCsat, recordCsatComment, hasPendingCsatComment,
};
