import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { Team } from '../models.js';
import { config } from '../config.js';
import { signToken } from '../lib/auth.js';
import { decrypt, safeEqual } from '../lib/crypto.js';
import { getSettingsDoc } from '../settings.js';
import { ipKey } from '../lib/net.js';

const router = Router();
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// Per visitor (real IP behind Cloudflare). Captain attempts are also split by team, so one
// team's typos on the venue Wi-Fi can never lock the other captains out.
const adminLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: ipKey,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});
const captainLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKey(req)}:${String(req.body?.teamId || '').slice(0, 24)}`,
  message: { error: 'TOO_MANY_ATTEMPTS' },
});

router.post('/admin', adminLimiter, h(async (req, res) => {
  const password = String(req.body?.password || '');
  if (!password) return res.status(400).json({ error: 'PASSWORD_REQUIRED' });
  const s = await getSettingsDoc();
  let ok = false;
  if (s.adminPasswordHash) ok = await bcrypt.compare(password, s.adminPasswordHash);
  else if (config.bootstrapAdminPassword) ok = safeEqual(password, config.bootstrapAdminPassword);
  else return res.status(503).json({ error: 'ADMIN_PASSWORD_NOT_SET' });
  if (!ok) return res.status(401).json({ error: 'WRONG_PASSWORD' });
  return res.json({
    token: signToken({ role: 'admin', tv: s.adminTokenVersion ?? 0 }, '12h'),
    mustChangePassword: !s.adminPasswordHash,
  });
}));

router.post('/captain', captainLimiter, h(async (req, res) => {
  const { teamId } = req.body || {};
  const password = String(req.body?.password || '').trim();
  if (!mongoose.isValidObjectId(teamId) || !password) return res.status(400).json({ error: 'TEAM_AND_PASSWORD_REQUIRED' });
  const team = await Team.findById(teamId);
  if (!team?.captainPasswordEnc || !safeEqual(password, decrypt(team.captainPasswordEnc))) {
    return res.status(401).json({ error: 'WRONG_PASSWORD' });
  }
  return res.json({
    token: signToken({ role: 'captain', teamId: String(team._id), tv: team.tokenVersion ?? 0 }, '24h'),
    team: { id: String(team._id), name: team.name },
  });
}));

export default router;
