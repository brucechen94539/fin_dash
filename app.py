"""
fin_dash: view-only household portfolio dashboard.

Self-hostable equivalent of the Muse-hosted Household Portfolio Dashboard.
It shows, it does not trade: there are no buy/sell endpoints, no order
routes, and no brokerage credentials stored in this repo.

Data sources (hybrid, by design):
  1. CSV / XLSX import (brokerage exports) -- see /api/import
  2. Manual entry
  3. Market-data pull for quotes and price/volume history:
     - FINNHUB_API_KEY set  -> Finnhub quote endpoint (fast, may be delayed
       on a free plan; the UI shows the provider and as-of time)
     - otherwise             -> Yahoo Finance chart endpoint (free, no key,
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
Never commit fin_dash.db, a .env file, an API key, or a real brokerage
export. Use sample_holdings.csv as the import template format.
"""

import csv
import io
import json
import os
import sqlite3
import urllib.request
import urllib.error
from datetime import datetime, timezone

from flask import Flask, g, jsonify, request, send_from_directory

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("FIN_DASH_DB", os.path.join(APP_DIR, "fin_dash.db"))
FINNHUB_KEY = os.environ.get("FINNHUB_API_KEY", "").strip()

app = Flask(__name__, static_folder="static", template_folder="templates")


