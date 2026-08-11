// =====================================================================
// mcp-server.js — v0.9.495 — Conector de Claude (MCP remoto, Streamable HTTP)
// ---------------------------------------------------------------------
// Deja que un asesor use SU cuenta de Claude (incluso la gratis: permite un
// conector personalizado) para trabajar el catálogo conversando:
//   "cargame este proyecto del brochure" / "qué tengo en Equipetrol bajo 150k".
//
// Cableado deliberadamente simple (pedido de José):
//   · URL del conector: https://app.sg-ventas.com/mcp  (sin OAuth)
//   · El asesor se identifica con las MISMAS credenciales de la app móvil
//     (tenant_users.email + password) vía la herramienta iniciar_sesion, que
//     reusa POST /api/auth/login (mismos rate-limits, mismos chequeos).
//   · Todo lo que Claude crea entra como BORRADOR (active=false, source='claude'):
//     Claude propone, el asesor revisa en el panel y activa. Un brochure mal
//     leído nunca llega solo a un cliente real.
//   · Fotos: por URL (mismo mecanismo que el sync 21Online).
//
// Protocolo: JSON-RPC 2.0 sobre POST /mcp (Streamable HTTP). Respondemos
// application/json directo (permitido por la spec); GET → 405 (no hay push).
// La sesión MCP (Mcp-Session-Id) cachea el JWT para no re-loguear por llamada;
// el token también se devuelve por si el cliente no persiste la sesión.
// =====================================================================
const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const { verifySession } = require('./auth');

const PROTOCOL_FALLBACK = '2025-03-26';
const SESSIONS = new Map(); // Mcp-Session-Id → { token, at }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
setInterval(() => { const now = Date.now(); for (const [k, v] of SESSIONS) if (now - v.at > SESSION_TTL_MS) SESSIONS.delete(k); }, 30 * 60 * 1000).unref();

const PROP_TYPES = ['casa', 'departamento', 'terreno', 'local', 'oficina', 'otro'];
const PROP_OPS = ['venta', 'alquiler', 'anticretico'];

