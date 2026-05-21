// replay_lobster.js — stream LOBSTER message CSV through OrderBook,
// compare engine state against LOBSTER orderbook CSV at checkpoints.
//
// LOBSTER message.csv columns: time, type, order_id, size, price, direction
// LOBSTER orderbook.csv columns: ask_p_1, ask_s_1, bid_p_1, bid_s_1, ...
// Empty levels: ask_price=9999999999, bid_price=-9999999999, size=0
//
// Mapping LOBSTER -> engine API (engine.js: OrderBook.submitOrder, cancelOrder):
//   1 (submission)        -> book.submitOrder(side, 'LIMIT', price, size)
//                            Map LOBSTER order_id -> engine id (for later events)
//   2 (cancel partial)    -> reduce maker qty in place by `size` (engine has no
//                            partial cancel; mutate book.bids/book.asks directly)
//   3 (delete)            -> book.cancelOrder(engine_id)
//   4 (execution visible) -> reduce maker qty in place by `size`; record trade
//   5 (execution hidden)  -> skip; hidden orders are off-book in LOBSTER too
//   6 (cross trade)       -> skip; rare, no top-of-book impact in same way
//   7 (trading halt)      -> log; no engine action
//
// Why mutate book state directly for types 2 and 4: engine.js is read-only per
// constraint. submitOrder + cancelOrder is a full-replace API. To preserve time
// priority on partial events the only correct option without modifying engine.js
// is to walk book.bids / book.asks (public arrays per engine.js:5-6) and mutate
// the matching maker's qty. Documented in lobster/README.md.
//
// CLI: node replay_lobster.js <message.csv> <orderbook.csv> [--levels N]
//      [--checkpoint-every K] [--limit N] [--quiet]

'use strict';

const fs = require('fs');
const readline = require('readline');
const path = require('path');

const { OrderBook } = require('../engine.js');

const EMPTY_ASK_PRICE = 9999999999;
const EMPTY_BID_PRICE = -9999999999;

// Walk book.bids / book.asks externally and reduce a resting order's qty.
// Returns true on success. If qty hits zero, removes the order (and the level
// if empty). Pure state mutation; no trade is recorded here.
function reduceRestingQty(book, engineId, byQty) {
  for (const sideArr of [book.bids, book.asks]) {
    for (let li = 0; li < sideArr.length; li++) {
      const level = sideArr[li];
      for (let oi = 0; oi < level.orders.length; oi++) {
        if (level.orders[oi].id === engineId) {
          level.orders[oi].qty -= byQty;
          if (level.orders[oi].qty <= 0) {
            level.orders.splice(oi, 1);
            if (level.orders.length === 0) sideArr.splice(li, 1);
          }
          return true;
        }
      }
    }
  }
  return false;
}

// Find which side a resting order sits on, and its price. Used to record
// synthetic trades from execution events.
function locateOrder(book, engineId) {
  for (const [arr, sideName] of [[book.bids, 'BUY'], [book.asks, 'SELL']]) {
    for (const level of arr) {
      for (const o of level.orders) {
        if (o.id === engineId) {
          return { side: sideName, price: level.price, qty: o.qty };
        }
      }
    }
  }
  return null;
}

// Format the engine's top-N levels into a LOBSTER orderbook row.
// LOBSTER: alternating ask_p, ask_s, bid_p, bid_s per level.
function engineSnapshotAsLobsterRow(book, levels) {
  const row = [];
  for (let i = 0; i < levels; i++) {
    const a = book.asks[i];
    const b = book.bids[i];
    if (a) {
      const sz = a.orders.reduce((s, o) => s + o.qty, 0);
      row.push(a.price, sz);
    } else {
      row.push(EMPTY_ASK_PRICE, 0);
    }
    if (b) {
      const sz = b.orders.reduce((s, o) => s + o.qty, 0);
      row.push(b.price, sz);
    } else {
      row.push(EMPTY_BID_PRICE, 0);
    }
  }
  return row;
}

function parseLobsterRow(line) {
  return line.split(',').map(Number);
}

