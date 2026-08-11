/**
 * upload-links.js — Link de subida de fotos para inmuebles (v0.9.512)
 * ---------------------------------------------------------------------------
 * EL PROBLEMA QUE RESUELVE
 *   El conector MCP deja que un asesor cargue un inmueble conversando con Claude
 *   desde su cuenta gratuita: le pasa el brochure y Claude extrae título, zona,
 *   tipologías, precios y descripción. Pero las FOTOS no puede moverlas — Claude
 *   ve las páginas del PDF renderizadas, no puede emitir los bytes del archivo.
 *   Por eso `agregar_fotos` solo acepta URLs públicas, y un asesor con un PDF en
 *   el celular no tiene ninguna URL que pasar.
 *
 * LA SOLUCIÓN
 *   Claude maneja los datos, el navegador maneja los bytes. `link_de_fotos`
 *   devuelve una URL corta y temporal; el asesor la abre, suelta el PDF (o las
 *   fotos sueltas) y el SERVIDOR extrae las imágenes incrustadas, las sube a R2
 *   y se las pega al inmueble. Claude nunca toca un byte binario.
 *
 * SEGURIDAD — esto es un endpoint PÚBLICO, sin sesión. El token ES la credencial:
 *   · 32 bytes aleatorios (256 bits): no se adivina.
 *   · Vence a las 24 h.
 *   · Atado a UN inmueble de UN tenant: con el token no se llega a nada más.
 *   · Tope de subidas por link, así un token filtrado no sirve de depósito gratis.
 *   · La página solo muestra el título del inmueble — lo mínimo para que el
 *     asesor confirme que está en el lugar correcto.
 */
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const r2 = require('./r2');

const TTL_HORAS = 24;
const MAX_SUBIDAS_POR_LINK = 10;   // requests, no fotos
const MAX_FOTOS_POR_INMUEBLE = 25; // tope duro del catálogo
const MIN_LADO_PX = 300;           // menos que esto es logo o viñeta, no una foto
const MAX_ARCHIVO = 30 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVO, files: 25 },
  fileFilter: (req, file, cb) => {
    const mt = String(file.mimetype || '').toLowerCase();
    if (mt === 'application/pdf' || /^image\/(jpeg|jpg|png|webp|heic|heif)$/.test(mt)) return cb(null, true);
    cb(new Error('Solo se aceptan PDF o imágenes (JPG, PNG, WEBP).'));
  },
});

// ── schema ───────────────────────────────────────────────────────────
async function ensureSchema() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS property_upload_links (
        token       TEXT PRIMARY KEY,
        tenant_id   INTEGER NOT NULL,
        property_id INTEGER NOT NULL,
        created_by  INTEGER,
        expires_at  TIMESTAMPTZ NOT NULL,
        uploads     INTEGER NOT NULL DEFAULT 0,
        last_used_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
    await db.query(`CREATE INDEX IF NOT EXISTS pul_prop_idx ON property_upload_links (property_id, created_at DESC)`);
  } catch (e) { console.error('[upload-links] ensureSchema:', e.message); }
}

/** Borra los vencidos. Los llama el cron; un link muerto no tiene por qué quedar. */
async function limpiarVencidos() {
  try {
    const r = await db.query(`DELETE FROM property_upload_links WHERE expires_at < NOW() - INTERVAL '7 days'`);
    if (r.rowCount) console.log(`🧹 [upload-links] ${r.rowCount} link(s) vencido(s) borrado(s)`);
  } catch (e) { /* silencioso */ }
}

// ── crear / verificar ────────────────────────────────────────────────
function baseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://app.sg-ventas.com').replace(/\/+$/, '');
}

async function crear(tenantId, propertyId, userId) {
  const p = await db.query('SELECT id, title FROM properties WHERE id = $1 AND tenant_id = $2', [propertyId, tenantId]);
  if (!p.rows.length) throw new Error('Ese inmueble no existe o no es de tu organización.');
  const token = crypto.randomBytes(32).toString('hex');
  await db.query(
    `INSERT INTO property_upload_links (token, tenant_id, property_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '${TTL_HORAS} hours')`,
    [token, tenantId, propertyId, userId || null]);
  return {
    url: `${baseUrl()}/subir/${token}`,
    inmueble: p.rows[0].title,
    vence_en_horas: TTL_HORAS,
  };
}

