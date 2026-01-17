const API = (path) => `/api${path}`;

const fmtKsh = (n) => {
  const x = Number(n || 0);
  return "Ksh" + x.toLocaleString("en-KE", { maximumFractionDigits: 0 });
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let state = {
  month: null,
  chartMode: "pie",
  filter: "all",
  categories: [],
  transactions: [],
  chart: null,
  budgets: [],        // array from API
  recurringTemplates: [],
  recApplyFilter: "all", // all | income | expense
  recApplySelected: {}, // { [templateId]: true/false }
};

const ADD_MONTH_VALUE = "__add_month__";

function toast(message, type = "ok", title = null, ms = 2600) {
  const host = document.getElementById("toastHost");
  if (!host) return;

  const t = document.createElement("div");
  t.className = `toast ${type}`;

  const safeTitle =
    title || (type === "ok" ? "Done" : type === "warn" ? "Heads up" : "Error");

  t.innerHTML = `
    <div class="toastTitle">${safeTitle}</div>
    <div class="toastMsg">${String(message)}</div>
  `;

  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));

  window.setTimeout(() => {
    t.classList.remove("show");
    window.setTimeout(() => t.remove(), 200);
  }, ms);
}

// ---- Doughnut outside labels + leader lines (Chart.js plugin) ----
const outsideLabelsPlugin = {
  id: "outsideLabels",
  afterDatasetsDraw(chart, args, opts) {
    const o = opts || {};
    if (o.enabled === false) return;

    const ctx = chart.ctx;
    const meta = chart.getDatasetMeta(0);
    if (!meta || !meta.data || !meta.data.length) return;

    const data = chart.data.datasets[0].data || [];
    const labels = chart.data.labels || [];
    const total = data.reduce((s, v) => s + (Number(v) || 0), 0) || 0;

    const fontSize = o.fontSize ?? 12;
    const fontWeight = o.fontWeight ?? 900;
    const textColor = o.textColor ?? "rgba(248,248,248,.95)";
    const lineColor = o.lineColor ?? "rgba(191,195,230,.35)";
    const padding = o.padding ?? 14;      // how far label sits outside donut
    const lineLen = o.lineLen ?? 18;      // first leader segment
    const elbowLen = o.elbowLen ?? 16;    // horizontal segment
    const minPct = o.minPercent ?? 4;     // hide labels below this % to reduce clutter
    const mode = o.mode ?? "both";        // "value" | "percent" | "both" | "label"

    // Build candidate points (right side / left side) then de-conflict Y positions
    const right = [];
    const left = [];

    meta.data.forEach((arc, i) => {
      const v = Number(data[i] || 0);
      if (!v || !total) return;

      const pct = (v / total) * 100;
      if (pct < minPct) return;

      const angle = (arc.startAngle + arc.endAngle) / 2;
      const cx = arc.x;
      const cy = arc.y;
      const r = arc.outerRadius;

      // anchor point on donut edge
      const x1 = cx + Math.cos(angle) * r;
      const y1 = cy + Math.sin(angle) * r;

      // point just outside donut
      const x2 = cx + Math.cos(angle) * (r + lineLen);
      const y2 = cy + Math.sin(angle) * (r + lineLen);

      const isRight = Math.cos(angle) >= 0;

      // final label x (horizontal)
      const x3 = x2 + (isRight ? elbowLen : -elbowLen);
      const y3 = y2;

      // label text
      const baseLabel = labels[i] ?? "";
      const valText = (typeof fmtKsh === "function") ? fmtKsh(v) : String(v);
      const pctText = `${Math.round(pct)}%`;

      let text = baseLabel;
      if (mode === "value") text = `${baseLabel}: ${valText}`;
      if (mode === "percent") text = `${baseLabel}: ${pctText}`;
      if (mode === "both") text = `${baseLabel}: ${valText} (${pctText})`;
      if (mode === "label") text = `${baseLabel}`;

      const item = { i, x1, y1, x2, y2, x3, y3, text, isRight };

      (isRight ? right : left).push(item);
    });

    // simple collision avoidance (keep minimum vertical gap)
    function spread(list) {
      list.sort((a, b) => a.y3 - b.y3);
      const gap = o.minGap ?? (fontSize + 6);

      for (let k = 1; k < list.length; k++) {
        if (list[k].y3 - list[k - 1].y3 < gap) {
          list[k].y3 = list[k - 1].y3 + gap;
        }
      }
      // pull back up if we pushed too far down
      const area = chart.chartArea;
      const bottom = area.bottom - 10;
      const top = area.top + 10;

      const last = list[list.length - 1];
      if (last && last.y3 > bottom) {
        const shift = last.y3 - bottom;
        for (const it of list) it.y3 -= shift;
      }
      const first = list[0];
      if (first && first.y3 < top) {
        const shift = top - first.y3;
        for (const it of list) it.y3 += shift;
      }
    }

    spread(right);
    spread(left);

    // Draw everything
    ctx.save();
    ctx.font = `${fontWeight} ${fontSize}px system-ui, -apple-system, Segoe UI, Roboto, Arial`;
    ctx.fillStyle = textColor;
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;

    function drawItem(it) {
      // leader line: x1,y1 -> x2,y2 -> x3,y3
      ctx.beginPath();
      ctx.moveTo(it.x1, it.y1);
      ctx.lineTo(it.x2, it.y2);
      ctx.lineTo(it.x3, it.y3);
      ctx.stroke();

      // text
      ctx.textAlign = it.isRight ? "left" : "right";
      ctx.textBaseline = "middle";
      const tx = it.x3 + (it.isRight ? padding : -padding);
      ctx.fillText(it.text, tx, it.y3);
    }

    right.forEach(drawItem);
    left.forEach(drawItem);

    ctx.restore();
  }
};

