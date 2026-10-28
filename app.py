"""
fin_dash: view-only household portfolio dashboard.

Self-hostable equivalent of the Muse-hosted Household Portfolio Dashboard.
It shows, it does not trade: there are no buy/sell endpoints, no order
routes, and no brokerage credentials stored in this repo.

Data sources (hybrid, by design):
  1. CSV / XLSX import (brokerage exports) -- see /api/import
  2. Manual entry
  3. Market-data pull for quotes and price/volume history:
     - Yahoo Finance chart endpoint (free, no key,
       unofficial -- see README; Stooq is kept as a last-resort fallback
       but is currently bot-blocked for server requests)
       Quote = regular market price, change vs. previous close.
     - no provider reachable -> the holding's manual / imported price is
       used and the quote is labelled "manual".

Run:
    pip install -r requirements.txt
    python3 app.py          # http://127.0.0.1:5000, PORT env var to change
    # or:  flask --app app run --port 5000

Data lives in fin_dash.db (SQLite, created on first run, gitignored).
Never commit fin_dash.db or a real brokerage export. Use sample_holdings.csv as the import template format.
No API keys, no .env file, and no brokerage login are used by this app.
"""

import csv
import io
import json
import os
import re
import sqlite3
import urllib.request
import urllib.error
from datetime import datetime, timezone

from flask import Flask, Response, g, jsonify, request, send_from_directory

APP_DIR = os.path.dirname(os.path.abspath(__file__))



DB_PATH = os.environ.get("FIN_DASH_DB", os.path.join(APP_DIR, "fin_dash.db"))
app = Flask(__name__, static_folder="static", template_folder="templates")


