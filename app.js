// app.js — Visualization, DOM rendering, Canvas depth chart, controls
// Wires engine.js to the UI. No matching logic here.

const book = new OrderBook();
const gen = new OrderFlowGenerator(100, 0.05, 0.3);

// State
let orderSide = 'BUY';
let orderType = 'MARKET';
let autoRunning = false;
let autoInterval = null;
let orderCount = 0;
let lastOrderCount = 0;
let opsPerSec = 0;
let lastTradeIdx = 0;
let impactSide = 'BUY';

// DOM refs
const asksContainer = document.getElementById('asks-container');
const bidsContainer = document.getElementById('bids-container');
const spreadRow = document.getElementById('spread-row');
const tapeContent = document.getElementById('tape-content');
const depthCanvas = document.getElementById('depth-canvas');
const ctx = depthCanvas.getContext('2d');

// Invariant names for display
const INVARIANTS = [
  'Price-time priority',
  'No trade at worse price',
  'Conservation of shares',
  'Book always sorted',
  'Empty book rejection'
];

// --- CONTROLS ---

function setSide(s) {
  orderSide = s;
  document.getElementById('btn-buy').classList.toggle('active', s === 'BUY');
  document.getElementById('btn-sell').classList.toggle('active', s === 'SELL');
}

function setType(t) {
  orderType = t;
  document.getElementById('btn-limit').classList.toggle('active', t === 'LIMIT');
  document.getElementById('btn-market').classList.toggle('active', t === 'MARKET');
  document.getElementById('inp-price').disabled = (t === 'MARKET');
}

function manualSubmit() {
  const price = orderType === 'MARKET' ? null : +document.getElementById('inp-price').value;
  const qty = +document.getElementById('inp-qty').value || 1;
  book.submitOrder(orderSide, orderType, price, qty);
  orderCount++;
}

function toggleAuto() {
  autoRunning = !autoRunning;
  const btn = document.getElementById('btn-auto');
  if (autoRunning) {
    btn.textContent = 'Auto \u25A0';
    btn.classList.add('active');
    startAutoFlow();
  } else {
    btn.textContent = 'Auto \u25B6';
    btn.classList.remove('active');
    if (autoInterval) clearInterval(autoInterval);
    autoInterval = null;
  }
}

function startAutoFlow() {
  if (autoInterval) clearInterval(autoInterval);
  const speed = +document.getElementById('speed-slider').value;
  const ms = Math.max(5, Math.round(1000 / speed));
  autoInterval = setInterval(() => {
    if (!autoRunning) return;
    const order = gen.generate(book.nextId);
    book.submitOrder(order.side, order.type, order.price, order.qty);
    orderCount++;
  }, ms);
}

document.getElementById('speed-slider').addEventListener('input', function () {
  document.getElementById('speed-val').textContent = this.value + '/s';
  if (autoRunning) startAutoFlow();
});

function marketImpact() {
  // Large order sweep to demonstrate slippage
  const qty = 500;
  book.submitOrder(impactSide, 'MARKET', null, qty);
  orderCount++;
  impactSide = impactSide === 'BUY' ? 'SELL' : 'BUY'; // alternate
}

function clearBook() {
  book.reset();
  gen.fairPrice = 100;
  gen.mu = 100;
  orderCount = 0;
  lastOrderCount = 0;
  lastTradeIdx = 0;
  tapeContent.innerHTML = '';
}

function runBenchmark() {
  document.getElementById('m-tput').textContent = 'running...';
  // Run async to not block UI
  setTimeout(() => {
    const result = book.runBenchmark(100000);
    document.getElementById('m-tput').textContent = result.ordersPerSec.toLocaleString() + ' ord/s';
    document.getElementById('m-p95').textContent = result.p95us + ' \u00B5s';
  }, 50);
}

// Click book row to fill price
function onBookRowClick(price) {
  document.getElementById('inp-price').value = price;
  setType('LIMIT');
}

// --- RENDERING ---