// ── helpers ───────────────────────────────────────────────────────────
function _s(v, max) { const x = String(v == null ? '' : v).trim(); return x ? x.slice(0, max || 500) : null; }
function _num(v) { if (v == null || v === '') return null; const n = Number(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : null; }
function _int(v) { const n = _num(v); return n == null ? null : Math.round(n); }
function _cur(v) { const c = String(v || '').trim().toUpperCase(); return c === 'BS' ? 'Bs' : 'USD'; }
function _normFormats(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const f of v.slice(0, 30)) {
    if (!f || typeof f !== 'object') continue;
    const label = _s(f.label || f.nombre, 60);
    if (!label) continue;
    out.push({
      label,
      m2: _s(f.m2, 20), dorm: _s(f.dorm || f.dormitorios, 20),
      price_from: _s(f.price_from || f.precio_desde, 40),
      availability: _s(f.availability || f.disponibilidad, 60),
    });
  }
  return out;
}
function _fotos(v) {
  if (!Array.isArray(v)) return { urls: [], labels: {} };
  const urls = []; const labels = {};
  for (const f of v.slice(0, 20)) {
    const url = _s(f && (f.url || f), 800);
    if (!url || !/^https?:\/\//i.test(url)) continue;
    urls.push(url);
    const d = _s(f && f.descripcion, 200);
    if (d) labels[url] = d;
  }
  return { urls, labels };
}

// Resuelve la sesión del asesor: token explícito > sesión MCP cacheada.
async function _auth(args, sid) {
  const token = _s(args && args.token, 2000) || (SESSIONS.get(sid) || {}).token;
  if (!token) throw new Error('Primero iniciá sesión con la herramienta iniciar_sesion (email y contraseña del CRM, los mismos de la app móvil).');
  const payload = verifySession(token);
  if (!payload || !payload.tenant_id) throw new Error('La sesión expiró o el token no es válido. Volvé a usar iniciar_sesion.');
  let user = { id: payload.user_id || null, name: payload.name || 'Usuario', role: payload.role || 'owner', agent_name: null };
  if (payload.user_id) {
    const r = await db.query(
      `SELECT display_name, role, active, COALESCE(to_jsonb(tenant_users) ->> 'c21_agent_name', '') AS agent
         FROM tenant_users WHERE id = $1 AND tenant_id = $2`, [payload.user_id, payload.tenant_id]);
    if (!r.rows.length || !r.rows[0].active) throw new Error('Tu usuario está desactivado en el CRM. Hablá con el dueño de tu organización.');
    user = { id: payload.user_id, name: r.rows[0].display_name || payload.name, role: r.rows[0].role, agent_name: r.rows[0].agent || null };
  }
  return { tenantId: payload.tenant_id, user, token };
}

function _propRow(p) {
  return {
    id: p.id, titulo: p.title, operacion: p.operation, tipo: p.type, zona: p.zone,
    precio: p.price != null ? Number(p.price) : null, moneda: p.currency || 'USD',
    m2: p.area_m2 != null ? Number(p.area_m2) : null, dormitorios: p.bedrooms, banos: p.bathrooms,
    estado: p.status, activo: p.active !== false,
    borrador: p.active === false && p.source === 'claude' ? true : undefined,
    fotos: Array.isArray(p.image_urls) ? p.image_urls.length : 0,
    formatos: Array.isArray(p.formats) ? p.formats.length : 0,
    asesor: p.assigned_agent_name || null,
  };
}

// ── herramientas ──────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'iniciar_sesion',
    description: 'Iniciar sesión en el CRM SG Ventas con el email y la contraseña del asesor (las mismas credenciales de la app móvil). Hay que llamarla una vez antes de usar las demás herramientas.',
    inputSchema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } }, required: ['email', 'password'] },
  },
  {
    name: 'buscar_inmuebles',
    description: 'Buscar en el catálogo de inmuebles del asesor. Todos los filtros son opcionales. Devuelve hasta 20 resultados con id, título, zona, precio y estado. Incluye los borradores creados por Claude (marcados borrador=true).',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string', description: 'Token de sesión (opcional si ya iniciaste sesión en esta conversación)' },
      texto: { type: 'string', description: 'Busca en título y zona' },
      zona: { type: 'string' }, tipo: { type: 'string', enum: PROP_TYPES }, operacion: { type: 'string', enum: PROP_OPS },
      dormitorios_min: { type: 'integer' }, precio_min: { type: 'number' }, precio_max: { type: 'number' },
      moneda: { type: 'string', enum: ['USD', 'Bs'], description: 'Obligatoria si usás precio_min/precio_max, para no mezclar Bs con dólares' },
    } },
  },
  {
    name: 'crear_inmueble',
    description: 'Crear un inmueble o proyecto en el catálogo. SIEMPRE entra como BORRADOR: el asesor lo revisa y lo activa desde el panel. Para un proyecto con varias tipologías usá formats (label, m2, dorm, price_from, availability) y en price el precio "desde". Las fotos van por URL pública.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string' },
      titulo: { type: 'string' }, operacion: { type: 'string', enum: PROP_OPS }, tipo: { type: 'string', enum: PROP_TYPES },
      zona: { type: 'string' }, precio: { type: 'number' }, moneda: { type: 'string', enum: ['USD', 'Bs'] },
      m2: { type: 'number' }, dormitorios: { type: 'integer' }, banos: { type: 'integer' }, garajes: { type: 'integer' },
      descripcion: { type: 'string' }, maps_url: { type: 'string' },
      formats: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, m2: { type: 'string' }, dorm: { type: 'string' }, price_from: { type: 'string' }, availability: { type: 'string' } }, required: ['label'] } },
      fotos: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, descripcion: { type: 'string' } }, required: ['url'] } },
    }, required: ['titulo'] },
  },
  {
    name: 'actualizar_inmueble',
    description: 'Actualizar campos de un inmueble existente del catálogo (buscalo antes con buscar_inmuebles para tener el id). Con activar=true se publica un borrador. formats reemplaza la lista completa de tipologías.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string' }, id: { type: 'integer' },
      titulo: { type: 'string' }, operacion: { type: 'string', enum: PROP_OPS }, tipo: { type: 'string', enum: PROP_TYPES },
      zona: { type: 'string' }, precio: { type: 'number' }, moneda: { type: 'string', enum: ['USD', 'Bs'] },
      m2: { type: 'number' }, dormitorios: { type: 'integer' }, banos: { type: 'integer' }, garajes: { type: 'integer' },
      descripcion: { type: 'string' }, estado: { type: 'string', enum: ['disponible', 'reservado', 'vendido'] },
      activar: { type: 'boolean', description: 'true = publicar (visible para Aitana y el panel)' },
      formats: { type: 'array', items: { type: 'object' } },
    }, required: ['id'] },
  },
  {
    name: 'agregar_fotos',
    description: 'Agregar fotos por URL pública a un inmueble existente, cada una con su descripción corta (qué muestra: fachada, cocina, piscina…). La primera foto del inmueble es la que Aitana manda por WhatsApp.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string' }, id: { type: 'integer' },
      fotos: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' }, descripcion: { type: 'string' } }, required: ['url'] } },
    }, required: ['id', 'fotos'] },
  },
  {
    name: 'link_de_fotos',
    description: 'Devuelve un link temporal para que el asesor suba las fotos desde su celular o computadora. USALO SIEMPRE que las fotos estén dentro de un PDF/brochure, o cuando el asesor las tenga como archivos — vos no podés subir imágenes al CRM. El asesor abre el link, suelta el PDF y el servidor extrae las fotos y se las pega al inmueble solo. Si en cambio ya tenés URLs públicas de las fotos, usá agregar_fotos.',
    inputSchema: { type: 'object', properties: {
      token: { type: 'string' }, id: { type: 'integer', description: 'id del inmueble' },
    }, required: ['id'] },
  },
];

