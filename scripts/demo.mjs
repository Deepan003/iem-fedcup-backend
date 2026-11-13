/**
 * Local demo — try the whole auction without MongoDB Atlas, R2 or Google.
 *
 *   npm run demo               start (data is kept in .demo-data/ between runs)
 *   npm run demo -- --fresh    wipe the demo data and seed again
 *   npm run demo -- --bots     computer captains bid for every team except the first one,
 *                              so you can run a realistic auction alone
 *
 * Then start the frontend (`npm run dev` in ../frontend) and open http://localhost:5173
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io } from 'socket.io-client';
import sharp from 'sharp';

const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.PORT || 4000);
const API = `http://localhost:${PORT}`;
const ADMIN_PASSWORD = 'fedcup-demo';
const DATA_DIR = path.resolve('.demo-data');

if (args.has('--fresh')) fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

console.log('Starting local database…');
const mongo = await MongoMemoryServer.create({ instance: { dbPath: DATA_DIR, storageEngine: 'wiredTiger' } });

const server = spawn(process.execPath, ['src/index.js'], {
  env: {
    ...process.env,
    MONGODB_URI: mongo.getUri('fedcup-demo'),
    MASTER_KEY: 'local-demo-master-key-do-not-use-in-production-0123456789',
    ADMIN_PASSWORD,
    CORS_ORIGIN: 'http://localhost:5173,http://127.0.0.1:5173',
    PORT: String(PORT),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', (d) => {
    process.stdout.write(`[api] ${d}`);
    if (String(d).includes('API listening')) resolve();
  });
  server.once('exit', (c) => reject(new Error(`API exited with code ${c}`)));
});

async function api(method, p, body, token) {
  const isForm = body instanceof FormData;
  const res = await fetch(`${API}/api${p}`, {
    method,
    headers: {
      ...(isForm || !body ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/* --------------------------- generated artwork --------------------------- */

const POS_COLORS = {
  Goalkeeper: ['#f59e0b', '#7c2d12'], Defender: ['#2563eb', '#0b1d4d'], Midfielder: ['#16a34a', '#052e16'], Forward: ['#e11d48', '#4c0519'],
};
const initials = (name) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

async function avatar(name, position, seed) {
  const [c1, c2] = POS_COLORS[position];
  const skin = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524'][seed % 4];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="900">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="720" height="900" fill="url(#g)"/>
    <circle cx="360" cy="330" r="150" fill="${skin}"/>
    <path d="M90 900 C110 640 230 560 360 560 C490 560 610 640 630 900 Z" fill="${skin}" opacity="0.95"/>
    <path d="M150 900 C170 700 260 640 360 640 C460 640 550 700 570 900 Z" fill="${c2}" opacity="0.85"/>
    <text x="360" y="830" font-family="Arial, Helvetica, sans-serif" font-size="110" font-weight="700" fill="#ffffff" text-anchor="middle" opacity="0.9">${initials(name)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function logo(name, color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
    <path d="M256 24 L456 96 L432 312 C416 400 336 456 256 492 C176 456 96 400 80 312 L56 96 Z" fill="${color}" stroke="#ffffff" stroke-width="18"/>
    <text x="256" y="300" font-family="Arial, Helvetica, sans-serif" font-size="150" font-weight="800" fill="#ffffff" text-anchor="middle">${initials(name)}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const upload = (buf, name) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'image/png' }), name);
  return fd;
};

/* --------------------------------- seed ---------------------------------- */

const TEAMS = [
  { name: 'Crimson Dragons', shortName: 'CRD', color: '#dc2626', captainName: 'Arjun Sen' },
  { name: 'Azure Falcons', shortName: 'AZF', color: '#2563eb', captainName: 'Rohit Das' },
  { name: 'Emerald Vipers', shortName: 'EMV', color: '#059669', captainName: 'Sayan Ghosh' },
  { name: 'Golden Lions', shortName: 'GLL', color: '#d97706', captainName: 'Ankit Roy' },
  { name: 'Violet Titans', shortName: 'VLT', color: '#7c3aed', captainName: 'Pritam Saha' },
  { name: 'Obsidian Strikers', shortName: 'OBS', color: '#334155', captainName: 'Kunal Paul' },
];
const FIRST = ['Aarav', 'Ishan', 'Rahul', 'Sourav', 'Debjit', 'Subham', 'Aniket', 'Rohan', 'Sayantan', 'Arnab', 'Tanmoy', 'Abhishek', 'Ritwik', 'Soham', 'Kaushik', 'Nilanjan', 'Sagnik', 'Ayan', 'Sudip', 'Pratik', 'Rajdeep', 'Anirban', 'Shreyas', 'Dhruv'];
const LAST = ['Banerjee', 'Chatterjee', 'Mukherjee', 'Sen', 'Bose', 'Dutta', 'Ghosh', 'Roy', 'Saha', 'Pal', 'Mondal', 'Sarkar', 'Das', 'Biswas', 'Majumdar', 'Naskar', 'Halder', 'Kar'];
const YEARS = ['1st', '2nd', '3rd', '4th', 'Passout ( 2026 only )'];
const PLAN = [['Defender', 30], ['Midfielder', 24], ['Forward', 24], ['Goalkeeper', 12]];

