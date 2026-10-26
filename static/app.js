// fin_dash frontend: view-only. No trading calls exist on the server.
let owner = "all";
let owners = [];

const $ = (s) => document.querySelector(s);
const money = (n) => "$" + (n || 0).toLocaleString(undefined, {maximumFractionDigits: 2, minimumFractionDigits: 2});

async function load() {
  const d = await (await fetch(`/api/dashboard?owner=${owner}`)).json();
  owners = d.owners;
  renderTabs();
  fillSelects();
  const t = d.totals;
  $("#kpis").innerHTML = [
    ["Portfolio value", money(t.value)],
    ["Today", `${money(t.day_move)} (${t.day_move_pct.toFixed(2)}%)`],
    ["Total gain", `${money(t.gain)} (${t.gain_pct.toFixed(2)}%)`],
    ["Cost basis", money(t.cost)],
  ].map(([k, v]) => `<div class="card"><span>${k}</span><strong>${v}</strong></div>`).join("");
  $("#holdings tbody").innerHTML = d.holdings.map((h) => `
    <tr data-symbol="${h.symbol}">
      <td>${h.owner_name}</td><td>${h.account_name}</td><td><strong>${h.symbol}</strong></td>
      <td>${h.shares}</td><td>${money(h.price)}</td><td>${money(h.value)}</td>
      <td>${money(h.day_move)}</td><td>${money(h.gain)}</td>
      <td>${h.source} / ${h.quote_provider}</td>
      <td><button data-del="${h.id}">Remove</button></td>
    </tr>`).join("") || `<tr><td colspan="10">No holdings yet — add one below or import a CSV/XLSX export.</td></tr>`;
  document.querySelectorAll("#holdings tbody tr[data-symbol]").forEach((tr) =>
    tr.addEventListener("click", (e) => { if (!e.target.dataset.del) showDetail(tr.dataset.symbol); }));
  document.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => { await fetch(`/api/holdings/${b.dataset.del}`, {method: "DELETE"}); load(); }));
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
  // volume bars (bottom third)
  history.forEach((h, i) => {
    const x = pad + (i / (history.length - 1)) * W;
    const vh = (h.volume / vmax) * (H * 0.3);
    ctx.fillStyle = "#9aa7b8";
    ctx.fillRect(x, pad + H - vh, Math.max(1, W / history.length - 1), vh);
  });
  // price line
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
  $("#detail-meta").textContent = d.quote
    ? `Last quote ${money(d.quote.price)} via ${d.quote.provider} at ${d.quote.as_of || "unknown"}`
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