function confirmDialog({
  title = "Confirm",
  message = "Are you sure?",
  okText = "Yes",
  cancelText = "Cancel",
  danger = true
} = {}) {
  return new Promise((resolve) => {
    const modal = $("#confirmModal");
    const titleEl = $("#confirmTitle");
    const msgEl = $("#confirmMessage");
    const btnOk = $("#confirmOk");
    const btnCancel = $("#confirmCancel");
    const btnClose = $("#confirmClose");

    titleEl.textContent = title;
    msgEl.textContent = message;
    btnOk.textContent = okText;
    btnCancel.textContent = cancelText;

    btnOk.className = danger ? "btn btnDangerSolid" : "btn";
    modal.classList.remove("hidden");

    const cleanup = () => {
      modal.classList.add("hidden");
      btnOk.removeEventListener("click", onOk);
      btnCancel.removeEventListener("click", onCancel);
      btnClose.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBackdrop);
      document.removeEventListener("keydown", onKey);
    };

    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target.id === "confirmModal") onCancel(); };
    const onKey = (e) => { if (e.key === "Escape") onCancel(); };

    btnOk.addEventListener("click", onOk);
    btnCancel.addEventListener("click", onCancel);
    btnClose.addEventListener("click", onCancel);
    modal.addEventListener("click", onBackdrop);
    document.addEventListener("keydown", onKey);
  });
}

