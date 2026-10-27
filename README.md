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
Day range | 52-week range. Click a column header to sort. Holdings are grouped by
account, each group has its own Account total row, and the table footer
is the overall total. On a phone-width screen (≤640px) the table stops
scrolling sideways: each holding row becomes a card with the column
name shown before its value, and group/total rows stay as full-width
banners.

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

## Plaid sync (self-hosted, no dashboard login)

Plaid sync is now in this self-hosted version, with its own Plaid
developer account — Muse's Plaid connection does **not** transfer to
your Mac, and no dashboard login is added (Plaid Link itself is the
brokerage authentication step):

1. Create a Plaid developer account at dashboard.plaid.com and create
   an app. Start in **sandbox** — free test institutions, no real money.
2. Copy `.env.example` to `.env` in the same folder as `app.py`
   (gitignored) and set `PLAID_CLIENT_ID`, `PLAID_SECRET`, and
   `PLAID_ENV=sandbox`, then run `chmod 600 .env` and restart the
   server. **app.py loads `.env` itself on startup** (a small stdlib
   parser, no new dependency, no pip install needed) — no `export`
   is needed, and a variable already exported in your shell always
   wins over `.env`. A `.env` in your home folder (`~`) is NOT read;
   it must sit next to `app.py`.
3. In the dashboard's Plaid panel, pick an owner, click **Connect
   brokerage via Plaid**, complete Link (in sandbox, use Plaid's test
   credentials), then click **Sync Plaid holdings**.
4. Sync creates accounts named “Institution — Account (Plaid)” and
   merges on account + symbol, so re-syncing updates instead of
   duplicating. Do **not** also CSV-import the same brokerage under a
   different account name, or the holding will appear twice.
5. Only move to `PLAID_ENV=development` (up to 100 real items, free)
   or `production` (paid, requires Plaid approval) after sandbox works.

Plaid cost basis is treated as a **total** cost (divided by quantity
for storage, like Fidelity's Cost Basis Total — confirmed against
Plaid's Holding docs, where cost_basis is 'the total amount spent to
acquire all assets currently in the holding'). Plaid's cost_basis is
nullable, so an institution that does not report it imports as 0 cost
and is listed in the sync result as 'Missing cost basis' (and flagged
by What to watch), not silently treated as a real 0. Likewise,
institution_price is per share; when it is null but institution_value
is present, the import derives price as institution_value / quantity.
Holdings with no ticker are skipped and listed in the sync result
('Skipped: …'), and two Plaid holdings with the same ticker in the
same account are aggregated (quantity and cost summed) instead of the
second overwriting the first. Access tokens are
stored in the local `plaid_tokens.json` file (gitignored, mode 0600),
**not** in the database and **not** in the repo — so a database
backup does not back them up; copy that file separately if you need
it. Do not put brokerage credentials, API keys, or real exports in
this repo.

## Holdings grouping, expand/collapse, and unpriced holdings

Holdings stay grouped by account (brokerage account), with a per-account
total row — grouping is not flattened by sorting: column sorting applies
within each group, and groups stay ordered by owner then account name.
Each group header is a toggle (▾/▸) that expands or collapses that
account; collapsed groups still show their account total in the header.
Collapsed state is remembered in the browser (`localStorage`, key
`fin_dash_collapsed`), so it survives reloads and owner-tab switches.
**Expand all** / **Collapse all** sit next to Refresh quotes.

A holding with no price — no quote, no imported price, and (for Plaid)
no institution price or value to derive one from — is **not** shown as
$0.00 gain. Its Last price, Current value, Today's gain, and Total
gain show as —, it is excluded from portfolio and account totals, and
it is listed under the holdings table ('X holdings have no price yet')
and in What to watch ('No price: SYM'). The old behaviour fell back to
price = cost per share, which made value always equal cost and gain
always exactly 0.00 — a fake flat holding. Money values that are
missing (null) now render as — everywhere, not $0.00.

## PWA / Add to Home Screen (iPhone, no login)

The page links a `static/manifest.json` and an SVG icon, with
`apple-mobile-web-app-capable` set, so Safari's Share → Add to Home
Screen opens fin_dash full-screen, without Safari chrome. No service
worker is registered on purpose — a cached shell could serve stale
prices. The icon is SVG (the GitHub snapshot push accepts UTF-8
files only, so no PNG icon is in the repo); iOS may fall back to a
page screenshot for the Home Screen icon in some versions, while the
full-screen behaviour still works.

## Export and backup

- **Export CSV** (`GET /api/export?owner=all|<id>`) downloads the
  holdings the dashboard currently shows, with computed last price,
  current value, total gain/loss, and today's gain/loss.
- **Download backup** (`GET /api/backup`) downloads the whole SQLite
  database via the online backup API, so it is consistent while the
  server is running. It contains holdings, accounts, quotes, and the
  history cache — but **not** Plaid tokens (see above).

## History cache (faster loads)

Daily OHLCV history is cached in `history_cache` for one UTC day,
with `history_meta` recording the fetch date. The growth chart and
the detail view used to fetch the same 1-year history twice per
load; a second load on the same day now reads the cache, and the
growth chart no longer re-fetches on every owner-tab switch. The
first load of a day still fetches fresh history, like quotes.

## Symbol detail: beta and market cap

Clicking a holding shows its price + volume chart, day/52-week
ranges, and — best-effort, from Nasdaq's public quote summary
(no key) — **beta and market cap**, plus sector/industry when
Nasdaq publishes them. Yahoo's quote endpoints now return 401
without a crumb, so they are not used for this. When Nasdaq does
not publish beta or market cap for a symbol, the detail view omits
them instead of estimating them. Market cap goes through the same
money formatter as every other dollar amount, so the eye mask hides
it too.

## Run it

```bash
pip install -r requirements.txt
python3 app.py        # http://127.0.0.1:5000
# PORT=5001 python3 app.py
```

Data is stored in `fin_dash.db` (SQLite, gitignored, created on first run).

## API (view + data entry only)

- `GET /api/dashboard?owner=all|<owner_id>` — totals + holdings
- `GET /api/symbol/<SYMBOL>` — cached quote + daily price/volume history + beta / market cap / sector (best-effort, Nasdaq)
- `POST /api/accounts`, `POST /api/holdings`, `DELETE /api/holdings/<id>`
- `POST /api/import` (multipart `file`, `owner_id`, `account_name`;
  `?preview=1` returns the first 20 parsed rows without writing)
- `POST /api/refresh` — refresh all cached quotes
- `POST /api/owners/<id>/rename`
- `GET /api/export?owner=all|<id>` — holdings CSV download
- `GET /api/backup` — SQLite database download (no Plaid tokens)
- `GET /api/plaid/status`, `POST /api/plaid/link-token`, `POST /api/plaid/exchange`, `POST /api/plaid/sync` — Plaid Link + Investments holdings sync (needs `PLAID_CLIENT_ID` / `PLAID_SECRET` in a local `.env`)

## What is not here

No buy, sell, or order code, and no dashboard login. The only
brokerage-authentication code is Plaid Link, which is read-only
(holdings only) and is the brokerages' own login flow. Rule-based
observations (concentration, allocation) are not personalised
investment advice, and no returns are promised.
