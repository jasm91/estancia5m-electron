/**
 * catalog-matcher.js — v0.9.338
 * Scorer compartido perfil_de_busqueda(lead) -> item del catálogo. Lo usan el endpoint
 * /admin/leads/:id/matches (api.js) y el nurturing por comportamiento (nurture.js).
 *
 * v0.9.338 — CANDADO DE PRESUPUESTO:
 *  - Convierte Bs↔USD (opts.usdToBs, tasa de platform_pricing) para comparar precios
 *    en la moneda del presupuesto del lead. Antes, monedas distintas hacían que el
 *    presupuesto se IGNORARA y se ofrecían props de Bs 2,4M a leads de 100k USD.
 *  - Si el precio supera el presupuesto máximo en >25%, el ítem queda DESCALIFICADO
 *    (score 0, over_budget=true, reason 'fuera de presupuesto').
 */
function _mNorm(x) { return String(x == null ? '' : x).toLowerCase().trim(); }
function _mNum(x) { return (x === 0 || (x && !isNaN(Number(x)))) ? Number(x) : null; }
// Normaliza denominaciones de moneda a una clave comparable ('usd' | 'bs' | otra).
// v0.9.436 — el perfil dice "compra/comprar" pero el catálogo dice "venta" (y "renta"
// vs "alquiler"): sin normalizar, la operación NUNCA matcheaba y un comprador recibía
// alquileres. Compra/venta → 'venta'; alquilar/renta → 'alquiler'.
function _mOpNorm(x) {
  x = _mNorm(x);
  if (!x) return null;
  if (/compra|comprar|venta|vender/.test(x)) return 'venta';
  if (/alquil|renta|arrend/.test(x)) return 'alquiler';
  return x;
}
function _mCurKey(c) {
  const s = _mNorm(c);
  if (!s) return null;
  if (/usd|us\$|\$us|d[oó]lar/.test(s)) return 'usd';
  if (/^bs\.?$|bob|boliviano/.test(s)) return 'bs';
  return s;
}
// Convierte `price` (en itCur) a la moneda del presupuesto (spCur). null = no comparable.
function _mToBudgetCur(price, itCur, spCur, usdToBs) {
  if (!itCur || !spCur || itCur === spCur) return price;
  if (!usdToBs) return null;
  if (itCur === 'usd' && spCur === 'bs') return price * usdToBs;
  if (itCur === 'bs' && spCur === 'usd') return price / usdToBs;
  return null;
}
function scoreCatalogItem(sp, item, kind, opts) {
  const usdToBs = (opts && Number(opts.usdToBs) > 0) ? Number(opts.usdToBs) : null;
  const attrs = (sp.attributes && typeof sp.attributes === 'object') ? sp.attributes : {};
  let applicable = 0, matched = 0; const reasons = [];
  const price = _mNum(item.price);
  const bmin = _mNum(sp.budget_min), bmax = _mNum(sp.budget_max);
  const spCurK = _mCurKey(sp.currency), itCurK = _mCurKey(item.currency);
  let overBudget = false;
  if ((bmin != null || bmax != null) && price != null) {
    const effPrice = _mToBudgetCur(price, itCurK, spCurK, usdToBs);
    if (effPrice != null) {
      applicable += 2;
      const okMin = bmin == null || effPrice >= bmin * 0.9;   // 10% de tolerancia
      const okMax = bmax == null || effPrice <= bmax * 1.1;
      if (okMin && okMax) { matched += 2; reasons.push('presupuesto'); }
      if (bmax != null && effPrice > bmax * 1.25) overBudget = true; // candado duro
    }
  }
  const hay = _mNorm([item.title, item.name, item.description, item.zone, item.type, item.code].filter(Boolean).join(' '));
  const attrHit = (val) => { const v = _mNorm(val); return !!v && hay.indexOf(v) !== -1; };
  let opMismatch = false; // v0.9.436
  if (kind === 'property') {
    if (sp.location) { applicable += 2; if (_mNorm(item.zone).indexOf(_mNorm(sp.location)) !== -1 || attrHit(sp.location)) { matched += 2; reasons.push('zona'); } }
    if (sp.operation) {
      applicable += 2;
      const so = _mOpNorm(sp.operation), io = _mOpNorm(item.operation);
      if (so && io && so === io) { matched += 2; reasons.push('operación'); }
      else if (so && io && so !== io) opMismatch = true; // comprador ≠ alquiler: descalifica
    }
    const tipo = attrs.tipo || attrs.type;
    // v0.9.436 — el tipo también se busca en el TÍTULO/descripción: el mapeo C21 convierte
    // "quinta" en type='casa' y el tipo pedido jamás matcheaba contra type solo.
    if (tipo) { applicable += 1; if (_mNorm(item.type).indexOf(_mNorm(tipo)) !== -1 || _mNorm(item.category).indexOf(_mNorm(tipo)) !== -1 || attrHit(tipo)) { matched += 1; reasons.push('tipo'); } } // v0.9.445: también contra la carpeta
    const dorm = _mNum(attrs.dormitorios || attrs.bedrooms), itBed = _mNum(item.bedrooms);
    if (dorm != null && itBed != null) { applicable += 1; if (itBed >= dorm) { matched += 1; reasons.push('dormitorios'); } }
  } else {
    ['marca', 'modelo', 'producto', 'categoria', 'category', 'tipo', 'color'].forEach((k) => {
      if (attrs[k]) { applicable += 1; if (attrHit(attrs[k])) { matched += 1; reasons.push(k); } }
    });
    if (sp.location) { applicable += 1; if (attrHit(sp.location)) { matched += 1; reasons.push('zona'); } }
  }
  let score = applicable > 0 ? Math.round((matched / applicable) * 100) : 0;
  if (overBudget) { score = 0; reasons.length = 0; reasons.push('fuera de presupuesto'); }
  if (opMismatch) { score = 0; reasons.length = 0; reasons.push('operación distinta (venta vs alquiler)'); } // v0.9.436
  if (item.featured && score > 0) { score = Math.min(100, score + 5); reasons.push('destacada'); } // v0.9.445 — prioridad suave a las ⭐
  const img = Array.isArray(item.image_urls) ? item.image_urls[0] : (item.image_url || null);
  const subtitle = kind === 'property'
    ? [item.operation, item.type, item.zone, (item.bedrooms != null ? item.bedrooms + ' dorm' : null)].filter(Boolean).join(' · ')
    : (item.description ? String(item.description).slice(0, 90) : (item.code ? 'Cod ' + item.code : ''));
  // v0.9.384 — asesor asignado (facilitación C21): viaja al panel para mostrarlo en el resumen del lead.
  // Solo inmuebles; INTERNO (nunca se le manda al cliente).
  const assigned_agent_name = (kind === 'property') ? (item.assigned_agent_name || null) : null;
  return { kind, id: item.id, title: item.title || item.name || ('#' + item.id), price, currency: item.currency || null, subtitle, image: img, score, reasons, over_budget: overBudget, assigned_agent_name };
}