async function verificar(token) {
  if (!/^[a-f0-9]{64}$/.test(String(token || ''))) return null;
  const r = await db.query(
    `SELECT l.token, l.tenant_id, l.property_id, l.uploads, l.expires_at,
            p.title, COALESCE(jsonb_array_length(p.image_urls), 0) AS fotos
       FROM property_upload_links l
       JOIN properties p ON p.id = l.property_id AND p.tenant_id = l.tenant_id
      WHERE l.token = $1 AND l.expires_at > NOW()`, [token]);
  const row = r.rows[0];
  if (!row) return null;
  if (Number(row.uploads) >= MAX_SUBIDAS_POR_LINK) return null;
  return row;
}

// ── extracción de imágenes del PDF ───────────────────────────────────
/**
 * Saca las imágenes INCRUSTADAS de un PDF, no las páginas renderizadas.
 * La diferencia importa: un brochure tiene texto y varias fotos por página;
 * renderizar la página daría una captura con letras encima, inservible como
 * foto de inmueble. Acá se recuperan los bitmaps originales.
 *
 * pdfjs se carga con import() dinámico porque su build sólo viene en ESM.
 */
async function extraerDePdf(buf) {
  const sharp = require('sharp');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), disableFontFace: true, useSystemFonts: false }).promise;
  const fotos = [];
  const vistosEnDoc = new Set();  // mismo XObject repetido entre páginas (logos)
  const hashes = new Set();       // mismo contenido subido dos veces
  try {
    for (let n = 1; n <= doc.numPages && fotos.length < MAX_FOTOS_POR_INMUEBLE; n++) {
      const page = await doc.getPage(n);
      let ops;
      try { ops = await page.getOperatorList(); } catch (e) { page.cleanup(); continue; }
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        if (fn !== pdfjs.OPS.paintImageXObject && fn !== pdfjs.OPS.paintJpegXObject) continue;
        const key = ops.argsArray[i] && ops.argsArray[i][0];
        if (!key || vistosEnDoc.has(key)) continue;
        vistosEnDoc.add(key);

        let img = null;
        try { img = await new Promise((res) => { try { page.objs.get(key, res); } catch (_) { res(null); } }); }
        catch (_) { continue; }
        if (!img || !img.width || !img.height || !img.data) continue;
        // Chico = logo, ícono o viñeta decorativa. No es una foto del inmueble.
        if (img.width < MIN_LADO_PX || img.height < MIN_LADO_PX) continue;
        // Tiras muy alargadas suelen ser barras o separadores de diseño.
        const ratio = img.width / img.height;
        if (ratio > 6 || ratio < 1 / 6) continue;

        // kind: 2 = RGB 24bpp, 3 = RGBA 32bpp. 1 (gris 1bpp) son máscaras.
        const channels = img.kind === 3 ? 4 : (img.kind === 2 ? 3 : 0);
        if (!channels) continue;

        let jpg;
        try {
          jpg = await sharp(Buffer.from(img.data), { raw: { width: img.width, height: img.height, channels } })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 82, mozjpeg: true })
            .toBuffer();
        } catch (e) { continue; }

        const h = crypto.createHash('sha1').update(jpg).digest('hex');
        if (hashes.has(h)) continue;
        hashes.add(h);

        fotos.push({ buffer: jpg, pagina: n, w: img.width, h: img.height });
        if (fotos.length >= MAX_FOTOS_POR_INMUEBLE) break;
      }
      page.cleanup();
    }
  } finally {
    try { await doc.destroy(); } catch (_) {}
  }
  return fotos;
}

// ── pegar las fotos al inmueble ──────────────────────────────────────
async function adjuntar(link, buffers) {
  const cur = await db.query(
    `SELECT COALESCE(image_urls, '[]'::jsonb) AS urls FROM properties WHERE id = $1 AND tenant_id = $2`,
    [link.property_id, link.tenant_id]);
  if (!cur.rows.length) throw new Error('El inmueble ya no existe.');
  const urls = Array.isArray(cur.rows[0].urls) ? cur.rows[0].urls.slice() : [];

  const nuevas = [];
  for (const b of buffers) {
    if (urls.length + nuevas.length >= MAX_FOTOS_POR_INMUEBLE) break;
    let up;
    try { up = await r2.upload({ buffer: b.buffer, mimeType: 'image/jpeg', prefix: 'properties', filename: b.filename || 'foto.jpg' }); }
    catch (e) { console.warn('[upload-links] r2:', e.message); continue; }
    if (up && up.url) nuevas.push(up.url);
  }
  if (!nuevas.length) return { agregadas: 0, total: urls.length };

  // Se agregan al final a propósito: la PRIMERA foto es la que Aitana manda por
  // WhatsApp, y si el inmueble ya tenía una elegida no se la pisamos por sorpresa.
  const final = urls.concat(nuevas);
  await db.query(`UPDATE properties SET image_urls = $1::jsonb WHERE id = $2 AND tenant_id = $3`,
    [JSON.stringify(final), link.property_id, link.tenant_id]);
  console.log(`📸 [upload-links] inmueble ${link.property_id}: +${nuevas.length} foto(s)`);
  return { agregadas: nuevas.length, total: final.length };
}