async function apiGet(path) {
  const res = await fetch(API(path));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

async function apiSend(path, method, payload) {
  const res = await fetch(API(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function monthKeyNow() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function dateToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prevMonthKey(mk) {
  const [y, m] = mk.split("-").map(Number);
  const d = new Date(y, m - 1, 1);
  d.setMonth(d.getMonth() - 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

async function ensureMonth(mk) {
  await apiSend("/months", "POST", { month_key: mk });
}

async function loadBudgets() {
  const { budgets } = await apiGet(`/budgets?month=${encodeURIComponent(state.month)}`);
  state.budgets = budgets || [];
}

function txMonthKey(t){
  return (
    t.month_key ||
    t.monthKey ||
    t.month ||
    String(t.tdate || t.date || "").slice(0, 7) // fallback from date
  );
}

function txDate(t){
  return (t.tdate || t.date || "");
}

function catType(c){
  return String(c?.type || "").toLowerCase();
}

function expenseTotalsByCategory(monthKey){
  const txsAll = state.transactions || [];
  const catMap = new Map((state.categories || []).map(c => [Number(c.id), c]));

  // If txs don't store month key, DON'T exclude them.
  const txs = txsAll.filter(t => {
    const mk = txMonthKey(t);
    return !mk || mk === monthKey;
  });

  const sums = new Map(); // catId -> sum
  for (const t of txs){
    const c = catMap.get(Number(t.category_id));
    if (!c || catType(c) !== "expense") continue;

    sums.set(c.id, (sums.get(c.id) || 0) + Number(t.amount || 0));
  }

  const rows = [...sums.entries()].map(([catId, total]) => {
    const c = catMap.get(Number(catId));
    return {
      id: Number(catId),
      name: c?.name || "Unknown",
      color: c?.color || "#BFC3E6",
      total: Number(total)
    };
  });

  rows.sort((a,b) => b.total - a.total);
  return rows;
}

function getExpenseSumsByCategoryId() {
  const sums = {};
  for (const t of state.transactions || []) {
    if (t.category_type !== "expense") continue;
    const id = Number(t.category_id);
    sums[id] = (sums[id] || 0) + Number(t.amount || 0);
  }
  return sums;
}

function getBudgetMap() {
  const map = {};
  for (const b of state.budgets || []) {
    map[Number(b.category_id)] = Number(b.budget_amount || 0);
  }
  return map;
}

function renderBudgets() {
  const el = $("#budgetList");
  if (!el) return;

  const expenseCats = (state.categories || []).filter(c => c.type === "expense");
  if (!expenseCats.length) {
    el.innerHTML = `<div class="small">No expense categories yet. Add one above.</div>`;
    return;
  }

  const budgetMap = getBudgetMap();
  const spentMap = getExpenseSumsByCategoryId();

  el.innerHTML = expenseCats.map(c => {
    const budget = budgetMap[c.id] || 0;
    const spent = spentMap[c.id] || 0;

    const pct = (budget > 0) ? Math.min(140, Math.round((spent / budget) * 100)) : 0; // cap UI at 140%
    const pctText = (budget > 0) ? `${Math.min(999, Math.round((spent / budget) * 100))}%` : "—";

    // bar color by status
    let barStyle = `background: linear-gradient(90deg, rgba(8,248,80,.95), rgba(88,216,176,.9));`;
    let chip = `<span class="chip chipTeal">OK</span>`;
    if (budget > 0 && spent / budget >= 1) {
      barStyle = `background: linear-gradient(90deg, rgba(224,32,32,.95), rgba(232,40,136,.85));`;
      chip = `<span class="chip badgeOver">OVER</span>`;
    } else if (budget > 0 && spent / budget >= 0.8) {
      barStyle = `background: linear-gradient(90deg, rgba(240,168,16,.95), rgba(232,40,136,.75));`;
      chip = `<span class="chip badgeWarn">80%+</span>`;
    }

    return `
      <div class="item">
        <div class="budgetRow">
          <div class="dot" style="background:${c.color}"></div>

          <div class="budgetMeta">
            <div class="itemTitle">${c.name} ${chip}</div>
            <div class="itemSub">Spent ${fmtKsh(spent)} • Budget ${budget > 0 ? fmtKsh(budget) : "Not set"} • ${pctText}</div>
            <div class="miniProgress">
              <div class="miniBar" style="width:${budget > 0 ? Math.min(100, pct) : 0}%; ${barStyle}"></div>
            </div>
          </div>

          <div class="budgetBtns">
            <input id="budget-${c.id}" class="input budgetInput" type="number" min="0" step="1" value="${budget > 0 ? budget : ""}" placeholder="Ksh" />
            <button class="btn btnSmall" data-save-budget="${c.id}">Save</button>
            <button class="btn btnGhost btnSmall" data-clear-budget="${c.id}">Clear</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderBudgetAlerts() {
  const el = $("#budgetAlertList");
  if (!el) return;

  const expenseCats = (state.categories || []).filter(c => c.type === "expense");
  const budgetMap = getBudgetMap();
  const spentMap = getExpenseSumsByCategoryId();

  const alerts = expenseCats
    .map(c => {
      const budget = budgetMap[c.id] || 0;
      const spent = spentMap[c.id] || 0;
      const ratio = (budget > 0) ? (spent / budget) : 0;
      return { ...c, budget, spent, ratio };
    })
    .filter(x => x.budget > 0 && x.ratio >= 0.8)
    .sort((a,b) => b.ratio - a.ratio)
    .slice(0, 5);

  if (!alerts.length) {
    el.innerHTML = `<div class="small">No budget warnings yet.</div>`;
    return;
  }

  el.innerHTML = alerts.map((x, i) => {
    const isOver = x.ratio >= 1;
    const chip = isOver
      ? `<span class="chip badgeOver">OVER</span>`
      : `<span class="chip badgeWarn">${Math.round(x.ratio*100)}%</span>`;
    return `
      <div class="item">
        <div class="itemRow">
          <div class="rank">${i + 1}</div>
          <div class="dot" style="background:${x.color}"></div>
          <div class="itemLeft">
            <div class="itemTitle">${x.name} ${chip}</div>
            <div class="itemSub">Spent ${fmtKsh(x.spent)} of ${fmtKsh(x.budget)}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function loadMonths() {
  const res = await apiGet("/months");
  const months = (res.months || []).slice().sort().reverse(); // newest first

  const picker = $("#monthPicker");
  picker.innerHTML = "";

  // Add existing months
  months.forEach(mk => {
    const opt = document.createElement("option");
    opt.value = mk;
    opt.textContent = mk;
    picker.appendChild(opt);
  });

  // Add the special "Add new month" option at the bottom
  const addOpt = document.createElement("option");
  addOpt.value = ADD_MONTH_VALUE;
  addOpt.textContent = "+ Add new month…";
  picker.appendChild(addOpt);

  // Select a valid month (or open modal if none)
  if (!state.month && months.length) state.month = months[0];

  // If current state.month doesn't exist anymore, fallback
  if (state.month && !months.includes(state.month) && months.length) {
    state.month = months[0];
  }

  if (state.month) {
  picker.value = state.month;
  } else {
    // No months yet → open modal immediately
    picker.value = ADD_MONTH_VALUE;
    $("#monthInput").value = monthKeyNow();
    openMonthModal();
  }
}

async function loadCategories() {
  const { categories } = await apiGet("/categories");
  state.categories = categories;
  renderCategories();
  renderTxCategoryOptions();
  renderRecurringCategoryOptions();
  renderSuggestedCategories();
}

async function loadTransactions() {
  const { transactions } = await apiGet(`/transactions?month=${encodeURIComponent(state.month)}`);
  state.transactions = transactions;
  renderTransactions();
}

async function loadSummary() {
  const s = await apiGet(`/summary?month=${encodeURIComponent(state.month)}`);

  const empty = (s.total_income || 0) === 0 && (s.total_expenses || 0) === 0;
  document.querySelector(".chartWrap").classList.toggle("empty", empty);

  $("#kpiIncome").textContent = fmtKsh(s.total_income);
  $("#kpiExpenses").textContent = fmtKsh(s.total_expenses);
  $("#kpiBalance").textContent = fmtKsh(s.balance);

  if (s.highest_spend) {
    $("#kpiTop").textContent = `${s.highest_spend.name}`;
    $("#kpiTopSub").textContent = `${fmtKsh(s.highest_spend.amount)} (highest expense)`;
  } else {
    $("#kpiTop").textContent = "—";
    $("#kpiTopSub").textContent = "No expense data yet";
  }

  renderBreakdown(s.breakdown);
  renderTopSpend(s.top_expenses || []);
  renderChart(s);

  // ===== Savings Goal UI =====
  const goal = Number(s.savings_goal || 0);
  const income = Number(s.total_income || 0);
  const expenses = Number(s.total_expenses || 0);
  const balance = Number(s.balance || 0);

  $("#goalInput").value = goal ? goal : "";
  $("#goalKpi").textContent = fmtKsh(balance);

  // Progress: only count positive savings toward goal
  const pct = (goal > 0 && balance > 0) ? Math.min(100, Math.round((balance / goal) * 100)) : 0;
  $("#goalBar").style.width = pct + "%";

  if (goal <= 0) {
    $("#goalStatus").textContent = "No goal";
    $("#goalStatus").className = "chip chipTeal";
    $("#goalSub").textContent = "Set a goal for this month";
  } else {
    const diff = balance - goal;
    if (diff >= 0) {
      $("#goalStatus").textContent = `Over by ${fmtKsh(diff)}`;
      $("#goalStatus").className = "chip chipGreen";
      $("#goalSub").textContent = `${pct}% of goal reached`;
    } else {
      $("#goalStatus").textContent = `Under by ${fmtKsh(Math.abs(diff))}`;
      $("#goalStatus").className = "chip chipPink";
      $("#goalSub").textContent = `${pct}% of goal reached`;
    }
  }

  // Overspending alert
  const alertEl = $("#overspendAlert");
  if (expenses > income && (income > 0 || expenses > 0)) {
    alertEl.hidden = false;
    alertEl.textContent = `Overspending alert: You spent ${fmtKsh(expenses - income)} more than you earned this month.`;
  } else {
    alertEl.hidden = true;
    alertEl.textContent = "";
  }
}

function renderBreakdown(breakdown) {
  const el = $("#breakdownList");
  if (!breakdown.length) {
    el.innerHTML = `<div class="small">No data yet for this month.</div>`;
    return;
  }
  el.innerHTML = breakdown.map(b => {
    const chip = b.type === "income" ? "chipGreen" : "chipPink";
    return `
      <div class="item">
        <div class="itemLeft">
          <div class="itemTitle">${b.name}</div>
          <div class="itemSub"><span class="chip ${chip}">${b.type.toUpperCase()}</span></div>
        </div>
        <div class="itemAmt" style="color:${b.color}">${fmtKsh(b.amount)}</div>
      </div>
    `;
  }).join("");
}

// ===== Breakdown Modal with Expense Pie Chart =====
// When implementing renderBreakdownModal(), use this chart configuration:
// (Make sure to add a canvas element with id="expensePie" in the modal HTML)
//
// let expensePieChart = null; // declare at top of file or in state
//
// function renderBreakdownModal() {
//   const expenseData = expenseTotalsByCategory(state.month);
//   const total = expenseData.reduce((sum, item) => sum + item.total, 0);
//   const labels = expenseData.map(item => item.name);
//   const data = expenseData.map(item => item.total);
//   const bg = expenseData.map(item => item.color);
//
//   if (expensePieChart) expensePieChart.destroy();
//
//   expensePieChart = new Chart($("#expensePie"), {
//     type: "doughnut",
//     data: {
//       labels,
//       datasets: [{
//         data,
//         backgroundColor: bg,
//         borderWidth: 0
//       }]
//     },
//     options: {
//       responsive: true,
//       maintainAspectRatio: false,
//       cutout: "70%",
//       radius: "92%",
//       spacing: 3,
//       // IMPORTANT: so outside labels don't get clipped
//       layout: { padding: { top: 20, bottom: 20, left: 120, right: 120 } },
//       plugins: {
//         legend: { display: false },
//         tooltip: {
//           callbacks: {
//             label: (ctx) => {
//               const v = ctx.raw || 0;
//               const pct = total ? Math.round((v / total) * 100) : 0;
//               return `${ctx.label}: ${fmtKsh(v)} (${pct}%)`;
//             }
//           }
//         },
//         // ✅ outside labels ON (smart for many categories)
//         outsideLabels: {
//           enabled: true,
//           mode: "both",      // label + amount + %
//           minPercent: 5,     // hide tiny slices (change to 3 if you want more)
//           fontSize: 11,
//           lineColor: "rgba(191,195,230,.35)",
//           padding: 10,
//           lineLen: 18,
//           elbowLen: 18
//         }
//       },
//       animation: { duration: 650 }
//     },
//     // ✅ attach plugin
//     plugins: [outsideLabelsPlugin]
//   });
// }

function renderTopSpend(top) {
  const el = $("#topSpendList");
  if (!el) return;

  if (!top || top.length === 0) {
    el.innerHTML = `<div class="small">No expense data yet.</div>`;
    return;
  }

  el.innerHTML = top.map((x, i) => `
    <div class="item">
      <div class="itemRow">
        <div class="rank">${i + 1}</div>
        <div class="dot" style="background:${x.color}"></div>
        <div class="itemLeft">
          <div class="itemTitle">${x.name}</div>
          <div class="itemSub">Top expense category</div>
        </div>
      </div>
      <div class="itemAmt" style="color:${x.color}">${fmtKsh(x.amount)}</div>
    </div>
  `).join("");
}

async function loadRecurring() {
  const { recurring } = await apiGet("/recurring");
  state.recurringTemplates = recurring || [];
}

function renderRecurringCategoryOptions() {
  const sel = $("#recCat");
  if (!sel) return;
  sel.innerHTML = (state.categories || []).map(c =>
    `<option value="${c.id}">${c.name} (${c.type})</option>`
  ).join("");
}

const SUGGEST_CATS = [
  { name:"Rent", type:"expense", color:"#E82888" },
  { name:"Groceries", type:"expense", color:"#F0A810" },
  { name:"Transport", type:"expense", color:"#7028F8" },
  { name:"Bills", type:"expense", color:"#58D8B0" },
  { name:"Entertainment", type:"expense", color:"#E82888" },
  { name:"Savings", type:"income", color:"#08F850" },
  { name:"Salary", type:"income", color:"#08F850" },
];

function norm(s){ return String(s || "").trim().toLowerCase(); }

function renderSuggestedCategories() {
  const el = $("#suggestCatRow");
  if (!el) return;

  const cats = state.categories || [];

  el.innerHTML = SUGGEST_CATS.map(s => {
    const already = cats.some(c => norm(c.name) === norm(s.name) && c.type === s.type);

    return `
      <button class="suggestBtn"
        ${already ? "disabled" : ""}
        data-suggest-cat='${JSON.stringify(s).replaceAll("'", "&apos;")}'>
        + ${s.name} ${already ? `<span class="addedTag">Added</span>` : ""}
      </button>
    `;
  }).join("");
}

async function ensureCategoryByNameType(name, type, color) {
  const found = (state.categories || []).find(c =>
    c.name.toLowerCase() === name.toLowerCase() && c.type === type
  );
  if (found) return found.id;

  const res = await apiSend("/categories", "POST", { name, type, color });
  await loadCategories();
  renderRecurringCategoryOptions();
  return res.id;
}

function renderSuggestedRecurring() {
  const el = $("#suggestRecRow");
  if (!el) return;

  const suggestions = [
    { label:"Salary (25th)", cat:"Salary", type:"income", day:25, color:"#08F850", note:"Salary" },
    { label:"Rent (1st)", cat:"Rent", type:"expense", day:1, color:"#E82888", note:"Rent" },
    { label:"Internet (5th)", cat:"Bills", type:"expense", day:5, color:"#58D8B0", note:"Internet" },
    { label:"Subscription (10th)", cat:"Entertainment", type:"expense", day:10, color:"#7028F8", note:"Subscription" },
  ];

  el.innerHTML = suggestions.map(s =>
    `<button class="suggestBtn" data-suggest-rec='${JSON.stringify(s).replaceAll("'", "&apos;")}'>
      ${s.label}
    </button>`
  ).join("");
}

function renderRecurringList() {
  const el = $("#recurringList");
  if (!el) return;

  if (!state.recurringTemplates.length) {
    el.innerHTML = `<div class="small">No recurring templates yet. Use Suggested Recurring above.</div>`;
    return;
  }

  el.innerHTML = state.recurringTemplates.map(r => {
    const tag = Number(r.variable) === 1 ? '<span class="chip chipPink">VARIABLE</span>' : '<span class="chip chipGreen">FIXED</span>';
    return `
    <div class="item">
      <div class="recRow">
        <div class="recLeft">
          <div class="itemTitle">
            ${r.category_name} <span style="color:${r.category_color}">●</span>
            ${r.enabled ? '<span class="chip chipGreen">ON</span>' : '<span class="chip chipPink">OFF</span>'} ${tag}
          </div>
          <div class="itemSub">
            ${Number(r.variable) === 1 ? "Variable amount" : fmtKsh(r.amount)} • Day ${r.day_of_month} • ${r.note || "Recurring"}
          </div>
        </div>

        <div class="recRight">
          <label class="checkRow" style="gap:8px;">
            <input type="checkbox" data-rec-toggle="${r.id}" ${r.enabled ? "checked" : ""}>
            <span class="small" style="margin:0;">Enabled</span>
          </label>
          <button class="btn btnGhost btnSmall" data-rec-del="${r.id}">Del</button>
        </div>
      </div>
    </div>
    `;
  }).join("");
}

function renderApplyRecurringHint() {
  const el = $("#applyRecurringHint");
  if (!el) return;

  const enabled = (state.recurringTemplates || []).filter(r => r.enabled);
  if (!enabled.length) {
    el.textContent = "No templates yet. Go to Categories → Recurring and add Salary/Rent/Subscriptions.";
    return;
  }
  const preview = enabled.slice(0,3).map(r => {
    const amt = Number(r.variable) === 1 ? "variable" : fmtKsh(r.amount);
    return `${r.category_name} (${amt})`;
  }).join(", ");
  const more = enabled.length > 3 ? ` +${enabled.length - 3} more` : "";
  el.textContent = `Will add: ${preview}${more}`;
}

function resetRecApplySelected() {
  // default: all enabled templates selected
  state.recApplySelected = {};
  for (const r of (state.recurringTemplates || [])) {
    if (r.enabled) state.recApplySelected[r.id] = true;
  }
}

function isRecSelected(id) {
  // default true if missing
  if (state.recApplySelected[id] === undefined) return true;
  return !!state.recApplySelected[id];
}

function setAllVisibleRecSelected(val) {
  // affects only currently rendered (filtered) items
  document.querySelectorAll("#applyRecurringList [data-rec-sel]").forEach(cb => {
    const id = Number(cb.getAttribute("data-rec-sel"));
    state.recApplySelected[id] = val;
    cb.checked = val;
  });
  renderApplyRecurringHint();
}

function setRecApplyFilter(mode){
  state.recApplyFilter = mode;

  $("#recFilterAll")?.classList.toggle("active", mode === "all");
  $("#recFilterIncome")?.classList.toggle("active", mode === "income");
  $("#recFilterExpense")?.classList.toggle("active", mode === "expense");

  renderApplyRecurringList();
}

function renderApplyRecurringList() {
  const box = $("#applyRecurringBox");
  const el = $("#applyRecurringList");
  if (!box || !el) return;

  let enabled = (state.recurringTemplates || []).filter(r => r.enabled);

  if (state.recApplyFilter === "income") {
    enabled = enabled.filter(r => r.category_type === "income");
  } else if (state.recApplyFilter === "expense") {
    enabled = enabled.filter(r => r.category_type === "expense");
  }

  const show = $("#applyRecurringCheck")?.checked;

  box.style.display = show ? "block" : "none";
  if (!show) return;

  if (!enabled.length) {
    el.innerHTML = `<div class="small">No templates for this filter.</div>`;
    return;
  }

  // If selection map is empty (first time), default to selected
  for (const r of enabled) {
    if (state.recApplySelected[r.id] === undefined) state.recApplySelected[r.id] = true;
  }

  el.innerHTML = enabled.map(r => {
    const isVar = Number(r.variable) === 1;
    const val = (!isVar && Number(r.amount) > 0) ? Number(r.amount) : "";
    const tag = isVar ? `<span class="chip chipPink">VARIABLE</span>` : `<span class="chip chipGreen">FIXED</span>`;
    const selected = isRecSelected(r.id);

    return `
      <div class="item">
        <div class="applyRecRow">
          <div class="applyRecLeft applyRecPick">
            <input type="checkbox" data-rec-sel="${r.id}" ${selected ? "checked" : ""}>
            <div style="min-width:0;">
              <div class="itemTitle">${r.category_name} ${tag}</div>
              <div class="itemSub">Day ${r.day_of_month} • ${r.note || "Recurring"}</div>
            </div>
          </div>

          <div class="applyRecRight">
            <input id="applyRecAmt-${r.id}" class="input applyRecAmt" type="number" min="0" step="1"
              value="${val}" placeholder="${isVar ? "Enter amount" : "Amount"}" />
          </div>
        </div>
      </div>
    `;
  }).join("");
}

function renderChart(summary) {
  const ctx = $("#mainChart");
  const chartWrap = ctx.closest(".chartWrap");
  const income = summary.total_income || 0;
  const expenses = summary.total_expenses || 0;

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  // Set data attribute for CSS styling
  if (chartWrap) {
    chartWrap.setAttribute("data-chart-mode", state.chartMode);
  }

  const isPie = state.chartMode === "pie";

  // Dataset config - different borders for doughnut vs bar
  const data = {
    labels: ["Income", "Expenses"],
    datasets: [{
      data: [income, expenses],
      backgroundColor: ["#08F850", "#E82888"],
      borderColor: isPie ? undefined : ["rgba(8,248,80,.6)", "rgba(232,40,136,.6)"],
      borderWidth: isPie ? 0 : 2,
      spacing: isPie ? 3 : 0 // spacing between slices for doughnut
    }]
  };

  if (isPie) {
    // Premium doughnut chart options with outside labels
    const labels = ["Income", "Expenses"];
    const values = [income, expenses];
    const colors = ["rgba(8,248,80,.95)", "rgba(232,40,136,.95)"];

    const doughnutOpts = {
      responsive: true,
      maintainAspectRatio: false, // ✅ allow CSS square to control size
      devicePixelRatio: window.devicePixelRatio || 1,
      cutout: "72%", // bigger hole = thinner ring
      radius: "92%", // a bit smaller so it breathes
      spacing: 3, // spacing between slices

      // IMPORTANT: extra padding so labels don't get clipped
      layout: {
        padding: { top: 20, bottom: 20, left: 90, right: 90 }
      },

      plugins: {
        legend: { display: false }, // hide legend since we have breakdown list
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const total = values.reduce((a, b) => a + (b || 0), 0) || 0;
              const v = ctx.raw || 0;
              const pct = total ? Math.round((v / total) * 100) : 0;
              return `${ctx.label}: ${fmtKsh(v)} (${pct}%)`;
            }
          }
        },
        // ✅ outside labels ON for Income vs Expenses (2 slices)
        outsideLabels: {
          enabled: true,
          mode: "both",      // label + value + percent
          minPercent: 0,     // show both labels always (only 2 slices)
          fontSize: 12,
          lineColor: "rgba(191,195,230,.35)",
          padding: 10,
          lineLen: 18,
          elbowLen: 18
        }
      },
      animation: { duration: 650 }
    };

    // Update data to use variables
    const doughnutData = {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: 0
      }]
    };

    state.chart = new Chart(ctx, {
      type: "doughnut",
      data: doughnutData,
      options: doughnutOpts,
      plugins: [outsideLabelsPlugin] // ✅ attach plugin here
    });
  } else {
    // Bar chart options
    const barOpts = {
      responsive: true,
      maintainAspectRatio: true,
      devicePixelRatio: window.devicePixelRatio || 1,
      plugins: {
        legend: { labels: { color: "#F8F8F8", boxWidth: 14, font: { size: 12 } } },
        tooltip: {
          callbacks: { label: (c) => `${c.label}: ${fmtKsh(c.raw)}` }
        }
      },
      scales: {
        x: { ticks: { color: "#BFC3E6" }, grid: { color: "rgba(191,195,230,.12)" } },
        y: { ticks: { color: "#BFC3E6" }, grid: { color: "rgba(191,195,230,.12)" } },
      }
    };

    state.chart = new Chart(ctx, {
      type: "bar",
      data,
      options: barOpts
    });
  }
}

function renderTransactions() {
  const el = $("#txList");
  const filter = state.filter;

  const tx = state.transactions.filter(t => {
    if (filter === "all") return true;
    return t.category_type === filter;
  });

  if (!tx.length) {
    el.innerHTML = `<div class="small">No transactions yet for ${state.month}. Tap “+ Add”.</div>`;
    return;
  }

  el.innerHTML = tx.map(t => {
    const isIncome = t.category_type === "income";
    const amtColor = isIncome ? "#08F850" : "#E82888";
    const sign = isIncome ? "+" : "-";
    return `
      <div class="item">
        <div class="itemLeft">
          <div class="itemTitle">${t.category_name} <span style="color:${t.category_color}">●</span></div>
          <div class="itemSub">${t.tdate}${t.note ? ` • ${escapeHtml(t.note)}` : ""}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <div class="itemAmt" style="color:${amtColor}">${sign}${fmtKsh(t.amount)}</div>
          <button class="btn btnGhost btnSmall" data-del="${t.id}">Del</button>
        </div>
      </div>
    `;
  }).join("");

  $$("button[data-del]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-del");
      const ok = await confirmDialog({
        title: "Delete transaction",
        message: "This will permanently remove this transaction.",
        okText: "Delete",
        danger: true
      });
      if (!ok) return;
      try {
        await apiSend(`/transactions/${id}`, "DELETE");
        await refreshMonth();
        toast("Transaction deleted", "ok");
      } catch (e) {
        toast(e?.message || "Request failed", "err");
      }
    });
  });
}

