import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Media, Player, Team } from '../models.js';
import { auctionService } from '../auction/service.js';
import { urlFor } from '../integrations/storage.js';
import { getSettingsDoc } from '../settings.js';
import { decrypt, safeEqual } from '../lib/crypto.js';

const router = Router();
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.get('/config', (req, res) => {
  const { studio, portal, auction } = auctionService.sections;
  const st = auctionService.engine.state;
  res.set('Cache-Control', 'public, max-age=5');
  res.json({
    studio: {
      live: studio.live, title: studio.title, subtitle: studio.subtitle, startsAt: studio.startsAt,
    },
    auctionStatus: st.status,
    portalMode: portal.mode,
    currency: auction.currency,
    serverNow: Date.now(),
  });
});

/** Snapshot for clients that cannot open a socket (and for first paint). */
router.get('/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(auctionService.stateFor({ role: 'public' }));
});

/** Team list for the captain login screen. */
router.get('/teams', h(async (req, res) => {
  const teams = await Team.find({}, { name: 1, shortName: 1, color: 1, logoKey: 1, order: 1 }).sort({ order: 1, name: 1 }).lean();
  res.json(teams.map((t) => ({
    id: String(t._id), name: t.name, shortName: t.shortName, color: t.color, logoUrl: urlFor(t.logoKey),
  })));
}));

/* ------------------------- player portal (search) ------------------------ */

const portalLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

const portalGate = h(async (req, res, next) => {
  const mode = auctionService.sections.portal.mode;
  if (mode === 'off') return res.status(404).json({ error: 'PORTAL_CLOSED' });
  if (mode === 'code') {
    const s = await getSettingsDoc();
    const code = String(req.get('x-portal-code') || req.query.code || '');
    if (!s.portalCodeEnc || !code || !safeEqual(code.trim().toLowerCase(), decrypt(s.portalCodeEnc).toLowerCase())) {
      return res.status(401).json({ error: 'PORTAL_CODE_REQUIRED' });
    }
  }
  return next();
});

router.get('/players/search', portalLimiter, portalGate, h(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 60);
  if (q.length < 2) return res.json([]);
  const players = await Player.find({ name: { $regex: escapeRegex(q), $options: 'i' }, status: { $ne: 'withheld' } })
    .limit(20).lean();
  const teams = new Map((await Team.find({}, { name: 1, color: 1, logoKey: 1 }).lean()).map((t) => [String(t._id), t]));
  res.json(players.map((p) => {
    const t = p.teamId ? teams.get(String(p.teamId)) : null;
    return {
      id: String(p._id),
      name: p.name,
      position: p.position,
      year: p.year,
      tier: p.tier,
      status: p.status,
      price: ['sold', 'retained'].includes(p.status) ? p.price : null,
      team: t ? { id: String(t._id), name: t.name, color: t.color, logoUrl: urlFor(t.logoKey) } : null,
      thumbUrl: urlFor(p.thumbKey) || urlFor(p.photoKey),
    };
  }));
}));

/** Public player showcase (all players in the pool). */
router.get('/players', portalLimiter, portalGate, (req, res) => {
  const e = auctionService.engine;
  res.set('Cache-Control', 'public, max-age=15');
  res.json([...e.players.values()]
    .filter((p) => p.status !== 'withheld')
    .map((p) => ({ ...auctionService.publicPlayer(p), teamId: p.teamId, price: ['sold', 'retained'].includes(p.status) ? p.price : null })));
});

/* ------------------------- images stored in MongoDB ----------------------- */

router.get('/media/*', h(async (req, res) => {
  const key = req.params[0];
  const doc = await Media.findById(key).lean();
  if (!doc) return res.status(404).end();
  res.set('Content-Type', doc.contentType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.send(doc.data.buffer ? Buffer.from(doc.data.buffer) : doc.data);
}));

export default router;
