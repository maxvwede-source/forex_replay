#!/usr/bin/env python3
"""Fetch real TradingView historical OHLC into data/*.json (same schema as site)."""
import json, os, sys, time, traceback
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from tv_feed import TVFeed

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
DATA = os.path.normpath(os.path.join(ROOT, "data"))

# id -> (TV symbol, display name, category)
SYMBOLS = {
    "EURUSD":  ("OANDA:EURUSD",  "EUR/USD", "forex"),
    "GBPUSD":  ("OANDA:GBPUSD",  "GBP/USD", "forex"),
    "USDJPY":  ("OANDA:USDJPY",  "USD/JPY", "forex"),
    "AUDUSD":  ("OANDA:AUDUSD",  "AUD/USD", "forex"),
    "USDCAD":  ("OANDA:USDCAD",  "USD/CAD", "forex"),
    "USDCHF":  ("OANDA:USDCHF",  "USD/CHF", "forex"),
    "NZDUSD":  ("OANDA:NZDUSD",  "NZD/USD", "forex"),
    "XAUUSD":  ("OANDA:XAUUSD",  "Gold (XAU/USD)", "metal"),
    "BTCUSD":  ("BINANCE:BTCUSDT",  "Bitcoin / USD", "crypto"),
    "ETHUSD":  ("BINANCE:ETHUSDT",  "Ethereum / USD", "crypto"),
}
# site file key -> (TV interval, target bars)
TFS = {
    "1m":  ("1",   5000),
    "5m":  ("5",   8000),
    "15m": ("15",  8000),
    "1h":  ("60", 15000),
    "1d":  ("1D",  2500),
}


def write_sym(sym, tv_sym):
    got = {}
    for key, (iv, n) in TFS.items():
        for attempt in range(3):
            try:
                t0 = time.time()
                bars = TVFeed().history(tv_sym, iv, n)
                if len(bars) < 100 and key != "1d":
                    raise RuntimeError(f"too few bars {len(bars)}")
                path = os.path.join(DATA, f"{sym}_{key}.json")
                with open(path, "w") as f:
                    json.dump({"symbol": sym, "tf": key, "bars": bars}, f, separators=(",", ":"))
                got[key] = len(bars)
                print(f"  {sym:7s} {key:3s} {len(bars):6d} bars  {time.time()-t0:5.1f}s  ok", flush=True)
                break
            except Exception as e:
                print(f"  {sym:7s} {key:3s} attempt {attempt+1} FAIL: {e}", flush=True)
                time.sleep(2 + attempt * 3)
        else:
            got[key] = 0
        time.sleep(0.5)
    return got


def main():
    os.makedirs(DATA, exist_ok=True)
    catalog = {"generated": None, "symbols": []}
    cat_path = os.path.join(DATA, "catalog.json")
    if os.path.exists(cat_path):
        try: catalog = json.load(open(cat_path))
        except Exception: pass
    by_id = {s.get("id"): s for s in catalog.get("symbols", [])}
    for sym, (tv, display, cat) in SYMBOLS.items():
        print(f"== {sym} ({tv})", flush=True)
        got = write_sym(sym, tv)
        entry = by_id.get(sym)
        if entry is None:
            entry = {"id": sym, "name": display, "cat": cat,
                     "digits": 5 if cat == "forex" else (2 if sym == "XAUUSD" else 2),
                     "pip": 0.01 if sym == "XAUUSD" else (1 if cat == "crypto" else 0.0001),
                     "desc": display}
            by_id[sym] = entry
            catalog.setdefault("symbols", []).append(entry)
        entry["name"] = display          # keep display name, never the TV feed id
        entry["cat"] = cat
        entry["source"] = "tradingview"
        entry["tv"] = tv
        entry["files"] = {k: f"{sym}_{k}.json" for k, n in got.items() if n}
    # keep only known symbols, stable order
    order = list(SYMBOLS.keys())
    catalog["symbols"] = [by_id[s] for s in order if s in by_id]
    catalog["generated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    catalog["source"] = "tradingview"
    tmp = cat_path + ".tmp"
    json.dump(catalog, open(tmp, "w"), separators=(",", ":"))
    os.replace(tmp, cat_path)
    print("CATALOG updated:", catalog["generated"], flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        sys.exit(1)
