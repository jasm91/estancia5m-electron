/**
 * image-tools.js — v0.9.263
 *
 * Compresión DEFENSIVA de imágenes para que sean aptas para WhatsApp.
 * WhatsApp rechaza/no entrega imágenes enviadas por URL que pesan más de ~5 MB.
 * Antes el panel aceptaba fotos de hasta 25 MB SIN redimensionar → subían y se veían
 * bien en el panel, pero Meta no las podía enviar ("no entregado"). Acá las achicamos.
 *
 * - Solo toca imágenes still (jpeg/png/webp). GIF / animadas / video / PDF pasan SIN tocar.
 * - Solo recomprime si hace falta (lado largo > 1600px o pesa > ~1.2 MB).
 * - Usa `sharp` si está instalado; si NO está (o si algo falla), devuelve el buffer
 *   ORIGINAL sin tocar → nunca rompe la subida ni el server. Degradación elegante.
 */

let _sharp = null;
let _sharpTried = false;
function getSharp() {
  if (_sharpTried) return _sharp;
  _sharpTried = true;
  try {
    _sharp = require('sharp');
  } catch (e) {
    console.warn('[image-tools] sharp no disponible — las imágenes se suben sin comprimir:', e && e.message);
    _sharp = null;
  }
  return _sharp;
}

const MAX_DIM = 1600;                          // lado largo máximo (px)
const JPEG_QUALITY = 82;
const RECOMPRESS_OVER_BYTES = 1.2 * 1024 * 1024; // recomprime si pesa más de ~1.2 MB

/**
 * @returns {Promise<{buffer:Buffer, mimeType:string, filename:string, changed:boolean}>}
 * Si no es una imagen apta, no hace falta, o algo falla → devuelve el original (changed:false).
 */
async function compressImage(buffer, mimeType, filename) {
  try {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return { buffer, mimeType, filename, changed: false };
    const mt = String(mimeType || '').toLowerCase();
    if (!/^image\/(jpe?g|png|webp)$/.test(mt)) return { buffer, mimeType, filename, changed: false };

    const sharp = getSharp();
    if (!sharp) return { buffer, mimeType, filename, changed: false };

    const img = sharp(buffer, { failOn: 'none' });
    const meta = await img.metadata();
    if (meta && meta.pages && meta.pages > 1) return { buffer, mimeType, filename, changed: false }; // animada → no tocar

    const tooBig = (meta && meta.width && meta.width > MAX_DIM)
      || (meta && meta.height && meta.height > MAX_DIM)
      || (buffer.length > RECOMPRESS_OVER_BYTES);
    if (!tooBig) return { buffer, mimeType, filename, changed: false };

    let pipe = img.rotate(); // aplica orientación EXIF y la elimina
    if (meta && meta.hasAlpha) pipe = pipe.flatten({ background: { r: 255, g: 255, b: 255 } }); // PNG con transparencia → fondo blanco (evita negro en JPEG)
    const out = await pipe
      .resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();

    if (!out || !out.length) return { buffer, mimeType, filename, changed: false };
    // Si por alguna razón no achicó (ya era un JPEG chico), quedarse con el original.
    if (out.length >= buffer.length && /^image\/jpe?g$/.test(mt)) return { buffer, mimeType, filename, changed: false };

    const fn = (filename || 'foto').replace(/\.[a-z0-9]+$/i, '') + '.jpg';
    return { buffer: out, mimeType: 'image/jpeg', filename: fn, changed: true };
  } catch (e) {
    console.warn('[image-tools] compresión falló, se sube el original:', e && e.message);
    return { buffer, mimeType, filename, changed: false };
  }
}

module.exports = { compressImage, MAX_DIM, JPEG_QUALITY };