// v0.9.338 — tasa USD→Bs para el candado de presupuesto (platform_pricing, cron diario BCB).
// Fallback conservador si la tabla no está o no tiene tasa. Cacheada 10 min.
let _rateCache = { v: null, at: 0 };
async function getUsdToBsRate(db) {
  const now = Date.now();
  if (_rateCache.v && now - _rateCache.at < 10 * 60 * 1000) return _rateCache.v;
  let rate = 9.73;
  try {
    const r = await db.query(`SELECT (to_jsonb(platform_pricing) ->> 'usd_to_bs_rate')::numeric AS rate FROM platform_pricing WHERE id = 1`);
    if (r.rows[0] && Number(r.rows[0].rate) > 0) rate = Number(r.rows[0].rate);
  } catch (e) { /* fallback */ }
  _rateCache = { v: rate, at: now };
  return rate;
}

// =====================================================================
// v0.9.431 — SELECCIÓN POR RELEVANCIA del catálogo de inmuebles que viaja
// al prompt (webhook.js + test-message). Con catálogos chicos el LIMIT 200
// por recencia alcanzaba, pero con 5.000+ propiedades (sync C21) el modelo
// quedaba ciego al 96% del inventario: decía "no tengo quintas en el norte"
// con una quinta activa y dentro del presupuesto en la base (bug B-01 de la
// batería del 14-jul-2026). Si el lead ya tiene search_profile con señal,
// se puntúa TODO el pool con scoreCatalogItem y viajan los top N relevantes
// + un relleno por recencia (variedad, sin ítems fuera de presupuesto).
// Sin perfil todavía → recencia, como siempre (status quo).
// =====================================================================
// v0.9.433 — pool completo + cache. El LIMIT 3000 dejaba fuera ~800 de las 3.803
// del sync (todas comparten updated_at → orden arbitrario entre empatadas) y la
// quinta de la batería seguía invisible. Pool 10.000 (catálogo entero) con cache
// de 60s por tenant+línea para no cargar 5.000 filas en cada mensaje entrante.
const _poolCache = new Map();
const _POOL_TTL_MS = Number(process.env.CATALOG_POOL_TTL_MS) > 0 ? Number(process.env.CATALOG_POOL_TTL_MS) : 60000;