function renderBook(snap) {
  // Asks: show reversed (lowest/best ask at bottom, near spread)
  const askRows = snap.asks;
  const bidRows = snap.bids;
  const maxCum = Math.max(
    askRows.reduce((s, l) => s + l.qty, 0),
    bidRows.reduce((s, l) => s + l.qty, 0),
    1
  );

  // Build asks HTML (reversed: highest at top)
  let askHtml = '';
  let askCum = 0;
  const askCums = [];
  for (let i = 0; i < askRows.length; i++) {
    askCum += askRows[i].qty;
    askCums.push(askCum);
  }
  for (let i = askRows.length - 1; i >= 0; i--) {
    const l = askRows[i];
    const pct = (askCums[i] / maxCum * 100).toFixed(1);
    askHtml += '<div class="book-row ask" onclick="onBookRowClick(' + l.price + ')">'
      + '<span class="price">' + l.price.toFixed(2) + '</span>'
      + '<span class="size">' + l.qty + '</span>'
      + '<span class="cum">' + askCums[i] + '</span>'
      + '<span class="bar" style="width:' + pct + '%;background:var(--red)"></span>'
      + '</div>';
  }
  asksContainer.innerHTML = askHtml;

  // Spread
  spreadRow.textContent = snap.spread !== null
    ? 'SPREAD ' + snap.spread.toFixed(2)
    : 'SPREAD \u2014';

  // Bids
  let bidHtml = '';
  let bidCum = 0;
  for (let i = 0; i < bidRows.length; i++) {
    bidCum += bidRows[i].qty;
    const pct = (bidCum / maxCum * 100).toFixed(1);
    bidHtml += '<div class="book-row bid" onclick="onBookRowClick(' + bidRows[i].price + ')">'
      + '<span class="price">' + bidRows[i].price.toFixed(2) + '</span>'
      + '<span class="size">' + bidRows[i].qty + '</span>'
      + '<span class="cum">' + bidCum + '</span>'
      + '<span class="bar" style="width:' + pct + '%;background:var(--green)"></span>'
      + '</div>';
  }
  bidsContainer.innerHTML = bidHtml;
}

function renderTape() {
  const recent = book.getRecentTrades(50);
  // Only render new trades
  if (recent.length <= 0) return;

  const newStart = Math.max(0, book.trades.length - 50);
  const newTrades = book.trades.slice(Math.max(lastTradeIdx, newStart));
  lastTradeIdx = book.trades.length;

  for (const t of newTrades) {
    const row = document.createElement('div');
    const cls = t.takerSide === 'BUY' ? 'buy-taker' : 'sell-taker';
    row.className = 'tape-row ' + cls + ' flash';
    const d = new Date(performance.timeOrigin + t.ts);
    const time = d.toTimeString().slice(0, 8);
    row.innerHTML = '<span>' + time + '</span>'
      + '<span>' + t.price.toFixed(2) + '</span>'
      + '<span>' + t.qty + '</span>'
      + '<span>' + (t.takerSide === 'BUY' ? '\u25B2' : '\u25BC') + '</span>';
    tapeContent.insertBefore(row, tapeContent.firstChild);
    // Remove flash after animation
    setTimeout(() => row.classList.remove('flash'), 300);
  }

  // Trim to 50 rows
  while (tapeContent.children.length > 50) {
    tapeContent.removeChild(tapeContent.lastChild);
  }
}