// ── implementación ────────────────────────────────────────────────────
async function toolLogin(args, sid) {
  const email = _s(args.email, 160); const password = String(args.password || '');
  if (!email || !password) throw new Error('Falta el email o la contraseña.');
  const axios = require('axios');
  const port = process.env.PORT || 3000;
  let resp;
  try {
    resp = await axios.post(`http://127.0.0.1:${port}/api/auth/login`, { email, password }, { timeout: 10000 });
  } catch (e) {
    const msg = (e.response && e.response.data && e.response.data.error) || 'No se pudo iniciar sesión.';
    throw new Error(msg);
  }
  const d = resp.data || {};
  if (!d.session_token) throw new Error('El login no devolvió sesión. Probá de nuevo.');
  if (sid) SESSIONS.set(sid, { token: d.session_token, at: Date.now() });
  return {
    ok: true,
    mensaje: `Sesión iniciada como ${d.user && d.user.name} (${d.user && d.user.role}) en ${d.tenant && d.tenant.name}. Ya podés buscar y cargar inmuebles.`,
    token: d.session_token,
    nota: 'Guardá este token para las próximas llamadas si la sesión se corta.',
  };
}

async function toolBuscar(args, sid) {
  const { tenantId } = await _auth(args, sid);
  const params = [tenantId]; let where = 'tenant_id = $1';
  const q = _s(args.texto, 80);
  if (q) { params.push(`%${q}%`); where += ` AND (title ILIKE $${params.length} OR zone ILIKE $${params.length})`; }
  const zona = _s(args.zona, 80);
  if (zona) { params.push(`%${zona}%`); where += ` AND zone ILIKE $${params.length}`; }
  if (PROP_TYPES.includes(args.tipo)) { params.push(args.tipo); where += ` AND type = $${params.length}`; }
  if (PROP_OPS.includes(args.operacion)) { params.push(args.operacion); where += ` AND operation = $${params.length}`; }
  const dm = _int(args.dormitorios_min); if (dm) { params.push(dm); where += ` AND bedrooms >= $${params.length}`; }
  const pmin = _num(args.precio_min), pmax = _num(args.precio_max);
  if ((pmin || pmax) && !args.moneda) throw new Error('Para filtrar por precio indicá también la moneda (USD o Bs) — si no, se mezclan dólares con bolivianos.');
  if (args.moneda) { params.push(_cur(args.moneda)); where += ` AND UPPER(COALESCE(NULLIF(TRIM(currency), ''), 'USD')) = UPPER($${params.length})`; }
  if (pmin) { params.push(pmin); where += ` AND price >= $${params.length}`; }
  if (pmax) { params.push(pmax); where += ` AND price <= $${params.length}`; }
  const r = await db.query(
    `SELECT id, title, operation, type, zone, price, currency, area_m2, bedrooms, bathrooms, status, active, image_urls, assigned_agent_name,
            to_jsonb(properties) -> 'formats' AS formats, to_jsonb(properties) ->> 'source' AS source
       FROM properties WHERE ${where}
       ORDER BY active DESC, updated_at DESC NULLS LAST, id DESC LIMIT 20`, params);
  return { total_mostrados: r.rows.length, nota: r.rows.length === 20 ? 'Hay más resultados: afiná el filtro.' : undefined, inmuebles: r.rows.map(_propRow) };
}

