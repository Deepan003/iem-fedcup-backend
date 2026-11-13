import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuctionEngine, AuctionError, nextBidAmount } from '../src/auction/engine.js';

const settings = () => ({
  tiers: [{ name: 'Gold', basePrice: 50 }, { name: 'Silver', basePrice: 20 }],
  defaultBasePrice: 10,
  increments: [{ upTo: 100, step: 5 }, { upTo: 300, step: 10 }, { upTo: null, step: 20 }],
  positionOrder: ['Defender', 'Midfielder', 'Forward', 'Goalkeeper'],
  minSquadSize: 3,
  maxSquadSize: 4,
  reservePerSlot: 10,
  positionLimits: { Goalkeeper: { min: 1, max: 1 } },
  timerEnabled: true,
  firstBidMs: 20000,
  bidMs: 10000,
  graceMs: 400,
  resumeMinMs: 5000,
  captainBiddingEnabled: true,
  requireConfirm: false,
});

function setup(overrides = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const engine = new AuctionEngine({
    settings: { ...settings(), ...overrides },
    teams: [
      { id: 'A', name: 'Alpha', budget: 200 },
      { id: 'B', name: 'Bravo', budget: 200 },
    ],
    players: [
      { id: 'd1', name: 'Def One', position: 'Defender', tier: 'Gold', status: 'available' },
      { id: 'd2', name: 'Def Two', position: 'Defender', tier: 'Silver', status: 'available' },
      { id: 'm1', name: 'Mid One', position: 'Midfielder', status: 'available' },
      { id: 'g1', name: 'Keeper One', position: 'Goalkeeper', status: 'available' },
      { id: 'g2', name: 'Keeper Two', position: 'Goalkeeper', status: 'available' },
    ],
    clock: clock.now,
  });
  engine.start();
  return { engine, clock };
}

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuctionError) return e.code;
    throw e;
  }
  return null;
};

function openLot(engine, id) {
  engine.loadLot(id);
  engine.openBidding();
  return engine.state.lot;
}

test('increment slabs', () => {
  const s = settings().increments;
  assert.equal(nextBidAmount({ amount: null, base: 50 }, s), 50);
  assert.equal(nextBidAmount({ amount: 95, base: 50 }, s), 100);
  assert.equal(nextBidAmount({ amount: 100, base: 50 }, s), 110);
  assert.equal(nextBidAmount({ amount: 300, base: 50 }, s), 320);
});

test('queue follows position order and default lot uses tier base price', () => {
  const { engine } = setup();
  assert.deepEqual(engine.upcoming().map((p) => p.id), ['d1', 'd2', 'm1', 'g1', 'g2']);
  const lot = openLot(engine);
  assert.equal(lot.playerId, 'd1');
  assert.equal(lot.base, 50);
});

test('simultaneous bids at the same amount: first wins, second is stale', () => {
  const { engine } = setup();
  const lot = openLot(engine, 'd1');
  engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq });
  assert.equal(code(() => engine.bid({ teamId: 'B', amount: 50, lotSeq: lot.seq })), 'STALE_AMOUNT');
  engine.bid({ teamId: 'B', amount: 55, lotSeq: lot.seq });
  assert.equal(engine.state.lot.leaderId, 'B');
  assert.equal(engine.state.lot.amount, 55);
});

test('cannot outbid yourself, stale lot rejected', () => {
  const { engine } = setup();
  const lot = openLot(engine, 'd1');
  engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq });
  assert.equal(code(() => engine.bid({ teamId: 'A', amount: 55, lotSeq: lot.seq })), 'ALREADY_LEADING');
  assert.equal(code(() => engine.bid({ teamId: 'B', amount: 55, lotSeq: lot.seq - 1 })), 'STALE_LOT');
});

