/* UI layer: symbol/timeframe switching, order ticket, panels, replay transport, toasts */
(function (global) {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const fmt$ = (v) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const UI = {
    symbol: "EURUSD",
    tf: "1h",
    mode: "live",
    liveSource: null,
    _lastLiveBarT: null,

    /* =============== boot =============== */
    init() {
      this._toolbar();
      this._ticket();
      this._replayUI();
      this._symbolModal();
      this._settings();
      this._keys();
      this._panels();
      this._mobile();
      this._panelResize();
      this._clock();

      Chart.onCursor = (bar) => this._legend(bar);
      Trade.onUpdate = (type, info) => this._tradeEvent(type, info);
      Trade.priceProvider = (sym) => this.priceNow(sym);

      Trade.init();
      this._paintAccount();
    },

    /* =============== data flow =============== */
    async selectSymbol(id) {
      if (id === this.symbol) return;
      this.symbol = id;
      $("#symName").textContent = Data.meta(id).name;
      $("#tkSym").textContent = Data.meta(id).name;
      Tools.load(id);
      await this.loadChart();
      this.refreshAll();
    },
    async selectTf(tf) {
      if (tf === this.tf) return;
      this.tf = tf;
      $$(".tf-btn").forEach((b) => b.classList.toggle("active", b.dataset.tf === tf));
      $("#lgSym").textContent = Data.meta(this.symbol).name + " · " + tf.toUpperCase();
      await this.loadChart();
      this.refreshAll();
    },

    async loadChart() {
      const meta = Data.meta(this.symbol);
      let bars;
      try { bars = await Data.bars(this.symbol, this.tf); }
      catch (e) { this.toast("No data for " + meta.name + " " + this.tf, String(e.message || e), "bad"); return; }
      Replay.setSeries(bars, this.symbol + "_" + this.tf);
      Replay.pause();
      Replay.enabled = this.mode === "replay";
      Replay.cursor = this.mode === "replay" ? Replay.defIdx(0.72) : Replay.all.length - 1;
      Chart.setSeries(Replay.all, meta, this.tf, Replay.enabled ? Replay.cursor : -1);
      this._lastLiveBarT = null;
      $("#lgSym").textContent = meta.name + " · " + this.tf.toUpperCase();
      $("#rpSlider").max = Math.max(60, Replay.all.length - 1);
      $("#rpSlider").min = 0;
      this._feed();
      this._syncTransport();
      this._legend(null);
      $("#tpInput").value = ""; $("#slInput").value = "";
      this._prefillTPSL();

      if (this.mode === "live") Data.startLive(this.symbol, this.tf, (arr, src) => this._liveArrived(arr, src));
      else Data.stopLive();
    },

    _liveArrived(arr, src) {
      this.liveSource = src === "disjoint" ? null : src;
      if (src === "disjoint") {
        this.toast("Live feed paused", "Price level incompatible with bundled history — showing bundled data", "warn");
        this._feed(); this._legend(null);
        return;
      }
      const last = arr[arr.length - 1];
      const prevT = this._lastLiveBarT;
      this._feed();
      if (Replay.enabled) return;
      this._legend(null);
      if (prevT && last.t !== prevT) {
        // a bar closed -> evaluate SL/TP on it
        const closed = arr[arr.length - 2];
        if (closed) Trade.onBar(closed).then(() => this.refreshAll());
      }
      this._lastLiveBarT = last.t;
      Chart.setSeries(arr, null, null);
      Chart.onSeriesGrew();
      this.refreshAll();
    },

    priceNow(sym) {
      if (sym === this.symbol) {
        const b = Chart.revealedBar();
        return b ? b.c : null;
      }
      const c = Data.cache;
      for (const k of Object.keys(c)) {
        if (k.lastIndexOf(sym + "_", 0) === 0 && c[k].length) return c[k][c[k].length - 1].c;
      }
      return null;
    },

    /* =============== replay wiring =============== */
    async _stepForward(cursor, bar, silent) {
      Chart.setSeries(Replay.all, null, null, Replay.enabled ? cursor : -1);
      Chart.onSeriesGrew();
      this._syncTransport();
      if (!silent && bar && Replay.enabled) {
        await Trade.onBar(bar);
        this.refreshAll();
      }
      this._legend(null);
    },

    _replayUI() {
      Replay.onStep = (c, b, s) => this._stepForward(c, b, s);
      Replay.onToggle = () => this._syncTransport();

      $("#rpPlay").onclick = () => Replay.toggle();
      $("#rpStepF").onclick = () => Replay.stepF();
      $("#rpStepB").onclick = () => Replay.stepB();
      $("#rpRestart").onclick = () => Replay.restart();
      $$("#speedMenu button").forEach((b) => b.onclick = () => {
        $$("#speedMenu button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        Replay.setSpeed(+b.dataset.speed);
      });
      $("#rpSlider").oninput = (e) => {
        Replay.pause();
        Replay.seek(+e.target.value);
      };
      $("#jumpGo").onclick = () => {
        const v = $("#jumpDate").value;
        if (!v) return;
        Replay.pause();
        Replay.seekTime(Date.parse(v) / 1000);
      };
      $("#modeToggle").onclick = () => this.toggleMode();
      this._cutUI();
      this._cutTailUI();
    },

    /* scissors: cut segments out of the playback sequence */
    _cutUI() {
      Chart.onCut = (i0, i1) => {
        const b0 = Chart.bars[i0], b1 = Chart.bars[i1];
        const cutBtn = $("#rpCut");
        if (cutBtn) cutBtn.classList.remove("active");
        if (!b0 || !b1) { Chart.requestRender(); return; }
        const tfSec = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800 }[this.tf] || 3600;
        const res = Replay.addCut(b0.t, b1.t + tfSec);
        if (res.err) { this.toast("Cut failed", res.err, "bad"); Chart.requestRender(); return; }
        Chart.setSeries(Replay.all, null, null, Replay.cursor);
        Chart.onSeriesGrew();
        this._syncTransport();
        this.toast("✂ " + res.removed + " bars cut",
          "Playback will skip that segment — tap ↺ to bring it back", "warn");
      };
      $("#rpCut").onclick = () => {
        if (!Replay.enabled) { this.toast("Scissors", "Switch to REPLAY mode first", "warn"); return; }
        if (Chart.cutTail != null) this._cancelCutTail();
        if (Chart.cutMode) {                              // cancel
          Chart.cutMode = false; Chart.cutSel = null;
          $("#rpCut").classList.remove("active");
          Chart.requestRender();
          return;
        }
        Tools.setTool("cursor");
        Chart.cutMode = true; Chart.cutSel = null;
        $("#rpCut").classList.add("active");
        Chart.requestRender();
        this.toast("Scissors active",
          "Full history shown — drag across the chart to cut that segment out of playback", "warn");
      };
      $("#rpRestore").onclick = () => {
        const n = Replay.clearCuts();
        if (!n) return;
        Chart.setSeries(Replay.all, null, null, Replay.cursor);
        Chart.onSeriesGrew();
        this._syncTransport();
        this.toast("Cuts restored", n + " segment" + (n > 1 ? "s" : "") + " back in the playback", "warn");
      };
    },

    /* hazard-striped CUT button: pick a start line, adjust it, cut everything to the end */
    _cutTailUI() {
      const btn = $("#cutTailBtn"), box = $("#cutTailConfirm");
      Chart.onCutTailPick = (i) => {
        const b = Chart.bars[i];
        if (!b || !box) return;
        const remain = Replay.all.filter((z) => z.t < b.t).length;
        const tailN = Replay.full.filter((z) => z.t >= b.t).length;
        const when = new Date(b.t * 1000).toISOString().slice(0, 16).replace("T", " ");
        const info = $("#ctInfo"), ok = $("#ctOk");
        const tooLittle = remain < 30;
        info.textContent = tooLittle
          ? "✗ Only " + remain + " bars would remain — pick earlier"
          : "Cut " + tailN + " bars from " + when + " → END of history";
        ok.disabled = tooLittle;
        box.hidden = false;
      };
      btn.onclick = () => {
        if (Chart.cutTail != null) { this._cancelCutTail(); return; }
        if (Chart.cutMode) {
          Chart.cutMode = false; Chart.cutSel = null;
          const rb = $("#rpCut"); if (rb) rb.classList.remove("active");
        }
        Tools.setTool("cursor");
        Chart.cutTail = 0;
        btn.classList.add("active");
        if (box) box.hidden = true;
        Chart.requestRender();
        this.toast("✂ Cut to end",
          "Click the chart where the cut should start — drag the yellow line to adjust, then press OK", "warn");
      };
      $("#ctOk").onclick = () => {
        const i = Chart.cutTail;
        const b = (typeof i === "number" && i > 0) ? Chart.bars[i] : null;
        if (!b) return;
        const res = Replay.addCut(b.t, Number.MAX_SAFE_INTEGER);
        this._cancelCutTail();
        if (res.err) { this.toast("Cut failed", res.err, "bad"); return; }
        Chart.setSeries(Replay.all, null, null, Replay.cursor);
        Chart.onSeriesGrew();
        this._syncTransport();
        this.toast("✂ " + res.removed + " bars cut to the end",
          "History now ends at " + this._ts(b.t) + " — trade it without seeing the future · ↺ restores", "warn");
      };
      $("#ctCancel").onclick = () => this._cancelCutTail();
    },
    _cancelCutTail() {
      Chart.cutTail = null;
      const box = $("#cutTailConfirm"); if (box) box.hidden = true;
      const btn = $("#cutTailBtn"); if (btn) btn.classList.remove("active");
      Chart.requestRender();
    },

    async toggleMode() {
      if (Chart.cutTail != null) this._cancelCutTail();
      if (this.mode === "live") {
        this.mode = "replay";
        Data.stopLive();
        document.body.classList.add("is-replay");
        Replay.setSeries(Replay.full, Replay.key);      // rebuild cut-filtered sequence
        Replay.enter(Replay.defIdx(0.72));
        Chart.setSeries(Replay.all, null, null, Replay.cursor);  // align reveal with cut-filtered series
      } else {
        this.mode = "live";
        Replay.exit();
        document.body.classList.remove("is-replay");
        Replay.enabled = false;
        Chart.cutMode = false; Chart.cutSel = null;
        const cutBtn = $("#rpCut"); if (cutBtn) cutBtn.classList.remove("active");
        Chart.setSeries(Replay.full, null, null, -1);
        Data.startLive(this.symbol, this.tf, (arr, src) => this._liveArrived(arr, src));
      }
      this._syncTransport();
      this._feed();
      this.refreshAll();
    },

    _syncTransport() {
      const on = Replay.enabled;
      $("#modeToggle").classList.toggle("replay", on);
      $("#modeLabel").textContent = on ? "REPLAY" : "LIVE";
      $(".mode-dot").className = "mode-dot " + (on ? "replay" : "live");
      $("#rpPlay").textContent = Replay.playing ? "❚❚" : "▶";
      $("#replayOverlay").classList.toggle("ro-hidden", !on);
      document.body.classList.toggle("is-replay", this.mode === "replay");
      this._status();
      const sl = $("#rpSlider");
      sl.value = Replay.cursor;
      const b = Replay.currentBar();
      $("#rpTime").textContent = b ? this._ts(b.t, true) : "—";
      $("#rpCount").textContent = Replay.all.length
        ? "bar " + (Replay.cursor + 1) + " / " + Replay.all.length +
          (Replay.cutCount() ? " · ✂" + Replay.cutCount() : "") : "";
      const rb = $("#rpRestore"); if (rb) rb.hidden = !Replay.cutCount();
      if (b) {
        const d = new Date(b.t * 1000 - new Date().getTimezoneOffset() * 60000);
        $("#jumpDate").value = d.toISOString().slice(0, 16);
      }
    },

    /* =============== top bar =============== */
    _toolbar() {
      $$(".tf-btn").forEach((b) => b.onclick = () => this.selectTf(b.dataset.tf));
      $$(".ct-btn").forEach((b) => b.onclick = () => {
        $$(".ct-btn").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        Chart.type = b.dataset.type;
        Chart.requestRender();
      });
      $("#emaBtn").onclick = (e) => { Chart.ema = !Chart.ema; e.currentTarget.classList.toggle("active", Chart.ema); Chart.requestRender(); };
      $("#volBtn").onclick = (e) => { Chart.vol = !Chart.vol; e.currentTarget.classList.toggle("active", Chart.vol); Chart.requestRender(); };
      $("#volBtn").classList.add("active");

      $$("#toolBar .tool[data-tool]").forEach((b) => b.onclick = () => {
        if (Chart.cutTail != null) this._cancelCutTail();   // drawing beats cutting
        Tools.setTool(b.dataset.tool);
      });
      $("#undoBtn").onclick = () => Tools.undo();
      $("#clearBtn").onclick = () => { if (confirm("Clear all drawings for " + Data.meta(this.symbol).name + "?")) Tools.clearAll(); };

      // colour swatches
      const sw = document.createElement("div");
      sw.className = "tool-sep";
      sw.innerHTML = '<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;width:34px;padding-top:4px">' +
        ["#2962ff", "#f0b90b", "#ef5350", "#26a69a", "#ab47bc"].map((c) =>
          `<button class="swatch${c === "#2962ff" ? " active" : ""}" data-c="${c}" style="width:14px;height:14px;border-radius:50%;background:${c};border:2px solid ${c === "#2962ff" ? "#fff" : "transparent"}"></button>`).join("") +
        "</div>";
      $("#toolBar").appendChild(sw);
      $$(".swatch").forEach((b) => b.onclick = () => Tools.setColor(b.dataset.c));

      $("#dDel").onclick = () => {
        if (!Tools.sel) return;
        Tools.items = Tools.items.filter((x) => x !== Tools.sel);
        Tools._select(null); Tools.save(); Chart.requestRender();
      };
      $("#dEdit").onclick = () => {
        const it = Tools.sel;
        if (!it) return;
        if (it.type === "text") {
          const t = prompt("Edit text:", it.text);
          if (t != null) { it.text = t; Tools.save(); Chart.requestRender(); }
        } else this.toast("Tip", "Drag the end handles to reshape · right-click deletes", "warn");
      };
    },

    _keys() {
      window.addEventListener("keydown", (e) => {
        const tag = (e.target.tagName || "").toLowerCase();
        if (tag === "input" || tag === "select" || tag === "textarea") return;
        if (e.code === "Space") { e.preventDefault(); Replay.toggle(); return; }
        if (e.code === "ArrowRight") { e.preventDefault(); Replay.pause(); Replay.stepF(); return; }
        if (e.code === "ArrowLeft") { e.preventDefault(); Replay.pause(); Replay.stepB(); return; }
        if (e.key === "Escape") {
          if (Chart.cutTail != null) this._cancelCutTail();
          if (Chart.cutMode) {
            Chart.cutMode = false; Chart.cutSel = null;
            const cb = $("#rpCut"); if (cb) cb.classList.remove("active");
            Chart.requestRender();
          }
          Tools.setTool("cursor"); this._closeModals(); return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          if (Tools.sel) { Tools.items = Tools.items.filter((x) => x !== Tools.sel); Tools._select(null); Tools.save(); Chart.requestRender(); }
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); Tools.undo(); return; }
        const map = { t: "trend", h: "hline", f: "fib", m: "measure", v: "vline", r: "rect", a: "arrow" };
        if (map[e.key.toLowerCase()]) Tools.setTool(map[e.key.toLowerCase()]);
      });
    },

    /* =============== legend =============== */
    _legend(bar) {
      const b = bar || Chart.revealedBar();
      if (!b) return;
      const d = Data.meta(this.symbol).digits;
      $("#lgO").textContent = b.o.toFixed(d);
      $("#lgH").textContent = b.h.toFixed(d);
      $("#lgL").textContent = b.l.toFixed(d);
      $("#lgC").textContent = b.c.toFixed(d);
      const chg = b.c - b.o;
      const el = $("#lgChg");
      const bars = Chart.bars;
      const rev = Chart.revealedBar();
      const ref = bar ? b.o : (bars.length > 1 ? (rev || bars[bars.length - 1]).c : b.o);
      const diff = bar ? chg : b.c - ref;
      el.textContent = (diff >= 0 ? "+" : "") + diff.toFixed(d) + " (" + ((diff / ref) * 100).toFixed(2) + "%)";
      el.className = "chg " + (diff >= 0 ? "pos" : "neg");
    },

    _ts(t, long) {
      const d = new Date(t * 1000);
      const p = (n) => String(n).padStart(2, "0");
      const date = d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
      return long ? date + " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " UTC" : date;
    },

    _feed() {
      const el = $("#feedBadge");
      const src = this.mode === "replay" ? "replay" : this.liveSource;
      if (this.mode === "replay") { el.className = "feed-badge hist"; el.textContent = "REPLAY"; el.title = "Replaying bundled history — future bars hidden"; return; }
      if (src === "twelvedata") { el.className = "feed-badge live"; el.textContent = "LIVE"; el.title = "Real-time feed: Twelve Data"; }
      else if (src === "binance") { el.className = "feed-badge proxy"; el.textContent = "LIVE*"; el.title = "Live feed via liquid stablecoin/market proxy (Binance Vision)"; }
      else {
        const t = Data.lastAsOf[this.symbol];
        el.className = "feed-badge hist"; el.textContent = "HIST";
        el.title = t ? "Bundled data as of " + this._ts(t, true) : "Bundled historical data";
      }
      $("#lgSrc").textContent = src === "twelvedata" ? "· Twelve Data live"
        : src === "binance" ? "· Binance Vision live"
        : (this.mode === "replay" ? "· bar replay" : "· TradingView history");
      this._status();
    },

    /* =============== ticket =============== */
    _ticket() {
      $("#volUp").onclick = () => this._vol(+$("#volInput").value + 0.01);
      $("#volDn").onclick = () => this._vol(+$("#volInput").value - 0.01);
      $("#volInput").onchange = () => this._vol(+$("#volInput").value);
      $$(".quick-vol button").forEach((b) => b.onclick = () => {
        $$(".quick-vol button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        this._vol(+b.dataset.v);
      });
      $("#riskInput").oninput = () => this._riskSuggest();
      $("#tpOn").onchange = () => { this._prefillTPSL(); this._tpslVisibility(); };
      $("#slOn").onchange = () => { this._prefillTPSL(); this._tpslVisibility(); this._riskSuggest(); };
      $("#slInput").oninput = () => this._riskSuggest();
      $("#orderType").onchange = () => {
        const t = $("#orderType").value;
        $("#limitInput").hidden = t === "market";
        if (t !== "market" && !$("#limitInput").value)
          $("#limitInput").value = this.priceNow(this.symbol) || "";
        this._ticketPrices();
      };
      $("#buyBtn").onclick = () => this._order("buy");
      $("#sellBtn").onclick = () => this._order("sell");
      $("#qxSell").onclick = () => this._order("sell");
      $("#qxBuy").onclick = () => this._order("buy");
      this._tpslVisibility();
      this._ticketPrices();
    },
    _tpslVisibility() {
      $("#tpRow").style.display = $("#tpOn").checked ? "" : "none";
      $("#slRow").style.display = $("#slOn").checked ? "" : "none";
    },
    _vol(v) {
      v = Math.min(Math.max(Math.round(v * 100) / 100, 0.01), 100);
      $("#volInput").value = v.toFixed(2);
      $$(".quick-vol button").forEach((x) => x.classList.toggle("active", +x.dataset.v === v));
      this._riskSuggest();
      this._ticketPrices();
    },
    _prefillTPSL() {
      const m = Data.meta(this.symbol);
      const px = this.priceNow(this.symbol);
      if (!px) return;
      const dist = (m.cat === "crypto" ? 300 : m.cat === "metal" ? 50 : 12) * m.pip;
      if ($("#tpOn").checked && !$("#tpInput").value) $("#tpInput").value = (px + dist).toFixed(m.digits);
      if ($("#slOn").checked && !$("#slInput").value) $("#slInput").value = (px - dist).toFixed(m.digits);
      if (!$("#tpOn").checked) $("#tpInput").value = "";
      if (!$("#slOn").checked) $("#slInput").value = "";
    },
    async _riskSuggest() {
      const risk = +$("#riskInput").value;
      const sl = +$("#slInput").value;
      const entry = this.priceNow(this.symbol);
      if (!$("#slOn").checked || !sl || !entry) { $("#riskHint").textContent = "manual volume"; return; }
      const lots = await Trade.lotsForRisk(this.symbol, risk, sl, entry);
      if (lots) $("#riskHint").textContent = "≈ " + lots.toFixed(2) + " lot";
    },
    _ticketPrices() {
      const m = Data.meta(this.symbol);
      const t = $("#orderType").value;
      const bid = Trade.quote(this.symbol, "sell");
      const ask = Trade.quote(this.symbol, "buy");
      const p = (v) => (v == null ? "—" : v.toFixed(m.digits));
      $("#bidPx").textContent = p(bid);
      $("#askPx").textContent = p(ask);
      $("#sellLbl").textContent = t === "market" ? p(bid) : t === "limit" ? "LIMIT " + p(+$("#limitInput").value || 0) : "STOP " + p(+$("#limitInput").value || 0);
      $("#buyLbl").textContent = t === "market" ? p(ask) : t === "limit" ? "LIMIT " + p(+$("#limitInput").value || 0) : "STOP " + p(+$("#limitInput").value || 0);
      $("#tkSpread").textContent = "spread " + Data.pips(this.symbol, Trade.spread(this.symbol)).toFixed(1);
      const lots = +$("#volInput").value || 0.1;
      if (ask) {
        Data.notionalUSD(this.symbol, lots, ask).then((n) => {
          $("#marginReq").textContent = fmt$(n / Trade.settings.lev);
        }).catch(() => {});
      }
      $("#levLbl").textContent = "1:" + Trade.settings.lev;
    },

    async _order(side) {
      const m = Data.meta(this.symbol);
      const t = $("#orderType").value;
      const lots = +$("#volInput").value;
      const sl = $("#slOn").checked ? +$("#slInput").value : null;
      const tp = $("#tpOn").checked ? +$("#tpInput").value : null;
      const res = await Trade.place({
        symbol: this.symbol, side, lots, type: t,
        price: t === "market" ? null : +$("#limitInput").value,
        sl, tp,
      });
      if (res.err) { this.toast("Order rejected", res.err, "bad"); return; }
      if (res.order)
        this.toast("Pending " + res.order.type + " placed",
          side.toUpperCase() + " " + lots + " " + m.name + " @ " + res.order.price.toFixed(m.digits), "warn");
      else
        this.toast("Position opened",
          side.toUpperCase() + " " + lots + " " + m.name + " @ " + res.position.entry.toFixed(m.digits) +
          (sl ? " · SL " + sl.toFixed(m.digits) : "") + (tp ? " · TP " + tp.toFixed(m.digits) : ""), side === "buy" ? "good" : "bad");
      this.refreshAll();
    },

    /* =============== panels =============== */
    _panels() {
      $$(".panel-tabs button").forEach((b) => b.onclick = () => {
        $$(".panel-tabs button").forEach((x) => x.classList.remove("active"));
        $$(".tab-page").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        $("#tab-" + b.dataset.tab).classList.add("active");
      });
    },

    refreshPositions() { this.refreshAll(); },

    refreshAll() {
      this._paintAccount();
      this._paintPositions();
      this._paintOrders();
      this._paintHistory();
      this._chartState();
      this._ticketPrices();
    },

    _paintAccount() {
      const eq = Trade.equity(), fl = Trade.floating();
      const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
      set("#acctBalance", fmt$(Trade.balance));
      set("#acctEquity", fmt$(eq));
      const f = $("#acctFloat");
      f.textContent = (fl >= 0 ? "+" : "") + fmt$(fl);
      f.className = fl > 0 ? "pos" : fl < 0 ? "neg" : "zero";
      set("#acctOpen", String(Trade.positions.length));
      set("#ftBalance", fmt$(Trade.balance));
      set("#ftEquity", fmt$(eq));
      set("#ftFree", fmt$(Trade.freeMargin()));
      const ml = Trade.marginLevel();
      set("#ftLevel", ml == null ? "—" : ml.toFixed(1) + "%");
      set("#posCnt", String(Trade.positions.length));
      set("#ordCnt", String(Trade.orders.length));
      set("#hisCnt", String(Trade.history.length));
    },

    _paintPositions() {
      const tb = $("#posTable tbody");
      tb.innerHTML = "";
      $("#posEmpty").style.display = Trade.positions.length ? "none" : "";
      $("#posTable").style.display = Trade.positions.length ? "" : "none";
      for (const p of Trade.positions) {
        const m = Data.meta(p.symbol);
        const cur = this.priceNow(p.symbol);
        const bid = cur == null ? null : cur - Trade.spread(p.symbol) / 2;
        const px = p.side === "buy" ? bid : bid == null ? null : bid + Trade.spread(p.symbol);
        let pnl = 0, pips = 0;
        if (px != null) {
          const raw = (px - p.entry) * (p.side === "buy" ? 1 : -1) * m.contract * p.lots;
          pnl = m.quote === "USD" ? raw : this._conv(m.quote, raw);
          pips = Data.pips(p.symbol, px - p.entry) * (p.side === "buy" ? 1 : -1);
        }
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + m.name + "</td>" +
          '<td><span class="side-tag ' + p.side + '">' + p.side.toUpperCase() + "</span></td>" +
          "<td>" + p.lots.toFixed(2) + "</td>" +
          "<td>" + p.entry.toFixed(m.digits) + "</td>" +
          "<td>" + (px == null ? "—" : px.toFixed(m.digits)) + "</td>" +
          '<td class="' + (pnl >= 0 ? "pos" : "neg") + '">' + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) +
          '<br><small>' + (pips >= 0 ? "+" : "") + pips.toFixed(1) + "p</small></td>" +
          '<td><button class="row-x" title="Close position">✕</button></td>';
        tr.querySelector(".row-x").onclick = () => Trade.close(p.id, "manual");
        tr.title = "SL " + (p.sl ? p.sl.toFixed(m.digits) : "—") + " · TP " + (p.tp ? p.tp.toFixed(m.digits) : "—") +
                   " · opened " + this._ts(p.t, true);
        tb.appendChild(tr);
      }
    },

    _conv(ccy, raw) {
      const arr = Data.cache["USD" + ccy + "_1d"] || Data.cache["USD" + ccy + "_1h"];
      return arr && arr.length ? raw / arr[arr.length - 1].c : raw;
    },

    _paintOrders() {
      const tb = $("#ordTable tbody");
      tb.innerHTML = "";
      $("#ordEmpty").style.display = Trade.orders.length ? "none" : "";
      $("#ordTable").style.display = Trade.orders.length ? "" : "none";
      for (const o of Trade.orders) {
        const m = Data.meta(o.symbol);
        const tr = document.createElement("tr");
        tr.innerHTML =
          "<td>" + m.name + "</td>" +
          '<td><span class="side-tag ' + o.side + '">' + o.type.toUpperCase() + " " + o.side.toUpperCase() + "</span></td>" +
          "<td>" + o.lots.toFixed(2) + "</td>" +
          "<td>" + o.price.toFixed(m.digits) + "</td>" +
          "<td>" + (o.sl ? o.sl.toFixed(m.digits) : "—") + "/" + (o.tp ? o.tp.toFixed(m.digits) : "—") + "</td>" +
          '<td><button class="row-x" title="Cancel order">✕</button></td>';
        tr.querySelector(".row-x").onclick = () => Trade.cancel(o.id);
        tb.appendChild(tr);
      }
    },

    _paintHistory() {
      const tb = $("#hisTable tbody");
      tb.innerHTML = "";
      $("#hisEmpty").style.display = Trade.history.length ? "none" : "";
      $("#hisTable").style.display = Trade.history.length ? "" : "none";
      let wins = 0, net = 0;
      for (const h of Trade.history.slice(0, 100)) {
        const m = Data.meta(h.symbol);
        if (h.pnl > 0) wins++;
        net += h.pnl;
        const tr = document.createElement("tr");
        const why = h.reason === "TP" ? '<span class="pos">TP</span>'
          : h.reason === "SL" ? '<span class="neg">SL</span>'
          : h.reason === "liquid" ? '<span class="neg">LIQ</span>' : "MAN";
        tr.innerHTML =
          "<td>" + m.name + "</td>" +
          '<td><span class="side-tag ' + h.side + '">' + h.side.toUpperCase() + "</span></td>" +
          "<td>" + h.lots.toFixed(2) + "</td>" +
          "<td>" + h.entry.toFixed(m.digits) + "</td>" +
          "<td>" + h.exit.toFixed(m.digits) + "</td>" +
          '<td class="' + (h.pnl >= 0 ? "pos" : "neg") + '">' + (h.pnl >= 0 ? "+" : "") + h.pnl.toFixed(2) +
          '<br><small>' + (h.pips >= 0 ? "+" : "") + h.pips.toFixed(1) + "p</small></td>" +
          "<td>" + why + "</td>";
        tr.title = this._ts(h.tIn, true) + " → " + this._ts(h.tOut, true);
        tb.appendChild(tr);
      }
      const n = Trade.history.length;
      const wr = n ? (wins / Math.min(n, 100)) * 100 : 0;
      $("#histStats").innerHTML = n
        ? "Trades <b>" + n + "</b> · Win rate <b>" + wr.toFixed(0) + "%</b> · Net <b class=\"" +
          (net >= 0 ? "pos" : "neg") + "\">" + (net >= 0 ? "+" : "") + net.toFixed(2) +
          " USD</b> <button id=\"csvBtn\" style=\"color:#7aa2ff;margin-left:auto\">⬇ CSV</button>"
        : "";
      const csv = $("#csvBtn");
      if (csv) csv.onclick = () => {
        const blob = new Blob([Trade.exportCSV()], { type: "text/csv" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "forexreplay_trades.csv";
        a.click();
      };
    },

    /* trade markers + position lines for the chart */
    _chartState() {
      const sym = this.symbol;
      const markers = [];
      for (const h of Trade.history) {
        if (h.symbol !== sym) continue;
        markers.push({ t: h.tIn, price: h.entry, dir: h.side, kind: "entry", label: h.lots.toFixed(2) });
        markers.push({ t: h.tOut, price: h.exit, kind: "exit", pnl: h.pnl });
      }
      Chart.setMarkers(markers.slice(-400));

      const lines = [];
      for (const p of Trade.positions) {
        if (p.symbol !== sym) continue;
        const m = Data.meta(sym);
        const col = p.side === "buy" ? "#26a69a" : "#ef5350";
        lines.push({ role: "entry", price: p.entry, color: col,
          tag: (p.side === "buy" ? "BUY " : "SELL ") + p.lots.toFixed(2) + " " + m.name + " @ " + p.entry.toFixed(m.digits),
          tagSub: p.src && p.src !== "market" ? "(" + p.src + ")" : "" });
        if (p.sl) lines.push({ role: "sl", drole: "sl", posId: p.id, pos: p, price: p.sl, color: "#ef5350",
          tag: "SL " + p.sl.toFixed(m.digits), tagSub: this._riskTag(p, "sl") });
        if (p.tp) lines.push({ role: "tp", drole: "tp", posId: p.id, pos: p, price: p.tp, color: "#26a69a",
          tag: "TP " + p.tp.toFixed(m.digits), tagSub: this._riskTag(p, "tp") });
      }
      for (const o of Trade.orders) {
        if (o.symbol !== sym) continue;
        const m = Data.meta(sym);
        lines.push({ role: "order", price: o.price, color: "#2962ff",
          tag: (o.side === "buy" ? "BUY " : "SELL ") + o.type.toUpperCase() + " " + o.lots.toFixed(2) + " @ " + o.price.toFixed(m.digits),
          tagSub: "click ✕ in Pending tab" });
      }
      Chart.setPosLines(lines);
    },

    _riskTag(p, kind) {
      const m = Data.meta(p.symbol);
      const lvl = kind === "sl" ? p.sl : p.tp;
      const dist = (lvl - p.entry) * (p.side === "buy" ? 1 : -1);
      const pips = Data.pips(p.symbol, dist);
      const raw = dist * m.contract * p.lots;
      const usd = m.quote === "USD" ? raw : this._conv(m.quote, raw);
      return (pips >= 0 ? "+" : "") + pips.toFixed(1) + "p  " + (usd >= 0 ? "+" : "") + usd.toFixed(2);
    },

    _tradeEvent(type, info) {
      if (type === "close") {
        const m = Data.meta(info.symbol);
        const good = info.pnl >= 0;
        const why = info.reason === "TP" ? "Take profit hit" : info.reason === "SL" ? "Stop loss hit" : "Closed";
        this.toast(why,
          m.name + " " + info.side.toUpperCase() + " " + info.lots.toFixed(2) +
          " · " + (info.pnl >= 0 ? "+" : "") + info.pnl.toFixed(2) + " USD (" +
          (info.pips >= 0 ? "+" : "") + info.pips.toFixed(1) + " pips)",
          good ? "good" : "bad");
      } else if (type === "reject") this.toast("Margin call", "Pending order skipped — free margin too low", "bad");
      this.refreshAll();
    },

    /* =============== symbol modal =============== */
    _symbolModal() {
      $("#symbolBtn").onclick = () => {
        $("#symModal").classList.remove("hidden");
        $("#symSearch").value = "";
        this._renderSymList("");
        $("#symSearch").focus();
      };
      $("#symSearch").oninput = (e) => this._renderSymList(e.target.value);
      $("#symModal").onclick = (e) => { if (e.target.id === "symModal") this._closeModals(); };
      $("#settingsModal").onclick = (e) => { if (e.target.id === "settingsModal") this._closeModals(); };
    },
    _renderSymList(q) {
      q = (q || "").toLowerCase();
      const groups = { forex: "Forex", metal: "Metals", crypto: "Crypto" };
      let html = "";
      for (const g of Object.keys(groups)) {
        const list = Data.catalog.symbols.filter((s) =>
          s.cat === g && (!q || (s.name + " " + s.id + " " + (s.desc || "")).toLowerCase().includes(q)));
        if (!list.length) continue;
        html += '<div class="sym-group">' + groups[g] + "</div>";
        for (const s of list) {
          html += '<div class="sym-item" data-id="' + s.id + '"><b>' + s.name + "</b><span>" +
            (s.desc || s.id) + "</span><em>8 TF</em></div>";
        }
      }
      if (!html) html = '<div class="empty">No symbol matches "' + q + '"</div>';
      $("#symList").innerHTML = html;
      $$("#symList .sym-item").forEach((el) => el.onclick = () => {
        this._closeModals();
        this.selectSymbol(el.dataset.id);
      });
    },
    _closeModals() {
      $("#symModal").classList.add("hidden");
      $("#settingsModal").classList.add("hidden");
    },

    /* =============== settings =============== */
    _settings() {
      $("#settingsBtn").onclick = () => {
        $("#setBalance").value = Trade.startBalance;
        $("#setSpread").value = Data.meta(this.symbol).spread;
        $("#settingsModal").classList.remove("hidden");
      };
      $("#setClose").onclick = () => this._closeModals();
      $("#setApply").onclick = () => {
        const bal = +$("#setBalance").value || 10000;
        const lev = +($("#setLev").value.split(":")[1]) || 100;
        const sp = +$("#setSpread").value;
        const m = Data.meta(this.symbol);
        if (m) m.spread = sp;
        Trade.init({ balance: bal, lev, spreadPips: sp });
        this.toast("Settings applied", "Account reset to " + fmt$(bal) + " · 1:" + lev, "warn");
        this._closeModals();
        this.refreshAll();
      };
    },

    /* =============== clock / countdown / status =============== */
    _clock() {
      const p = (n) => String(n).padStart(2, "0");
      const tick = () => {
        const now = new Date();
        const c = $("#sbClock");
        if (c) c.textContent = p(now.getUTCHours()) + ":" + p(now.getUTCMinutes()) + ":" + p(now.getUTCSeconds()) + " UTC";
        const el = $("#lgCount");
        if (el) {
          const b = Chart.revealedBar();
          if (this.mode === "replay" || !b) el.textContent = "";
          else {
            const tfSec = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400, "1W": 604800 }[this.tf] || 3600;
            const left = Math.max(0, Math.floor(((b.t + tfSec) * 1000 - now.getTime()) / 1000));
            const hh = Math.floor(left / 3600), mm = Math.floor((left % 3600) / 60), ss = left % 60;
            el.textContent =
              left < 60   ? "closes " + left + "s" :
              left < 3600 ? "closes " + p(mm) + ":" + p(ss) :
              left < 86400 ? "closes " + hh + ":" + p(mm) + ":" + p(ss) :
                            "closes " + Math.floor(hh / 24) + "d " + p(hh % 24) + ":" + p(mm) + ":" + p(ss);
          }
        }
        const barsEl = $("#sbBars");
        if (barsEl) barsEl.textContent = (Chart.bars.length || 0).toLocaleString("en-US") + " bars";
      };
      tick();
      setInterval(tick, 1000);
    },
    _status() {
      const l = $("#sbLeft");
      if (!l) return;
      if (this.mode === "replay") l.textContent = "◄ REPLAY — future bars hidden · ▶ play";
      else l.textContent = this.liveSource === "twelvedata" ? "LIVE · Twelve Data"
        : this.liveSource === "binance" ? "LIVE · Binance proxy"
        : "HISTORY · TradingView data";
    },

    /* =============== mobile sheet + panel resize =============== */
    _mobile() {
      const open = () => {
        $("#sidePanel").classList.add("open");
        $("#sheetBackdrop").classList.add("show");
        document.body.classList.add("sheet-open");
      };
      const close = () => {
        $("#sidePanel").classList.remove("open");
        $("#sheetBackdrop").classList.remove("show");
        document.body.classList.remove("sheet-open");
      };
      this.closeSheet = close;
      const fab = $("#tradeFab"); if (fab) fab.onclick = open;
      const cl = $("#sheetClose"); if (cl) cl.onclick = close;
      const bd = $("#sheetBackdrop"); if (bd) bd.onclick = close;
    },
    _panelResize() {
      const h = $("#panelHandle");
      if (!h) return;
      let dragging = false;
      h.addEventListener("pointerdown", (e) => {
        if (window.innerWidth <= 768) return;
        dragging = true; h.classList.add("dragging");
        try { h.setPointerCapture(e.pointerId); } catch (err) {}
      });
      h.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const w = Math.min(480, Math.max(260, window.innerWidth - e.clientX));
        document.documentElement.style.setProperty("--panel-w", w + "px");
      });
      const end = () => { dragging = false; h.classList.remove("dragging"); };
      h.addEventListener("pointerup", end);
      h.addEventListener("pointercancel", end);
    },

    /* =============== toast =============== */
    toast(msg, sub, kind) {
      const box = $("#toasts");
      const el = document.createElement("div");
      el.className = "toast " + (kind || "");
      el.innerHTML = msg + (sub ? "<small>" + sub + "</small>" : "");
      box.appendChild(el);
      setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 350); }, 3800);
    },
  };

  global.UI = UI;
  global.$ = $;
  global.$$ = $$;
})(window);
