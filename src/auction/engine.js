/**
 * Pure, synchronous auction state machine.
 *
 * Every mutation runs to completion before the next one starts (Node is single
 * threaded and nothing here awaits), so two bids can never interleave. The
 * service layer around this class handles timers, persistence and broadcasting.
 *
 * All money values are integers in the auction's unit (points / lakhs / …).
 */

export class AuctionError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.code = code;
    this.details = details;
  }
}

const fail = (code, details) => {
  throw new AuctionError(code, details);
};

export const SQUAD_STATUSES = new Set(['sold', 'retained']);
const AUCTIONABLE = new Set(['available', 'unsold']);
const HISTORY_LIMIT = 12;
const RECENT_SALES_LIMIT = 20;

/**
 * Lot phases: reveal → bidding → awaiting (timer ended, waiting for the auctioneer) → sold | unsold.
 * With requireConfirm on, nothing is final until the auctioneer confirms.
 */
export const OPEN_PHASES = new Set(['reveal', 'bidding', 'awaiting']);
export const isOpenPhase = (phase) => OPEN_PHASES.has(phase);

export function initialState() {
  return {
    status: 'idle', // idle | live | ended
    paused: false,
    mode: 'online', // online | manual
    round: 1,
    lotCounter: 0,
    lot: null,
    recentSales: [],
    version: 0,
  };
}

/** Step size for the current price, from ascending slabs like [{upTo:100,step:5},{upTo:null,step:20}]. */
export function stepFor(amount, slabs) {
  for (const s of slabs) {
    if (s.upTo == null || amount < s.upTo) return s.step;
  }
  return slabs[slabs.length - 1].step;
}

export function nextBidAmount(lot, slabs) {
  if (lot.amount == null) return lot.base;
  return lot.amount + stepFor(lot.amount, slabs);
}

export class AuctionEngine {
  /**
   * @param {object} opts
   * @param {object} opts.settings  engine settings (see toEngineSettings in models/Settings.js)
   * @param {Array}  opts.teams     [{id, name, budget, frozen, ...}]
   * @param {Array}  opts.players   [{id, name, position, tier, basePrice, status, teamId, price, ...}]
   * @param {object} [opts.state]   persisted state to restore
   * @param {() => number} [opts.clock]
   */
  constructor({ settings, teams, players, state, clock = Date.now }) {
    this.clock = clock;
    this.state = state ? structuredClone(state) : initialState();
    this.dirtyPlayers = new Set();
    this.setData({ settings, teams, players });
  }

  setData({ settings, teams, players }) {
    this.settings = settings;
    this.teams = new Map(teams.map((t) => [t.id, { ...t }]));
    this.players = new Map(players.map((p) => [p.id, { ...p }]));
  }

  /* ------------------------------------------------------------------ */
  /* Derived values                                                     */
  /* ------------------------------------------------------------------ */

  squadOf(teamId) {
    const out = [];
    for (const p of this.players.values()) {
      if (p.teamId === teamId && SQUAD_STATUSES.has(p.status)) out.push(p);
    }
    return out;
  }

  basePriceFor(player) {
    if (Number.isInteger(player.basePrice) && player.basePrice > 0) return player.basePrice;
    const tier = this.tierOf(player);
    return tier ? tier.basePrice : this.settings.defaultBasePrice;
  }

  /** The configured tier for a player; matching ignores case and extra spaces ("gold " = "Gold"). */
  tierOf(player) {
    const key = String(player?.tier || '').trim().toLowerCase();
    if (!key) return null;
    return this.settings.tiers.find((t) => String(t.name).trim().toLowerCase() === key) || null;
  }

