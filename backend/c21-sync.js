// =====================================================================
// c21-sync.js — v0.9.427 — Sincronización automática 21Online → properties
// ---------------------------------------------------------------------
// Conexión "directa" con el buscador de 21Online (c21.com.bo): un cron
// diario se loguea con las credenciales del tenant (guardadas cifradas),
// baja el inventario segmentado (el buscador corta en 15 páginas → se
// recorre por tipo × operación) y hace un sync INCREMENTAL:
//   - nuevas → INSERT (source='c21', con fotos por URL)
//   - existentes → UPDATE de datos de origen; NUNCA pisa los campos que
//     el equipo editó a mano en el panel (properties.manual_fields)
//   - ausentes del feed → active=false (Aitana deja de ofrecerlas)
// Config por tenant en tenants.c21_sync (JSONB): {enabled, user, pass_enc,
// filtro: {estados: []}, last_at, last_result}. Gate adicional por tenant:
// c21_import_enabled (mismo permiso que la carga masiva).
// Candado global: env C21_SYNC_ENABLED=0 lo apaga entero.
// Fallas → alerta best-effort al WhatsApp del dueño (OWNER_PHONE).
// =====================================================================
const axios = require('axios');
const db = require('./db');
const express = require('express');
const { encrypt, decryptSafe } = require('./crypto');
const { requireTenantSession, requireRole } = require('./auth');

const BASE = 'https://21online.c21.com.bo';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const TIPOS = ['casa', 'casa-en-condominio', 'departamento', 'penthouse', 'terreno', 'quinta', 'rural', 'rancho', 'cochera', 'edificio', 'colegio', 'hotel', 'proyecto', 'local', 'oficinas', 'deposito', 'tinglado', 'ganaderas'];
const OPS = ['venta', 'renta'];
const MAX_PAGES = 15; // tope duro del buscador de 21Online

