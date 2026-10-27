# fin_dash

View-only household portfolio dashboard. It shows your finances — it does
not buy or sell anything. There are no trading endpoints in this codebase.

## Views

- **Household** — all owners combined
- **Bruce** / **Spouse** — per-owner views (names are editable in the app;
  more owners can be added in code via the `owners` table)

## Positions table (Fidelity-style)

Columns, in order: Symbol | Last price | Today's gain/loss | Total
gain/loss | Current value | % of account | Quantity | Cost basis |
52-week range. Click a column header to sort. Holdings are grouped by
account, each group has its own Account total row, and the table footer
is the overall total.

**52-week range: yes, via API.** Yahoo's chart meta returns
`fiftyTwoWeekLow` / `fiftyTwoWeekHigh` directly, and fin_dash stores them
on refresh, rendering the range bar with the current price as a diamond
marker. With a Finnhub key (whose quote endpoint has no 52-week field),
the detail view falls back to the min/max of the 1-year history. Without
any quote, the cell shows a dash — never an invented range.

## Brokerage CSV import — automatic conversion to Fidelity format

Upload a Fidelity, Schwab, E*TRADE, or generic export and the
dashboard converts it on import — no separate conversion step:

- **Fidelity:** Cost Basis Total (total) + Average Cost Basis (per-share).
- **Schwab:** the file's title line is skipped, its Cost Basis is
  treated as a **total** (not per-share), and cash/total rows are dropped.
- **E*TRADE:** Total Cost -> cost basis total, Price Paid ->
  average cost basis; Description/Type are absent from its export.
- **Generic:** flexible header aliases (Symbol/Ticker, Quantity/Shares,
  Last Price/Price, Cost Basis Total / Average Cost Basis / Avg Cost).

The import API returns `detected_format` (`fidelity`, `schwab`,
`etrade`, or `generic`), and the preview endpoint returns the
converted rows, so the mapping can be checked before importing.

## Holdings table layout

Every holdings column is capped at 16 characters wide and soft-wraps
on words (long dollar figures break only if they would otherwise
overflow). No column truncates with an ellipsis and no cell forces a
single line — headers like "Today's gain/loss" wrap onto two lines
rather than stretching the table. The symbol column stays narrower
(72px), and merged group/total rows are exempt from the cap.

## Masking monetary values (eye toggle)

The eye button at the top (🙈 Mask values / 👁️ Show values)
replaces every dollar amount on the page with a fixed `****` —
KPI cards, holdings table (last price, gains, current value, cost
basis, day/52-week ranges), allocation legend, and detail view —
so the number of digits cannot leak the magnitude. Percentages,
quantities, symbols, and the 100-indexed growth chart stay visible.
The choice persists in the browser (`localStorage`) across visits.
This is a display mask only: the server still returns real values
to the browser, so it is for shoulder-surfing privacy, not a
security boundary for someone with browser / network access.

## Growth vs VOO, allocation, and What to watch

- **Growth vs VOO** (`GET /api/growth?owner=all|<id>`): the current
  holdings' daily value (shares × that day's close, forward-filled)
  indexed to 100, plotted against VOO over the same dates, with
  1M / 3M / 6M / 1Y / ALL ranges (re-indexed to 100 at the range
  start). This is what the current holdings would have done if held
  over the whole period — not a record of actual purchase dates.
- **Allocation:** a donut of current value by symbol, across accounts,
  with a legend showing each symbol's share and value.
- **What to watch:** rule-based observations computed from the
  dashboard's own holdings and returned as `watch` on
  `/api/dashboard` — concentration (a holding at 25%+ of value),
  the same symbol in multiple accounts, fewer than 3 distinct
  symbols, a holding down 20%+ in total, a missing (0) cost basis,
  and no broad index ETF in a small well-known list. These are
  observations only, never a buy/sell recommendation and never a
  promised return.

## Database locking (fixed 2026-10-26)

