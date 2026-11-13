import crypto from 'node:crypto';
import { config } from '../config.js';

const derive = (purpose) => Buffer.from(crypto.hkdfSync('sha256', config.masterKey, 'iem-fedcup', purpose, 32));

const ENC_KEY = derive('credential-encryption');
export const JWT_SECRET = derive('jwt-signing');

/** AES-256-GCM. Output format: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export const encryptJson = (obj) => (obj ? encrypt(JSON.stringify(obj)) : '');
export const decryptJson = (blob) => (blob ? JSON.parse(decrypt(blob)) : null);

export function mask(value) {
  if (!value) return '';
  const s = String(value);
  return s.length <= 4 ? '••••' : `••••${s.slice(-4)}`;
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const WORDS = [
  'striker', 'volley', 'header', 'tackle', 'corner', 'penalty', 'derby', 'keeper', 'winger', 'dribble',
  'curler', 'chip', 'rocket', 'falcon', 'tiger', 'cobra', 'storm', 'thunder', 'phoenix', 'eagle',
];

/** Human-friendly password such as "falcon-volley-4821". */
export function friendlyPassword() {
  const pick = () => WORDS[crypto.randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${crypto.randomInt(1000, 10000)}`;
}
