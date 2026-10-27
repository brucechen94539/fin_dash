let growthRange = "1Y";
let lastGrowth = null;

// fin_dash frontend: view-only, Fidelity-style portfolio table.
// No trading calls exist on the server. Column order matches the
// Fidelity positions table: Symbol | Last price | Today's gain/loss |
// Total gain/loss | Current value | % of account | Quantity |
// Cost basis | Day range | 52-week range. Day range and 52-week range
// come from the API (Yahoo regularMarketDayLow/High and
// fiftyTwoWeekLow/High, stored on refresh); without a quote they
// show as a dash, never as an invented number.
let owner = "all";
let owners = [];
let lastData = null;
let sortKey = "symbol";
let sortDir = 1;

const $ = (s) => document.querySelector(s);
// Value masking (eye toggle): when on, every dollar amount rendered
// through money()/moneySigned() becomes a fixed "****" — fixed length,
// so the number of digits (and therefore the magnitude) does not leak
// the way "$***,***.**" would. Percentages, quantities, symbols and
// indexed growth (100-based, not dollars) stay visible by design;
// this masks monetary values only, as requested, and it is a display
// mask only — the server still returns real values to the browser.
let masked = false;
try { masked = localStorage.getItem("fin_dash_masked") === "1"; } catch {}
// Null is a missing value, not zero: the old money() rendered null
// as $0.00 (via n || 0), which is how an unpriced holding's
// gain/loss showed as 0.0. Now null renders as "—" (or **** when
// masked, so masking does not reveal whether a value is missing).
const money = (n) => n == null ? (masked ? "****" : "—")
  : masked ? "****"
  : "$" + n.toLocaleString(undefined, {maximumFractionDigits: 2, minimumFractionDigits: 2});
const moneySigned = (n) => n == null ? (masked ? "****" : "—")
  : masked ? "****"
  : (n < 0 ? "-$" : "+$") + Math.abs(n).toLocaleString(undefined, {maximumFractionDigits: 2, minimumFractionDigits: 2});
// Collapsed account groups, persisted across reloads and owner-tab
// switches, so the grouping (and which groups are open) stays put.
let collapsedGroups = new Set();
try { collapsedGroups = new Set(JSON.parse(localStorage.getItem("fin_dash_collapsed") || "[]")); } catch {}
const groupKey = (g) => `${g.owner}|${g.account}`;
function saveCollapsed() {
  try { localStorage.setItem("fin_dash_collapsed", JSON.stringify([...collapsedGroups])); } catch {}
}

