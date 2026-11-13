import { Settings, POSITIONS } from './models.js';

export const DEFAULTS = {
  auction: {
    currency: 'pts',
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
    maxSquadSize: 15,
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
    reservePerSlot: int(a.reservePerSlot, 'Reserve per slot', { min: 0 }),
    positionLimits: {},
    timerEnabled: bool(a.timerEnabled),
    revealSec: int(a.revealSec, 'Reveal time', { min: 0, max: 120 }),
    autoOpen: bool(a.autoOpen),
    firstBidSec: int(a.firstBidSec, 'First bid timer', { min: 3, max: 600 }),
    bidSec: int(a.bidSec, 'Bid timer', { min: 3, max: 600 }),
    graceMs: int(a.graceMs, 'Grace window', { min: 0, max: 3000 }),
    requireConfirm: a.requireConfirm === undefined ? true : bool(a.requireConfirm),
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
  return { mode };
}

export const SECTION_CLEANERS = {
  auction: cleanAuction,
  captainView: cleanCaptainView,
  studio: cleanStudio,
  portal: cleanPortal,
};

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
  };
}
