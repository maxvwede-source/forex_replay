/* Drawing tools: trendline, ray, h/vline, arrow, rect, fib, measure, text, position tools */
(function (global) {
  "use strict";

  const DEF_COLOR = "#2962ff";
  const TOOLS = ["trend", "ray", "hline", "vline", "arrow", "rect", "fib", "measure", "text", "long", "short"];

  const Tools = {
    active: "cursor",
    color: DEF_COLOR,
    items: [],
    draft: null,
    sel: null,
    symbol: null,
    chart: null,
    _pending: null, // second click for point tools

    setChart(c) {
      this.chart = c;
      c.onLineDrag = (line, price) => this._lineDragged(line, price);
    },

    setTool(name) {
      this.active = name;
      this.draft = null; this._pending = null;
      this._select(null);
      if (this.chart) {
        this.chart.cv.classList.toggle("tool-cursor", name === "cursor");
        this.chart.requestRender();
      }
      document.querySelectorAll("#toolBar .tool[data-tool]").forEach((b) =>
        b.classList.toggle("active", b.dataset.tool === name));
    },

    setColor(c) {
      this.color = c;
      document.querySelectorAll(".swatch").forEach((b) => b.classList.toggle("active", b.dataset.c === c));
      if (this.sel) { this.sel.color = c; this.save(); this.chart.requestRender(); }
    },

    load(symbol) {
      this.symbol = symbol;
      try { this.items = JSON.parse(localStorage.getItem("fr_draw_" + symbol) || "[]"); }
      catch (e) { this.items = []; }
      this.draft = null; this._pending = null; this._select(null);
      if (this.chart) this.chart.drawings = this.items, this.chart.requestRender();
    },
    save() {
      try { localStorage.setItem("fr_draw_" + this.symbol, JSON.stringify(this.items)); } catch (e) {}
    },

    undo() {
      if (!this.items.length) return;
      this.items.pop(); this._select(null); this.save();
      this.chart.requestRender();
    },
    clearAll() {
      this.items = []; this._pending = null; this._select(null); this.save();
      this.chart.requestRender();
    },

    /* ---------------- hit test ---------------- */
    _hit(x, y) {
      const c = this.chart;
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        if (this._hitItem(c, it, x, y)) return it;
      }
      return null;
    },
    _hitItem(c, it, x, y) {
      const T = (t) => c.xOf(c._idxOfT2(t));
      const P = (p) => c.yOf(p);
      const seg = (x1, y1, x2, y2) => distSeg(x, y, x1, y1, x2, y2) < 5;
      switch (it.type) {
        case "hline": return Math.abs(P(it.price) - y) < 4;
        case "vline": return Math.abs(T(it.t) - x) < 4;
        case "trend": case "ray": case "arrow":
          return seg(T(it.p1.t), P(it.p1.price), T(it.p2.t), P(it.p2.price));
        case "rect": {
          const x1 = T(it.p1.t), y1 = P(it.p1.price), x2 = T(it.p2.t), y2 = P(it.p2.price);
          return seg(x1, y1, x2, y1) || seg(x2, y1, x2, y2) || seg(x2, y2, x1, y2) || seg(x1, y2, x1, y1);
        }
        case "fib": {
          const x1 = T(it.p1.t), x2 = T(it.p2.t);
          for (const L of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) {
            const p = it.p1.price + (it.p2.price - it.p1.price) * L;
            if (seg(x1, P(p), x2, P(p))) return true;
          }
          return false;
        }
        case "measure": return seg(T(it.p1.t), P(it.p1.price), T(it.p2.t), P(it.p2.price));
        case "text": {
          const tx = T(it.p1.t), ty = P(it.p1.price);
          const w = this.chart.ctx.measureText(it.text || "").width + 10;
          return x >= tx - 4 && x <= tx + w && y >= ty - 14 && y <= ty + 6;
        }
        case "long": case "short": {
          const x1 = T(it.p1.t), xe = x1 + 220;
          const rows = this._posLevels(it);
          for (const r of rows) if (seg(x1, P(r.price), xe, P(r.price))) return true;
          return false;
        }
      }
      return false;
    },

    _select(it) {
      this.sel = it;
      const box = document.getElementById("drawingBox");
      if (!box) return;
      if (!it) { box.hidden = true; return; }
      const c = this.chart;
      let ax = 0, ay = 0;
      if (it.p1) { ax = c.xOf(c._idxOfT2(it.p1.t)); ay = c.yOf(it.p1.price); }
      else if (it.price != null) { ax = 60; ay = c.yOf(it.price); }
      else if (it.t != null) { ax = c.xOf(c._idxOfT2(it.t)); ay = 40; }
      box.hidden = false;
      box.style.left = Math.max(4, Math.min(c.plotW() - 130, ax + 10)) + "px";
      box.style.top = Math.max(4, ay - 34) + "px";
    },

    /* ---------------- mouse ---------------- */
    onMouseDown(x, y, e) {
      if (this.active === "cursor" || x > this.chart.plotW() || y > this.chart.plotH()) return false;
      e.preventDefault && e.preventDefault();
      const p = { t: this._tAt(x), price: this.chart.priceOf(y) };
      if (this._pending) {                       // second click completes point-to-point tool
        this._pending.p2 = p;
        this._commit(this._pending);
        this._pending = null; this.draft = null;
        return true;
      }
      if (this.active === "hline") { this._commit({ type: "hline", price: p.price, color: this.color }); return true; }
      if (this.active === "vline") { this._commit({ type: "vline", t: p.t, color: this.color }); return true; }
      if (this.active === "text") {
        const txt = prompt("Text label:");
        if (txt) this._commit({ type: "text", p1: p, text: txt, color: this.color });
        return true;
      }
      // start draft (drag or 2-click)
      this.draft = { type: this.active, p1: p, p2: p, color: this.color };
      this.chart.requestRender();
      return true;
    },

    onMouseMove(x, y, e) {
      if (!this.draft) return false;
      this.draft.p2 = { t: this._tAt(x), price: this.chart.priceOf(y) };
      this.chart.requestRender();
      return true;
    },

    onMouseUp(x, y, e) {
      if (!this.draft) return false;
      const d = this.draft;
      const moved = Math.abs(x - this.chart.xOf(this.chart._idxOfT2(d.p1.t))) > 5 ||
                    Math.abs(y - this.chart.yOf(d.p1.price)) > 5;
      if (moved) { this._commit(d); this.draft = null; }
      else { this._pending = d; }   // wait for 2nd click (draft stays live for preview)
      this.chart.requestRender();
      return true;
    },

    onClick(x, y, e) {
      if (this.active !== "cursor") return;
      const it = this._hit(x, y);
      this._select(it);
      this.chart.requestRender();
    },

    onContext(x, y, e) {
      const it = this._hit(x, y);
      if (it) {
        this._select(it);
        this.items = this.items.filter((z) => z !== it);
        this._select(null); this.save(); this.chart.requestRender();
      }
    },

    _tAt(x) {
      const c = this.chart;
      const i = Math.max(0, Math.min(c.bars.length - 1, Math.round(c.iOf(x))));
      if (!c.bars.length) return 0;
      if (x <= 0) return c.bars[0].t;
      if (x >= c.plotW()) return c.bars[c.bars.length - 1].t;
      return c.bars[i] ? c.bars[i].t : c.bars[c.bars.length - 1].t;
    },

    _commit(it) {
      if (it.p1 && it.p2 && it.p1.t === it.p2.t && it.p1.price === it.p2.price && it.type !== "hline") return;
      it.id = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
      this.items.push(it);
      this.save();
      this.chart.requestRender();
    },

    _lineDragged(line, price) {
      if (line.drole === "sl" || line.drole === "tp") {
        if (Trade && Trade.modify) Trade.modify(line.posId, line.drole === "sl" ? price : line.pos.sl,
                                                line.drole === "tp" ? price : line.pos.tp);
        if (global.UI && UI.refreshPositions) UI.refreshPositions();
        return;
      }
      if (line.price != null) line.price = price;
      this.save(); this.chart.requestRender();
    },

    /* ---------------- rendering ---------------- */
    draw(ctx, c) {
      const all = this.draft ? this.items.concat([this.draft]) : this.items;
      for (const it of all) this._drawItem(ctx, c, it, it === this.sel);
    },

    _drawItem(ctx, c, it, sel) {
      const T = (t) => c.xOf(c._idxOfT2(t));
      const P = (p) => c.yOf(p);
      const col = it.color || DEF_COLOR;
      ctx.save();
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = sel ? 2 : 1.4;
      ctx.lineCap = "round";
      if (it.type !== "long" && it.type !== "short" && it.type !== "fib" && it.type !== "measure" && it.type !== "text")
        ctx.globalAlpha = 0.95;

      const arrowHead = (x1, y1, x2, y2) => {
        const a = Math.atan2(y2 - y1, x2 - x1), s = 9;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - s * Math.cos(a - 0.42), y2 - s * Math.sin(a - 0.42));
        ctx.lineTo(x2 - s * Math.cos(a + 0.42), y2 - s * Math.sin(a + 0.42));
        ctx.closePath(); ctx.fill();
      };

      switch (it.type) {
        case "hline": {
          const y = P(it.price);
          ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(c.plotW(), y); ctx.stroke();
          const w = ctx.measureText(this._fp(c, it.price)).width + 12;
          ctx.fillStyle = col; c._rr(ctx, c.plotW() - w - 4, y - 8, w, 16, 3); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(this._fp(c, it.price), c.plotW() - w / 2 - 4, y);
          ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
          break;
        }
        case "vline": {
          const x = Math.round(T(it.t)) + 0.5;
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, c.plotH()); ctx.stroke();
          break;
        }
        case "trend": case "ray": case "measure": {
          const x1 = T(it.p1.t), y1 = P(it.p1.price);
          let x2 = T(it.p2.t), y2 = P(it.p2.price);
          if (it.type === "ray" || (it.type === "trend" && sel === false && it.extend)) {
            // extend beyond p2 up to plot edge
            const dx = x2 - x1 || 1, dy = y2 - y1;
            const k = (c.plotW() - x1) / dx;
            if (k > 1) { x2 = c.plotW(); y2 = y1 + dy * k; }
          }
          if (it.type === "measure") {
            ctx.setLineDash([5, 4]);
            ctx.beginPath(); ctx.moveTo(T(it.p1.t), P(it.p1.price)); ctx.lineTo(T(it.p2.t), P(it.p2.price)); ctx.stroke();
            ctx.setLineDash([]);
            this._measureLabel(ctx, c, it);
          } else {
            ctx.beginPath(); ctx.moveTo(T(it.p1.t), P(it.p1.price));
            ctx.lineTo(x2, y2); ctx.stroke();
            if (it.type === "arrow") arrowHead(T(it.p1.t), P(it.p1.price), x2, y2);
            if (it.type === "trend" || it.type === "arrow") {
              ctx.beginPath(); ctx.arc(T(it.p1.t), P(it.p1.price), 3, 0, 7); ctx.fill();
            }
          }
          break;
        }
        case "rect": {
          const x1 = T(it.p1.t), y1 = P(it.p1.price), x2 = T(it.p2.t), y2 = P(it.p2.price);
          ctx.globalAlpha = 0.12; ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          ctx.globalAlpha = 0.95;
          ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
          break;
        }
        case "fib": {
          const x1 = T(it.p1.t), x2 = T(it.p2.t);
          const lvls = [[0, "#ef5350"], [0.236, "#ff9800"], [0.382, "#f0b90b"], [0.5, "#787b86"], [0.618, "#26a69a"], [0.786, "#2962ff"], [1, "#ab47bc"]];
          ctx.font = "10px sans-serif"; ctx.textBaseline = "middle";
          for (const [L, cc] of lvls) {
            const p = it.p1.price + (it.p2.price - it.p1.price) * L;
            const y = P(p);
            ctx.strokeStyle = cc; ctx.setLineDash(L === 0 || L === 1 ? [] : [4, 3]);
            ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x2, y); ctx.stroke();
            ctx.fillStyle = cc;
            ctx.fillText((L * 100).toFixed(1) + "%  " + this._fp(c, p), x2 + 6, y);
          }
          ctx.setLineDash([]); ctx.textBaseline = "alphabetic";
          break;
        }
        case "text": {
          const x = T(it.p1.t), y = P(it.p1.price);
          ctx.font = "600 13px sans-serif";
          ctx.fillStyle = col;
          ctx.fillText(it.text || "", x, y);
          break;
        }
        case "long": case "short": {
          const x1 = T(it.p1.t), xe = x1 + 240;
          const rows = this._posLevels(it);
          for (const r of rows) {
            const y = P(r.price);
            ctx.globalAlpha = r.alpha; ctx.fillStyle = r.color;
            ctx.fillRect(x1, Math.min(y, P(r.mid)), xe - x1, Math.abs(P(r.mid) - y));
            ctx.globalAlpha = 1;
            ctx.strokeStyle = r.color; ctx.setLineDash(r.dash);
            ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(xe, y); ctx.stroke();
            ctx.setLineDash([]);
          }
          ctx.font = "600 10.5px sans-serif";
          for (const r of rows) {
            const y = P(r.price);
            ctx.fillStyle = "#fff";
            ctx.fillText(r.label, x1 + 6, y - 3);
          }
          ctx.fillStyle = "#fff";
          ctx.fillText("Entry " + this._fp(c, it.p1.price), x1 + 6, P(it.p1.price) + 13);
          break;
        }
      }
      // selection handles
      if (sel && it.p1 && it.p2) {
        ctx.fillStyle = "#fff"; ctx.strokeStyle = col;
        for (const pt of [it.p1, it.p2]) {
          const x = T(pt.t), y = P(pt.price);
          ctx.fillRect(x - 3.5, y - 3.5, 7, 7); ctx.strokeRect(x - 3.5, y - 3.5, 7, 7);
        }
      }
      ctx.restore();
    },

    _posLevels(it) {
      const buy = it.type === "long";
      const e = it.p1.price, s = it.p2.price;
      const risk = Math.abs(e - s);
      const target = buy ? e + risk * 1.5 : e - risk * 1.5;
      return [
        { price: target, mid: e, color: "#26a69a", alpha: 0.16, dash: [], label: "Target  1.5R  " + target.toFixed(5) },
        { price: e, mid: buy ? e + risk * 0.0001 : e - risk * 0.0001, color: "#787b86", alpha: 0.0, dash: [3, 3], label: "" },
        { price: s, mid: e, color: "#ef5350", alpha: 0.16, dash: [], label: "Stop   -1R  " + s.toFixed(5) },
      ];
    },

    _measureLabel(ctx, c, it) {
      const dp = it.p2.price - it.p1.price;
      const pips = Data.pips(this.symbol, dp);
      const pct = (dp / it.p1.price) * 100;
      const i1 = c._idxOfT2(it.p2.t), i0 = c._idxOfT2(it.p1.t);
      const bars = Math.abs(i1 - i0);
      const txt = (dp >= 0 ? "+" : "") + this._fp(c, dp) + "  (" + (pips >= 0 ? "+" : "") + pips.toFixed(1) +
                  " pips, " + pct.toFixed(2) + "%)  " + bars + " bars";
      const x = Math.min(c.xOf(c._idxOfT2(it.p1.t)), c.xOf(c._idxOfT2(it.p2.t)));
      const y = Math.min(c.yOf(it.p1.price), c.yOf(it.p2.price)) - 10;
      ctx.font = "600 11px sans-serif";
      const w = ctx.measureText(txt).width + 14;
      ctx.fillStyle = dp >= 0 ? "#26a69a" : "#ef5350";
      c._rr(ctx, x, y - 20, w, 18, 4); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(txt, x + 7, y - 11);
      ctx.textBaseline = "alphabetic";
    },

    _fp(c, p) {
      const d = (this.symbol && Data.meta(this.symbol) ? Data.meta(this.symbol).digits : c.digits);
      return p.toFixed(d);
    },
  };

  /* Chart needs t->index for drawings anchored to time */
  function distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + t * dx, cy = y1 + t * dy;
    return Math.hypot(px - cx, py - cy);
  }

  /* patch chart with time->index helper used by tools */
  const Chart = global.Chart;
  Chart._idxOfT2 = function (t) {
    const arr = this.bars;
    if (!arr.length) return 0;
    let lo = 0, hi = arr.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t === t) return mid;
      if (arr[mid].t < t) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return best;
  };

  global.Tools = Tools;
})(window);