test('timer: bid extends, grace window accepted, then hammer sells', () => {
  const { engine, clock } = setup();
  const lot = openLot(engine, 'd1');
  clock.advance(19_000);
  engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq });
  assert.equal(engine.state.lot.endsAt, clock.now() + 10_000);
  clock.advance(10_200); // 200ms past zero, inside the 400ms grace
  engine.bid({ teamId: 'B', amount: 55, lotSeq: lot.seq });
  clock.advance(10_000 + 399);
  assert.deepEqual(engine.tick(), []);
  clock.advance(1);
  const ev = engine.tick();
  assert.equal(ev[0].type, 'sold');
  assert.equal(engine.players.get('d1').teamId, 'B');
  assert.equal(engine.finance('B').purse, 145);
});

test('bid after grace is rejected; no bids means unsold', () => {
  const { engine, clock } = setup();
  const lot = openLot(engine, 'd1');
  clock.advance(20_400);
  assert.equal(code(() => engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq })), 'TIME_UP');
  assert.equal(engine.tick()[0].type, 'unsold');
  assert.equal(engine.players.get('d1').status, 'unsold');
});

test('pause freezes remaining time, resume restores at least resumeMin', () => {
  const { engine, clock } = setup();
  const lot = openLot(engine, 'd1');
  clock.advance(18_000);
  engine.pause();
  assert.equal(engine.state.lot.remainingMs, 2000);
  assert.equal(code(() => engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq })), 'PAUSED');
  clock.advance(60_000);
  assert.deepEqual(engine.tick(), []);
  engine.resume();
  assert.equal(engine.state.lot.endsAt, clock.now() + 5000);
});

test('budget reserve: must keep money to complete minimum squad', () => {
  // budget 200, min squad 3, reserve 10/slot. After buying a 1st player 2 more are needed -> max 180.
  const { engine } = setup();
  const lot = openLot(engine, 'd2');
  assert.equal(engine.finance('A', engine.players.get('d2')).maxBid, 180);
  engine.bid({ teamId: 'B', amount: 170, lotSeq: lot.seq, source: 'admin' }); // next step is +10
  assert.equal(code(() => engine.bid({ teamId: 'A', amount: 180, lotSeq: lot.seq })), null);
  assert.equal(code(() => engine.bid({ teamId: 'B', amount: 185, lotSeq: lot.seq, source: 'admin' })), 'RESERVE_REQUIRED');
  assert.equal(code(() => engine.bid({ teamId: 'B', amount: 250, lotSeq: lot.seq, source: 'admin' })), 'OVER_BUDGET');
});

test('position limits: GK max, and a slot is kept free for the GK minimum', () => {
  const { engine } = setup();
  let lot = openLot(engine, 'g1');
  engine.bid({ teamId: 'A', amount: 10, lotSeq: lot.seq });
  engine.hammerNow();
  lot = openLot(engine, 'g2');
  assert.equal(code(() => engine.bid({ teamId: 'A', amount: 10, lotSeq: lot.seq })), 'POSITION_FULL');
  engine.withdrawLot();
  // Team B has no GK and max squad 4: it may buy 3 outfield players, the 4th slot stays for a GK.
  for (const id of ['d1', 'd2', 'm1']) {
    lot = openLot(engine, id);
    assert.equal(code(() => engine.bid({ teamId: 'B', amount: lot.base, lotSeq: lot.seq })), null, id);
    engine.hammerNow();
  }
  assert.equal(engine.finance('B').count, 3);
  engine.players.set('m2', { id: 'm2', name: 'Mid Two', position: 'Midfielder', status: 'available' });
  lot = openLot(engine, 'm2');
  assert.equal(code(() => engine.bid({ teamId: 'B', amount: lot.base, lotSeq: lot.seq })), 'POSITION_SLOTS_NEEDED');
});

test('undo last sale returns player and money', () => {
  const { engine } = setup();
  const lot = openLot(engine, 'd1');
  engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq });
  engine.hammerNow();
  assert.equal(engine.finance('A').purse, 150);
  engine.undoLastSale();
  assert.equal(engine.finance('A').purse, 200);
  assert.equal(engine.players.get('d1').status, 'available');
  assert.equal(engine.upcoming()[0].id, 'd1');
});

