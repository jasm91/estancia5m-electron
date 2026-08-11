/**
 * reprocess-images-r2.js — v0.9.263
 *
 * Recomprime las imágenes pesadas que YA están subidas a R2 (las que exceden el límite
 * de WhatsApp de ~5 MB y por eso salían "no entregado"). Las re-sube a la MISMA key,
 * así las URLs guardadas en la BD NO cambian y no hay que re-subir nada a mano.
 *
 * Es idempotente: solo toca imágenes que pesan más del umbral; las ya livianas las salta.
 *
 * CÓMO CORRERLO (necesita las env R2_* del backend):
 *   Railway:  railway run -s <servicio-backend> node reprocess-images-r2.js
 *   Local:    R2_ACCOUNT_ENDPOINT=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
 *             R2_BUCKET=... R2_PUBLIC_URL=... node reprocess-images-r2.js
 *
 *   Opcional: DRY_RUN=1 para solo listar qué tocaría, sin escribir.
 *             THRESHOLD_MB=4.5 para cambiar el umbral (default 4.5 MB).
 */

const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { compressImage } = require('./image-tools');

const BUCKET = process.env.R2_BUCKET || 'sg-ventas-media';
const DRY_RUN = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';
const THRESHOLD = (parseFloat(process.env.THRESHOLD_MB) || 4.5) * 1024 * 1024;

// Prefijos de contenido que se ENVÍA a clientes por WhatsApp (fotos de catálogo).
const PREFIXES = ['properties/', 'inventory/', 'services/', 'salud/', 'belleza/', 'restaurante/', 'assets/', 'outgoing/'];
const IMG_EXT = /\.(jpe?g|png|webp)$/i;

if (!process.env.R2_ACCOUNT_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
  console.error('❌ Faltan las variables R2_* (R2_ACCOUNT_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY). Corré con `railway run`.');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ACCOUNT_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

const mb = (n) => (n / 1048576).toFixed(2) + 'MB';

async function run() {
  console.log(`🔧 Reprocesando imágenes > ${(THRESHOLD / 1048576).toFixed(1)}MB en bucket "${BUCKET}"${DRY_RUN ? ' (DRY RUN — no escribe)' : ''}\n`);
  let token, scanned = 0, candidates = 0, fixed = 0, skipped = 0, failed = 0, savedBytes = 0;
  do {
    const out = await client.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of (out.Contents || [])) {
      const key = o.Key;
      if (!PREFIXES.some((p) => key.startsWith(p))) continue;
      if (!IMG_EXT.test(key)) continue;
      scanned++;
      if ((o.Size || 0) <= THRESHOLD) continue;
      candidates++;
      try {
        const g = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const buf = await streamToBuffer(g.Body);
        const mt = g.ContentType || 'image/jpeg';
        const c = await compressImage(buf, mt, key.split('/').pop());
        if (!c.changed) { console.log(`·  no comprimible (se deja): ${key} (${mb(o.Size)})`); skipped++; continue; }
        if (DRY_RUN) { console.log(`?  [dry] ${key}  ${mb(o.Size)} → ${mb(c.buffer.length)}`); fixed++; savedBytes += (buf.length - c.buffer.length); continue; }
        await client.send(new PutObjectCommand({
          Bucket: BUCKET, Key: key, Body: c.buffer,
          ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000',
        }));
        console.log(`✓  ${key}  ${mb(o.Size)} → ${mb(c.buffer.length)}`);
        fixed++; savedBytes += (buf.length - c.buffer.length);
      } catch (e) {
        console.error(`✗  ${key}: ${e.message}`); failed++;
      }
    }
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);

  console.log(`\n── Listo ──`);
  console.log(`Imágenes escaneadas: ${scanned} · sobre el umbral: ${candidates}`);
  console.log(`Recomprimidas: ${fixed} · saltadas: ${skipped} · fallidas: ${failed}`);
  console.log(`Espacio ahorrado: ${mb(savedBytes)}${DRY_RUN ? ' (estimado)' : ''}`);
}

run().then(() => process.exit(0)).catch((e) => { console.error('Fatal:', e); process.exit(1); });
