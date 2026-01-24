// --- IndexedDB simple storage (offline-first) ---
const IDB_NAME = "moneyTrackerDB";
const IDB_STORE = "kv";

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openIDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// --- User-scoped offline storage keys (guest vs logged-in) ---
let currentUserId = null;

// Create Supabase client if available (graceful fallback if keys not set)
let supabase = null;
if (window.supabase?.createClient && window.SUPABASE_URL && window.SUPABASE_ANON_KEY) {
  try {
    supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  } catch (e) {
    console.warn("Supabase client creation failed:", e);
  }
}

async function getUserId() {
  try {
    if (supabase) {
      const { data } = await supabase.auth.getSession();
      return data?.session?.user?.id || null;
    }
  } catch {
    return null;
  }
  return null;
}

function kUser(prefix) {
  return currentUserId ? `${prefix}:user:${currentUserId}` : `${prefix}:guest`;
}

// Cached datasets
const K_MONTHS = () => kUser("cache:months");
const K_CATEGORIES = () => kUser("cache:categories");
const K_TX = (m) => kUser(`cache:tx:${m}`);
const K_SUMMARY = (m) => kUser(`cache:summary:${m}`);
const K_BUDGETS = (m) => kUser(`cache:budgets:${m}`);
const K_RECURRING = () => kUser("cache:recurring");
const K_TRENDS = (n) => kUser(`cache:trends:${n}`);

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
  editTxId: null,
  undoTx: null,
  trends: [],
  trendMode: "ie", // "ie" or "bal"
};

let trendChart = null;
let comparePieChart = null;
let compareBarChart = null;
let breakdownPieChart = null;
let breakdownBarChart = null;

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

function toastAction(message, type, title, actionText, onAction, ms = 4500) {
  const host = document.getElementById("toastHost");
  if (!host) return;

  const t = document.createElement("div");
  t.className = `toast ${type || "ok"}`;

  t.innerHTML = `
    <div class="toastTitle">${title || "Done"}</div>
    <div class="toastMsg">${String(message)}</div>
    <div class="toastActionRow">
      <button class="toastBtn" type="button">${actionText || "Undo"}</button>
    </div>
  `;

  host.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));

  const btn = t.querySelector("button");
  const kill = () => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 200);
  };

  btn.addEventListener("click", () => {
    try { onAction?.(); } finally { kill(); }
  });

  setTimeout(kill, ms);
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

function isMobile(){
  return window.matchMedia("(max-width: 900px)").matches;
}

function isTypingTarget(el){
  if (!el) return false;
  const tag = (el.tagName || "").toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

function closeAnyOpenModal(){
  // Close the top-most known modal (adjust ids if yours differ)
  const ids = ["compareModal","confirmModal","breakdownModal","deleteMonthModal","monthModal","modal"];
  for (const id of ids){
    const m = document.getElementById(id);
    if (m && !m.classList.contains("hidden")){
      // try dedicated closers if they exist
      if (id === "compareModal") {
        m.classList.add("hidden");
        m.setAttribute("aria-hidden", "true");
        if(comparePieChart) { comparePieChart.destroy(); comparePieChart = null; }
        if(compareBarChart) { compareBarChart.destroy(); compareBarChart = null; }
        return;
      }
      if (id === "breakdownModal" && typeof closeBreakdownModal === "function") return closeBreakdownModal();
      if (id === "deleteMonthModal" && typeof closeDeleteMonthModal === "function") return closeDeleteMonthModal();
      if (id === "monthModal" && typeof closeMonthModal === "function") return closeMonthModal();
      if (id === "modal" && typeof closeModal === "function") return closeModal();
      // fallback
      m.classList.add("hidden");
      return;
    }
  }
}

function openAddTransaction(){
  if (typeof openTxModalForAdd === "function") return openTxModalForAdd();
  if (typeof openModal === "function") return openModal(); // fallback
  const btn = document.getElementById("addTxBtn");
  if (btn) btn.click();
}

function numFromAny(x){
  return Number(String(x ?? "").replace(/[^\d.-]/g, "")) || 0;
}

function startInlineNumberEdit(targetEl, { getValue, onSave, formatDisplay, placeholderText }) {
  if (!targetEl) return;
  if (targetEl.dataset.editing === "1") return;

  targetEl.dataset.editing = "1";

  const oldValue = Number(getValue());
  const oldText = targetEl.textContent;

  const input = document.createElement("input");
  input.type = "number";
  input.min = "0";
  input.step = "1";
  input.className = "inlineInput";
  input.value = String(Math.max(0, Math.floor(oldValue)));
  input.placeholder = placeholderText || "Enter amount";

  // replace element with input
  targetEl.replaceWith(input);
  input.focus();
  input.select();

  const restore = () => {
    const span = document.createElement("span");
    span.className = targetEl.className;
    span.dataset.inlineType = targetEl.dataset.inlineType;
    span.dataset.inlineGoal = targetEl.dataset.inlineGoal || "";
    span.dataset.inlineBudget = targetEl.dataset.inlineBudget || "";
    span.textContent = oldText;
    span.dataset.editing = "0";
    input.replaceWith(span);
  };

  const commit = async () => {
    const newVal = Math.max(0, Math.floor(Number(input.value || 0)));

    try {
      await onSave(newVal);

      const span = document.createElement("span");
      span.className = targetEl.className.replace(" inlinePlaceholder", "");
      span.dataset.inlineType = targetEl.dataset.inlineType;
      span.dataset.inlineGoal = targetEl.dataset.inlineGoal || "";
      span.dataset.inlineBudget = targetEl.dataset.inlineBudget || "";

      span.textContent = formatDisplay(newVal);
      span.dataset.editing = "0";

      input.replaceWith(span);
      toast("Saved", "ok");
    } catch (err) {
      toast(err?.message || "Save failed", "err");
      restore();
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      restore();
    }
  });

  // Blur: cancel (to match your "Enter saves" request)
  input.addEventListener("blur", () => restore());
}

function isOnline() {
  return navigator.onLine;
}

