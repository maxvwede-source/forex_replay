/* Data layer: bundled history, timeframe aggregation, live-feed adapters */
(function (global) {
  "use strict";

  const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800 };
  const BASE_TF = ["1m", "5m", "15m", "1h", "1d"];

  // symbol meta defaults: contract size, quote ccy, typical spread (pips), live adapters
  const EXTRA = {
    EURUSD: { contract: 100000, quote: "USD", spread: 0.7, td: "EUR/USD", bn: "EURUSDT" },
    GBPUSD: { contract: 100000, quote: "USD", spread: 1.0, bn: "GBPUSDT" },
    USDJPY: { contract: 100000, quote: "JPY", spread: 0.9, td: "USD/JPY" },
    AUDUSD: { contract: 100000, quote: "USD", spread: 1.1, bn: "AUDUSDT" },
    USDCAD: { contract: 100000, quote: "CAD", spread: 1.3 },
    USDCHF: { contract: 100000, quote: "CHF", spread: 1.4 },
    NZDUSD: { contract: 100000, quote: "USD", spread: 1.5, bn: "NZDUSDT" },
    XAUUSD: { contract: 100, quote: "USD", spread: 3.0, bn: "PAXGUSDT" },
    BTCUSD: { contract: 1, quote: "USD", spread: 6.0, td: "BTC/USD", bn: "BTCUSDT" },
    ETHUSD: { contract: 1, quote: "USD", spread: 3.0, bn: "ETHUSDT" },
  };

  const Data = {
    catalog: null,
    symbols: {},          // id -> meta
    cache: {},            // "SYM_tf" -> bars[]
    live: { timer: null, symbol: null, tf: null, cb: null, source: null, seq: 0 },
    blocked: {},   // "SYM_tf" -> feed level incompatible with bundled history
    lastAsOf: {},

    async init() {
      const r = await fetch("data/catalog.json");
      this.catalog = await r.json();
      for (const s of this.catalog.symbols) {
        Object.assign(s, EXTRA[s.id] || {});
        s.pip = s.pip || 0.0001;
        this.symbols[s.id] = s;
      }
      return this.catalog;
    },

    meta(id) { return this.symbols[id]; },

    /* ---------- history ---------- */
    async bars(symbol, tf) {
      const key = symbol + "_" + tf;
      if (this.cache[key]) return this.cache[key];
      const meta = this.symbols[symbol];
      if (!meta) throw new Error("unknown symbol " + symbol);
      let out;

      if (tf === "1W") {
        out = this._aggregateWeeks(await this.bars(symbol, "1D"));
      } else if (tf === "1D") {
        // Yahoo FX daily bars carry open≈close (useless for candles), so FX
        // dailies are rebuilt by aggregating the healthy hourly series in UTC
        // day buckets; metals/crypto daily files are genuine OHLC.
        if (meta.cat === "forex")
          out = this._aggregate(await this._load(symbol, "1h"), TF_SEC["1D"]);
        else
          out = await this._load(symbol, "1d");
      } else if (tf === "30m") {
        out = this._aggregate(await this._load(symbol, "15m"), TF_SEC["30m"]);
      } else if (tf === "4h") {
        out = this._aggregate(await this._load(symbol, "1h"), TF_SEC["4h"]);
      } else {
        out = await this._load(symbol, tf);
      }

      this.cache[key] = out;
      return out;
    },

    async _load(symbol, base) {
      const rawKey = symbol + "_" + base;
      if (this.cache[rawKey]) return this.cache[rawKey];
      const meta = this.symbols[symbol];
      const file = meta && meta.files && meta.files[base];
      if (!file) throw new Error("no data for " + symbol + " " + base);
      const r = await fetch("data/" + file);
      if (!r.ok) throw new Error("fetch failed " + file);
      const j = await r.json();
      const bars = j.bars.map((b) => ({ t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
      this.cache[rawKey] = bars;
      this.lastAsOf[symbol] = bars[bars.length - 1].t;
      return bars;
    },

    _aggregate(bars, span) {
      const out = [];
      let cur = null;
      for (const b of bars) {
        const slot = Math.floor(b.t / span) * span;
        if (!cur || cur.t !== slot) {
          if (cur) out.push(cur);
          cur = { t: slot, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        } else {
          cur.h = Math.max(cur.h, b.h);
          cur.l = Math.min(cur.l, b.l);
          cur.c = b.c;
          cur.v += b.v;
        }
      }
      if (cur) out.push(cur);
      return out;
    },

    _aggregateWeeks(bars) {
      const out = [];
      let cur = null;
      for (const b of bars) {
        const d = new Date(b.t * 1000);
        const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
        const slot = Math.floor(b.t / 86400) * 86400 - dow * 86400;
        if (!cur || cur.t !== slot) {
          if (cur) out.push(cur);
          cur = { t: slot, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
        } else {
          cur.h = Math.max(cur.h, b.h);
          cur.l = Math.min(cur.l, b.l);
          cur.c = b.c;
          cur.v += b.v;
        }
      }
      if (cur) out.push(cur);
      return out;
    },

    /* merge freshly fetched bars into the cache for tf (in place) */
    mergeLive(symbol, tf, fresh) {
      const key = symbol + "_" + tf;
      const arr = this.cache[key];
      if (!arr || !arr.length) return false;
      // continuity guard: a live feed whose price level is disjoint from bundled
      // history (e.g. futures vs spot, weekend gaps) is refused so the chart
      // never renders two incompatible sources end-to-end.
      const lastT = arr[arr.length - 1].t;
      const nxt = fresh.filter((b) => b.t > lastT).sort((a, b) => a.t - b.t)[0];
      if (nxt) {
        const meta = this.symbols[symbol];
        const limit = meta.cat === "crypto" ? 0.02 : 0.004;
        if (Math.abs(nxt.c - arr[arr.length - 1].c) / arr[arr.length - 1].c > limit) {
          this.blocked[key] = true;
          return "disjoint";
        }
      }
      const idx = new Map();
      for (const b of fresh) idx.set(b.t, b);
      let changed = false;
      for (let i = 0; i < arr.length; i++) {
        if (idx.has(arr[i].t)) { arr[i] = idx.get(arr[i].t); changed = true; }
      }
      const last = arr[arr.length - 1].t;
      for (const b of fresh) {
        if (b.t > last) { arr.push(b); changed = true; }
      }
      if (changed) this.lastAsOf[symbol] = arr[arr.length - 1].t;
      return changed;
    },

    /* ---------- live feeds ---------- */
    startLive(symbol, tf, cb) {
      this.stopLive();
      const meta = this.symbols[symbol];
      if (!meta) return;
      const src = meta.td ? "twelvedata" : (meta.bn ? "binance" : null);
      this.live.cb = cb;
      if (!src || this.blocked[symbol + "_" + tf]) { this.live.source = null; return; }
      const tick = async () => {
        try {
          const fresh = src === "twelvedata"
            ? await this._fetchTwelveData(meta, tf)
            : await this._fetchBinance(meta, tf);
          if (fresh && fresh.length) {
            const ok = this.mergeLive(symbol, tf, fresh);
            if (ok === "disjoint") {
              const bars = this.cache[symbol + "_" + tf];
              this.live.source = null;
              if (this.live.cb) this.live.cb(bars, "disjoint");
              this.stopLive();
              this.live.cb = cb;
              return;
            }
            if (ok && this.live.cb) this.live.cb(this.cache[symbol + "_" + tf], src);
          }
        } catch (e) { /* silent — feed falls back to bundled data */ }
      };
      this.live.source = src;
      tick();
      this.live.timer = setInterval(tick, src === "twelvedata" ? 15000 : 6000);
    },

    stopLive() {
      if (this.live.timer) clearInterval(this.live.timer);
      this.live.timer = null;
      this.live.symbol = null;
      this.live.source = null;
      this.live.cb = null;
    },

    async _fetchTwelveData(meta, tf) {
      const iv = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1D": "1day", "1W": "1week" }[tf];
      const url = "https://api.twelvedata.com/time_series?symbol=" + meta.td +
        "&interval=" + iv + "&outputsize=12&apikey=demo&format=JSON";
      const r = await fetch(url);
      if (!r.ok) throw new Error("td " + r.status);
      const j = await r.json();
      if (j.status !== "ok" || !j.values) throw new Error(j.message || "td error");
      const digits = meta.digits;
      const sec = TF_SEC[tf];
      const rows = j.values.map((v) => {
        const t = Math.floor(Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000);
        return {
          t: Math.floor(t / sec) * sec,
          o: +(+v.open).toFixed(digits), h: +(+v.high).toFixed(digits),
          l: +(+v.low).toFixed(digits), c: +(+v.close).toFixed(digits), v: +(v.volume || 0),
        };
      });
      return rows.sort((a, b) => a.t - b.t);
    },

    async _fetchBinance(meta, tf) {
      const iv = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h", "4h": "4h", "1D": "1d", "1W": "1w" }[tf];
      const url = "https://data-api.binance.vision/api/v3/klines?symbol=" + meta.bn +
        "&interval=" + iv + "&limit=30";
      const r = await fetch(url);
      if (!r.ok) throw new Error("bn " + r.status);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error("bn error");
      const digits = meta.digits;
      return j.map((k) => ({
        t: Math.floor(k[0] / 1000),
        o: +(+k[1]).toFixed(digits), h: +(+k[2]).toFixed(digits),
        l: +(+k[3]).toFixed(digits), c: +(+k[4]).toFixed(digits), v: +(+k[5]).toFixed(2),
      }));
    },

    /* ---------- pricing helpers ---------- */
    spreadPrice(symbol) { return (this.symbols[symbol].spread || 1) * this.symbols[symbol].pip; },

    async _rate(symbol) { // price of a catalog symbol (for cross conversions)
      try {
        const arr = this.cache[symbol + "_1h"] || this.cache[symbol + "_1D"] || await this.bars(symbol, "1h");
        return arr[arr.length - 1].c;
      } catch (e) { return null; }
    },

    /* P/L in USD for a completed move */
    async pnlUSD(symbol, dir, entry, exit) {
      const m = this.symbols[symbol];
      const raw = (exit - entry) * dir * m.contract;
      if (m.quote === "USD") return raw;
      const r = await this._rate("USD" + m.quote);
      return r ? raw / r : null;
    },

    /* notional in USD for margin */
    async notionalUSD(symbol, lots, price) {
      const m = this.symbols[symbol];
      if (m.quote === "USD") return m.contract * lots * price;   // XXX/USD: price is USD per unit
      if (m.id === "USDJPY" || m.id === "USDCAD" || m.id === "USDCHF") return m.contract * lots; // USD base
      const r = await this._rate("USD" + m.quote);
      return r ? (m.contract * lots * price) / r : m.contract * lots * price;
    },

    pips(symbol, diff) { return diff / this.symbols[symbol].pip; },
  };

  global.Data = Data;
})(window);
