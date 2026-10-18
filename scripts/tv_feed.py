#!/usr/bin/env python3
"""Minimal TradingView websocket datafeed (unofficial) — paged historical OHLC."""
import json, time, hashlib, threading
import websocket


class TVFeed:
    URL = ("wss://data.tradingview.com/socket.io/websocket"
           "?from=symbols%2F&date=2024_11_01-00_00")

    def __init__(self, timeout=20):
        self.timeout = timeout
        self.cs = "cs_" + hashlib.md5(str(time.time()).encode()).hexdigest()[:12]
        self.ws = None
        self._buf = ""
        self._bars = []
        self._done = threading.Event()
        self._error = None

    # ---- framing ----
    @staticmethod
    def _frame(p): return f"~m~{len(p)}~m~{p}"

    def _unframe(self):
        out = []
        while True:
            i = self._buf.find("~m~")
            if i < 0: break
            j = self._buf.find("~m~", i + 3)
            if j < 0: break
            try: n = int(self._buf[i + 3:j])
            except ValueError: break
            k = j + 3
            if len(self._buf) < k + n: break
            out.append(self._buf[k:k + n]); self._buf = self._buf[k + n:]
        return out

    def _send(self, m, p):
        self.ws.send(self._frame(json.dumps({"m": m, "p": p}, separators=(",", ":"))))

    # ---- session ----
    def connect(self):
        self.ws = websocket.create_connection(
            self.URL, timeout=self.timeout, origin="https://data.tradingview.com",
            header=["Origin: https://data.tradingview.com",
                    "User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                    "Chrome/120.0 Safari/537.36"])
        self._send("chart_create_session", [self.cs, ""])
        self._send("set_auth_token", ["unauthorized_user_token"])

    def close(self):
        try: self.ws.close()
        except Exception: pass

    def _pump(self, seconds):
        """Read frames for `seconds`, accumulate bars until series_completed."""
        t0 = time.time()
        self.ws.settimeout(0.5)
        while time.time() - t0 < seconds:
            try:
                chunk = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception:
                break
            if not chunk: continue
            self._buf += chunk
            for f in self._unframe():
                if f.startswith("~h~"):
                    self.ws.send(self._frame(f)); continue
                try: j = json.loads(f)
                except Exception: continue
                m = j.get("m")
                if m == "timescale_update":
                    for _sid, payload in j["p"][1].items():
                        for row in payload.get("s", []):
                            v = row.get("v")
                            if v and len(v) >= 6:
                                self._bars.append(v)
                elif m in ("series_completed", "series_ready"):
                    self._done.set()
                elif m in ("series_error", "critical_error", "symbol_error"):
                    self._error = f"{m}: {j.get('p')}"
                    self._done.set()

    # ---- public ----
    def history(self, symbol, interval, count, chunk=500, max_wait=45):
        """Return up to `count` bars [t,o,h,l,c,v] ascending."""
        self._bars, self._error, self._done = [], None, threading.Event()
        self.connect()
        self._send("resolve_symbol",
                   [self.cs, "sds_sym_1",
                    "=" + json.dumps({"symbol": symbol, "adjustment": "splits",
                                      "session": "regular"}, separators=(",", ":"))])
        self._send("create_series",
                   [self.cs, "sds_1", "s1", "sds_sym_1", interval, min(count, 500)])
        self._pump(8)
        want = count
        stalls = 0
        while len(self._bars) < want and stalls < 3 and not self._error:
            before = len(self._bars)
            more = min(want - before, 5000)
            self._done.clear()
            self._send("request_more_data", [self.cs, "sds_1", more])
            self._pump(6)
            if len(self._bars) == before:
                stalls += 1
                time.sleep(0.4)
        self.close()
        # de-dup + sort + trim newest `count`
        seen, out = set(), []
        for b in sorted(self._bars, key=lambda x: x[0]):
            t = int(b[0])
            if t in seen: continue
            seen.add(t)
            out.append([t, float(b[1]), float(b[2]), float(b[3]), float(b[4]),
                        float(b[5]) if b[5] is not None else 0.0])
        if len(out) > count: out = out[-count:]
        if self._error: raise RuntimeError(self._error)
        return out
