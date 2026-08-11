/**
 * media-limits.js — v0.9.264
 *
 * Límites de tamaño de WhatsApp Cloud API por tipo de media. Meta NO entrega los archivos
 * que superan estos límites (salen "no entregado"). Por eso, al subir, RECHAZAMOS con un
 * mensaje claro explicando el por qué, en vez de aceptarlo y que falle silenciosamente.
 *
 * IMÁGENES: NO se rechazan por tamaño — se comprimen solas (ver image-tools.js). El resto
 * (video, audio, documentos) no se comprime, así que se valida y se rechaza si excede.
 *
 * Referencia Meta: image 5MB · video 16MB · audio 16MB · document 100MB · sticker 500KB.
 */

const MB = 1024 * 1024;

const LIMITS = {
  image: 5 * MB,
  video: 16 * MB,
  audio: 16 * MB,
  document: 100 * MB,
  sticker: 0.5 * MB,
};

// Tope de subida (memoria del server) — debe coincidir con el `limits.fileSize` de multer en api.js.
const MULTER_MAX = 25 * MB;

function kindOf(mimeType) {
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('image/')) return 'image';
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  return 'document';
}

const KIND_PLURAL_ES = { image: 'imágenes', video: 'videos', audio: 'audios', document: 'archivos', sticker: 'stickers' };

function fmtMB(bytes) {
  const v = bytes / MB;
  return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' MB';
}

/**
 * Devuelve null si el archivo es apto, o un MENSAJE de rechazo (string en español) si excede
 * el límite de Meta. Las imágenes nunca se rechazan acá (se comprimen al subir).
 */
function mediaLimitError(mimeType, sizeBytes, originalName) {
  const kind = kindOf(mimeType);
  if (kind === 'image') return null; // se comprime sola (image-tools.js)
  const limit = LIMITS[kind] || LIMITS.document;
  const cap = Math.min(limit, MULTER_MAX); // no se puede recibir más que el tope de multer
  if (Number(sizeBytes) > cap) {
    const plural = KIND_PLURAL_ES[kind] || 'archivos';
    const hint = kind === 'video' ? ' Comprimí el video o subí uno más corto.'
      : kind === 'audio' ? ' Subí un audio más corto.'
      : ' Subí uno más liviano.';
    return `"${originalName || 'archivo'}" pesa ${fmtMB(sizeBytes)} y WhatsApp solo permite hasta ${fmtMB(cap)} para ${plural}.${hint}`;
  }
  return null;
}

/**
 * Traduce un error de multer / fileFilter a un mensaje claro para el usuario.
 * Devuelve null si no es un error de subida que reconozcamos.
 */
function multerErrorMessage(err) {
  if (!err) return null;
  if (err.code === 'LIMIT_FILE_SIZE') {
    return `El archivo es demasiado grande. El máximo para subir es ${fmtMB(MULTER_MAX)} (límite de WhatsApp). Comprimilo o subí uno más liviano.`;
  }
  if (err.code === 'LIMIT_FILE_COUNT') return 'Subiste demasiados archivos a la vez.';
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return 'Llegó un archivo en un campo inesperado.';
  if (/Tipo de archivo no permitido/i.test(err.message || '')) return err.message; // ya es claro y en español
  return null;
}

module.exports = { mediaLimitError, multerErrorMessage, LIMITS, MULTER_MAX };