`/api/refresh` used to upsert each quote as it fetched it, holding a
SQLite write transaction open through the whole slow network loop —
a second Refresh click (or the dashboard's first-load auto-refresh)
then failed with `sqlite3.OperationalError: database is locked`.
Now all quotes are fetched first with no writes open, then upserted
in one short transaction; connections use WAL mode with a 30s busy
timeout, and a still-locked refresh returns a clean 503 "database
busy, please try Refresh again" instead of a 500 traceback. The
`-wal` / `-shm` sidecar files are covered by `fin_dash.db*` in
`.gitignore`.

## Last price and Day range (API)

Last price is **not** the price frozen in the import file. On the
first dashboard load of a day, any symbol with no quote or a quote
from an earlier day is refreshed from the market-data API: the
intraday price while the market is open, the close once it has
closed (free tiers are delayed, not real-time). A failed fetch keeps
the previous quote / manual price, never blanks it. The same API
pull supplies the **Day range** column (today's low–high, Yahoo
`regularMarketDayLow`/`regularMarketDayHigh`, with a fallback to
the last daily bar) next to the 52-week range column.

## Fidelity CSV import (cost basis mapping)

Fidelity's export uses two different cost columns — mixing them up is
what produced 0.00 cost bases:

- **Cost Basis Total** = the *total* cost for the position
- **Average Cost Basis** = the *per-share* cost

fin_dash stores cost basis per share internally, so on import it
divides Cost Basis Total by Quantity, or uses Average Cost Basis
directly if no total is present. Re-importing the same Fidelity file
after this fix updates the existing holdings (same account + symbol)
instead of duplicating them, so a bad 0.00 import is corrected by
re-importing. See `sample_fidelity.csv` for the exact header format.
Headers with units/punctuation (e.g. `Cost Basis Total ($)`) are
normalised before matching.

## Data in (hybrid)

1. **CSV / XLSX import** — upload a brokerage export. Flexible headers:
   Symbol/Ticker, Shares/Quantity, Cost Basis/Avg Cost, Last Price/Price,
   Name. Re-importing the same account + symbol updates it, it does not
   duplicate it. Try `sample_holdings.csv` first.
2. **Manual entry** — add an account and holding from the dashboard.
3. **Market-data pull** — quotes and price + volume history:
   - With `FINNHUB_API_KEY` set: Finnhub quotes (free plan may be delayed).
   - Without it: Yahoo Finance chart data, free, no key, but unofficial and
     personal-use only — it can change or rate-limit without notice, so it
     is a fallback for a personal dashboard, not a production data contract.
     Stooq is a further fallback, but it currently bot-blocks server requests.
     The UI labels the provider and as-of time so a delayed price is never
     shown as live.
   - If no provider is reachable, the imported/manual price is used.

Plaid brokerage sync is **not** in this self-hosted version yet — that was
the hosted app's next step and needs a Plaid Link connection, not a key in
this repo. Do not put brokerage credentials, API keys, or real exports in
this repo.

## Run it

```bash
pip install -r requirements.txt
python3 app.py        # http://127.0.0.1:5000
# PORT=5001 python3 app.py
```

Data is stored in `fin_dash.db` (SQLite, gitignored, created on first run).

## API (view + data entry only)

- `GET /api/dashboard?owner=all|<owner_id>` — totals + holdings
- `GET /api/symbol/<SYMBOL>` — cached quote + daily price/volume history
- `POST /api/accounts`, `POST /api/holdings`, `DELETE /api/holdings/<id>`
- `POST /api/import` (multipart `file`, `owner_id`, `account_name`;
  `?preview=1` returns the first 20 parsed rows without writing)
- `POST /api/refresh` — refresh all cached quotes
- `POST /api/owners/<id>/rename`

## What is not here

No buy, sell, order, or brokerage-login code. Recommendations in the
hosted dashboard are rule-based observations (concentration, allocation),
not personalised investment advice, and no returns are promised.
