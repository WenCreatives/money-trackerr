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
};

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

async function ensureMonth(mk) {
  await apiSend("/months", "POST", { month_key: mk });
}

async function loadMonths() {
  const picker = $("#monthPicker");

  const current = monthKeyNow();
  await ensureMonth(current);

  const refreshed = await apiGet("/months");
  const list = refreshed.months.length ? refreshed.months : [current];

  picker.innerHTML = list.map(m => `<option value="${m}">${m}</option>`).join("");
  state.month = list.includes(state.month) ? state.month : current;
  picker.value = state.month;
}

async function loadCategories() {
  const { categories } = await apiGet("/categories");
  state.categories = categories;
  renderCategories();
  renderTxCategoryOptions();
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

function renderChart(summary) {
  const ctx = $("#mainChart");
  const income = summary.total_income || 0;
  const expenses = summary.total_expenses || 0;

  if (state.chart) {
    state.chart.destroy();
    state.chart = null;
  }

  const data = {
    labels: ["Income", "Expenses"],
    datasets: [{
      data: [income, expenses],
      backgroundColor: ["#08F850", "#E82888"],
      borderColor: ["rgba(8,248,80,.6)", "rgba(232,40,136,.6)"],
      borderWidth: 2
    }]
  };

  const baseOpts = {
    responsive: true,
    devicePixelRatio: window.devicePixelRatio || 1,
    plugins: {
      legend: { labels: { color: "#F8F8F8", boxWidth: 14, font: { size: 12 } } },
      tooltip: {
        callbacks: { label: (c) => `${c.label}: ${fmtKsh(c.raw)}` }
      }
    }
  };

  state.chart = new Chart(ctx, {
    type: state.chartMode === "pie" ? "doughnut" : "bar",
    data,
    options: state.chartMode === "pie" ? baseOpts : {
      ...baseOpts,
      scales: {
        x: { ticks: { color: "#BFC3E6" }, grid: { color: "rgba(191,195,230,.12)" } },
        y: { ticks: { color: "#BFC3E6" }, grid: { color: "rgba(191,195,230,.12)" } },
      }
    }
  });
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
      if (!confirm("Delete this transaction?")) return;
      try {
        await apiSend(`/transactions/${id}`, "DELETE");
        await refreshMonth();
      } catch (e) {
        alert(e.message);
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
      if (!confirm("Delete this category? (Must have no transactions)")) return;
      try {
        await apiSend(`/categories/${id}`, "DELETE");
        await loadCategories();
        renderTxCategoryOptions();
      } catch (e) {
        alert(e.message);
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

function escapeHtml(str) {
  return String(str)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

async function refreshMonth() {
  await loadSummary();
  await loadTransactions();
}

function wireUI() {
  $$(".tab").forEach(btn => btn.addEventListener("click", () => showTab(btn.dataset.tab)));

  $("#monthPicker").addEventListener("change", async (e) => {
    state.month = e.target.value;
    await refreshMonth();
  });

  $("#addMonthBtn").addEventListener("click", async () => {
    const mk = prompt("Enter month (YYYY-MM):", monthKeyNow());
    if (!mk) return;
    try {
      await ensureMonth(mk.trim());
      await loadMonths();
      $("#monthPicker").value = mk.trim();
      state.month = mk.trim();
      await refreshMonth();
    } catch (e) {
      alert(e.message);
    }
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
      alert(err.message);
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
      alert(err.message);
    }
  });

  $("#saveGoalBtn").addEventListener("click", async () => {
    const goal = Number($("#goalInput").value || 0);
    if (goal < 0) return alert("Goal must be 0 or more.");

    try {
      await apiSend("/goal", "POST", { month_key: state.month, savings_goal: Math.floor(goal) });
      await refreshMonth();
    } catch (e) {
      alert(e.message);
    }
  });
}

async function boot() {
  wireUI();
  await loadMonths();
  await loadCategories();
  await refreshMonth();
  showTab("dashboard");
}

boot().catch(err => alert(err.message));
