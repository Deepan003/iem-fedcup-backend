import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  AuditLog, Bid, Player, Team,
} from '../models.js';
import { auctionService, fitOut } from '../auction/service.js';
import { getObject, urlFor } from '../integrations/storage.js';
import { getSettingsDoc } from '../settings.js';
import { decrypt, safeEqual } from '../lib/crypto.js';
import { ipKey } from '../lib/net.js';

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
    cardsEnabled: !!portal.cards,
    currency: auction.currency,
    decimals: auction.decimals || 0,
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
  const teams = await Team.find({}, { name: 1, shortName: 1, color: 1, logoKey: 1, logoFit: 1, order: 1 }).sort({ order: 1, name: 1 }).lean();
  res.json(teams.map((t) => ({
    id: String(t._id), name: t.name, shortName: t.shortName, color: t.color, logoUrl: urlFor(t.logoKey), logoFit: fitOut(t.logoFit),
  })));
}));

/* ------------------------- player portal (search) ------------------------ */

const portalLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: ipKey,
});

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
  const teams = new Map((await Team.find({}, { name: 1, color: 1, logoKey: 1, logoFit: 1 }).lean()).map((t) => [String(t._id), t]));
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
      team: t ? { id: String(t._id), name: t.name, color: t.color, logoUrl: urlFor(t.logoKey), logoFit: fitOut(t.logoFit) } : null,
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

/**
 * One player's auction story: every lot they went under the hammer in, with each bid
 * (team, amount, time). Bids an admin took back (undo) are left out. Cached briefly so a
 * player sharing their link with the whole class costs one database read, not hundreds.
 */
const storyCache = new Map(); // id -> { at, dataV, body }
router.get('/players/:id/bids', portalLimiter, portalGate, h(async (req, res) => {
  const e = auctionService.engine;
  const p = e.players.get(String(req.params.id));
  if (!p || p.status === 'withheld') return res.status(404).json({ error: 'NOT_FOUND' });
  const dataV = e.state.version;
  const hit = storyCache.get(p.id);
  if (hit && hit.dataV === dataV && Date.now() - hit.at < 15000) return res.json(hit.body);

  const [rows, undone] = await Promise.all([
    Bid.find({ playerId: p.id }, {
      lotSeq: 1, round: 1, teamId: 1, amount: 1, at: 1, _id: 0,
    }).sort({ at: 1 }).limit(2000).lean(),
    AuditLog.find({ type: { $in: ['bid_undone', 'bids_reset'] }, 'data.removed': { $exists: true } }, { type: 1, data: 1, _id: 0 }).lean(),
  ]);
  const gone = new Set(undone.flatMap((u) => (Array.isArray(u.data.removed) ? u.data.removed : [u.data.removed]).map((r) => `${u.data.seq}|${r.teamId}|${r.amount}|${+new Date(r.at)}`)));
  const byLot = new Map();
  for (const r of rows) {
    if (gone.has(`${r.lotSeq}|${r.teamId}|${r.amount}|${+new Date(r.at)}`)) continue;
    const lot = byLot.get(r.lotSeq) || { seq: r.lotSeq, round: r.round, bids: [] };
    lot.bids.push({ teamId: String(r.teamId), amount: r.amount, at: r.at });
    byLot.set(r.lotSeq, lot);
  }
  const lots = [...byLot.values()].sort((a, b) => a.seq - b.seq).map((l) => ({
    ...l, final: p.status === 'sold' && l.seq === p.lotSeq,
  }));
  const body = {
    player: {
      ...auctionService.publicPlayer(p), status: p.status, teamId: p.teamId, price: ['sold', 'retained'].includes(p.status) ? p.price : null,
    },
    lots,
  };
  storyCache.set(p.id, { at: Date.now(), dataV, body });
  if (storyCache.size > 600) storyCache.delete(storyCache.keys().next().value);
  return res.json(body);
}));

/**
 * The player pool for the studio / anyone watching: every player and where they stand
 * (still to come, sold + buyer + price, unsold). Not tied to the portal switch; the same facts are
 * already public on the studio as the auction runs. Built from memory, cached briefly.
 */
let poolCache = { at: 0, v: -1, body: null };
router.get('/pool', portalLimiter, (req, res) => {
  const e = auctionService.engine;
  const v = e.state.version;
  if (!poolCache.body || poolCache.v !== v || Date.now() - poolCache.at > 10000) {
    poolCache = {
      at: Date.now(), v,
      body: [...e.players.values()].filter((p) => p.status !== 'withheld').map((p) => ({
        ...auctionService.publicPlayer(p), status: p.status, teamId: p.teamId, price: ['sold', 'retained'].includes(p.status) ? p.price : null,
      })),
    };
  }
  res.set('Cache-Control', 'public, max-age=5');
  res.json(poolCache.body);
});

/* ------------------------- images stored in MongoDB ----------------------- */

/*
 * Keys contain a content hash, so a stored image never changes. Keep recently served images in
 * memory (≈24 MB cap, oldest evicted first) so hundreds of viewers loading the same player photo
 * cause one database read, not hundreds. Concurrent misses for the same key share one query.
 */
const MEDIA_CACHE_MAX = 24 * 1024 * 1024;
const mediaCache = new Map(); // key -> { type, body }
const mediaPending = new Map(); // key -> Promise
let mediaCacheBytes = 0;

async function loadMedia(key) {
  const hit = mediaCache.get(key);
  if (hit) {
    mediaCache.delete(key); // refresh recency
    mediaCache.set(key, hit);
    return hit;
  }
  if (mediaPending.has(key)) return mediaPending.get(key);
  // database images and R2 images alike (R2's public URL sends no CORS header, so canvas
  // drawing — player cards, videos — loads R2 images through here instead)
  const p = getObject(key).catch(() => null).then((obj) => {
    if (!obj) return null;
    const entry = { type: obj.type, body: obj.body };
    const body = entry.body;
    mediaCache.set(key, entry);
    mediaCacheBytes += body.length;
    for (const [k, v] of mediaCache) {
      if (mediaCacheBytes <= MEDIA_CACHE_MAX) break;
      mediaCache.delete(k);
      mediaCacheBytes -= v.body.length;
    }
    return entry;
  }).finally(() => mediaPending.delete(key));
  mediaPending.set(key, p);
  return p;
}

// Only the folders the app writes to; unknown keys are remembered for a minute so a flood of made-up
// keys can't turn every request into a storage / database read.
const MEDIA_KEY = /^(db|players|teams|audio)\/[\w\-./]+$/;
const mediaMiss = new Map(); // key -> time of the last miss
const mediaLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 900, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: ipKey,
});

router.get('/media/*', mediaLimiter, h(async (req, res) => {
  const key = String(req.params[0] || '');
  if (!MEDIA_KEY.test(key) || key.includes('..') || key.length > 300) return res.status(404).end();
  const missAt = mediaMiss.get(key);
  if (missAt && Date.now() - missAt < 60_000) return res.status(404).end();
  const entry = await loadMedia(key);
  if (!entry) {
    mediaMiss.set(key, Date.now());
    if (mediaMiss.size > 5000) mediaMiss.delete(mediaMiss.keys().next().value);
    return res.status(404).end();
  }
  mediaMiss.delete(key);
  // only ever serve images / audio as themselves; anything else downloads as plain bytes
  res.set('Content-Type', /^(image|audio)\/[\w.+-]+$/.test(entry.type || '') ? entry.type : 'application/octet-stream');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  return res.send(entry.body);
}));

export default router;
