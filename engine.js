// Order Book Matching Engine — Price-Time Priority (FIFO)
// Pure logic, no DOM dependencies. Testable standalone.

class OrderBook {
  constructor() {
    this.bids = [];       // [{price, orders: [{id, qty, ts}]}] sorted desc by price
    this.asks = [];       // [{price, orders: [{id, qty, ts}]}] sorted asc by price
    this.trades = [];
    this.allOrders = new Map(); // id -> {side, price, qty, ts, status}
    this.nextId = 1;
    this.totalSubmittedQty = 0;
    this.vwapNum = 0;
    this.vwapDen = 0;
  }

  submitOrder(side, type, price, qty) {
    const id = this.nextId++;
    const ts = performance.now();
    this.totalSubmittedQty += qty;
    const result = { id, fills: [], restingOrder: null, rejectReason: null };

    if (type === 'MARKET') {
      if (side === 'BUY') {
        if (this.asks.length === 0) { result.rejectReason = 'NO_LIQUIDITY'; return result; }
        this._matchBuy(id, qty, Infinity, ts, result);
      } else {
        if (this.bids.length === 0) { result.rejectReason = 'NO_LIQUIDITY'; return result; }
        this._matchSell(id, qty, 0, ts, result);
      }
    } else {
      if (side === 'BUY') {
        this._matchBuy(id, qty, price, ts, result);
        if (result.remainingQty > 0) {
          this._insertBid(id, price, result.remainingQty, ts);
          result.restingOrder = { id, side, price, qty: result.remainingQty };
        }
      } else {
        this._matchSell(id, qty, price, ts, result);
        if (result.remainingQty > 0) {
          this._insertAsk(id, price, result.remainingQty, ts);
          result.restingOrder = { id, side, price, qty: result.remainingQty };
        }
      }
    }
    delete result.remainingQty;
    return result;
  }

  _matchBuy(takerId, qty, maxPrice, ts, result) {
    let remaining = qty;
    while (remaining > 0 && this.asks.length > 0 && this.asks[0].price <= maxPrice) {
      const level = this.asks[0];
      while (remaining > 0 && level.orders.length > 0) {
        const maker = level.orders[0];
        const fillQty = Math.min(remaining, maker.qty);
        const trade = {
          price: level.price, qty: fillQty,
          makerId: maker.id, takerId, takerSide: 'BUY', ts: performance.now()
        };
        this.trades.push(trade);
        this.vwapNum += trade.price * trade.qty;
        this.vwapDen += trade.qty;
        result.fills.push(trade);
        remaining -= fillQty;
        maker.qty -= fillQty;
        if (maker.qty === 0) level.orders.shift();
      }
      if (level.orders.length === 0) this.asks.shift();
    }
    result.remainingQty = remaining;
  }

  _matchSell(takerId, qty, minPrice, ts, result) {
    let remaining = qty;
    while (remaining > 0 && this.bids.length > 0 && this.bids[0].price >= minPrice) {
      const level = this.bids[0];
      while (remaining > 0 && level.orders.length > 0) {
        const maker = level.orders[0];
        const fillQty = Math.min(remaining, maker.qty);
        const trade = {
          price: level.price, qty: fillQty,
          makerId: maker.id, takerId, takerSide: 'SELL', ts: performance.now()
        };
        this.trades.push(trade);
        this.vwapNum += trade.price * trade.qty;
        this.vwapDen += trade.qty;
        result.fills.push(trade);
        remaining -= fillQty;
        maker.qty -= fillQty;
        if (maker.qty === 0) level.orders.shift();
      }
      if (level.orders.length === 0) this.bids.shift();
    }
    result.remainingQty = remaining;
  }

  _insertBid(id, price, qty, ts) {
    for (let i = 0; i < this.bids.length; i++) {
      if (this.bids[i].price === price) {
        this.bids[i].orders.push({ id, qty, ts });
        return;
      }
      if (this.bids[i].price < price) {
        this.bids.splice(i, 0, { price, orders: [{ id, qty, ts }] });
        return;
      }
    }
    this.bids.push({ price, orders: [{ id, qty, ts }] });
  }

  _insertAsk(id, price, qty, ts) {
    for (let i = 0; i < this.asks.length; i++) {
      if (this.asks[i].price === price) {
        this.asks[i].orders.push({ id, qty, ts });
        return;
      }
      if (this.asks[i].price > price) {
        this.asks.splice(i, 0, { price, orders: [{ id, qty, ts }] });
        return;
      }
    }
    this.asks.push({ price, orders: [{ id, qty, ts }] });
  }

  cancelOrder(id) {
    for (const side of [this.bids, this.asks]) {
      for (let li = 0; li < side.length; li++) {
        const level = side[li];
        for (let oi = 0; oi < level.orders.length; oi++) {
          if (level.orders[oi].id === id) {
            level.orders.splice(oi, 1);
            if (level.orders.length === 0) side.splice(li, 1);
            return true;
          }
        }
      }
    }
    return false;
  }