async function toolCrear(args, sid) {
  const { tenantId, user } = await _auth(args, sid);
  const title = _s(args.titulo, 120);
  if (!title) throw new Error('Falta el título del inmueble.');
  const formats = _normFormats(args.formats);
  const { urls, labels } = _fotos(args.fotos);
  const asesor = user.agent_name || user.name || null;
  const r = await db.query(
    `INSERT INTO properties (tenant_id, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency,
                             status, description, image_urls, image_labels, maps_url, formats, assigned_agent_name, active, created_by, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'disponible',$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17,false,$18,'claude')
     RETURNING id`,
    [tenantId, title, PROP_OPS.includes(args.operacion) ? args.operacion : 'venta',
     PROP_TYPES.includes(args.tipo) ? args.tipo : 'otro', _s(args.zona, 120),
     _num(args.m2), _int(args.dormitorios), _int(args.banos), _int(args.garajes), _num(args.precio), _cur(args.moneda),
     _s(args.descripcion, 4000), JSON.stringify(urls), JSON.stringify(labels), _s(args.maps_url, 400),
     formats ? JSON.stringify(formats) : null, asesor, user.id]);
  console.log(`🤖 [mcp] tenant ${tenantId}: inmueble BORRADOR #${r.rows[0].id} creado por ${user.name} vía Claude`);
  return {
    ok: true, id: r.rows[0].id,
    estado: 'BORRADOR — todavía no lo ve Aitana ni sale en el catálogo activo.',
    siguiente_paso: `Decile al asesor que entre al panel (Propiedades), revise el inmueble #${r.rows[0].id} y lo active. También puede activarse desde acá con actualizar_inmueble {id: ${r.rows[0].id}, activar: true} una vez revisado.`,
    fotos_cargadas: urls.length, formatos_cargados: formats ? formats.length : 0,
  };
}

const _UPD_FIELDS = {
  titulo: ['title', (v) => _s(v, 120)], zona: ['zone', (v) => _s(v, 120)], descripcion: ['description', (v) => _s(v, 4000)],
  operacion: ['operation', (v) => PROP_OPS.includes(v) ? v : null], tipo: ['type', (v) => PROP_TYPES.includes(v) ? v : null],
  precio: ['price', _num], moneda: ['currency', _cur], m2: ['area_m2', _num],
  dormitorios: ['bedrooms', _int], banos: ['bathrooms', _int], garajes: ['garages', _int],
  estado: ['status', (v) => ['disponible', 'reservado', 'vendido'].includes(v) ? v : null],
};

