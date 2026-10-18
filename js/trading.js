/* Trading engine: account, market & pending orders, SL/TP, positions, history */
(function (global) {
  "use strict";

  const Trade = {
    positions: [],
    orders: [],
    history: [],
    balance: 10000,
    startBalance: 10000,
    settings: { lev: 100, spreadPips: 0.8 },
    priceProvider: null,   // (symbol) => mid price
    onUpdate: null,        // (type, info) => void
    _nextId: 1,
    _uid: 1,

    init(opts) {
      opts = opts || {};
      this.startBalance = opts.balance || 10000;
      this.balance = this.startBalance;
      this.settings.lev = opts.lev || 100;
      this.settings.spreadPips = opts.spreadPips != null ? opts.spreadPips : 0.8;
      this.positions = []; this.orders = []; this.history = [];
      this._nextId = 1;
      this.load();
      this.emit("reset");
    },

    reset() {
      this.balance = this.startBalance;
      this.positions = []; this.orders = []; this.history = [];
      this._nextId = 1;
      this.save(); this.emit("reset");
    },

    emit(type, info) { if (this.onUpdate) this.onUpdate(type, info); },

    _id() { return this._nextId++; },

    /* ---------- pricing ---------- */
    spread(symbol) {
      const m = Data.meta(symbol);
      return (m.spread != null ? m.spread : this.settings.spreadPips) * m.pip;
    },
    quote(symbol, side) { // executable prices
      const mid = this.priceProvider ? this.priceProvider(symbol) : null;
      if (mid == null) return null;
      const s = this.spread(symbol) / 2;
      const bid = mid - s, ask = mid + s;
      return side === "buy" ? ask : bid;
    },

    /* ---------- orders ---------- */
    async place(o) {
      const m = Data.meta(o.symbol);
      if (!m) return { err: "unknown symbol" };
      const lots = Math.round(Math.min(Math.max(+o.lots || 0.01, 0.01), 100) * 100) / 100;
      const type = o.type || "market";

      if (type !== "market") {
        const px = +o.price;
        if (!isFinite(px) || px <= 0) return { err: "set a valid trigger price" };
        const cur = this.quote(o.symbol, "buy");
        if (type === "limit" && ((o.side === "buy" && px >= cur) || (o.side === "sell" && px <= cur)))
          return { err: "limit price must be better than current price" };
        if (type === "stop" && ((o.side === "buy" && px <= cur) || (o.side === "sell" && px >= cur)))
          return { err: "stop price must be beyond current price" };
        const ord = {
          id: this._id(), symbol: o.symbol, side: o.side, lots, type,
          price: px, sl: o.sl || null, tp: o.tp || null, t: this.now(),
        };
        this.orders.push(ord);
        this.save(); this.emit("order", ord);
        return { ok: true, order: ord };
      }

      // market
      const px = this.quote(o.symbol, o.side);
      if (px == null) return { err: "no price feed" };
      const notional = await Data.notionalUSD(o.symbol, lots, px);
      const need = notional / this.settings.lev;
      if (need > this.freeMargin()) return { err: "not enough free margin (need ≈ $" + need.toFixed(0) + ")" };

      if (o.sl && o.tp) {
        if (o.side === "buy" && (o.sl >= px || o.tp <= px)) return { err: "SL/TP on wrong side of price" };
        if (o.side === "sell" && (o.sl <= px || o.tp >= px)) return { err: "SL/TP on wrong side of price" };
      }
      const pos = this._open(o.symbol, o.side, lots, px, o.sl || null, o.tp || null, o.src || "market");
      return { ok: true, position: pos };
    },

    _open(symbol, side, lots, price, sl, tp, src) {
      const pos = {
        id: this._id(), symbol, side, lots, entry: price, t: this.now(),
        sl: sl || null, tp: tp || null, src: src || "market", dep: 0,
      };
      this.positions.push(pos);
      this.emit("open", pos);
      return pos;
    },

    async close(id, reason) {
      const i = this.positions.findIndex((p) => p.id === id);
      if (i < 0) return;
      const p = this.positions[i];
      const px = this.quote(p.symbol, p.side === "buy" ? "sell" : "buy");
      if (px == null) return;
      this.positions.splice(i, 1);
      const usd = await Data.pnlUSD(p.symbol, p.side === "buy" ? 1 : -1, p.entry, px);
      const pips = Data.pips(p.symbol, (px - p.entry) * (p.side === "buy" ? 1 : -1));
      this.balance += usd;
      const rec = {
        id: p.id, symbol: p.symbol, side: p.side, lots: p.lots,
        entry: p.entry, exit: px, sl: p.sl, tp: p.tp,
        tIn: p.t, tOut: this.now(), pnl: usd, pips,
        reason: reason || "manual",
      };
      this.history.unshift(rec);
      this.save(); this.emit("close", rec);
    },

    modify(id, sl, tp) {
      const p = this.positions.find((x) => x.id === id);
      if (!p) return { err: "position not found" };
      p.sl = sl || null; p.tp = tp || null;
      this.save(); this.emit("modify", p);
      return { ok: true };
    },

    cancel(id) {
      const i = this.orders.findIndex((o) => o.id === id);
      if (i < 0) return;
      const o = this.orders[i];
      this.orders.splice(i, 1);
      this.save(); this.emit("cancel", o);
    },

    /* ---------- event stream (called by replay / live on every new bar) ---------- */
    async onBar(bar) {
      // 1) trigger pending orders
      for (let i = this.orders.length - 1; i >= 0; i--) {
        const o = this.orders[i];
        const trig = o.type === "limit"
          ? (o.side === "buy" ? bar.l <= o.price : bar.h >= o.price)
          : (o.side === "buy" ? bar.h >= o.price : bar.l <= o.price);
        if (!trig) continue;
        let fill = o.price;
        if (o.side === "buy") fill = bar.o <= o.price ? Math.min(bar.o, o.price) : o.price;
        else fill = bar.o >= o.price ? Math.max(bar.o, o.price) : o.price;
        fill = +fill.toFixed(Data.meta(o.symbol).digits);
        this.orders.splice(i, 1);
        const notional = await Data.notionalUSD(o.symbol, o.lots, fill);
        if (notional / this.settings.lev > this.freeMargin()) { this.emit("reject", o); continue; }
        this._open(o.symbol, o.side, o.lots, fill, o.sl, o.tp, o.type);
        // same-bar SL/TP check for freshly filled pending order
        if (o.sl) {
          const hit = o.side === "buy" ? bar.l <= o.sl : bar.h >= o.sl;
          if (hit) { await this._closeById(this.positions[this.positions.length - 1].id, "SL", true); }
        }
      }
      // 2) SL/TP for open positions (conservative: if both hit in one bar -> SL)
      for (const p of [...this.positions]) {
        const buy = p.side === "buy";
        const slHit = p.sl && (buy ? bar.l <= p.sl : bar.h >= p.sl);
        const tpHit = p.tp && (buy ? bar.h >= p.tp : bar.l <= p.tp);
        if (slHit) { await this._closeById(p.id, "SL", true); continue; }
        if (tpHit) { await this._closeById(p.id, "TP", true); }
      }
    },

    async _closeById(id, reason) { await this.close(id, reason); },

    /* ---------- account ---------- */
    now() { return Trade.timeNow ? Trade.timeNow() : Date.now() / 1000; },

    floating() {
      let sum = 0;
      for (const p of this.positions) {
        const px = this.quote(p.symbol, p.side === "buy" ? "sell" : "buy");
        if (px == null) continue;
        const m = Data.meta(p.symbol);
        let raw = (px - p.entry) * (p.side === "buy" ? 1 : -1) * m.contract * p.lots;
        if (m.quote !== "USD") {
          const r = this._conv(m.quote);
          raw = r ? raw / r : raw;
        }
        sum += raw;
      }
      return sum;
    },
    _conv(ccy) {
      const m = Data.meta("USD" + ccy);
      if (!m || !m.id) return null;
      const arr = Data.cache["USD" + ccy + "_1h"] || Data.cache["USD" + ccy + "_1D"];
      if (arr && arr.length) return arr[arr.length - 1].c;
      return this._convCache && this._convCache[ccy];
    },
    equity() { return this.balance + this.floating(); },
    usedMargin() {
      let sum = 0;
      for (const p of this.positions) {
        const px = this.quote(p.symbol, "buy") || p.entry;
        const n = Data.symbols[p.symbol].quote === "USD"
          ? Data.symbols[p.symbol].contract * p.lots * px
          : Data.symbols[p.symbol].contract * p.lots;
        sum += n / this.settings.lev;
      }
      return sum;
    },
    freeMargin() { return this.equity() - this.usedMargin(); },
    marginLevel() { const u = this.usedMargin(); return u > 0 ? (this.equity() / u) * 100 : null; },

    /* risk-based lot size */
    async lotsForRisk(symbol, riskPct, slPrice, entry) {
      const m = Data.meta(symbol);
      const riskUSD = (this.balance * riskPct) / 100;
      const dist = Math.abs((slPrice || 0) - (entry || 0));
      if (!dist) return null;
      let perLot = dist * m.contract;
      if (m.quote !== "USD") {
        const r = this._conv(m.quote);
        if (r) perLot = perLot / r;
      }
      if (!perLot) return null;
      return Math.max(0.01, Math.floor((riskUSD / perLot) * 100) / 100);
    },

    /* ---------- persistence ---------- */
    save() {
      try {
        localStorage.setItem("fr_acct", JSON.stringify({
          balance: this.balance, start: this.startBalance, s: this.settings,
          positions: this.positions, orders: this.orders, history: this.history.slice(0, 200),
          next: this._nextId,
        }));
      } catch (e) {}
    },
    load() {
      try {
        const raw = localStorage.getItem("fr_acct");
        if (!raw) return;
        const j = JSON.parse(raw);
        this.balance = j.balance; this.startBalance = j.start || j.balance;
        this.settings = Object.assign(this.settings, j.s || {});
        this.positions = j.positions || []; this.orders = j.orders || [];
        this.history = j.history || []; this._nextId = j.next || 1;
      } catch (e) {}
    },
    exportCSV() {
      const rows = [["symbol", "side", "lots", "entry", "exit", "pnl_usd", "pips", "reason", "opened", "closed"]];
      for (const h of this.history)
        rows.push([h.symbol, h.side, h.lots, h.entry, h.exit, h.pnl.toFixed(2), h.pips.toFixed(1), h.reason,
          new Date(h.tIn * 1000).toISOString(), new Date(h.tOut * 1000).toISOString()]);
      return rows.map((r) => r.join(",")).join("\n");
    },
  };

  global.Trade = Trade;
})(window);
