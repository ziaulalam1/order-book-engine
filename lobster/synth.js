// synth.js — deterministic LOBSTER-format CSV generator
// Produces a paired _message.csv + _orderbook.csv that exercises message types
// 1, 2, 3, 4, 5, 7. Used as a fallback when real LOBSTER samples are not
// reachable, and as the basis for the round-trip parser test.
//
// LOBSTER schema reference (lobsterdata.com/info/DataStructure.php):
//   message.csv columns: time, type, order_id, size, price, direction
//     time:      seconds after midnight, fractional
//     type:      1=submission, 2=cancel partial, 3=delete, 4=exec visible,
//                5=exec hidden, 6=cross trade, 7=halt
//     order_id:  unique per submission; 0 for hidden/halt
//     size:      shares (for type 2/4: the cancelled/executed delta, not the
//                resulting size)
//     price:     dollar price * 10000 (50.00 -> 500000)
//     direction: -1 sell limit order, +1 buy limit order. For exec events,
//                this is the side of the maker (resting order), not the taker.
//
//   orderbook.csv columns (--levels N): ask_price_1, ask_size_1, bid_price_1,
//   bid_size_1, ask_price_2, ask_size_2, bid_price_2, bid_size_2, ...
//   Empty levels: price=9999999999 (LOBSTER convention for ask) or -9999999999
//   for bid; size=0.
//
// CLI: node synth.js <out_prefix> [--events N] [--levels L] [--seed S]
//   Outputs <out_prefix>_message.csv and <out_prefix>_orderbook.csv.

'use strict';

const fs = require('fs');
const path = require('path');

// LOBSTER convention for empty levels (cap from spec)
const EMPTY_ASK_PRICE = 9999999999;
const EMPTY_BID_PRICE = -9999999999;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildEvents(numEvents, seed) {
  const rng = mulberry32(seed);
  const events = [];
  // Reference-side book mirroring the engine. Tracks (side, price, size, lobster_id).
  // bids: descending by price, asks: ascending. Within a level, FIFO by insert order.
  const bids = [];
  const asks = [];
  const liveOrders = new Map(); // lobster_id -> {side, price, size}
  let nextOrderId = 100;
  let timeMs = 34200000; // 9:30 AM (LOBSTER trading-day start)

  function findLevel(arr, price) {
    for (const l of arr) if (l.price === price) return l;
    return null;
  }
  function insertBid(price, size, id) {
    let lvl = findLevel(bids, price);
    if (!lvl) {
      lvl = { price, orders: [] };
      let i = 0;
      while (i < bids.length && bids[i].price > price) i++;
      bids.splice(i, 0, lvl);
    }
    lvl.orders.push({ id, size });
  }
  function insertAsk(price, size, id) {
    let lvl = findLevel(asks, price);
    if (!lvl) {
      lvl = { price, orders: [] };
      let i = 0;
      while (i < asks.length && asks[i].price < price) i++;
      asks.splice(i, 0, lvl);
    }
    lvl.orders.push({ id, size });
  }
  function removeOrder(id) {
    const o = liveOrders.get(id);
    if (!o) return false;
    const arr = o.side === 1 ? bids : asks;
    for (let i = 0; i < arr.length; i++) {
      const lvl = arr[i];
      if (lvl.price !== o.price) continue;
      for (let j = 0; j < lvl.orders.length; j++) {
        if (lvl.orders[j].id === id) {
          lvl.orders.splice(j, 1);
          if (lvl.orders.length === 0) arr.splice(i, 1);
          liveOrders.delete(id);
          return true;
        }
      }
    }
    return false;
  }
  function reduceOrder(id, delta) {
    const o = liveOrders.get(id);
    if (!o) return false;
    const arr = o.side === 1 ? bids : asks;
    for (const lvl of arr) {
      if (lvl.price !== o.price) continue;
      for (const ord of lvl.orders) {
        if (ord.id === id) {
          ord.size -= delta;
          o.size -= delta;
          if (ord.size <= 0) return removeOrder(id);
          return true;
        }
      }
    }
    return false;
  }

  // Snapshot in LOBSTER orderbook.csv format for given level depth.
  function snapshot(levels) {
    const row = [];
    for (let i = 0; i < levels; i++) {
      const a = asks[i];
      const b = bids[i];
      if (a) {
        const sz = a.orders.reduce((s, o) => s + o.size, 0);
        row.push(a.price, sz);
      } else {
        row.push(EMPTY_ASK_PRICE, 0);
      }
      if (b) {
        const sz = b.orders.reduce((s, o) => s + o.size, 0);
        row.push(b.price, sz);
      } else {
        row.push(EMPTY_BID_PRICE, 0);
      }
    }
    return row;
  }

  function emit(type, orderId, size, price, direction) {
    timeMs += 1 + Math.floor(rng() * 5); // 1-5 ms gap
    const tSec = timeMs / 1000;
    events.push({ time: tSec, type, orderId, size, price, direction });
  }

  // Seed initial book (5 levels each side) so subsequent events have something
  // to act on. Mid price 50.00 -> price field 500000.
  const mid = 500000;
  for (let i = 0; i < 5; i++) {
    const askPrice = mid + 100 + i * 100;
    const bidPrice = mid - 100 - i * 100;
    const askSize = 50 + Math.floor(rng() * 100);
    const bidSize = 50 + Math.floor(rng() * 100);
    const aId = nextOrderId++;
    const bId = nextOrderId++;
    insertAsk(askPrice, askSize, aId);
    liveOrders.set(aId, { side: -1, price: askPrice, size: askSize });
    emit(1, aId, askSize, askPrice, -1);
    insertBid(bidPrice, bidSize, bId);
    liveOrders.set(bId, { side: 1, price: bidPrice, size: bidSize });
    emit(1, bId, bidSize, bidPrice, 1);
  }

  // Generate the rest of the events with a mix of types.
  while (events.length < numEvents) {
    const r = rng();
    const liveIds = Array.from(liveOrders.keys());
    if (r < 0.5 || liveIds.length === 0) {
      // submission (type 1)
      const direction = rng() < 0.5 ? 1 : -1;
      const offset = (1 + Math.floor(rng() * 8)) * 100;
      const price = direction === 1 ? mid - offset : mid + offset;
      const size = 10 + Math.floor(rng() * 90);
      const id = nextOrderId++;
      if (direction === 1) insertBid(price, size, id);
      else insertAsk(price, size, id);
      liveOrders.set(id, { side: direction, price, size });
      emit(1, id, size, price, direction);
    } else if (r < 0.65) {
      // cancel partial (type 2)
      const id = liveIds[Math.floor(rng() * liveIds.length)];
      const o = liveOrders.get(id);
      if (o.size <= 1) continue; // need >1 to partial cancel
      const delta = 1 + Math.floor(rng() * Math.max(1, o.size - 1));
      reduceOrder(id, delta);
      emit(2, id, delta, o.price, o.side);
    } else if (r < 0.75) {
      // delete (type 3)
      const id = liveIds[Math.floor(rng() * liveIds.length)];
      const o = liveOrders.get(id);
      removeOrder(id);
      emit(3, id, o.size, o.price, o.side);
    } else if (r < 0.93) {
      // execution visible (type 4): pick top of book, decrement
      const arr = rng() < 0.5 ? bids : asks;
      if (arr.length === 0 || arr[0].orders.length === 0) continue;
      const lvl = arr[0];
      const ord = lvl.orders[0];
      const o = liveOrders.get(ord.id);
      const fillQty = Math.min(ord.size, 1 + Math.floor(rng() * ord.size));
      reduceOrder(ord.id, fillQty);
      emit(4, ord.id, fillQty, o.price, o.side);
    } else if (r < 0.98) {
      // execution hidden (type 5): no book impact
      const direction = rng() < 0.5 ? 1 : -1;
      const size = 10 + Math.floor(rng() * 50);
      const price = mid + (rng() < 0.5 ? -50 : 50);
      emit(5, 0, size, price, direction);
    } else {
      // halt (type 7)
      emit(7, 0, 0, 0, 0);
    }
  }

  return { events, snapshotter: (levels) => snapshot(levels) };
}

