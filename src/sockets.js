import { Server } from 'socket.io';
import { resolveSession } from './lib/auth.js';

/**
 * Rooms:  public (viewers) · admin · team:<id> (captains of one team).
 * Events: server → client  'state' (full snapshot), 'bid' (small delta), 'viewers', 'job'
 *         client → server  'sync' (clock), 'state:get', 'bid' (captain), 'admin' (admin action)
 */
export function createSocketServer(httpServer, service, corsOrigins) {
  const io = new Server(httpServer, {
    cors: { origin: corsOrigins },
    perMessageDeflate: false, // saves CPU with hundreds of viewers; payloads are small
    pingInterval: 20000,
    pingTimeout: 25000,
    maxHttpBufferSize: 64 * 1024,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        socket.data.session = null;
        return next();
      }
      const session = await resolveSession(token);
      if (!session) return next(new Error('SESSION_EXPIRED'));
      socket.data.session = session;
      return next();
    } catch (err) {
      return next(new Error('AUTH_ERROR'));
    }
  });

  io.on('connection', (socket) => {
    const session = socket.data.session;
    const role = session?.role || 'public';
    const view = { role, teamId: session?.teamId };
    socket.join(role === 'admin' ? 'admin' : role === 'captain' ? `team:${session.teamId}` : 'public');

    socket.emit('state', service.stateFor(view));

    socket.on('sync', (_payload, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('state:get', (_payload, ack) => {
      if (typeof ack === 'function') ack(service.stateFor(view));
    });

    if (role === 'captain') {
      // Token bucket: bursts of 4, refilling 4 per second.
      let tokens = 4;
      let last = Date.now();
      socket.on('bid', (payload, ack) => {
        if (typeof ack !== 'function') return;
        const now = Date.now();
        tokens = Math.min(4, tokens + (now - last) / 250);
        last = now;
        if (tokens < 1) return ack({ ok: false, code: 'TOO_FAST' });
        tokens -= 1;
        try {
          return ack(service.captainBid(session.teamId, payload || {}));
        } catch (err) {
          console.error('[bid] error', err);
          return ack({ ok: false, code: 'SERVER_ERROR' });
        }
      });
    }

    if (role === 'admin') {
      socket.on('admin', (payload, ack) => {
        if (typeof ack !== 'function') return;
        try {
          ack(service.adminAction(payload?.action, payload?.args || {}));
        } catch (err) {
          console.error('[admin] error', err);
          ack({ ok: false, code: 'SERVER_ERROR' });
        }
      });
    }
  });

  const viewers = setInterval(() => {
    const rooms = io.sockets.adapter.rooms;
    const counts = {
      total: io.engine.clientsCount,
      public: rooms.get('public')?.size || 0,
      admin: rooms.get('admin')?.size || 0,
      captains: [...rooms.keys()].filter((r) => r.startsWith('team:')).reduce((s, r) => s + rooms.get(r).size, 0),
    };
    io.to('admin').emit('viewers', counts);
    if (service.sections?.studio.showViewerCount) io.to('public').emit('viewers', { total: counts.total });
  }, 5000);
  viewers.unref();

  return io;
}
