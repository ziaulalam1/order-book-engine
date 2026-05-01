// Engine invariant tests, ported from tests/test_invariants.html for Node CI.
// Run: node --test test/engine.test.mjs
//
// Each test asserts a property of the matching engine, not the implementation.
// If a test fails, the engine's correctness contract is broken — not a coverage gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { OrderBook, OrderFlowGenerator } = require('../engine.js');

test('1. Price-time priority: equal-price orders match in submission order', () => {
  const book = new OrderBook();
  const a = book.submitOrder('SELL', 'LIMIT', 100, 5);
  const b = book.submitOrder('SELL', 'LIMIT', 100, 5);
  const buy = book.submitOrder('BUY', 'LIMIT', 100, 5);
  assert.equal(buy.fills[0].makerId, a.id, 'buy must match the earlier seller A first');
  assert.equal(book.asks.length, 1);
  assert.equal(book.asks[0].orders[0].id, b.id, 'B remains resting');
  assert.equal(book.asks[0].orders[0].qty, 5);
});

test('2. No trade at worse price: limit-or-better only', () => {
  const book = new OrderBook();
  book.submitOrder('BUY', 'LIMIT', 100, 10);
  book.submitOrder('SELL', 'LIMIT', 101, 5);
  assert.equal(book.trades.length, 0, 'buy@100 vs sell@101 must not match');

  const r = book.submitOrder('SELL', 'LIMIT', 99, 5);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].price, 100, 'maker price wins (sell@99 fills against bid@100)');
});

test('2b. Buy limit does not match higher-priced ask', () => {
  const book = new OrderBook();
  book.submitOrder('SELL', 'LIMIT', 105, 10);
  const r = book.submitOrder('BUY', 'LIMIT', 100, 5);
  assert.equal(r.fills.length, 0);
});

test('3. Conservation of shares: rest + executed + cancelled == submitted (10k mixed orders)', () => {
  const book = new OrderBook();
  let totalSubmitted = 0;
  for (let i = 0; i < 10000; i++) {
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const price = +(100 + (Math.random() * 10 - 5)).toFixed(2);
    const qty = 1 + Math.floor(Math.random() * 10);
    totalSubmitted += qty;
    book.submitOrder(side, 'LIMIT', price, qty);
  }
  const resting = book.getRestingQty();
  const executed = book.getExecutedQty();
  const cancelled = book.totalCancelledQty;
  assert.equal(resting + executed + cancelled, totalSubmitted,
    `submitted=${totalSubmitted} resting=${resting} executed=${executed} cancelled=${cancelled}`);
});

test('4. Book always sorted (10k random orders)', () => {
  const book = new OrderBook();
  for (let i = 0; i < 10000; i++) {
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const price = +(100 + (Math.random() * 10 - 5)).toFixed(2);
    const qty = 1 + Math.floor(Math.random() * 10);
    book.submitOrder(side, 'LIMIT', price, qty);
  }
  for (let i = 1; i < book.bids.length; i++) {
    assert.ok(book.bids[i].price <= book.bids[i - 1].price, `bids not desc at ${i}`);
  }
  for (let i = 1; i < book.asks.length; i++) {
    assert.ok(book.asks[i].price >= book.asks[i - 1].price, `asks not asc at ${i}`);
  }
});

test('5. Empty book rejects market order with NO_LIQUIDITY', () => {
  const book = new OrderBook();
  const r = book.submitOrder('BUY', 'MARKET', null, 10);
  assert.equal(r.rejectReason, 'NO_LIQUIDITY');
  assert.equal(book.trades.length, 0);
});

test('6. IOC: matches what it can, kills remainder, never rests', () => {
  const book = new OrderBook();
  book.submitOrder('SELL', 'LIMIT', 100, 5);
  book.submitOrder('SELL', 'LIMIT', 102, 10);
  const r = book.submitOrder('BUY', 'IOC', 101, 12);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].qty, 5);
  assert.equal(r.cancelledQty, 7);
  assert.equal(r.restingOrder, null);
  assert.equal(book.asks.length, 1, 'the 102 ask is untouched');
  assert.equal(book.asks[0].price, 102);
});

test('7. FOK: rejected when liquidity insufficient — book unchanged', () => {
  const book = new OrderBook();
  book.submitOrder('SELL', 'LIMIT', 100, 5);
  book.submitOrder('SELL', 'LIMIT', 102, 10);
  const r = book.submitOrder('BUY', 'FOK', 101, 12);
  assert.equal(r.rejectReason, 'FOK_NOT_FILLABLE');
  assert.equal(r.fills.length, 0, 'no partial fill on FOK reject');
  assert.equal(book.asks.length, 2, 'book unchanged on FOK reject');
});

test('8. FOK: fully fills when liquidity is sufficient', () => {
  const book = new OrderBook();
  book.submitOrder('SELL', 'LIMIT', 100, 5);
  book.submitOrder('SELL', 'LIMIT', 101, 10);
  const r = book.submitOrder('BUY', 'FOK', 101, 12);
  assert.equal(r.rejectReason, null);
  assert.equal(r.fills.reduce((s, f) => s + f.qty, 0), 12);
});

test('9. Sell-side IOC mirrors buy-side', () => {
  const book = new OrderBook();
  book.submitOrder('BUY', 'LIMIT', 100, 5);
  book.submitOrder('BUY', 'LIMIT', 98, 10);
  const r = book.submitOrder('SELL', 'IOC', 99, 12);
  assert.equal(r.fills.length, 1);
  assert.equal(r.fills[0].qty, 5);
  assert.equal(r.cancelledQty, 7);
});

test('10. Sell-side FOK across multiple levels', () => {
  const book = new OrderBook();
  book.submitOrder('BUY', 'LIMIT', 100, 5);
  book.submitOrder('BUY', 'LIMIT', 98, 10);
  // Reject case
  const r1 = book.submitOrder('SELL', 'FOK', 99, 12);
  assert.equal(r1.rejectReason, 'FOK_NOT_FILLABLE');
  // Fill case spans both levels
  const r2 = book.submitOrder('SELL', 'FOK', 98, 12);
  assert.equal(r2.rejectReason, null);
  assert.equal(r2.fills.reduce((s, f) => s + f.qty, 0), 12);
});

test('11. Cancel removes a resting order', () => {
  const book = new OrderBook();
  const r = book.submitOrder('BUY', 'LIMIT', 99, 5);
  assert.ok(r.restingOrder, 'order should rest');
  const ok = book.cancelOrder(r.restingOrder.id);
  assert.equal(ok, true);
  assert.equal(book.bids.length, 0, 'book empty after cancel');
  // Cancelling again returns false
  assert.equal(book.cancelOrder(r.restingOrder.id), false);
});

test('12. Auto-flow conservation holds with mixed MARKET/LIMIT (5k orders)', () => {
  const book = new OrderBook();
  const gen = new OrderFlowGenerator(100, 0.05, 0.3);
  let totalSubmitted = 0;
  for (let i = 0; i < 5000; i++) {
    const o = gen.generate(book.nextId);
    totalSubmitted += o.qty;
    book.submitOrder(o.side, o.type, o.price, o.qty);
  }
  const resting = book.getRestingQty();
  const executed = book.getExecutedQty();
  const cancelled = book.totalCancelledQty;
  assert.equal(resting + executed + cancelled, totalSubmitted,
    `submitted=${totalSubmitted} resting=${resting} executed=${executed} cancelled=${cancelled}`);
});
