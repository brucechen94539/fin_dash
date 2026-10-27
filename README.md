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