  /**
   * Money and squad numbers for a team. When `forPlayer` is given, maxBid is the most the
   * team may bid for that particular player while still being able to complete a legal squad.
   */
  finance(teamId, forPlayer = null) {
    const s = this.settings;
    const team = this.teams.get(teamId);
    const squad = this.squadOf(teamId);
    const spent = squad.reduce((sum, p) => sum + (p.price || 0), 0);
    const byPosition = {};
    for (const p of squad) byPosition[p.position] = (byPosition[p.position] || 0) + 1;

    const purse = team.budget - spent;
    const count = squad.length;
    const slotsLeft = Math.max(0, s.maxSquadSize - count);

    // Simulate owning one more player (the one on the block, or a generic one).
    const after = { ...byPosition };
    if (forPlayer) after[forPlayer.position] = (after[forPlayer.position] || 0) + 1;
    let positionNeedAfter = 0;
    for (const [pos, lim] of Object.entries(s.positionLimits)) {
      if (lim.min) positionNeedAfter += Math.max(0, lim.min - (after[pos] || 0));
    }
    const mustBuyAfter = Math.max(s.minSquadSize - (count + 1), positionNeedAfter, 0);
    const maxBid = slotsLeft > 0 ? Math.max(0, purse - mustBuyAfter * s.reservePerSlot) : 0;

    return { purse, spent, count, slotsLeft, byPosition, maxBid, mustBuyAfter };
  }

  /** Returns an error code if `teamId` may not buy `player` for `amount`, otherwise null. */
  eligibility(teamId, player, amount) {
    const team = this.teams.get(teamId);
    if (!team) return 'UNKNOWN_TEAM';
    if (team.frozen) return 'TEAM_FROZEN';
    const s = this.settings;
    const f = this.finance(teamId, player);
    if (f.slotsLeft <= 0) return 'SQUAD_FULL';
    const lim = s.positionLimits[player.position];
    if (lim?.max != null && (f.byPosition[player.position] || 0) >= lim.max) return 'POSITION_FULL';
    // After this purchase the remaining slots must still cover every position minimum.
    const slotsAfter = f.slotsLeft - 1;
    let posNeed = 0;
    for (const [pos, l] of Object.entries(s.positionLimits)) {
      const have = (f.byPosition[pos] || 0) + (pos === player.position ? 1 : 0);
      if (l.min) posNeed += Math.max(0, l.min - have);
    }
    if (posNeed > slotsAfter) return 'POSITION_SLOTS_NEEDED';
    if (amount > f.purse) return 'OVER_BUDGET';
    if (amount > f.maxBid) return 'RESERVE_REQUIRED';
    return null;
  }

  /** Auction queue: available players in position order, then manual order, then name. */
  upcoming(limit = Infinity) {
    const order = this.settings.positionOrder;
    const rank = (pos) => {
      const i = order.indexOf(pos);
      return i === -1 ? order.length : i;
    };
    const currentId = this.#lotInProgress() ? this.state.lot.playerId : null;
    return [...this.players.values()]
      .filter((p) => p.status === 'available' && p.id !== currentId)
      .sort((a, b) => rank(a.position) - rank(b.position)
        || (a.order ?? 0) - (b.order ?? 0)
        || a.name.localeCompare(b.name))
      .slice(0, limit);
  }

  /* ------------------------------------------------------------------ */
  /* Mutations                                                          */
  /* ------------------------------------------------------------------ */