async function toolActualizar(args, sid) {
  const { tenantId, user } = await _auth(args, sid);
  const id = _int(args.id);
  if (!id) throw new Error('Falta el id del inmueble (buscalo con buscar_inmuebles).');
  const sets = []; const vals = [id, tenantId];
  for (const [k, [col, fn]] of Object.entries(_UPD_FIELDS)) {
    if (args[k] === undefined) continue;
    const v = fn(args[k]);
    if (v === null && args[k] !== null) continue;
    vals.push(v); sets.push(`${col} = $${vals.length}`);
  }
  if (args.formats !== undefined) { const f = _normFormats(args.formats) || []; vals.push(JSON.stringify(f)); sets.push(`formats = $${vals.length}::jsonb`); }
  if (args.activar === true) sets.push(`active = true`);
  if (args.activar === false) sets.push(`active = false`);
  if (!sets.length) throw new Error('No mandaste ningún campo para actualizar.');
  sets.push('updated_at = NOW()');
  const r = await db.query(`UPDATE properties SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING id, title, active`, vals);
  if (!r.rows.length) throw new Error(`No existe el inmueble #${id} en esta cuenta.`);
  console.log(`🤖 [mcp] tenant ${tenantId}: inmueble #${id} actualizado por ${user.name} vía Claude${args.activar === true ? ' (ACTIVADO)' : ''}`);
  return { ok: true, id, titulo: r.rows[0].title, activo: r.rows[0].active, publicado: args.activar === true ? 'El inmueble ya está activo: Aitana puede ofrecerlo.' : undefined };
}