async function selectRelevantProperties(db, opts) {
  const o = opts || {};
  const tenantId = o.tenantId;
  const lineId = o.lineId || null;
  const limitRelevant = Number(process.env.CATALOG_RELEVANT_N) > 0 ? Number(process.env.CATALOG_RELEVANT_N) : (o.limitRelevant || 40);
  const limitFill = o.limitFill != null ? o.limitFill : 20;
  const noProfileLimit = o.noProfileLimit || 200; // = LIMIT histórico
  const poolLimit = o.poolLimit || 10000;
  const _pk = tenantId + ':' + (lineId || 0);
  const _pc = _poolCache.get(_pk);
  let rows;
  if (_pc && (Date.now() - _pc.at) < _POOL_TTL_MS) {
    rows = _pc.rows;
  } else {
  const pr = await db.query(
    `SELECT id, code, title, operation, type, zone, area_m2, bedrooms, bathrooms, garages, price, currency, description,
            maps_url, COALESCE(jsonb_array_length(file_urls), 0) AS docs_count,
            image_urls, COALESCE(to_jsonb(properties) -> 'image_labels', '{}'::jsonb) AS image_labels,
            to_jsonb(properties) ->> 'category' AS category,
            to_jsonb(properties) ->> 'availability' AS availability,
            COALESCE(to_jsonb(properties) -> 'promotions', '[]'::jsonb) AS promotions, -- v0.9.570
            to_jsonb(properties) -> 'formats' AS formats,
            COALESCE((to_jsonb(properties) ->> 'featured')::boolean, false) AS featured
       FROM properties
      WHERE tenant_id = $1 AND active = TRUE AND status = 'disponible'
        AND (visible_lines IS NULL OR cardinality(visible_lines) = 0 OR $2 = ANY(visible_lines))
      ORDER BY updated_at DESC
      LIMIT $3`,
    [tenantId, lineId, poolLimit]);
    rows = pr.rows;
    _poolCache.set(_pk, { rows, at: Date.now() });
    if (_poolCache.size > 50) { const k0 = _poolCache.keys().next().value; _poolCache.delete(k0); }
  }
  const sp = (o.searchProfile && typeof o.searchProfile === 'object') ? o.searchProfile : null;
  const attrs = (sp && sp.attributes && typeof sp.attributes === 'object') ? sp.attributes : {};
  const hasSignal = !!(sp && (sp.operation || sp.location || sp.budget_max != null || sp.budget_min != null || Object.keys(attrs).length));
  if (!hasSignal || rows.length <= noProfileLimit) return rows.slice(0, noProfileLimit);
  const usdToBs = await getUsdToBsRate(db);
  const scored = rows.map((r, i) => ({ r, i, m: scoreCatalogItem(sp, r, 'property', { usdToBs }) }));
  // Relevantes: score > 0, mejor puntaje primero (empate → más reciente primero).
  const relevant = scored.filter((x) => x.m && x.m.score > 0).sort((a, b) => (b.m.score - a.m.score) || (a.i - b.i)).slice(0, limitRelevant);
  const chosen = new Set(relevant.map((x) => x.r.id));
  // Relleno por recencia para variedad (pero NUNCA ítems fuera de presupuesto:
  // re-meter un caro "reciente" reintroduce el bug B-02 de ofrecer sobre el tope).
  const fill = [];
  for (const x of scored) {
    if (fill.length >= limitFill) break;
    if (!chosen.has(x.r.id) && !(x.m && x.m.over_budget)) fill.push(x.r);
  }
  return [...relevant.map((x) => x.r), ...fill];
}

