# Order Book Engine

Price-time priority matching engine with real-time depth visualization, 5 invariant proofs, and market impact simulation. Runs entirely client-side.

**[Live Demo](https://ziaulalam1.github.io/orderbook/)**

---

## The Problem

Every exchange provides an environment where price-time priority exists; the highest priced order will be executed first. If two orders are to execute at the same price point, then the order submitted earliest will be executed next. Providing such a guaranteed environment allows investors to compete fairly. When this cannot be provided, some investor has either paid too much money for their position, or had to wait too long to buy or sell.

A good matching engine could provide evidence that the rules as defined by the exchange were followed, therefore providing a fair environment for all investors. Visualizing the order flow and the behavior of the order book in near-real time also demonstrates an understanding of market microstructure at the system level, rather than simply the programming interface.

## The Decision

The engine uses a price-time priority based matching algorithm to process both limit and market orders. The three views which are viewed by traders are: Level II Depth (L2); the depth chart; and the trade tape.

The most helpful part of this application is the "Market Impact" button. It triggers a 500 quantity market order into the order book and displays how a large order moves through various price levels, consumes available liquidity and affects the price. Slippage occurs when a market order cannot move through enough available shares on each trading level. Viewing this in near-real time is far more informative than reading about it in a book.

### Architecture decisions

| Decision | Reasoning |
|----------|-----------|
| Pure JS, no framework | Fixed UI structure. React adds bundle size and render overhead in the order processing loop. For 20 price levels and a Canvas chart, framework abstraction adds cost without value. |
| Array + splice, not binary heap | Verified: 1.1M orders/sec for <100 price levels. Heap would matter at >1000 levels. At 20 levels, cache-friendly linear scan beats pointer-chasing. |
| Client-side simulation, no server | Demonstrates the algorithm without infrastructure dependencies. A production exchange would use kernel bypass (DPDK/RDMA) and hardware timestamping. |
| No ML price prediction | Order matching is deterministic. Adding ML would obscure the matching semantics, which are the point. |
| Ornstein-Uhlenbeck order flow, not uniform random | Uniform random produces unrealistic flat price distributions. O-U mean-reverts around a fair price, producing realistic spread dynamics and occasional directional moves. |
| 30% market orders (vs ~10-15% in production) | Elevated ratio creates visible matching activity in the demo. Real equity markets have lower market order ratios because institutional execution is mostly limit-based. |

## What I'd Change

The simulation runs in interpreted JavaScript. A production matching engine would need:

- **Lock-free data structures** (compare-and-swap) for concurrent order submission from multiple gateways
- **Kernel bypass** (DPDK/RDMA) to eliminate OS network stack overhead -- real exchanges achieve sub-microsecond matching
- **UDP multicast** for market data distribution instead of DOM updates
- **FIX protocol** for standardized order entry (vs the internal API used here)
- **Hardware timestamping** (NIC-level) to guarantee ordering fairness, since software timestamps can jitter by microseconds

The order flow generator uses a simplified Ornstein-Uhlenbeck process. Real order flow has fat tails, volatility clustering (GARCH-like behavior), and informed/uninformed trader segmentation. A Hawkes process would model contagion effects more accurately.

## Invariant Tests

Browser-based tests (open `tests/test_invariants.html`):

| # | Invariant | Assertion |
|---|-----------|-----------|
| 1 | Price-time priority | Given two sells at $100 (A, then B), a buy at $100 matches A first. Always. |
| 2 | No trade at worse price | Buy limit at $100 never executes against sell at $101. Sell at $99 matches at $100 (maker's price). |
| 3 | Conservation of shares | Total resting quantity + total executed quantity (both sides) = total submitted quantity. No shares created or destroyed. |
| 4 | Book always sorted | After any sequence of operations, bids are strictly descending and asks are strictly ascending. |
| 5 | Empty book rejection | Market order against empty opposite side is explicitly rejected, not silently dropped. |

## Performance

Built-in benchmark (100,000 random limit orders):

| Metric | Value |
|--------|-------|
| Throughput | 1.1M orders/sec |
| p50 latency | <1 us |
| p95 latency | ~1 us |
| p99 latency | ~4 us |

Measured in V8 (Node.js/Chrome). The bottleneck in the browser demo is Canvas rendering, not matching.

## Transferable Pattern

Order matching (two-sided priority queue with price-time semantics) applies directly to:

- **Ad auctions**: second-price auction is a degenerate order book with one ask per impression
- **Ride-sharing**: driver supply vs rider demand, matched by price and proximity
- **Energy markets**: merit-order dispatch matches generation bids against demand forecast
- **Dark pools**: same matching logic, different pre-trade disclosure rules
- **Any two-sided marketplace**: the fundamental pattern is priority-queue matching with domain-specific tiebreakers

## Running Locally

```
open index.html
```

No build step. No dependencies. No server.

## Tech

- JavaScript (ES6+), HTML5 Canvas, CSS Grid
- Zero dependencies
- Retina-aware Canvas rendering
- 60fps depth chart via requestAnimationFrame
