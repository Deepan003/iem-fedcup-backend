import { Settings, POSITIONS } from './models.js';

export const DEFAULTS = {
  auction: {
    currency: 'pts',
    // Decimal places for money (0, 1 or 2). Amounts are stored as whole numbers of the smallest
    // unit (e.g. 2.1 with 1 decimal is stored as 21), so all auction maths stays exact.
    decimals: 0,
    teamBudget: 1000,
    defaultBasePrice: 20,
    tiers: [
      { name: 'Icon', basePrice: 100, color: '#f5c542' },
      { name: 'Gold', basePrice: 50, color: '#e0a526' },
      { name: 'Silver', basePrice: 30, color: '#b8c2cc' },
      { name: 'Bronze', basePrice: 20, color: '#c27c4a' },
    ],
    increments: [
      { upTo: 100, step: 5 },
      { upTo: 300, step: 10 },
      { upTo: null, step: 20 },
    ],
    positionOrder: ['Defender', 'Midfielder', 'Forward', 'Goalkeeper'],
    minSquadSize: 11,
    maxSquadSize: 17, // whole squad: captain + retained + bought
    maxRetained: 2, // players a team may retain (captain not counted)
    captainInSquad: true, // the captain takes one squad slot
    reservePerSlot: 20,
    positionLimits: {
      Goalkeeper: { min: 1, max: 2 },
      Defender: { min: 0, max: null },
      Midfielder: { min: 0, max: null },
      Forward: { min: 0, max: null },
    },
    timerEnabled: true,
    revealSec: 5,
    autoOpen: false,
    firstBidSec: 30,
    bidSec: 15,
    graceMs: 400,
    requireConfirm: true, // a sale is final only when the auctioneer clicks Confirm
    gkRule: true, // a team that has a goalkeeper can't bid for another until every team has one
    resumeMinSec: 5,
  },
  captainView: {
    biddingEnabled: true,
    showOtherPurses: true,
    showOtherSquads: true,
    showOtherPrices: true,
    showBidHistory: true,
    showUpcoming: true,
    upcomingCount: 5,
    showSquadBuilder: true,
  },
  studio: {
    live: false, // shows the "Auction is LIVE" banner on the landing page
    title: 'IEM FED Cup Auction',
    subtitle: '',
    startsAt: null,
    showPurses: true,
    showSquads: true,
    showUpcoming: true,
    upcomingCount: 5,
    showViewerCount: false,
  },
  portal: {
    mode: 'public', // public | code | off
    cards: false, // player cards download on the players page (switch on after the auction)
  },
  // Studio screensavers: shown when paused / between players / on demand.
  screens: {
    enabled: true,
    onPause: true,
    betweenLots: false,
    forceOn: false, // "Show now" from the control room
    show: '', // one chosen screen (e.g. "top3", "r-<teamId>", "c-0"); empty = rotate through the ticked ones
    slideSeconds: 8,
    shuffle: false,
    items: ['retained', 'top3', 'record', 'war', 'teams', 'teamsAll', 'custom'],
    custom: [], // [{ title, text }]
  },
  audio: {
    enabled: true, // master switch for every screen
    studioSound: true, // studio / projector plays sound
    captainSound: true, // captains hear bids, timer and outbid alerts
    voice: true, // announcer voice
    voiceGender: 'male', // male | female
    voiceAccent: 'in', // in | gb | us | au | auto
    screenSfx: true, // effects and music on the studio screensavers
    voiceRate: 100, // % speaking speed
    callBids: 'every', // every | leader | off
    goingOnceTwice: true,
    music: true,
    introSeconds: 25, // intro music plays this long, then fades out (0 = whole track)
    crowd: true, // stadium crowd ambience and cheers
    sfxVolume: 80,
    musicVolume: 45,
    voiceVolume: 100,
  },
};

/* ---------------------------- validation ---------------------------- */

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const bad = (msg) => {
  throw new ValidationError(msg);
};