# ---------------------------------------------------------------- database
def get_db():
    if "db" not in g:
        # timeout=30 + busy_timeout: a writer waits instead of failing
        # instantly with "database is locked" when another request is
        # writing. WAL lets readers proceed while a writer writes.
        g.db = sqlite3.connect(DB_PATH, timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
        g.db.execute("PRAGMA journal_mode = WAL")
        g.db.execute("PRAGMA busy_timeout = 30000")
    return g.db


@app.teardown_appcontext
def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS owners (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_id INTEGER NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            account_type TEXT NOT NULL DEFAULT 'Brokerage'
        );
        CREATE TABLE IF NOT EXISTS holdings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            symbol TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            shares REAL NOT NULL DEFAULT 0,
            cost_basis REAL NOT NULL DEFAULT 0,
            manual_price REAL,
            source TEXT NOT NULL DEFAULT 'manual',
            UNIQUE(account_id, symbol)
        );
        CREATE TABLE IF NOT EXISTS quotes (
            symbol TEXT PRIMARY KEY,
            price REAL, change REAL, change_pct REAL, volume REAL,
            provider TEXT, as_of TEXT, week_low REAL, week_high REAL,
            day_low REAL, day_high REAL
        );
        CREATE TABLE IF NOT EXISTS history_cache (
            symbol TEXT NOT NULL, date TEXT NOT NULL,
            open REAL, high REAL, low REAL, close REAL, volume REAL,
            PRIMARY KEY (symbol, date)
        );
        CREATE TABLE IF NOT EXISTS history_meta (
            symbol TEXT PRIMARY KEY, fetched_date TEXT
        );
        """
    )
    # Migration for databases created before the 52-week / day-range
    # columns existed.
    for _col in ("week_low REAL", "week_high REAL",
                 "day_low REAL", "day_high REAL"):
        try:
            db.execute(f"ALTER TABLE quotes ADD COLUMN {_col}")
        except sqlite3.OperationalError:
            pass  # column already exists
    db.execute("INSERT OR IGNORE INTO owners (name) VALUES ('Bruce')")
    db.execute("INSERT OR IGNORE INTO owners (name) VALUES ('Spouse')")
    db.commit()


with app.app_context():
    init_db()


def row(d):
    return dict(d) if d is not None else None


# ------------------------------------------------------------- market data
def _http_json(url, timeout=10):
    req = urllib.request.Request(url, headers={"User-Agent": "fin_dash/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_text(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": "fin_dash/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _yahoo_chart(symbol, range_="1y"):
    """Yahoo chart JSON. Unofficial endpoint, personal-use only.
    The symbol is URL-quoted so index symbols (^DJI, ^IXIC, ^GSPC)
    work as well as tickers — plain tickers are unchanged."""
    from urllib.parse import quote as _urlquote
    req = urllib.request.Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{_urlquote(symbol, safe='')}"
        f"?range={range_}&interval=1d",
        headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _yahoo_quote(symbol):
    """Yahoo quote dict, or None. This is the source for Last price,
    the 52-week range AND the day range: meta carries
    regularMarketPrice (intraday while the market is open, the close
    otherwise), regularMarketDayLow/High for today, and
    fiftyTwoWeekLow/High. If the day fields are absent, fall back to
    the last daily bar in the 5-day chart.

    Previous close is NOT meta chartPreviousClose: for a 5d chart
    that field is the close before the 5-day window (2026-10-20:
    $339.50 for AAPL; $52,495.88 for DJIA), not the previous trading
    day. That gave AAPL a bogus +$7.60 (+2.24%) instead of the hosted
    +$3.19 (+0.93%). Previous close is taken from the daily bars
    instead: the second-last close once the market has closed
    (price == last close: 2026-10-27 $347.10, previous 2026-10-26
    $343.91), or the last close while the market is still open
    (intraday price differs from the last bar).
    The "price == last close" test uses a relative tolerance, not
    a fixed $0.01: Yahoo rounds large index prices to 0.1 (DJIA
    price $52,377.6 vs last close $52,377.57, a $0.03 gap), so a
    fixed $0.01 test misread DJIA as intraday and gave +$0.03
    instead of the correct +$15.99 (Oct 26 close $52,361.58)."""
    result = _yahoo_chart(symbol, "5d")["chart"]["result"][0]
    meta = result["meta"]
    price = meta.get("regularMarketPrice")
    prev = None
    change = None
    try:
        closes = [v for v in result["indicators"]["quote"][0]["close"]
                  if v is not None]
        if closes:
            tol = max(0.01, abs(price) * 1e-6) if price else 0.01
            if abs(price - closes[-1]) <= tol and len(closes) >= 2:
                prev = closes[-2]
                # Change from the closes themselves, not the rounded
                # meta price: DJIA meta price $52,377.6 − Oct 26
                # $52,361.58 = $16.02, while the closes give the
                # screenshot-exact $52,377.57 − $52,361.58 = $15.99.
                change = closes[-1] - prev
            else:
                prev = closes[-1]
    except Exception:
        pass
    if prev is None:
        prev = meta.get("regularMarketPreviousClose") or meta.get("chartPreviousClose")
    if not (price and prev):
        return None
    if change is None:
        change = price - prev
    day_low = meta.get("regularMarketDayLow")
    day_high = meta.get("regularMarketDayHigh")
    if day_low is None or day_high is None:
        try:
            q = result["indicators"]["quote"][0]
            lows = [v for v in q["low"] if v is not None]
            highs = [v for v in q["high"] if v is not None]
            day_low = day_low if day_low is not None else (lows[-1] if lows else None)
            day_high = day_high if day_high is not None else (highs[-1] if highs else None)
        except Exception:
            pass
    return {"price": price, "change": change,
            "change_pct": change / prev * 100,
            "volume": meta.get("regularMarketVolume"),
            "provider": "yahoo-delayed",
            "week_low": meta.get("fiftyTwoWeekLow"),
            "week_high": meta.get("fiftyTwoWeekHigh"),
            "day_low": day_low, "day_high": day_high}


def fetch_quote(symbol):
    """Return a dict, or None.

    52-week range: Yahoo's chart meta carries fiftyTwoWeekLow /
    fiftyTwoWeekHigh directly, so no separate endpoint is needed;
    the detail view falls back to the min/max of the 1-year history
    when a quote does not supply a range (see symbol_detail).
    """
    symbol = symbol.upper()
    try:
        return _yahoo_quote(symbol)
    except Exception:
        pass
    try:
        text = _http_text(f"https://stooq.com/q/d/l/?s={symbol.lower()}.us&i=d")
        lines = [ln for ln in text.strip().splitlines() if ln.strip()]
        if len(lines) >= 3:  # header + at least 2 closes
            rows = [ln.split(",") for ln in lines[1:]]
            last, prev = rows[-1], rows[-2]
            close, prev_close = float(last[4]), float(prev[4])
            return {"price": close, "change": close - prev_close,
                    "change_pct": ((close - prev_close) / prev_close * 100
                                   if prev_close else None),
                    "volume": float(last[5]) if len(last) > 5 and last[5] else None,
                    "provider": "stooq-eod", "week_low": None, "week_high": None,
                    "day_low": None, "day_high": None}
    except Exception:
        pass
    return None


def _upsert_quote(db, symbol, q):
    now = datetime.now(timezone.utc).isoformat()
    db.execute(
        """INSERT INTO quotes (symbol, price, change, change_pct, volume,
                                provider, as_of, week_low, week_high,
                                day_low, day_high)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET price=excluded.price,
             change=excluded.change, change_pct=excluded.change_pct,
             volume=excluded.volume, provider=excluded.provider,
             as_of=excluded.as_of, week_low=excluded.week_low,
             week_high=excluded.week_high, day_low=excluded.day_low,
             day_high=excluded.day_high""",
        (symbol, q["price"], q["change"], q["change_pct"], q["volume"],
         q["provider"], now, q.get("week_low"), q.get("week_high"),
         q.get("day_low"), q.get("day_high")))


def _refresh_symbols(db, symbols):
    """Fetch and store quotes for symbols; returns (refreshed, failed).

    Root cause of the 2026-10-26 "database is locked" 500 on
    /api/refresh: the old code upserted each symbol as it fetched it,
    so a write transaction stayed open for the whole (slow, network)
    fetch loop. Any concurrent request that tried to write — a second
    Refresh click, or the dashboard's own first-load auto-refresh —
    then hit a locked database. Now all fetches happen first, with no
    DB writes open, and the upserts + commit are one short transaction
    at the end."""
    fetched = []
    failed = 0
    for sym in symbols:
        q = fetch_quote(sym)
        if q:
            fetched.append((sym, q))
        else:
            failed += 1
    for sym, q in fetched:
        _upsert_quote(db, sym, q)
    db.commit()
    return len(fetched), failed


def _quotes_need_refresh(db, symbols):
    """Symbols with no quote, or a quote stamped on an earlier UTC day.
    That is the 'when started, Last price is today's price' rule: the
    first dashboard load of a day pulls today's intraday price (or the
    close, once the market has closed), later loads reuse the cache
    until the user hits Refresh quotes."""
    today = datetime.now(timezone.utc).date().isoformat()
    stale = []
    for sym in symbols:
        r = db.execute("SELECT as_of FROM quotes WHERE symbol=?", (sym,)).fetchone()
        if r is None or not r["as_of"] or not str(r["as_of"]).startswith(today):
            stale.append(sym)
    return stale


def _nasdaq_summary(symbol):
    """Beta + market cap + sector/industry, best-effort, no key.

    Yahoo's quote / quoteSummary endpoints now return 401 without a
    crumb, so they are not usable from the server; the Nasdaq quote
    summary endpoint (public, no key) still returns MarketCap for
    stocks and ETFs, and Beta for ETFs (stocks return it when Nasdaq
    publishes one). Returns {} when unavailable — the detail view
    then simply omits beta/market cap instead of inventing them.
    Values are parsed to floats where possible; 'N/A' becomes None."""
    for assetclass in ("stocks", "etf"):
        try:
            data = _http_json_nasdaq(
                f"https://api.nasdaq.com/api/quote/{symbol}/summary"
                f"?assetclass={assetclass}", timeout=10)
        except Exception:
            continue
        if not data:
            continue
        summary = (data.get("data") or {}).get("summaryData") or {}
        if not summary:
            continue
        def _val(key):
            v = (summary.get(key) or {}).get("value")
            if v in (None, "", "N/A"):
                return None
            if isinstance(v, (int, float)):
                return float(v)
            try:
                return float(str(v).replace("$", "").replace(",", ""))
            except ValueError:
                return None
        out = {"beta": _val("Beta"), "market_cap": _val("MarketCap"),
               "sector": (summary.get("Sector") or {}).get("value"),
               "industry": (summary.get("Industry") or {}).get("value")}
        if out["beta"] is not None or out["market_cap"] is not None:
            return out
        # A summary with neither beta nor market cap is not a match
        # (wrong asset class can return a near-empty summary); try next.
    return {}


def _http_json_nasdaq(url, timeout=10):
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0",
                      "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_history(symbol):
    """Daily OHLCV, Yahoo first, Stooq as fallback. Returns list of dicts.

    Cached per symbol for one UTC day (see _history_cached): the
    growth chart calls fetch_history once per symbol, and the detail
    view calls it again for the same symbol, so without the cache a
    dashboard load fetched the same 1-year history twice and the
    growth chart re-fetched it on every owner-tab switch. A second
    load on the same day now reads the cache instead."""
    cached = _history_cached(symbol)
    if cached is not None:
        return cached
    hist = _fetch_history_live(symbol)
    if hist:
        _history_store(symbol, hist)
    return hist


def _history_cached(symbol):
    """Cached history if it was fetched today (UTC), else None."""
    try:
        db = get_db()
    except RuntimeError:
        return None
    today = datetime.now(timezone.utc).date().isoformat()
    meta = db.execute("SELECT fetched_date FROM history_meta WHERE symbol=?",
                      (symbol.upper(),)).fetchone()
    if meta is None or meta["fetched_date"] != today:
        return None
    rows = db.execute(
        "SELECT date, open, high, low, close, volume FROM history_cache "
        "WHERE symbol=? ORDER BY date", (symbol.upper(),)).fetchall()
    if not rows:
        return None
    return [row(r) for r in rows]


def _history_store(symbol, hist):
    try:
        db = get_db()
    except RuntimeError:
        return
    sym = symbol.upper()
    today = datetime.now(timezone.utc).date().isoformat()
    db.execute("DELETE FROM history_cache WHERE symbol=?", (sym,))
    for h in hist:
        db.execute(
            "INSERT INTO history_cache (symbol, date, open, high, low, "
            "close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (sym, h["date"], h["open"], h["high"], h["low"], h["close"],
             h["volume"]))
    db.execute(
        "INSERT INTO history_meta (symbol, fetched_date) VALUES (?, ?) "
        "ON CONFLICT(symbol) DO UPDATE SET fetched_date=excluded.fetched_date",
        (sym, today))
    db.commit()


def _fetch_history_live(symbol):
    """Daily OHLCV, Yahoo first, Stooq as fallback. Returns list of dicts."""
    try:
        result = _yahoo_chart(symbol, "1y")["chart"]["result"][0]
        ts, q = result["timestamp"], result["indicators"]["quote"][0]
        from datetime import date
        out = []
        for i, t in enumerate(ts):
            if q["close"][i] is None:
                continue
            out.append({
                "date": date.fromtimestamp(t).isoformat(),
                "open": q["open"][i] or 0, "high": q["high"][i] or 0,
                "low": q["low"][i] or 0, "close": q["close"][i],
                "volume": q["volume"][i] or 0,
            })
        if out:
            return out
    except Exception:
        pass
    try:
        text = _http_text(f"https://stooq.com/q/d/l/?s={symbol.lower()}.us&i=d")
        out = []
        for ln in text.strip().splitlines()[1:]:
            parts = ln.split(",")
            if len(parts) >= 6:
                out.append({
                    "date": parts[0], "open": float(parts[1]),
                    "high": float(parts[2]), "low": float(parts[3]),
                    "close": float(parts[4]),
                    "volume": float(parts[5]) if parts[5] else 0,
                })
        return out
    except Exception:
        return []


# ------------------------------------------------------------------ routes
@app.route("/")
def index():
    return send_from_directory(app.template_folder, "index.html")


@app.route("/api/owners")
def owners():
    db = get_db()
    return jsonify([row(r) for r in db.execute("SELECT * FROM owners ORDER BY id")])


@app.route("/api/owners/<int:owner_id>/rename", methods=["POST"])
def rename_owner(owner_id):
    name = (request.json or {}).get("name", "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400
    db = get_db()
    db.execute("UPDATE owners SET name=? WHERE id=?", (name, owner_id))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/dashboard")
def dashboard():
    """owner=all (household) or an owner id. Totals are computed here,
    never trusted from the client."""
    db = get_db()
    owner = request.args.get("owner", "all")
    owners = [row(r) for r in db.execute("SELECT * FROM owners ORDER BY id")]
    q = """
        SELECT h.*, a.name AS account_name, a.account_type, o.name AS owner_name,
               o.id AS owner_id
        FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        JOIN owners o ON o.id = a.owner_id
    """
    params = []
    if owner != "all":
        q += " WHERE o.id = ?"
        params.append(owner)
    q += " ORDER BY o.id, a.name, h.symbol"
    holdings = [row(r) for r in db.execute(q, params)]
    # Last price must be today's price when the dashboard is opened:
    # refresh any symbol with no quote or a quote from an earlier day.
    # A failed fetch keeps the previous quote / manual price, never blanks it.
    if holdings:
        try:
            stale = _quotes_need_refresh(
                db, sorted({h["symbol"] for h in holdings}))
            if stale:
                _refresh_symbols(db, stale)
        except Exception:
            pass
    quotes = {r["symbol"]: row(r) for r in db.execute("SELECT * FROM quotes")}
    total_value = total_cost = day_move = 0.0
    unpriced = []
    accounts = {}
    for h in holdings:
        quote = quotes.get(h["symbol"])
        price = quote["price"] if quote and quote["price"] else h["manual_price"]
        # 2026-10-26 gain/loss 0.0 bug: the old code fell back to
        # price = cost per share when no quote and no manual price
        # existed, so value always equalled cost and gain was always
        # exactly 0.00 — a fake number, not a real flat holding. A
        # holding with no price now has price/value/gain = None, is
        # excluded from totals, and is listed in unpriced (the UI
        # renders None as "—", never as $0.00). This is the common
        # case: an import that reports no price
        # (and Yahoo has no quote for the symbol), or a holding whose
        # quote fetch failed. Its cost basis is still shown, so the
        # user can see what is known and what is missing.
        h["priced"] = price is not None
        if not h["priced"]:
            unpriced.append(h["symbol"])
        # Fidelity-style fields (see templates/index.html for the column order).
        h["price"] = price
        h["last_change"] = quote["change"] if quote else None
        h["last_change_pct"] = quote["change_pct"] if quote else None
        h["value"] = price * h["shares"] if price is not None else None
        h["current_value"] = h["value"]
        h["gain"] = (h["value"] - h["cost_basis"] * h["shares"]
                     if price is not None else None)
        h["total_gain"] = h["gain"]
        h["gain_pct"] = (h["gain"] / (h["cost_basis"] * h["shares"]) * 100
                         if h["gain"] is not None and h["cost_basis"]
                         and h["shares"] else None)
        h["total_gain_pct"] = h["gain_pct"]
        h["day_move"] = (quote["change"] * h["shares"]
                         if quote and quote["change"] is not None else None)
        h["today_gain"] = h["day_move"]
        h["today_gain_pct"] = quote["change_pct"] if quote else None
        h["quantity"] = h["shares"]
        h["cost_total"] = h["cost_basis"] * h["shares"]
        h["cost_per_share"] = h["cost_basis"]
        h["week_low"] = quote["week_low"] if quote else None
        h["week_high"] = quote["week_high"] if quote else None
        h["week_position"] = (
            (price - h["week_low"]) / (h["week_high"] - h["week_low"])
            if price is not None and h["week_low"] is not None
            and h["week_high"] is not None
            and h["week_high"] > h["week_low"] else None)
        h["day_low"] = quote["day_low"] if quote else None
        h["day_high"] = quote["day_high"] if quote else None
        h["day_position"] = (
            (price - h["day_low"]) / (h["day_high"] - h["day_low"])
            if price is not None and h["day_low"] is not None
            and h["day_high"] is not None
            and h["day_high"] > h["day_low"] else None)
        h["quote_provider"] = quote["provider"] if quote else "manual"
        h["quote_as_of"] = quote["as_of"] if quote else None
        # Totals cover priced holdings only: including an unpriced
        # holding's cost (with no value) would understate gain by
        # exactly that cost. Unpriced holdings are listed separately.
        if h["priced"]:
            total_value += h["value"]
            total_cost += h["cost_basis"] * h["shares"]
            day_move += h["day_move"] if h["day_move"] is not None else 0
            accounts.setdefault(h["account_name"],
                                {"owner": h["owner_name"], "value": 0.0})
            accounts[h["account_name"]]["value"] += h["value"]
    # % of account is per brokerage account (owner + account), matching
    # the hosted dashboard — NOT a share of the household total. The
    # old code divided by total_value, so e.g. AAPL showed 8.59% of the
    # household instead of 61.00% of its E*TRADE account.
    group_totals = {}
    for h in holdings:
        if h["priced"]:
            key = (h["owner_id"], h["account_id"])
            group_totals[key] = group_totals.get(key, 0.0) + h["value"]
    for h in holdings:  # needs the totals above, so a second pass
        group_total = group_totals.get((h["owner_id"], h["account_id"]), 0.0)
        h["pct_of_account"] = (h["value"] / group_total * 100
                               if h["priced"] and group_total else None)
        # Previous close, as shown in the hosted detail panel: the
        # price the day's change is measured from.
        h["prev_close"] = (h["price"] - h["last_change"]
                           if h["price"] is not None
                           and h["last_change"] is not None else None)
    return jsonify({
        "owners": owners,
        "holdings": holdings,
        "watch": _watch_flags(holdings, total_value),
        "accounts": accounts,
        "unpriced": unpriced,
        "totals": {
            "value": total_value, "cost": total_cost,
            "gain": total_value - total_cost,
            "gain_pct": ((total_value - total_cost) / total_cost * 100
                         if total_cost else 0),
            "day_move": day_move,
            "day_move_pct": (day_move / (total_value - day_move) * 100
                             if total_value - day_move else 0),
        },
    })


def _watch_flags(holdings, total_value):
    """Rule-based observations only — never a buy/sell recommendation
    and never a promised return. Every flag is computed from the
    holdings the dashboard already has, so it can be checked."""
    flags = []
    # Unpriced holdings are flagged first, even when totals are 0:
    # they are the holdings whose gain would otherwise read as 0.00.
    for h in holdings:
        if not h.get("priced"):
            flags.append({
                "level": "watch",
                "title": f"No price: {h['symbol']}",
                "detail": "No quote and no imported/institution price, so its "
                          "value and gain/loss are shown as —, not $0.00, "
                          "and it is excluded from totals. Refresh quotes, "
                          "or check the import for a missing price."})
    if not total_value or total_value <= 0:
        return flags
    by_symbol = {}
    for h in holdings:
        by_symbol.setdefault(h["symbol"], []).append(h)
    # Concentration: a single symbol at 25%+ of portfolio value,
    # aggregated across accounts (a symbol held in two accounts is
    # one concentration, not two). Unpriced rows carry value None
    # and are skipped, not treated as 0.
    for sym, rows in by_symbol.items():
        priced_rows = [r for r in rows if r.get("value") is not None]
        if not priced_rows:
            continue
        pct = sum(r["value"] for r in priced_rows) / total_value * 100
        if pct >= 25:
            flags.append({
                "level": "watch",
                "title": f"Concentration: {sym} is {pct:.1f}% of the portfolio",
                "detail": "A single symbol above 25% drives most of the portfolio's movement."})
    # Duplicate: same symbol held in more than one account.
    for sym, rows in by_symbol.items():
        accounts = {r["account_name"] for r in rows}
        if len(accounts) > 1:
            flags.append({
                "level": "info",
                "title": f"Duplicate holding: {sym} in {len(accounts)} accounts",
                "detail": "Totals combine across accounts, so this is not a double-count — "
                          "it is a note that the same symbol appears in several places."})
    # Few distinct holdings.
    if len(by_symbol) < 3:
        flags.append({
            "level": "info",
            "title": f"Few holdings: {len(by_symbol)} distinct symbol(s)",
            "detail": "With fewer than 3 distinct symbols, one holding's move dominates."})
    # Large unrealised loss, and missing cost basis (gains overstated).
    for h in holdings:
        if (h["total_gain_pct"] is not None
                and h["total_gain_pct"] <= -20):
            flags.append({
                "level": "watch",
                "title": f"Large unrealised loss: {h['symbol']} {h['total_gain_pct']:.1f}%",
                "detail": "Total gain/loss is at or below -20% for this holding."})
        if h["cost_total"] == 0 and h["shares"]:
            flags.append({
                "level": "watch",
                "title": f"Missing cost basis: {h['symbol']}",
                "detail": "Cost basis is 0, so its gain/loss is overstated until a cost is imported."})
    # No broad index ETF in a small, well-known set (composition note only).
    _index_etfs = {"VOO", "SPY", "QQQ", "VTI", "SCHD", "IVV", "SPYM", "SCHX"}
    if not (_index_etfs & set(by_symbol)):
        flags.append({
            "level": "info",
            "title": "No broad index ETF holding",
            "detail": "None of the holdings is in a small list of broad index ETFs "
                      "(VOO, SPY, QQQ, VTI, SCHD, IVV). This is a composition "
                      "observation, not a suggestion to buy one."})
    return flags


@app.route("/api/markets")
def markets():
    """US market indices for the Markets panel: DJIA, NASDAQ, S&P 500.
    Same Yahoo quote logic as holdings (previous close from the
    daily bars, not chartPreviousClose), so the day change matches
    the holdings' day-change definition. A failed index fetch
    returns null for that index, never an invented number."""
    out = []
    for name, symbol in (("DJIA", "^DJI"), ("NASDAQ", "^IXIC"), ("S&P 500", "^GSPC")):
        try:
            q = fetch_quote(symbol)
        except Exception:
            q = None
        out.append({
            "name": name, "symbol": symbol,
            "price": q["price"] if q else None,
            "change": q["change"] if q else None,
            "change_pct": q["change_pct"] if q else None,
            "provider": q["provider"] if q else "none",
        })
    return jsonify({"markets": out})


@app.route("/api/growth")
def growth():
    """Growth of the CURRENT holdings vs VOO, indexed to 100.

    Portfolio value on each past date = sum(shares * that day's close),
    forward-filled per symbol. This is what the current holdings would
    have done if held over the whole period — it is not a record of
    actual purchase dates, and a symbol that starts trading mid-period
    joins the series then. VOO is the benchmark, fetched the same way.
    Returns the full 1-year series; the frontend filters by range."""
    db = get_db()
    owner = request.args.get("owner", "all")
    q = """
        SELECT h.symbol, h.shares FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        JOIN owners o ON o.id = a.owner_id
    """
    params = []
    if owner != "all":
        q += " WHERE o.id = ?"
        params.append(owner)
    shares = {}
    for r in db.execute(q, params):
        shares[r["symbol"]] = shares.get(r["symbol"], 0) + r["shares"]
    if not shares:
        return jsonify({"dates": [], "portfolio_index": [], "voo_index": [],
                        "portfolio_growth_pct": 0, "voo_growth_pct": 0,
                        "start_date": None, "end_date": None,
                        "symbols_failed": []})
    histories, failed = {}, []
    for sym in shares:
        hist = fetch_history(sym)
        if hist:
            histories[sym] = {h["date"]: h["close"] for h in hist}
        else:
            failed.append(sym)
    voo_hist = fetch_history("VOO")
    voo_map = {h["date"]: h["close"] for h in voo_hist} if voo_hist else {}
    dates = sorted({d for mp in histories.values() for d in mp} | set(voo_map))
    series_dates, portfolio_vals, voo_vals = [], [], []
    last, voo_last = {}, None
    for d in dates:
        for sym, mp in histories.items():
            if d in mp:
                last[sym] = mp[d]
        if d in voo_map:
            voo_last = voo_map[d]
        if not last or voo_last is None:
            continue
        series_dates.append(d)
        portfolio_vals.append(sum(shares[s] * last[s] for s in last))
        voo_vals.append(voo_last)
    if not series_dates:
        return jsonify({"dates": [], "portfolio_index": [], "voo_index": [],
                        "portfolio_growth_pct": 0, "voo_growth_pct": 0,
                        "start_date": None, "end_date": None,
                        "symbols_failed": failed})
    base_p, base_v = portfolio_vals[0], voo_vals[0]
    return jsonify({
        "dates": series_dates,
        "portfolio_index": [v / base_p * 100 for v in portfolio_vals],
        "voo_index": [v / base_v * 100 for v in voo_vals],
        "portfolio_growth_pct": (portfolio_vals[-1] / base_p - 1) * 100,
        "voo_growth_pct": (voo_vals[-1] / base_v - 1) * 100,
        "start_date": series_dates[0], "end_date": series_dates[-1],
        "symbols_failed": failed,
    })


@app.route("/api/symbol/<symbol>")
def symbol_detail(symbol):
    db = get_db()
    quote = row(db.execute("SELECT * FROM quotes WHERE symbol=?",
                           (symbol.upper(),)).fetchone())
    history = fetch_history(symbol)
    # Fallback 52-week range from the 1-year history when the quote
    # provider did not supply one.
    week_low = week_high = None
    day_low = day_high = None
    if quote:
        week_low, week_high = quote.get("week_low"), quote.get("week_high")
        day_low, day_high = quote.get("day_low"), quote.get("day_high")
    if (week_low is None or week_high is None) and history:
        week_low = min(h["low"] for h in history if h["low"])
        week_high = max(h["high"] for h in history if h["high"])
    if (day_low is None or day_high is None) and history:
        # Last history bar is today's (or the last trading day's) bar.
        day_low = history[-1]["low"]
        day_high = history[-1]["high"]
    # Beta / market cap are best-effort (Nasdaq summary, no key); a
    # symbol Nasdaq does not cover returns None, not an estimate.
    try:
        nasdaq = _nasdaq_summary(symbol.upper())
    except Exception:
        nasdaq = {}
    return jsonify({
        "symbol": symbol.upper(), "quote": quote, "history": history,
        "week_low": week_low, "week_high": week_high,
        "day_low": day_low, "day_high": day_high,
        "beta": nasdaq.get("beta"), "market_cap": nasdaq.get("market_cap"),
        "sector": nasdaq.get("sector"), "industry": nasdaq.get("industry"),
    })


@app.route("/api/accounts", methods=["POST"])
def add_account():
    body = request.json or {}
    owner_id, name = body.get("owner_id"), (body.get("name") or "").strip()
    if not owner_id or not name:
        return jsonify({"error": "owner_id and name are required"}), 400
    db = get_db()
    cur = db.execute(
        "INSERT INTO accounts (owner_id, name, account_type) VALUES (?, ?, ?)",
        (owner_id, name, body.get("account_type") or "Brokerage"))
    db.commit()
    return jsonify({"id": cur.lastrowid}), 201


@app.route("/api/holdings", methods=["POST"])
def add_holding():
    body = request.json or {}
    try:
        account_id = int(body["account_id"])
        shares = float(body.get("shares") or 0)
        cost = float(body.get("cost_basis") or 0)
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "account_id, shares and cost_basis are required"}), 400
    symbol = (body.get("symbol") or "").strip().upper()
    if not symbol or shares <= 0:
        return jsonify({"error": "symbol and positive shares are required"}), 400
    db = get_db()
    db.execute(
        """INSERT INTO holdings (account_id, symbol, name, shares, cost_basis,
                                  manual_price, source)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account_id, symbol) DO UPDATE SET
             name=excluded.name, shares=excluded.shares,
             cost_basis=excluded.cost_basis, manual_price=excluded.manual_price,
             source=excluded.source""",
        (account_id, symbol, body.get("name") or "", shares, cost,
         body.get("manual_price"), body.get("source") or "manual"))
    db.commit()
    return jsonify({"ok": True}), 201


@app.route("/api/holdings/<int:holding_id>", methods=["DELETE"])
def delete_holding(holding_id):
    db = get_db()
    db.execute("DELETE FROM holdings WHERE id=?", (holding_id,))
    db.commit()
    return jsonify({"ok": True})


def _norm_header(h):
    """'Cost Basis Total ($)' -> 'cost_basis_total', so Fidelity headers
    (and other brokerages' variants with units/punctuation) match."""
    h = (h or "").strip().lower().replace(" ", "_").replace("-", "_")
    return re.sub(r"[^a-z0-9_]", "", h)


def _money(v):
    """'$1,234.56' / '($1,234.56)' / 1234.56 -> float, else None."""
    if v is None or v == "":
        return None
    s = str(v).strip().replace("$", "").replace(",", "")
    negative = s.startswith("(") and s.endswith(")")
    s = s.strip("()")
    try:
        val = float(s)
    except ValueError:
        return None
    return -val if negative else val


def _pick(row_dict, *names):
    for n in names:
        if n in row_dict and row_dict[n] not in (None, ""):
            return row_dict[n]
    return None


_NON_POSITION_SYMBOLS = {"CASH", "TOTAL", "CASH_INVESTMENTS"}


def _is_position_row(r, symbol):
    """Drop cash/total/footer rows from brokerage exports."""
    s = (symbol or "").strip().upper()
    if s in _NON_POSITION_SYMBOLS:
        return False
    low = (symbol or "").strip().lower()
    if "cash" in low and "invest" in low or low == "positions total":
        return False
    return True


def _normalize_broker_rows(rows):
    """Persistent brokerage conversion: any recognised export is
    rewritten to Fidelity-shaped rows BEFORE import, so the user never
    has to convert a file by hand again.

    Detected formats (by normalised header set):
      fidelity: cost_basis_total + average_cost_basis (already Fidelity)
      schwab:   qty_quantity + mkt_val_market_value. Its 'Cost Basis'
                is a TOTAL, not per-share — the old generic mapping
                treated a bare cost_basis as per-share, which is why a
                direct Schwab import would misstate cost. It is
                rewritten to cost_basis_total here.
      etrade:   price_paid_ + total_cost. Total Cost -> cost_basis_total,
                Price Paid -> average_cost_basis. Description/Type are
                absent from E*TRADE exports and stay blank.
      generic:  anything else — import_rows' alias picks handle it.
    Returns (format, rows). Schwab/E*TRADE title lines and cash/total
    rows are dropped here; the header-row search in _csv_rows_from_text
    / _xlsx_rows_from_sheet drops Schwab's title line."""
    if not rows:
        return "generic", rows
    # Drop blank / footer / disclaimer lines (Fidelity exports end with
    # them) so they do not inflate the import's skipped count.
    rows = [r for r in rows if _pick(r, "symbol", "ticker")]
    keys = set()
    for r in rows:
        keys.update(r.keys())
    if "qty_quantity" in keys or "mkt_val_market_value" in keys:
        fmt = "schwab"
    elif "price_paid_" in keys and "total_cost" in keys:
        fmt = "etrade"
    elif "cost_basis_total" in keys:
        fmt = "fidelity"
    else:
        return "generic", rows
    out = []
    for r in rows:
        symbol = _pick(r, "symbol", "ticker")
        if symbol and not _is_position_row(r, symbol):
            continue
        if fmt == "schwab":
            out.append({
                "symbol": symbol,
                "description": _pick(r, "description") or "",
                "quantity": _pick(r, "qty_quantity", "quantity", "qty"),
                "last_price": _pick(r, "price", "last_price"),
                "current_value": _pick(r, "mkt_val_market_value"),
                "cost_basis_total": _pick(r, "cost_basis"),
                "percent_of_account": _pick(r, "_of_acct__of_account"),
                "type": _pick(r, "asset_type") or "",
            })
        elif fmt == "etrade":
            out.append({
                "symbol": symbol,
                "description": _pick(r, "description") or "",
                "quantity": _pick(r, "qty_", "quantity", "qty"),
                "last_price": _pick(r, "last_price_", "last_price"),
                "current_value": _pick(r, "value_"),
                "cost_basis_total": _pick(r, "total_cost"),
                "average_cost_basis": _pick(r, "price_paid_", "price_paid"),
            })
        else:
            out.append(r)
    return fmt, out


def _csv_rows_from_text(text):
    """Find the real header row (Schwab exports start with a title line
    and a blank line) and return dict rows with normalised headers."""
    parsed = list(csv.reader(io.StringIO(text)))
    for i, row in enumerate(parsed):
        normed = [_norm_header(c) for c in row]
        if "symbol" in normed or "ticker" in normed:
            headers = normed
            return [{headers[j]: (r[j] if j < len(r) else "")
                     for j in range(len(headers))}
                    for r in parsed[i + 1:]]
    # No symbol header found: fall back to DictReader (first row as header).
    reader = csv.DictReader(io.StringIO(text))
    return [{_norm_header(k): v for k, v in (r or {}).items()} for r in reader]


def _xlsx_rows_from_sheet(ws):
    """Same header-row search as CSV, for XLSX exports."""
    rows = list(ws.iter_rows(values_only=True))
    for i, row in enumerate(rows):
        normed = [_norm_header(c) for c in row]
        if "symbol" in normed or "ticker" in normed:
            headers = normed
            return [dict(zip(headers, r)) for r in rows[i + 1:]]
    headers = [_norm_header(c) for c in rows[0]] if rows else []
    return [dict(zip(headers, r)) for r in rows[1:]]


def import_rows(rows, owner_id, account_name):
    """rows: list of dicts with normalised headers. Returns counts."""
    db = get_db()
    acct = db.execute(
        "SELECT id FROM accounts WHERE owner_id=? AND name=?",
        (owner_id, account_name)).fetchone()
    if acct is None:
        acct_id = db.execute(
            "INSERT INTO accounts (owner_id, name) VALUES (?, ?)",
            (owner_id, account_name)).lastrowid
    else:
        acct_id = acct["id"]
    created = updated = skipped = 0
    for r in rows:
        symbol = _pick(r, "symbol", "ticker")
        shares = _pick(r, "shares", "quantity", "qty", "qty_quantity", "qty_")
        if not symbol or shares is None:
            skipped += 1
            continue
        # Fidelity CSV mapping — this was the 0.0 bug: the old code looked
        # for a bare 'cost_basis' header, which Fidelity does not use, so
        # every imported row fell back to 0.
        #   'Cost Basis Total'   -> TOTAL cost (cost_basis_total)
        #   'Average Cost Basis' -> PER-SHARE cost (average_cost_basis)
        # The holdings table stores cost_basis PER SHARE, and computes
        # Cost basis (total) = cost_basis * quantity, so a total must be
        # divided by quantity here, never stored as-is.
        try:
            shares = _money(shares)
            if shares is None:
                skipped += 1
                continue
            cost_total_raw = _pick(r, "cost_basis_total", "total_cost_basis",
                                   "total_cost")
            avg_raw = _pick(r, "average_cost_basis", "avg_cost_basis",
                            "average_cost", "avg_cost",
                            "cost_basis_per_share", "price_paid", "price_paid_")
            legacy_raw = _pick(r, "cost_basis", "cost")
            if cost_total_raw is not None:
                total = _money(cost_total_raw)
                cost = (total / shares) if total is not None else 0
            elif avg_raw is not None:
                cost = _money(avg_raw) or 0
            elif legacy_raw is not None:
                # Legacy sample_holdings.csv: 'Cost Basis' is per-share.
                # (Schwab's 'Cost Basis' is a TOTAL, but Schwab rows are
                # rewritten to cost_basis_total by _normalize_broker_rows
                # before they reach here, so this branch never sees them.)
                cost = _money(legacy_raw) or 0
            else:
                cost = 0
            price = _money(_pick(r, "last_price", "last_price_", "price",
                                 "current_price"))
        except (ValueError, TypeError):
            skipped += 1
            continue
        if shares <= 0:
            skipped += 1
            continue
        existed = db.execute(
            "SELECT id FROM holdings WHERE account_id=? AND symbol=?",
            (acct_id, str(symbol).strip().upper())).fetchone()
        db.execute(
            """INSERT INTO holdings (account_id, symbol, name, shares, cost_basis,
                                      manual_price, source)
               VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(account_id, symbol) DO UPDATE SET
                 name=excluded.name, shares=excluded.shares,
                 cost_basis=excluded.cost_basis,
                 manual_price=excluded.manual_price, source=excluded.source""",
            (acct_id, str(symbol).strip().upper(),
             _pick(r, "name", "description", "security_name",
                   "company_name") or "", shares, cost, price,
             "csv" if price is None else "csv"))
        created, updated = (created, updated + 1) if existed else (created + 1, updated)
    db.commit()
    return {"account_id": acct_id, "created": created,
            "updated": updated, "skipped": skipped}


@app.route("/api/import", methods=["POST"])
def import_file():
    """Multipart upload: CSV (stdlib) or XLSX (openpyxl, optional).
    A preview is returned when ?preview=1, nothing is written then."""
    f = request.files.get("file")
    owner_id = request.form.get("owner_id")
    account_name = (request.form.get("account_name") or "Imported").strip()
    if not f or not owner_id:
        return jsonify({"error": "file and owner_id are required"}), 400
    name = f.filename.lower()
    try:
        if name.endswith(".csv"):
            text = f.read().decode("utf-8-sig")
            rows = _csv_rows_from_text(text)
        elif name.endswith((".xlsx", ".xls")):
            try:
                import openpyxl
            except ImportError:
                return jsonify({"error": "XLSX needs openpyxl: pip install openpyxl"}), 400
            wb = openpyxl.load_workbook(io.BytesIO(f.read()), read_only=True, data_only=True)
            rows = _xlsx_rows_from_sheet(wb.active)
        else:
            return jsonify({"error": "only .csv and .xlsx are accepted"}), 400
    except Exception as e:
        return jsonify({"error": f"could not parse file: {e}"}), 400
    # Persistent conversion: normalise to Fidelity shape before preview
    # or import, whatever brokerage the file came from.
    detected, rows = _normalize_broker_rows(rows)
    if request.args.get("preview") == "1":
        return jsonify({"rows": rows[:20], "total_rows": len(rows),
                        "detected_format": detected})
    result = import_rows(rows, int(owner_id), account_name)
    result["detected_format"] = detected
    return jsonify(result)


@app.route("/api/refresh", methods=["POST"])
def refresh_quotes():
    db = get_db()
    symbols = [r["symbol"] for r in db.execute("SELECT DISTINCT symbol FROM holdings")]
    try:
        refreshed, failed = _refresh_symbols(db, symbols)
    except sqlite3.OperationalError:
        # Still locked after the 30s busy timeout: do not leave a half
        # transaction open, and do not surface a 500 traceback for a
        # transient lock. The next refresh retries cleanly.
        db.rollback()
        return jsonify({"error": "database busy, please try Refresh again"}), 503
    return jsonify({"refreshed": refreshed, "failed": failed,
                    "provider": "yahoo-delayed"})


# ------------------------------------------------------- export / backup
@app.route("/api/export")
def export_holdings():
    """CSV download of the current holdings (computed like the
    dashboard: last price from the quote cache, else the manual /
    imported price). This is an export of what the dashboard shows,
    not a brokerage file — re-importing it uses the generic path."""
    db = get_db()
    owner = request.args.get("owner", "all")
    q = """
        SELECT h.*, a.name AS account_name, o.name AS owner_name
        FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        JOIN owners o ON o.id = a.owner_id
    """
    params = []
    if owner != "all":
        q += " WHERE o.id = ?"
        params.append(owner)
    q += " ORDER BY o.id, a.name, h.symbol"
    quotes = {r["symbol"]: row(r) for r in db.execute("SELECT * FROM quotes")}
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["Owner", "Account", "Symbol", "Name", "Quantity",
                "Cost basis per share", "Cost basis total", "Last price",
                "Current value", "Total gain/loss", "Today's gain/loss"])
    for h in db.execute(q, params):
        quote = quotes.get(h["symbol"])
        price = quote["price"] if quote and quote["price"] else h["manual_price"]
        # No fake price fallback here either (see dashboard): an
        # unpriced holding exports blank price/value/gain, not a
        # value equal to its cost with a 0 gain.
        value = price * h["shares"] if price is not None else ""
        w.writerow([h["owner_name"], h["account_name"], h["symbol"], h["name"],
                    h["shares"], h["cost_basis"], h["cost_basis"] * h["shares"],
                    price if price is not None else "",
                    value,
                    (value - h["cost_basis"] * h["shares"]
                     if price is not None else ""),
                    (quote["change"] * h["shares"]
                     if quote and quote["change"] is not None else "")])
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition":
                             "attachment; filename=fin_dash_holdings.csv"})


@app.route("/api/backup")
def backup_db():
    """One-click SQLite backup download (online backup API, so it is
    consistent even while the server is running). The download is the
    fin_dash database ONLY."""
    import sqlite3 as _sqlite3
    import tempfile
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp_path = tmp.name
    tmp.close()
    try:
        src = _sqlite3.connect(DB_PATH, timeout=30)
        dst = _sqlite3.connect(tmp_path)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        # The database is small (personal holdings), so read it into
        # memory and delete the temp file immediately — no temp files
        # accumulate, and the download still contains only holdings
        with open(tmp_path, "rb") as f:
            data = f.read()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
    return Response(data, mimetype="application/x-sqlite3",
                    headers={"Content-Disposition":
                             "attachment; filename=fin_dash_backup.db"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
