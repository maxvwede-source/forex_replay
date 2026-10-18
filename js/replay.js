/* Replay engine: play historical bars like a video (play/pause/step/speed/jump) */
(function (global) {
  "use strict";

  const Replay = {
    all: [],        // series actually played (full minus cut segments)
    full: [],       // complete series (source of truth)
    cuts: [],       // [[t0,t1], ...] removed segments, persisted per symbol+tf
    key: null,      // persistence key "SYM_tf"
    cursor: 0,      // index of last revealed bar (into `all`)
    playing: false,
    speed: 4,       // bars per second base
    timer: null,
    enabled: false, // replay mode active
    onStep: null,   // (cursor, bar) => void
    onToggle: null,

    /* -------- series with cuts -------- */
    setSeries(full, key) {
      const curT = this.all[this.cursor] ? this.all[this.cursor].t : null;
      this.full = full || [];
      if (key) this.key = key;
      this.cuts = this._loadCuts();
      this.all = this._applyCuts();
      if (curT != null) this.cursor = this._tIndex(curT);
      else this.cursor = Math.min(this.cursor, Math.max(0, this.all.length - 1));
      return this.all;
    },
    _applyCuts() {
      if (!this.cuts.length) return this.full.slice();
      const cuts = this.cuts;
      return this.full.filter((b) => {
        for (const c of cuts) if (b.t >= c[0] && b.t < c[1]) return false;
        return true;
      });
    },
    /* index of first bar with t >= given time (clamped) */
    _tIndex(t) {
      const a = this.all;
      let lo = 0, hi = a.length - 1, best = a.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (a[mid].t >= t) { best = mid; hi = mid - 1; } else lo = mid + 1;
      }
      return best;
    },
    _loadCuts() {
      if (!this.key) return [];
      try {
        const raw = localStorage.getItem("fr_cuts_" + this.key);
        const j = raw ? JSON.parse(raw) : [];
        return Array.isArray(j) ? j.filter((c) => Array.isArray(c) && c.length === 2) : [];
      } catch (e) { return []; }
    },
    _saveCuts() {
      if (!this.key) return;
      try { localStorage.setItem("fr_cuts_" + this.key, JSON.stringify(this.cuts)); } catch (e) {}
    },
    _mergeCuts() {
      this.cuts.sort((a, b) => a[0] - b[0]);
      const out = [];
      for (const c of this.cuts) {
        const last = out[out.length - 1];
        if (last && c[0] <= last[1]) last[1] = Math.max(last[1], c[1]);
        else out.push([c[0], c[1]]);
      }
      this.cuts = out;
    },
    /* remove bars in [t0, t1) from the PLAYABLE sequence; returns {removed} or {err} */
    addCut(t0, t1) {
      if (!(t1 > t0)) return { err: "empty range" };
      const curT = this.all[this.cursor] ? this.all[this.cursor].t : null;
      const inRange = (b) => b.t >= t0 && b.t < t1;
      const removed = this.all.filter(inRange).length;   // bars that actually leave the sequence
      if (removed <= 0) return { err: "nothing to cut there — that part is already cut" };
      if (this.all.length - removed < 30) return { err: "would remove too much history" };
      this.cuts.push([t0, t1]);
      this._mergeCuts();
      this._saveCuts();
      this.all = this._applyCuts();
      this.cursor = curT != null ? this._tIndex(curT) : Math.min(this.cursor, this.all.length - 1);
      return { removed };
    },
    clearCuts() {
      if (!this.cuts.length) return 0;
      const n = this.cuts.length;
      const curT = this.all[this.cursor] ? this.all[this.cursor].t : null;
      this.cuts = [];
      this._saveCuts();
      this.all = this._applyCuts();
      this.cursor = curT != null ? this._tIndex(curT) : this.cursor;
      return n;
    },
    cutCount() { return this.cuts.length; },

    enter(fromIdx) {
      this.enabled = true;
      this.playing = false;
      this.cursor = fromIdx != null ? fromIdx : this.defIdx(0.72);
      this._stopTimer();
      if (this.onToggle) this.onToggle();
      this._step(true);
    },
    exit() {
      this.enabled = false;
      this.playing = false;
      this._stopTimer();
      if (this.onToggle) this.onToggle();
      this._step(true);
    },

    /* safe default position: ~pct through the series, always in range */
    defIdx(pct) {
      const n = this.all.length;
      if (n <= 10) return Math.max(0, n - 1);
      return Math.max(5, Math.min(n - 1, Math.floor(n * (pct == null ? 0.72 : pct))));
    },

    visible() { return this.enabled ? this.all.slice(0, Math.min(this.cursor, this.all.length - 1) + 1) : this.all; },
    currentBar() { return this.all[this.cursor] || null; },

    play() {
      if (!this.enabled) this.enter();
      if (this.cursor >= this.all.length - 1) this.cursor = this.defIdx(0.5);
      this.playing = true;
      this._startTimer();
      if (this.onToggle) this.onToggle();
    },
    pause() {
      this.playing = false;
      this._stopTimer();
      if (this.onToggle) this.onToggle();
    },
    toggle() { this.playing ? this.pause() : this.play(); },

    stepF() {
      if (!this.enabled) return;
      if (this.cursor >= this.all.length - 1) { this.pause(); return; }
      this.cursor++;
      this._step();
    },
    stepB() {
      if (!this.enabled) return;
      if (this.cursor <= 20) return;
      this.cursor--;
      this._step();
    },
    restart() {
      if (!this.enabled) this.enter(this.defIdx(0.05));
      else { this.cursor = Math.min(this.defIdx(0.05), this.all.length - 1); this.pause(); this._step(true); }
    },
    seek(idx) {
      this.cursor = Math.max(0, Math.min(this.all.length - 1, Math.floor(idx)));
      this._step();
    },
    seekTime(t) {
      // first bar with t >= requested
      let lo = 0, hi = this.all.length - 1, best = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (this.all[mid].t >= t) { best = mid; hi = mid - 1; } else lo = mid + 1;
      }
      this.seek(best);
    },
    progress() {
      if (!this.all.length) return 100;
      return (this.cursor / Math.max(1, this.all.length - 1)) * 100;
    },

    setSpeed(s) {
      this.speed = s;
      if (this.playing) this._startTimer();
    },

    _startTimer() {
      this._stopTimer();
      const ms = Math.max(40, 1000 / this.speed);
      this.timer = setInterval(() => {
        if (this.cursor >= this.all.length - 1) { this.pause(); return; }
        this.stepF();
        if (this.cursor >= this.all.length - 1) this.pause();
      }, ms);
    },
    _stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; },

    _step(silent) {
      const bar = this.currentBar();
      if (this.onStep) this.onStep(this.cursor, bar, silent);
    },
  };

  global.Replay = Replay;
})(window);