async function toolFotos(args, sid) {
  const { tenantId, user } = await _auth(args, sid);
  const id = _int(args.id);
  const { urls, labels } = _fotos(args.fotos);
  if (!id || !urls.length) throw new Error('Falta el id o no hay ninguna URL de foto válida (tienen que ser https públicas).');
  const cur = await db.query(`SELECT image_urls, image_labels FROM properties WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  if (!cur.rows.length) throw new Error(`No existe el inmueble #${id} en esta cuenta.`);
  const oldUrls = Array.isArray(cur.rows[0].image_urls) ? cur.rows[0].image_urls : [];
  const oldLabels = (cur.rows[0].image_labels && typeof cur.rows[0].image_labels === 'object') ? cur.rows[0].image_labels : {};
  const merged = [...oldUrls];
  for (const u of urls) if (!merged.includes(u)) merged.push(u);
  const r = await db.query(
    `UPDATE properties SET image_urls = $3::jsonb, image_labels = $4::jsonb, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id`,
    [id, tenantId, JSON.stringify(merged.slice(0, 30)), JSON.stringify({ ...oldLabels, ...labels })]);
  console.log(`🤖 [mcp] tenant ${tenantId}: +${urls.length} fotos al inmueble #${id} (${user.name} vía Claude)`);
  return { ok: true, id, fotos_totales: Math.min(merged.length, 30), nota: 'La primera foto de la lista es la principal (la que manda Aitana).' };
}

/**
 * v0.9.512 — link_de_fotos: el puente para las fotos que están dentro de un PDF.
 *
 * Claude no puede sacar los bytes de una imagen incrustada en un brochure: ve las
 * páginas renderizadas, no el archivo. Por eso `agregar_fotos` solo sirve cuando
 * las fotos YA están publicadas en algún lado. Acá se devuelve una URL temporal
 * para que el asesor suelte el PDF en el navegador y el servidor haga el resto.
 */
async function toolLinkFotos(args, sid) {
  const { tenantId, user } = await _auth(args, sid);
  const id = _int(args.id);
  if (!id) throw new Error('Falta el id del inmueble.');
  const out = await require('./upload-links').crear(tenantId, id, user.id);
  console.log(`🔗 [mcp] tenant ${tenantId}: link de fotos para inmueble #${id} (${user.name} vía Claude)`);
  return {
    ok: true, id, inmueble: out.inmueble, url: out.url,
    instruccion: `Pasale este link al asesor tal cual: ${out.url} — lo abre, suelta el PDF del brochure (o las fotos sueltas) y las imágenes se cargan solas en el inmueble. Vence en ${out.vence_en_horas} horas.`,
    nota: 'Usá esta herramienta cuando las fotos estén dentro de un PDF o en el celular del asesor. Si ya tenés URLs públicas de las fotos, usá agregar_fotos, que es directo.',
  };
}

const HANDLERS = { iniciar_sesion: toolLogin, buscar_inmuebles: toolBuscar, crear_inmueble: toolCrear, actualizar_inmueble: toolActualizar, agregar_fotos: toolFotos, link_de_fotos: toolLinkFotos };

// ── JSON-RPC / Streamable HTTP ────────────────────────────────────────
const SERVER_INFO = { name: 'sg-ventas-crm', title: 'SG Ventas · Catálogo de inmuebles', version: '1.0.0' };
const INSTRUCTIONS = `Conector del CRM SG Ventas (Aitana). Flujo típico: (1) iniciar_sesion con el email y la contraseña del asesor (los de la app móvil). (2) Si el asesor comparte un brochure/PDF, extraé título, zona, tipologías (formats), precios "desde" y descripción, y usá crear_inmueble — SIEMPRE entra como borrador que el asesor revisa y activa. (3) LAS FOTOS: vos no podés subir imágenes al CRM, ni siquiera las que ves dentro del PDF. Apenas creaste el inmueble, llamá a link_de_fotos y pasale el link al asesor para que suelte ahí el mismo PDF — el servidor extrae las fotos y se las pega solo. No le pidas que te dé URLs ni que las suba a otro lado. agregar_fotos es solo para cuando el asesor YA te pasa URLs públicas. (4) buscar_inmuebles sirve para responder "qué tengo en X zona bajo Y precio" (indicá moneda al filtrar por precio). No inventes datos que el brochure no diga; ante la duda, dejá el campo vacío y avisale al asesor.`;

async function handleRpc(msg, sid) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const rpcError = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    const pv = (params && params.protocolVersion) || PROTOCOL_FALLBACK;
    return reply({ protocolVersion: pv, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }
  if (isNotification) return null; // notifications/initialized, cancelled, etc.
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return reply({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = HANDLERS[name];
    if (!fn) return rpcError(-32602, `Herramienta desconocida: ${name}`);
    try {
      const out = await fn(args, sid);
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], isError: false });
    } catch (e) {
      return reply({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (method === 'resources/list') return reply({ resources: [] });
  if (method === 'prompts/list') return reply({ prompts: [] });
  return rpcError(-32601, `Método no soportado: ${method}`);
}

const router = express.Router();
router.post('/', async (req, res) => {
  let sid = req.headers['mcp-session-id'] || null;
  const body = req.body;
  const isInit = body && !Array.isArray(body) && body.method === 'initialize';
  if (isInit && !sid) sid = crypto.randomUUID();
  if (sid) res.setHeader('Mcp-Session-Id', sid);
  try {
    if (Array.isArray(body)) {
      const outs = [];
      for (const m of body) { const r = await handleRpc(m, sid); if (r) outs.push(r); }
      if (!outs.length) return res.status(202).end();
      return res.json(outs);
    }
    const out = await handleRpc(body, sid);
    if (!out) return res.status(202).end(); // notificación
    res.json(out);
  } catch (e) {
    console.error('[mcp] error:', e.message);
    res.status(500).json({ jsonrpc: '2.0', id: (body && body.id) || null, error: { code: -32603, message: 'Error interno del servidor MCP' } });
  }
});
router.get('/', (req, res) => res.status(405).json({ error: 'Este endpoint MCP no soporta streaming por GET. Usá POST.' }));
router.delete('/', (req, res) => { const sid = req.headers['mcp-session-id']; if (sid) SESSIONS.delete(sid); res.status(200).end(); });

module.exports = { router, _handleRpc: handleRpc, _tools: TOOLS };
