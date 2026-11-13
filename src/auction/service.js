import {
  AuctionEngine, AuctionError, initialState, nextBidAmount, isOpenPhase,
} from './engine.js';
import {
  Player, Team, Bid, AuditLog, AuctionState,
} from '../models.js';
import { getSettingsDoc, resolveSections, toEngineSettings } from '../settings.js';
import { urlFor } from '../integrations/storage.js';

const ADMIN_ACTIONS = {
  start: (e) => e.start(),
  end: (e) => e.end(),
  setMode: (e, a) => e.setMode(a.mode),
  loadLot: (e, a) => e.loadLot(a.playerId || undefined),
  openBidding: (e) => e.openBidding(),
  pause: (e) => e.pause(),
  resume: (e) => e.resume(),
  extend: (e, a) => e.extend(a.seconds ?? 10),
  hammerNow: (e) => e.hammerNow(),
  closeBidding: (e) => e.closeBidding(),
  reopenBidding: (e, a) => e.reopenBidding(a.seconds),
  confirmSale: (e) => e.confirmSale(),
  markUnsold: (e) => e.markUnsold(),
  withdrawLot: (e) => e.withdrawLot(),
  manualSale: (e, a) => e.manualSale({ teamId: a.teamId, amount: Number(a.amount), force: !!a.force }),
  proxyBid: (e, a) => e.bid({
    teamId: a.teamId, amount: Number(a.amount), lotSeq: a.lotSeq ?? null, source: 'admin',
  }),
  undoLastSale: (e) => e.undoLastSale(),
  undoLastBid: (e) => e.undoLastBid(),
  startUnsoldRound: (e) => e.startUnsoldRound(),
};

const toId = (v) => (v ? String(v) : null);
const emptyBatch = () => ({
  players: new Map(), bids: [], logs: [], state: null,
});

function playerToEngine(p) {
  return {
    id: String(p._id),
    name: p.name,
    position: p.position,
    tier: p.tier || '',
    department: p.department || '',
    isCaptain: !!p.isCaptain,
    year: p.year || '',
    basePrice: p.basePrice ?? null,
    order: p.order ?? 0,
    status: p.status,
    teamId: toId(p.teamId),
    price: p.price ?? null,
    soldAt: p.soldAt ? new Date(p.soldAt).getTime() : null,
    lotSeq: p.lotSeq ?? null,
    photoKey: p.photoKey || '',
    thumbKey: p.thumbKey || '',
    attributes: p.attributes || {},
  };
}

/** Logo framing for clients: null when untouched so payloads stay small. */
export function fitOut(f) {
  if (!f) return null;
  const scale = Number(f.scale) || 1;
  const x = Number(f.x) || 0;
  const y = Number(f.y) || 0;
  return scale === 1 && x === 0 && y === 0 ? null : { scale, x, y };
}

function teamToEngine(t, sections) {
  return {
    id: String(t._id),
    name: t.name,
    shortName: t.shortName || t.name.slice(0, 3).toUpperCase(),
    color: t.color,
    logoKey: t.logoKey || '',
    logoFit: fitOut(t.logoFit),
    captainName: t.captainName || '',
    captainPhotoKey: t.captainPhotoKey || '',
    budget: t.budget ?? sections.auction.teamBudget,
    penalty: (t.penalties || []).reduce((s, p) => s + (p.amount || 0), 0),
    penalties: (t.penalties || []).map((p) => ({
      id: String(p._id), amount: p.amount, remark: p.remark || '', at: p.at ? new Date(p.at).getTime() : null,
    })),
    frozen: !!t.frozen,
    order: t.order ?? 0,
  };
}

export class AuctionService {
  constructor() {
    this.io = null;
    this.engine = null;
    this.sections = null;
    this.pending = emptyBatch();
    this.flushing = null;
    this.timer = null;
    this.revealTimer = null;
    this.backupTick = null;
  }

  attach(io) {
    this.io = io;
  }