const int = (v, name, { min = 0, max = 1e9, nullable = false } = {}) => {
  if (nullable && (v === null || v === '' || v === undefined)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be a whole number between ${min} and ${max}`);
  return n;
};
const bool = (v) => v === true || v === 'true';
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);

function cleanAuction(a) {
  const out = {
    currency: str(a.currency, 20) || 'pts',
    // Only changed through POST /admin/money/decimals (which rescales stored amounts).
    decimals: [0, 1, 2].includes(Number(a.decimals)) ? Number(a.decimals) : 0,
    teamBudget: int(a.teamBudget, 'Team budget', { min: 1 }),
    defaultBasePrice: int(a.defaultBasePrice, 'Default base price', { min: 1 }),
    tiers: (a.tiers || []).map((t, i) => ({
      name: str(t.name, 30) || bad(`Tier ${i + 1} needs a name`),
      basePrice: int(t.basePrice, `Base price for tier ${t.name}`, { min: 1 }),
      color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : '#888888',
    })),
    increments: (a.increments || []).map((s, i) => ({
      upTo: int(s.upTo, `Slab ${i + 1} "up to"`, { min: 1, nullable: true }),
      step: int(s.step, `Slab ${i + 1} step`, { min: 1 }),
    })),
    positionOrder: (a.positionOrder || []).filter((p) => POSITIONS.includes(p)),
    minSquadSize: int(a.minSquadSize, 'Minimum squad size', { min: 1, max: 40 }),
    maxSquadSize: int(a.maxSquadSize, 'Maximum squad size', { min: 1, max: 40 }),
    maxRetained: a.maxRetained == null ? 2 : int(a.maxRetained, 'Max retained players', { min: 0, max: 20 }),
    captainInSquad: a.captainInSquad === undefined ? true : bool(a.captainInSquad),
    reservePerSlot: int(a.reservePerSlot, 'Reserve per slot', { min: 0 }),
    positionLimits: {},
    timerEnabled: bool(a.timerEnabled),
    revealSec: int(a.revealSec, 'Reveal time', { min: 0, max: 120 }),
    autoOpen: bool(a.autoOpen),
    firstBidSec: int(a.firstBidSec, 'First bid timer', { min: 3, max: 600 }),
    bidSec: int(a.bidSec, 'Bid timer', { min: 3, max: 600 }),
    graceMs: int(a.graceMs, 'Grace window', { min: 0, max: 3000 }),
    requireConfirm: a.requireConfirm === undefined ? true : bool(a.requireConfirm),
    gkRule: a.gkRule === undefined ? true : bool(a.gkRule),
    resumeMinSec: int(a.resumeMinSec, 'Minimum time after resume', { min: 0, max: 120 }),
  };
  if (out.minSquadSize > out.maxSquadSize) bad('Minimum squad size cannot exceed the maximum');
  if (!out.increments.length) bad('Add at least one increment slab');
  const ups = out.increments.map((s) => s.upTo);
  if (ups.slice(0, -1).some((u) => u == null) || ups.at(-1) !== null) {
    bad('Increment slabs must end with one open-ended slab (leave "up to" empty on the last one)');
  }
  for (let i = 1; i < ups.length - 1; i += 1) if (ups[i] <= ups[i - 1]) bad('Increment slabs must be in ascending order');
  for (const p of POSITIONS) if (!out.positionOrder.includes(p)) out.positionOrder.push(p);
  let minTotal = 0;
  for (const p of POSITIONS) {
    const l = a.positionLimits?.[p] || {};
    const min = int(l.min ?? 0, `${p} minimum`, { min: 0, max: 40 });
    const max = int(l.max, `${p} maximum`, { min: 0, max: 40, nullable: true });
    if (max != null && min > max) bad(`${p}: minimum cannot exceed maximum`);
    out.positionLimits[p] = { min, max };
    minTotal += min;
  }
  if (minTotal > out.maxSquadSize) bad('Position minimums add up to more than the maximum squad size');
  return out;
}

function cleanCaptainView(c) {
  return {
    biddingEnabled: bool(c.biddingEnabled),
    showOtherPurses: bool(c.showOtherPurses),
    showOtherSquads: bool(c.showOtherSquads),
    showOtherPrices: bool(c.showOtherPrices),
    showBidHistory: bool(c.showBidHistory),
    showUpcoming: bool(c.showUpcoming),
    upcomingCount: int(c.upcomingCount, 'Upcoming count', { min: 0, max: 50 }),
    showSquadBuilder: bool(c.showSquadBuilder),
  };
}

function cleanStudio(s) {
  const startsAt = s.startsAt ? new Date(s.startsAt) : null;
  return {
    live: bool(s.live),
    title: str(s.title, 80) || DEFAULTS.studio.title,
    subtitle: str(s.subtitle, 160),
    startsAt: startsAt && !Number.isNaN(startsAt.getTime()) ? startsAt.toISOString() : null,
    showPurses: bool(s.showPurses),
    showSquads: bool(s.showSquads),
    showUpcoming: bool(s.showUpcoming),
    upcomingCount: int(s.upcomingCount, 'Upcoming count', { min: 0, max: 50 }),
    showViewerCount: bool(s.showViewerCount),
  };
}

function cleanPortal(p) {
  const mode = ['public', 'code', 'off'].includes(p.mode) ? p.mode : 'public';
  return { mode, cards: p.cards === undefined ? false : bool(p.cards) };
}

function cleanAudio(a) {
  const d = DEFAULTS.audio;
  const pct = (v, name, def, min = 0, max = 100) => (v === undefined || v === '' ? def : int(v, name, { min, max }));
  const flag = (k) => (a[k] === undefined ? d[k] : bool(a[k]));
  return {
    enabled: flag('enabled'),
    studioSound: flag('studioSound'),
    captainSound: flag('captainSound'),
    voice: flag('voice'),
    voiceGender: a.voiceGender === 'female' ? 'female' : 'male',
    voiceAccent: ['in', 'gb', 'us', 'au', 'auto'].includes(a.voiceAccent) ? a.voiceAccent : d.voiceAccent,
    screenSfx: flag('screenSfx'),
    soundCheck: Number.isFinite(Number(a.soundCheck)) ? Math.max(0, Math.floor(Number(a.soundCheck))) : 0,
    voiceRate: pct(a.voiceRate, 'Voice speed', d.voiceRate, 60, 140),
    callBids: ['every', 'leader', 'off'].includes(a.callBids) ? a.callBids : d.callBids,
    goingOnceTwice: flag('goingOnceTwice'),
    music: flag('music'),
    introSeconds: pct(a.introSeconds, 'Intro music length', d.introSeconds, 0, 600),
    crowd: flag('crowd'),
    sfxVolume: pct(a.sfxVolume, 'Effects volume', d.sfxVolume),
    musicVolume: pct(a.musicVolume, 'Music volume', d.musicVolume),
    voiceVolume: pct(a.voiceVolume, 'Voice volume', d.voiceVolume),
  };
}

export const SCREEN_ITEMS = ['retained', 'top3', 'record', 'war', 'teams', 'teamsAll', 'custom'];

function cleanScreens(s) {
  const d = DEFAULTS.screens;
  const flag = (k) => (s[k] === undefined ? d[k] : bool(s[k]));
  const items = (Array.isArray(s.items) ? s.items : d.items).filter((x, i, arr) => SCREEN_ITEMS.includes(x) && arr.indexOf(x) === i);
  const custom = (Array.isArray(s.custom) ? s.custom : []).slice(0, 12)
    .map((c) => ({ title: str(c?.title, 80), text: str(c?.text, 400) }))
    .filter((c) => c.title || c.text);
  return {
    enabled: flag('enabled'),
    onPause: flag('onPause'),
    betweenLots: flag('betweenLots'),
    forceOn: flag('forceOn'),
    show: /^[\w-]{0,60}$/.test(String(s.show ?? '')) ? String(s.show ?? '') : '',
    slideSeconds: s.slideSeconds === undefined ? d.slideSeconds : int(s.slideSeconds, 'Slide time', { min: 3, max: 60 }),
    shuffle: flag('shuffle'),
    items,
    custom,
  };
}

export const SECTION_CLEANERS = {
  auction: cleanAuction,
  captainView: cleanCaptainView,
  studio: cleanStudio,
  portal: cleanPortal,
  audio: cleanAudio,
  screens: cleanScreens,
};

/** Music slots the admin can upload: intro (auction start), bed (background loop), sold (sting). */
export const AUDIO_SLOTS = ['intro', 'bed', 'sold', 'bid', 'newPlayer', 'hammer', 'record', 'unsold', 'end', 'screens', 'screensRetained', 'screensTop', 'screensReplay', 'screensTeams'];

/* ------------------------------ access ------------------------------ */

export async function getSettingsDoc() {
  return (await Settings.findById('main')) ?? Settings.create({ _id: 'main' });
}

/** Settings sections merged over defaults (stored values win). */
export function resolveSections(doc) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = { ...structuredClone(DEFAULTS[key]), ...(doc?.[key] || {}) };
  }
  out.auction.positionLimits = { ...DEFAULTS.auction.positionLimits, ...(doc?.auction?.positionLimits || {}) };
  return out;
}

/** Shape expected by AuctionEngine. */
export function toEngineSettings({ auction, captainView }) {
  return {
    tiers: auction.tiers,
    defaultBasePrice: auction.defaultBasePrice,
    increments: auction.increments,
    positionOrder: auction.positionOrder,
    minSquadSize: auction.minSquadSize,
    maxSquadSize: auction.maxSquadSize,
    reservePerSlot: auction.reservePerSlot,
    positionLimits: auction.positionLimits,
    timerEnabled: auction.timerEnabled,
    firstBidMs: auction.firstBidSec * 1000,
    bidMs: auction.bidSec * 1000,
    graceMs: auction.graceMs,
    requireConfirm: auction.requireConfirm,
    resumeMinMs: auction.resumeMinSec * 1000,
    captainBiddingEnabled: captainView.biddingEnabled,
    gkRule: auction.gkRule !== false,
    captainInSquad: auction.captainInSquad !== false,
  };
}