async function seed(adminToken) {
  console.log('Seeding demo data (teams, 90 players with photos)…');
  const settings = await api('GET', '/admin/settings', null, adminToken);
  await api('PUT', '/admin/settings/auction', {
    ...settings.auction, teamBudget: 1000, minSquadSize: 11, maxSquadSize: 15, reservePerSlot: 20, firstBidSec: 20, bidSec: 10,
  }, adminToken);
  await api('PUT', '/admin/settings/studio', {
    ...settings.studio, live: true, title: 'IEM FED Cup Auction — Demo', subtitle: 'Rehearsal with demo data',
  }, adminToken);

  const teams = [];
  for (const [i, t] of TEAMS.entries()) {
    const team = await api('POST', '/admin/teams', { ...t, order: i }, adminToken);
    await api('POST', `/admin/teams/${team.id}/logo`, upload(await logo(t.name, t.color), 'logo.png'), adminToken);
    teams.push(team);
  }

  let n = 0;
  const used = new Set();
  const tierFor = (r) => (r < 0.08 ? 'Icon' : r < 0.28 ? 'Gold' : r < 0.62 ? 'Silver' : 'Bronze');
  for (const [position, count] of PLAN) {
    for (let i = 0; i < count; i += 1) {
      let name;
      do name = `${FIRST[(n * 7 + i * 3) % FIRST.length]} ${LAST[(n * 5 + i) % LAST.length]}`; while (used.has(name) && (n += 1));
      used.add(name);
      const p = await api('POST', '/admin/players', {
        name, position, tier: tierFor(Math.random()), year: YEARS[n % YEARS.length],
      }, adminToken);
      await api('POST', `/admin/players/${p.id}/photo`, upload(await avatar(name, position, n), 'p.png'), adminToken);
      n += 1;
      if (n % 15 === 0) console.log(`  ${n} players…`);
    }
  }

  for (const [i, team] of teams.entries()) {
    await api('POST', `/admin/teams/${team.id}/retained`, {
      name: `${TEAMS[i].captainName}`, position: ['Midfielder', 'Forward', 'Defender'][i % 3], year: '4th', price: 80 + i * 10,
    }, adminToken);
    await api('POST', `/admin/teams/${team.id}/password`, {}, adminToken);
  }
  await api('POST', '/admin/players/shuffle', {}, adminToken);
}

/* --------------------------------- bots ---------------------------------- */

function runBot(team, token) {
  const s = io(API, { auth: { token }, transports: ['websocket'] });
  const valuation = new Map();
  let state = null;
  let pending = null;
  const consider = () => {
    clearTimeout(pending);
    const lot = state?.lot;
    if (!state || state.status !== 'live' || state.paused || !lot || lot.phase !== 'bidding') return;
    if (lot.leaderId === team.id || state.me?.blockReason) return;
    if (!valuation.has(lot.playerId)) {
      const keen = Math.random() < 0.7;
      valuation.set(lot.playerId, keen ? Math.round(lot.base * (1 + Math.random() * 2.5)) : 0);
    }
    const cap = Math.min(valuation.get(lot.playerId), state.me?.maxBidForLot ?? 0);
    if (lot.nextAmount > cap) return;
    pending = setTimeout(() => {
      s.emit('bid', { lotSeq: lot.seq, amount: lot.nextAmount }, (res) => {
        if (!res?.ok && res?.lot && state) {
          state = { ...state, lot: { ...state.lot, ...res.lot } };
          consider();
        }
      });
    }, 600 + Math.random() * 3500);
  };
  s.on('state', (st) => { state = st; consider(); });
  s.on('bid', (d) => {
    if (state && d.v > state.v) {
      state = { ...state, v: d.v, lot: { ...state.lot, ...d.lot } };
      consider();
    }
  });
}

/* --------------------------------- main ---------------------------------- */

try {
  const { token: adminToken } = await api('POST', '/auth/admin', { password: ADMIN_PASSWORD });
  let teams = await api('GET', '/admin/teams', null, adminToken);
  if (!teams.length) {
    await seed(adminToken);
    teams = await api('GET', '/admin/teams', null, adminToken);
  }
  const creds = [];
  for (const t of teams) {
    const { password } = await api('GET', `/admin/teams/${t.id}/password`, null, adminToken);
    creds.push({ team: t, password });
  }

  if (args.has('--bots')) {
    for (const { team, password } of creds.slice(1)) {
      const { token } = await api('POST', '/auth/captain', { teamId: team.id, password });
      runBot(team, token);
    }
  }

  const line = '─'.repeat(64);
  console.log(`\n${line}\n  IEM FED Cup — local demo is running\n${line}`);
  console.log(`  API         ${API}/api/health`);
  console.log('  Website     start the frontend: cd ../frontend && npm run dev → http://localhost:5173');
  console.log(`  Admin       /admin    password: ${ADMIN_PASSWORD}`);
  console.log('  Studio      /studio   (public live view)');
  console.log('  Captains    /captain');
  for (const { team, password } of creds) {
    const bot = args.has('--bots') && team.id !== creds[0].team.id ? '  (bot)' : '';
    console.log(`              ${team.name.padEnd(20)} ${password}${bot}`);
  }
  console.log('\n  Undo a wrong bid / sale and Reset auction are in the admin Control Room.');
  console.log('  npm run demo -- --fresh   wipes the demo   ·   --bots   adds computer captains');
  console.log(`${line}\n  Press Ctrl+C to stop.\n`);
} catch (err) {
  console.error('Demo failed to start:', err.message);
}

const stop = async () => {
  server.kill();
  await mongo.stop({ doCleanup: false });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