// ── router ───────────────────────────────────────────────────────────
const router = express.Router();

function pagina({ titulo, fotos, error }) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (error) {
    return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link no válido</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1117;color:#e8edf4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:24px}
.c{max-width:420px;text-align:center}h1{font-size:19px;margin:0 0 10px}p{color:#8895a8;font-size:14px;line-height:1.6;margin:0}</style></head>
<body><div class="c"><div style="font-size:40px;margin-bottom:12px">🔗</div><h1>Este link ya no sirve</h1>
<p>${esc(error)}</p><p style="margin-top:14px">Pedile a Claude un link nuevo con <b>link_de_fotos</b>.</p></div></body></html>`;
  }
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Subir fotos · ${esc(titulo)}</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#0d1117;color:#e8edf4;font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:22px 18px;display:flex;justify-content:center}
.w{width:100%;max-width:480px}
h1{font-size:13px;color:#8895a8;font-weight:500;margin:0 0 3px;text-transform:uppercase;letter-spacing:.06em}
h2{font-size:21px;margin:0 0 4px;line-height:1.25}
.sub{color:#8895a8;font-size:13.5px;margin:0 0 20px;line-height:1.55}
#zona{border:2px dashed #2a3444;border-radius:16px;padding:34px 20px;text-align:center;cursor:pointer;transition:.15s;background:#111823}
#zona:hover,#zona.on{border-color:#14b8c4;background:rgba(20,184,196,.07)}
#zona .ico{font-size:34px;margin-bottom:8px}
#zona .t{font-weight:600;font-size:15px;margin-bottom:4px}
#zona .h{color:#8895a8;font-size:12.5px;line-height:1.5}
#est{margin-top:16px;font-size:14px;line-height:1.6}
.ok{color:#5cd6a3}.err{color:#f2777a}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-top:14px}
.grid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:8px;background:#1a2231}
.nota{margin-top:20px;color:#6b7889;font-size:12px;line-height:1.6;border-top:1px solid #1c2532;padding-top:14px}
.bar{height:3px;background:#1c2532;border-radius:2px;overflow:hidden;margin-top:14px;display:none}
.bar i{display:block;height:100%;width:35%;background:#14b8c4;animation:s 1.1s ease-in-out infinite}
@keyframes s{0%{margin-left:-35%}100%{margin-left:100%}}
</style></head>
<body><div class="w">
  <h1>Fotos del inmueble</h1>
  <h2>${esc(titulo)}</h2>
  <p class="sub">Ya tiene <b>${fotos}</b> foto(s). Soltá acá el <b>brochure en PDF</b> y saco las imágenes solo, o subí las fotos sueltas si las tenés.</p>
  <div id="zona">
    <div class="ico">📄</div>
    <div class="t">Tocá para elegir el PDF o las fotos</div>
    <div class="h">También podés arrastrarlas acá</div>
  </div>
  <input type="file" id="f" accept="application/pdf,image/*" multiple hidden>
  <div class="bar" id="bar"><i></i></div>
  <div id="est"></div>
  <div class="grid" id="prev"></div>
  <p class="nota">La <b>primera foto</b> del inmueble es la que Aitana manda por WhatsApp. Podés reordenarlas, borrar las que no sirvan y ponerles descripción desde el panel del CRM, en Propiedades.</p>
</div>
<script>
var zona=document.getElementById('zona'),inp=document.getElementById('f'),est=document.getElementById('est'),prev=document.getElementById('prev'),bar=document.getElementById('bar');
zona.onclick=function(){inp.click()};
['dragenter','dragover'].forEach(function(e){zona.addEventListener(e,function(ev){ev.preventDefault();zona.classList.add('on')})});
['dragleave','drop'].forEach(function(e){zona.addEventListener(e,function(ev){ev.preventDefault();zona.classList.remove('on')})});
zona.addEventListener('drop',function(ev){if(ev.dataTransfer.files.length)enviar(ev.dataTransfer.files)});
inp.onchange=function(){if(inp.files.length)enviar(inp.files)};
function enviar(files){
  var fd=new FormData();
  for(var i=0;i<files.length;i++)fd.append('archivos',files[i]);
  est.innerHTML='Subiendo y procesando…';est.className='';bar.style.display='block';zona.style.pointerEvents='none';
  fetch(location.pathname,{method:'POST',body:fd}).then(function(r){return r.json()}).then(function(d){
    bar.style.display='none';zona.style.pointerEvents='';
    if(!d.ok){est.innerHTML=d.error||'No se pudo procesar.';est.className='err';return}
    if(!d.agregadas){est.innerHTML='No encontré fotos utilizables en lo que subiste. Si el PDF es un escaneo o las imágenes son muy chicas, subí las fotos sueltas.';est.className='err';return}
    est.innerHTML='✅ Listo — <b>'+d.agregadas+'</b> foto(s) agregada(s). El inmueble ahora tiene '+d.total+'.';est.className='ok';
    prev.innerHTML=(d.previews||[]).map(function(u){return '<img src="'+u+'" alt="">'}).join('');
  }).catch(function(){bar.style.display='none';zona.style.pointerEvents='';est.innerHTML='Error de red. Probá de nuevo.';est.className='err'});
}
</script></body></html>`;
}

router.get('/subir/:token', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  let link;
  try { link = await verificar(req.params.token); }
  catch (e) { return res.status(500).send(pagina({ error: 'Error del servidor. Probá en un rato.' })); }
  if (!link) return res.status(404).send(pagina({ error: 'El link venció, ya se usó demasiadas veces, o el inmueble fue borrado.' }));
  res.send(pagina({ titulo: link.title || 'Inmueble', fotos: Number(link.fotos) || 0 }));
});

