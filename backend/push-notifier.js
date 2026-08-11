/**
 * push-notifier.js
 * Helper para enviar Web Push notifications desde el backend.
 *
 * Variables de entorno requeridas:
 *   - VAPID_PUBLIC_KEY
 *   - VAPID_PRIVATE_KEY
 *   - VAPID_SUBJECT (mailto:tu@email.com)
 */

const webpush = require('web-push');
const db = require('./db');

let _configured = false;

function configure() {
  if (_configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@sgsd.com.bo';

  if (!pub || !priv) {
    console.warn('⚠️  VAPID keys no configuradas, push deshabilitado');
    return false;
  }
  webpush.setVapidDetails(subject, pub, priv);
  _configured = true;
  return true;
}

function isConfigured() {
  return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}

/**
 * Envía push a las suscripciones registradas.
 * payload: { title, body, url, icon, conversation_phone }
 * tenantId: filtra por organización (null = todas, legacy).
 * target (v0.9.192, opcional): { roles: ['owner','supervisor',...], userIds: [1,2,...] }
 *   - Si se pasa roles y/o userIds, manda SOLO a las suscripciones cuyo usuario tiene
 *     ese rol (JOIN tenant_users) o cuyo user_id está en la lista (unión OR).
 *   - Sin target → comportamiento legacy: todo el tenant.
 */
async function broadcast(payload, tenantId = null, target = null) {
  if (!configure()) return { sent: 0, failed: 0 };

  const roles = target && Array.isArray(target.roles) && target.roles.length ? target.roles : null;
  const userIds = target && Array.isArray(target.userIds) && target.userIds.length ? target.userIds : null;

  // v0.9.19: filtrar por tenant. v0.9.192: + filtrar por rol/usuario si se pidió.
  let subs;
  try {
    if (tenantId && (roles || userIds)) {
      // v0.9.527 — el filtro por rol/usuario ahora incluye TAMBIÉN las suscripciones legacy
      // sin user_id (user_id IS NULL), que son las que el JOIN por rol no alcanza. Antes, si el
      // filtro no encontraba NADA se caía a MANDAR A TODO EL TENANT ("mejor avisar de más"), y eso
      // pisaba el filtrado por rol: cuando el rol objetivo no tenía dispositivos, la notificación
      // llegaba igual a TODOS (incluido el dueño que la había apagado). Con esto, las suscripciones
      // legacy siguen recibiendo (no se pueden filtrar), pero las que SÍ tienen usuario respetan el
      // rol/usuario pedido, y si nadie califica, NO se manda a nadie (que es lo correcto).
      subs = await db.query(
        `SELECT DISTINCT ps.id, ps.endpoint, ps.p256dh, ps.auth
           FROM push_subscriptions ps
           LEFT JOIN tenant_users u ON u.id = ps.user_id
          WHERE ps.tenant_id = $1
            AND ( ($2::text[] IS NOT NULL AND u.role = ANY($2))
               OR ($3::int[]  IS NOT NULL AND ps.user_id = ANY($3))
               OR ps.user_id IS NULL )`,
        [tenantId, roles, userIds]
      );
    } else if (tenantId) {
      subs = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = $1', [tenantId]);
    } else {
      subs = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions');
    }
  } catch (e) {
    // esquema viejo (sin tenant_id/user_id) → fallback legacy
    try {
      subs = tenantId
        ? await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE tenant_id = $1', [tenantId])
        : await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions');
    } catch (e2) {
      subs = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions');
    }
  }
  if (subs.rows.length === 0) return { sent: 0, failed: 0 };

  // v0.9.253 — diagnóstico: a qué dispositivos va el push (host del push service + cola del endpoint).
  // fcm.googleapis.com = Android/Chrome · web.push.apple.com = iOS · *.mozilla.com = Firefox.
  try {
    const _dst = subs.rows.map(s => { try { return new URL(s.endpoint).host + '…' + String(s.endpoint).slice(-6); } catch (e) { return '?'; } });
    console.log(`🔔 [push] ${subs.rows.length} destinatario(s): ${_dst.join(' | ')}`);
  } catch (e) {}

  const data = JSON.stringify(payload);
  let sent = 0, failed = 0;
  const expiredIds = [];

  await Promise.all(subs.rows.map(async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      // v0.9.256: urgency 'high' → FCM/APNs lo entrega de inmediato aunque el equipo esté en ahorro
      // de batería/doze (clave en Samsung). TTL 24h → no se descarta si el device está un rato offline
      // (antes 60s: en equipos con restricción de fondo el push se vencía y nunca llegaba).
      await webpush.sendNotification(subscription, data, { TTL: 86400, urgency: 'high' });
      sent++;
    } catch (err) {
      // 410 Gone, 404 Not Found = suscripción muerta, hay que borrarla
      if (err.statusCode === 410 || err.statusCode === 404) {
        expiredIds.push(sub.id);
      } else {
        console.warn(`⚠️  Push falló (${sub.endpoint.substring(0, 50)}...):`, err.statusCode || err.message);
      }
      failed++;
    }
  }));

  // Cleanup de suscripciones muertas
  if (expiredIds.length > 0) {
    await db.query('DELETE FROM push_subscriptions WHERE id = ANY($1::int[])', [expiredIds]);
    console.log(`🧹 Borradas ${expiredIds.length} suscripciones expiradas`);
  }

  if (sent > 0) console.log(`🔔 Push enviado a ${sent} dispositivo(s)${failed > 0 ? ` (${failed} fallaron)` : ''}`);
  return { sent, failed };
}

module.exports = { isConfigured, configure, broadcast };