// ── schema self-migrante (idempotente; corre al boot) ─────────────────
async function ensureSchema() {
  try { await db.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS c21_sync JSONB`); } catch (e) { console.error('[c21-sync] schema tenants:', e.message); }
  try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS source TEXT`); } catch (e) { console.error('[c21-sync] schema source:', e.message); }
  try { await db.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS manual_fields JSONB DEFAULT '[]'::jsonb`); } catch (e) { console.error('[c21-sync] schema manual_fields:', e.message); }
  // v0.9.429 — email del asesor en el directorio (el detalle de 21Online lo trae)
  try { await db.query(`ALTER TABLE IF EXISTS c21_agents ADD COLUMN IF NOT EXISTS email TEXT`); } catch (e) { console.error('[c21-sync] schema c21_agents.email:', e.message); }
}

// ── cookies ───────────────────────────────────────────────────────────
function mergeCookies(jar, setCookieHeaders) {
  for (const sc of setCookieHeaders || []) {
    const kv = String(sc).split(';')[0];
    const eq = kv.indexOf('=');
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

// ── login (Symfony: _username/_password/_csrf_token) ──────────────────
async function c21Login(user, pass) {
  const jar = {};
  const g = await axios.get(`${BASE}/login`, { headers: { 'User-Agent': UA }, timeout: 30000, maxRedirects: 0, validateStatus: (s) => s < 400 });
  mergeCookies(jar, g.headers['set-cookie']);
  const m = String(g.data).match(/name="_csrf_token"\s+value="([^"]+)"/);
  if (!m) throw new Error('No se encontró el token CSRF del login (¿cambió la página de 21Online?)');
  const body = new URLSearchParams({ _username: user, _password: pass, _csrf_token: m[1] }).toString();
  const p = await axios.post(`${BASE}/login`, body, {
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader(jar), Referer: `${BASE}/login` },
    timeout: 30000, maxRedirects: 0, validateStatus: (s) => s < 400,
  });
  mergeCookies(jar, p.headers['set-cookie']);
  const loc = String(p.headers.location || '');
  if (p.status !== 302 || /login/.test(loc)) throw new Error('Login rechazado por 21Online (usuario o contraseña incorrectos)');
  return jar;
}

// ── feed (segmentado; dedupe por clave) ────────────────────────────────
function _mapType(t) {
  t = String(t || '').toLowerCase();
  if (/lote|terreno|parcela|agr[ií]cola/.test(t)) return 'terreno';
  if (/depart|d[uú]plex|penthouse|studio|suite|loft/.test(t)) return 'departamento';
  if (/casa|chalet|quinta|residencia/.test(t)) return 'casa';
  if (/local|comercial|tienda|galp[oó]n|dep[oó]sito/.test(t)) return 'local';
  if (/oficina/.test(t)) return 'oficina';
  return 'otro';
}
function _mapItem(r) {
  const fotos = (r.fotos && Array.isArray(r.fotos.propiedadThumbnail)) ? r.fotos.propiedadThumbnail.slice(0, 10) : [];
  const enc = String(r.encabezado || '').trim();
  const ubic = [r.colonia, r.municipio, r.estado].filter(Boolean).join(', ');
  let title = enc || `${_mapType(r.tipoPropiedad)} en ${r.municipio || 'Bolivia'}`;
  if (title.length > 90) title = title.slice(0, 87).trim() + '…';
  const m2c = Number(r.m2C) || null, m2t = Number(r.m2T) || null;
  const lat = Number(r.lat) || null, lon = Number(r.lon) || null;
  return {
    code: String(r.id),
    title,
    operation: String(r.tipoOperacion || '').toLowerCase() === 'renta' ? 'alquiler' : 'venta',
    type: _mapType(r.tipoPropiedad),
    zone: r.municipio || null,
    estado: r.estado || null,
    area_m2: (m2c && m2c > 0) ? m2c : (m2t && m2t > 0 ? m2t : null),
    bedrooms: Number(r.recamaras) || null,
    bathrooms: Number(r.banos) || null,
    garages: Number(r.estacionamientos) || null,
    price: r.ocultarPrecioInternet ? null : (Number(r.precio) || null),
    currency: r.moneda === 'USD' ? 'USD' : 'Bs',
    description: [enc, ubic].filter(Boolean).join('\n') || null,
    maps_url: (lat != null && lon != null) ? `https://www.google.com/maps?q=${lat},${lon}` : null,
    image_urls: fotos,
  };
}
async function fetchFeed(jar) {
  const map = new Map();
  const get = async (path, page) => {
    const r = await axios.get(`${BASE}/v/resultados${path}/pagina_${page}?json=true`, {
      headers: { 'User-Agent': UA, Cookie: cookieHeader(jar), Accept: 'application/json' }, timeout: 30000,
      validateStatus: (s) => s === 200 || s === 404,
    });
    if (r.status === 404 || typeof r.data !== 'object') return null;
    return r.data.datas || r.data;
  };
  for (const tipo of TIPOS) {
    // 1ra página del tipo: si el total supera el tope, se recorre por operación
    const first = await get(`/tipo_${tipo}`, 1);
    if (!first || !Array.isArray(first.results) || !first.results.length) continue;
    const total = Number(String(first.totalHits || '0').replace(/[^\d]/g, '')) || 0;
    const paths = total > MAX_PAGES * 100 ? OPS.map((o) => `/tipo_${tipo}/operacion_${o}`) : [`/tipo_${tipo}`];
    for (const path of paths) {
      for (let p = 1; p <= MAX_PAGES; p++) {
        const d = (path === `/tipo_${tipo}` && p === 1) ? first : await get(path, p);
        if (!d || !Array.isArray(d.results) || !d.results.length) break;
        for (const raw of d.results) { const it = _mapItem(raw); map.set(it.code, it); }
        if (d.results.length < 100) break;
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }
  return [...map.values()];
}

// ── asesor de captación (v0.9.429) ────────────────────────────────────
// El listado JSON NO trae al asesor: vive solo en la ficha de detalle
// (/propiedades/ver/detalle/{id}, HTML: "<strong>Asesor: </strong> Nombre").
// Traer 5.000+ detalles bloquearía el sync, así que el backfill corre EN
// SEGUNDO PLANO tras cada sync, con tope por corrida (C21_ADVISOR_CAP,
// default 800 ≈ 7-8 min con pausa de 250 ms). Corrida a corrida converge.
const ADVISOR_CAP = Math.max(0, parseInt(process.env.C21_ADVISOR_CAP || '800', 10) || 0);
function _parseAdvisor(html) {
  const g = (re) => { const m = String(html).match(re); return m ? m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim() : null; };
  const name = g(/<strong>\s*Asesor:\s*<\/strong>\s*([^<]+)/i) || g(/<strong>\s*Cita con:\s*<\/strong>\s*([^<]+)/i);
  let phone = g(/<strong>\s*Celular:\s*<\/strong>\s*([^<]+)/i) || g(/<strong>\s*Tel\.\s*Cita:\s*<\/strong>\s*([^<]+)/i);
  phone = phone ? phone.replace(/[^0-9]/g, '') : null;
  if (phone && /^[67]\d{7}$/.test(phone)) phone = '591' + phone; // móvil BO sin código país → wa.me
  const email = g(/<strong>\s*Email:\s*<\/strong>\s*([^<]+)/i);
  return { name: name || null, phone: phone || null, email: (email && /@/.test(email)) ? email.toLowerCase() : null };
}
async function _advisorsPending(tenantId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM properties WHERE tenant_id = $1 AND source = 'c21' AND active = true AND (assigned_agent_name IS NULL OR assigned_agent_name = '')`,
    [tenantId]).catch(() => ({ rows: [{ n: 0 }] }));
  return r.rows[0].n;
}
let _advRunning = false;
async function backfillAdvisors(jar, tenantId) {
  if (!ADVISOR_CAP || _advRunning) return;
  _advRunning = true;
  let filled = 0, failed = 0;
  try {
    const q = await db.query(
      `SELECT id, code FROM properties WHERE tenant_id = $1 AND source = 'c21' AND active = true AND (assigned_agent_name IS NULL OR assigned_agent_name = '') ORDER BY id LIMIT $2`,
      [tenantId, ADVISOR_CAP]);
    for (const row of q.rows) {
      try {
        const r = await axios.get(`${BASE}/propiedades/ver/detalle/${row.code}`, {
          headers: { 'User-Agent': UA, Cookie: cookieHeader(jar) }, timeout: 30000, validateStatus: (s) => s === 200 || s === 404,
        });
        if (r.status === 200) {
          const a = _parseAdvisor(r.data);
          if (a.name) {
            await db.query(`UPDATE properties SET assigned_agent_name = $1 WHERE id = $2 AND tenant_id = $3 AND (assigned_agent_name IS NULL OR assigned_agent_name = '')`, [a.name, row.id, tenantId]);
            try { // directorio: upsert; no pisa un teléfono cargado a mano con null
              await db.query(
                `INSERT INTO c21_agents (tenant_id, name, phone, email, updated_at) VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET phone = COALESCE(EXCLUDED.phone, c21_agents.phone), email = COALESCE(EXCLUDED.email, c21_agents.email), updated_at = now()`,
                [tenantId, a.name, a.phone, a.email]);
            } catch (_) { /* tabla c21_agents puede no existir en este tenant — best-effort */ }
            filled++;
          } else failed++;
        } else failed++;
      } catch (e) { failed++; }
      await new Promise((r2) => setTimeout(r2, 250));
    }
    const pending = await _advisorsPending(tenantId);
    console.log(`👤 [c21-sync asesores] tenant ${tenantId}: +${filled} asignados · ${failed} sin dato · ${pending} pendientes`);
    await db.query(
      `UPDATE tenants SET c21_sync = COALESCE(c21_sync,'{}'::jsonb) || jsonb_build_object('last_advisors', $2::jsonb) WHERE id = $1`,
      [tenantId, JSON.stringify({ at: new Date().toISOString(), filled, failed, pending })]).catch(() => {});
  } catch (e) {
    console.error(`👤 [c21-sync asesores] tenant ${tenantId} FALLÓ:`, e.message);
  } finally { _advRunning = false; }
}

// ── sync de UN tenant ──────────────────────────────────────────────────
async function syncTenant(tenant, opts) {
  opts = opts || {};
  const cfg = tenant.c21_sync || {};
  if (!cfg.user || !cfg.pass_enc) throw new Error('Faltan credenciales de 21Online');
  const pass = decryptSafe(cfg.pass_enc);
  if (!pass) throw new Error('No se pudo descifrar la contraseña guardada (¿cambió ENCRYPTION_KEY?) — volvé a cargarla en el panel');
  const jar = await c21Login(cfg.user, pass);
  let feed = await fetchFeed(jar);
  const estados = (cfg.filtro && Array.isArray(cfg.filtro.estados) && cfg.filtro.estados.length) ? cfg.filtro.estados : null;
  if (estados) feed = feed.filter((f) => estados.includes(f.estado));
  if (opts.testOnly) return { ok: true, test: true, feed_total: feed.length };
  if (!feed.length) throw new Error('El feed vino vacío — no se toca el catálogo (¿filtro demasiado estricto o cambio en 21Online?)');

  const cur = await db.query(`SELECT id, code, active, manual_fields FROM properties WHERE tenant_id = $1 AND code IS NOT NULL`, [tenant.id]);
  const byCode = new Map(cur.rows.map((r) => [String(r.code), r]));
  let inserted = 0, updated = 0, reactivated = 0; const errors = [];

  for (const f of feed) {
    const ex = byCode.get(f.code);
    try {
      if (!ex) {
        await db.query(
          `INSERT INTO properties (tenant_id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, status, description, image_urls, maps_url, visible_lines, assigned_agent_name, active, created_by, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'disponible',$13,$14::jsonb,$15,NULL,NULL,true,NULL,'c21')`,
          [tenant.id, f.code, f.title, f.operation, f.type, f.zone, f.area_m2, f.bedrooms, f.bathrooms, f.garages, f.price, f.currency, f.description, JSON.stringify(f.image_urls), f.maps_url]);
        inserted++;
      } else {
        const manual = Array.isArray(ex.manual_fields) ? ex.manual_fields : [];
        const sets = ['operation = $3', 'type = $4', 'zone = $5', 'area_m2 = $6', 'bedrooms = $7', 'bathrooms = $8', 'garages = $9', 'currency = $10', 'image_urls = $11::jsonb', 'maps_url = $12', 'active = true', `source = 'c21'`, 'updated_at = NOW()'];
        const vals = [ex.id, tenant.id, f.operation, f.type, f.zone, f.area_m2, f.bedrooms, f.bathrooms, f.garages, f.currency, JSON.stringify(f.image_urls), f.maps_url];
        if (!manual.includes('price')) { vals.push(f.price); sets.push(`price = $${vals.length}`); }
        if (!manual.includes('title')) { vals.push(f.title); sets.push(`title = $${vals.length}`); }
        if (!manual.includes('description')) { vals.push(f.description); sets.push(`description = $${vals.length}`); }
        await db.query(`UPDATE properties SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2`, vals);
        if (!ex.active) reactivated++;
        updated++;
      }
    } catch (e) { errors.push({ code: f.code, error: e.message }); }
  }

  // Ausentes del feed → inactivar (solo las que vinieron del sync/import C21; lo manual no se toca)
  const codes = feed.map((f) => f.code);
  const deact = await db.query(
    `UPDATE properties SET active = false, updated_at = NOW()
     WHERE tenant_id = $1 AND active = true AND code IS NOT NULL AND source = 'c21' AND NOT (code = ANY($2))`,
    [tenant.id, codes]);

  // v0.9.429 — asesor de captación: backfill EN SEGUNDO PLANO (no bloquea la respuesta)
  const advisors_pending = await _advisorsPending(tenant.id);
  if (advisors_pending > 0) setImmediate(() => backfillAdvisors(jar, tenant.id).catch(() => {}));

  return { ok: true, feed_total: feed.length, inserted, updated, reactivated, deactivated: deact.rowCount || 0, advisors_pending, error_count: errors.length, errors: errors.slice(0, 5) };
}

// ── corrida global (cron) ──────────────────────────────────────────────
let _running = false;
async function runC21Sync(opts) {
  if (process.env.C21_SYNC_ENABLED === '0') return { skipped: 'env off' };
  if (_running) return { skipped: 'ya corriendo' };
  _running = true;
  try {
    const t = await db.query(`SELECT id, name, c21_sync FROM tenants WHERE COALESCE(c21_import_enabled, false) = true AND c21_sync IS NOT NULL AND (c21_sync->>'enabled') = 'true'${opts && opts.tenantId ? ' AND id = $1' : ''}`, opts && opts.tenantId ? [opts.tenantId] : []);
    const out = [];
    for (const tenant of t.rows) {
      let result;
      try {
        result = await syncTenant(tenant);
        console.log(`🔄 [c21-sync] tenant ${tenant.id} (${tenant.name}):`, JSON.stringify(result));
      } catch (e) {
        result = { ok: false, error: e.message };
        console.error(`🔄 [c21-sync] tenant ${tenant.id} FALLÓ:`, e.message);
        try { // alerta best-effort al dueño de la plataforma
          const meta = require('./meta');
          if (process.env.OWNER_PHONE) await meta.sendText(process.env.OWNER_PHONE, `⚠️ Sync 21Online FALLÓ para ${tenant.name} (t${tenant.id}): ${e.message}`);
        } catch (_) {}
      }
      try {
        await db.query(`UPDATE tenants SET c21_sync = COALESCE(c21_sync,'{}'::jsonb) || jsonb_build_object('last_at', to_jsonb(NOW()), 'last_result', $2::jsonb) WHERE id = $1`, [tenant.id, JSON.stringify(result)]);
      } catch (_) {}
      out.push({ tenant: tenant.id, ...result });
    }
    return { ran: out.length, out };
  } finally { _running = false; }
}

// Cron diario ~3am Bolivia (UTC-4 → 07 UTC). Chequeo cada 20 min.
let _lastRunDay = null;
function cronTick() {
  const now = new Date();
  if (now.getUTCHours() !== 7) return;
  const day = now.toISOString().slice(0, 10);
  if (_lastRunDay === day) return;
  _lastRunDay = day;
  runC21Sync().catch((e) => console.error('[c21-sync cron]', e.message));
}

// ── endpoints (owner del tenant; requiere c21_import_enabled) ──────────
const router = express.Router();
async function _gate(req, res) {
  const tenantId = req.isSuperAdmin ? (Number(req.query.tenant_id || req.body.tenant_id) || null) : req.tenantId;
  if (!tenantId) { res.status(400).json({ error: 'tenant_id requerido' }); return null; }
  const t = await db.query('SELECT id, name, c21_sync, COALESCE(c21_import_enabled,false) AS ok FROM tenants WHERE id = $1', [tenantId]);
  if (!t.rows.length || !t.rows[0].ok) { res.status(403).json({ error: 'La integración C21 no está habilitada para esta cuenta.' }); return null; }
  return t.rows[0];
}
router.get('/admin/c21-sync-config', requireTenantSession, requireRole('owner'), async (req, res) => {
  const t = await _gate(req, res); if (!t) return;
  const cfg = t.c21_sync || {};
  res.json({ ok: true, config: { enabled: !!cfg.enabled, user: cfg.user || '', has_pass: !!cfg.pass_enc, filtro: cfg.filtro || { estados: [] }, last_at: cfg.last_at || null, last_result: cfg.last_result || null, last_advisors: cfg.last_advisors || null } });
});
router.put('/admin/c21-sync-config', requireTenantSession, requireRole('owner'), async (req, res) => {
  const t = await _gate(req, res); if (!t) return;
  const b = req.body || {}; const cur = t.c21_sync || {};
  const next = {
    ...cur,
    enabled: !!b.enabled,
    user: String(b.user || cur.user || '').trim().slice(0, 120),
    filtro: { estados: Array.isArray(b.estados) ? b.estados.map(String).slice(0, 9) : ((cur.filtro && cur.filtro.estados) || []) },
  };
  if (b.pass) { // contraseña nueva → se cifra; vacío = conservar la guardada
    try { next.pass_enc = encrypt(String(b.pass)); } catch (e) { return res.status(500).json({ error: 'No se pudo cifrar la contraseña: ' + e.message }); }
  }
  await db.query(`UPDATE tenants SET c21_sync = $2::jsonb WHERE id = $1`, [t.id, JSON.stringify(next)]);
  res.json({ ok: true });
});
// v0.9.487 — corridas manuales en curso (una por tenant). El cron tiene su propio
// candado global (_running); el manual NO debe quedar bloqueado por él ni bloquearlo.
const _manualRunning = new Set();

router.post('/admin/c21-sync/run', requireTenantSession, requireRole('owner'), async (req, res) => {
  const t = await _gate(req, res); if (!t) return;
  const testOnly = !!(req.body && req.body.test);
  try {
    if (testOnly) {
      const r = await syncTenant({ id: t.id, name: t.name, c21_sync: t.c21_sync }, { testOnly: true });
      return res.json({ ok: true, test: true, feed_total: r.feed_total, message: `Login OK · ${r.feed_total} propiedades visibles con el filtro actual` });
    }

    // v0.9.487 — "Sincronizar ahora" es una acción EXPLÍCITA del dueño: corre siempre,
    // tenga o no tildado el switch de sincronización diaria.
    // Antes llamaba a runC21Sync(), que filtra por (c21_sync->>'enabled')='true'. Con el
    // switch apagado el SELECT no devolvía filas → {ran:0,out:[]} en ~10ms → el panel
    // no encontraba out[0] ni error y mostraba un "❌ Falló" pelado, sin motivo, y
    // last_at nunca se escribía ("Última corrida: nunca"). El switch ahora solo decide
    // si el CRON diario la incluye.
    if (process.env.C21_SYNC_ENABLED === '0') {
      return res.json({ ok: false, error: 'El sync con 21Online está apagado a nivel plataforma (C21_SYNC_ENABLED=0). Avisale al administrador.' });
    }
    if (_manualRunning.has(t.id)) {
      return res.json({ ok: false, error: 'Ya hay una sincronización corriendo para esta cuenta. Esperá a que termine (puede tardar 1-2 minutos).' });
    }

    _manualRunning.add(t.id);
    let result;
    try {
      result = await syncTenant({ id: t.id, name: t.name, c21_sync: t.c21_sync });
      console.log(`🔄 [c21-sync manual] tenant ${t.id} (${t.name}):`, JSON.stringify(result));
    } catch (e) {
      result = { ok: false, error: e.message };
      console.error(`🔄 [c21-sync manual] tenant ${t.id} FALLÓ:`, e.message);
    } finally {
      _manualRunning.delete(t.id);
    }

    // Igual que el cron: deja rastro de la corrida (arregla el "Última corrida: nunca").
    try {
      await db.query(
        `UPDATE tenants SET c21_sync = COALESCE(c21_sync,'{}'::jsonb) || jsonb_build_object('last_at', to_jsonb(NOW()), 'last_result', $2::jsonb) WHERE id = $1`,
        [t.id, JSON.stringify(result)]);
    } catch (_) { /* best-effort */ }

    // Se mantiene la forma {ok, ran, out:[…]} que ya espera el panel.
    res.json({ ok: true, manual: true, ran: 1, out: [{ tenant: t.id, ...result }] });
  } catch (e) {
    // v0.9.430 — 200 con ok:false (no 502): el helper api() del panel convierte
    // los non-2xx en null y el modal solo podía decir "Falló" sin el motivo.
    res.json({ ok: false, error: e.message });
  }
});

module.exports = { ensureSchema, runC21Sync, cronTick, router };