function updateMaskButton() {
  const b = $("#mask-toggle");
  if (!b) return;
  // Open eye = values are showing, closed eye = values are masked.
  b.textContent = masked ? "👁️ Show values" : "🙈 Mask values";
  b.setAttribute("aria-pressed", masked ? "true" : "false");
  b.title = masked ? "Show monetary values" : "Mask monetary values with asterisks";
}
const pct = (n) => `${n < 0 ? "" : "+"}${(n || 0).toFixed(2)}%`;
const cls = (n) => (n < 0 ? "neg" : "pos");
const num = (n) => (n || 0).toLocaleString(undefined, {maximumFractionDigits: 3});
const escAttr = (s) => String(s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function rangeCell(h) {
  if (h.week_low == null || h.week_high == null || h.week_position == null) return "—";
  const left = Math.max(0, Math.min(100, h.week_position * 100));
  return `<div class="range"><span class="range-bar"><i style="left:${left}%"></i></span>` +
    `<span class="range-labels"><span>${money(h.week_low)}</span><span>${money(h.week_high)}</span></span></div>`;
}

function dayRangeCell(h) {
  if (h.day_low == null || h.day_high == null || h.day_position == null) return "—";
  const left = Math.max(0, Math.min(100, h.day_position * 100));
  return `<div class="range"><span class="range-bar"><i style="left:${left}%"></i></span>` +
    `<span class="range-labels"><span>${money(h.day_low)}</span><span>${money(h.day_high)}</span></span></div>`;
}

function holdingRow(h) {
  // Full company name is a hover tooltip only, not a second line — the
  // ticker column stays narrow (tickers are at most ~4-5 characters).
  // data-label on every cell drives the phone card layout (see
  // style.css @media): on a narrow screen each row becomes a card
  // with the column name shown before its value.
  return `<tr data-symbol="${h.symbol}" class="holding-row">
    <td class="symbol-col" data-label="Symbol"><strong title="${escAttr(h.name)}">${h.symbol}</strong></td>
    <td class="num" data-label="Last price">${money(h.price)}<span class="sub-line ${h.last_change == null ? "" : cls(h.last_change)}">${moneySigned(h.last_change)} ${h.last_change_pct == null ? "—" : pct(h.last_change_pct)}</span></td>
    <td class="num ${h.today_gain == null ? "" : cls(h.today_gain)}" data-label="Today's gain/loss">${moneySigned(h.today_gain)}<span class="sub-line">${h.today_gain_pct == null ? "—" : pct(h.today_gain_pct)}</span></td>
    <td class="num ${h.total_gain == null ? "" : cls(h.total_gain)}" data-label="Total gain/loss">${moneySigned(h.total_gain)}<span class="sub-line">${h.total_gain_pct == null ? "—" : pct(h.total_gain_pct)}</span></td>
    <td class="num" data-label="Current value">${money(h.current_value)}</td>
    <td class="num" data-label="% of account">${h.pct_of_account == null ? "—" : h.pct_of_account.toFixed(2) + "%"}</td>
    <td class="num" data-label="Quantity">${num(h.quantity)}</td>
    <td class="num" data-label="Cost basis">${money(h.cost_total)}<span class="sub-line">${money(h.cost_per_share)} / Share</span></td>
    <td data-label="Day range">${dayRangeCell(h)}</td>
    <td data-label="52-week range">${rangeCell(h)}</td>
    <td data-label=""><button data-del="${h.id}">Remove</button></td>
  </tr>`;
}

function totalRow(label, today, total, value) {
  return `<tr class="total-row"><td><strong>${label}</strong></td><td></td>` +
    `<td class="num ${cls(today)}"><strong>${moneySigned(today)}</strong></td>` +
    `<td class="num ${cls(total)}"><strong>${moneySigned(total)}</strong></td>` +
    `<td class="num"><strong>${money(value)}</strong></td><td colspan="6"></td></tr>`;
}

function renderHoldings() {
  const d = lastData;
  if (!d) return;
  // Group by account (brokerage account, Fidelity-style: one account
  // header, then its rows, then that account's total; the overall
  // total follows in <tfoot>). Grouping stays in place: groups are
  // ordered by owner then account name, and sorting applies WITHIN
  // each group only — the old code sorted holdings globally first,
  // so clicking a sort header reordered the groups themselves.
  // Each group header is an expand/collapse toggle; collapsed groups
  // still show their account total in the header, and the collapsed
  // set is persisted in localStorage (see collapsedGroups above).
  const groups = [];
  for (const h of d.holdings) {
    let g = groups.find((x) => x.account === h.account_name && x.owner === h.owner_name);
    if (!g) { g = {account: h.account_name, owner: h.owner_name, rows: []}; groups.push(g); }
    g.rows.push(h);
  }
  groups.sort((a, b) => (a.owner + "|" + a.account).localeCompare(b.owner + "|" + b.account));
  const sortRows = (rows) => [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;  // unpriced rows sort last, never as 0
    if (bv == null) return -1;
    if (typeof av === "string") return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });
  let html = "";
  for (const g of groups) {
    const rows = sortRows(g.rows);
    const priced = rows.filter((h) => h.priced);
    const tv = priced.reduce((s, h) => s + h.current_value, 0);
    const tt = priced.reduce((s, h) => s + (h.today_gain || 0), 0);
    const tg = priced.reduce((s, h) => s + h.total_gain, 0);
    const collapsed = collapsedGroups.has(groupKey(g));
    const arrow = collapsed ? "▸" : "▾";
    html += `<tr class="group-header" data-group="${escAttr(groupKey(g))}"><td colspan="11">` +
      `<button class="group-toggle" aria-expanded="${!collapsed}">${arrow}</button> ` +
      `${g.account} — ${g.owner} &nbsp;·&nbsp; ${money(tv)}` +
      ` <span class="${tg < 0 ? "neg" : "pos"}">${moneySigned(tg)}</span>` +
      (collapsed ? ` <span class="small">(${rows.length} holding${rows.length === 1 ? "" : "s"} — collapsed)</span>` : "") +
      `</td></tr>`;
    if (!collapsed) {
      html += rows.map(holdingRow).join("");
      html += totalRow("Account total", tt, tg, tv);
    }
  }
  if (!html) html = `<tr><td colspan="11">No holdings yet — add one below or import a CSV/XLSX export.</td></tr>`;
  $("#holdings tbody").innerHTML = html;
  // Unpriced holdings are excluded from totals (see dashboard): say
  // so in plain sight, instead of letting a total silently omit them.
  const unpriced = d.unpriced || [];
  $("#unpriced-note").textContent = unpriced.length
    ? `${unpriced.length} holding${unpriced.length === 1 ? "" : "s"} ha${unpriced.length === 1 ? "s" : "ve"} no price yet (${unpriced.join(", ")}) — shown as — and excluded from totals. Refresh quotes, or check the import for a missing price.`
    : "";
  const t = d.totals;
  $("#holdings tfoot").innerHTML = totalRow("Account total", t.day_move, t.gain, t.value);
  document.querySelectorAll("#holdings tbody tr.group-header").forEach((tr) =>
    tr.addEventListener("click", () => {
      const key = tr.dataset.group;
      if (collapsedGroups.has(key)) collapsedGroups.delete(key); else collapsedGroups.add(key);
      saveCollapsed();
      renderHoldings();
    }));
  document.querySelectorAll("#holdings tbody tr.holding-row").forEach((tr) =>
    tr.addEventListener("click", (e) => { if (!e.target.dataset.del) showDetail(tr.dataset.symbol); }));
  document.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => { await fetch(`/api/holdings/${b.dataset.del}`, {method: "DELETE"}); load(); }));
  document.querySelectorAll("#holdings thead th[data-sort]").forEach((th) => {
    th.textContent = th.dataset.label + (sortKey === th.dataset.sort ? (sortDir === 1 ? " ▲" : " ▼") : " ◆");
    th.onclick = () => {
      if (sortKey === th.dataset.sort) sortDir *= -1; else { sortKey = th.dataset.sort; sortDir = 1; }
      renderHoldings();
    };
  });
}

