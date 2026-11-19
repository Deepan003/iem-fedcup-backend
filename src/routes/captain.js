import { Router } from 'express';
import { Team } from '../models.js';
import { requireCaptain } from '../lib/auth.js';
import { auctionService } from '../auction/service.js';

const router = Router();
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(requireCaptain);

const FORMATIONS = [
  '4-4-2', '4-3-3', '4-2-3-1', '4-5-1', '4-4-1-1', '4-1-4-1', '4-1-2-1-2', '4-2-2-2', '4-3-2-1', '3-5-2', '3-4-3', '3-4-1-2', '3-4-2-1', '5-3-2', '5-4-1', '5-2-3',
  '3-3-2', '3-4-1', '4-3-1', '3-2-3', // 9-a-side
  '2-3-1', '3-2-1', '3-1-2', '2-2-2', // 7-a-side
];

/** The captain's private squad plan (formation, lineup, watchlist). */
router.get('/plan', h(async (req, res) => {
  const team = await Team.findById(req.session.teamId, { plan: 1, name: 1 }).lean();
  res.json({
    formations: FORMATIONS,
    showSquadBuilder: auctionService.sections.captainView.showSquadBuilder,
    plan: team?.plan || { formation: '4-4-2', lineup: {}, watchlist: [] },
  });
}));

/** The whole player pool for captains (works even when the public players page is closed). */
router.get('/pool', (req, res) => {
  const e = auctionService.engine;
  res.set('Cache-Control', 'private, max-age=10');
  res.json([...e.players.values()]
    .filter((p) => p.status !== 'withheld')
    .map((p) => ({ ...auctionService.publicPlayer(p), teamId: p.teamId, price: ['sold', 'retained'].includes(p.status) ? p.price : null })));
});

router.put('/plan', h(async (req, res) => {
  const body = req.body || {};
  const formation = FORMATIONS.includes(body.formation) ? body.formation : '4-4-2';
  const lineup = {};
  for (const [slot, playerId] of Object.entries(body.lineup || {}).slice(0, 30)) {
    if (/^[a-z0-9_-]{1,20}$/i.test(slot) && typeof playerId === 'string' && playerId.length <= 40) lineup[slot] = playerId;
  }
  const watchlist = (Array.isArray(body.watchlist) ? body.watchlist : []).slice(0, 100).map((w) => ({
    playerId: String(w.playerId || '').slice(0, 40),
    maxPrice: Number.isFinite(Number(w.maxPrice)) ? Math.max(0, Math.round(Number(w.maxPrice))) : null,
    note: String(w.note || '').slice(0, 200),
  })).filter((w) => w.playerId);
  const manual = body.manual === true; // lineup set by hand (no auto-fill)
  await Team.updateOne({ _id: req.session.teamId }, { $set: { plan: { formation, lineup, watchlist, manual } } });
  res.json({ ok: true });
}));

export default router;