function renderCategories() {
  const el = $("#catList");
  if (!state.categories.length) {
    el.innerHTML = `<div class="small">No categories yet.</div>`;
    return;
  }

  el.innerHTML = state.categories.map(c => {
    const chip = c.type === "income" ? "chipGreen" : "chipPink";
    return `
      <div class="item">
        <div class="itemLeft">
          <div class="itemTitle">${c.name} <span style="color:${c.color}">●</span></div>
          <div class="itemSub"><span class="chip ${chip}">${c.type.toUpperCase()}</span></div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <button class="btn btnGhost btnSmall" data-catdel="${c.id}">Del</button>
        </div>
      </div>
    `;
  }).join("");

  $$("button[data-catdel]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-catdel");
      const ok = await confirmDialog({
        title: "Delete category",
        message: "This will permanently remove this category. The category must have no transactions.",
        okText: "Delete",
        danger: true
      });
      if (!ok) return;
      try {
        await apiSend(`/categories/${id}`, "DELETE");
        await loadCategories();
        renderTxCategoryOptions();
        toast("Category deleted", "ok");
      } catch (e) {
        toast(e?.message || "Request failed", "err");
      }
    });
  });
}

function renderTxCategoryOptions() {
  const sel = $("#txCategory");
  const opts = state.categories.map(c => {
    const label = `${c.name} (${c.type})`;
    return `<option value="${c.id}">${label}</option>`;
  }).join("");
  sel.innerHTML = opts;
}

function showTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  $$(".panel").forEach(p => p.classList.toggle("show", p.id === name));
}

function openModal() { $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }

function openMonthModal() {
  $("#monthModal").classList.remove("hidden");

  const mk = $("#monthInput").value || monthKeyNow();
  const pm = prevMonthKey(mk);

  $("#copyBudgetsCheck").checked = true;
  $("#copyBudgetsHint").style.display = "block";
  $("#copyBudgetsHint").textContent = `Will copy budgets from ${pm} → ${mk} (if they exist).`;

  resetRecApplySelected();
  setRecApplyFilter("all");
  renderApplyRecurringList();
  renderApplyRecurringHint();
}
function closeMonthModal() { $("#monthModal").classList.add("hidden"); }

function openDeleteMonthModal(){
  const mk = state.month || "";
  $("#delMonthLabel").textContent = mk || "—";
  $("#delMonthNeed").textContent = mk || "—";

  const input = $("#delMonthInput");
  input.value = "";
  input.placeholder = mk || "YYYY-MM";

  // disable confirm by default
  const btn = $("#confirmDeleteMonth");
  btn.disabled = true;
  btn.style.opacity = ".55";
  btn.style.pointerEvents = "none";

  $("#deleteMonthModal").classList.remove("hidden");
  setTimeout(() => input.focus(), 0);
}