async function apiGet(path) {
  // If offline, throw so loaders fall back to IndexedDB
  if (!isOnline()) throw new Error("offline");
  const res = await fetch(API(path));
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

async function apiSend(path, method, payload) {
  if (!isOnline()) throw new Error("offline");
  const res = await fetch(API(path), {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
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
  try {
    const res = await apiGet(`/budgets?month=${encodeURIComponent(state.month)}`);
    const { budgets } = res;
    await dbSet(K_BUDGETS(state.month), res);
    state.budgets = budgets || [];
  } catch (e) {
    const cached = await dbGet(K_BUDGETS(state.month));
    if (cached) {
      state.budgets = cached.budgets || [];
    }
  }
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
            <div class="itemSub">Spent ${fmtKsh(spent)} of
              <span
                class="inlineEdit ${budget ? "" : "inlinePlaceholder"}"
                data-inline-type="budget"
                data-inline-budget="${c.id}"
                data-value="${budget}">
                ${budget ? fmtKsh(budget) : "Set budget"}
              </span>
              • ${pctText}</div>
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

function renderBudgetSnapshot(){
  const el = document.getElementById("budgetSnapshot");
  if (!el) return;

  const expenseCats = (state.categories || []).filter(c => c.type === "expense");
  const budgetMap = getBudgetMap();           // you already have this
  const spentMap  = getExpenseSumsByCategoryId(); // you already have this

  const rows = expenseCats.map(c => {
    const budget = Number(budgetMap[c.id] || 0);
    const spent  = Number(spentMap[c.id] || 0);
    const ratio  = budget > 0 ? spent / budget : 0;
    return { ...c, budget, spent, ratio };
  }).filter(r => r.budget > 0)
    .sort((a,b) => b.ratio - a.ratio)
    .slice(0, 4);

  if (!rows.length){
    el.innerHTML = `<div class="small">Set some budgets to see progress here.</div>`;
    return;
  }

  el.innerHTML = rows.map(r => {
    const pct = Math.round(r.ratio * 100);
    const chip = r.ratio >= 1
      ? `<span class="chip badgeOver">OVER</span>`
      : r.ratio >= 0.8
        ? `<span class="chip badgeWarn">${pct}%</span>`
        : `<span class="chip chipTeal">${pct}%</span>`;

    // Helper to convert hex to rgba
    const hexToRgba = (hex, alpha) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    };

    return `
      <div class="item">
        <div class="rowBetween">
          <div class="itemLeft">
            <div class="itemTitle">${r.name} ${chip}</div>
            <div class="itemSub">Spent ${fmtKsh(r.spent)} of ${fmtKsh(r.budget)}</div>
          </div>
          <span class="dot" style="background:${r.color}"></span>
        </div>

        <div class="miniProgress" style="margin-top:12px;">
          <div class="miniBar" style="width:${Math.min(100, pct)}%; background:${hexToRgba(r.color, .9)}"></div>
        </div>
      </div>
    `;
  }).join("");
}

async function loadMonths() {
  try {
    const res = await apiGet("/months");
    const months = (res.months || []).slice().sort().reverse(); // newest first
    await dbSet(K_MONTHS(), res);
    
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
  } catch (e) {
    const cached = await dbGet(K_MONTHS());
    if (cached) {
      const months = (cached.months || []).slice().sort().reverse();
      
      const picker = $("#monthPicker");
      picker.innerHTML = "";

      months.forEach(mk => {
        const opt = document.createElement("option");
        opt.value = mk;
        opt.textContent = mk;
        picker.appendChild(opt);
      });

      const addOpt = document.createElement("option");
      addOpt.value = ADD_MONTH_VALUE;
      addOpt.textContent = "+ Add new month…";
      picker.appendChild(addOpt);

      if (!state.month && months.length) state.month = months[0];
      if (state.month && !months.includes(state.month) && months.length) {
        state.month = months[0];
      }
      if (state.month) {
        picker.value = state.month;
      } else {
        picker.value = ADD_MONTH_VALUE;
        $("#monthInput").value = monthKeyNow();
        openMonthModal();
      }
    }
  }
}

async function loadCategories() {
  try {
    const res = await apiGet("/categories");
    const { categories } = res;
    await dbSet(K_CATEGORIES(), res);
    state.categories = categories;
    renderCategories();
    renderTxCategoryOptions();
    renderRecurringCategoryOptions();
    renderSuggestedCategories();
    populateTxCategoryFilter();
  } catch (e) {
    const cached = await dbGet(K_CATEGORIES());
    if (cached) {
      const categories = cached.categories || [];
      state.categories = categories;
      renderCategories();
      renderTxCategoryOptions();
      renderRecurringCategoryOptions();
      renderSuggestedCategories();
      populateTxCategoryFilter();
    }
  }
}

async function loadTransactions() {
  try {
    const res = await apiGet(`/transactions?month=${encodeURIComponent(state.month)}`);
    const { transactions } = res;
    await dbSet(K_TX(state.month), res);
    state.transactions = transactions;
    renderTransactions();
  } catch (e) {
    const cached = await dbGet(K_TX(state.month));
    if (cached) {
      state.transactions = cached.transactions || [];
      renderTransactions();
    }
  }
}

async function loadSummary() {
  try {
    const s = await apiGet(`/summary?month=${encodeURIComponent(state.month)}`);
    await dbSet(K_SUMMARY(state.month), s);
    state.summary = s; // Store in state for breakdown charts
    
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

  // Update goal display to be inline editable
  const goalDisplayEl = $("#goalValue");
  if (goalDisplayEl) {
    goalDisplayEl.innerHTML = `
      <span
        class="inlineEdit ${goal ? "" : "inlinePlaceholder"}"
        data-inline-type="goal"
        data-value="${goal}">
        ${goal ? fmtKsh(goal) : "Set goal"}
      </span>
    `;
  }

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
  } catch (e) {
    const cached = await dbGet(K_SUMMARY(state.month));
    if (cached) {
      const s = cached;
      state.summary = s; // Store in state for breakdown charts
      const empty = (s.total_income || 0) === 0 && (s.total_expenses || 0) === 0;
      document.querySelector(".chartWrap").classList.toggle("empty", empty);

      $("#kpiIncome").textContent = fmtKsh(s.total_income || 0);
      $("#kpiExpenses").textContent = fmtKsh(s.total_expenses || 0);
      $("#kpiBalance").textContent = fmtKsh(s.balance || 0);

      if (s.highest_spend) {
        $("#kpiTop").textContent = `${s.highest_spend.name}`;
        $("#kpiTopSub").textContent = `${fmtKsh(s.highest_spend.amount)} (highest expense)`;
      } else {
        $("#kpiTop").textContent = "—";
        $("#kpiTopSub").textContent = "No expense data yet";
      }

      renderBreakdown(s.breakdown || []);
      renderTopSpend(s.top_expenses || []);
      renderChart(s);

      const goal = Number(s.savings_goal || 0);
      const income = Number(s.total_income || 0);
      const expenses = Number(s.total_expenses || 0);
      const balance = Number(s.balance || 0);

      $("#goalInput").value = goal ? goal : "";
      $("#goalKpi").textContent = fmtKsh(balance);

      const pct = (goal > 0 && balance > 0) ? Math.min(100, Math.round((balance / goal) * 100)) : 0;
      $("#goalBar").style.width = pct + "%";

      const goalDisplayEl = $("#goalValue");
      if (goalDisplayEl) {
        goalDisplayEl.innerHTML = `
          <span
            class="inlineEdit ${goal ? "" : "inlinePlaceholder"}"
            data-inline-type="goal"
            data-value="${goal}">
            ${goal ? fmtKsh(goal) : "Set goal"}
          </span>
        `;
      }

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

      const alertEl = $("#overspendAlert");
      if (expenses > income && (income > 0 || expenses > 0)) {
        alertEl.hidden = false;
        alertEl.textContent = `Overspending alert: You spent ${fmtKsh(expenses - income)} more than you earned this month.`;
      } else {
        alertEl.hidden = true;
        alertEl.textContent = "";
      }
    }
  }
}

function renderBreakdown(breakdown) {
  const el = $("#breakdownList");
  const modalEl = $("#breakdownListModal");
  
  if (!breakdown.length) {
    const emptyMsg = `<div class="small">No data yet for this month.</div>`;
    if (el) el.innerHTML = emptyMsg;
    if (modalEl) modalEl.innerHTML = emptyMsg;
    return;
  }
  
  const html = breakdown.map(b => {
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
  
  if (el) el.innerHTML = html;
  if (modalEl) modalEl.innerHTML = html;
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
  try {
    const res = await apiGet("/recurring");
    const { recurring } = res;
    await dbSet(K_RECURRING(), res);
    state.recurringTemplates = recurring || [];
  } catch (e) {
    const cached = await dbGet(K_RECURRING());
    if (cached) {
      state.recurringTemplates = cached.recurring || [];
    }
  }
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
  const emptyHint = $("#recurringEmptyHint");
  if (!box || !el) return;

  let enabled = (state.recurringTemplates || []).filter(r => r.enabled);

  if (state.recApplyFilter === "income") {
    enabled = enabled.filter(r => r.category_type === "income");
  } else if (state.recApplyFilter === "expense") {
    enabled = enabled.filter(r => r.category_type === "expense");
  }

  const show = $("#applyRecurringCheck")?.checked;
  const hasTemplates = (state.recurringTemplates || []).length > 0;

  // Show/hide recurring box and empty hint
  if (box) box.style.display = (show && hasTemplates) ? "block" : "none";
  if (emptyHint) emptyHint.style.display = (show && !hasTemplates) ? "block" : "none";
  
  if (!show || !hasTemplates) return;

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

function populateTxCategoryFilter(){
  const sel = document.getElementById("txCatFilter");
  if (!sel) return;

  const cur = sel.value || "";
  const cats = state.categories || [];

  sel.innerHTML = `<option value="">All categories</option>` + cats
    .map(c => `<option value="${c.id}">${c.name} (${c.type})</option>`)
    .join("");

  sel.value = cur;
}

function getFilteredTransactions(){
  const q = (document.getElementById("txSearch")?.value || "").trim().toLowerCase();
  const catId = Number(document.getElementById("txCatFilter")?.value || 0);
  const min = Number(document.getElementById("txMin")?.value || 0);
  const maxRaw = document.getElementById("txMax")?.value;
  const max = maxRaw === "" || maxRaw == null ? Infinity : Number(maxRaw);
  const from = document.getElementById("txFrom")?.value || "";
  const to = document.getElementById("txTo")?.value || "";

  return (state.transactions || []).filter(t => {
    if (catId && Number(t.category_id) !== catId) return false;

    const amt = Number(t.amount || 0);
    if (amt < min) return false;
    if (amt > max) return false;

    const d = t.tdate || t.date || "";
    if (from && d < from) return false;
    if (to && d > to) return false;

    if (q) {
      const hay = `${t.category_name || ""} ${t.note || ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTransactions() {
  const el = $("#txList");
  const filter = state.filter;

  // Check if there are any transactions at all (empty state)
  const hasAnyTx = (state.transactions || []).length > 0;

  if (!hasAnyTx) {
    el.innerHTML = `
      <div class="card">
        <div class="sectionTitle">No transactions yet</div>
        <div class="small">Add your first transaction to get started.</div>
        <div style="margin-top:12px;">
          <button class="btn" type="button" id="emptyAddTx">+ Add transaction</button>
        </div>
      </div>
    `;

    document.getElementById("emptyAddTx")?.addEventListener("click", openAddTransaction);
    return;
  }

  let tx = getFilteredTransactions();

  // Apply type filter (all/income/expense)
  if (filter !== "all") {
    tx = tx.filter(t => t.category_type === filter);
  }

  if (!tx.length) {
    el.innerHTML = `<div class="small">No transactions match your filters.</div>`;
    return;
  }

  el.innerHTML = tx.map(t => {
    const isIncome = t.category_type === "income";
    const amtColor = isIncome ? "#08F850" : "#E82888";
    const sign = isIncome ? "+" : "-";
    return `
      <div class="item" data-tx-open="${t.id}">
        <div class="itemLeft">
          <div class="itemTitle">${t.category_name} <span style="color:${t.category_color}">●</span></div>
          <div class="itemSub">${t.tdate}${t.note ? ` • ${escapeHtml(t.note)}` : ""}</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <div class="itemAmt" style="color:${amtColor}">${sign}${fmtKsh(t.amount)}</div>
          <button class="btn btnGhost btnSmall" data-tx-del="${t.id}" type="button">Del</button>
        </div>
      </div>
    `;
  }).join("");
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

  // Load trends when trends tab is opened
  if (name === "trends") {
    openTrends();
  }
}

function openModal() { $("#modal").classList.remove("hidden"); }
function closeModal() { $("#modal").classList.add("hidden"); }

function openTxModalForAdd() {
  state.editTxId = null;
  $("#txModalTitle").textContent = "Add Transaction";
  $("#txSubmitBtn").textContent = "Save";
  $("#txCancelEdit").style.display = "none";
  openModal(); // your existing tx modal open
}

function openTxModalForEdit(tx) {
  state.editTxId = tx.id;

  $("#txModalTitle").textContent = "Edit Transaction";
  $("#txSubmitBtn").textContent = "Save changes";
  $("#txCancelEdit").style.display = "inline-flex";

  // fill fields (adjust ids to your form inputs)
  $("#txCategory").value = String(tx.category_id);
  $("#txAmount").value = String(tx.amount);
  $("#txDate").value = tx.tdate;
  $("#txNote").value = tx.note || "";

  openModal();
}

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

async function loadTrends(n = 6){
  try {
    const res = await apiGet(`/trends?months=${n}`);
    await dbSet(K_TRENDS(n), res);
    state.trends = res.months || [];
  } catch (e) {
    const cached = await dbGet(K_TRENDS(n));
    if (cached) {
      state.trends = cached.months || [];
    }
  }
}

function renderTrends(){
  const labels = state.trends.map(r => r.month_key);
  const income = state.trends.map(r => Number(r.income || 0));
  const expenses = state.trends.map(r => Number(r.expenses || 0));
  const balance = state.trends.map((r,i) => income[i] - expenses[i]);
  const goal = state.trends.map(r => Number(r.savings_goal || 0));

  // Chart
  if (trendChart) trendChart.destroy();

  const ctx = document.getElementById("trendChart");
  if (!ctx) return;

  const isIE = state.trendMode === "ie";

  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: isIE ? [
        { label: "Income", data: income, tension: 0.25, borderColor: "rgba(8,248,80,.95)", backgroundColor: "rgba(8,248,80,.1)" },
        { label: "Expenses", data: expenses, tension: 0.25, borderColor: "rgba(232,40,136,.95)", backgroundColor: "rgba(232,40,136,.1)" }
      ] : [
        { label: "Balance", data: balance, tension: 0.25, borderColor: "rgba(112,40,248,.95)", backgroundColor: "rgba(112,40,248,.1)" },
        { label: "Savings goal", data: goal, tension: 0.25, borderColor: "rgba(240,168,16,.95)", backgroundColor: "rgba(240,168,16,.1)", borderDash: [5, 5] }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      devicePixelRatio: window.devicePixelRatio || 1,
      plugins: {
        legend: { display: true, labels: { color: "#F8F8F8" } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${fmtKsh(ctx.raw || 0)}`
          }
        }
      },
      scales: {
        x: { ticks: { color: "#BFC3E6" }, grid: { color: "rgba(191,195,230,.12)" } },
        y: { ticks: { color: "#BFC3E6" }, grid: { color: "rgba(191,195,230,.12)" } }
      }
    }
  });

  // Table
  const t = document.getElementById("trendTable");
  if (!t) return;

  t.innerHTML = state.trends.map((r, i) => {
    const bal = balance[i];
    const hitGoal = bal >= (r.savings_goal || 0) && (r.savings_goal || 0) > 0;

    const chip = (r.savings_goal || 0) === 0
      ? `<span class="chip chipPurple">No goal</span>`
      : hitGoal
        ? `<span class="chip chipGreen">Goal hit</span>`
        : `<span class="chip badgeWarn">Below goal</span>`;

    const over = expenses[i] > income[i] ? `<span class="chip badgeOver">Overspent</span>` : "";

    return `
      <div class="item trendRow" data-trend-month="${r.month_key}">
        <div class="itemLeft">
          <div class="itemTitle">${r.month_key} ${chip} ${over}</div>
          <div class="itemSub">
            Income ${fmtKsh(income[i])} • Expenses ${fmtKsh(expenses[i])} • Balance ${fmtKsh(bal)}
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function openTrends(){
  await loadTrends(12);
  renderTrends();
}

function exportTrendsCSV(){
  window.location.href = `/api/trends/export?months=12`;
  toast("Downloading trends CSV…", "ok");
}

// Demo data functionality removed - users start with clean empty app
// async function loadDemoData(){ ... }

async function exportMonthJSON(){
  const mk = state.month;
  try{
    const data = await apiGet(`/month/export?month=${encodeURIComponent(mk)}&format=json`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `money-tracker-${mk}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    toast("Exported JSON", "ok");
  }catch(err){
    toast(err?.message || "Export failed", "err");
  }
}

function exportMonthCSV(){
  const mk = state.month;
  window.location.href = `/api/month/export?month=${encodeURIComponent(mk)}&format=csv`;
  // CSV download triggers via browser, so no need for toast (file will download)
}

async function importMonthJSONFile(file){
  try{
    const text = await file.text();
    const payload = JSON.parse(text);

    // First try without overwrite
    try{
      await apiSend("/month/import", "POST", { payload, overwrite: false });
    }catch(e){
      // If server says conflict, ask for overwrite (if confirmDialog exists)
      const msg = e?.message || "";
      if (msg.includes("409") || msg.toLowerCase().includes("overwrite")) {
        if (typeof confirmDialog === "function") {
          const ok = await confirmDialog({
            title: "Overwrite month data?",
            message: `Month ${payload.month_key} already has data. Overwrite it with the imported file?`,
            okText: "Overwrite",
            danger: true
          });
          if (!ok) return;
          await apiSend("/month/import", "POST", { payload, overwrite: true });
        } else {
          toast("Month already has data. Add confirmDialog to allow overwrite, or import into a new month.", "warn");
          return;
        }
      } else {
        throw e;
      }
    }

    toast(`Imported ${payload.month_key}`, "ok");

    // Switch to imported month
    await loadMonths();
    state.month = payload.month_key;
    $("#monthPicker").value = payload.month_key;

    await refreshMonth();
  }catch(err){
    toast(err?.message || "Import failed", "err");
  }
}

async function refreshMonth() {
  await loadTransactions();
  await loadBudgets();
  await loadSummary();

  // these depend on transactions + budgets + categories
  renderBudgets();
  renderBudgetAlerts();
  renderBudgetSnapshot();
  renderTransactions();
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
    openTxModalForAdd();
  });

  // Mobile FAB opens the same Add Transaction flow
  document.getElementById("fabAddTx")?.addEventListener("click", () => {
    $("#txDate").value = dateToday();
    openTxModalForAdd();
  });

  // Toggle filters panel on mobile
  const filterBtn = document.getElementById("filterToggleBtn");
  const filtersPanel = document.getElementById("txFilters");
  filterBtn?.addEventListener("click", () => {
    filtersPanel?.classList.toggle("open");
  });

  $("#quickIncomeBtn").addEventListener("click", () => {
    showTab("transactions");
    $("#txDate").value = dateToday();
    openTxModalForAdd();
  });

  $("#quickExpenseBtn").addEventListener("click", () => {
    showTab("transactions");
    $("#txDate").value = dateToday();
    openTxModalForAdd();
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

    try {
      if (state.editTxId) {
        // EDIT - use tdate for PUT
        const payload = {
          category_id: Number($("#txCategory").value),
          amount: Number($("#txAmount").value),
          tdate: $("#txDate").value,
          note: $("#txNote").value || ""
        };
        await apiSend(`/transactions/${state.editTxId}`, "PUT", payload);
        toast("Transaction updated", "ok");
      } else {
        // ADD - use date for POST
    const payload = {
      month_key: state.month,
      category_id: Number($("#txCategory").value),
      amount: Number($("#txAmount").value),
      date: $("#txDate").value,
      note: $("#txNote").value || ""
    };
      await apiSend("/transactions", "POST", payload);
        toast("Transaction added", "ok");
      }

      state.editTxId = null;
      $("#txAmount").value = "";
      $("#txNote").value = "";
      closeModal();
      await refreshMonth();
      showTab("transactions");
    } catch (err) {
      toast(err?.message || "Save failed", "err");
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
        renderBudgetSnapshot();
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
        renderBudgetSnapshot();
      } catch (err) {
        toast(err.message, "err");
      }
    }
  });

  $("#txCancelEdit").addEventListener("click", () => {
    state.editTxId = null;
    closeModal();
  });

  // Transaction edit + delete with undo
  document.addEventListener("click", async (e) => {
    // Delete (don't trigger open)
    const delBtn = e.target.closest?.("[data-tx-del]");
    if (delBtn) {
      e.stopPropagation();
      const id = Number(delBtn.getAttribute("data-tx-del"));
      const tx = (state.transactions || []).find(x => Number(x.id) === id);
      if (!tx) return;

      try {
        // Optimistic UI: remove immediately
        state.transactions = (state.transactions || []).filter(x => Number(x.id) !== id);
        renderTransactions(); // refresh list immediately

        await apiSend(`/transactions/${id}`, "DELETE");

        // store for undo
        state.undoTx = { ...tx };

        toastAction(
          "Transaction deleted",
          "warn",
          "Deleted",
          "Undo",
          async () => {
            try {
              await apiSend("/transactions", "POST", {
                month_key: state.month,
                category_id: state.undoTx.category_id,
                amount: state.undoTx.amount,
                date: state.undoTx.tdate,
                note: state.undoTx.note || ""
              });
              toast("Restored", "ok");
              await refreshMonth();
            } catch (err) {
              toast(err?.message || "Undo failed", "err");
            } finally {
              state.undoTx = null;
            }
          }
        );

        await refreshMonth(); // ensure totals/charts updated
      } catch (err) {
        toast(err?.message || "Delete failed", "err");
        await refreshMonth(); // re-sync UI if something went wrong
      }
      return;
    }

    // Open to edit (click row)
    const row = e.target.closest?.("[data-tx-open]");
    if (!row) return;
    const id = Number(row.getAttribute("data-tx-open"));
    const tx = (state.transactions || []).find(x => Number(x.id) === id);
    if (!tx) return;

    openTxModalForEdit(tx);
  });

  // Transaction filter events
  ["txSearch","txCatFilter","txMin","txMax","txFrom","txTo"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", () => renderTransactions());
      el.addEventListener("change", () => renderTransactions());
    }
  });

  document.getElementById("txClearFilters")?.addEventListener("click", () => {
    ["txSearch","txMin","txMax","txFrom","txTo"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = "";
    });
    const sel = document.getElementById("txCatFilter");
    if (sel) sel.value = "";
    renderTransactions();
  });

  // Export/Import buttons
  $("#btnExportJson")?.addEventListener("click", exportMonthJSON);
  $("#btnExportCsv")?.addEventListener("click", exportMonthCSV);

  // --- Export dropdown wiring ---
  (function () {
    const btn = document.getElementById("exportMenuBtn");
    const panel = document.getElementById("exportMenu");
    const jsonItem = document.getElementById("exportJsonItem");
    const csvItem = document.getElementById("exportCsvItem");

    function openMenu() {
      panel.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
    }

    function closeMenu() {
      panel.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
    }

    btn?.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.classList.contains("open") ? closeMenu() : openMenu();
    });

    jsonItem?.addEventListener("click", () => {
      closeMenu();
      exportMonthJSON();
    });

    csvItem?.addEventListener("click", () => {
      closeMenu();
      exportMonthCSV();
    });

    // close on outside click / ESC
    document.addEventListener("click", closeMenu);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeMenu();
    });

    // prevent panel clicks from closing instantly
    panel?.addEventListener("click", (e) => e.stopPropagation());
  })();

  $("#btnImportJson")?.addEventListener("click", () => $("#importJsonFile").click());
  $("#importJsonFile")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    await importMonthJSONFile(f);
    e.target.value = ""; // allow re-import same file later
  });

  // Trends mode toggle
  document.getElementById("trendModeIE")?.addEventListener("click", () => {
    state.trendMode = "ie";
    document.getElementById("trendModeIE").classList.add("active");
    document.getElementById("trendModeBal").classList.remove("active");
    renderTrends();
  });

  document.getElementById("trendModeBal")?.addEventListener("click", () => {
    state.trendMode = "bal";
    document.getElementById("trendModeBal").classList.add("active");
    document.getElementById("trendModeIE").classList.remove("active");
    renderTrends();
  });

  $("#btnTrendExportCsv")?.addEventListener("click", exportTrendsCSV);

  // Demo data functionality removed - users start with clean empty app

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (isTypingTarget(e.target)) {
      // allow Esc even when typing
      if (e.key !== "Escape") return;
    }

    // Esc closes modals
    if (e.key === "Escape") {
      closeAnyOpenModal();
      return;
    }

    // "/" focuses transaction search
    if (e.key === "/") {
      e.preventDefault();
      const s = document.getElementById("txSearch");
      if (s) s.focus();
      return;
    }

    // "A" opens Add Transaction
    if (e.key.toLowerCase() === "a") {
      e.preventDefault();
      openAddTransaction();
    }
  });

  // Breakdown modal functions
  function openBreakdownModal() {
    const m = document.getElementById("breakdownModal");
    if (!m) return;
    m.classList.remove("hidden");
    m.setAttribute("aria-hidden", "false");
    renderBreakdownCharts(state.month);
  }

  function closeBreakdownModal() {
    const m = document.getElementById("breakdownModal");
    if (!m) return;
    m.classList.add("hidden");
    m.setAttribute("aria-hidden", "true");
    // Destroy charts when closing
    if (breakdownPieChart) {
      breakdownPieChart.destroy();
      breakdownPieChart = null;
    }
    if (breakdownBarChart) {
      breakdownBarChart.destroy();
      breakdownBarChart = null;
    }
  }

  function renderBreakdownCharts(monthKey) {
    if (!monthKey) {
      console.error("renderBreakdownCharts: monthKey is required");
      return;
    }
    try {
      // Get expense breakdown from summary
      const breakdown = (state.summary?.breakdown || []).filter(b => 
        (b.type || "").toLowerCase() === "expense"
      );

      const pieEl = document.getElementById("breakdownPie");
      const barEl = document.getElementById("breakdownBars");
      const emptyEl = document.getElementById("breakdownEmpty");

      if (!pieEl || !barEl) {
        console.error("Breakdown chart canvas elements not found");
        return;
      }

      // Destroy old charts
      if (breakdownPieChart) breakdownPieChart.destroy();
      if (breakdownBarChart) breakdownBarChart.destroy();

      if (!breakdown.length) {
        // Show empty message
        if (emptyEl) emptyEl.style.display = "block";
        // Render placeholder charts
        breakdownPieChart = new Chart(pieEl.getContext("2d"), {
          type: "doughnut",
          data: { 
            labels: ["No data"], 
            datasets: [{ 
              data: [1], 
              backgroundColor: ["rgba(191,195,230,.15)"], 
              borderWidth: 0 
            }] 
          },
          options: { 
            responsive: true, 
            maintainAspectRatio: false,
            cutout: "70%",
            plugins: { 
              legend: { display: false }, 
              tooltip: { enabled: false } 
            } 
          }
        });
        breakdownBarChart = new Chart(barEl.getContext("2d"), {
          type: "bar",
          data: { labels: ["No data"], datasets: [{ data: [0] }] },
          options: { 
            responsive: true, 
            maintainAspectRatio: false, 
            plugins: { 
              legend: { display: false }, 
              tooltip: { enabled: false } 
            } 
          }
        });
        return;
      }

      // Hide empty message
      if (emptyEl) emptyEl.style.display = "none";

      const labels = breakdown.map(b => b.name);
      const values = breakdown.map(b => Number(b.amount) || 0);
      const colors = breakdown.map(b => b.color || "#E82888");
      const total = values.reduce((a, b) => a + b, 0);

      // Pie/Donut chart
      breakdownPieChart = new Chart(pieEl.getContext("2d"), {
        type: "doughnut",
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: colors,
            borderWidth: 0,
            hoverOffset: 6,
            cutout: "68%"
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          layout: { padding: 14 },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.raw || 0;
                  const pct = total ? Math.round((v / total) * 100) : 0;
                  return `${ctx.label}: ${fmtKsh(v)} (${pct}%)`;
                }
              }
            }
          }
        }
      });

      // Bar chart
      breakdownBarChart = new Chart(barEl.getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [{
            data: values,
            backgroundColor: colors,
            borderWidth: 0,
            borderRadius: 8
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          indexAxis: "y",
          scales: {
            x: {
              beginAtZero: true,
              grid: { display: false },
              ticks: { color: "rgba(255,255,255,0.5)", font: { size: 11 } }
            },
            y: {
              grid: { color: "rgba(255,255,255,0.08)" },
              ticks: { color: "rgba(255,255,255,0.5)", font: { size: 11 } }
            }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => {
                  const v = ctx.raw || 0;
                  const pct = total ? Math.round((v / total) * 100) : 0;
                  return `${ctx.label}: ${fmtKsh(v)} (${pct}%)`;
                }
              }
            }
          }
        }
      });
    } catch (err) {
      console.error("Error rendering breakdown charts:", err);
    }
  }

  // Breakdown modal close button
  document.getElementById("breakdownClose")?.addEventListener("click", () => {
    closeBreakdownModal();
  });

  // Mobile: tap Breakdown card -> open breakdown modal
  document.addEventListener("click", (e) => {
    // Don't trigger if clicking the Compare button
    if (e.target.closest?.("#btnCompare")) return;
    
    const breakdownCard = e.target.closest?.("#breakdownCard, [data-open-breakdown], .breakdownCard");
    if (!breakdownCard) return;

    if (isMobile()) {
      e.preventDefault();
      openBreakdownModal();
    }
  });

  // ---- Compare modal (categories charts) ----
  const compareModal = document.getElementById("compareModal");
  const btnCompare = document.getElementById("btnCompare");
  const compareClose = document.getElementById("compareClose");
  const compareReset = document.getElementById("compareReset");

  async function openCompareModal(){
    if(!compareModal) {
      console.error("compareModal element not found");
      return;
    }
    if(!state.month) {
      console.error("No month selected");
      return;
    }
    try {
      // Ensure summary is loaded (contains breakdown data)
      if (!state.summary) {
        await loadSummary();
      }
      // Also ensure transactions are loaded as fallback
      if (!state.transactions || state.transactions.length === 0) {
        await loadTransactions();
      }
      
      compareModal.classList.remove("hidden");
      compareModal.setAttribute("aria-hidden", "false");
      renderCompareCharts(state.month);
    } catch(err) {
      console.error("Error opening compare modal:", err);
      compareModal.classList.add("hidden");
    }
  }

  function closeCompareModal(){
    if(!compareModal) return;
    compareModal.classList.add("hidden");
    compareModal.setAttribute("aria-hidden", "true");
    // Destroy charts when closing
    if(comparePieChart) {
      comparePieChart.destroy();
      comparePieChart = null;
    }
    if(compareBarChart) {
      compareBarChart.destroy();
      compareBarChart = null;
    }
  }

  if (btnCompare) {
    btnCompare.addEventListener("click", (e) => {
      e.stopPropagation(); // Prevent triggering breakdown card click
      e.preventDefault();
      console.log("Compare button clicked");
      openCompareModal();
    });
  } else {
    console.warn("btnCompare button not found");
  }
  if (compareClose) {
    compareClose.addEventListener("click", closeCompareModal);
  }
  if (compareModal) {
    compareModal.addEventListener("click", (e) => {
      if (e.target === compareModal) closeCompareModal();
    });
  }
  // Note: Escape key is handled by the main keyboard shortcuts handler above

  // Helpers: sum expenses by category from transactions
  function sumExpensesByCategory(txs){
    const map = new Map();
    for(const t of txs){
      if((t.category_type || "").toLowerCase() !== "expense") continue;
      const cat = t.category_name || "Uncategorized";
      const amt = Number(t.amount) || 0;
      map.set(cat, (map.get(cat) || 0) + amt);
    }
    return [...map.entries()].sort((a,b) => b[1] - a[1]);
  }

  function renderCompareCharts(monthKey){
    if(!monthKey) {
      console.error("renderCompareCharts: monthKey is required");
      return;
    }
    try {
      // Use summary breakdown data if available (more reliable)
      let pairs = [];
      
      if (state.summary && state.summary.breakdown) {
        // Get expense breakdown from summary
        const expenseBreakdown = state.summary.breakdown.filter(b => 
          (b.type || "").toLowerCase() === "expense"
        );
        pairs = expenseBreakdown.map(b => [b.name, Number(b.amount) || 0])
          .sort((a, b) => b[1] - a[1]); // Sort by amount descending
      } else {
        // Fallback: filter transactions manually
        const allTxs = state.transactions || [];
        const txs = allTxs.filter(t => {
          const txMonth = (t.tdate || t.date || "").slice(0, 7); // YYYY-MM
          return txMonth === monthKey;
        });
        pairs = sumExpensesByCategory(txs);
      }
      
      console.log("Expense categories for compare:", pairs.length);

      const pieEl = document.getElementById("comparePie");
      const barEl = document.getElementById("compareBar");
      const listEl = document.getElementById("compareList");
      const emptyEl = document.getElementById("compareEmpty");

      if(!pieEl || !barEl) {
        console.error("Chart canvas elements not found");
        return;
      }

    // Destroy old charts
    if(comparePieChart) comparePieChart.destroy();
    if(compareBarChart) compareBarChart.destroy();

    if(listEl) listEl.innerHTML = "";

    if(!pairs.length){
      if(emptyEl) emptyEl.style.display = "block";
      comparePieChart = new Chart(pieEl.getContext("2d"), {
        type: "doughnut",
        data: { labels: ["No data"], datasets: [{ data: [1], backgroundColor: ["rgba(191,195,230,.15)"], borderWidth: 0, cutout: "70%" }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
      });
      compareBarChart = new Chart(barEl.getContext("2d"), {
        type: "bar",
        data: { labels: ["No data"], datasets: [{ data: [0] }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } }
      });
      return;
    } else {
      if(emptyEl) emptyEl.style.display = "none";
    }

    const labels = pairs.map(([c]) => c);
    const values = pairs.map(([,v]) => v);
    const total = values.reduce((a,b)=>a+b,0);

    // Get colors from breakdown if available, otherwise use palette
    let colors;
    if (state.summary && state.summary.breakdown) {
      const expenseBreakdown = state.summary.breakdown.filter(b => 
        (b.type || "").toLowerCase() === "expense"
      );
      const colorMap = new Map(expenseBreakdown.map(b => [b.name, b.color || "#E82888"]));
      colors = labels.map(cat => colorMap.get(cat) || "#E82888");
    } else {
      // Fallback: use CSS variables palette
      const css = getComputedStyle(document.documentElement);
      const PINK  = css.getPropertyValue("--pink")?.trim()  || "#E82888";
      const AMBER = css.getPropertyValue("--amber")?.trim() || "#F0A810";
      const PURP  = css.getPropertyValue("--purple")?.trim()|| "#7028F8";
      const TEAL  = css.getPropertyValue("--teal")?.trim()  || "#58D8B0";
      const GREEN = css.getPropertyValue("--green")?.trim() || "#08F850";
      const palette = [PINK, AMBER, PURP, TEAL, GREEN, "#BFC3E6"];
      colors = labels.map((_,i) => palette[i % palette.length]);
    }

    // Pie/Donut chart
    comparePieChart = new Chart(pieEl.getContext("2d"), {
      type: "doughnut",
      data: {
        labels,
        datasets: [{
          data: values,
          backgroundColor: colors,
          borderWidth: 0,
          hoverOffset: 6,
          cutout: "68%"
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: 14 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = Number(ctx.parsed) || 0;
                const pct = total ? Math.round((v / total) * 100) : 0;
                return ` ${ctx.label}: ${fmtKsh(v)} (${pct}%)`;
              }
            }
          }
        }
      }
    });

    // Bar chart (top 8)
    const topN = 8;
    const topLabels = labels.slice(0, topN);
    const topValues = values.slice(0, topN);
    const topColors = topLabels.map(cat => {
      const idx = labels.indexOf(cat);
      return colors[idx] || "#E82888";
    });

    compareBarChart = new Chart(barEl.getContext("2d"), {
      type: "bar",
      data: {
        labels: topLabels,
        datasets: [{
          data: topValues,
          backgroundColor: topColors.map(c => c + "80"), // Add transparency
          borderColor: topColors,
          borderWidth: 1,
          borderRadius: 10
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${fmtKsh(Number(ctx.parsed.x))}`
            }
          }
        },
        scales: {
          x: {
            ticks: { color: "rgba(191,195,230,.85)", callback: (v) => fmtKsh(v) },
            grid: { color: "rgba(191,195,230,.08)" }
          },
          y: {
            ticks: { color: "rgba(248,248,248,.9)" },
            grid: { display: false }
          }
        }
      }
    });

    // Build clickable list (optional drill-down hook)
    if(listEl){
      pairs.slice(0, 12).forEach(([cat, amt], idx) => {
        const pct = total ? Math.round((amt / total) * 100) : 0;
        const row = document.createElement("div");
        row.className = "item";
        row.style.cursor = "pointer";
        row.innerHTML = `
          <div class="itemLeft">
            <div class="itemTitle">${idx+1}. ${cat}</div>
            <div class="itemSub">${pct}% of expenses</div>
          </div>
          <div class="itemAmt">${fmtKsh(amt)}</div>
        `;
        row.addEventListener("click", () => {
          if (typeof toast === "function") toast(`Showing ${cat}`, "ok");
        });
        listEl.appendChild(row);
      });
    }
    } catch(err) {
      console.error("Error rendering compare charts:", err);
    }
  }

  // Inline editing: goal and budget
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.("[data-inline-type]");
    if (!el) return;

    // Savings goal inline
    if (el.dataset.inlineType === "goal") {
      startInlineNumberEdit(el, {
        getValue: () => numFromAny(el.dataset.value),
        onSave: async (v) => {
          await apiSend("/goals", "POST", { month_key: state.month, savings_goal: v });
          await refreshMonth(); // update dashboard/insights immediately
        },
        formatDisplay: (v) => fmtKsh(v),
        placeholderText: "Goal amount"
      });
      return;
    }

    // Budget inline (per category)
    if (el.dataset.inlineType === "budget") {
      const catId = Number(el.dataset.inlineBudget || 0);
      startInlineNumberEdit(el, {
        getValue: () => numFromAny(el.dataset.value),
        onSave: async (v) => {
          await apiSend("/budgets", "POST", { month_key: state.month, category_id: catId, budget_amount: v });
          await refreshMonth();
        },
        formatDisplay: (v) => (v > 0 ? fmtKsh(v) : "Set budget"),
        placeholderText: "Budget amount"
      });
    }
  });

  // Click a month row → jump to month (trends table)
  // This is separate from transaction row clicks, so no conflict
  document.addEventListener("click", async (e) => {
    const row = e.target.closest?.("[data-trend-month]");
    if (!row) return;
    e.stopPropagation();
    const mk = row.getAttribute("data-trend-month");

    state.month = mk;
    document.getElementById("monthPicker").value = mk;
    toast(`Opened ${mk}`, "ok");
    await refreshMonth(); // updates dashboard for that month
    showTab("dashboard"); // switch to dashboard to see the month
  });
}

async function boot() {
  // Initialize user ID from Supabase session (if available)
  currentUserId = await getUserId();
  
  // Set up auth state change handler (if Supabase is available)
  if (supabase) {
    supabase.auth.onAuthStateChange(async (_event, session) => {
      currentUserId = session?.user?.id || null;
      // Reload cached data sets for the new user and refresh UI
      await loadMonths();
      await loadCategories();
      await refreshMonth();
    });
  }
  
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

// Welcome block functionality
(function () {
  const STORAGE_KEY = "mt_display_name";

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }

  function sanitizeName(name) {
    return String(name || "")
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 20);
  }

  function setWelcomeUI(name) {
    const welcomeLine = document.getElementById("welcomeLine");
    const welcomeSub = document.getElementById("welcomeSub");

    const greeting = getGreeting();
    const safeName = sanitizeName(name);

    if (welcomeLine) {
      welcomeLine.textContent = safeName
        ? `${greeting}, ${safeName} 👋`
        : `${greeting} 👋`;
    }

    if (welcomeSub) {
      welcomeSub.textContent = "Here's your monthly overview.";
    }
  }

  function openNameChangeModal() {
    const modal = document.getElementById("nameChangeModal");
    const input = document.getElementById("nameChangeInput");
    const current = localStorage.getItem(STORAGE_KEY) || "";
    
    if (modal && input) {
      input.value = current;
      modal.classList.remove("hidden");
      // Focus after a tiny delay to ensure modal is visible
      setTimeout(() => input.focus(), 100);
    }
  }

  function closeNameChangeModal() {
    const modal = document.getElementById("nameChangeModal");
    if (modal) {
      modal.classList.add("hidden");
    }
  }

  function saveName() {
    const input = document.getElementById("nameChangeInput");
    if (!input) return;

    const cleaned = sanitizeName(input.value);
    if (!cleaned) {
      // If empty, just close without saving
      closeNameChangeModal();
      return;
    }

    localStorage.setItem(STORAGE_KEY, cleaned);
    setWelcomeUI(cleaned);
    closeNameChangeModal();
  }

  function initWelcome() {
    const saved = localStorage.getItem(STORAGE_KEY);

    if (!saved) {
      setWelcomeUI("there");
    } else {
      setWelcomeUI(saved);
    }

    // Set up change button
    const changeBtn = document.getElementById("changeNameBtn");
    if (changeBtn) {
      changeBtn.addEventListener("click", openNameChangeModal);
    }

    // Set up modal controls
    const modal = document.getElementById("nameChangeModal");
    const form = document.getElementById("nameChangeForm");
    const cancelBtn = document.getElementById("nameChangeCancel");
    const closeBtn = document.getElementById("nameChangeClose");
    const input = document.getElementById("nameChangeInput");

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        saveName();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", closeNameChangeModal);
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", closeNameChangeModal);
    }

    // Close on ESC key
    if (modal) {
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          closeNameChangeModal();
        }
      });
    }

    // Close on backdrop click
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) {
          closeNameChangeModal();
        }
      });
    }

    // Enter key to save (when input is focused)
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          saveName();
        }
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initWelcome);
  } else {
    initWelcome();
  }
})();

// Onboarding flow (first-time only)
(function () {
  const OB_KEY = "mt_onboarded_v1";
  const NAME_KEY = "mt_display_name";
  const DEFAULT_GOAL_KEY = "mt_default_goal";

  const overlay = document.getElementById("onboardOverlay");
  if (!overlay) return;

  const steps = Array.from(document.querySelectorAll(".obStep"));
  const dots = Array.from(document.querySelectorAll(".obDot"));
  const btnBack = document.getElementById("obBack");
  const btnNext = document.getElementById("obNext");
  const btnSkip = document.getElementById("obSkip");
  const btnClose = document.getElementById("obClose");

  // Debug: Check if button is found
  console.log("obNext found?", btnNext);

  const nameInput = document.getElementById("obName");
  const goalInput = document.getElementById("obGoal");

  let step = 0;

  function sanitizeName(name) {
    return String(name || "")
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 20);
  }

  function open() {
    overlay.removeAttribute("hidden");
    overlay.style.display = "flex";
    render();
    setTimeout(() => document.getElementById("obClose")?.focus(), 0);
  }

  function close() {
    overlay.setAttribute("hidden", "true");
    overlay.style.display = "none";
  }

  function setDotActive(i) {
    dots.forEach((d, idx) => d.classList.toggle("obDotActive", idx === i));
  }

  function render() {
    steps.forEach((s, idx) => s.classList.toggle("obStepShow", idx === step));
    setDotActive(step);

    btnBack.disabled = step === 0;
    btnNext.textContent = step === steps.length - 1 ? "Finish" : "Next";
  }

  function applyWelcomeName(name) {
    const welcomeLine = document.getElementById("welcomeLine");
    if (!welcomeLine) return;

    const h = new Date().getHours();
    const g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    welcomeLine.textContent = name ? `${g}, ${name} 👋` : `${g} 👋`;
  }

  function applyGoalNow(goal) {
    const gi = document.getElementById("goalInput");
    const save = document.getElementById("saveGoalBtn");
    if (gi && save) {
      gi.value = String(goal);
      save.click(); // uses your existing save logic
    }
  }

  function finish(saveData) {
    // Always mark as onboarded (even if skipped)
    localStorage.setItem(OB_KEY, "1");
    
    if (saveData) {
      const cleanedName = sanitizeName(nameInput?.value);
      const goal = Number(goalInput?.value || 0);

      if (cleanedName) {
        localStorage.setItem(NAME_KEY, cleanedName);
        applyWelcomeName(cleanedName);
      }

      if (goal > 0) {
        localStorage.setItem(DEFAULT_GOAL_KEY, String(goal));
        applyGoalNow(goal);
      }
    }

    close();
  }

  btnBack?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    step = Math.max(0, step - 1);
    render();
  });

  btnNext?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    console.log("Finish/Next button clicked, step:", step);
    if (step < steps.length - 1) {
      step += 1;
      render();
    } else {
      console.log("Calling finish(true)");
      finish(true);
    }
  });

  btnSkip?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Mark as onboarded even when skipped
    localStorage.setItem(OB_KEY, "1");
    close();
  });
  
  btnClose?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Mark as onboarded even when closed
    localStorage.setItem(OB_KEY, "1");
    close();
  });

  document.addEventListener("keydown", (e) => {
    if (overlay.hidden) return;
    if (e.key === "Escape") {
      // Mark as onboarded when ESC is pressed
      localStorage.setItem(OB_KEY, "1");
      close();
    }
  });

  function init() {
    const params = new URLSearchParams(window.location.search);
    const force = params.get("test_onboarding") === "1"; // only for testing

    // Normal users: show only if not onboarded
    if (!force && localStorage.getItem(OB_KEY) === "1") return;

    // If testing, temporarily clear the flag
    if (force) {
      localStorage.removeItem(OB_KEY);
    }

    open();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// Reset all data button (with type-to-confirm modal)
(function () {
  const btnReset = document.getElementById("btnResetAll");
  const resetModal = document.getElementById("resetModal");
  const resetModalClose = document.getElementById("resetModalClose");
  const resetCancel = document.getElementById("resetCancel");
  const resetConfirm = document.getElementById("resetConfirm");
  const resetConfirmInput = document.getElementById("resetConfirmInput");

  if (!btnReset || !resetModal) return;

  function openResetModal() {
    resetModal.classList.remove("hidden");
    resetConfirmInput.value = "";
    resetConfirm.disabled = true;
    resetConfirmInput.focus();
  }

  function closeResetModal() {
    resetModal.classList.add("hidden");
    resetConfirmInput.value = "";
    resetConfirm.disabled = true;
  }

  function checkConfirmInput() {
    const typed = resetConfirmInput.value.toUpperCase().trim();
    resetConfirm.disabled = typed !== "RESET";
  }

  async function performReset() {
    try {
      // Clear database
      const res = await fetch('/api/reset', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!res.ok) {
        const err = await res.json();
        alert('Failed to reset database: ' + (err.error || 'Unknown error'));
        return;
      }

      // Clear localStorage
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;

        if (
          k.startsWith("mt_") ||
          k.startsWith("monetzie_") ||
          k.startsWith("money_")
        ) {
          keysToRemove.push(k);
        }
      }

      keysToRemove.forEach(k => localStorage.removeItem(k));
      
      // Also clear demo flag if it exists
      localStorage.removeItem("mt_demo_mode");
      
      closeResetModal();
      // Reload to show empty state
      location.reload();
    } catch (error) {
      console.error('Reset error:', error);
      alert('Error resetting data: ' + error.message);
    }
  }

  btnReset.addEventListener("click", openResetModal);
  resetModalClose?.addEventListener("click", closeResetModal);
  resetCancel?.addEventListener("click", closeResetModal);
  
  resetConfirmInput?.addEventListener("input", checkConfirmInput);
  resetConfirmInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !resetConfirm.disabled) {
      e.preventDefault();
      performReset();
    }
    if (e.key === "Escape") {
      closeResetModal();
    }
  });

  resetConfirm?.addEventListener("click", performReset);

  // Close on backdrop click
  resetModal?.addEventListener("click", (e) => {
    if (e.target === resetModal) closeResetModal();
  });
})();