test('requireConfirm: timer only closes bidding; auctioneer confirms, reopens or marks unsold', () => {
  const { engine, clock } = setup({ requireConfirm: true });
  let lot = openLot(engine, 'd1');
  engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq });
  clock.advance(20_000 + 400);
  assert.equal(engine.tick()[0].type, 'closed');
  assert.equal(engine.state.lot.phase, 'awaiting');
  assert.equal(engine.players.get('d1').status, 'available', 'not sold until confirmed');
  assert.equal(code(() => engine.bid({ teamId: 'B', amount: 55, lotSeq: lot.seq })), 'BIDDING_CLOSED');
  assert.equal(code(() => engine.loadLot('d2')), 'LOT_IN_PROGRESS');

  // A captain disputes: auctioneer reopens, B bids, admin closes and B's bid is undone, then confirms A.
  engine.reopenBidding();
  engine.bid({ teamId: 'B', amount: 55, lotSeq: lot.seq });
  engine.closeBidding();
  engine.undoLastBid();
  assert.equal(engine.state.lot.leaderId, 'A');
  assert.equal(engine.confirmSale()[0].type, 'sold');
  assert.equal(engine.players.get('d1').teamId, 'A');
  assert.equal(engine.players.get('d1').price, 50);

  // No bids: timer closes, nothing to confirm, auctioneer marks unsold.
  lot = openLot(engine, 'd2');
  clock.advance(20_400);
  engine.tick();
  assert.equal(code(() => engine.confirmSale()), 'NO_BIDS');
  engine.markUnsold();
  assert.equal(engine.players.get('d2').status, 'unsold');
});

test('undo last bid restores previous leader and price', () => {
  const { engine } = setup();
  const lot = openLot(engine, 'd1');
  engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq });
  engine.bid({ teamId: 'B', amount: 90, lotSeq: lot.seq, source: 'admin' }); // mistaken proxy bid
  engine.undoLastBid();
  assert.equal(engine.state.lot.amount, 50);
  assert.equal(engine.state.lot.leaderId, 'A');
  assert.equal(nextBidAmount(engine.state.lot, engine.settings.increments), 55);
  engine.undoLastBid();
  assert.equal(engine.state.lot.amount, null);
  assert.equal(engine.state.lot.leaderId, null);
  assert.equal(code(() => engine.undoLastBid()), 'NOTHING_TO_UNDO');
});

test('manual mode: captains cannot bid, admin records sale', () => {
  const { engine } = setup();
  engine.setMode('manual');
  const lot = openLot(engine, 'd1');
  assert.equal(code(() => engine.bid({ teamId: 'A', amount: 50, lotSeq: lot.seq })), 'ONLINE_BIDDING_OFF');
  engine.manualSale({ teamId: 'B', amount: 70 });
  assert.equal(engine.players.get('d1').price, 70);
});

test('retained players count against budget and squad', () => {
  const { engine } = setup();
  engine.players.set('r1', { id: 'r1', name: 'Kept', position: 'Forward', status: 'retained', teamId: 'A', price: 60 });
  assert.equal(engine.finance('A').purse, 140);
  assert.equal(engine.finance('A').count, 1);
});

test('unsold round and restart recovery', () => {
  const { engine, clock } = setup();
  openLot(engine, 'd1');
  engine.markUnsold();
  engine.startUnsoldRound();
  assert.equal(engine.state.round, 2);
  const lot = openLot(engine, 'd1');
  clock.advance(5000);
  const restored = new AuctionEngine({
    settings: engine.settings,
    teams: [...engine.teams.values()],
    players: [...engine.players.values()],
    state: engine.state,
    clock: clock.now,
  });
  restored.recoverAfterRestart();
  assert.equal(restored.state.paused, true);
  assert.equal(restored.state.lot.seq, lot.seq);
  assert.equal(restored.state.lot.remainingMs, 15000);
});
