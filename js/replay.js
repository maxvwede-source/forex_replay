/* Replay engine: play historical bars like a video (play/pause/step/speed/jump) */
(function (global) {
  "use strict";

  const Replay = {
    all: [],        // full series
    cursor: 0,      // index of last revealed bar
    playing: false,
    speed: 4,       // bars per second base
    timer: null,
    enabled: false, // replay mode active
    onStep: null,   // (cursor, bar) => void
    onToggle: null,

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
