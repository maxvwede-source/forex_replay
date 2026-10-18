/* Chart engine: canvas candlestick chart with axes, crosshair, EMA, volume, markers */
(function (global) {
  "use strict";

  const UP = "#26a69a", DOWN = "#ef5350", GRID = "#1e222d", AXISC = "#2a2e39",
        TXT = "#b2b5be", DIM = "#787b86", ACC = "#2962ff";

  const Chart = {
    cv: null, ctx: null, w: 0, h: 0, dpr: 1,
    bars: [],
    symbol: null, tf: "1h", digits: 5, meta: null,
    view: { bw: 9, first: 0, follow: true, pManual: null },  // pManual {center, span}|null
    type: "candles", ema: false, vol: true,
    cross: { x: 0, y: 0, on: false },
    revealIdx: -1,     // replay: last revealed bar index (-1 = all visible)
    cutMode: false,    // scissors: full history shown while picking a cut range
    cutSel: null,      // {i0,i1} transient selection band
    onCut: null,       // (i0, i1) => void  — user confirmed a cut range
    drawings: [],      // managed by Tools
    markers: [],       // trade markers [{t, price, dir, kind, pnl}]
    posLines: [],      // [{role, t1, price, color, tag, tagSub, id}] rendered + hit-tested
    dragPriceLine: null,
    priceW: 66, timeH: 24, emaCache: null,
    onCursor: null,    // (bar|null, idx) => void
    onSelect: null,    // drawing selection event
    selected: null,
    _raf: 0,

    init() {
      this.cv = document.getElementById("mainCanvas");
      this.ctx = this.cv.getContext("2d");
      this.dpr = window.devicePixelRatio || 1;
      const wrap = document.getElementById("chartWrap");
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(wrap);
      this.resize();
      this._bind();
    },

    resize() {
      const wrap = document.getElementById("chartWrap");
      this.w = wrap.clientWidth; this.h = wrap.clientHeight;
      this.dpr = window.devicePixelRatio || 1;
      this.cv.width = Math.round(this.w * this.dpr);
      this.cv.height = Math.round(this.h * this.dpr);
      this.requestRender();
    },

    /* ---------------- series ---------------- */
    setSeries(bars, meta, tf, reveal) {
      this.bars = bars || [];
      if (meta) { this.meta = meta; this.symbol = meta.id; this.digits = meta.digits; }
      if (tf) this.tf = tf;
      this.revealIdx = reveal == null ? -1 : reveal;
      this.emaCache = null;
      const vis = this._visCount();
      if (this.view.follow || this.view.first <= 0)
        this.view.first = Math.max(0, this._rIdx() + 6 - vis);
      this.requestRender();
    },

    /* last index allowed to render (replay reveal, or full while cutting) */
    _rIdx() {
      const n = this.bars.length - 1;
      if (n < 0) return -1;
      if (this.cutMode || this.revealIdx < 0) return n;
      return Math.min(this.revealIdx, n);
    },
    revealedBar() { const i = this._rIdx(); return i >= 0 ? this.bars[i] : null; },

    /* keep chart pinned to right edge when following */
    onSeriesGrew() {
      const vis = this._visCount();
      const maxFirst = Math.max(0, this._rIdx() + 6 - vis);
      if (this.view.follow) this.view.first = maxFirst;
    },

    /* ---------------- coords ---------------- */
    plotW() { return this.w - this.priceW; },
    plotH() { return this.h - this.timeH; },
    volH() {
      if (!this.vol) return 0;
      let any = false;
      const { i0, i1 } = this._range();
      for (let i = i0; i <= i1 && i < this.bars.length; i++) if (this.bars[i].v > 0) { any = true; break; }
      return any ? Math.round(this.plotH() * 0.15) : 0;
    },
    _visCount() { return this.plotW() / this.view.bw; },
    xOf(i) { return (i - this.view.first) * this.view.bw + this.view.bw / 2; },
    iOf(x) { return Math.floor(this.view.first + x / this.view.bw); },
    _range() {
      const n = this.bars.length;
      let i0 = Math.max(0, Math.floor(this.view.first));
      let i1 = Math.min(this._rIdx(), Math.ceil(this.view.first + this._visCount()));
      if (i1 < i0) i1 = i0;
      return { i0, i1 };
    },
    priceRange() {
      const { i0, i1 } = this._range();
      let mn = Infinity, mx = -Infinity;
      for (let i = i0; i <= i1 && i < this.bars.length; i++) {
        const b = this.bars[i];
        if (b.l < mn) mn = b.l;
        if (b.h > mx) mx = b.h;
      }
      if (!isFinite(mn)) { mn = 0; mx = 1; }
      if (this.posLines.length) {
        for (const l of this.posLines) {
          if (l.price < mn) mn = l.price;
          if (l.price > mx) mx = l.price;
        }
      }
      let span = mx - mn || Math.abs(mx) * 0.001 || 1;
      if (this.view.pManual) return { lo: this.view.pManual.center - this.view.pManual.span / 2,
                                       hi: this.view.pManual.center + this.view.pManual.span / 2 };
      return { lo: mn - span * 0.08, hi: mx + span * 0.10 };
    },
    priceAreaH() {
      const v = this._volHC != null ? this._volHC : this.volH();
      return this.plotH() - v;
    },
    yOf(p) {
      const r = this._pr || this.priceRange();
      const ph = this.priceAreaH();
      return ((r.hi - p) / (r.hi - r.lo)) * ph;
    },
    priceOf(y) {
      const r = this._pr || this.priceRange();
      return r.hi - (y / this.priceAreaH()) * (r.hi - r.lo);
    },

    /* ---------------- view ops ---------------- */
    zoomBars(factor, cx) {
      const bw0 = this.view.bw;
      let bw = bw0 * factor;
      bw = Math.max(1.2, Math.min(60, bw));
      if (bw === bw0) return;
      const anchor = cx == null ? null : this.iOf(cx);
      this.view.bw = bw;
      if (anchor != null && cx != null) {
        // keep the bar under cursor stationary
        this.view.first = anchor + (0.5 - cx / bw) - 0.0;
        this.view.first = anchor - (cx / bw) + 0.5;
      }
      this.view.follow = this._atRight();
      this.requestRender();
    },
    _atRight() {
      const maxFirst = Math.max(0, this._rIdx() + 6 - this._visCount());
      return this.view.first >= maxFirst - 1.2;
    },
    pan(barsDelta) {
      const maxFirst = Math.max(0, this._rIdx() + 6 - this._visCount());
      this.view.first = Math.max(-2, Math.min(maxFirst, this.view.first + barsDelta));
      this.view.follow = this._atRight();
      this.requestRender();
    },
    resetView() {
      this.view.bw = 9; this.view.pManual = null; this.view.follow = true;
      this.view.first = Math.max(0, this._rIdx() + 6 - this._visCount());
      this.requestRender();
    },
    priceZoom(factor, y) {
      const r = this.priceRange();
      const c = r.lo + ((this.plotH() - y) / this.plotH()) * (r.hi - r.lo);
      let span = (r.hi - r.lo) * factor;
      const last = this.revealedBar();
      const base = Math.abs(last ? last.c : 1);
      span = Math.max(base * 1e-6, Math.min(base * 10, span));
      this.view.pManual = { center: c, span };
      this.requestRender();
    },
    pricePan(dy) {
      const r = this.priceRange();
      const d = (dy / this.plotH()) * (r.hi - r.lo);
      this.view.pManual = { center: (r.hi + r.lo) / 2 + d, span: r.hi - r.lo };
      this.requestRender();
    },
    priceAuto() { this.view.pManual = null; this.requestRender(); },

    /* MT5-style price axis drag: down = compress scale (see full range),
       up = expand. Anchored at the price under the grab point. */
    _axisScale(drag, y) {
      const k = Math.max(0.15, Math.min(12, Math.exp((y - drag.y0) * 0.005)));
      const { lo, hi } = drag.pr0;
      const a = drag.anchor;
      const ctr = (lo + hi) / 2;
      this.view.pManual = { center: a + (ctr - a) * k, span: (hi - lo) * k };
      this.requestRender();
    },

    /* ---------------- interaction (mouse + touch via pointer events) ---------------- */
    _bind() {
      const cv = this.cv;
      let drag = null;
      const pointers = new Map();
      let pinch = null;

      cv.addEventListener("pointerdown", (e) => {
        try { cv.setPointerCapture(e.pointerId); } catch (err) {}
        pointers.set(e.pointerId, this._ev(e));
        if (pointers.size === 2) {                 // two-finger pinch: time zoom + pan
          drag = null; this.dragPriceLine = null;
          cv.classList.remove("panning");
          const pts = [...pointers.values()];
          const pr = this.priceRange();
          pinch = {
            d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
            cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2,
            bw: this.view.bw, first: this.view.first,
            lo: pr.lo, hi: pr.hi,
          };
          return;
        }
        if (pointers.size > 2) return;
        const { x, y } = this._ev(e);
        if (Tools.onMouseDown(x, y, e)) return;               // drawing tools first
        const line = this._hitPosLine(x, y);
        if (line) {
          this.dragPriceLine = { line, y0: y, price0: line.price, moved: false };
          return;
        }
        if (x > this.plotW()) {
          const pr = this.priceRange();
          drag = { kind: "axis", y0: y, pr0: pr, anchor: this.priceOf(y) };
          cv.style.cursor = "ns-resize";
          return;
        }
        if (this.cutMode) {
          const i = Math.max(0, Math.min(this.bars.length - 1, this.iOf(x)));
          drag = { kind: "cut", i0: i };
          this.cutSel = { i0: i, i1: i };
          this.requestRender();
          return;
        }
        drag = { kind: "pan", x: x, first: this.view.first, moved: false };
        cv.classList.add("panning");
      });

      window.addEventListener("pointermove", (e) => {
        if (pointers.has(e.pointerId)) pointers.set(e.pointerId, this._ev(e));
        if (pinch && pointers.size >= 2) {
          const pts = [...pointers.values()].slice(0, 2);
          const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
          const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
          const bw = Math.max(1.2, Math.min(60, pinch.bw * (d / pinch.d)));
          const anchorI = pinch.first + pinch.cx / pinch.bw;
          this.view.bw = bw;
          this.view.first = anchorI - cx / bw;
          this.view.follow = this._atRight();
          const span = pinch.hi - pinch.lo;
          this.view.pManual = { center: (pinch.hi + pinch.lo) / 2 + ((cy - pinch.cy) / this.plotH()) * span, span };
          this.requestRender();
          return;
        }
        const { x, y } = this._ev(e);
        if (this.dragPriceLine) {
          const d = this.dragPriceLine;
          const p = this.priceOf(y);
          d.line.price = p; d.moved = true;
          this.requestRender();
          return;
        }
        if (Tools.onMouseMove(x, y, e)) return;
        if (drag) {
          if (drag.kind === "axis") { this._axisScale(drag, y); return; }
          if (drag.kind === "cut") {
            const i = Math.max(0, Math.min(this.bars.length - 1, this.iOf(x)));
            this.cutSel = { i0: Math.min(drag.i0, i), i1: Math.max(drag.i0, i) };
            this.requestRender();
            return;
          }
          if (drag.kind === "pan") {
            const dx = x - drag.x;
            if (Math.abs(dx) > 3) drag.moved = true;
            this.view.first = drag.first - dx / this.view.bw;
            this.view.follow = this._atRight();
          }
          this.requestRender();
          return;
        }
        this.cross = { x, y, on: x <= this.plotW() && y <= this.plotH() };
        cv.style.cursor = this._cursorFor(x, y);
        this._emitCursor();
        this.requestRender();
      }, { passive: true });

      const up = (e) => {
        pointers.delete(e.pointerId);
        try { cv.releasePointerCapture(e.pointerId); } catch (err) {}
        if (pointers.size < 2) pinch = null;
        if (this.dragPriceLine) {
          const d = this.dragPriceLine; this.dragPriceLine = null;
          const { x, y } = this._ev(e);
          const price = this.priceOf(y);
          if (d.moved && Math.abs(price - d.price0) > 1e-12 && this.onLineDrag) {
            this.onLineDrag(d.line, price);
          } else { d.line.price = d.price0; }
          this.requestRender();
        }
        Tools.onMouseUp(this._ev(e).x, this._ev(e).y, e);
        if (drag) {
          if (drag.kind === "cut") {
            const sel = this.cutSel;
            this.cutMode = false;
            this.cutSel = null;
            if (this.onCut && sel && sel.i1 > sel.i0) this.onCut(sel.i0, sel.i1);
            else this.requestRender();
          } else if (drag.kind === "pan") {
            if (!drag.moved) Tools.onClick(this._ev(e).x, this._ev(e).y, e);
            this.view.follow = this._atRight();
          }
          drag = null;
        }
        this.cv.classList.remove("panning");
        this.cv.style.cursor = "";
      };
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);

      cv.addEventListener("dblclick", (e) => {
        const { x } = this._ev(e);
        if (x > this.plotW()) this.priceAuto();
        else this.resetView();
      });
      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        const { x, y } = this._ev(e);
        if (x > this.plotW()) { this.priceZoom(e.deltaY > 0 ? 1.12 : 0.89, y); return; }
        this.zoomBars(e.deltaY > 0 ? 0.9 : 1.11, x);
      }, { passive: false });
      cv.addEventListener("mouseleave", () => {
        if (pointers.size) return;                 // don't kill crosshair mid-touch-drag
        this.cross.on = false; this._emitCursor(); this.requestRender();
      });
      cv.addEventListener("contextmenu", (e) => { e.preventDefault(); Tools.onContext(this._ev(e).x, this._ev(e).y, e); });
    },
    _ev(e) {
      const r = this.cv.getBoundingClientRect();
      return { x: (e.clientX - r.left), y: (e.clientY - r.top) };
    },
    _cursorFor(x, y) {
      if (this._hitPosLine(x, y)) return "ns-resize";
      if (x > this.plotW() || y > this.plotH()) return "";
      return Tools.active && Tools.active !== "cursor" ? "crosshair" : "crosshair";
    },
    _emitCursor() {
      if (!this.onCursor) return;
      if (!this.cross.on) { this.onCursor(null, -1); return; }
      const i = this.iOf(this.cross.x);
      if (i < 0 || i > this._rIdx()) { this.onCursor(null, -1); return; }
      const b = (i < this.bars.length) ? this.bars[i] : null;
      this.onCursor(b, i);
    },

    /* ---------------- trade lines ---------------- */
    _hitPosLine(x, y) {
      if (x > this.plotW()) return null;
      for (const l of this.posLines) {
        if (l.role === "vline") continue;
        const ly = this.yOf(l.price);
        if (Math.abs(ly - y) <= 3.5) return l;
      }
      return null;
    },
    setMarkers(m) { this.markers = m; this.requestRender(); },
    setPosLines(l) { this.posLines = l; this.requestRender(); },

    /* ---------------- EMA ---------------- */
    _ema(period) {
      const key = "e" + period + "_" + this.symbol + this.tf + this.bars.length;
      if (this.emaCache && this.emaCache[key]) return this.emaCache[key];
      const k = 2 / (period + 1);
      const out = new Array(this.bars.length);
      let prev = null;
      for (let i = 0; i < this.bars.length; i++) {
        const c = this.bars[i].c;
        prev = prev == null ? c : c * k + prev * (1 - k);
        out[i] = prev;
      }
      if (!this.emaCache) this.emaCache = {};
      this.emaCache = { [key]: out };
      return out;
    },

    /* ---------------- render ---------------- */
    requestRender() {
      if (this._raf) return;
      this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
    },

    draw() {
      const ctx = this.ctx, W = this.w, H = this.h;
      if (!W || !H) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const pW = this.plotW(), pH = this.plotH();
      this._drawWatermark(ctx, pW, pH);
      this._volHC = this.volH();
      const vH = this._volHC;
      this._pr = this.priceRange();
      const aH = this.priceAreaH();

      this._drawGrid(ctx, pW, pH);
      if (this.bars.length) {
        if (vH) this._drawVolume(ctx, pW, pH, vH);
        if (this.type === "candles") this._drawCandles(ctx, pW, pH);
        else if (this.type === "bars") this._drawBars(ctx, pW, pH);
        else this._drawLine(ctx, pW, pH, this.type === "area");
        if (this.ema) this._drawEMA(ctx, pW, pH);
      }
      this._drawPosLines(ctx, pW, pH);
      Tools.draw(ctx, this);           // drawings overlay
      this._drawMarkers(ctx, pW, pH);
      this._drawCutSel(ctx, pW, pH);
      this._drawLastPrice(ctx, pW, pH);
      this._drawAxes(ctx, pW, pH, W, H);
      if (this.cross.on) this._drawCross(ctx, pW, pH);
      // plot frame
      ctx.strokeStyle = AXISC; ctx.lineWidth = 1;
      ctx.strokeRect(pW + 0.5, 0.5, W - pW - 1, H - 1);
      ctx.beginPath(); ctx.moveTo(0, pH + 0.5); ctx.lineTo(W, pH + 0.5); ctx.stroke();
    },

    /* scissors selection band */
    _drawCutSel(ctx, pW, pH) {
      if (!this.cutMode || !this.cutSel) return;
      const s = this.cutSel;
      if (s.i1 < s.i0) return;
      const bw = this.view.bw;
      const x0 = this.xOf(s.i0) - bw / 2, x1 = this.xOf(s.i1) + bw / 2;
      ctx.save();
      ctx.fillStyle = "rgba(240,185,11,0.14)";
      ctx.fillRect(x0, 0, x1 - x0, pH);
      ctx.strokeStyle = "#f0b90b"; ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x0) + 0.5, 0.5, Math.round(x1 - x0) - 1, pH - 1);
      ctx.setLineDash([]);
      const label = "✂ " + (s.i1 - s.i0 + 1) + " bars — release to cut";
      ctx.font = "700 11px sans-serif";
      const w = ctx.measureText(label).width + 18;
      const lx = Math.max(2, Math.min((x0 + x1) / 2 - w / 2, pW - w - 2));
      ctx.fillStyle = "#f0b90b";
      this._rr(ctx, lx, 8, w, 20, 5); ctx.fill();
      ctx.fillStyle = "#131722"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, lx + w / 2, 18);
      ctx.restore();
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    },

    /* TradingView-style faint watermark behind the candles */
    _drawWatermark(ctx, pW, pH) {
      if (pW < 120 || pH < 80) return;
      const name = (this.meta && this.meta.name) || this.symbol || "";
      if (!name) return;
      const prov = this.meta && this.meta.tv ? String(this.meta.tv).split(":")[0] : "";
      const size = Math.min(58, Math.max(26, Math.min(pW, pH * 1.6) / 9));
      ctx.save();
      ctx.globalAlpha = 0.045;
      ctx.fillStyle = "#f7f8fa";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.font = "700 " + size + "px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText(name, pW / 2, pH * 0.4);
      ctx.font = "400 " + Math.round(size * 0.4) + "px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillText((prov ? prov + " · " : "") + this.tf, pW / 2, pH * 0.4 + size * 0.72);
      ctx.restore();
    },

    _drawGrid(ctx, pW, pH) {
      const aH = this.priceAreaH();
      const step = this._niceStep(this._pr.hi - this._pr.lo, 6);
      const start = Math.ceil(this._pr.lo / step) * step;
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let p = start; p <= this._pr.hi; p += step) {
        const y = Math.round(this.yOf(p)) + 0.5;
        if (y < 0 || y > aH) continue;
        ctx.moveTo(0, y); ctx.lineTo(pW, y);
      }
      // vertical time grid
      const tstep = this._timeStep();
      const { i0, i1 } = this._range();
      for (let i = i0; i <= i1 && i < this.bars.length; i++) {
        const b = this.bars[i];
        if (b.t % tstep === 0) {
          const x = Math.round(this.xOf(i)) + 0.5;
          ctx.moveTo(x, 0); ctx.lineTo(x, pH);
        }
      }
      ctx.stroke();
    },

    _drawVolume(ctx, pW, pH, vH) {
      const { i0, i1 } = this._range();
      let mx = 0;
      for (let i = i0; i <= i1; i++) mx = Math.max(mx, this.bars[i].v);
      if (!mx) return;
      const top = pH - vH;
      const bw = Math.max(1, this.view.bw * 0.72);
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i];
        if (!b.v) continue;
        const x = this.xOf(i), hgt = (b.v / mx) * (vH - 4);
        ctx.fillStyle = (b.c >= b.o ? UP : DOWN) + "80";
        ctx.fillRect(x - bw / 2, pH - hgt, bw, hgt);
      }
      ctx.fillStyle = DIM; ctx.font = "10px sans-serif"; ctx.textAlign = "left";
      ctx.fillText("VOL " + (mx >= 1e6 ? (mx / 1e6).toFixed(2) + "M" : mx >= 1e3 ? (mx / 1e3).toFixed(1) + "K" : mx.toFixed(0)), 6, top + 12);
    },

    _drawCandles(ctx, pW, pH) {
      const { i0, i1 } = this._range();
      const bw = Math.max(1, this.view.bw * 0.7);
      const wickW = this.view.bw < 3 ? 1 : Math.max(1, Math.min(2, this.view.bw * 0.12));
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i];
        const x = this.xOf(i);
        const up = b.c >= b.o;
        ctx.fillStyle = ctx.strokeStyle = up ? UP : DOWN;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, this.yOf(b.h));
        ctx.lineTo(Math.round(x) + 0.5, this.yOf(b.l));
        ctx.lineWidth = wickW;
        ctx.stroke();
        const yo = this.yOf(b.o), yc = this.yOf(b.c);
        const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
        ctx.fillRect(Math.round(x - bw / 2), Math.round(top), Math.max(1, Math.round(bw)), Math.round(hgt));
      }
    },

    _drawBars(ctx, pW, pH) {
      const { i0, i1 } = this._range();
      ctx.lineWidth = 1.2;
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i];
        const x = Math.round(this.xOf(i)) + 0.5;
        ctx.strokeStyle = b.c >= b.o ? UP : DOWN;
        ctx.beginPath();
        ctx.moveTo(x, this.yOf(b.h)); ctx.lineTo(x, this.yOf(b.l));
        ctx.moveTo(x - Math.max(2, this.view.bw * 0.3), this.yOf(b.o));
        ctx.lineTo(x, this.yOf(b.o));
        ctx.moveTo(x, this.yOf(b.c));
        ctx.lineTo(x + Math.max(2, this.view.bw * 0.3), this.yOf(b.c));
        ctx.stroke();
      }
    },

    _drawLine(ctx, pW, pH, area) {
      const aH = this.priceAreaH();
      const { i0, i1 } = this._range();
      ctx.beginPath();
      let started = false;
      for (let i = i0; i <= i1; i++) {
        const x = this.xOf(i), y = this.yOf(this.bars[i].c);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      if (area && started) {
        const grad = ctx.createLinearGradient(0, 0, 0, aH);
        grad.addColorStop(0, "rgba(41,98,255,0.35)"); grad.addColorStop(1, "rgba(41,98,255,0.02)");
        ctx.save();
        ctx.lineTo(this.xOf(i1), aH); ctx.lineTo(this.xOf(i0), aH); ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
        ctx.restore();
        ctx.beginPath();
        started = false;
        for (let i = i0; i <= i1; i++) {
          const x = this.xOf(i), y = this.yOf(this.bars[i].c);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = ACC; ctx.lineWidth = 1.8; ctx.stroke();
    },

    _drawEMA(ctx, pW, pH) {
      const { i0, i1 } = this._range();
      const defs = [[9, "#f0b90b"], [21, "#2962ff"], [50, "#ff6d00"]];
      for (const [p, col] of defs) {
        const arr = this._ema(p);
        ctx.beginPath();
        for (let i = i0; i <= i1; i++) {
          const x = this.xOf(i), y = this.yOf(arr[i]);
          if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = col; ctx.lineWidth = 1.3; ctx.stroke();
      }
    },

    _drawPosLines(ctx, pW, pH) {
      ctx.font = "600 10.5px sans-serif";
      for (const l of this.posLines) {
        const y = this.yOf(l.price);
        if (y < -20 || y > pH + 20) continue;
        ctx.save();
        ctx.strokeStyle = l.color; ctx.globalAlpha = l.role === "entry" ? 0.75 : 0.9;
        ctx.setLineDash(l.role === "entry" ? [1, 0] : [6, 4]);
        ctx.lineWidth = l.role === "entry" ? 1 : 1.4;
        ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pW, Math.round(y) + 0.5); ctx.stroke();
        ctx.restore();
        if (l.tag) {
          const w = Math.max(ctx.measureText(l.tag).width + 14, 92);
          ctx.fillStyle = l.color + "ee";
          this._rr(ctx, 4, y - 9, w, 18, 3); ctx.fill();
          ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
          ctx.fillText(l.tag, 10, y);
          if (l.tagSub) {
            ctx.fillStyle = "#ffffffcc";
            ctx.fillText(l.tagSub, 10 + ctx.measureText(l.tag).width + 8, y);
          }
        }
      }
      ctx.textBaseline = "alphabetic";
    },

    _drawMarkers(ctx, pW, pH) {
      const rev = this.revealedBar();
      for (const m of this.markers) {
        if (rev && m.t > rev.t) continue;
        const i = this._idxOfT(m.t);
        if (i < 0) continue;
        const x = this.xOf(i), y = this.yOf(m.price);
        if (x < -10 || x > pW + 10) continue;
        ctx.save();
        if (m.kind === "entry") {
          ctx.fillStyle = m.dir === "buy" ? UP : DOWN;
          ctx.beginPath();
          if (m.dir === "buy") { ctx.moveTo(x, y + 6); ctx.lineTo(x - 6, y + 17); ctx.lineTo(x + 6, y + 17); }
          else { ctx.moveTo(x, y - 6); ctx.lineTo(x - 6, y - 17); ctx.lineTo(x + 6, y - 17); }
          ctx.closePath(); ctx.fill();
          if (m.label) {
            ctx.font = "700 9.5px sans-serif"; ctx.textAlign = "center";
            ctx.fillText(m.label, x, m.dir === "buy" ? y + 27 : y - 21);
          }
        } else { // exit
          ctx.strokeStyle = m.pnl >= 0 ? UP : DOWN; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3);
          ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke();
        }
        ctx.restore();
      }
    },
    _idxOfT(t) {
      const arr = this.bars;
      let lo = 0, hi = arr.length - 1, best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].t === t) return mid;
        if (arr[mid].t < t) { best = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return best;
    },

    _drawLastPrice(ctx, pW, pH) {
      const b = this.revealedBar();
      if (!b) return;
      const y = this.yOf(b.c);
      if (y < 0 || y > pH) return;
      const up = b.c >= b.o;
      ctx.save();
      ctx.strokeStyle = up ? UP : DOWN; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pW, Math.round(y) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
      const label = b.c.toFixed(this.digits);
      ctx.font = "700 11px sans-serif";
      const w = this.priceW - 2;
      ctx.fillStyle = up ? UP : DOWN;
      ctx.fillRect(pW + 1, y - 9, w, 18);
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, pW + w / 2, y);
      ctx.restore();
      ctx.textBaseline = "alphabetic";
    },

    _drawAxes(ctx, pW, pH, W, H) {
      const aH = this.priceAreaH();
      // price axis bg
      ctx.fillStyle = "#131722"; ctx.fillRect(pW, 0, this.priceW, H);
      ctx.strokeStyle = AXISC; ctx.beginPath();
      ctx.moveTo(pW + 0.5, 0); ctx.lineTo(pW + 0.5, H); ctx.stroke();
      const step = this._niceStep(this._pr.hi - this._pr.lo, 6);
      const start = Math.ceil(this._pr.lo / step) * step;
      ctx.fillStyle = TXT; ctx.font = "10.5px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      for (let p = start; p <= this._pr.hi; p += step) {
        const y = this.yOf(p);
        if (y < 6 || y > aH - 4) continue;
        ctx.fillText(this._fmtP(p), pW + 7, y);
      }
      // time axis
      ctx.fillStyle = "#131722"; ctx.fillRect(0, pH, W, this.timeH);
      ctx.strokeStyle = AXISC; ctx.beginPath();
      ctx.moveTo(0, pH + 0.5); ctx.lineTo(W, pH + 0.5); ctx.stroke();
      const { i0, i1 } = this._range();
      const tstep = this._timeStep();
      const labels = [];
      for (let i = i0; i <= i1 && i < this.bars.length; i++) {
        const b = this.bars[i];
        if (b.t % tstep === 0) labels.push({ x: this.xOf(i), t: b.t });
      }
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const dayMs = 86400000;
      for (const L of labels) {
        if (L.x < 14 || L.x > pW - 14) continue;
        const d = new Date(L.t * 1000);
        let txt;
        if (this._tfSec() >= dayMs / 1000)
          txt = d.getUTCDate() + " " + d.toLocaleString("en", { month: "short", timeZone: "UTC" });
        else {
          const sameDay = labels.some((o) => o !== L && new Date(o.t * 1000).getUTCDate() === d.getUTCDate() && Math.abs(o.x - L.x) < 80);
          txt = (sameDay ? "" : d.getUTCDate() + " " + d.toLocaleString("en", { month: "short", timeZone: "UTC" }) + " ") +
                String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
        }
        ctx.fillStyle = DIM;
        ctx.fillText(txt, L.x, pH + this.timeH / 2);
      }
      ctx.textBaseline = "alphabetic";
    },

    _drawCross(ctx, pW, pH) {
      const { x, y } = this.cross;
      if (x > pW || y > pH) return;
      if (y > this.priceAreaH() + 4) return;
      ctx.save();
      ctx.strokeStyle = "#758696"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(pW, Math.round(y) + 0.5);
      ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, pH);
      ctx.stroke();
      ctx.setLineDash([]);
      // price label
      const p = this.priceOf(y);
      ctx.fillStyle = "#434651";
      ctx.fillRect(pW + 1, y - 9, this.priceW - 2, 18);
      ctx.fillStyle = "#fff"; ctx.font = "10.5px sans-serif";
      ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillText(this._fmtP(p), pW + 7, y);
      // time label
      const i = this.iOf(x);
      if (i >= 0 && i < this.bars.length && i <= this._rIdx()) {
        const d = new Date(this.bars[i].t * 1000);
        const txt = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
                    String(d.getUTCDate()).padStart(2, "0") + " " +
                    String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
        ctx.font = "10.5px sans-serif";
        const w = ctx.measureText(txt).width + 14;
        ctx.fillStyle = "#434651";
        const lx = Math.max(0, Math.min(x - w / 2, pW - w));
        ctx.fillRect(lx, pH + 2, w, this.timeH - 4);
        ctx.fillStyle = "#fff"; ctx.textAlign = "center";
        ctx.fillText(txt, lx + w / 2, pH + this.timeH / 2);
      }
      ctx.restore();
      ctx.textBaseline = "alphabetic";
    },

    /* ---------------- helpers ---------------- */
    _niceStep(span, count) {
      const raw = span / count;
      const mag = Math.pow(10, Math.floor(Math.log10(raw)));
      const n = raw / mag;
      const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
      return step * mag;
    },
    _tfSec() {
      const map = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800 };
      return map[this.tf] || 3600;
    },
    _timeStep() {
      const tf = this._tfSec();
      const target = Math.max(1, Math.floor(this._visCount() / 6));
      const cands = [tf, tf * 2, tf * 4, tf * 6, tf * 12, tf * 24, tf * 48, tf * 96, tf * 168,
                     3600, 7200, 21600, 43200, 86400, 172800, 604800, 1209600, 2592000];
      let best = cands[0];
      for (const c of cands) if (c >= target * tf) { best = c; break; }
      if (this._tfSec() >= 86400 && this._tfSec() % 86400 === 0)
        best = Math.max(best, 86400 * Math.ceil((target * tf) / 86400));
      return best;
    },
    _fmtP(p) {
      const d = this.digits;
      if (d >= 5) return p.toFixed(5);
      if (d === 3) return p.toFixed(3);
      if (Math.abs(p) >= 1000) return p.toFixed(1);
      return p.toFixed(d);
    },
    _rr(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    },
  };

  global.Chart = Chart;
})(window);