function compareRows(engineRow, lobsterRow) {
  if (engineRow.length !== lobsterRow.length) {
    return { ok: false, reason: `length mismatch ${engineRow.length} vs ${lobsterRow.length}` };
  }
  for (let i = 0; i < engineRow.length; i++) {
    if (engineRow[i] !== lobsterRow[i]) {
      return {
        ok: false,
        reason: `col ${i}: engine=${engineRow[i]} lobster=${lobsterRow[i]}`,
      };
    }
  }
  return { ok: true };
}

async function replay(messageFile, orderbookFile, opts = {}) {
  const levels = opts.levels || 10;
  const checkpointEvery = opts.checkpointEvery || 1000;
  const limit = opts.limit || Infinity;
  const quiet = !!opts.quiet;
  const onMismatch = opts.onMismatch || null;

  const book = new OrderBook();
  const lobsterToEngineId = new Map(); // lobster order_id -> engine id

  const stats = {
    events: 0,
    submissions: 0,
    cancelsPartial: 0,
    deletes: 0,
    executionsVisible: 0,
    executionsHidden: 0,
    halts: 0,
    crossTrades: 0,
    other: 0,
    parserErrors: 0,
    checkpointsChecked: 0,
    mismatches: [],
    unmappedRefs: 0, // events referencing an order_id we never saw
  };

  const msgRl = readline.createInterface({
    input: fs.createReadStream(messageFile),
    crlfDelay: Infinity,
  });
  const obRl = readline.createInterface({
    input: fs.createReadStream(orderbookFile),
    crlfDelay: Infinity,
  });
  const obIter = obRl[Symbol.asyncIterator]();

  for await (const rawLine of msgRl) {
    if (stats.events >= limit) break;
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 6) {
      stats.parserErrors++;
      continue;
    }
    const time = +parts[0];
    const type = +parts[1];
    const orderId = +parts[2];
    const size = +parts[3];
    const price = +parts[4];
    const direction = +parts[5]; // -1 sell limit, +1 buy limit

    switch (type) {
      case 1: {
        // submission: add resting limit order
        const side = direction === 1 ? 'BUY' : 'SELL';
        const result = book.submitOrder(side, 'LIMIT', price, size);
        if (result.restingOrder) {
          lobsterToEngineId.set(orderId, result.restingOrder.id);
        } else if (result.id !== undefined) {
          // Order matched and did not rest — track it anyway in case later
          // events reference it (for synthetic data, submissions never cross
          // existing book; for real data this can happen).
          lobsterToEngineId.set(orderId, result.id);
        }
        stats.submissions++;
        break;
      }
      case 2: {
        // partial cancel: reduce qty by `size`
        const engineId = lobsterToEngineId.get(orderId);
        if (engineId === undefined) {
          stats.unmappedRefs++;
        } else {
          reduceRestingQty(book, engineId, size);
        }
        stats.cancelsPartial++;
        break;
      }
      case 3: {
        // full delete
        const engineId = lobsterToEngineId.get(orderId);
        if (engineId === undefined) {
          stats.unmappedRefs++;
        } else {
          book.cancelOrder(engineId);
          lobsterToEngineId.delete(orderId);
        }
        stats.deletes++;
        break;
      }
      case 4: {
        // visible execution: reduce maker by `size`, record synthetic trade
        const engineId = lobsterToEngineId.get(orderId);
        if (engineId === undefined) {
          stats.unmappedRefs++;
        } else {
          const located = locateOrder(book, engineId);
          if (located) {
            const fillQty = Math.min(size, located.qty);
            const takerSide = located.side === 'BUY' ? 'SELL' : 'BUY';
            const trade = {
              price: located.price,
              qty: fillQty,
              makerId: engineId,
              takerId: 0,
              takerSide,
              ts: time,
            };
            book.trades.push(trade);
            book.vwapNum += trade.price * trade.qty;
            book.vwapDen += trade.qty;
            reduceRestingQty(book, engineId, fillQty);
            if (located.qty - fillQty <= 0) lobsterToEngineId.delete(orderId);
          }
        }
        stats.executionsVisible++;
        break;
      }
      case 5:
        // hidden execution: no displayed-book impact in LOBSTER
        stats.executionsHidden++;
        break;
      case 6:
        stats.crossTrades++;
        break;
      case 7:
        stats.halts++;
        break;
      default:
        stats.other++;
        break;
    }

    stats.events++;

    // advance orderbook stream in lockstep
    const obStep = await obIter.next();
    if (obStep.done) break;
    const obLine = obStep.value.trim();
    if (!obLine) continue;

    if (stats.events % checkpointEvery === 0 || stats.events === 1) {
      const lobsterRow = parseLobsterRow(obLine);
      const engineRow = engineSnapshotAsLobsterRow(book, levels);
      const cmp = compareRows(engineRow, lobsterRow);
      stats.checkpointsChecked++;
      if (!cmp.ok) {
        const mm = {
          eventIndex: stats.events,
          eventType: type,
          reason: cmp.reason,
          engine: engineRow.slice(0, 8),
          lobster: lobsterRow.slice(0, 8),
        };
        stats.mismatches.push(mm);
        if (onMismatch) onMismatch(mm);
        if (!quiet) {
          console.log(`MISMATCH at event ${stats.events} (type=${type}): ${cmp.reason}`);
        }
      } else if (!quiet && stats.checkpointsChecked % 10 === 0) {
        console.log(`event ${stats.events}: checkpoint OK`);
      }
    }
  }

  return { book, stats };
}

