import jwt from 'jsonwebtoken';
import { JWT_SECRET } from './crypto.js';
import { Settings, Team } from '../models.js';

export function signToken(payload, expiresIn = '12h') {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Validates a token against the current DB state (so changing the admin password or
 * regenerating a captain password logs out old sessions immediately).
 */
export async function resolveSession(token) {
  const p = token && verifyToken(token);
  if (!p) return null;
  if (p.role === 'admin') {
    const s = await Settings.findById('main', { adminTokenVersion: 1 }).lean();
    return (s?.adminTokenVersion ?? 0) === p.tv ? { role: 'admin' } : null;
  }
  if (p.role === 'captain') {
    const t = await Team.findById(p.teamId, { tokenVersion: 1 }).lean();
    return t && (t.tokenVersion ?? 0) === p.tv ? { role: 'captain', teamId: String(t._id) } : null;
  }
  return null;
}

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
};

export function requireRole(role) {
  return async (req, res, next) => {
    try {
      const session = await resolveSession(bearer(req));
      if (!session || session.role !== role) return res.status(401).json({ error: 'UNAUTHORIZED' });
      req.session = session;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export const requireAdmin = requireRole('admin');
export const requireCaptain = requireRole('captain');