  #touch(...playerIds) {
    for (const id of playerIds) this.dirtyPlayers.add(id);
    this.state.version += 1;
  }

  #lotInProgress() {
    return isOpenPhase(this.state.lot?.phase);
  }

  #requireLive() {
    if (this.state.status !== 'live') fail('NOT_LIVE');
  }

  start() {
    if (this.state.status === 'live') fail('ALREADY_LIVE');
    this.state.status = 'live';
    this.state.paused = false;
    this.#touch();
    return [{ type: 'status', status: 'live' }];
  }

  end() {
    this.#requireLive();
    if (this.#lotInProgress()) fail('LOT_IN_PROGRESS');
    this.state.status = 'ended';
    this.state.paused = false;
    this.#touch();
    return [{ type: 'status', status: 'ended' }];
  }

  setMode(mode) {
    if (!['online', 'manual'].includes(mode)) fail('INVALID_MODE');
    if (this.state.lot?.phase === 'bidding') fail('LOT_IN_PROGRESS');
    this.state.mode = mode;
    this.#touch();
    return [{ type: 'mode', mode }];
  }

  loadLot(playerId) {
    this.#requireLive();
    if (this.#lotInProgress()) fail('LOT_IN_PROGRESS');
    const id = playerId ?? this.upcoming(1)[0]?.id;
    if (!id) fail('QUEUE_EMPTY');
    const player = this.players.get(id);
    if (!player) fail('UNKNOWN_PLAYER');
    if (!AUCTIONABLE.has(player.status)) fail('PLAYER_NOT_AVAILABLE');

    const seq = ++this.state.lotCounter;
    this.state.lot = {
      seq,
      playerId: id,
      base: this.basePriceFor(player),
      amount: null,
      leaderId: null,
      bidCount: 0,
      phase: 'reveal',
      endsAt: null,
      remainingMs: null,
      loadedAt: this.clock(),
      history: [],
    };
    this.#touch(id);
    return [{ type: 'lot', seq, playerId: id }];
  }

  openBidding() {
    this.#requireLive();
    if (this.state.paused) fail('PAUSED');
    const lot = this.state.lot;
    if (!lot || lot.phase !== 'reveal') fail('NO_LOT_TO_OPEN');
    lot.phase = 'bidding';
    lot.endsAt = this.settings.timerEnabled ? this.clock() + this.settings.firstBidMs : null;
    this.#touch();
    return [{ type: 'open', seq: lot.seq }];
  }

  /**
   * Place a bid.
   * Captains must send exactly the next amount they were shown; anything else means their
   * view was stale and the bid is rejected (they get the fresh price back).
   * Admin (proxy/manual) bids may use any amount above the current price.
   */
  bid({ teamId, amount, lotSeq, source = 'captain' }) {
    const s = this.settings;
    const st = this.state;
    const lot = st.lot;
    const now = this.clock();

    if (st.status !== 'live') fail('NOT_LIVE');
    if (st.paused) fail('PAUSED');
    if (!lot || !isOpenPhase(lot.phase)) fail('NO_ACTIVE_LOT');
    if (lotSeq != null && lotSeq !== lot.seq) fail('STALE_LOT', { seq: lot.seq });
    if (lot.phase === 'awaiting') fail('BIDDING_CLOSED');
    if (lot.phase !== 'bidding') fail('BIDDING_NOT_OPEN');
    if (source === 'captain') {
      if (st.mode !== 'online' || !s.captainBiddingEnabled) fail('ONLINE_BIDDING_OFF');
    }
    if (lot.endsAt != null && now >= lot.endsAt + s.graceMs) fail('TIME_UP');
    if (lot.leaderId === teamId) fail('ALREADY_LEADING');
    if (!Number.isInteger(amount)) fail('INVALID_AMOUNT');

    const expected = nextBidAmount(lot, s.increments);
    if (source === 'captain') {
      if (amount !== expected) fail('STALE_AMOUNT', { expected });
    } else {
      const minimum = lot.amount == null ? lot.base : lot.amount + 1;
      if (amount < minimum) fail('INVALID_AMOUNT', { minimum });
    }

    const player = this.players.get(lot.playerId);
    const err = this.eligibility(teamId, player, amount);
    if (err) fail(err, { maxBid: this.teams.has(teamId) ? this.finance(teamId, player).maxBid : 0 });

    lot.amount = amount;
    lot.leaderId = teamId;
    lot.bidCount += 1;
    lot.history.unshift({ teamId, amount, at: now, source });
    if (lot.history.length > HISTORY_LIMIT) lot.history.length = HISTORY_LIMIT;
    if (lot.endsAt != null) lot.endsAt = Math.max(lot.endsAt, now + s.bidMs);
    this.#touch();
    return [{ type: 'bid', seq: lot.seq, teamId, amount, at: now, source, playerId: lot.playerId }];
  }

  /**
   * Called by the service timer once the countdown (plus grace) has passed.
   * With requireConfirm the lot only closes for bids and waits for the auctioneer;
   * otherwise it is sold/unsold automatically.
   */
  tick() {
    const st = this.state;
    const lot = st.lot;
    if (st.status !== 'live' || st.paused || !lot || lot.phase !== 'bidding' || lot.endsAt == null) return [];
    if (this.clock() < lot.endsAt + this.settings.graceMs) return [];
    return this.settings.requireConfirm ? this.#closeBidding('timer') : this.#hammer();
  }

  /** Admin: stop bidding now. The result still needs confirmSale / markUnsold. */
  closeBidding() {
    this.#requireLive();
    const lot = this.state.lot;
    if (!lot || lot.phase !== 'bidding') fail('NO_ACTIVE_LOT');
    return this.#closeBidding('admin');
  }

  #closeBidding(by) {
    const lot = this.state.lot;
    lot.phase = 'awaiting';
    lot.endsAt = null;
    lot.remainingMs = null;
    this.#touch();
    return [{
      type: 'closed', seq: lot.seq, by, leaderId: lot.leaderId, amount: lot.amount,
    }];
  }

  /** Admin: reopen a closed lot for more bids (e.g. a captain disputes the hammer). */
  reopenBidding(seconds) {
    this.#requireLive();
    if (this.state.paused) fail('PAUSED');
    const lot = this.state.lot;
    if (!lot || lot.phase !== 'awaiting') fail('NOT_AWAITING');
    lot.phase = 'bidding';
    const ms = seconds ? Math.round(Number(seconds) * 1000) : this.settings.bidMs;
    lot.endsAt = this.settings.timerEnabled ? this.clock() + ms : null;
    this.#touch();
    return [{ type: 'reopen', seq: lot.seq }];
  }

  /** Auctioneer confirms the sale to the current leader. This is the only way a bid becomes a sale. */
  confirmSale() {
    this.#requireLive();
    const lot = this.state.lot;
    if (!lot || !['bidding', 'awaiting'].includes(lot.phase)) fail('NO_ACTIVE_LOT');
    if (!lot.leaderId) fail('NO_BIDS');
    return this.#closeSold('auction');
  }

  /** Close the lot now with no confirmation step: sold to the leader if any, otherwise unsold. */
  hammerNow() {
    this.#requireLive();
    if (!this.#lotInProgress()) fail('NO_ACTIVE_LOT');
    return this.#hammer();
  }

  markUnsold() {
    this.#requireLive();
    if (!this.#lotInProgress()) fail('NO_ACTIVE_LOT');
    return this.#closeUnsold();
  }

  /** Admin: abandon the current lot without a result (player goes back to the queue). */
  withdrawLot() {
    if (!this.#lotInProgress()) fail('NO_ACTIVE_LOT');
    const { seq, playerId } = this.state.lot;
    this.state.lot = null;
    this.#touch(playerId);
    return [{ type: 'withdraw', seq, playerId }];
  }

  /** Manual mode: admin records the price agreed in the room. */
  manualSale({ teamId, amount, force = false }) {
    this.#requireLive();
    if (!this.#lotInProgress()) fail('NO_ACTIVE_LOT');
    if (!Number.isInteger(amount) || amount <= 0) fail('INVALID_AMOUNT');
    if (!this.teams.has(teamId)) fail('UNKNOWN_TEAM');
    const lot = this.state.lot;
    const player = this.players.get(lot.playerId);
    if (!force) {
      const err = this.eligibility(teamId, player, amount);
      if (err) fail(err, { maxBid: this.finance(teamId, player).maxBid });
    }
    lot.amount = amount;
    lot.leaderId = teamId;
    lot.history.unshift({ teamId, amount, at: this.clock(), source: 'manual' });
    return this.#closeSold(force ? 'manual-forced' : 'manual');
  }

  pause() {
    this.#requireLive();
    if (this.state.paused) fail('ALREADY_PAUSED');
    this.state.paused = true;
    const lot = this.state.lot;
    if (lot?.phase === 'bidding' && lot.endsAt != null) {
      lot.remainingMs = Math.max(0, lot.endsAt - this.clock());
      lot.endsAt = null;
    }
    this.#touch();
    return [{ type: 'pause' }];
  }

  resume() {
    this.#requireLive();
    if (!this.state.paused) fail('NOT_PAUSED');
    this.state.paused = false;
    const lot = this.state.lot;
    if (lot?.phase === 'bidding' && lot.remainingMs != null) {
      lot.endsAt = this.clock() + Math.max(lot.remainingMs, this.settings.resumeMinMs);
      lot.remainingMs = null;
    }
    this.#touch();
    return [{ type: 'resume' }];
  }

  extend(seconds) {
    const lot = this.state.lot;
    if (!lot || lot.phase !== 'bidding') fail('NO_ACTIVE_LOT');
    const ms = Math.round(Number(seconds) * 1000);
    if (!(ms > 0)) fail('INVALID_AMOUNT');
    if (this.state.paused) lot.remainingMs = (lot.remainingMs ?? 0) + ms;
    else lot.endsAt = Math.max(lot.endsAt ?? 0, this.clock()) + ms;
    this.#touch();
    return [{ type: 'extend', seq: lot.seq, ms }];
  }

  /** Admin: cancel the latest bid on the current lot (e.g. a mistaken proxy bid). */
  undoLastBid() {
    const lot = this.state.lot;
    if (!lot || !['bidding', 'awaiting'].includes(lot.phase)) fail('NO_ACTIVE_LOT');
    if (!lot.history.length || lot.bidCount === 0) fail('NOTHING_TO_UNDO');
    const removed = lot.history.shift();
    const prev = lot.history[0];
    lot.amount = prev ? prev.amount : null;
    lot.leaderId = prev ? prev.teamId : null;
    lot.bidCount -= 1;
    this.#touch();
    return [{ type: 'bid_undone', seq: lot.seq, removed }];
  }

  /** Revert the most recent sale (player returns to the queue, money returns to the team). */
  undoLastSale() {
    if (this.#lotInProgress()) fail('LOT_IN_PROGRESS');
    const last = this.state.recentSales[0];
    if (!last) fail('NOTHING_TO_UNDO');
    const p = this.players.get(last.playerId);
    if (!p || p.status !== 'sold' || p.teamId !== last.teamId) fail('NOTHING_TO_UNDO');
    p.status = 'available';
    p.teamId = null;
    p.price = null;
    p.soldAt = null;
    p.lotSeq = null;
    this.state.recentSales.shift();
    if (this.state.lot?.playerId === p.id) this.state.lot = null;
    this.#touch(p.id);
    return [{ type: 'undo', playerId: p.id, teamId: last.teamId, price: last.price }];
  }

  /** Put every unsold player back into the queue for another round. */
  startUnsoldRound() {
    if (this.#lotInProgress()) fail('LOT_IN_PROGRESS');
    const ids = [];
    for (const p of this.players.values()) {
      if (p.status === 'unsold') {
        p.status = 'available';
        ids.push(p.id);
      }
    }
    if (!ids.length) fail('NO_UNSOLD_PLAYERS');
    this.state.round += 1;
    this.#touch(...ids);
    return [{ type: 'round', round: this.state.round, count: ids.length }];
  }

  #hammer() {
    return this.state.lot.leaderId ? this.#closeSold('auction') : this.#closeUnsold();
  }

  #closeSold(via) {
    const lot = this.state.lot;
    const p = this.players.get(lot.playerId);
    const now = this.clock();
    p.status = 'sold';
    p.teamId = lot.leaderId;
    p.price = lot.amount;
    p.soldAt = now;
    p.lotSeq = lot.seq;
    lot.phase = 'sold';
    lot.endsAt = null;
    lot.remainingMs = null;
    const sale = { playerId: p.id, teamId: p.teamId, price: p.price, at: now, seq: lot.seq, via };
    this.state.recentSales.unshift(sale);
    if (this.state.recentSales.length > RECENT_SALES_LIMIT) this.state.recentSales.length = RECENT_SALES_LIMIT;
    this.#touch(p.id);
    return [{ type: 'sold', ...sale }];
  }

  #closeUnsold() {
    const lot = this.state.lot;
    const p = this.players.get(lot.playerId);
    p.status = 'unsold';
    p.teamId = null;
    p.price = null;
    lot.phase = 'unsold';
    lot.endsAt = null;
    lot.remainingMs = null;
    this.#touch(p.id);
    return [{ type: 'unsold', playerId: p.id, seq: lot.seq }];
  }

  /** Take (and clear) the set of player ids changed since the last call. */
  drainDirty() {
    const ids = [...this.dirtyPlayers];
    this.dirtyPlayers.clear();
    return ids;
  }

  /**
   * Restore after a server restart: a lot that was mid-bidding comes back paused
   * with the time it had left, so nobody loses a bid to the outage.
   */
  recoverAfterRestart() {
    const st = this.state;
    const lot = st.lot;
    if (st.status === 'live' && lot?.phase === 'bidding' && !st.paused) {
      st.paused = true;
      if (lot.endsAt != null) {
        lot.remainingMs = Math.max(this.settings.resumeMinMs, lot.endsAt - this.clock());
        lot.endsAt = null;
      }
      this.#touch();
    }
  }
}
