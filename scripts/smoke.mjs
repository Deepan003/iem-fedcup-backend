/**
 * End-to-end smoke test: boots the real server against a throw-away in-memory MongoDB and
 * runs a mini auction through REST + WebSockets. Run before deploying: `npm run smoke`.
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io } from 'socket.io-client';
import sharp from 'sharp';

const PORT = 4555;
const BASE = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'admin-pass-123';
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

const mongo = await MongoMemoryServer.create();
const env = {
  ...process.env,
  MONGODB_URI: mongo.getUri('fedcup'),
  MASTER_KEY: 'smoke-test-master-key-0123456789-abcdefghijklmnop',
  ADMIN_PASSWORD,
  CORS_ORIGIN: 'http://localhost:5173',
  PORT: String(PORT),
};

let server;
async function startServer() {
  server = spawn(process.execPath, ['src/index.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 20000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('API listening')) {
        clearTimeout(t);
        resolve();
      }
    });
    server.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => { server.once('exit', r); });
  server.kill('SIGTERM');
  await done;
}

async function api(method, path, body, token) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: {
      ...(isForm || !body ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`);
  return json;
}

/** Socket client that keeps the latest state, applying bid deltas like the frontend will. */
function connect(token) {
  return new Promise((resolve, reject) => {
    const s = io(BASE, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
    s.latest = null;
    s.on('state', (st) => { s.latest = st; });
    s.on('bid', (d) => {
      if (s.latest && d.v > s.latest.v) s.latest = { ...s.latest, v: d.v, lot: { ...s.latest.lot, ...d.lot } };
    });
    s.once('state', () => resolve(s));
    s.on('connect_error', reject);
  });
}
const emit = (s, ev, payload) => new Promise((r) => { s.emit(ev, payload, r); });
const admin = (s, action, args) => emit(s, 'admin', { action, args });
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timed out waiting for condition');
}