function closeDeleteMonthModal(){
  $("#deleteMonthModal").classList.add("hidden");
  $("#delMonthInput").value = "";
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function refreshMonth() {
  await loadTransactions();
  await loadBudgets();
  await loadSummary();

  // these depend on transactions + budgets + categories
  renderBudgets();
  renderBudgetAlerts();
}

function wireUI() {
  $$(".tab").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

  $("#monthPicker").addEventListener("change", async (e) => {
    const v = e.target.value;

    // If user chooses "+ Add new month…"
    if (v === ADD_MONTH_VALUE) {
      // revert dropdown to current month so it doesn't stay on the special option
      e.target.value = state.month || "";
      $("#monthInput").value = state.month || monthKeyNow();
      openMonthModal();
      return;
    }

    // Normal month switch
    state.month = v;
    await refreshMonth();
  });

  $("#pieBtn").addEventListener("click", async () => {
    state.chartMode = "pie";
    $("#pieBtn").classList.add("btnActive");
    $("#barBtn").classList.remove("btnActive");
    await loadSummary();
  });

  $("#barBtn").addEventListener("click", async () => {
    state.chartMode = "bar";
    $("#barBtn").classList.add("btnActive");
    $("#pieBtn").classList.remove("btnActive");
    await loadSummary();
  });

  $$(".pill").forEach(p => {
    p.addEventListener("click", () => {
      $$(".pill").forEach(x => x.classList.remove("active"));
      p.classList.add("active");
      state.filter = p.dataset.filter;
      renderTransactions();
    });
  });

  $("#addTxBtn").addEventListener("click", () => {
    $("#txDate").value = dateToday();
    openModal();
  });

  $("#quickIncomeBtn").addEventListener("click", () => {
    showTab("transactions");
    $("#txDate").value = dateToday();
    openModal();
  });

  $("#quickExpenseBtn").addEventListener("click", () => {
    showTab("transactions");
    $("#txDate").value = dateToday();
    openModal();
  });

  $("#closeModal").addEventListener("click", closeModal);

  $("#modal").addEventListener("click", (e) => {
    if (e.target.id === "modal") closeModal();
  });

  $("#closeMonthModal").addEventListener("click", closeMonthModal);

  $("#monthModal").addEventListener("click", (e) => {
    if (e.target.id === "monthModal") closeMonthModal();
  });

  $("#monthForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    // <input type="month"> gives "YYYY-MM"
    const mk = $("#monthInput").value;
    if (!mk) return;

    try {
      await ensureMonth(mk);

      if ($("#copyBudgetsCheck").checked) {
        const from = prevMonthKey(mk);
        try {
          await apiSend("/budgets/copy", "POST", { from_month: from, to_month: mk });
        } catch (e) {
          // If no budgets exist in from-month, it's not a fatal error. Keep it soft.
          console.warn("Budget copy skipped:", e.message);
        }
      }

      if ($("#applyRecurringCheck")?.checked) {
        let enabled = (state.recurringTemplates || []).filter(r => r.enabled);

        // respect filter (all/income/expense)
        if (state.recApplyFilter === "income") enabled = enabled.filter(r => r.category_type === "income");
        if (state.recApplyFilter === "expense") enabled = enabled.filter(r => r.category_type === "expense");

        // respect checkboxes
        enabled = enabled.filter(r => isRecSelected(r.id));

        if (enabled.length === 0) {
          // nothing selected → skip applying
        } else {
          const overrides = {};

          for (const r of enabled) {
            const raw = $(`#applyRecAmt-${r.id}`).value;
            const amt = Number(raw || 0);

            // Variable requires an entered amount
            if (Number(r.variable) === 1 && amt <= 0) {
              toast(`Enter an amount for: ${r.category_name} (variable recurring)`, "warn");
              return;
            }

            if (amt > 0) overrides[r.id] = Math.floor(amt);
          }

          await apiSend("/recurring/apply", "POST", { month_key: mk, overrides });
        }
      }

      await loadMonths();
      $("#monthPicker").value = mk;
      state.month = mk;
      closeMonthModal();
      await refreshMonth();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#monthInput").addEventListener("input", () => {
    const mk = $("#monthInput").value;
    if (!mk) return;
    const pm = prevMonthKey(mk);
    $("#copyBudgetsHint").style.display = $("#copyBudgetsCheck").checked ? "block" : "none";
    $("#copyBudgetsHint").textContent = `Will copy budgets from ${pm} → ${mk} (if they exist).`;
  });

  $("#copyBudgetsCheck").addEventListener("change", () => {
    const mk = $("#monthInput").value;
    if (!mk) return;
    const pm = prevMonthKey(mk);
    $("#copyBudgetsHint").style.display = $("#copyBudgetsCheck").checked ? "block" : "none";
    $("#copyBudgetsHint").textContent = `Will copy budgets from ${pm} → ${mk} (if they exist).`;
  });

  $("#applyRecurringCheck").addEventListener("change", renderApplyRecurringList);

  $("#recFilterAll").addEventListener("click", () => setRecApplyFilter("all"));
  $("#recFilterIncome").addEventListener("click", () => setRecApplyFilter("income"));
  $("#recFilterExpense").addEventListener("click", () => setRecApplyFilter("expense"));

  // checkbox toggle (event delegation)
  document.addEventListener("change", (e) => {
    const id = e.target?.getAttribute?.("data-rec-sel");
    if (!id) return;
    state.recApplySelected[Number(id)] = e.target.checked;
    renderApplyRecurringHint();
  });

  // Select all / clear (only visible list)
  $("#recSelectAll").addEventListener("click", () => setAllVisibleRecSelected(true));
  $("#recSelectNone").addEventListener("click", () => setAllVisibleRecSelected(false));

  $("#closeDeleteMonthModal").addEventListener("click", closeDeleteMonthModal);

  $("#deleteMonthModal").addEventListener("click", (e) => {
    if (e.target.id === "deleteMonthModal") closeDeleteMonthModal();
  });

  $("#cancelDeleteMonth").addEventListener("click", closeDeleteMonthModal);

  $("#delMonthInput").addEventListener("input", (e) => {
    const typed = (e.target.value || "").trim();
    const mk = state.month || "";

    const btn = $("#confirmDeleteMonth");
    const ok = typed === mk;

    btn.disabled = !ok;
    btn.style.opacity = ok ? "1" : ".55";
    btn.style.pointerEvents = ok ? "auto" : "none";
  });

  $("#confirmDeleteMonth").addEventListener("click", async () => {
    const mk = state.month;
    if (!mk) return;

    try {
      // TODO: Add API endpoint for deleting month
      // await apiSend(`/months/${mk}`, "DELETE");
      toast("Delete month functionality not yet implemented in API", "warn");
      closeDeleteMonthModal();
      // await loadMonths();
      // await refreshMonth();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#txForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      month_key: state.month,
      category_id: Number($("#txCategory").value),
      amount: Number($("#txAmount").value),
      date: $("#txDate").value,
      note: $("#txNote").value || ""
    };
    try {
      await apiSend("/transactions", "POST", payload);
      $("#txAmount").value = "";
      $("#txNote").value = "";
      closeModal();
      await refreshMonth();
      showTab("transactions");
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#catForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      name: $("#catName").value.trim(),
      type: $("#catType").value,
      color: $("#catColor").value
    };
    try {
      await apiSend("/categories", "POST", payload);
      $("#catName").value = "";
      await loadCategories();
      renderTxCategoryOptions();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  $("#saveGoalBtn").addEventListener("click", async () => {
    const goal = Number($("#goalInput").value || 0);
    if (goal < 0) return toast("Goal must be 0 or more.", "warn");

    try {
      await apiSend("/goal", "POST", { month_key: state.month, savings_goal: Math.floor(goal) });
      await refreshMonth();
    } catch (e) {
      toast(e.message, "err");
    }
  });

  // Suggested categories click
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest?.("[data-suggest-cat]");
    if (!btn) return;

    if (btn.disabled) return; // ✅ do nothing if already added

    const s = JSON.parse(btn.getAttribute("data-suggest-cat"));

    try {
      await ensureCategoryByNameType(s.name, s.type, s.color);
      await loadCategories(); // ensures UI refresh
      toast(`Added category: ${s.name}`, "ok");
    } catch (err) {
      toast(err?.message || "Failed to add category", "err");
    }
  });

  // Suggested recurring click (prefill form)
  document.addEventListener("click", async (e) => {
    const raw = e.target?.getAttribute?.("data-suggest-rec");
    if (!raw) return;

    const s = JSON.parse(raw);
    try {
      const catId = await ensureCategoryByNameType(s.cat, s.type, s.color);
      $("#recCat").value = String(catId);
      $("#recDay").value = String(s.day);
      $("#recNote").value = s.note;
      $("#recAmount").focus();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  // Add recurring template
  $("#recurringForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const variable = $("#recVariable").checked ? 1 : 0;
      const amtRaw = $("#recAmount").value;
      const amount = Number(amtRaw || 0);

      await apiSend("/recurring", "POST", {
        category_id: Number($("#recCat").value),
        amount: Math.floor(amount),
        day_of_month: Number($("#recDay").value),
        note: $("#recNote").value || "",
        enabled: 1,
        variable
      });
      $("#recAmount").value = "";
      $("#recNote").value = "";
      $("#recVariable").checked = false;
      await loadRecurring();
      renderRecurringList();
      renderApplyRecurringHint();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  // Toggle / delete recurring
  document.addEventListener("click", async (e) => {
    const delId = e.target?.getAttribute?.("data-rec-del");
    if (!delId) return;
    const ok = await confirmDialog({
      title: "Delete recurring template",
      message: "This will remove the template. It won't delete past months' transactions.",
      okText: "Delete",
      danger: true
    });
    if (!ok) return;

    try {
      await apiSend(`/recurring/${delId}`, "DELETE");
      await loadRecurring();
      renderRecurringList();
      renderApplyRecurringHint();
      toast("Recurring template deleted", "ok");
    } catch (err) {
      toast(err?.message || "Request failed", "err");
    }
  });

  document.addEventListener("change", async (e) => {
    const togId = e.target?.getAttribute?.("data-rec-toggle");
    if (!togId) return;

    try {
      await apiSend(`/recurring/${togId}`, "PUT", { enabled: e.target.checked ? 1 : 0 });
      await loadRecurring();
      renderRecurringList();
      renderApplyRecurringHint();
    } catch (err) {
      toast(err.message, "err");
    }
  });

  // Budget save/clear (event delegation)
  document.addEventListener("click", async (e) => {
    const saveId = e.target?.getAttribute?.("data-save-budget");
    const clearId = e.target?.getAttribute?.("data-clear-budget");

    if (saveId) {
      const catId = Number(saveId);
      const v = Number($(`#budget-${catId}`).value || 0);
      if (v < 0) return toast("Budget must be 0 or more.", "warn");

      try {
        await apiSend("/budgets", "POST", { month_key: state.month, category_id: catId, budget_amount: Math.floor(v) });
        await loadBudgets();
        renderBudgets();
        renderBudgetAlerts();
      } catch (err) {
        toast(err.message, "err");
      }
    }

    if (clearId) {
      const catId = Number(clearId);
      try {
        await apiSend(`/budgets?month=${encodeURIComponent(state.month)}&category_id=${catId}`, "DELETE");
        await loadBudgets();
        renderBudgets();
        renderBudgetAlerts();
      } catch (err) {
        toast(err.message, "err");
      }
    }
  });
}

async function boot() {
  wireUI();
  await loadMonths();
  await loadCategories();
  renderSuggestedCategories();
  renderSuggestedRecurring();
  renderRecurringCategoryOptions();
  await loadRecurring();
  renderRecurringList();
  renderApplyRecurringHint();
  await refreshMonth();
  showTab("dashboard");
}

boot().catch(err => toast(err.message, "err"));
