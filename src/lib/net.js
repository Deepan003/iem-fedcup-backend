import { isIP } from 'node:net';
import { ipKeyGenerator } from 'express-rate-limit';

/**
 * The visitor's real IP. Behind Cloudflare (+ a reverse proxy) req.ip is often a Cloudflare edge
 * address shared by many people, so per-IP rate limits would lump the whole venue together.
 * Prefer Cloudflare's CF-Connecting-IP when it holds a valid IP; otherwise use req.ip.
 */
export function clientIp(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  return isIP(cf) ? cf : (req.ip || req.socket?.remoteAddress || 'unknown');
}

/** Rate-limit key for the visitor (IPv6 addresses are grouped by /56, as express-rate-limit recommends). */
export const ipKey = (req) => ipKeyGenerator(clientIp(req));