router.post('/subir/:token', (req, res) => {
  upload.array('archivos', 25)(req, res, async (err) => {
    res.set('Cache-Control', 'no-store');
    if (err) return res.status(400).json({ ok: false, error: err.message || 'Archivo rechazado.' });
    let link;
    try { link = await verificar(req.params.token); }
    catch (e) { return res.status(500).json({ ok: false, error: 'Error del servidor.' }); }
    if (!link) return res.status(404).json({ ok: false, error: 'El link venció o ya se usó demasiadas veces.' });

    // Se cuenta el uso ANTES de procesar: si alguien golpea el endpoint en loop,
    // el tope corta igual aunque cada request falle a mitad de camino.
    await db.query(`UPDATE property_upload_links SET uploads = uploads + 1, last_used_at = NOW() WHERE token = $1`, [link.token]);

    const files = req.files || [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No mandaste ningún archivo.' });

    const buffers = [];
    for (const f of files) {
      const mt = String(f.mimetype || '').toLowerCase();
      if (mt === 'application/pdf') {
        let sacadas = [];
        try { sacadas = await extraerDePdf(f.buffer); }
        catch (e) { console.warn('[upload-links] pdf:', e.message); }
        for (const s of sacadas) buffers.push({ buffer: s.buffer, filename: `pag${s.pagina}.jpg` });
      } else {
        buffers.push({ buffer: f.buffer, filename: f.originalname || 'foto.jpg' });
      }
    }
    if (!buffers.length) return res.json({ ok: true, agregadas: 0, total: Number(link.fotos) || 0, previews: [] });

    try {
      const out = await adjuntar(link, buffers);
      const prev = await db.query(`SELECT COALESCE(image_urls, '[]'::jsonb) AS urls FROM properties WHERE id = $1`, [link.property_id]);
      const urls = Array.isArray(prev.rows[0] && prev.rows[0].urls) ? prev.rows[0].urls : [];
      res.json({ ...out, ok: true, previews: urls.slice(-out.agregadas) });
    } catch (e) {
      console.error('[upload-links] adjuntar:', e.message);
      res.status(500).json({ ok: false, error: 'No se pudieron guardar las fotos.' });
    }
  });
});

module.exports = { router, ensureSchema, crear, verificar, extraerDePdf, limpiarVencidos, MAX_FOTOS_POR_INMUEBLE };