let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2)}. ${msg}`);
const sockets = [];

try {
  await startServer();
  ok('server boots against MongoDB');

  /* ---------------- admin setup ---------------- */
  const { token: adminToken, mustChangePassword } = await api('POST', '/auth/admin', { password: ADMIN_PASSWORD });
  assert.equal(mustChangePassword, true);
  await assert.rejects(api('POST', '/auth/admin', { password: 'wrong' }));
  ok('admin login with bootstrap password; wrong password rejected');

  const settings = await api('GET', '/admin/settings', null, adminToken);
  const auctionCfg = {
    ...settings.auction,
    teamBudget: 500,
    minSquadSize: 2,
    maxSquadSize: 3,
    reservePerSlot: 10,
    firstBidSec: 3,
    bidSec: 3,
    tiers: [{ name: 'Gold', basePrice: 50, color: '#e0a526' }],
    defaultBasePrice: 20,
  };
  await api('PUT', '/admin/settings/auction', auctionCfg, adminToken);
  await assert.rejects(api('PUT', '/admin/settings/auction', { ...auctionCfg, minSquadSize: 9 }, adminToken));
  ok('auction settings saved; invalid settings rejected');

  const teamA = await api('POST', '/admin/teams', { name: 'Alpha FC', shortName: 'ALP', color: '#e11d48', captainName: 'Cap A' }, adminToken);
  const teamB = await api('POST', '/admin/teams', { name: 'Bravo United', shortName: 'BRV', color: '#2563eb' }, adminToken);
  const { password: passA } = await api('POST', `/admin/teams/${teamA.id}/password`, {}, adminToken);
  const { password: passB } = await api('POST', `/admin/teams/${teamB.id}/password`, {}, adminToken);
  assert.match(passA, /^[a-z]+-[a-z]+-\d{4}$/);
  ok(`teams created; captain passwords generated (e.g. "${passA}")`);

  const mk = (name, position, extra = {}) => api('POST', '/admin/players', { name, position, ...extra }, adminToken);
  const dA = await mk('Aniket Test', 'Defender', { tier: 'Gold' });
  const dS = await mk('Shibam Test', 'Defender');
  const mid = await mk('Mid Test', 'Midfielder');
  await mk('Keeper Test', 'Goalkeeper');

  const png = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#336699' } }).png().toBuffer();
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'photo.png');
  const withPhoto = await api('POST', `/admin/players/${dA.id}/photo`, fd, adminToken);
  assert.ok(withPhoto.photoUrl.startsWith('/api/media/db/players/'), withPhoto.photoUrl);
  const img = await fetch(`${BASE}${withPhoto.photoUrl}`);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(`${meta.width}x${meta.height}`, '720x900');
  ok('players created; photo upload → 720x900 WebP served from DB fallback storage');

  await api('POST', `/admin/teams/${teamA.id}/retained`, { name: 'Retained Star', position: 'Forward', price: 100 }, adminToken);
  ok('retained player added to Alpha for 100');

  /* ---------------- captains + sockets ---------------- */
  const { token: capA } = await api('POST', '/auth/captain', { teamId: teamA.id, password: passA });
  const { token: capB } = await api('POST', '/auth/captain', { teamId: teamB.id, password: passB });
  await assert.rejects(api('POST', '/auth/captain', { teamId: teamA.id, password: passB }));
  ok('captain logins work; wrong password rejected');

  const sAdmin = await connect(adminToken);
  const sA = await connect(capA);
  const sB = await connect(capB);
  const sPub = await connect(null);
  sockets.push(sAdmin, sA, sB, sPub);
  assert.equal(sA.latest.teams.find((t) => t.id === teamA.id).purse, 400);
  ok('sockets connected (admin, 2 captains, viewer); Alpha purse 500 − 100 retained = 400');

  const serverNow = await emit(sPub, 'sync', null);
  assert.ok(Math.abs(serverNow - Date.now()) < 2000);
  ok('clock sync works');

  /* ---------------- live auction ---------------- */
  assert.equal((await emit(sA, 'bid', { lotSeq: 1, amount: 50 })).code, 'NOT_LIVE');
  assert.equal((await admin(sAdmin, 'start')).ok, true);
  let res = await admin(sAdmin, 'loadLot');
  assert.equal(res.lot.playerId, dA.id, 'queue: defenders first, alphabetical');
  assert.equal(res.lot.base, 50, 'Gold tier base price');
  await waitFor(() => sPub.latest.lot?.player?.name === 'Aniket Test');
  assert.equal(sPub.latest.lot.player.photoUrl, withPhoto.photoUrl);
  ok('auction started; first lot (Gold defender, base 50) reached the viewer with photo');

  assert.equal((await emit(sA, 'bid', { lotSeq: 1, amount: 50 })).code, 'BIDDING_NOT_OPEN');
  await admin(sAdmin, 'openBidding');
  const [ra, rb] = await Promise.all([
    emit(sA, 'bid', { lotSeq: 1, amount: 50 }),
    emit(sB, 'bid', { lotSeq: 1, amount: 50 }),
  ]);
  assert.equal([ra, rb].filter((r) => r.ok).length, 1, 'exactly one simultaneous bid wins');
  const loser = ra.ok ? rb : ra;
  assert.equal(loser.code, 'STALE_AMOUNT');
  assert.equal(loser.lot.nextAmount, 55, 'loser is told the new price');
  ok('simultaneous same-amount bids: exactly one accepted, other gets STALE_AMOUNT + new price 55');

  const loserSocket = ra.ok ? sB : sA;
  const winnerSocket = ra.ok ? sA : sB;
  res = await emit(loserSocket, 'bid', { lotSeq: 1, amount: 55 });
  assert.equal(res.ok, true);
  assert.equal((await emit(loserSocket, 'bid', { lotSeq: 1, amount: 60 })).code, 'ALREADY_LEADING');
  await waitFor(() => sPub.latest.lot.amount === 55);
  ok('outbid at 55 delivered to viewers as a delta; self-outbid blocked');

  const loserTeamId = loserSocket === sA ? teamA.id : teamB.id;
  await waitFor(() => sPub.latest.lot?.phase === 'awaiting', 6000);
  assert.equal(sPub.latest.lot.leaderId, loserTeamId);
  assert.equal((await emit(winnerSocket, 'bid', { lotSeq: 1, amount: 60 })).code, 'BIDDING_CLOSED');
  assert.equal(sPub.latest.stats.sold, 0, 'nothing is sold before the auctioneer confirms');
  ok('timer expired → bidding closed, awaiting auctioneer (late bid rejected, not sold yet)');

  assert.equal((await admin(sAdmin, 'confirmSale')).ok, true);
  await waitFor(() => sPub.latest.lot?.phase === 'sold');
  const soldTeam = sPub.latest.teams.find((t) => t.id === loserTeamId);
  assert.ok(soldTeam.squad.some((p) => p.name === 'Aniket Test' && p.price === 55));
  ok('auctioneer clicked Confirm → SOLD for 55; squad updated for everyone');

  /* captain visibility switch */
  await api('PUT', '/admin/settings/captainView', { ...settings.captainView, showOtherPurses: false, showOtherSquads: false }, adminToken);
  await waitFor(() => {
    const other = winnerSocket.latest.teams.find((t) => t.id !== (winnerSocket === sA ? teamA.id : teamB.id));
    return other && other.purse === undefined && other.squad === undefined;
  });
  const own = winnerSocket.latest.teams.find((t) => t.id === (winnerSocket === sA ? teamA.id : teamB.id));
  assert.ok(own.purse !== undefined && own.squad);
  ok('admin hid other teams\' purses/squads → enforced server-side, own team still visible');

  /* undo */
  assert.equal((await admin(sAdmin, 'undoLastSale')).ok, true);
  await waitFor(() => sPub.latest.stats.sold === 0);
  ok('undo last sale → player back in pool, money returned');

  /* manual sale + pause/resume */
  await admin(sAdmin, 'loadLot', { playerId: mid.id });
  await admin(sAdmin, 'openBidding');
  await admin(sAdmin, 'pause');
  assert.equal((await emit(sA, 'bid', { lotSeq: sPub.latest.lot.seq, amount: 20 })).code, 'PAUSED');
  await admin(sAdmin, 'resume');
  res = await admin(sAdmin, 'manualSale', { teamId: teamB.id, amount: 35 });
  assert.equal(res.ok, true, JSON.stringify(res));
  ok('pause blocks bids; resume; manual sale recorded (Mid Test → Bravo for 35)');

  /* crash recovery */
  await admin(sAdmin, 'loadLot', { playerId: dS.id });
  await admin(sAdmin, 'openBidding');
  const lotSeq = (await emit(sAdmin, 'state:get')).lot.seq;
  assert.equal((await emit(sA, 'bid', { lotSeq, amount: 20 })).ok, true);
  sockets.forEach((s) => s.close());
  sockets.length = 0;
  await stopServer();
  await startServer();
  const recovered = await api('GET', '/state');
  assert.equal(recovered.paused, true);
  assert.equal(recovered.lot.seq, lotSeq);
  assert.equal(recovered.lot.amount, 20);
  assert.equal(recovered.lot.leaderId, teamA.id);
  assert.ok(recovered.lot.remainingMs > 0);
  ok('server restarted mid-lot → auction restored PAUSED with same lot, price 20, leader and time left');

  /* portal + export + audit */
  const found = await api('GET', '/players/search?q=mid');
  assert.equal(found[0].team.name, 'Bravo United');
  assert.equal(found[0].price, 35);
  ok('player portal search shows "Mid Test → Bravo United for 35"');

  const csvRes = await fetch(`${BASE}/api/admin/export.csv`, { headers: { authorization: `Bearer ${adminToken}` } });
  const csv = await csvRes.text();
  assert.ok(csv.includes('"Mid Test","Midfielder"') && csv.includes('"Bravo United","35"'));
  const logs = await api('GET', '/admin/logs', null, adminToken);
  assert.ok(logs.some((l) => l.type === 'bid_rejected') && logs.some((l) => l.type === 'sold'));
  ok('CSV export and audit log (incl. rejected bids) work');

  /* password change logs out old admin sessions */
  await api('POST', '/admin/password', { next: 'a-much-better-password' }, adminToken);
  await assert.rejects(api('GET', '/admin/settings', null, adminToken));
  ok('changing admin password invalidates old admin sessions');
} catch (err) {
  console.error('\nSMOKE TEST FAILED:', err);
  process.exitCode = 1;
}

sockets.forEach((s) => s.close());
await stopServer().catch(() => {});
await mongo.stop();
console.log(process.exitCode === 1 ? '\n✗ smoke test failed' : '\n✓ smoke test passed');
process.exit(process.exitCode ?? 0);