function generate(outPrefix, numEvents, levels, seed) {
  const rng = mulberry32(seed);
  const messageRows = [];
  const orderbookRows = [];

  // Re-build with snapshot after each event so message[i] aligns with orderbook[i]
  const bids = [];
  const asks = [];
  const liveOrders = new Map();

  function findLevel(arr, price) {
    for (const l of arr) if (l.price === price) return l;
    return null;
  }
  function insertBid(price, size, id) {
    let lvl = findLevel(bids, price);
    if (!lvl) {
      lvl = { price, orders: [] };
      let i = 0;
      while (i < bids.length && bids[i].price > price) i++;
      bids.splice(i, 0, lvl);
    }
    lvl.orders.push({ id, size });
  }
  function insertAsk(price, size, id) {
    let lvl = findLevel(asks, price);
    if (!lvl) {
      lvl = { price, orders: [] };
      let i = 0;
      while (i < asks.length && asks[i].price < price) i++;
      asks.splice(i, 0, lvl);
    }
    lvl.orders.push({ id, size });
  }
  function removeOrder(id) {
    const o = liveOrders.get(id);
    if (!o) return false;
    const arr = o.side === 1 ? bids : asks;
    for (let i = 0; i < arr.length; i++) {
      const lvl = arr[i];
      if (lvl.price !== o.price) continue;
      for (let j = 0; j < lvl.orders.length; j++) {
        if (lvl.orders[j].id === id) {
          lvl.orders.splice(j, 1);
          if (lvl.orders.length === 0) arr.splice(i, 1);
          liveOrders.delete(id);
          return true;
        }
      }
    }
    return false;
  }
  function reduceOrder(id, delta) {
    const o = liveOrders.get(id);
    if (!o) return false;
    const arr = o.side === 1 ? bids : asks;
    for (const lvl of arr) {
      if (lvl.price !== o.price) continue;
      for (const ord of lvl.orders) {
        if (ord.id === id) {
          ord.size -= delta;
          o.size -= delta;
          if (ord.size <= 0) {
            removeOrder(id);
          }
          return true;
        }
      }
    }
    return false;
  }
  function snapshot() {
    const row = [];
    for (let i = 0; i < levels; i++) {
      const a = asks[i];
      const b = bids[i];
      if (a) {
        const sz = a.orders.reduce((s, o) => s + o.size, 0);
        row.push(a.price, sz);
      } else {
        row.push(EMPTY_ASK_PRICE, 0);
      }
      if (b) {
        const sz = b.orders.reduce((s, o) => s + o.size, 0);
        row.push(b.price, sz);
      } else {
        row.push(EMPTY_BID_PRICE, 0);
      }
    }
    return row;
  }

  let nextOrderId = 100;
  let timeMs = 34200000;
  const mid = 500000;

  function emit(type, orderId, size, price, direction) {
    timeMs += 1 + Math.floor(rng() * 5);
    const tSec = (timeMs / 1000).toFixed(9);
    messageRows.push([tSec, type, orderId, size, price, direction].join(','));
    orderbookRows.push(snapshot().join(','));
  }

  // Seed initial book
  for (let i = 0; i < 5; i++) {
    const askPrice = mid + 100 + i * 100;
    const bidPrice = mid - 100 - i * 100;
    const askSize = 50 + Math.floor(rng() * 100);
    const bidSize = 50 + Math.floor(rng() * 100);
    const aId = nextOrderId++;
    const bId = nextOrderId++;
    insertAsk(askPrice, askSize, aId);
    liveOrders.set(aId, { side: -1, price: askPrice, size: askSize });
    emit(1, aId, askSize, askPrice, -1);
    insertBid(bidPrice, bidSize, bId);
    liveOrders.set(bId, { side: 1, price: bidPrice, size: bidSize });
    emit(1, bId, bidSize, bidPrice, 1);
  }

  while (messageRows.length < numEvents) {
    const r = rng();
    const liveIds = Array.from(liveOrders.keys());
    if (r < 0.5 || liveIds.length === 0) {
      const direction = rng() < 0.5 ? 1 : -1;
      const offset = (1 + Math.floor(rng() * 8)) * 100;
      const price = direction === 1 ? mid - offset : mid + offset;
      const size = 10 + Math.floor(rng() * 90);
      const id = nextOrderId++;
      if (direction === 1) insertBid(price, size, id);
      else insertAsk(price, size, id);
      liveOrders.set(id, { side: direction, price, size });
      emit(1, id, size, price, direction);
    } else if (r < 0.65) {
      const id = liveIds[Math.floor(rng() * liveIds.length)];
      const o = liveOrders.get(id);
      if (o.size <= 1) continue;
      const delta = 1 + Math.floor(rng() * Math.max(1, o.size - 1));
      const origPrice = o.price;
      const origSide = o.side;
      reduceOrder(id, delta);
      emit(2, id, delta, origPrice, origSide);
    } else if (r < 0.75) {
      const id = liveIds[Math.floor(rng() * liveIds.length)];
      const o = liveOrders.get(id);
      const origPrice = o.price;
      const origSide = o.side;
      const origSize = o.size;
      removeOrder(id);
      emit(3, id, origSize, origPrice, origSide);
    } else if (r < 0.93) {
      const arr = rng() < 0.5 ? bids : asks;
      if (arr.length === 0 || arr[0].orders.length === 0) continue;
      const lvl = arr[0];
      const ord = lvl.orders[0];
      const o = liveOrders.get(ord.id);
      const fillQty = Math.min(ord.size, 1 + Math.floor(rng() * ord.size));
      const origPrice = o.price;
      const origSide = o.side;
      reduceOrder(ord.id, fillQty);
      emit(4, ord.id, fillQty, origPrice, origSide);
    } else if (r < 0.98) {
      const direction = rng() < 0.5 ? 1 : -1;
      const size = 10 + Math.floor(rng() * 50);
      const price = mid + (rng() < 0.5 ? -50 : 50);
      emit(5, 0, size, price, direction);
    } else {
      emit(7, 0, 0, 0, 0);
    }
  }

  fs.writeFileSync(`${outPrefix}_message.csv`, messageRows.join('\n') + '\n');
  fs.writeFileSync(`${outPrefix}_orderbook.csv`, orderbookRows.join('\n') + '\n');

  return { messages: messageRows.length, orderbookRows: orderbookRows.length };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  let outPrefix = null;
  let events = 5000;
  let levels = 10;
  let seed = 42;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--events') events = +args[++i];
    else if (args[i] === '--levels') levels = +args[++i];
    else if (args[i] === '--seed') seed = +args[++i];
    else if (!outPrefix) outPrefix = args[i];
  }
  if (!outPrefix) {
    console.error('Usage: node synth.js <out_prefix> [--events N] [--levels L] [--seed S]');
    process.exit(1);
  }
  const r = generate(outPrefix, events, levels, seed);
  console.log(`wrote ${r.messages} events to ${outPrefix}_message.csv and ${outPrefix}_orderbook.csv`);
}

module.exports = { generate, mulberry32, EMPTY_ASK_PRICE, EMPTY_BID_PRICE };