function renderWatch() {
  const flags = (lastData && lastData.watch) || [];
  $("#watch-list").innerHTML = flags.length
    ? flags.map((f) => `<li><strong>${f.title}</strong> — ${f.detail}</li>`).join("")
    : `<li>No watch flags — nothing in the current holdings trips the rules above.</li>`;
}

function drawAllocation() {
  const c = $("#alloc-chart"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  const bySym = {};
  (lastData.holdings || []).forEach((h) => {
    if (h.current_value == null) return;  // unpriced: excluded, not 0
    bySym[h.symbol] = (bySym[h.symbol] || 0) + h.current_value;
  });
  const entries = Object.entries(bySym).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!total) { $("#alloc-legend").textContent = "No holdings yet."; return; }
  const colors = ["#1f6feb", "#0a7d33", "#e67e22", "#7d3cff", "#c00", "#0e9aa7", "#8a6d00", "#556", "#2f9e44", "#d63384"];
  let start = -Math.PI / 2;
  entries.forEach(([sym, v], i) => {
    const frac = v / total, end = start + frac * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(c.width / 2, c.height / 2);
    ctx.arc(c.width / 2, c.height / 2, Math.min(c.width, c.height) / 2 - 10, start, end);
    ctx.closePath(); ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    start = end;
  });
  ctx.beginPath(); ctx.arc(c.width / 2, c.height / 2, 60, 0, Math.PI * 2);
  ctx.fillStyle = "#fff"; ctx.fill();
  $("#alloc-legend").innerHTML = entries.map(([sym, v], i) =>
    `<div><span style="display:inline-block;width:12px;height:12px;background:${colors[i % colors.length]}"></span> ` +
    `${sym} — ${(v / total * 100).toFixed(1)}% (${money(v)})</div>`).join("");
}

async function loadGrowth() {
  try {
    lastGrowth = await (await fetch(`/api/growth?owner=${owner}`)).json();
  } catch { lastGrowth = null; }
  drawGrowth();
}

