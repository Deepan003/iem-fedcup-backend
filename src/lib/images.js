import crypto from 'node:crypto';
import sharp from 'sharp';
import convertHeic from 'heic-convert';

sharp.cache(false);
sharp.concurrency(2);

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);

/* --------------------------- HEIC / HEIF support --------------------------- */
// sharp's prebuilt binaries cannot decode HEVC-compressed HEIC (iPhone photos), so those are
// converted to JPEG first with heic-convert (libheif compiled to WebAssembly).

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);
const HEIF_BRANDS = new Set([...HEIC_BRANDS, 'mif1', 'msf1']); // mif1/msf1 may also be AVIF

const brandOf = (buf) => (buf?.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp' ? buf.toString('ascii', 8, 12) : '');
export const isHeic = (buf) => HEIC_BRANDS.has(brandOf(buf));
const maybeHeif = (buf) => HEIF_BRANDS.has(brandOf(buf));

// One conversion at a time: decoding a 12 MP HEIC in WebAssembly uses a lot of memory.
let heicQueue = Promise.resolve();
function heicToJpeg(buf) {
  const job = heicQueue.then(() => convertHeic({ buffer: buf, format: 'JPEG', quality: 0.92 }));
  heicQueue = job.catch(() => {});
  return job.then((out) => Buffer.from(out));
}

/** Runs `fn` on the image; HEIC is converted first, and HEIF-looking files get a second try. */
async function withDecodable(input, fn) {
  if (isHeic(input)) return fn(await heicToJpeg(input));
  try {
    return await fn(input);
  } catch (err) {
    if (maybeHeif(input)) return fn(await heicToJpeg(input));
    throw err;
  }
}

/* ------------------------------- processors -------------------------------- */

/**
 * Player photo → portrait card image (720x900) + thumbnail (240x300), WebP.
 * `attention` cropping keeps the most detailed region (usually the face) in frame,
 * and rotate() applies the phone's EXIF orientation.
 */
export function processPlayerPhoto(input) {
  return withDecodable(input, async (buf) => {
    const base = sharp(buf, { failOn: 'none' }).rotate();
    const main = await base.clone()
      .resize(720, 900, { fit: 'cover', position: sharp.strategy.attention })
      .webp({ quality: 80 })
      .toBuffer();
    const thumb = await base.clone()
      .resize(240, 300, { fit: 'cover', position: sharp.strategy.attention })
      .webp({ quality: 72 })
      .toBuffer();
    return { main, thumb, hash: hash(main) };
  });
}

/**
 * Team logo kept whole: original shape, never cropped or padded, transparency preserved.
 * Only shrunk if larger than 1024px on its longest side.
 */
export function processLogo(input) {
  return withDecodable(input, async (buf) => {
    const out = await sharp(buf, { failOn: 'none' })
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92, alphaQuality: 100 })
      .toBuffer();
    return { main: out, hash: hash(out) };
  });
}

export function describeImageError(err) {
  const msg = String(err?.message || err);
  if (/heif|heic/i.test(msg)) return 'Could not convert this iPhone (HEIC) photo. Try Retry, or upload a JPG/PNG manually.';
  if (/unsupported image format|Input buffer contains unsupported/i.test(msg)) return 'File is not a supported image (JPG, PNG, WebP, HEIC).';
  return msg.slice(0, 200);
}
