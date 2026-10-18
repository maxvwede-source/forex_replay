#!/usr/bin/env python3
"""Fetch historical OHLC data for the forex_replay site and bundle as compact JSON."""
import warnings, json, time, os, sys
warnings.filterwarnings("ignore")

import yfinance as yf
import pandas as pd
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data")
os.makedirs(OUT, exist_ok=True)

SYMBOLS = [
    {"id": "EURUSD", "yahoo": "EURUSD=X", "name": "EUR/USD", "digits": 5, "pip": 0.0001, "cat": "forex", "desc": "Euro / US Dollar"},
    {"id": "GBPUSD", "yahoo": "GBPUSD=X", "name": "GBP/USD", "digits": 5, "pip": 0.0001, "cat": "forex", "desc": "British Pound / US Dollar"},
    {"id": "USDJPY", "yahoo": "USDJPY=X", "name": "USD/JPY", "digits": 3, "pip": 0.01,   "cat": "forex", "desc": "US Dollar / Japanese Yen"},
    {"id": "AUDUSD", "yahoo": "AUDUSD=X", "name": "AUD/USD", "digits": 5, "pip": 0.0001, "cat": "forex", "desc": "Australian Dollar / US Dollar"},
    {"id": "USDCAD", "yahoo": "USDCAD=X", "name": "USD/CAD", "digits": 5, "pip": 0.0001, "cat": "forex", "desc": "US Dollar / Canadian Dollar"},
    {"id": "USDCHF", "yahoo": "USDCHF=X", "name": "USD/CHF", "digits": 5, "pip": 0.0001, "cat": "forex", "desc": "US Dollar / Swiss Franc"},
    {"id": "NZDUSD", "yahoo": "NZDUSD=X", "name": "NZD/USD", "digits": 5, "pip": 0.0001, "cat": "forex", "desc": "New Zealand Dollar / US Dollar"},
    {"id": "XAUUSD", "yahoo": "GC=F", "name": "XAU/USD", "digits": 2, "pip": 0.1,    "cat": "metal", "desc": "Gold Spot / US Dollar"},
    {"id": "BTCUSD", "yahoo": "BTC-USD",  "name": "BTC/USD",  "digits": 2, "pip": 1.0,    "cat": "crypto", "desc": "Bitcoin / US Dollar"},
    {"id": "ETHUSD", "yahoo": "ETH-USD",  "name": "ETH/USD",  "digits": 2, "pip": 0.1,    "cat": "crypto", "desc": "Ethereum / US Dollar"},
]

# timeframe id -> (interval, lookback_days)
TFS = {
    "1m":  ("1m", 5),
    "5m":  ("5m", 30),
    "15m": ("15m", 55),
    "1h":  ("1h", 365),
    "1d":  ("1d", 1830),
}

def fetch(sym, interval, days, retries=3):
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days)
    for a in range(retries):
        try:
            df = yf.download(sym, start=start.strftime("%Y-%m-%d"), end=end.strftime("%Y-%m-%d"),
                             interval=interval, progress=False, auto_adjust=True)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)
            if df is not None and len(df) > 10:
                return df
        except Exception as e:
            print(f"  retry {a+1}: {e}", flush=True)
        time.sleep(2 + a * 3)
    return None

def to_rows(df, digits):
    df = df[["Open", "High", "Low", "Close", "Volume"]].copy()
    df = df.dropna()
    df = df[(df["Close"] > 0) & (df["High"] > 0)]
    df = df[~df.index.duplicated(keep="last")]
    df = df.sort_index()
    rows = []
    for ts, r in df.iterrows():
        t = int(ts.timestamp())
        rows.append([
            t,
            round(float(r["Open"]), digits),
            round(float(r["High"]), digits),
            round(float(r["Low"]), digits),
            round(float(r["Close"]), digits),
            round(float(r["Volume"]) or 0, 2),
        ])
    return rows

def main():
    catalog = {"generated": datetime.now(timezone.utc).isoformat(), "symbols": [], "timeframes": list(TFS.keys())}
    only = sys.argv[1] if len(sys.argv) > 1 else None
    for s in SYMBOLS:
        if only and only != s["id"]:
            continue
        entry = dict(s)
        entry["files"] = {}
        for tf, (interval, days) in TFS.items():
            if s["cat"] == "forex" and tf == "1d":
                continue  # Yahoo FX dailies have open~close; UI rebuilds 1D/1W from 1h
            print(f"{s['id']} {tf} ...", end=" ", flush=True)
            fname = f"{s['id']}_{tf}.json"
            fpath = os.path.join(OUT, fname)
            if os.path.exists(fpath) and os.path.getsize(fpath) > 20000:
                entry["files"][tf] = fname
                print("cached")
                continue
            df = fetch(s["yahoo"], interval, days)
            if df is None or len(df) < 10:
                print("FAILED")
                continue
            rows = to_rows(df, s["digits"])
            if len(rows) < 10:
                print("too few rows")
                continue
            with open(fpath, "w") as f:
                json.dump({"symbol": s["id"], "tf": tf, "digits": s["digits"], "bars": rows},
                          f, separators=(",", ":"))
            entry["files"][tf] = fname
            print(f"{len(rows)} bars -> {fname}")
            time.sleep(1.2)
        catalog["symbols"].append(entry)
        with open(os.path.join(OUT, "catalog.json"), "w") as f:
            json.dump(catalog, f, indent=1)
    print("DONE", flush=True)

if __name__ == "__main__":
    main()