function drawGrowth() {
  const c = $("#growth-chart"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!lastGrowth || !lastGrowth.dates.length) {
    $("#growth-meta").textContent = "No growth history yet — add holdings first.";
    return;
  }
  const days = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365, "ALL": Infinity }[growthRange];
  const endDate = new Date(lastGrowth.dates[lastGrowth.dates.length - 1]);
  let startIdx = 0;
  if (days !== Infinity) {
    const cutoff = new Date(endDate); cutoff.setDate(cutoff.getDate() - days);
    startIdx = lastGrowth.dates.findIndex((d) => new Date(d) >= cutoff);
    if (startIdx < 0) startIdx = 0;
  }
  const dates = lastGrowth.dates.slice(startIdx);
  // Re-index to 100 at the start of the selected range.
  const p0 = lastGrowth.portfolio_index[startIdx], v0 = lastGrowth.voo_index[startIdx];
  const p = lastGrowth.portfolio_index.slice(startIdx).map((v) => v / p0 * 100);
  const v = lastGrowth.voo_index.slice(startIdx).map((x) => x / v0 * 100);
  const all = [...p, ...v];
  const min = Math.min(...all), max = Math.max(...all);
  const pad = 30, W = c.width - pad * 2, H = c.height - pad * 2;
  const line = (series, color) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 2;
    series.forEach((val, i) => {
      const x = pad + (series.length > 1 ? (i / (series.length - 1)) * W : W / 2);
      const y = pad + (1 - (val - min) / (max - min || 1)) * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  line(v, "#9aa7b8"); line(p, "#1f6feb");
  ctx.fillStyle = "#333";
  ctx.fillText(`${dates[0]} → ${dates[dates.length - 1]}`, pad, 18);
  ctx.fillStyle = "#1f6feb"; ctx.fillText("Portfolio", pad, 36);
  ctx.fillStyle = "#9aa7b8"; ctx.fillText("VOO", pad + 90, 36);
  const pg = (p[p.length - 1] - 100), vg = (v[v.length - 1] - 100);
  $("#growth-meta").textContent =
    `Portfolio ${pg >= 0 ? "+" : ""}${pg.toFixed(2)}% vs VOO ${vg >= 0 ? "+" : ""}${vg.toFixed(2)}% over this range.` +
    (lastGrowth.symbols_failed.length ? ` History unavailable for: ${lastGrowth.symbols_failed.join(", ")}.` : "");
}

document.querySelectorAll("#growth-ranges button").forEach((b) =>
  b.addEventListener("click", () => {
    growthRange = b.dataset.range;
    document.querySelectorAll("#growth-ranges button").forEach((x) => x.classList.toggle("active", x === b));
    drawGrowth();
  }));

async function load() {
  const d = await (await fetch(`/api/dashboard?owner=${owner}`)).json();
  lastData = d;
  owners = d.owners;
  renderTabs();
  fillSelects();
  renderWatch();
  drawAllocation();
  loadGrowth();
  const t = d.totals;
  $("#kpis").innerHTML = [
    ["Portfolio value", money(t.value)],
    ["Today", `${moneySigned(t.day_move)} (${pct(t.day_move_pct)})`],
    ["Total gain", `${moneySigned(t.gain)} (${pct(t.gain_pct)})`],
    ["Cost basis", money(t.cost)],
  ].map(([k, v]) => `<div class="card"><span>${k}</span><strong>${v}</strong></div>`).join("");
  renderHoldings();
}

function renderTabs() {
  const tabs = [{id: "all", name: "Household"}, ...owners];
  $("#owner-tabs").innerHTML = tabs.map((o) =>
    `<button class="${String(o.id) === String(owner) ? "active" : ""}" data-owner="${o.id}">${o.name}</button>`).join("");
  document.querySelectorAll("#owner-tabs button").forEach((b) =>
    b.addEventListener("click", () => { owner = b.dataset.owner; load(); }));
}

function fillSelects() {
  for (const id of ["#add-owner", "#import-owner"]) {
    const sel = $(id);
    if (!sel.dataset.filled) {
      sel.innerHTML = owners.map((o) => `<option value="${o.id}">${o.name}</option>`).join("");
      sel.dataset.filled = "1";
    }
  }
}

function drawChart(history) {
  const c = $("#chart"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  if (!history.length) { ctx.fillText("No price history available for this symbol.", 20, 30); return; }
  const closes = history.map((h) => h.close), vols = history.map((h) => h.volume);
  const min = Math.min(...closes), max = Math.max(...closes), vmax = Math.max(...vols, 1);
  const pad = 30, W = c.width - pad * 2, H = c.height - pad * 2;
  history.forEach((h, i) => {
    const x = pad + (i / (history.length - 1)) * W;
    const vh = (h.volume / vmax) * (H * 0.3);
    ctx.fillStyle = "#9aa7b8";
    ctx.fillRect(x, pad + H - vh, Math.max(1, W / history.length - 1), vh);
  });
  ctx.beginPath(); ctx.strokeStyle = "#1f6feb"; ctx.lineWidth = 2;
  history.forEach((h, i) => {
    const x = pad + (i / (history.length - 1)) * W;
    const y = pad + (1 - (h.close - min) / (max - min || 1)) * (H * 0.65);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = "#333";
  const minMax = masked ? "**** – ****" : `${min.toFixed(2)} – ${max.toFixed(2)}`;
  ctx.fillText(`${history[0].date} → ${history[history.length - 1].date}  •  ${minMax}`, pad, 18);
}

async function showDetail(symbol) {
  const d = await (await fetch(`/api/symbol/${symbol}`)).json();
  $("#detail").hidden = false;
  $("#detail-title").textContent = symbol;
  const range = (d.week_low != null && d.week_high != null)
    ? ` • 52-week range ${money(d.week_low)} – ${money(d.week_high)}` : "";
  const day = (d.day_low != null && d.day_high != null)
    ? ` • Day range ${money(d.day_low)} – ${money(d.day_high)}` : "";
  // Beta / market cap are best-effort from Nasdaq's summary (no key);
  // when Nasdaq does not publish them for a symbol they are omitted,
  // never estimated. Market cap goes through money() so the eye mask
  // hides it like every other dollar amount.
  const beta = (d.beta != null) ? ` • Beta ${d.beta.toFixed(2)}` : "";
  const mcap = (d.market_cap != null) ? ` • Market cap ${money(d.market_cap)}` : "";
  const sector = d.sector ? ` • ${d.sector}${d.industry ? ` — ${d.industry}` : ""}` : "";
  $("#detail-meta").textContent = d.quote
    ? `Last quote ${money(d.quote.price)} via ${d.quote.provider} at ${d.quote.as_of || "unknown"}${day}${range}${beta}${mcap}${sector}`
    : "No cached quote yet — click Refresh quotes.";
  drawChart(d.history);
}

// Expand / collapse all account groups (persisted like single toggles).
$("#expand-all").addEventListener("click", () => { collapsedGroups.clear(); saveCollapsed(); renderHoldings(); });
$("#collapse-all").addEventListener("click", () => {
  if (!lastData) return;
  for (const h of lastData.holdings) collapsedGroups.add(`${h.owner_name}|${h.account_name}`);
  saveCollapsed(); renderHoldings();
});

// Export / backup: plain downloads, no API JSON to render.
$("#export-csv").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = `/api/export?owner=${owner}`; a.download = "fin_dash_holdings.csv";
  a.click();
});
$("#backup-db").addEventListener("click", () => {
  const a = document.createElement("a");
  a.href = "/api/backup"; a.download = "fin_dash_backup.db";
  a.click();
});

$("#refresh").addEventListener("click", async () => {
  const r = await (await fetch("/api/refresh", {method: "POST"})).json();
  alert(`Refreshed ${r.refreshed}, failed ${r.failed} (provider: ${r.provider})`);
  load();
});

// Eye toggle: flip the mask, remember it for next visit, re-render.
$("#mask-toggle").addEventListener("click", () => {
  masked = !masked;
  try { localStorage.setItem("fin_dash_masked", masked ? "1" : "0"); } catch {}
  updateMaskButton();
  load();
});
updateMaskButton();

$("#add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ownerId = $("#add-owner").value, account = $("#add-account").value.trim();
  const acc = await (await fetch("/api/accounts", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({owner_id: ownerId, name: account})})).json();
  await fetch("/api/holdings", {method: "POST", headers: {"Content-Type": "application/json"},
    body: JSON.stringify({account_id: acc.id, symbol: $("#add-symbol").value,
      shares: $("#add-shares").value, cost_basis: $("#add-cost").value, source: "manual"})});
  load();
});

$("#import-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData();
  fd.append("file", $("#import-file").files[0]);
  fd.append("owner_id", $("#import-owner").value);
  fd.append("account_name", $("#import-account").value);
  const r = await fetch("/api/import", {method: "POST", body: fd});
  const j = await r.json();
  $("#import-result").textContent = r.ok
    ? `Created ${j.created}, updated ${j.updated}, skipped ${j.skipped}.`
    : `Import failed: ${j.error}`;
  if (r.ok) load();
});

load();