// =====================================================================
// v0.9.440 — MATCH ANUNCIO ↔ INMUEBLE. El anuncio CTWA trae headline/body
// que casi siempre describen UNA propiedad concreta. Al capturar el referral
// se busca el mejor match en el catálogo (tokens del título con peso 3,
// descripción 1, zona +2, precio exacto +6) y se guarda en la conversación:
// Aitana arranca trabajando ESE inmueble (Straight Line) en vez de re-preguntar.
// Umbral conservador: mejor no matchear que matchear mal.
// =====================================================================
const _AD_STOP = new Set(['de','la','el','en','con','para','por','los','las','les','un','una','uno','y','o','a','del','al','tu','su','sus','que','qué','este','esta','ese','esa','venta','alquiler','anticretico','casa','departamento','depto','terreno','lote','propiedad','inmueble','zona','bs','usd','m2','oportunidad','hermosa','hermoso','linda','lindo','espectacular','increible','gran','excelente','nueva','nuevo','estrenar','whatsapp','info','informacion','mas','click','aqui','ahora','hoy','solo','desde','entre','sobre','contactanos','escribinos','consulta','disponible']);
function _adTokens(txt) {
  return String(txt || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !_AD_STOP.has(w));
}
async function matchAdToProperty(db, tenantId, referral) {
  const text = [referral && referral.headline, referral && referral.body].filter(Boolean).join(' ');
  const toks = [...new Set(_adTokens(text))];
  if (toks.length < 2) return null;
  const pr = await db.query(
    `SELECT id, title, description, zone, price, currency FROM properties WHERE tenant_id = $1 AND active = TRUE AND status = 'disponible' LIMIT 10000`,
    [tenantId]).catch(() => ({ rows: [] }));
  if (!pr.rows.length) return null;
  const prices = (text.match(/\d[\d.,]{2,}/g) || []).map((x) => Number(x.replace(/[.,]/g, ''))).filter((n) => n > 1000);
  const lowText = text.toLowerCase();
  let best = null;
  for (const p of pr.rows) {
    const tTok = new Set(_adTokens(p.title));
    const dTok = new Set(_adTokens(String(p.description || '').slice(0, 400)));
    let sc = 0, titleHits = 0;
    for (const w of toks) {
      if (tTok.has(w)) { sc += 3; titleHits++; }
      else if (dTok.has(w)) sc += 1;
    }
    if (p.zone && lowText.includes(String(p.zone).toLowerCase())) sc += 2;
    const pn = Number(p.price) || 0;
    if (pn && prices.some((x) => Math.abs(x - pn) / pn < 0.01)) sc += 6;
    if (!best || sc > best.sc) best = { sc, titleHits, p };
  }
  if (best && (best.sc >= 8 || (best.sc >= 6 && best.titleHits >= 2))) {
    return { id: best.p.id, title: best.p.title, score: best.sc };
  }
  return null;
}

module.exports = { scoreCatalogItem, getUsdToBsRate, selectRelevantProperties, matchAdToProperty };