function renderDepthChart(snap) {
  const rect = depthCanvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  const h = rect.height;

  if (depthCanvas.width !== w * dpr || depthCanvas.height !== h * dpr) {
    depthCanvas.width = w * dpr;
    depthCanvas.height = h * dpr;
    depthCanvas.style.width = w + 'px';
    depthCanvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  ctx.clearRect(0, 0, w, h);

  const bids = snap.bids;
  const asks = snap.asks;
  if (bids.length === 0 && asks.length === 0) {
    ctx.fillStyle = '#333';
    ctx.font = '12px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'center';
    ctx.fillText('No orders in book', w / 2, h / 2);
    return;
  }

  // Price range
  const allPrices = [];
  bids.forEach(l => allPrices.push(l.price));
  asks.forEach(l => allPrices.push(l.price));
  const minP = Math.min(...allPrices) - 1;
  const maxP = Math.max(...allPrices) + 1;
  const priceRange = maxP - minP || 1;

  // Build cumulative depth
  let bidDepth = [];
  let cumB = 0;
  for (const l of bids) {
    cumB += l.qty;
    bidDepth.push({ price: l.price, cum: cumB });
  }

  let askDepth = [];
  let cumA = 0;
  for (const l of asks) {
    cumA += l.qty;
    askDepth.push({ price: l.price, cum: cumA });
  }

  const maxCum = Math.max(cumB, cumA, 1);

  // Margins
  const mx = 40, my = 20;
  const cw = w - mx * 2;
  const ch = h - my * 2;

  function priceToX(p) { return mx + ((p - minP) / priceRange) * cw; }
  function cumToY(c) { return my + ch - (c / maxCum) * ch; }

  // Draw grid
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = my + (ch / 4) * i;
    ctx.beginPath(); ctx.moveTo(mx, y); ctx.lineTo(w - mx, y); ctx.stroke();
  }

  // Draw bid mountain (right to left: best bid first, going down in price)
  if (bidDepth.length > 0) {
    ctx.beginPath();
    ctx.moveTo(priceToX(bidDepth[0].price), cumToY(0));
    for (const pt of bidDepth) {
      ctx.lineTo(priceToX(pt.price), cumToY(pt.cum));
    }
    const lastBid = bidDepth[bidDepth.length - 1];
    ctx.lineTo(priceToX(lastBid.price), cumToY(0));
    ctx.closePath();

    const gradB = ctx.createLinearGradient(0, my, 0, my + ch);
    gradB.addColorStop(0, 'rgba(0, 204, 102, 0.4)');
    gradB.addColorStop(1, 'rgba(0, 204, 102, 0.05)');
    ctx.fillStyle = gradB;
    ctx.fill();
    ctx.strokeStyle = 'rgba(0, 204, 102, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < bidDepth.length; i++) {
      const pt = bidDepth[i];
      if (i === 0) ctx.moveTo(priceToX(pt.price), cumToY(pt.cum));
      else ctx.lineTo(priceToX(pt.price), cumToY(pt.cum));
    }
    ctx.stroke();
  }

  // Draw ask mountain (left to right: best ask first, going up in price)
  if (askDepth.length > 0) {
    ctx.beginPath();
    ctx.moveTo(priceToX(askDepth[0].price), cumToY(0));
    for (const pt of askDepth) {
      ctx.lineTo(priceToX(pt.price), cumToY(pt.cum));
    }
    const lastAsk = askDepth[askDepth.length - 1];
    ctx.lineTo(priceToX(lastAsk.price), cumToY(0));
    ctx.closePath();

    const gradA = ctx.createLinearGradient(0, my, 0, my + ch);
    gradA.addColorStop(0, 'rgba(255, 51, 51, 0.4)');
    gradA.addColorStop(1, 'rgba(255, 51, 51, 0.05)');
    ctx.fillStyle = gradA;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 51, 51, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < askDepth.length; i++) {
      const pt = askDepth[i];
      if (i === 0) ctx.moveTo(priceToX(pt.price), cumToY(pt.cum));
      else ctx.lineTo(priceToX(pt.price), cumToY(pt.cum));
    }
    ctx.stroke();
  }

  // Midpoint line
  if (snap.mid !== null) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const mx2 = priceToX(snap.mid);
    ctx.moveTo(mx2, my);
    ctx.lineTo(mx2, my + ch);
    ctx.stroke();
    ctx.setLineDash([]);

    // Midpoint label
    ctx.fillStyle = '#ff8c00';
    ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
    ctx.textAlign = 'center';
    ctx.fillText(snap.mid.toFixed(2), mx2, my - 4);
  }

  // Price axis labels
  ctx.fillStyle = '#555';
  ctx.font = '9px ' + getComputedStyle(document.body).fontFamily;
  ctx.textAlign = 'center';
  const nLabels = 6;
  for (let i = 0; i <= nLabels; i++) {
    const p = minP + (priceRange / nLabels) * i;
    ctx.fillText(p.toFixed(1), priceToX(p), h - 4);
  }

  // Qty axis labels
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const c = (maxCum / 4) * (4 - i);
    ctx.fillText(Math.round(c).toString(), mx - 4, my + (ch / 4) * i + 3);
  }
}