# ---------------------------------------------------------------- database
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
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
            provider TEXT, as_of TEXT, week_low REAL, week_high REAL
        );
        """
    )
    # Migration for databases created before the 52-week columns existed.
    for _col in ("week_low REAL", "week_high REAL"):
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
    """Yahoo chart JSON. Unofficial endpoint, personal-use only."""
    req = urllib.request.Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
        f"?range={range_}&interval=1d",
        headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_quote(symbol):
    """Return a dict, or None.

    52-week range: YES, there is a public-API way. Yahoo's chart meta
    carries fiftyTwoWeekLow / fiftyTwoWeekHigh directly, so no separate
    endpoint is needed. Finnhub's quote endpoint does not include it, so
    with a Finnhub key the range is left null here and the detail view
    falls back to the min/max of the 1-year history (see symbol_detail).
    """
    symbol = symbol.upper()
    if FINNHUB_KEY:
        try:
            q = _http_json(
                f"https://finnhub.io/api/v1/quote?symbol={symbol}&token={FINNHUB_KEY}"
            )
            if q.get("c"):
                return {"price": q["c"], "change": q.get("d"),
                        "change_pct": q.get("dp"), "volume": None,
                        "provider": "finnhub", "week_low": None, "week_high": None}
        except Exception:
            pass  # fall through to Yahoo
    try:
        meta = _yahoo_chart(symbol, "5d")["chart"]["result"][0]["meta"]
        price = meta.get("regularMarketPrice")
        prev = meta.get("chartPreviousClose")
        if price and prev:
            return {"price": price, "change": price - prev,
                    "change_pct": (price - prev) / prev * 100,
                    "volume": meta.get("regularMarketVolume"),
                    "provider": "yahoo-delayed",
                    "week_low": meta.get("fiftyTwoWeekLow"),
                    "week_high": meta.get("fiftyTwoWeekHigh")}
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
                    "provider": "stooq-eod", "week_low": None, "week_high": None}
    except Exception:
        pass
    return None


def fetch_history(symbol):
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
    quotes = {r["symbol"]: row(r) for r in db.execute("SELECT * FROM quotes")}
    total_value = total_cost = day_move = 0.0
    accounts = {}
    for h in holdings:
        quote = quotes.get(h["symbol"])
        price = quote["price"] if quote and quote["price"] else h["manual_price"]
        if price is None:
            price = h["cost_basis"] / h["shares"] if h["shares"] else 0
        # Fidelity-style fields (see templates/index.html for the column order).
        h["price"] = price
        h["last_change"] = quote["change"] if quote else None
        h["last_change_pct"] = quote["change_pct"] if quote else None
        h["value"] = price * h["shares"]
        h["current_value"] = h["value"]
        h["gain"] = h["value"] - h["cost_basis"] * h["shares"]
        h["total_gain"] = h["gain"]
        h["gain_pct"] = (h["gain"] / (h["cost_basis"] * h["shares"]) * 100
                         if h["cost_basis"] and h["shares"] else 0)
        h["total_gain_pct"] = h["gain_pct"]
        h["day_move"] = (quote["change"] * h["shares"]
                         if quote and quote["change"] is not None else 0)
        h["today_gain"] = h["day_move"]
        h["today_gain_pct"] = quote["change_pct"] if quote else 0
        h["quantity"] = h["shares"]
        h["cost_total"] = h["cost_basis"] * h["shares"]
        h["cost_per_share"] = h["cost_basis"]
        h["week_low"] = quote["week_low"] if quote else None
        h["week_high"] = quote["week_high"] if quote else None
        h["week_position"] = (
            (price - h["week_low"]) / (h["week_high"] - h["week_low"])
            if h["week_low"] is not None and h["week_high"] is not None
            and h["week_high"] > h["week_low"] else None)
        h["quote_provider"] = quote["provider"] if quote else "manual"
        h["quote_as_of"] = quote["as_of"] if quote else None
        total_value += h["value"]
        total_cost += h["cost_basis"] * h["shares"]
        day_move += h["day_move"]
        accounts.setdefault(h["account_name"], {"owner": h["owner_name"], "value": 0.0})
        accounts[h["account_name"]]["value"] += h["value"]
    for h in holdings:  # needs the total above, so a second pass
        h["pct_of_account"] = (h["value"] / total_value * 100 if total_value else 0)
    return jsonify({
        "owners": owners,
        "holdings": holdings,
        "accounts": accounts,
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


@app.route("/api/symbol/<symbol>")
def symbol_detail(symbol):
    db = get_db()
    quote = row(db.execute("SELECT * FROM quotes WHERE symbol=?",
                           (symbol.upper(),)).fetchone())
    history = fetch_history(symbol)
    # Fallback 52-week range from the 1-year history when the quote
    # provider did not supply one (e.g. Finnhub).
    week_low = week_high = None
    if quote:
        week_low, week_high = quote.get("week_low"), quote.get("week_high")
    if (week_low is None or week_high is None) and history:
        week_low = min(h["low"] for h in history if h["low"])
        week_high = max(h["high"] for h in history if h["high"])
    return jsonify({
        "symbol": symbol.upper(), "quote": quote, "history": history,
        "week_low": week_low, "week_high": week_high,
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
    return (h or "").strip().lower().replace(" ", "_").replace("-", "_")


def _pick(row_dict, *names):
    for n in names:
        if n in row_dict and row_dict[n] not in (None, ""):
            return row_dict[n]
    return None


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
        shares = _pick(r, "shares", "quantity", "qty")
        if not symbol or shares is None:
            skipped += 1
            continue
        try:
            shares = float(str(shares).replace(",", "").replace("$", ""))
            cost = float(str(_pick(r, "cost_basis", "avg_cost", "average_cost",
                                   "cost") or 0).replace(",", "").replace("$", ""))
            price = _pick(r, "last_price", "price", "current_price")
            price = float(str(price).replace(",", "").replace("$", "")) if price else None
        except ValueError:
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
             _pick(r, "name", "description") or "", shares, cost, price,
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
            reader = csv.DictReader(io.StringIO(text))
            rows = [{_norm_header(k): v for k, v in (r or {}).items()} for r in reader]
        elif name.endswith((".xlsx", ".xls")):
            try:
                import openpyxl
            except ImportError:
                return jsonify({"error": "XLSX needs openpyxl: pip install openpyxl"}), 400
            wb = openpyxl.load_workbook(io.BytesIO(f.read()), read_only=True, data_only=True)
            ws = wb.active
            it = ws.iter_rows(values_only=True)
            headers = [_norm_header(c) for c in next(it)]
            rows = [dict(zip(headers, r)) for r in it]
        else:
            return jsonify({"error": "only .csv and .xlsx are accepted"}), 400
    except Exception as e:
        return jsonify({"error": f"could not parse file: {e}"}), 400
    if request.args.get("preview") == "1":
        return jsonify({"rows": rows[:20], "total_rows": len(rows)})
    return jsonify(import_rows(rows, int(owner_id), account_name))


@app.route("/api/refresh", methods=["POST"])
def refresh_quotes():
    db = get_db()
    symbols = [r["symbol"] for r in db.execute("SELECT DISTINCT symbol FROM holdings")]
    refreshed = failed = 0
    now = datetime.now(timezone.utc).isoformat()
    for sym in symbols:
        q = fetch_quote(sym)
        if q:
            db.execute(
                """INSERT INTO quotes (symbol, price, change, change_pct, volume,
                                        provider, as_of, week_low, week_high)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(symbol) DO UPDATE SET price=excluded.price,
                     change=excluded.change, change_pct=excluded.change_pct,
                     volume=excluded.volume, provider=excluded.provider,
                     as_of=excluded.as_of, week_low=excluded.week_low,
                     week_high=excluded.week_high""",
                (sym, q["price"], q["change"], q["change_pct"], q["volume"],
                 q["provider"], now, q["week_low"], q["week_high"]))
            refreshed += 1
        else:
            failed += 1
    db.commit()
    return jsonify({"refreshed": refreshed, "failed": failed,
                    "provider": "finnhub" if FINNHUB_KEY else "yahoo-delayed"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "5000")), debug=False)
