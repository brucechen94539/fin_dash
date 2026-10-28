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
// Inline chart: which holding's price + volume chart is open, and
// where it lives — a detail row inserted directly after that holding's
// row (on a phone, directly under its card), not a panel at the bottom.
// The holding id (not just the symbol) identifies the row, because the
// same symbol can appear in several accounts.
let expandedHoldingId = null;
let expandedSymbol = null;

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
// Market cap as the hosted detail panel shows it: $5,074.8B, not the
// full dollar figure ($5,065,639,878,000.00).
const moneyB = (n) => n == null ? (masked ? "****" : "—")
  : masked ? "****"
  : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
  : money(n);
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
  return `<tr data-symbol="${h.symbol}" data-id="${h.id}" class="holding-row">
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
      html += rows.map((h) => holdingRow(h) +
        (String(h.id) === String(expandedHoldingId)
          ? `<tr class="detail-row" data-detail-for="${h.id}"><td colspan="11">` +
            `<div class="detail-head"><strong>${h.symbol} — price + volume</strong>` +
            `<button data-close-detail>Close</button></div>` +
            `<div class="detail-ranges" role="group" aria-label="Chart range">` +
            `<button data-detail-range="1M">1M</button><button data-detail-range="3M">3M</button>` +
            `<button data-detail-range="6M">6M</button><button data-detail-range="1Y" class="active">1Y</button></div>` +
            `<canvas class="detail-chart" width="900" height="340"></canvas>` +
            `<p class="detail-hover small">Hover a point for its date, close, day change, volume and moving averages.</p>` +
            `<p class="detail-meta small">Loading chart…</p></td></tr>`
          : "")).join("");
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
    tr.addEventListener("click", (e) => {
      if (e.target.dataset.del) return;
      // Toggle: clicking the open row closes its chart; clicking
      // another row moves the chart under that row.
      if (String(tr.dataset.id) === String(expandedHoldingId)) {
        expandedHoldingId = null; expandedSymbol = null;
      } else {
        expandedHoldingId = tr.dataset.id; expandedSymbol = tr.dataset.symbol;
      }
      renderHoldings();
    }));
  document.querySelectorAll("[data-close-detail]").forEach((b) =>
    b.addEventListener("click", () => {
      expandedHoldingId = null; expandedSymbol = null;
      renderHoldings();
    }));
  // If a chart is open, fill the detail row that renderHoldings just
  // inserted (this re-runs after sort / mask / group changes, so the
  // chart follows the row instead of being lost on re-render).
  if (expandedHoldingId && expandedSymbol) fillDetail(expandedHoldingId, expandedSymbol);
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
  const slices = [];
  entries.forEach(([sym, v], i) => {
    const frac = v / total, end = start + frac * Math.PI * 2;
    slices.push({sym, v, start, end, color: colors[i % colors.length]});
    ctx.beginPath(); ctx.moveTo(c.width / 2, c.height / 2);
    ctx.arc(c.width / 2, c.height / 2, Math.min(c.width, c.height) / 2 - 10, start, end);
    ctx.closePath(); ctx.fillStyle = colors[i % colors.length]; ctx.fill();
    start = end;
  });
  // Hover tooltip data: centre, radii, and each slice's angles.
  const outerR0 = Math.min(c.width, c.height) / 2 - 10;
  c._alloc = {slices, total, cx: c.width / 2, cy: c.height / 2, outerR: outerR0, innerR: outerR0 * 0.6};
  // Inner hole scales with the canvas (60% of the outer radius), so
  // changing the canvas size in the template resizes the donut
  // without editing this code.
  const outerR = Math.min(c.width, c.height) / 2 - 10;
  ctx.beginPath(); ctx.arc(c.width / 2, c.height / 2, outerR * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = "#1e293b"; ctx.fill();
  $("#alloc-legend").innerHTML = entries.map(([sym, v], i) =>
    `<div><span style="display:inline-block;width:12px;height:12px;background:${colors[i % colors.length]}"></span> ` +
    `${sym} — ${(v / total * 100).toFixed(1)}% (${money(v)})</div>`).join("");
}

// Allocation hover tooltip: hovering (or tapping, on touch) a slice
// shows its ticker, share, and value in a floating tooltip by the
// cursor. Angles are measured from the -90° start used when drawing;
// only hits inside the donut ring count, not the centre hole or
// outside the donut.
function allocSliceAt(e) {
  const c = $("#alloc-chart"), det = c._alloc;
  if (!det) return null;
  const rect = c.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (c.width / rect.width);
  const py = (e.clientY - rect.top) * (c.height / rect.height);
  const dx = px - det.cx, dy = py - det.cy, r = Math.hypot(dx, dy);
  if (r < det.innerR || r > det.outerR) return null;
  let ang = Math.atan2(dy, dx);
  if (ang < -Math.PI / 2) ang += Math.PI * 2;
  return det.slices.find((s) => ang >= s.start && ang < s.end) || null;
}
function showAllocTooltip(e) {
  const tip = $("#alloc-tooltip"), c = $("#alloc-chart"), det = c._alloc;
  if (!tip || !det) return;
  const slice = allocSliceAt(e);
  if (!slice) { tip.style.display = "none"; return; }
  tip.innerHTML = `<strong>${slice.sym}</strong> — ${(slice.v / det.total * 100).toFixed(1)}% (${money(slice.v)})`;
  tip.style.display = "block";
  const row = tip.parentElement, rowRect = row.getBoundingClientRect(), rect = c.getBoundingClientRect();
  const cssX = e.clientX - rect.left, cssY = e.clientY - rect.top;
  tip.style.left = `${Math.min(rect.left - rowRect.left + cssX + 14, rowRect.width - 180)}px`;
  tip.style.top = `${Math.max(rect.top - rowRect.top + cssY - 10, 0)}px`;
}
$("#alloc-chart").addEventListener("mousemove", showAllocTooltip);
$("#alloc-chart").addEventListener("click", showAllocTooltip);
$("#alloc-chart").addEventListener("mouseleave", () => {
  const tip = $("#alloc-tooltip"); if (tip) tip.style.display = "none";
});

async function loadGrowth() {
  try {
    lastGrowth = await (await fetch(`/api/growth?owner=${owner}`)).json();
  } catch { lastGrowth = null; }
  drawGrowth();
}

// Elaborated Growth vs VOO chart (canvas, no new dependency).
// Indexed to 100 at the range start, as before, but now with: a left
// index axis with gridlines, a dashed 100 baseline, a date axis, a
// shaded gap between the two lines (green where the portfolio is
// ahead, red where it trails), a soft fill under the portfolio line,
// a dashed VOO line so the two are distinguishable without colour
// alone, end dots + end-index labels, and a hover crosshair. The
// meta line below the chart adds outperformance in percentage
// points, the share of days the portfolio was ahead, and each
// series' maximum drawdown over the range — all computed from the
// same re-indexed series, never estimated. Indexed values are not
// dollar amounts, so they stay visible when values are masked.
let growthHoverIdx = null;
function drawGrowth(hoverIdx = null) {
  const c = $("#growth-chart"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = "12px -apple-system, Helvetica, Arial, sans-serif";
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
  const rawMin = Math.min(...all), rawMax = Math.max(...all);
  const padV = (rawMax - rawMin) * 0.08 || 1;
  const lo = rawMin - padV, hi = rawMax + padV;
  const left = 64, right = 76, top = 30, bottom = 28, W = c.width - left - right, H = c.height - top - bottom;
  const x = (i) => left + (p.length > 1 ? (i / (p.length - 1)) * W : W / 2);
  const y = (val) => top + (1 - (val - lo) / (hi - lo || 1)) * H;
  // Legend (top row, above the plot area).
  ctx.fillStyle = "#60a5fa"; ctx.fillRect(left, 8, 18, 3);
  ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "left"; ctx.fillText("Portfolio", left + 24, 14);
  ctx.fillStyle = "#94a3b8"; ctx.fillRect(left + 110, 8, 18, 3);
  ctx.fillText("VOO", left + 134, 14);
  ctx.fillText(`${dates[0]} → ${dates[dates.length - 1]}`, left + 190, 14);
  // Gridlines + index axis.
  ctx.textAlign = "right";
  for (let g = 0; g <= 4; g++) {
    const val = lo + (hi - lo) * g / 4, gy = y(val);
    ctx.strokeStyle = "#334155"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, gy); ctx.lineTo(left + W, gy); ctx.stroke();
    ctx.fillStyle = "#94a3b8"; ctx.fillText(val.toFixed(1), left - 8, gy + 4);
  }
  // Dashed 100 baseline (the range start), when in view.
  if (lo <= 100 && 100 <= hi) {
    ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = "#64748b";
    ctx.beginPath(); ctx.moveTo(left, y(100)); ctx.lineTo(left + W, y(100)); ctx.stroke(); ctx.restore();
    ctx.fillStyle = "#64748b"; ctx.fillText("100", left - 8, y(100) - 6);
  }
  // Shaded gap between the lines, segment by segment.
  for (let i = 1; i < p.length; i++) {
    const ahead = ((p[i - 1] + p[i]) / 2) > ((v[i - 1] + v[i]) / 2);
    ctx.fillStyle = ahead ? "rgba(34, 197, 94, 0.16)" : "rgba(248, 113, 113, 0.16)";
    ctx.beginPath();
    ctx.moveTo(x(i - 1), y(p[i - 1])); ctx.lineTo(x(i), y(p[i]));
    ctx.lineTo(x(i), y(v[i])); ctx.lineTo(x(i - 1), y(v[i - 1])); ctx.closePath(); ctx.fill();
  }
  // Soft fill under the portfolio line.
  const grad = ctx.createLinearGradient(0, top, 0, top + H);
  grad.addColorStop(0, "rgba(96, 165, 250, 0.22)"); grad.addColorStop(1, "rgba(96, 165, 250, 0)");
  ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(x(0), y(p[0]));
  p.forEach((val, i) => ctx.lineTo(x(i), y(val)));
  ctx.lineTo(x(p.length - 1), top + H); ctx.lineTo(x(0), top + H); ctx.closePath(); ctx.fill();
  const line = (series, color, width, dashed) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.save(); if (dashed) ctx.setLineDash([7, 5]);
    series.forEach((val, i) => { const px = x(i), py = y(val); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke(); ctx.restore();
  };
  line(v, "#94a3b8", 2, true);
  line(p, "#60a5fa", 2.5, false);
  // Start dot (both at 100) and end dots + end-index labels.
  const dot = (px, py, color) => { ctx.beginPath(); ctx.fillStyle = color; ctx.arc(px, py, 4, 0, Math.PI * 2); ctx.fill(); };
  dot(x(0), y(100), "#e2e8f0");
  const lastI = p.length - 1;
  dot(x(lastI), y(p[lastI]), "#60a5fa"); dot(x(lastI), y(v[lastI]), "#94a3b8");
  ctx.textAlign = "left";
  ctx.fillStyle = "#60a5fa"; ctx.fillText(p[lastI].toFixed(1), x(lastI) + 8, y(p[lastI]) + 4);
  ctx.fillStyle = "#94a3b8"; ctx.fillText(v[lastI].toFixed(1), x(lastI) + 8, y(v[lastI]) + 4);
  // Date axis: first, middle, last.
  ctx.fillStyle = "#94a3b8"; ctx.textAlign = "center";
  [0, Math.floor(lastI / 2), lastI].filter((i, _, a) => a.indexOf(i) === i)
    .forEach((i) => ctx.fillText(dates[i], x(i), top + H + 20));
  // Hover crosshair.
  if (hoverIdx != null && hoverIdx >= 0 && hoverIdx < p.length) {
    ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x(hoverIdx), top); ctx.lineTo(x(hoverIdx), top + H); ctx.stroke(); ctx.restore();
    dot(x(hoverIdx), y(p[hoverIdx]), "#60a5fa"); dot(x(hoverIdx), y(v[hoverIdx]), "#94a3b8");
  }
  c._growth = {dates, p, v, x};
  // Meta: range return, outperformance, days ahead, max drawdowns.
  const pg = p[lastI] - 100, vg = v[lastI] - 100, out = pg - vg;
  const aheadDays = p.filter((val, i) => val > v[i]).length;
  const drawdown = (series) => {
    let peak = series[0], worst = 0;
    series.forEach((val) => { if (val > peak) peak = val; worst = Math.min(worst, (val - peak) / peak * 100); });
    return worst;
  };
  const fmt = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  const meta = $("#growth-meta");
  meta.innerHTML = `Portfolio <span class="${pg >= 0 ? "pos" : "neg"}">${fmt(pg)}</span> vs VOO ` +
    `<span class="${vg >= 0 ? "pos" : "neg"}">${fmt(vg)}</span> over this range • ` +
    `Outperformance <span class="${out >= 0 ? "pos" : "neg"}">${fmt(out)}</span> • ` +
    `Ahead of VOO on ${aheadDays} of ${p.length} days (${(aheadDays / p.length * 100).toFixed(0)}%) • ` +
    `Max drawdown: Portfolio ${drawdown(p).toFixed(2)}% / VOO ${drawdown(v).toFixed(2)}%.`;
  if (lastGrowth.symbols_failed.length) meta.appendChild(document.createTextNode(` History unavailable for: ${lastGrowth.symbols_failed.join(", ")}.`));
}

document.querySelectorAll("#growth-ranges button").forEach((b) =>
  b.addEventListener("click", () => {
    growthRange = b.dataset.range;
    document.querySelectorAll("#growth-ranges button").forEach((x) => x.classList.toggle("active", x === b));
    growthHoverIdx = null;
    drawGrowth();
  }));

// Growth hover: nearest date → portfolio vs VOO index, gap, and
// each series' return since the range start.
$("#growth-chart").addEventListener("mousemove", (e) => {
  const c = $("#growth-chart"), det = c._growth, hover = $("#growth-hover");
  if (!det || !hover) return;
  const rect = c.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (c.width / rect.width);
  let best = 0, bestDx = Infinity;
  det.p.forEach((_, i) => { const dx = Math.abs(det.x(i) - px); if (dx < bestDx) { bestDx = dx; best = i; } });
  growthHoverIdx = best;
  drawGrowth(best);
  const gap = det.p[best] - det.v[best];
  hover.textContent = `${det.dates[best]} • Portfolio ${det.p[best].toFixed(1)} (${(det.p[best] - 100).toFixed(2)}%) • ` +
    `VOO ${det.v[best].toFixed(1)} (${(det.v[best] - 100).toFixed(2)}%) • Gap ${gap >= 0 ? "+" : ""}${gap.toFixed(1)} points.`;
});
$("#growth-chart").addEventListener("mouseleave", () => {
  growthHoverIdx = null; drawGrowth();
  const hover = $("#growth-hover");
  if (hover) hover.textContent = "Hover a point for that date's portfolio vs VOO index.";
});

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

// Elaborated price + volume chart, drawn on canvas (no new dependency).
// Price pane on top, volume pane below; left price axis with gridlines,
// bottom date axis, 50-day and 200-day moving averages, a dashed cost
// basis line when the holding's cost per share is in view, a last-price
// dot, and a hover crosshair (see fillDetail, which wires mousemove
// to the .detail-hover line). Ranges filter the 1-year history by
// calendar days; moving averages are computed on the full history
// first, so a 1M view still shows a true 50-day average, not an
// average of only the visible month.
let detailRange = "1Y";
const DETAIL_RANGES = {"1M": 30, "3M": 90, "6M": 180, "1Y": 365};
function movingAverage(closes, window) {
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= window) sum -= closes[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}
function drawChart(history, canvas, costBasis) {
  const c = canvas, ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.font = "12px -apple-system, Helvetica, Arial, sans-serif";
  if (!history.length) { ctx.fillStyle = "#e2e8f0"; ctx.fillText("No price history available for this symbol.", 20, 30); return; }
  const days = DETAIL_RANGES[detailRange] || 365;
  const lastDate = new Date(history[history.length - 1].date);
  const cutoff = new Date(lastDate); cutoff.setDate(cutoff.getDate() - days);
  const visible = history.map((h, i) => ({...h, idx: i})).filter((h) => new Date(h.date) >= cutoff);
  const data = visible.length ? visible : history.map((h, i) => ({...h, idx: i}));
  const closes = data.map((h) => h.close);
  const ma50Full = movingAverage(history.map((h) => h.close), 50);
  const ma200Full = movingAverage(history.map((h) => h.close), 200);
  let min = Math.min(...closes), max = Math.max(...closes);
  if (costBasis != null && costBasis > 0) { min = Math.min(min, costBasis); max = Math.max(max, costBasis); }
  const pad = min * 0.02, lo = min - pad, hi = max + pad;
  const left = 72, right = 12, top = 18, bottom = 28, gap = 10;
  const priceH = 200, volH = 70, W = c.width - left - right;
  const x = (i) => left + (data.length > 1 ? (i / (data.length - 1)) * W : W / 2);
  const y = (v) => top + (1 - (v - lo) / (hi - lo || 1)) * priceH;
  const vmax = Math.max(...data.map((h) => h.volume), 1);
  // Gridlines + price axis (masked like every other dollar amount).
  ctx.strokeStyle = "#334155"; ctx.lineWidth = 1; ctx.fillStyle = "#94a3b8"; ctx.textAlign = "right";
  for (let g = 0; g <= 4; g++) {
    const v = lo + (hi - lo) * g / 4, gy = y(v);
    ctx.beginPath(); ctx.moveTo(left, gy); ctx.lineTo(left + W, gy); ctx.stroke();
    ctx.fillText(masked ? "****" : `$${v.toFixed(2)}`, left - 8, gy + 4);
  }
  // Volume bars, green on up days, red on down days.
  data.forEach((h, i) => {
    const vh = (h.volume / vmax) * volH;
    ctx.fillStyle = h.close >= (h.open || h.close) ? "#22c55e" : "#f87171";
    ctx.fillRect(x(i), top + priceH + gap + volH - vh, Math.max(1, W / data.length - 1), vh);
  });
  const line = (values, color, width) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = width; let started = false;
    data.forEach((h, i) => {
      const v = values[h.idx];
      if (v == null) return;
      const px = x(i), py = y(v);
      started ? ctx.lineTo(px, py) : ctx.moveTo(px, py); started = true;
    });
    ctx.stroke();
  };
  line(ma200Full, "#c084fc", 1.5);
  line(ma50Full, "#fb923c", 1.5);
  ctx.beginPath(); ctx.strokeStyle = "#f8fafc"; ctx.lineWidth = 2;
  data.forEach((h, i) => { const px = x(i), py = y(h.close); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
  ctx.stroke();
  // Cost basis: dashed green line + label, only when in view.
  if (costBasis != null && costBasis > 0 && costBasis >= lo && costBasis <= hi) {
    ctx.save(); ctx.setLineDash([6, 4]); ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(left, y(costBasis)); ctx.lineTo(left + W, y(costBasis)); ctx.stroke(); ctx.restore();
    ctx.fillStyle = "#22c55e"; ctx.textAlign = "left";
    ctx.fillText(masked ? "Cost ****" : `Cost $${costBasis.toFixed(2)}`, left + 6, y(costBasis) - 6);
  }
  // Last-price dot + label.
  const last = data[data.length - 1];
  ctx.beginPath(); ctx.fillStyle = "#f8fafc"; ctx.arc(x(data.length - 1), y(last.close), 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "left";
  ctx.fillText(masked ? "****" : `$${last.close.toFixed(2)}`, Math.min(x(data.length - 1) + 8, left + W - 60), y(last.close) - 8);
  // Date axis: first, middle, last.
  ctx.fillStyle = "#94a3b8"; ctx.textAlign = "center";
  const labelIdx = [0, Math.floor(data.length / 2), data.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  labelIdx.forEach((i) => ctx.fillText(data[i].date, x(i), top + priceH + gap + volH + 20));
  ctx.textAlign = "left";
  // Store geometry for the hover handler in fillDetail.
  c._detail = {data, ma50Full, ma200Full, x, y, left, W, top, priceH};
  const rangeLabel = `${data[0].date} → ${last.date} • ${masked ? "**** – ****" : `$${min.toFixed(2)} – $${max.toFixed(2)}`}`;
  ctx.fillStyle = "#e2e8f0"; ctx.fillText(rangeLabel, left, 14);
}

async function fillDetail(holdingId, symbol) {
  // Draw into the detail row under this holding, not a bottom panel.
  // Bail out if a re-render has since closed or moved the chart, so a
  // slow fetch cannot paint into a row that is no longer open.
  const row = document.querySelector(`tr.detail-row[data-detail-for="${holdingId}"]`);
  if (!row) return;
  const canvas = row.querySelector(".detail-chart");
  const meta = row.querySelector(".detail-meta");
  const d = await (await fetch(`/api/symbol/${symbol}`)).json();
  if (String(holdingId) !== String(expandedHoldingId)) return;
  const range = (d.week_low != null && d.week_high != null)
    ? ` • 52-week range ${money(d.week_low)} – ${money(d.week_high)}` : "";
  const day = (d.day_low != null && d.day_high != null)
    ? ` • Day range ${money(d.day_low)} – ${money(d.day_high)}` : "";
  // Beta / market cap are best-effort from Nasdaq's summary (no key);
  // when Nasdaq does not publish them for a symbol they are omitted,
  // never estimated. Market cap is $B like the hosted panel, and the
  // eye mask hides it like every other dollar amount.
  const beta = (d.beta != null) ? ` • Beta ${d.beta.toFixed(2)}` : "";
  const mcap = (d.market_cap != null) ? ` • Market cap ${moneyB(d.market_cap)}` : "";
  const sector = d.sector ? ` • ${d.sector}${d.industry ? ` — ${d.industry}` : ""}` : "";
  // Previous close, as the hosted detail panel shows it: the price
  // the day's change is measured from (Last price − Previous close).
  const prev = (d.quote && d.quote.price != null && d.quote.change != null)
    ? ` • Previous close ${money(d.quote.price - d.quote.change)}` : "";
  meta.textContent = d.quote
    ? `Last quote ${money(d.quote.price)} via ${d.quote.provider} at ${d.quote.as_of || "unknown"}${prev}${day}${range}${beta}${mcap}${sector}`
    : "No cached quote yet — click Refresh quotes.";
  // Cost basis for this holding (not just the symbol — the same
  // symbol can sit in several accounts at different costs).
  const holding = (lastData.holdings || []).find((h) => String(h.id) === String(holdingId));
  const costBasis = holding ? holding.cost_per_share : null;
  const redraw = () => drawChart(d.history, canvas, costBasis);
  row.querySelectorAll("[data-detail-range]").forEach((x) => x.classList.toggle("active", x.dataset.detailRange === detailRange));
  redraw();
  // Range buttons: re-filter, don't re-fetch.
  row.querySelectorAll("[data-detail-range]").forEach((b) =>
    b.addEventListener("click", () => {
      detailRange = b.dataset.detailRange;
      row.querySelectorAll("[data-detail-range]").forEach((x) => x.classList.toggle("active", x === b));
      redraw();
    }));
  // Hover: nearest visible bar → date, close, day change, volume,
  // 50-day and 200-day averages at that date.
  const hover = row.querySelector(".detail-hover");
  canvas.addEventListener("mousemove", (e) => {
    const det = canvas._detail; if (!det || !hover) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    let best = 0, bestDx = Infinity;
    det.data.forEach((h, i) => { const dx = Math.abs(det.x(i) - px); if (dx < bestDx) { bestDx = dx; best = i; } });
    const h = det.data[best];
    const prevClose = best > 0 ? det.data[best - 1].close : (d.history[h.idx - 1] ? d.history[h.idx - 1].close : null);
    const change = prevClose != null ? ((h.close - prevClose) / prevClose * 100) : null;
    const ma50 = det.ma50Full[h.idx], ma200 = det.ma200Full[h.idx];
    hover.textContent = `${h.date} • Close ${money(h.close)}` +
      (change != null ? ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}% vs prior day)` : "") +
      ` • Volume ${Math.round(h.volume).toLocaleString()}` +
      (ma50 != null ? ` • 50-day avg ${money(ma50)}` : "") +
      (ma200 != null ? ` • 200-day avg ${money(ma200)}` : "");
  });
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
