# ForexReplay

A TradingView-style **bar-replay backtesting terminal** for forex, gold and crypto.
Play the market like a video, place long/short trades, and watch take-profit / stop-loss
levels hit — with real drawing tools, 8 timeframes and 10 instruments.

Pure static site: **no build step, no backend** — open `index.html` through any HTTP server.

## Quick start

```bash
cd forex_replay
python3 -m http.server 8765
# open http://localhost:8765
```

## What it does

| Area | Features |
|---|---|
| Chart | Candles / bars / line / area, EMA 9-21-50, volume, crosshair OHLC legend, zoom (wheel), pan (drag), price-scale wheel-zoom + double-click reset |
| Timeframes | 1m · 5m · 15m · 30m · 1H · 4H · 1D · 1W (30m/4H/1D/1W derived by aggregation) |
| Instruments | EUR/USD GBP/USD USD/JPY AUD/USD USD/CAD USD/CHF NZD/USD XAU/USD BTC/USD ETH/USD |
| Drawing tools | Trend line, ray, horizontal, vertical, arrow, rectangle, Fib retracement, measure/ruler, text, **long/short position tool**, colour swatches, undo, clear, right-click delete — persisted per symbol |
| Replay | Play / pause / step ±1 bar, 1x–20x speed, timeline slider, jump-to-date, keyboard: Space ← → — **future bars are hidden** so you can't peek |
| Trading | Market / limit / stop orders, long & short, TP/SL (draggable lines on chart), risk-% position sizing, spread, leverage & margin checks, positions / pending / history panels, win-rate stats, CSV export |
| Account | Balance, equity, floating P/L, free margin, margin level — persisted in localStorage |
| Live mode | Toggle LIVE/REPLAY. Live feed: **Twelve Data** (real forex, CORS-enabled demo key) and **Binance Vision** (stablecoin/metal proxy, `Access-Control-Allow-Origin: *`). If a live feed's price level is disjoint from bundled history (e.g. futures vs spot), it is refused automatically — the chart never shows two incompatible sources. |

## Architecture

```
index.html          UI skeleton (top bar, toolbar, chart, order ticket, panels, transport)
css/style.css       TradingView-inspired dark theme
js/
  data.js           Data layer: bundled history, TF aggregation, live-feed adapters,
                    price helpers (pip value, P/L and margin conversion)
  trading.js        Trading engine: account, market/pending orders, SL/TP event stream,
                    risk-based sizing, persistence, CSV export
  chart.js          Canvas chart engine: coordinate system, candles/bars/line/area,
                    axes, crosshair, EMA, volume, markers, position lines (draggable)
  tools.js          Drawing tools: hit-testing, two-click/drag creation, selection,
                    rendering, localStorage persistence per symbol
  replay.js         Replay engine: cursor into full series, play/step/seek/speed
  ui.js             Wiring: symbol/timeframe switching, ticket, panels, transport,
                    toasts, keyboard, live/replay mode
  app.js            Boot sequence
data/
  catalog.json      Symbol metadata (digits, pip, contract, spread, live adapters)
  SYM_TF.json       Compact bars: [t_sec, o, h, l, c, v]  (~10 MB total)
scripts/
  tv_feed.py        Minimal TradingView websocket datafeed (unofficial, paged history)
  fetch_tv.py       Primary refresher — real TradingView OHLC (OANDA / Binance feeds)
  fetch_data.py     Fallback refresher via yfinance (used if TV is unreachable)
```

### Data flow

```
fetch_tv.py ──► data/*.json ──► Data.bars(sym, tf) ──► Replay.all
                                                              │ cursor (replay)
                                     Replay.visible() ◄────────┘
                                            │
                                     Chart.setSeries() ──► canvas
                                            │ new bar
                                     Trade.onBar(bar) ──► SL/TP checks ──► panels/toasts
```

### Notes on data quality

* **Source**: bundled history is **real TradingView data** — OANDA FX/XAU + Binance
  crypto, pulled over TV's websocket protocol (`scripts/tv_feed.py`). Typical depth:
  1m≈5k, 5m≈5.7k, 15m≈5.3k, 1h≈11k, 1d=2500 bars per symbol.
* **Aggregation**: 30m/4H/1W rebuilt client-side from base files; 1D loads the real
  daily file when present.
* **Live vs bundled**: live mode overlays the *last* bars only (Twelve Data /
  Binance Vision); a disjoint-feed guard refuses incompatible levels (e.g. futures
  vs spot on weekends) so the chart never stitches two sources end-to-end.
* Contract sizes: FX 100k/lot, gold 100 oz/lot, crypto 1. Spreads & leverage configurable
  in ⚙ Settings.

## Refreshing the bundled data

```bash
python3 scripts/fetch_tv.py     # real TradingView history (all symbols, ~15 min)
python3 scripts/fetch_data.py   # yfinance fallback
```

## Deployment

Static hosting only — any of: GitHub Pages, Netlify, Vercel, Cloudflare Pages,
or a local tunnel. Total payload ≈ 10 MB, largest file ≈ 490 KB (no server code needed).
