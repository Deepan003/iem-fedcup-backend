import crypto from 'node:crypto';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(2);

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);

/**
 * Player photo → portrait card image (720x900) + thumbnail (240x300), WebP.
 * `attention` cropping keeps the most detailed region (usually the face) in frame,
 * and rotate() applies the phone's EXIF orientation.
 */
export async function processPlayerPhoto(input) {
  const base = sharp(input, { failOn: 'none' }).rotate();
  const main = await base.clone()
    .resize(720, 900, { fit: 'cover', position: sharp.strategy.attention })
    .webp({ quality: 80 })
    .toBuffer();
  const thumb = await base.clone()
    .resize(240, 300, { fit: 'cover', position: sharp.strategy.attention })
    .webp({ quality: 72 })
    .toBuffer();
  return { main, thumb, hash: hash(main) };
}

/**
 * Team logo kept whole: original shape, never cropped or padded, transparency preserved.
 * Only shrunk if larger than 1024px on its longest side.
 */
export async function processLogo(input) {
  const out = await sharp(input, { failOn: 'none' })
    .rotate()
    .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 92, alphaQuality: 100 })
    .toBuffer();
  return { main: out, hash: hash(out) };
}

export function describeImageError(err) {
  const msg = String(err?.message || err);
  if (/heif|heic/i.test(msg)) return 'HEIC photo (iPhone) is not supported. Upload a JPG/PNG manually.';
  if (/unsupported image format|Input buffer contains unsupported/i.test(msg)) return 'File is not a supported image (JPG, PNG, WebP).';
  return msg.slice(0, 200);
}
