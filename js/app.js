/* Boot: init modules, load default chart, start render loop */
(async function () {
  "use strict";

  async function boot() {
    await Data.init();
    Chart.init();
    Tools.setChart(Chart);

    UI.mode = "replay";                    // land in replay mode — the core experience
    UI.init();
    $("#symName").textContent = Data.meta(UI.symbol).name;
    $("#tkSym").textContent = Data.meta(UI.symbol).name;
    $("#lgSym").textContent = Data.meta(UI.symbol).name + " · " + UI.tf.toUpperCase();

    Tools.load(UI.symbol);
    await UI.loadChart();
    UI.refreshAll();
    UI._legend(null);
    UI._syncTransport();

    // conversion pairs for non-USD quotes (JPY/CAD/CHF P/L & margin)
    ["USDJPY", "USDCAD", "USDCHF"].forEach((s) =>
      Data.bars(s, "1d").catch(() => {}));

    // subtle first-run nudge
    if (!localStorage.getItem("fr_seen")) {
      localStorage.setItem("fr_seen", "1");
      setTimeout(() => UI.toast("Replay ready",
        "Press ▶ or Space — bars print like a video. Place BUY/SELL, watch SL/TP hit.", "warn"), 700);
    }

    // live-mode ticket clock
    setInterval(() => { if (UI.mode === "live") UI._ticketPrices(); }, 900);
  }

  boot().catch((e) => {
    console.error(e);
    document.body.insertAdjacentHTML("beforeend",
      '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#131722;color:#ef5350;font:14px sans-serif;z-index:999">Boot failed: ' +
      (e && e.message ? e.message : e) + "</div>");
  });
})();
