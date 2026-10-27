// fin_dash frontend: view-only, Fidelity-style portfolio table.
// No trading calls exist on the server. Column order matches the
// Fidelity positions table: Symbol | Last price | Today's gain/loss |
// Total gain/loss | Current value | % of account | Quantity |
// Cost basis | 52-week range. The 52-week range comes from the API
// (Yahoo fiftyTwoWeekLow/High, stored on refresh); without a quote it
// shows as a dash, never as an invented number.
let owner = "all";
let owners = [];
let lastData = null;
let sortKey = "symbol";
let sortDir = 1;

const $ = (s) => document.querySelector(s);
const money = (n) => "$" + (n || 0).toLocaleString(undefined, {maximumFractionDigits: 2, minimumFractionDigits: 2});
const moneySigned = (n) => (n < 0 ? "-$" : "+$") + Math.abs(n || 0).toLocaleString(undefined, {maximumFractionDigits: 2, minimumFractionDigits: 2});
const pct = (n) => `${n < 0 ? "" : "+"}${(n || 0).toFixed(2)}%`;
const cls = (n) => (n < 0 ? "neg" : "pos");
const num = (n) => (n || 0).toLocaleString(undefined, {maximumFractionDigits: 3});

function rangeCell(h) {
  if (h.week_low == null || h.week_high == null || h.week_position == null) return "—";
  const left = Math.max(0, Math.min(100, h.week_position * 100));
  return `<div class="range"><span class="range-bar"><i style="left:${left}%"></i></span>` +
    `<span class="range-labels"><span>${money(h.week_low)}</span><span>${money(h.week_high)}</span></span></div>`;
}

function holdingRow(h) {
  return `<tr data-symbol="${h.symbol}" class="holding-row">
    <td><strong>${h.symbol}</strong><span class="sub-line">${h.name || ""}</span></td>
    <td class="num">${money(h.price)}<span class="sub-line ${cls(h.last_change)}">${moneySigned(h.last_change)} ${pct(h.last_change_pct)}</span></td>
    <td class="num ${cls(h.today_gain)}">${moneySigned(h.today_gain)}<span class="sub-line">${pct(h.today_gain_pct)}</span></td>
    <td class="num ${cls(h.total_gain)}">${moneySigned(h.total_gain)}<span class="sub-line">${pct(h.total_gain_pct)}</span></td>
    <td class="num">${money(h.current_value)}</td>
    <td class="num">${h.pct_of_account.toFixed(2)}%</td>
    <td class="num">${num(h.quantity)}</td>
    <td class="num">${money(h.cost_total)}<span class="sub-line">${money(h.cost_per_share)} / Share</span></td>
    <td>${rangeCell(h)}</td>
    <td><button data-del="${h.id}">Remove</button></td>
  </tr>`;
}

function totalRow(label, today, total, value) {
  return `<tr class="total-row"><td><strong>${label}</strong></td><td></td>` +
    `<td class="num ${cls(today)}"><strong>${moneySigned(today)}</strong></td>` +
    `<td class="num ${cls(total)}"><strong>${moneySigned(total)}</strong></td>` +
    `<td class="num"><strong>${money(value)}</strong></td><td colspan="5"></td></tr>`;
}

function renderHoldings() {
  const d = lastData;
  if (!d) return;
  let holdings = [...d.holdings];
  holdings.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "string") return av.localeCompare(bv) * sortDir;
    return ((av || 0) - (bv || 0)) * sortDir;
  });
  // Group by account, Fidelity-style: one account header, then its rows,
  // then that account's total. The overall total follows in <tfoot>.
  const groups = [];
  for (const h of holdings) {
    let g = groups.find((x) => x.account === h.account_name && x.owner === h.owner_name);
    if (!g) { g = {account: h.account_name, owner: h.owner_name, rows: []}; groups.push(g); }
    g.rows.push(h);
  }
  let html = "";
  for (const g of groups) {
    const tv = g.rows.reduce((s, h) => s + h.current_value, 0);
    const tt = g.rows.reduce((s, h) => s + h.today_gain, 0);
    const tg = g.rows.reduce((s, h) => s + h.total_gain, 0);
    html += `<tr class="group-header"><td colspan="10">${g.account} — ${g.owner}</td></tr>`;
    html += g.rows.map(holdingRow).join("");
    html += totalRow("Account total", tt, tg, tv);
  }
  if (!html) html = `<tr><td colspan="10">No holdings yet — add one below or import a CSV/XLSX export.</td></tr>`;
  $("#holdings tbody").innerHTML = html;
  const t = d.totals;
  $("#holdings tfoot").innerHTML = totalRow("Account total", t.day_move, t.gain, t.value);
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

async function load() {
  const d = await (await fetch(`/api/dashboard?owner=${owner}`)).json();
  lastData = d;
  owners = d.owners;
  renderTabs();
  fillSelects();
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
  ctx.fillText(`${history[0].date} → ${history[history.length - 1].date}  •  ${min.toFixed(2)} – ${max.toFixed(2)}`, pad, 18);
}

async function showDetail(symbol) {
  const d = await (await fetch(`/api/symbol/${symbol}`)).json();
  $("#detail").hidden = false;
  $("#detail-title").textContent = symbol;
  const range = (d.week_low != null && d.week_high != null)
    ? ` • 52-week range ${money(d.week_low)} – ${money(d.week_high)}` : "";
  $("#detail-meta").textContent = d.quote
    ? `Last quote ${money(d.quote.price)} via ${d.quote.provider} at ${d.quote.as_of || "unknown"}${range}`
    : "No cached quote yet — click Refresh quotes.";
  drawChart(d.history);
}

$("#refresh").addEventListener("click", async () => {
  const r = await (await fetch("/api/refresh", {method: "POST"})).json();
  alert(`Refreshed ${r.refreshed}, failed ${r.failed} (provider: ${r.provider})`);
  load();
});

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