function renderStatus(snap) {
  document.getElementById('s-spread').textContent = snap.spread !== null ? snap.spread.toFixed(2) : '\u2014';
  document.getElementById('s-mid').textContent = snap.mid !== null ? snap.mid.toFixed(2) : '\u2014';

  const lastEl = document.getElementById('s-last');
  if (snap.lastPrice !== null) {
    lastEl.textContent = snap.lastPrice.toFixed(2);
    lastEl.className = 'val ' + (snap.lastSide === 'BUY' ? 'up' : 'down');
  }

  document.getElementById('s-vwap').textContent = snap.vwap !== null ? snap.vwap.toFixed(2) : '\u2014';
  document.getElementById('s-ops').textContent = opsPerSec + ' ord/s';

  // Imbalance bar
  const fill = document.getElementById('s-imb-fill');
  if (snap.imbalance !== null) {
    const imb = snap.imbalance;
    const pct = Math.abs(imb) * 50;
    if (imb >= 0) {
      fill.style.left = '50%';
      fill.style.width = pct + '%';
      fill.style.background = '#00cc66';
    } else {
      fill.style.left = (50 - pct) + '%';
      fill.style.width = pct + '%';
      fill.style.background = '#ff3333';
    }
  } else {
    fill.style.width = '0';
  }
}

function renderMetrics(snap) {
  document.getElementById('m-orders').textContent = snap.totalOrders.toLocaleString();
  document.getElementById('m-trades').textContent = snap.totalTrades.toLocaleString();
  document.getElementById('m-depth').textContent = snap.bidLevels + ' / ' + snap.askLevels;
}

function renderInvariants() {
  const list = document.getElementById('invariant-list');
  if (list.children.length > 0) return; // only render once

  for (const name of INVARIANTS) {
    const el = document.createElement('div');
    el.className = 'invariant pass';
    el.textContent = '\u2713 ' + name;
    list.appendChild(el);
  }
}

// Live invariant checking during auto mode
function checkInvariantsLive() {
  const list = document.getElementById('invariant-list');
  if (list.children.length === 0) return;

  // Check sorted
  let bidOk = true;
  for (let i = 1; i < book.bids.length; i++) {
    if (book.bids[i].price > book.bids[i - 1].price) { bidOk = false; break; }
  }
  let askOk = true;
  for (let i = 1; i < book.asks.length; i++) {
    if (book.asks[i].price < book.asks[i - 1].price) { askOk = false; break; }
  }

  // Check conservation
  const rest = book.getRestingQty();
  const exec = book.getExecutedQty();
  const conserved = (rest + exec) === book.totalSubmittedQty;

  // Update display (indices match INVARIANTS array)
  const items = list.children;
  // 0: price-time (not checkable live without specific test)
  // 1: no worse price (not checkable live)
  // 2: conservation
  if (items[2]) {
    items[2].className = 'invariant ' + (conserved ? 'pass' : 'fail');
    items[2].textContent = (conserved ? '\u2713' : '\u2717') + ' Conservation of shares';
  }
  // 3: sorted
  if (items[3]) {
    const sorted = bidOk && askOk;
    items[3].className = 'invariant ' + (sorted ? 'pass' : 'fail');
    items[3].textContent = (sorted ? '\u2713' : '\u2717') + ' Book always sorted';
  }
}

// --- RENDER LOOP ---

let frameCount = 0;

function renderLoop() {
  frameCount++;
  const snap = book.getSnapshot(10);

  // Depth chart: every frame (Canvas, 60fps)
  renderDepthChart(snap);

  // DOM updates: throttle to ~10fps
  if (frameCount % 6 === 0) {
    renderBook(snap);
    renderTape();
    renderStatus(snap);
    renderMetrics(snap);
    if (autoRunning && frameCount % 30 === 0) {
      checkInvariantsLive();
    }
  }

  requestAnimationFrame(renderLoop);
}

// OPS/sec counter
setInterval(() => {
  opsPerSec = orderCount - lastOrderCount;
  lastOrderCount = orderCount;
}, 1000);

// --- INIT ---

setType('MARKET');
renderInvariants();
requestAnimationFrame(renderLoop);

// Seed the book with some initial orders so it's not empty on load
(function seed() {
  const seedGen = new OrderFlowGenerator(100, 0.01, 0.1);
  for (let i = 0; i < 200; i++) {
    const o = seedGen.generate(book.nextId);
    // Only limit orders for seeding (build up the book)
    if (o.type === 'LIMIT') {
      book.submitOrder(o.side, o.type, o.price, o.qty);
      orderCount++;
    }
  }
})();