function printSummary(stats) {
  console.log('--- replay summary ---');
  console.log(`events processed:     ${stats.events}`);
  console.log(`submissions:          ${stats.submissions}`);
  console.log(`cancels (partial):    ${stats.cancelsPartial}`);
  console.log(`deletes:              ${stats.deletes}`);
  console.log(`executions (visible): ${stats.executionsVisible}`);
  console.log(`executions (hidden):  ${stats.executionsHidden}`);
  console.log(`cross trades:         ${stats.crossTrades}`);
  console.log(`halts:                ${stats.halts}`);
  console.log(`other types:          ${stats.other}`);
  console.log(`parser errors:        ${stats.parserErrors}`);
  console.log(`unmapped refs:        ${stats.unmappedRefs}`);
  console.log(`checkpoints checked:  ${stats.checkpointsChecked}`);
  console.log(`mismatches:           ${stats.mismatches.length}`);
  if (stats.mismatches.length > 0 && stats.mismatches.length <= 10) {
    for (const m of stats.mismatches) {
      console.log(`  event ${m.eventIndex} type=${m.eventType}: ${m.reason}`);
    }
  } else if (stats.mismatches.length > 10) {
    console.log(`  (showing first 5)`);
    for (let i = 0; i < 5; i++) {
      const m = stats.mismatches[i];
      console.log(`  event ${m.eventIndex} type=${m.eventType}: ${m.reason}`);
    }
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const files = [];
  let levels = 10;
  let checkpointEvery = 1000;
  let limit = Infinity;
  let quiet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--levels') levels = +args[++i];
    else if (a === '--checkpoint-every') checkpointEvery = +args[++i];
    else if (a === '--limit') limit = +args[++i];
    else if (a === '--quiet') quiet = true;
    else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`);
      process.exit(2);
    } else files.push(a);
  }
  if (files.length < 2) {
    console.error('Usage: node replay_lobster.js <message.csv> <orderbook.csv> [--levels N] [--checkpoint-every K] [--limit N] [--quiet]');
    process.exit(1);
  }
  const [msgFile, obFile] = files;
  if (!fs.existsSync(msgFile) || !fs.existsSync(obFile)) {
    console.error(`missing input file: ${!fs.existsSync(msgFile) ? msgFile : obFile}`);
    process.exit(1);
  }
  replay(msgFile, obFile, { levels, checkpointEvery, limit, quiet }).then(({ stats }) => {
    printSummary(stats);
    process.exit(stats.mismatches.length > 0 ? 1 : 0);
  }).catch((err) => {
    console.error('replay error:', err);
    process.exit(1);
  });
}

module.exports = {
  replay,
  reduceRestingQty,
  locateOrder,
  engineSnapshotAsLobsterRow,
  EMPTY_ASK_PRICE,
  EMPTY_BID_PRICE,
};