  async init() {
    const { sections, data } = await this.#load();
    const saved = await AuctionState.findById('main').lean();
    this.sections = sections;
    this.dataV = Date.now(); // bumps whenever teams/players/settings/photos change
    this.engine = new AuctionEngine({ ...data, state: saved?.state });
    this.engine.recoverAfterRestart();
    this.engine.drainDirty();
    this.#persist({ players: [], bids: [], logs: [] });
    this.#schedule();
    this.backupTick = setInterval(() => this.#tick(), 1000);
    this.backupTick.unref();
  }

  async #load() {
    const doc = await getSettingsDoc();
    const sections = resolveSections(doc.toObject());
    const [teams, players] = await Promise.all([
      Team.find().sort({ order: 1, name: 1 }).lean(),
      Player.find().lean(),
    ]);
    return {
      sections,
      data: {
        settings: toEngineSettings(sections),
        teams: teams.map((t) => teamToEngine(t, sections)),
        players: players.map(playerToEngine),
      },
    };
  }

  /** Wait until every pending DB write has finished. */
  async drain() {
    while (this.flushing || this.#hasPending()) {
      this.#kick();
      // eslint-disable-next-line no-await-in-loop
      await this.flushing;
    }
  }

  /** Re-read teams/players/settings from the DB (after admin edits) without losing live state. */
  async reload() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await this.drain();
      const version = this.engine.state.version;
      // eslint-disable-next-line no-await-in-loop
      const { sections, data } = await this.#load();
      if (version === this.engine.state.version) {
        this.sections = sections;
        this.dataV = Date.now();
        this.engine.setData(data);
        this.#schedule();
        this.broadcastFull();
        return;
      }
    }
    throw new Error('The auction is busy, please try again');
  }

  isOnBlock(playerId) {
    const lot = this.engine.state.lot;
    return !!lot && lot.playerId === String(playerId) && isOpenPhase(lot.phase);
  }

  isBiddingLive() {
    return this.engine.state.lot?.phase === 'bidding';
  }

  /** Dry-run reset: every sold/unsold player goes back to the pool, bids and lot history are cleared. */
  async resetAuction() {
    if (this.engine.state.status === 'live' && this.engine.state.lot && isOpenPhase(this.engine.state.lot.phase)) {
      throw new AuctionError('LOT_IN_PROGRESS');
    }
    await this.drain();
    await Player.updateMany(
      { status: { $in: ['sold', 'unsold'] } },
      { $set: { status: 'available', teamId: null, price: null, soldAt: null, lotSeq: null } },
    );
    await Bid.deleteMany({});
    this.engine.state = initialState();
    await AuctionState.updateOne({ _id: 'main' }, { $set: { state: this.engine.state } }, { upsert: true });
    await AuditLog.create({ type: 'reset', actor: 'admin' });
    await this.reload();
  }

  /* ------------------------------ actions ----------------------------- */

  adminAction(name, args = {}) {
    const fn = ADMIN_ACTIONS[name];
    if (!fn) return { ok: false, code: 'UNKNOWN_ACTION' };
    return this.#run(() => fn(this.engine, args), { actor: 'admin', action: name, args });
  }

  captainBid(teamId, { lotSeq, amount } = {}) {
    return this.#run(
      () => this.engine.bid({
        teamId, amount: Number(amount), lotSeq: Number(lotSeq), source: 'captain',
      }),
      {
        actor: `captain:${teamId}`, action: 'bid', args: { lotSeq, amount }, logRejects: true,
      },
    );
  }

  #run(fn, meta) {
    let events;
    try {
      events = fn();
    } catch (err) {
      if (err instanceof AuctionError) {
        if (meta.logRejects) {
          this.#persist({
            players: [],
            bids: [],
            logs: [{ type: 'bid_rejected', actor: meta.actor, data: { ...meta.args, code: err.code } }],
            stateless: true,
          });
        }
        return {
          ok: false, code: err.code, details: err.details, lot: this.#lotView(false), v: this.engine.state.version,
        };
      }
      throw err;
    }
    this.#afterChange(events, meta);
    return { ok: true, v: this.engine.state.version, lot: this.#lotView(false) };
  }

  #tick() {
    if (!this.engine) return;
    const events = this.engine.tick();
    if (events.length) this.#afterChange(events, { actor: 'timer', action: 'hammer' });
    else this.#schedule();
  }

  #afterChange(events, meta) {
    const st = this.engine.state;
    const bids = [];
    const logs = [];
    for (const ev of events) {
      if (ev.type === 'bid') {
        bids.push({
          lotSeq: ev.seq, round: st.round, playerId: ev.playerId, teamId: ev.teamId, amount: ev.amount, source: ev.source, at: new Date(ev.at),
        });
      } else {
        logs.push({ type: ev.type, actor: meta.actor, data: { ...ev, args: meta.args } });
      }
    }
    const players = this.engine.drainDirty().map((id) => ({ ...this.engine.players.get(id) }));
    this.#persist({ players, bids, logs });
    this.#schedule();

    if (events.some((ev) => ev.type === 'lot')) this.#scheduleAutoOpen();

    if (events.length && events.every((ev) => ev.type === 'bid')) this.#broadcastBid();
    else this.broadcastFull();
  }

  /**
   * Queue changes for MongoDB. Writes are coalesced: while one batch is in flight, new changes
   * pile up and go out together in the next batch, and only the newest state snapshot is written.
   * So the DB is never more than ~one round-trip behind, however fast bids arrive.
   */
  #persist({
    players, bids, logs, stateless = false,
  }) {
    for (const p of players) this.pending.players.set(p.id, p);
    this.pending.bids.push(...bids);
    this.pending.logs.push(...logs);
    if (!stateless) this.pending.state = structuredClone(this.engine.state);
    this.#kick();
  }

  #hasPending() {
    const b = this.pending;
    return b.players.size > 0 || b.bids.length > 0 || b.logs.length > 0 || b.state !== null;
  }

  #kick() {
    if (this.flushing || !this.#hasPending()) return;
    this.flushing = this.#flushLoop().finally(() => {
      this.flushing = null;
    });
  }

  async #flushLoop() {
    while (this.#hasPending()) {
      const batch = this.pending;
      this.pending = emptyBatch();
      const started = Date.now();
      try {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all([
          batch.players.size && Player.bulkWrite([...batch.players.values()].map((p) => ({
            updateOne: {
              filter: { _id: p.id },
              update: {
                $set: {
                  status: p.status,
                  teamId: p.teamId,
                  price: p.price ?? null,
                  soldAt: p.soldAt ? new Date(p.soldAt) : null,
                  lotSeq: p.lotSeq ?? null,
                },
              },
            },
          })), { ordered: false }),
          batch.bids.length && Bid.insertMany(batch.bids, { ordered: false }),
          batch.logs.length && AuditLog.insertMany(batch.logs, { ordered: false }),
          batch.state && AuctionState.updateOne({ _id: 'main' }, { $set: { state: batch.state } }, { upsert: true }),
        ]);
        if (process.env.DEBUG_PERSIST) {
          console.log(`[persist] v${batch.state?.version ?? '-'} players=${batch.players.size} bids=${batch.bids.length} logs=${batch.logs.length} ${Date.now() - started}ms`);
        }
      } catch (err) {
        console.error('[persist] failed, retrying in 1s:', err.message);
        // Put the batch back in front of anything newer and retry.
        for (const [id, p] of batch.players) if (!this.pending.players.has(id)) this.pending.players.set(id, p);
        this.pending.bids.unshift(...batch.bids);
        this.pending.logs.unshift(...batch.logs);
        this.pending.state ??= batch.state;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 1000); });
      }
    }
  }

  #schedule() {
    clearTimeout(this.timer);
    const st = this.engine.state;
    const lot = st.lot;
    if (st.status !== 'live' || st.paused || !lot || lot.phase !== 'bidding' || lot.endsAt == null) return;
    const delay = Math.max(0, lot.endsAt + this.engine.settings.graceMs - Date.now()) + 5;
    this.timer = setTimeout(() => this.#tick(), delay);
  }

  #scheduleAutoOpen() {
    clearTimeout(this.revealTimer);
    const a = this.sections.auction;
    if (!a.autoOpen) return;
    const seq = this.engine.state.lot?.seq;
    this.revealTimer = setTimeout(() => {
      const st = this.engine.state;
      if (st.status === 'live' && !st.paused && st.lot?.seq === seq && st.lot.phase === 'reveal') {
        this.#run(() => this.engine.openBidding(), { actor: 'auto', action: 'openBidding' });
      }
    }, a.revealSec * 1000);
  }

  /* ------------------------------ views ------------------------------- */

  publicPlayer(p) {
    if (!p) return null;
    const tier = this.engine.tierOf(p);
    return {
      id: p.id,
      name: p.name,
      position: p.position,
      tier: tier?.name || p.tier,
      department: p.department,
      isCaptain: !!p.isCaptain,
      tierColor: tier?.color || null,
      year: p.year,
      basePrice: this.engine.basePriceFor(p),
      photoUrl: urlFor(p.photoKey),
      thumbUrl: urlFor(p.thumbKey) || urlFor(p.photoKey),
      attributes: p.attributes,
      status: p.status,
    };
  }

  #lotView(withPlayer) {
    const lot = this.engine.state.lot;
    if (!lot) return null;
    const out = {
      seq: lot.seq,
      playerId: lot.playerId,
      phase: lot.phase,
      base: lot.base,
      amount: lot.amount,
      leaderId: lot.leaderId,
      bidCount: lot.bidCount,
      endsAt: lot.endsAt,
      remainingMs: lot.remainingMs,
      nextAmount: nextBidAmount(lot, this.engine.settings.increments),
      history: lot.history,
    };
    if (withPlayer) out.player = this.publicPlayer(this.engine.players.get(lot.playerId));
    return out;
  }

  /**
   * Builds the state for one audience. Visibility switches from the admin panel are enforced
   * here, on the server, so hidden data never reaches the browser.
   * @param {{role: 'public'|'captain'|'admin', teamId?: string}} view
   */
  stateFor({ role, teamId }) {
    const e = this.engine;
    const st = e.state;
    const { auction, captainView: cv, studio: sv } = this.sections;
    const isAdmin = role === 'admin';
    const isCaptain = role === 'captain';
    const lot = this.#lotView(true);
    const lotOpen = lot && isOpenPhase(lot.phase);
    const lotPlayer = lotOpen ? e.players.get(lot.playerId) : null;

    const showPurses = isAdmin || (isCaptain ? cv.showOtherPurses : sv.showPurses);
    const showSquads = isAdmin || (isCaptain ? cv.showOtherSquads : sv.showSquads);
    const showPrices = isAdmin || (isCaptain ? cv.showOtherPrices : sv.showSquads);
    const showHistory = isAdmin || (isCaptain ? cv.showBidHistory : true);

    const teams = [...e.teams.values()]
      .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map((t) => {
        const own = isCaptain && t.id === teamId;
        const f = e.finance(t.id, lotPlayer);
        const out = {
          id: t.id,
          name: t.name,
          shortName: t.shortName,
          color: t.color,
          logoUrl: urlFor(t.logoKey),
          logoFit: t.logoFit,
          captainName: t.captainName,
          captainPhotoUrl: urlFor(t.captainPhotoKey),
          frozen: t.frozen,
          count: f.count,
        };
        if (own || showPurses) {
          Object.assign(out, {
            budget: t.budget, purse: f.purse, spent: f.spent, penalty: f.penalty, penalties: t.penalties, slotsLeft: f.slotsLeft, byPosition: f.byPosition, maxBid: f.maxBid,
          });
        }
        if (own || showSquads) {
          out.squad = e.squadOf(t.id).map((p) => ({
            id: p.id,
            name: p.name,
            position: p.position,
            tier: p.tier,
            year: p.year,
            department: p.department,
            isCaptain: !!p.isCaptain,
            retained: p.status === 'retained',
            thumbUrl: urlFor(p.thumbKey) || urlFor(p.photoKey),
            ...(own || showPrices ? { price: p.price } : {}),
          }));
        }
        return out;
      });

    let upcomingCount = 0;
    if (isAdmin) upcomingCount = Infinity;
    else if (isCaptain) upcomingCount = cv.showUpcoming ? cv.upcomingCount : 0;
    else upcomingCount = sv.showUpcoming ? sv.upcomingCount : 0;

    const all = [...e.players.values()];
    const sold = all.filter((p) => p.status === 'sold');
    const stats = {
      total: all.filter((p) => p.status !== 'withheld').length,
      sold: sold.length,
      unsold: all.filter((p) => p.status === 'unsold').length,
      available: all.filter((p) => p.status === 'available').length,
      retained: all.filter((p) => p.status === 'retained').length,
      totalSpent: sold.reduce((s, p) => s + (p.price || 0), 0),
      topBuys: [...sold].sort((a, b) => b.price - a.price).slice(0, 5)
        .map((p) => ({ playerId: p.id, name: p.name, teamId: p.teamId, price: p.price })),
    };
    // Record holders for live broadcast indicators (overall, per position, per tier).
    stats.records = { overall: null, byPosition: {}, byTier: {} };
    for (const p of sold) {
      const rec = { price: p.price, name: p.name, teamId: p.teamId, playerId: p.id };
      const R = stats.records;
      if (!R.overall || p.price > R.overall.price) R.overall = rec;
      if (!R.byPosition[p.position] || p.price > R.byPosition[p.position].price) R.byPosition[p.position] = rec;
      const tn = this.engine.tierOf(p)?.name || p.tier;
      if (tn && (!R.byTier[tn] || p.price > R.byTier[tn].price)) R.byTier[tn] = rec;
    }

    const state = {
      v: st.version,
      dataV: this.dataV,
      serverNow: Date.now(),
      status: st.status,
      paused: st.paused,
      mode: st.mode,
      round: st.round,
      currency: auction.currency,
      timerEnabled: auction.timerEnabled,
      lot: lot && !showHistory ? { ...lot, history: [] } : lot,
      teams,
      recentSales: st.recentSales.slice(0, 10).map((s) => ({
        ...s, player: this.publicPlayer(e.players.get(s.playerId)),
      })),
      upcoming: e.upcoming(upcomingCount).map((p) => this.publicPlayer(p)),
      stats,
      studio: {
        title: sv.title, subtitle: sv.subtitle, live: sv.live, startsAt: sv.startsAt,
      },
    };

    if (isCaptain) {
      state.captainView = cv;
      state.me = {
        teamId,
        blockReason: lotPlayer ? e.eligibility(teamId, lotPlayer, 0) : null,
        maxBidForLot: lotPlayer ? e.finance(teamId, lotPlayer).maxBid : null,
      };
    }
    if (isAdmin) {
      state.unsold = all.filter((p) => p.status === 'unsold').map((p) => this.publicPlayer(p));
      state.positionLimits = auction.positionLimits;
    }
    return state;
  }

  /* ---------------------------- broadcasting -------------------------- */

  #broadcastBid() {
    if (!this.io) return;
    const lot = this.#lotView(false);
    const msg = { v: this.engine.state.version, lot };
    this.io.to('public').to('admin').emit('bid', msg);
    const hidden = !this.sections.captainView.showBidHistory;
    for (const id of this.engine.teams.keys()) {
      this.io.to(`team:${id}`).emit('bid', hidden ? { ...msg, lot: { ...lot, history: [] } } : msg);
    }
  }

  broadcastFull() {
    if (!this.io || !this.engine) return;
    this.io.to('public').emit('state', this.stateFor({ role: 'public' }));
    this.io.to('admin').emit('state', this.stateFor({ role: 'admin' }));
    for (const id of this.engine.teams.keys()) {
      this.io.to(`team:${id}`).emit('state', this.stateFor({ role: 'captain', teamId: id }));
    }
  }

  /** Log out every device of a team (after its password is regenerated). */
  kickTeam(teamId) {
    this.io?.in(`team:${teamId}`).disconnectSockets(true);
  }

  kickAdmins() {
    this.io?.in('admin').disconnectSockets(true);
  }
}

export const auctionService = new AuctionService();
