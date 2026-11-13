import { Router } from 'express';
import { Team } from '../models.js';
import { requireCaptain } from '../lib/auth.js';
import { auctionService } from '../auction/service.js';

const router = Router();
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

router.use(requireCaptain);

const FORMATIONS = ['4-4-2', '4-3-3', '3-5-2', '4-2-3-1', '3-4-3', '5-3-2', '4-1-4-1', '5-4-1'];

/** The captain's private squad plan (formation, lineup, watchlist). */
router.get('/plan', h(async (req, res) => {
  const team = await Team.findById(req.session.teamId, { plan: 1, name: 1 }).lean();
  res.json({
    formations: FORMATIONS,
    showSquadBuilder: auctionService.sections.captainView.showSquadBuilder,
    plan: team?.plan || { formation: '4-4-2', lineup: {}, watchlist: [] },
  });
}));

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
  await Team.updateOne({ _id: req.session.teamId }, { $set: { plan: { formation, lineup, watchlist } } });
  res.json({ ok: true });
}));

export default router;