  getSnapshot(levels = 10) {
    const bidSnap = this.bids.slice(0, levels).map(l => ({
      price: l.price,
      qty: l.orders.reduce((s, o) => s + o.qty, 0),
      count: l.orders.length
    }));
    const askSnap = this.asks.slice(0, levels).map(l => ({
      price: l.price,
      qty: l.orders.reduce((s, o) => s + o.qty, 0),
      count: l.orders.length
    }));

    const bestBid = bidSnap.length > 0 ? bidSnap[0] : null;
    const bestAsk = askSnap.length > 0 ? askSnap[0] : null;
    const spread = (bestBid && bestAsk) ? +(bestAsk.price - bestBid.price).toFixed(2) : null;
    const mid = (bestBid && bestAsk) ? +((bestBid.price + bestAsk.price) / 2).toFixed(2) : null;

    let imbalance = null;
    if (bestBid && bestAsk) {
      const total = bestBid.qty + bestAsk.qty;
      imbalance = total > 0 ? +((bestBid.qty - bestAsk.qty) / total).toFixed(4) : 0;
    }

    const vwap = this.vwapDen > 0 ? +(this.vwapNum / this.vwapDen).toFixed(2) : null;
    const lastTrade = this.trades.length > 0 ? this.trades[this.trades.length - 1] : null;

    return {
      bids: bidSnap, asks: askSnap,
      spread, mid, imbalance, vwap,
      lastPrice: lastTrade ? lastTrade.price : null,
      lastSide: lastTrade ? lastTrade.takerSide : null,
      totalTrades: this.trades.length,
      totalOrders: this.nextId - 1,
      bidLevels: this.bids.length,
      askLevels: this.asks.length
    };
  }

  getRestingQty() {
    let qty = 0;
    for (const level of this.bids) for (const o of level.orders) qty += o.qty;
    for (const level of this.asks) for (const o of level.orders) qty += o.qty;
    return qty;
  }

  getExecutedQty() {
    let qty = 0;
    for (const t of this.trades) qty += t.qty;
    return qty * 2; // each trade has a buy side and sell side
  }

  getRecentTrades(n = 50) {
    return this.trades.slice(-n);
  }

  reset() {
    this.bids = [];
    this.asks = [];
    this.trades = [];
    this.allOrders.clear();
    this.nextId = 1;
    this.totalSubmittedQty = 0;
    this.vwapNum = 0;
    this.vwapDen = 0;
  }

  runBenchmark(n = 100000) {
    const book = new OrderBook();
    const latencies = new Float64Array(n);
    const start = performance.now();
    for (let i = 0; i < n; i++) {
      const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
      const price = +(100 + (Math.random() * 20 - 10)).toFixed(2);
      const qty = 1 + Math.floor(Math.random() * 10);
      const t0 = performance.now();
      book.submitOrder(side, 'LIMIT', price, qty);
      latencies[i] = performance.now() - t0;
    }
    const elapsed = performance.now() - start;
    latencies.sort();
    return {
      orders: n,
      timeMs: +elapsed.toFixed(1),
      ordersPerSec: Math.round(n / (elapsed / 1000)),
      p50us: +(latencies[Math.floor(n * 0.5)] * 1000).toFixed(1),
      p95us: +(latencies[Math.floor(n * 0.95)] * 1000).toFixed(1),
      p99us: +(latencies[Math.floor(n * 0.99)] * 1000).toFixed(1),
      trades: book.trades.length,
      restingBids: book.bids.length,
      restingAsks: book.asks.length
    };
  }
}

// Order Flow Generator — Ornstein-Uhlenbeck mean-reverting process
class OrderFlowGenerator {
  constructor(startPrice = 100, theta = 0.05, sigma = 0.3) {
    this.fairPrice = startPrice;
    this.mu = startPrice;
    this.theta = theta;
    this.sigma = sigma;
    this.dt = 0.01;
  }

  step() {
    const dW = this._gaussRandom() * Math.sqrt(this.dt);
    this.fairPrice += this.theta * (this.mu - this.fairPrice) * this.dt + this.sigma * dW;
    this.fairPrice = Math.max(1, this.fairPrice); // floor at 1
    return this.fairPrice;
  }

  generate(id) {
    const fair = this.step();
    const isMarket = Math.random() < 0.3;
    const side = Math.random() > 0.5 ? 'BUY' : 'SELL';
    const isLarge = Math.random() < 0.05;
    const qty = isLarge
      ? Math.floor(Math.random() * 200) + 100
      : Math.floor(Math.random() * 20) + 1;

    if (isMarket) {
      return { side, type: 'MARKET', price: null, qty };
    }

    const aggression = Math.random();
    let price;
    if (side === 'BUY') {
      price = fair - 0.5 + (Math.random() - 0.5) * 2 * (1 - aggression);
    } else {
      price = fair + 0.5 + (Math.random() - 0.5) * 2 * (1 - aggression);
    }
    price = +Math.max(0.01, price).toFixed(2);

    return { side, type: 'LIMIT', price, qty };
  }

  _gaussRandom() {
    const u1 = Math.random();
    const u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

if (typeof module !== 'undefined') {
  module.exports = { OrderBook, OrderFlowGenerator };
}
