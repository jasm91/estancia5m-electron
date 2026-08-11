/**
 * Cloudflare R2 Helper
 *
 * Wrapper sobre AWS S3 SDK v3 (R2 es compatible con S3).
 * Variables de entorno requeridas:
 *   - R2_ACCOUNT_ENDPOINT   (ej: https://abc123.r2.cloudflarestorage.com)
 *   - R2_ACCESS_KEY_ID
 *   - R2_SECRET_ACCESS_KEY
 *   - R2_BUCKET             (ej: sg-ventas-media)
 *   - R2_PUBLIC_URL         (ej: https://pub-abc.r2.dev)
 */

const { S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

const R2_ENDPOINT = process.env.R2_ACCOUNT_ENDPOINT;
const R2_BUCKET = process.env.R2_BUCKET || 'sg-ventas-media';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;

let _client = null;

function isConfigured() {
  return !!(R2_ENDPOINT && R2_ACCESS_KEY && R2_SECRET_KEY && R2_BUCKET && R2_PUBLIC_URL);
}

function getClient() {
  if (_client) return _client;
  if (!isConfigured()) {
    throw new Error('R2 no está configurado. Verifica variables R2_* en Railway.');
  }
  _client = new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY,
      secretAccessKey: R2_SECRET_KEY,
    },
  });
  return _client;
}

function generateKey(originalFilename, prefix = 'media') {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const ext = path.extname(originalFilename || '') || '';
  const baseName = path.basename(originalFilename || 'file', ext)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .substring(0, 40);
  const random = crypto.randomBytes(6).toString('hex');
  return `${prefix}/${year}/${month}/${random}-${baseName}${ext}`;
}

async function uploadBuffer(buffer, options = {}) {
  if (!isConfigured()) {
    console.warn('R2 no configurado, skip upload');
    return null;
  }

  let {
    filename = 'file.bin',
    contentType = 'application/octet-stream',
    prefix = 'media',
    cacheControl = 'public, max-age=31536000',
  } = options;

  // v0.9.263: comprimir imágenes pesadas para que Meta las pueda ENVIAR por WhatsApp
  // (límite ~5 MB por imagen). Docs/video/audio/GIF/animadas pasan sin tocar; si sharp
  // no está instalado o falla, se sube el original (nunca rompe la subida).
  try {
    const { compressImage } = require('./image-tools');
    const c = await compressImage(buffer, contentType, filename);
    if (c && c.changed) { buffer = c.buffer; contentType = c.mimeType; filename = c.filename; }
  } catch (e) { /* degradación elegante */ }

  const key = generateKey(filename, prefix);
  const client = getClient();

  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));

  return {
    key,
    public_url: `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`,
    size: buffer.length,
    content_type: contentType,
  };
}

/**
 * Alias compatible con la API esperada por webhook.js y endpoints de upload.
 * Acepta: { buffer, mimeType, prefix, filename }
 * Retorna: { url, key, size, content_type }
 */
async function upload({ buffer, mimeType, prefix, filename }) {
  const result = await uploadBuffer(buffer, {
    contentType: mimeType,
    prefix: prefix || 'media',
    filename: filename || 'file.bin',
  });
  if (!result) return null;
  return {
    url: result.public_url,
    key: result.key,
    size: result.size,
    content_type: result.content_type,
  };
}

async function deleteObject(key) {
  if (!isConfigured()) return false;
  if (!key) return false;
  try {
    const client = getClient();
    await client.send(new DeleteObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
    }));
    return true;
  } catch (e) {
    console.error('R2 delete error:', e.message);
    return false;
  }
}

async function getSignedDownloadUrl(key, expiresInSeconds = 3600) {
  const client = getClient();
  const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key });
  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

function extractKeyFromUrl(url) {
  if (!url || !R2_PUBLIC_URL) return null;
  const prefix = R2_PUBLIC_URL.replace(/\/$/, '') + '/';
  if (url.startsWith(prefix)) {
    return url.substring(prefix.length);
  }
  return null;
}

/**
 * v0.9.81 — Suma el tamaño total (bytes) y la cantidad de objetos bajo un prefijo.
 * Usado por el panel super-admin para monitorear el almacenamiento por tenant.
 * Pagina con ContinuationToken (1000 objetos por página).
 */
async function sumPrefix(prefix) {
  if (!isConfigured()) return { bytes: 0, objects: 0, configured: false };
  const client = getClient();
  let bytes = 0, objects = 0, token = undefined;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const o of (out.Contents || [])) { bytes += (o.Size || 0); objects += 1; }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return { bytes, objects, configured: true };
}

/**
 * v0.9.81 — Lista TODO el bucket y devuelve un Map key→bytes + totales.
 * Las keys NO llevan tenant (se guardan por tipo: properties/, inventory/, ...),
 * así que la atribución por tenant se hace afuera, mapeando las URLs que cada
 * tenant referencia en su BD contra este Map. Pagina de a 1000.
 */
async function listAllSizes() {
  if (!isConfigured()) return { sizes: new Map(), objects: [], totalBytes: 0, totalObjects: 0, configured: false };
  const client = getClient();
  const sizes = new Map();
  const objects = [];
  let totalBytes = 0, totalObjects = 0, token = undefined;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    for (const o of (out.Contents || [])) {
      sizes.set(o.Key, o.Size || 0);
      objects.push({ key: o.Key, size: o.Size || 0, lastModified: o.LastModified || null });
      totalBytes += (o.Size || 0); totalObjects += 1;
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return { sizes, objects, totalBytes, totalObjects, configured: true };
}

/**
 * v0.9.84 — Borra objetos en lote (hasta 1000 por request, como exige S3/R2).
 * Devuelve { deleted, errors }. Usado por la purga de huérfanos del super-admin.
 */
async function deleteObjects(keys) {
  if (!isConfigured()) return { deleted: 0, errors: ['R2 no configurado'] };
  if (!Array.isArray(keys) || keys.length === 0) return { deleted: 0, errors: [] };
  const client = getClient();
  let deleted = 0;
  const errors = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000);
    try {
      const out = await client.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: batch.map((k) => ({ Key: k })), Quiet: true },
      }));
      const errs = out.Errors || [];
      deleted += batch.length - errs.length;
      for (const e of errs) errors.push(`${e.Key}: ${e.Code || e.Message}`);
    } catch (e) {
      errors.push(`batch@${i}: ${e.message}`);
    }
  }
  return { deleted, errors };
}

module.exports = {
  isConfigured,
  upload,
  uploadBuffer,
  deleteObject,
  getSignedDownloadUrl,
  extractKeyFromUrl,
  generateKey,
  sumPrefix,
  listAllSizes,
  deleteObjects,
  R2_PUBLIC_URL,
  R2_BUCKET,
};
