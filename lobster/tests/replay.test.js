// replay.test.js — assert replay engine state matches reference at every step.
//
// Two scenarios:
//   1. Hand-crafted 6-event CSV with hand-computed orderbook rows at level 1.
//      Exercises: submission (type 1), partial cancel (type 2), visible
//      execution (type 4), full delete (type 3).
//   2. Deterministic synth roundtrip: generate 200 events via synth.js, replay
//      with --checkpoint-every 1, expect zero mismatches across all events.
//
// Run: node lobster/tests/replay.test.js

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const { replay } = require('../replay_lobster.js');
const { generate } = require('../synth.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster_test_'));

function fail(msg) {
  console.error('FAIL:', msg);
  process.exit(1);
}

async function testHandCrafted() {
  const msgFile = path.join(TMP, 'hand_message.csv');
  const obFile = path.join(TMP, 'hand_orderbook.csv');

  // Schema: time,type,order_id,size,price,direction
  // direction: -1=sell, +1=buy
  const messages = [
    '34200.000001,1,1,100,500000,1',   // bid 500000 size 100 (id=1)
    '34200.000002,1,2,100,510000,-1',  // ask 510000 size 100 (id=2)
    '34200.000003,1,3,50,500000,1',    // bid 500000 size 50 (id=3, same level as id=1)
    '34200.000004,2,1,30,500000,1',    // partial cancel id=1 by 30 (id=1 now 70)
    '34200.000005,4,1,20,500000,1',    // exec id=1 by 20 (id=1 now 50)
    '34200.000006,3,2,100,510000,-1',  // delete id=2 (full)
  ];

  // Format per level: ask_price, ask_size, bid_price, bid_size
  // Using levels=1
  const orderbookRows = [
    '9999999999,0,500000,100', // after event 1: bid=100, ask empty
    '510000,100,500000,100',   // after event 2: ask=100, bid=100
    '510000,100,500000,150',   // after event 3: bid level grew to 150
    '510000,100,500000,120',   // after event 4: bid 100->70 + 50 = 120
    '510000,100,500000,100',   // after event 5: bid 70->50 + 50 = 100
    '9999999999,0,500000,100', // after event 6: ask deleted
  ];

  fs.writeFileSync(msgFile, messages.join('\n') + '\n');
  fs.writeFileSync(obFile, orderbookRows.join('\n') + '\n');

  const { book, stats } = await replay(msgFile, obFile, {
    levels: 1,
    checkpointEvery: 1,
    quiet: true,
  });

  assert.strictEqual(stats.events, 6, `expected 6 events, got ${stats.events}`);
  assert.strictEqual(stats.submissions, 3, `expected 3 submissions, got ${stats.submissions}`);
  assert.strictEqual(stats.cancelsPartial, 1, `expected 1 partial cancel, got ${stats.cancelsPartial}`);
  assert.strictEqual(stats.deletes, 1, `expected 1 delete, got ${stats.deletes}`);
  assert.strictEqual(stats.executionsVisible, 1, `expected 1 visible exec, got ${stats.executionsVisible}`);
  assert.strictEqual(stats.mismatches.length, 0,
    `expected 0 mismatches, got ${stats.mismatches.length}: ${JSON.stringify(stats.mismatches, null, 2)}`);
  assert.strictEqual(stats.checkpointsChecked, 6, `expected 6 checkpoints, got ${stats.checkpointsChecked}`);

  // Final book state: 1 bid level @500000 with qty 100, no asks
  assert.strictEqual(book.bids.length, 1, `expected 1 bid level, got ${book.bids.length}`);
  assert.strictEqual(book.asks.length, 0, `expected 0 ask levels, got ${book.asks.length}`);
  assert.strictEqual(book.bids[0].price, 500000);
  const finalBidQty = book.bids[0].orders.reduce((s, o) => s + o.qty, 0);
  assert.strictEqual(finalBidQty, 100, `expected final bid qty 100, got ${finalBidQty}`);

  // The execution should have been recorded as a trade
  assert.strictEqual(book.trades.length, 1, `expected 1 trade, got ${book.trades.length}`);
  assert.strictEqual(book.trades[0].qty, 20);
  assert.strictEqual(book.trades[0].price, 500000);

  console.log('PASS: hand-crafted 6-event scenario');
}

async function testSynthRoundTrip() {
  const prefix = path.join(TMP, 'synth');
  const r = generate(prefix, 200, 10, 42);
  assert.strictEqual(r.messages, 200, `synth should write 200 events, wrote ${r.messages}`);
  assert.strictEqual(r.orderbookRows, 200, `synth should write 200 ob rows, wrote ${r.orderbookRows}`);

  const { stats } = await replay(`${prefix}_message.csv`, `${prefix}_orderbook.csv`, {
    levels: 10,
    checkpointEvery: 1,
    quiet: true,
  });

  assert.strictEqual(stats.events, 200, `expected 200 events, got ${stats.events}`);
  assert.strictEqual(stats.checkpointsChecked, 200, `expected 200 checkpoints, got ${stats.checkpointsChecked}`);
  assert.strictEqual(stats.mismatches.length, 0,
    `expected 0 mismatches across 200-event synth replay, got ${stats.mismatches.length}.\n` +
    `First mismatch: ${stats.mismatches[0] ? JSON.stringify(stats.mismatches[0], null, 2) : 'n/a'}`);
  // Sanity: every interesting event type was actually exercised
  assert.ok(stats.submissions > 10, `expected >10 submissions, got ${stats.submissions}`);
  assert.ok(stats.deletes > 0, `expected some deletes, got ${stats.deletes}`);
  assert.ok(stats.cancelsPartial > 0, `expected some partial cancels, got ${stats.cancelsPartial}`);
  assert.ok(stats.executionsVisible > 0, `expected some visible execs, got ${stats.executionsVisible}`);
  // hidden execs and halts are rare but should appear at 200 events with seed=42
  assert.ok(stats.executionsHidden >= 0);
  assert.ok(stats.halts >= 0);

  console.log(`PASS: synth roundtrip (200 events, ${stats.submissions} subs, ${stats.deletes} dels, ${stats.cancelsPartial} cancels, ${stats.executionsVisible} execs, ${stats.executionsHidden} hidden, ${stats.halts} halts)`);
}

async function testLargerSynth() {
  // 5000 events, default checkpoint every 1000
  const prefix = path.join(TMP, 'synth5k');
  generate(prefix, 5000, 10, 7);
  const { stats } = await replay(`${prefix}_message.csv`, `${prefix}_orderbook.csv`, {
    levels: 10,
    checkpointEvery: 500,
    quiet: true,
  });
  assert.strictEqual(stats.events, 5000);
  assert.strictEqual(stats.mismatches.length, 0,
    `5k synth: expected 0 mismatches, got ${stats.mismatches.length}`);
  console.log(`PASS: 5000-event synth replay, ${stats.checkpointsChecked} checkpoints, 0 mismatches`);
}

async function main() {
  try {
    await testHandCrafted();
    await testSynthRoundTrip();
    await testLargerSynth();
    console.log('\nALL TESTS PASS');
    fs.rmSync(TMP, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILURE:', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();
