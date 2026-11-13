import {
  S3Client, PutObjectCommand, DeleteObjectCommand, HeadBucketCommand,
} from '@aws-sdk/client-s3';
import { Media } from '../models.js';

/**
 * Image storage.
 * - Cloudflare R2 when configured (Admin → Integrations): served from R2's public URL / CDN.
 * - Otherwise MongoDB (keys prefixed "db/"), served by GET /api/media/<key> with long cache headers.
 * Keys contain a content hash, so files are immutable and safe to cache forever.
 */
let r2 = null;

function makeClient(cfg) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

export function isCompleteR2(cfg) {
  return !!(cfg?.accountId && cfg.accessKeyId && cfg.secretAccessKey && cfg.bucket && cfg.publicUrl);
}

export function configureStorage(cfg) {
  r2 = isCompleteR2(cfg)
    ? { client: makeClient(cfg), bucket: cfg.bucket, publicUrl: cfg.publicUrl.replace(/\/+$/, '') }
    : null;
}

export const storageMode = () => (r2 ? 'r2' : 'database');

export async function putObject(key, body, contentType) {
  if (r2) {
    await r2.client.send(new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return key;
  }
  const dbKey = `db/${key}`;
  await Media.updateOne(
    { _id: dbKey },
    { $set: { contentType, data: body, size: body.length, createdAt: new Date() } },
    { upsert: true },
  );
  return dbKey;
}

export async function deleteObject(key) {
  if (!key) return;
  try {
    if (key.startsWith('db/')) await Media.deleteOne({ _id: key });
    else if (r2) await r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: key }));
  } catch (err) {
    console.warn('deleteObject failed', key, err.message);
  }
}

/** Public URL for a stored key. Database-backed URLs are relative to the API origin. */
export function urlFor(key) {
  if (!key) return null;
  if (key.startsWith('db/')) return `/api/media/${key}`;
  return r2 ? `${r2.publicUrl}/${key}` : null;
}

export async function testR2(cfg) {
  if (!isCompleteR2(cfg)) throw new Error('Fill in account ID, access key, secret, bucket and public URL');
  const client = makeClient(cfg);
  await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
  const key = `healthcheck/${Date.now()}.txt`;
  await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: 'ok', ContentType: 'text/plain' }));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return true;
}
