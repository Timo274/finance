// Salary Allocation Planner — фронтенд (vanilla JS).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const api = {
  async req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) {
      showAuthGate();
      throw new Error("unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (method !== "GET") notifyDataChanged();
    return data;
  },
  get: (u) => api.req("GET", u),
  post: (u, b) => api.req("POST", u, b),
  put: (u, b) => api.req("PUT", u, b),
  del: (u) => api.req("DELETE", u),
};

// ---------- state ----------
const state = {
  meta: null,
  plan: null,
  items: [],
  allocation: null,
  insights: null,
  history: [],
  investments: [],
  portfolio: null,
  wallets: [],
  manualPlan: [],
  goals: [],
  view: "dashboard",
  firstLoginPending: false,
  queueFilters: {
    q: "",
    layer: "all",
    type: "all",
    band: "all",
    status: "all",
  },
  queueSort: { key: "priority", dir: "desc" },
  invTab: "overview",
  currencyRate: 43.5,
};

// ---------- helpers ----------
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU") + " грн";
const fmtShort = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");
const fmtUsd = (n) =>
  state.currencyRate > 0
    ? `(~$${((Number(n) || 0) / state.currencyRate).toLocaleString("ru-RU", { maximumFractionDigits: 0 })})`
    : "";
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), 2400);
}
function layerLabel(key) {
  const l = state.meta?.layers?.[key];
  return l ? `${l.ru}` : key;
}
function layerColor(key) {
  return state.meta?.layers?.[key]?.color || "#64748b";
}
// Совместимость со старыми вызовами.
const bucketLabel = layerLabel;
const bucketColor = layerColor;
function catObj(id) {
  return state.meta?.categories?.find((c) => c.id === id);
}
function catLabel(id) {
  const c = catObj(id);
  return c ? `${c.ru} · ${c.label}` : id;
}
function catLabelShort(id) {
  const c = catObj(id);
  return c ? c.ru : id;
}
function bandLabel(id) {
  const b = state.meta?.bands?.find((x) => x.id === id);
  return b ? b.label : id;
}
const TYPE_LABELS = { must: "Must", should: "Should", nice: "Nice" };
const STATUS_LABELS = {
  safe: "Безопасно",
  tight: "Впритык",
  overallocated: "Перерасход",
};
const VERDICT_LABELS = {
  keep: "Брать",
  reconsider: "Подумать",
  drop: "Отказаться",
};
const queueStatusLabel = {
  all: "Все",
  funded: "Копится",
  complete: "Накоплено",
  planned: "В плане",
};

// ---------- charts (vanilla canvas, без библиотек) ----------
function cssVar(name, fallback = "#888") {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawDonut(canvas, segments) {
  const { ctx, w, h } = setupCanvas(canvas);
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return;
  const cx = w / 2,
    cy = h / 2;
  const r = Math.min(w, h) / 2 - 6;
  const inner = r * 0.62;
  let a = -Math.PI / 2;
  segments.forEach((seg) => {
    const ang = (seg.value / total) * Math.PI * 2;
    if (ang <= 0) return;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a, a + ang);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    a += ang;
  });
  // вырезаем центр (донат)
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, inner, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  // подпись в центре
  ctx.fillStyle = cssVar("--text", "#111");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "700 18px Inter, sans-serif";
  ctx.fillText(fmtShort(total), cx, cy - 4);
  ctx.fillStyle = cssVar("--muted", "#888");
  ctx.font = "500 11px Inter, sans-serif";
  ctx.fillText("грн распределено", cx, cy + 13);
}
function drawLine(canvas, points) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (points.length < 2) return;
  const padL = 8,
    padR = 8,
    padT = 14,
    padB = 22;
  const vals = points.map((p) => p.value);
  const maxV = Math.max(...vals, 0);
  const minV = Math.min(...vals, 0);
  const span = maxV - minV || 1;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const x = (i) => padL + (innerW * i) / (points.length - 1);
  const y = (v) => padT + innerH - ((v - minV) / span) * innerH;
  const accent = cssVar("--accent", "#2f6bff");
  // нулевая линия
  if (minV < 0) {
    ctx.strokeStyle = cssVar("--border", "#ddd");
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, y(0));
    ctx.lineTo(w - padR, y(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // smooth curve helper
  const pts = points.map((p, i) => ({ x: x(i), y: y(p.value) }));
  function smoothPath(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const cx = (pts[i].x + pts[i + 1].x) / 2;
      const cy = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, cx, cy);
    }
    ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  // заливка под линией
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, accent + "55");
  grad.addColorStop(1, accent + "00");
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.lineTo(pts[pts.length - 1].x, padT + innerH);
  ctx.lineTo(pts[0].x, padT + innerH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // линия
  ctx.beginPath();
  smoothPath(ctx, pts);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();
  // точки
  pts.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    ctx.fillStyle = points[i].value < 0 ? cssVar("--red", "#e44") : accent;
    ctx.fill();
    ctx.strokeStyle = cssVar("--panel", "#fff");
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
}
function drawBars(canvas, segments) {
  const { ctx, w, h } = setupCanvas(canvas);
  const maxV = Math.max(...segments.map((s) => s.value), 1);
  const pad = 18;
  const gap = 10;
  const barW =
    (w - pad * 2 - gap * (segments.length - 1)) / Math.max(segments.length, 1);
  segments.forEach((seg, i) => {
    const x = pad + i * (barW + gap);
    const bh = ((h - 44) * seg.value) / maxV;
    const y = h - 26 - bh;
    ctx.fillStyle = seg.color || cssVar("--accent", "#2f6bff");
    ctx.fillRect(x, y, Math.max(8, barW), bh);
    ctx.fillStyle = cssVar("--muted", "#888");
    ctx.textAlign = "center";
    ctx.font = "600 10px Inter, sans-serif";
    ctx.fillText(seg.label, x + barW / 2, h - 8);
  });
}
function drawCharts() {
  const donut = $("#donutAlloc");
  if (donut && state.allocation) {
    const t = state.allocation.totals;
    const segs = [
      { value: t.survival, color: "#64708f" },
      { value: t.reserve, color: cssVar("--accent", "#2f6bff") },
      { value: t.fixedInvestment, color: cssVar("--green", "#16a34a") },
    ];
    Object.entries(committedBuckets())
      .filter(([, v]) => v > 0)
      .forEach(([k, v]) => segs.push({ value: v, color: layerColor(k) }));
    const rem = remainingSurplus();
    if (rem > 0) segs.push({ value: rem, color: cssVar("--border", "#ccd") });
    drawDonut(donut, segs);
  }
  const portChart = $("#portChart");
  if (portChart && state.portfolio && state.portfolio.valuations.length) {
    const byMonth = new Map();
    state.portfolio.valuations.forEach((v) => {
      const m = v.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) || 0) + v.value);
    });
    const months = [...byMonth.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    );
    drawLine(
      portChart,
      months.map(([, value]) => ({ value })),
    );
  }
}

// Клиентская копия логики вердикта (для живого отображения в модалке/таблице).
function clientVerdict(scoreType, scores) {
  if (!scoreType || scoreType === "none" || !scores) return null;
  const crit =
    scoreType === "full"
      ? [...state.meta.scoreCriteria.quick, ...state.meta.scoreCriteria.full]
      : state.meta.scoreCriteria.quick;
  let sum = 0;
  let count = 0;
  for (const c of crit) {
    const v = Number(scores[c.id]);
    if (!v) continue;
    sum += c.dir === "neg" ? 6 - v : v;
    count += 1;
  }
  if (count === 0) return null;
  const score = Math.round((sum / count / 5) * 100);
  let verdict = "reconsider";
  if (score >= 68) verdict = "keep";
  else if (score < 45) verdict = "drop";
  return { score, verdict };
}

function prioDots(p) {
  let s = '<span class="prio">';
  for (let i = 1; i <= 5; i++) s += `<i class="${i <= p ? "on" : ""}"></i>`;
  return s + "</span>";
}
function goalProgress(item) {
  const cost = Number(item.cost) || 0;
  const goal = state.goals.find((g) => g.itemId === item.id);
  const saved = Math.min(
    cost,
    Math.max(0, Number(goal?.savedAmount ?? item.savedAmount) || 0),
  );
  const monthly = Math.max(0, Number(goal?.monthlyContribution) || 0);
  const left = Math.max(0, cost - saved);
  return {
    saved,
    cost,
    left,
    monthly,
    monthsLeft: monthly > 0 ? Math.ceil(left / monthly) : null,
    pct: cost > 0 ? Math.min(100, Math.round((saved / cost) * 100)) : 0,
  };
}
function walletTotal() {
  return state.wallets.reduce((sum, w) => sum + Number(w.amount || 0), 0);
}
function manualPlanTotal() {
  return state.manualPlan.reduce((sum, p) => sum + Number(p.amount || 0), 0);
}
function manualAmountFor(itemId) {
  return state.manualPlan.find((p) => p.itemId === itemId)?.amount || 0;
}
// Единый источник «распределено / останется» для всех вкладок.
// Если пользователь заполнил ручной план — он главный; иначе берём авто-распределение.
function hasManualPlan() {
  return manualPlanTotal() > 0;
}
function committedTotal() {
  return hasManualPlan()
    ? manualPlanTotal()
    : state.allocation?.totals?.allocated || 0;
}
function remainingSurplus() {
  const avail = state.allocation?.totals?.availableToAllocate || 0;
  return avail - committedTotal();
}
// Разбивка распределённого по слоям капитала — из ручного плана либо из авто.
function committedBuckets() {
  if (!hasManualPlan()) return state.allocation?.buckets || {};
  const b = {};
  for (const p of state.manualPlan) {
    const amt = Number(p.amount) || 0;
    if (amt <= 0) continue;
    const it = state.items.find((i) => i.id === p.itemId);
    const layer = (it && (it.layer || it.bucket)) || "quality";
    b[layer] = (b[layer] || 0) + amt;
  }
  return b;
}
function sortValue(item, key) {
  const layer = item.layer || item.bucket;
  const map = {
    title: item.title || "",
    cost: Number(item.cost) || 0,
    layer: layerLabel(layer),
    category: catLabelShort(item.category),
    band: item.band || "",
    type: item.type || "",
    priority: Number(item.priority) || 0,
    deadline: item.deadline || "9999-12-31",
  };
  return map[key] ?? "";
}
function sortedItems(items) {
  const { key, dir } = state.queueSort;
  const mul = dir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (typeof av === "number" && typeof bv === "number")
      return (av - bv) * mul;
    return String(av).localeCompare(String(bv), "ru") * mul;
  });
}

// ---------- theme ----------
const THEME_MODES = [
  { id: "light", label: "Светлая", icon: "☾", meta: "#ffffff" },
  { id: "dark", label: "Тёмная", icon: "☀", meta: "#0a1020" },
  { id: "cockpit", label: "Decision Cockpit", icon: "◈", meta: "#102f32" },
];
const THEME_PALETTES = [
  { id: "ocean", label: "Ocean Teal" },
  { id: "sapphire", label: "Sapphire" },
  { id: "violet", label: "Executive Violet" },
  { id: "emerald", label: "Emerald" },
  { id: "amber", label: "Amber Desk" },
  { id: "rose", label: "Rose Graphite" },
  { id: "cyan", label: "Cyber Cyan" },
  { id: "slate", label: "Slate Mint" },
  { id: "forest", label: "Forest Gold" },
  { id: "mono", label: "Mono Steel" },
];
function isTheme(t) {
  return THEME_MODES.some((x) => x.id === t);
}
function isPalette(p) {
  return THEME_PALETTES.some((x) => x.id === p);
}
function currentTheme() {
  try {
    const stored = localStorage.getItem("cq-theme");
    if (isTheme(stored)) return stored;
  } catch {}
  const attr = document.documentElement.getAttribute("data-theme");
  return isTheme(attr) ? attr : "light";
}
function currentPalette() {
  try {
    const stored = localStorage.getItem("cq-palette");
    if (isPalette(stored)) return stored;
  } catch {}
  const attr = document.documentElement.getAttribute("data-palette");
  return isPalette(attr) ? attr : "ocean";
}
function syncThemeControls(t, palette = currentPalette()) {
  const mode = THEME_MODES.find((x) => x.id === t) || THEME_MODES[0];
  [$("#themeBtn"), $("#themeBtnAuth")].forEach((btn) => {
    if (!btn) return;
    btn.textContent = mode.icon;
    btn.title = `Режим: ${mode.label}. Нажмите, чтобы переключить`;
    btn.setAttribute("aria-label", btn.title);
  });
  [$("#paletteSelect"), $("#paletteSelectAuth")].forEach((sel) => {
    if (sel) sel.value = palette;
  });
}
function applyPalette(p = currentPalette()) {
  const palette = isPalette(p) ? p : "ocean";
  document.documentElement.setAttribute("data-palette", palette);
  try {
    localStorage.setItem("cq-palette", palette);
  } catch {}
  syncThemeControls(currentTheme(), palette);
  if (typeof drawCharts === "function") requestAnimationFrame(drawCharts);
}
function applyTheme(t) {
  const theme = isTheme(t) ? t : "light";
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("cq-theme", theme);
  } catch {}
  const mode = THEME_MODES.find((x) => x.id === theme) || THEME_MODES[0];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", mode.meta);
  syncThemeControls(theme);
  if (typeof drawCharts === "function") requestAnimationFrame(drawCharts);
}
function toggleTheme() {
  const i = THEME_MODES.findIndex((x) => x.id === currentTheme());
  applyTheme(THEME_MODES[(i + 1) % THEME_MODES.length].id);
}
$("#themeBtn")?.addEventListener("click", toggleTheme);
$("#themeBtnAuth")?.addEventListener("click", toggleTheme);
$("#paletteSelect")?.addEventListener("change", (e) => applyPalette(e.target.value));
$("#paletteSelectAuth")?.addEventListener("change", (e) => applyPalette(e.target.value));
applyTheme(currentTheme());
applyPalette(currentPalette());

// ============================================================
// AUTH
// ============================================================
async function bootstrap() {
  const st = await api.get("/api/auth/status");
  if (st.authed) {
    await loadAndRender();
  } else {
    showAuthGate(st.pinSet, st.setupTokenRequired);
  }
}

function showAuthGate(pinSet = true, setupTokenRequired = false) {
  $("#app").classList.add("hidden");
  const gate = $("#authGate");
  gate.classList.remove("hidden");
  const isSetup = pinSet === false;
  $("#authTitle").textContent = isSetup ? "Создайте PIN" : "Вход";
  $("#authHint").textContent = isSetup
    ? setupTokenRequired
      ? "Введите SETUP_TOKEN из переменных окружения и придумайте PIN (минимум 4 цифры)."
      : "Это персональное приложение. Придумайте PIN (минимум 4 цифры)."
    : "Введите PIN, чтобы открыть свой план.";
  $("#pinConfirm").classList.toggle("hidden", !isSetup);
  $("#setupToken")?.classList.toggle(
    "hidden",
    !(isSetup && setupTokenRequired),
  );
  $("#authSubmit").textContent = isSetup ? "Создать" : "Войти";
  $("#authForm").dataset.mode = isSetup ? "setup" : "login";
  $("#authForm").dataset.setupTokenRequired = setupTokenRequired ? "1" : "0";
  $("#pinInput").value = "";
  $("#pinConfirm").value = "";
  if ($("#setupToken")) $("#setupToken").value = "";
  $("#authError").textContent = "";
  $("#pinInput").focus();
}

$("#authForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const mode = e.currentTarget.dataset.mode;
  const pin = $("#pinInput").value.trim();
  const err = $("#authError");
  err.textContent = "";
  try {
    if (mode === "setup") {
      if (pin.length < 4) return (err.textContent = "PIN слишком короткий.");
      if (pin !== $("#pinConfirm").value.trim())
        return (err.textContent = "PIN не совпадает.");
      const setupToken =
        $("#authForm").dataset.setupTokenRequired === "1"
          ? $("#setupToken")?.value.trim()
          : undefined;
      await api.post("/api/auth/setup", { pin, setupToken });
    } else {
      await api.post("/api/auth/login", { pin });
    }
    state.firstLoginPending = true;
    $("#authGate").classList.add("hidden");
    await loadAndRender();
  } catch (ex) {
    err.textContent =
      ex.message === "bad_pin" ? "Неверный PIN." : "Ошибка: " + ex.message;
  }
});

$("#logoutBtn")?.addEventListener("click", doLogout);
$("#logoutBtnMobile")?.addEventListener("click", doLogout);

// ============================================================
// LOAD + RENDER
// ============================================================
async function loadAndRender() {
  const data = await api.get(`/api/state?scenario=balanced`);
  state.meta = data.meta;
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.insights = data.insights || null;
  state.history = data.history;
  state.investments = data.investments || [];
  state.portfolio = data.portfolio || null;
  state.wallets = data.wallets || [];
  state.manualPlan = data.manualPlan || [];
  state.goals = data.goals || [];
  state.currencyRate = data.currencyRate || 43.5;
  $("#app").classList.remove("hidden");
  renderTopbar();
  renderView();
  maybeShowOnboardingAfterLogin();
}

async function refresh() {
  const data = await api.get(`/api/state?scenario=balanced`);
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.insights = data.insights || null;
  state.history = data.history;
  state.investments = data.investments || [];
  state.portfolio = data.portfolio || null;
  state.wallets = data.wallets || [];
  state.manualPlan = data.manualPlan || [];
  state.goals = data.goals || [];
  state.currencyRate = data.currencyRate || 43.5;
  renderTopbar();
  renderView();
}

function renderTopbar() {
  $("#topPlanName").textContent = state.plan
    ? state.plan.name
    : "Зарплата не настроена";
  $("#topPayday").textContent = state.plan
    ? `Зарплата ${fmtDate(state.plan.payday)} · ${fmt(state.plan.salary)}`
    : "Нажмите «Настроить зарплату»";
  const badge = $("#topStatus");
  if (state.allocation) {
    const s = state.allocation.totals.status;
    badge.className = "status-badge status-" + s;
    badge.textContent = STATUS_LABELS[s] || s;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

$$(".nav-item[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    $$(".nav-item[data-view]").forEach((x) =>
      x.classList.toggle("active", x.dataset.view === b.dataset.view),
    );
    renderView();
  }),
);

async function doLogout() {
  await api.post("/api/auth/logout");
  try {
    localStorage.removeItem("chatHistory");
  } catch {}
  try {
    if ("caches" in window) {
      await caches.delete("capital-queue-api-v1");
      await caches.delete("capital-queue-v3");
    }
  } catch {}
  location.reload();
}

$("#editPlanBtn").addEventListener("click", openPlanModal);
$("#dataBtn").addEventListener("click", openDataModal);
$("#fabAdd")?.addEventListener("click", openQuickItemModal);

function renderView() {
  const root = $("#views");
  const v = state.view;
  if (v === "dashboard") root.innerHTML = viewDashboard();
  else if (v === "queue") root.innerHTML = viewQueue();
  else if (v === "wallets") root.innerHTML = viewWallets();
  else if (v === "investments") root.innerHTML = viewInvestments();
  else if (v === "plan") root.innerHTML = viewPlan();
  else if (v === "history") root.innerHTML = viewHistory();
  else if (v === "assistant") {
    root.innerHTML = viewAssistant();
    initAssistant();
  } else if (v === "more") root.innerHTML = viewMore();
  bindViewEvents();
  requestAnimationFrame(drawCharts);
}

let _resizeT;
window.addEventListener("resize", () => {
  clearTimeout(_resizeT);
  _resizeT = setTimeout(drawCharts, 150);
});

// ============================================================
// VIEWS
// ============================================================
function setView(view) {
  state.view = view;
  $$(".nav-item[data-view]").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === view),
  );
  renderView();
}

function onboardingSteps() {
  const hasPlan = !!state.plan;
  const hasItems = state.items.length > 0;
  const hasPriorities = state.items.some((i) => Number(i.priority) >= 4 || i.deadline);
  const hasManual = hasManualPlan();
  const hasWallet = state.wallets.length > 0;
  return [
    { id: "plan", done: hasPlan, label: "Ввести зарплату и обязательные расходы", hint: "Это база для всех расчётов.", action: "open-plan", button: "Настроить" },
    { id: "items", done: hasItems, label: "Добавить 3–5 желаний", hint: "От мелких покупок до больших целей.", action: "add-item", button: "Добавить" },
    { id: "priority", done: hasPriorities, label: "Отметить приоритеты и дедлайны", hint: "Так cockpit поймёт, что важно сейчас.", view: "queue", button: "Открыть" },
    { id: "manual", done: hasManual, label: "Собрать план месяца", hint: "Распределите излишки по желаниям.", view: "plan", button: "План" },
    { id: "wallet", done: hasWallet, label: "Разложить остаток по кошелькам", hint: "Карманы снижают хаос после зарплаты.", action: "add-wallet", button: "Кошелёк" },
  ];
}

function onboardingProgress() {
  const steps = onboardingSteps();
  const done = steps.filter((s) => s.done).length;
  return { steps, done, total: steps.length, pct: Math.round((done / steps.length) * 100) };
}

function onboardingChecklist({ compact = false } = {}) {
  const { steps, done, total, pct } = onboardingProgress();
  if (done === total && compact) return "";
  return `<section class="onboarding-card card pad-lg ${compact ? "compact" : ""}">
    <div class="row-between onboarding-head">
      <div>
        <div class="eyebrow">быстрый старт</div>
        <h2>Быстрый старт: от зарплаты к плану месяца</h2>
        <p class="muted">${done}/${total} готово. Выполните шаги один раз — дальше кабинет будет сразу подсказывать следующее действие.</p>
      </div>
      <div class="onboarding-progress" style="--pct:${pct}"><b>${pct}%</b><span>готово</span></div>
    </div>
    <div class="onboarding-steps">
      ${steps.map((step, idx) => `<div class="onboarding-step ${step.done ? "done" : ""}">
        <span class="step-check">${step.done ? "✓" : idx + 1}</span>
        <div><b>${step.label}</b><p>${step.hint}</p></div>
        ${step.done ? "" : `<button class="btn btn-sm btn-outline" data-act="${step.action || "go-view"}" ${step.view ? `data-target-view="${step.view}"` : ""}>${step.button}</button>`}
      </div>`).join("")}
    </div>
    <div class="onboarding-foot"><button class="btn btn-sm btn-ghost" data-act="dismiss-onboarding">Скрыть подсказку</button></div>
  </section>`;
}

function maybeShowOnboardingAfterLogin() {
  if (!state.firstLoginPending) return;
  state.firstLoginPending = false;
  const { done, total } = onboardingProgress();
  if (done === total || localStorage.getItem("onboardingDismissed") === "1") return;
  openModal(`<div class="modal onboarding-modal">
    <div class="modal-head"><h2>Соберём план за 5 шагов</h2><button class="close-x" data-close-modal>×</button></div>
    ${onboardingChecklist()}
  </div>`);
  bindViewEvents();
}

function smartDashboardCta() {
  if (!state.plan) {
    return { tone: "warning", title: "Начните с зарплаты", text: "Введите доход, дату зарплаты и стабильные расходы — остальной план появится автоматически.", action: "open-plan", button: "Настроить зарплату" };
  }
  if (!state.items.length) {
    return { tone: "neutral", title: "Добавьте первую очередь желаний", text: "Запишите покупки и цели, чтобы увидеть, что помещается в излишки после обязательного.", action: "add-item", button: "+ Добавить желание" };
  }
  if ((state.allocation?.totals?.status) === "overallocated" || remainingSurplus() < 0) {
    return { tone: "danger", title: "План перегружен", text: "Желаний больше, чем свободных денег. Откройте план и перенесите лишнее на следующий месяц.", view: "plan", button: "Разобрать план" };
  }
  if (!hasManualPlan()) {
    return { tone: "good", title: "Следующий шаг — зафиксировать план", text: `Свободно ${fmt(remainingSurplus())}. Распределите излишки по желаниям, чтобы не решать в день зарплаты.`, view: "plan", button: "Собрать план" };
  }
  if (!state.wallets.length) {
    return { tone: "neutral", title: "Разложите остаток по карманам", text: "Кошельки помогают не смешивать еду, транспорт, накопления и свободные траты.", action: "add-wallet", button: "+ Кошелёк" };
  }
  const buy = state.insights?.buyNow?.[0];
  return { tone: "good", title: buy ? `Можно действовать: ${buy.title}` : "План месяца собран", text: buy ? `Первое безопасное действие по cockpit — ${fmt(buy.remainingCost ?? buy.cost)}.` : "Проверьте план перед зарплатой и закрывайте месяц, когда решения выполнены.", view: buy ? "queue" : "plan", button: buy ? "Открыть очередь" : "Открыть план" };
}

function smartCtaCard() {
  const cta = smartDashboardCta();
  return `<section class="smart-cta card smart-${cta.tone}">
    <div><div class="eyebrow">главное действие</div><h2>${escapeHtml(cta.title)}</h2><p>${escapeHtml(cta.text)}</p></div>
    <button class="btn btn-primary" data-act="${cta.action || "go-view"}" ${cta.view ? `data-target-view="${cta.view}"` : ""}>${escapeHtml(cta.button)}</button>
  </section>`;
}

function richEmpty(icon, title, text, action = "", button = "", targetView = "") {
  return `<div class="empty rich-empty"><div class="big">${icon}</div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action ? `<button class="btn btn-primary" data-act="${action}" ${targetView ? `data-target-view="${targetView}"` : ""}>${escapeHtml(button)}</button>` : ""}</div>`;
}

function noPlanBlock() {
  return richEmpty("◎", "Сначала настройте зарплату", "После этого появится понятная картина: обязательные расходы, свободные деньги, желания и план месяца.", "open-plan", "Настроить зарплату");
}

function insightMoney(n) {
  return fmt(Number(n) || 0);
}

function miniInsightItem(item, emptyText) {
  if (!item) return `<div class="insight-empty">${emptyText}</div>`;
  const layer = item.layer || item.bucket;
  return `<div class="insight-item" data-id="${item.id}">
    <div class="insight-item-main">
      <div class="insight-item-title"><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(item.title)}</div>
      <div class="insight-item-meta">${layerLabel(layer)} · ${TYPE_LABELS[item.type] || item.type}${item.deadlineText ? ` · ${escapeHtml(item.deadlineText)}` : ""}</div>
    </div>
    <b>${insightMoney(item.remainingCost ?? item.cost)}</b>
  </div>`;
}

function decisionMetric(label, value, accent = "") {
  return `<div class="decision-metric ${accent}"><span>${label}</span><b>${value}</b></div>`;
}

function decisionCockpit() {
  const insights = state.insights;
  if (!insights) return "";
  const metrics = insights.metrics || {};
  const runway = Math.max(0, Math.min(100, metrics.runwayPct || 0));
  const statusLabel =
    insights.status === "danger"
      ? "Нужен trade-off"
      : insights.status === "warning"
        ? "Проверить перед покупкой"
        : insights.status === "no_plan"
          ? "Нет плана"
          : "Можно действовать";
  const actionRows = (insights.actions || [])
    .map((a) => `<li class="tone-${a.tone || "neutral"}"><span></span>${escapeHtml(a.text)}</li>`)
    .join("");
  return `<section class="decision-cockpit decision-${insights.status || "safe"}">
    <div class="decision-hero">
      <div class="decision-copy">
        <div class="eyebrow">Decision cockpit</div>
        <h2>${escapeHtml(insights.headline || "План готов")}</h2>
        <p>Один экран для решения: что купить сейчас, что держать под контролем и где лучше нажать паузу.</p>
      </div>
      <div class="runway-ring" style="--pct:${runway}">
        <b>${metrics.runwayPct ?? 0}%</b><span>запас</span>
      </div>
    </div>
    <div class="decision-strip">
      ${decisionMetric("Статус", statusLabel, "metric-status")}
      ${decisionMetric("Свободно", fmt(metrics.remaining || 0), metrics.remaining < 0 ? "metric-danger" : "metric-good")}
      ${decisionMetric("В плане", fmt(metrics.allocated || 0))}
      ${decisionMetric("Активных", `${metrics.activeCount || 0} шт.`)}
    </div>
    <ul class="decision-actions">${actionRows}</ul>
    <div class="decision-grid">
      <div class="decision-col decision-buy"><h3><span>✓</span> Брать сейчас</h3>${(insights.buyNow || []).slice(0, 3).map((x) => miniInsightItem(x, "Пока ничего не помещается в план")).join("") || `<div class="insight-empty">Пока ничего не помещается в план</div>`}</div>
      <div class="decision-col decision-watch"><h3><span>!</span> Проверить</h3>${(insights.watch || []).slice(0, 3).map((x) => miniInsightItem(x, "Нет срочных рисков")).join("") || `<div class="insight-empty">Нет срочных рисков</div>`}</div>
      <div class="decision-col decision-postpone"><h3><span>↷</span> Перенести</h3>${(insights.postpone || []).slice(0, 3).map((x) => miniInsightItem(x, "Нечего переносить")).join("") || `<div class="insight-empty">Нечего переносить</div>`}</div>
    </div>
  </section>`;
}


function allocationLayerCard(t, segs, stablePct) {
  const remaining = remainingSurplus();
  const committed = committedTotal();
  const fixedBase = (Number(t.survival) || 0) + (Number(t.reserve) || 0) + (Number(t.fixedInvestment) || 0);
  const salary = Number(t.salary) || 0;
  const fixedPct = salary ? Math.round((fixedBase / salary) * 100) : 0;
  const committedPct = salary ? Math.round((committed / salary) * 100) : 0;
  const remainingPct = salary ? Math.round((remaining / salary) * 100) : 0;
  const layerRows = Object.entries(committedBuckets())
    .filter(([, v]) => v > 0)
    .map(
      ([k, v]) =>
        `<span><span class="dot" style="background:${bucketColor(k)}"></span>${bucketLabel(k)} <b>${fmt(v)}</b></span>`,
    )
    .join("");

  return `<section class="card pad-lg allocation-card allocation-card-prime">
    <div class="allocation-topline">
      <div>
        <div class="eyebrow">главный экран</div>
        <h2>Распределение по слоям</h2>
        <p>Сначала база, потом защита и инвестиции, затем желания — всё видно одним срезом.</p>
      </div>
      <span class="status-badge status-${t.status}">${STATUS_LABELS[t.status]}</span>
    </div>

    <div class="allocation-hero-grid">
      <div class="allocation-donut-panel">
        <canvas id="donutAlloc" class="chart-donut allocation-donut"></canvas>
        <div class="allocation-donut-caption">
          <span>Всего к распределению</span>
          <b>${fmt(t.salary)}</b>
          <em>${fmtUsd(t.salary)}</em>
        </div>
      </div>

      <div class="allocation-layer-summary">
        <div class="layer-summary-card base">
          <span>База</span>
          <b>${fmt(fixedBase)}</b>
          <em>${fixedPct}% зарплаты</em>
        </div>
        <div class="layer-summary-card planned">
          <span>Желания в плане</span>
          <b>${fmt(committed)}</b>
          <em>${committedPct}% зарплаты</em>
        </div>
        <div class="layer-summary-card ${remaining < 0 ? "danger" : "free"}">
          <span>${remaining < 0 ? "Не хватает" : "Свободный остаток"}</span>
          <b>${fmt(remaining)}</b>
          <em>${remainingPct}% зарплаты</em>
        </div>
      </div>

      <div class="legend legend-col allocation-legend">
        <span><span class="dot" style="background:#64708f"></span>Обязательные <b>${fmt(t.survival)}</b></span>
        <span><span class="dot" style="background:var(--accent)"></span>Страховка <b>${fmt(t.reserve)}</b></span>
        <span><span class="dot" style="background:var(--green)"></span>Инвестиции <b>${fmt(t.fixedInvestment)}</b></span>
        ${layerRows}
        <span><span class="dot" style="background:var(--border)"></span>Останется <b>${fmt(remaining)}</b></span>
      </div>
    </div>

    <div class="alloc-bar allocation-main-bar" aria-label="Полоса распределения зарплаты">
      <div class="alloc-seg" style="width:${stablePct(t.survival)}%;background:#64708f" title="Обязательные"></div>
      <div class="alloc-seg" style="width:${stablePct(t.reserve)}%;background:var(--accent)" title="Страховка"></div>
      <div class="alloc-seg" style="width:${stablePct(t.fixedInvestment)}%;background:var(--green)" title="Инвестиции"></div>${segs}
    </div>
    <div class="allocation-axis"><span>обязательное</span><span>защита</span><span>рост</span><span>желания</span><span>остаток</span></div>
    ${t.status === "overallocated" ? `<div class="tradeoff" style="background:color-mix(in srgb,var(--red) 10%,transparent);border-color:var(--red)"><b style="color:var(--red)">Перерасход.</b> Стабильные пункты и желания выше зарплаты — откройте «План распределения» и перенесите лишнее.</div>` : ""}
  </section>`;
}

function viewDashboard() {
  if (!state.plan || !state.allocation) {
    return `<div class="view-head"><h1>Кабинет</h1><p>Обзор будущей зарплаты до её прихода.</p></div>${noPlanBlock()}`;
  }
  const t = state.allocation.totals;
  const stablePct = (value) => (t.salary ? (value / t.salary) * 100 : 0);
  const segs = Object.entries(committedBuckets())
    .filter(([, v]) => v > 0)
    .map(
      ([k, v]) =>
        `<div class="alloc-seg" style="width:${(v / t.salary) * 100}%;background:${bucketColor(k)}" title="${bucketLabel(k)}: ${fmt(v)}"></div>`,
    )
    .join("");

  const pf = state.portfolio;
  const pfTotals = pf?.totals || pf || {};
  const pfValue = pfTotals.totalValue || 0;
  const pfPL = pfTotals.totalPnL || 0;
  const pfInvested = pfTotals.totalInvested || 0;
  const pfPLpct =
    pfInvested > 0 ? ((pfPL / pfInvested) * 100).toFixed(1) : null;

  return `
  <div class="dashboard-shell">
    <div class="view-head dashboard-head"><div><h1>Кабинет</h1><p>Главный срез зарплаты: слои, остаток и следующие действия.</p></div><span class="page-kicker">личный финансовый cockpit</span></div>
    ${allocationLayerCard(t, segs, stablePct)}
    ${smartCtaCard()}
    ${decisionCockpit()}
    <div class="grid cards dashboard-cards">
    <div class="card"><div class="stat-label"><span class="stat-ico">💰</span> Зарплата</div><div class="stat-value">${fmt(t.salary)}</div><div class="stat-sub">${fmtDate(state.plan.payday)} ${fmtUsd(t.salary)}</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">🛡️</span> Обязательные расходы</div><div class="stat-value sm">${fmt(t.survival)}</div><div class="stat-sub">${fmtUsd(t.survival)} стабильный расходник</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">🏦</span> Страховка</div><div class="stat-value sm accent-num">${fmt(t.reserve)}</div><div class="stat-sub">${fmtUsd(t.reserve)} чёрный день</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">📈</span> Инвестиции</div><div class="stat-value sm green-num">${fmt(t.fixedInvestment)}</div><div class="stat-sub">${fmtUsd(t.fixedInvestment)} стабильно отложить</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">🎯</span> Излишки на желания</div><div class="stat-value accent-num">${fmt(t.availableToAllocate)}</div><div class="stat-sub">${fmtUsd(t.availableToAllocate)} после стабильных пунктов</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">📋</span> Распределено</div><div class="stat-value sm">${fmt(committedTotal())}</div><div class="stat-sub">${fmtUsd(committedTotal())} ${hasManualPlan() ? "ручной план" : `${state.allocation.approved.length} покупок`}</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">${remainingSurplus() < 0 ? "⚠️" : "✅"}</span> Останется из излишков</div><div class="stat-value ${remainingSurplus() < 0 ? "red-num" : "green-num"}">${fmt(remainingSurplus())}</div><div class="stat-sub">${fmtUsd(remainingSurplus())} ${hasManualPlan() ? "по ручному плану" : "по авто-распределению"}</div></div>
    ${pfValue > 0 ? `<div class="card"><div class="stat-label"><span class="stat-ico">💼</span> Портфель</div><div class="stat-value sm">${fmt(pfValue)}</div><div class="stat-sub">${fmtUsd(pfValue)} ${pfPLpct ? `<span style="color:${pfPL >= 0 ? "var(--green)" : "var(--red)"};font-weight:700">${pfPL >= 0 ? "+" : ""}${pfPLpct}%</span>` : ""}</div></div>` : ""}
    </div>
  </div>
  `;
}

function verdictChip(item) {
  const v = clientVerdict(item.scoreType, item.scores);
  if (!v) return "";
  return ` <span class="verdict verdict-${v.verdict}" title="Оценка ${v.score}/100">${VERDICT_LABELS[v.verdict]} ${v.score}</span>`;
}

function queueItemRow(item, extra = "", reason = "") {
  const layer = item.layer || item.bucket;
  const gp = goalProgress(item);
  return `<div class="queue-item queue-swipe" data-id="${item.id}">
    <div class="qi-main">
      <div class="qi-title"><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(item.title)}
        <span class="tag tag-${item.type}">${TYPE_LABELS[item.type]}</span>${verdictChip(item)}</div>
      <div class="qi-meta">${layerLabel(layer)} · ${catLabelShort(item.category)} · ${bandLabel(item.band)} · приоритет ${item.priority}/5 · траектория ${item.trajectory}/5${item.deadline ? " · дедлайн " + fmtDate(item.deadline) : ""}</div>
      ${gp.saved > 0 ? `<div class="goal-mini"><div style="width:${gp.pct}%"></div></div><div class="qi-meta">Накоплено ${fmt(gp.saved)} из ${fmt(gp.cost)} · осталось ${fmt(gp.left)}</div>` : ""}
      ${reason ? `<div class="reason">↪ ${reason}</div>` : ""}
      ${extra ? `<div class="qi-meta">${extra}</div>` : ""}
    </div>
    <div class="qi-cost">${fmt(item.cost)}</div>
  </div>`;
}

function viewQueue() {
  const q = state.queueFilters;
  const filtered = state.items.filter((it) => {
    const gp = goalProgress(it);
    const inPlan = state.allocation?.approved.some((a) => a.item.id === it.id);
    const textOk =
      !q.q ||
      `${it.title} ${it.notes || ""}`.toLowerCase().includes(q.q.toLowerCase());
    const layerOk = q.layer === "all" || (it.layer || it.bucket) === q.layer;
    const typeOk = q.type === "all" || it.type === q.type;
    const bandOk = q.band === "all" || it.band === q.band;
    const statusOk =
      q.status === "all" ||
      (q.status === "funded" && gp.saved > 0 && gp.pct < 100) ||
      (q.status === "complete" && gp.pct >= 100) ||
      (q.status === "planned" && inPlan);
    return textOk && layerOk && typeOk && bandOk && statusOk;
  });
  const sortMark = (key) =>
    state.queueSort.key === key
      ? state.queueSort.dir === "asc"
        ? " ↑"
        : " ↓"
      : "";
  const th = (key, label) =>
    `<th><button class="th-sort" data-sort="${key}">${label}${sortMark(key)}</button></th>`;
  const rows = sortedItems(filtered)
    .map((it) => {
      const inPlan = state.allocation?.approved.some(
        (a) => a.item.id === it.id,
      );
      const layer = it.layer || it.bucket;
      const gp = goalProgress(it);
      return `<tr data-id="${it.id}">
      <td><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(it.title)}${verdictChip(it)}</td>
      <td>${fmt(it.cost)}</td>
      <td><div class="goal-cell"><b>${gp.pct}%</b><div class="goal-mini"><div style="width:${gp.pct}%"></div></div><span>${fmtShort(gp.saved)} / ${fmtShort(gp.cost)}</span></div></td>
      <td>${layerLabel(layer)}</td>
      <td>${catLabelShort(it.category)}</td>
      <td><span class="band">${bandLabel(it.band)}</span></td>
      <td><span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span></td>
      <td>${prioDots(it.priority)}</td>
      <td>${it.deadline ? fmtDate(it.deadline) : "—"}</td>
      <td>${inPlan ? '<span class="green-num">в плане</span>' : '<span class="muted">позже</span>'}</td>
      <td style="text-align:right">
        <details class="row-menu">
          <summary aria-label="Действия с желанием">⋯</summary>
          <div class="row-menu-pop">
            <button class="btn btn-sm btn-ghost" data-act="tradeoff" data-id="${it.id}">Trade-off</button>
            <button class="btn btn-sm btn-ghost" data-act="ai-explain" data-id="${it.id}">✦ почему</button>
            <button class="btn btn-sm btn-outline" data-act="save-goal" data-id="${it.id}">Копить</button>
            <button class="btn btn-sm btn-outline" data-act="edit" data-id="${it.id}">Редактировать</button>
            <button class="btn btn-sm btn-ghost" data-act="bought" data-id="${it.id}">Отметить купленным</button>
            <button class="btn btn-sm btn-danger" data-act="delete" data-id="${it.id}">Удалить</button>
          </div>
        </details>
      </td>
    </tr>`;
    })
    .join("");

  return `
  <div class="view-head row-between">
    <div><h1>Очередь желаний</h1><p>Единый список желаний — переносится из месяца в месяц. Купленное архивируется.</p></div>
    <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button>
  </div>
  <form class="quick-add card quick-add-smart" id="quickAddForm">
    <input name="title" placeholder="Быстро добавить желание..." required />
    <input name="cost" type="number" min="0" placeholder="Сумма" required />
    <select name="category">${state.meta.categories.map((c) => `<option value="${c.id}">${c.ru}</option>`).join("")}</select>
    <select name="type"><option value="should">Should</option><option value="must">Must</option><option value="nice">Nice</option></select>
    <select name="priority"><option value="3">Приоритет 3</option><option value="5">Приоритет 5</option><option value="4">Приоритет 4</option><option value="2">Приоритет 2</option><option value="1">Приоритет 1</option></select>
    <input name="deadline" type="date" title="Дедлайн" />
    <button class="btn btn-primary" type="submit">Добавить</button>
  </form>
  <div class="filters card">
    <input data-filter="q" placeholder="Поиск по желаниям..." value="${escapeAttr(q.q)}" />
    <select data-filter="layer"><option value="all">Все слои</option>${Object.entries(
      state.meta.layers,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${q.layer === k ? "selected" : ""}>${v.ru}</option>`,
      )
      .join("")}</select>
    <select data-filter="type"><option value="all">Все типы</option>${Object.entries(
      TYPE_LABELS,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${q.type === k ? "selected" : ""}>${v}</option>`,
      )
      .join("")}</select>
    <select data-filter="band"><option value="all">Все размеры</option>${state.meta.bands.map((b) => `<option value="${b.id}" ${q.band === b.id ? "selected" : ""}>${b.label}</option>`).join("")}</select>
    <select data-filter="status">${Object.entries(queueStatusLabel)
      .map(
        ([k, v]) =>
          `<option value="${k}" ${q.status === k ? "selected" : ""}>${v}</option>`,
      )
      .join("")}</select>
    <select id="mobileSort" class="mobile-sort"><option value="priority:desc">Сорт: приоритет ↓</option><option value="cost:desc">Стоимость ↓</option><option value="cost:asc">Стоимость ↑</option><option value="deadline:asc">Дедлайн ↑</option><option value="title:asc">Название ↑</option></select>
  </div>
  ${
    state.items.length && filtered.length
      ? `<div class="table-wrap queue-table"><table>
    <thead><tr>${th("title", "Желание")}${th("cost", "Стоимость")}<th>Накоплено</th>${th("layer", "Слой")}${th("category", "Категория")}${th("band", "Band")}${th("type", "Тип")}${th("priority", "Приоритет")}${th("deadline", "Дедлайн")}<th>Статус</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
      : richEmpty("≡", "Очередь желаний пока пустая", "Добавьте то, что хотите купить: от обязательных покупок до мечт. Потом cockpit сам покажет, что помещается в излишки.", "add-item", "+ Добавить желание")
  }
  ${state.items.length && !filtered.length ? richEmpty("⌕", "По фильтрам ничего не найдено", "Сбросьте поиск или выберите другой слой, тип или статус.") : ""}
  <div class="mobile-queue">${sortedItems(filtered)
    .map((it) => queueItemRow(it, "Свайп влево — куплено, вправо — удалить"))
    .join("")}</div>
  <div id="tradeoffBox"></div>`;
}

function viewInvestments() {
  const p = state.portfolio;
  const tabs = [
    { key: "overview", label: "Обзор" },
    { key: "assets", label: "Активы" },
    { key: "transactions", label: "Операции" },
    { key: "valuations", label: "Оценки" },
  ];
  const tabBtns = tabs
    .map(
      (t) =>
        `<button class="chip ${state.invTab === t.key ? "active" : ""}" data-inv-tab="${t.key}">${t.label}</button>`,
    )
    .join("");

  let content = "";
  if (state.invTab === "overview") content = investOverview(p);
  else if (state.invTab === "assets") content = investAssets(p);
  else if (state.invTab === "transactions") content = investTransactions(p);
  else if (state.invTab === "valuations") content = investValuations(p);

  return `<div class="view-head row-between">
    <div><h1>Инвестиции</h1><p>Отслеживайте активы, покупки/продажи и рыночную стоимость.</p></div>
  </div>
  <div class="chip-row" style="margin-bottom:14px">${tabBtns}</div>
  <div id="investContent">${content}</div>`;
}
function investOverview(p) {
  if (!p || !p.assets.length)
    return richEmpty("↗", "Портфель пока пустой", "Добавьте первый актив, чтобы отслеживать вложения, текущую стоимость и прибыль/убыток.", "add-asset", "+ Добавить актив");
  const total = p.totals;
  const allocations = p.assets
    .map(
      (a) =>
        `<div class="prop-row"><div class="row-between small"><b>${escapeHtml(a.name)}</b><span>${total.totalValue ? Math.round((a.currentValue / total.totalValue) * 100) : 0}%</span></div><div class="goal-mini"><div style="width:${total.totalValue ? (a.currentValue / total.totalValue) * 100 : 0}%"></div></div><div class="muted small">${fmt(a.currentValue)} ${fmtUsd(a.currentValue)} · ${a.type}</div></div>`,
    )
    .join("");
  const pnlClass = total.totalPnL >= 0 ? "green-num" : "red-num";
  const pnlPct =
    total.totalInvested > 0
      ? ((total.totalPnL / total.totalInvested) * 100).toFixed(1)
      : null;
  const pnlBadge =
    pnlPct != null
      ? `<span style="color:${total.totalPnL >= 0 ? "var(--green)" : "var(--red)"};font-size:14px;font-weight:700">${total.totalPnL >= 0 ? "+" : ""}${pnlPct}%</span>`
      : "";
  const chartHtml = `<div class="card pad-lg" style="margin-top:16px"><div class="stat-label">Динамика портфеля по месяцам</div><canvas id="portChart" class="chart-line"></canvas></div>`;
  return `
  <div class="grid cards">
    <div class="card"><div class="stat-label"><span class="stat-ico">💼</span> Стоимость портфеля</div><div class="stat-value">${fmt(total.totalValue)}</div><div class="stat-sub">${fmtUsd(total.totalValue)}</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">💸</span> Вложено</div><div class="stat-value sm">${fmt(total.totalInvested)}</div><div class="stat-sub">${fmtUsd(total.totalInvested)}</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">📊</span> Прибыль / Убыток</div><div class="stat-value sm ${pnlClass}">${fmt(total.totalPnL)}</div><div class="stat-sub">${fmtUsd(total.totalPnL)} ${pnlBadge}</div></div>
  </div>
  <div class="card pad-lg" style="margin-top:16px">
    <div class="row-between"><div class="stat-label">Распределение портфеля</div>
      <button class="btn btn-sm btn-outline" data-act="refresh-prices">🔄 Обновить цены</button></div>
    <div style="margin-top:14px">${allocations}</div>
  </div>
  ${chartHtml}`;
}
function investAssets(p) {
  const rows = p
    ? p.assets
        .map(
          (a) => `<div class="wallet-row">
    <div><b>${escapeHtml(a.name)}</b><div class="muted small">${a.type}${a.ticker ? " · " + a.ticker : ""}${a.currency ? " · цены " + escapeHtml(a.currency) : ""}</div></div>
    <div style="min-width:200px">
      <div class="row-between small"><span>${fmt(a.currentValue)}</span><span class="${a.totalPnL >= 0 ? "green-num" : "red-num"}">${a.totalPnL >= 0 ? "+" : ""}${fmt(a.totalPnL)}</span></div>
      <div class="muted small">кол-во: ${a.quantityHeld} · вложено: ${fmt(a.totalInvested)}</div>
    </div>
  </div>`,
        )
        .join("")
    : "";
  return `<div class="card pad-lg"><div class="row-between"><div class="section-title" style="margin:0">Активы</div><button class="btn btn-primary btn-sm" data-act="add-asset">+ Актив</button></div>
    <div style="margin-top:14px">${rows || '<p class="muted">Нет активов.</p>'}</div></div>`;
}
function investTransactions(p) {
  const rows = p
    ? p.transactions
        .map((t) => {
          const asset = p.assets.find((a) => a.id === t.assetId);
          return `<div class="wallet-row">
      <div><b>${escapeHtml(asset?.name || t.assetId)}</b><div class="muted small">${fmtDate(t.date)} · ${t.type === "buy" ? "Покупка" : "Продажа"}</div></div>
      <div style="min-width:180px">
        <div class="row-between small"><span>${t.quantity} × ${fmt(t.price)}</span><span>${fmt(t.totalAmount)}</span></div>
        <div class="muted small">комиссия: ${fmt(t.fee)}${t.note ? " · " + escapeHtml(t.note) : ""}</div>
      </div>
    </div>`;
        })
        .join("")
    : "";
  return `<div class="card pad-lg"><div class="row-between"><div class="section-title" style="margin:0">Операции покупки/продажи</div><button class="btn btn-primary btn-sm" data-act="add-tx">+ Операция</button></div>
    <div style="margin-top:14px">${rows || '<p class="muted">Нет операций.</p>'}</div></div>`;
}
function investValuations(p) {
  const rows = p
    ? p.valuations
        .map((v) => {
          const asset = p.assets.find((a) => a.id === v.assetId);
          return `<div class="wallet-row">
      <div><b>${escapeHtml(asset?.name || v.assetId)}</b><div class="muted small">${fmtDate(v.date)}${v.note ? " · " + escapeHtml(v.note) : ""}</div></div>
      <div class="stat-value sm">${fmt(v.value)}</div>
    </div>`;
        })
        .join("")
    : "";
  return `<div class="card pad-lg"><div class="row-between"><div class="section-title" style="margin:0">Ежемесячные оценки</div><button class="btn btn-primary btn-sm" data-act="add-valuation">+ Оценка</button></div>
    <div style="margin-top:14px">${rows || '<p class="muted">Добавьте оценку стоимости актива.</p>'}</div></div>`;
}

function viewWallets() {
  const total = walletTotal();
  const available = state.allocation?.totals?.availableToAllocate || 0;
  const rows = state.wallets
    .map(
      (w) => `<div class="wallet-row">
    <div><b>${escapeHtml(w.name || "Кошелёк")}</b><div class="muted small">${escapeHtml(w.purpose || "на этот месяц")}</div></div>
    <div style="min-width:170px"><div class="row-between small"><span>${fmt(w.amount)}</span><b>${total ? Math.round((w.amount / total) * 100) : 0}%</b></div><div class="goal-mini"><div style="width:${total ? (w.amount / total) * 100 : 0}%"></div></div></div>
    <button class="btn btn-sm btn-danger" data-act="delete-wallet" data-id="${w.id}" title="Удалить">×</button>
  </div>`,
    )
    .join("");
  return `<div class="view-head row-between">
    <div><h1>Кошельки месяца</h1><p>Карманы с суммой и назначением именно на текущий месяц.</p></div>
    <button class="btn btn-primary" data-act="add-wallet">+ Кошелёк</button>
  </div>
  <div class="grid cards">
    <div class="card"><div class="stat-label">В кошельках</div><div class="stat-value">${fmt(total)}</div><div class="stat-sub">${state.wallets.length} карманов</div></div>
    <div class="card"><div class="stat-label">Излишки после стабильных пунктов</div><div class="stat-value sm">${fmt(available)}</div><div class="stat-sub">${total > available ? "кошельки выше излишков" : "в пределах излишков"}</div></div>
  </div>
  <div class="card pad-lg" style="margin-top:16px"><div class="section-title" style="margin-top:0">Карманы</div>${rows || richEmpty("◫", "Кошельков ещё нет", "Создайте карманы для еды, транспорта, инвестиций и свободных трат — так остаток не смешивается.", "add-wallet", "+ Кошелёк")}</div>`;
}

function viewPlan() {
  if (!state.allocation)
    return `<div class="view-head"><h1>План распределения</h1></div>${noPlanBlock()}`;
  const a = state.allocation;
  const available = a.totals.availableToAllocate;
  const planned = manualPlanTotal();
  const sortedItems = [...state.items].sort(
    (a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0),
  );
  const manualRows = sortedItems
    .map((it) => {
      const amount = manualAmountFor(it.id);
      const gp = goalProgress(it);
      return `<div class="manual-row">
      <div><b>${escapeHtml(it.title)}</b><div class="muted small">${fmt(it.cost)} · накоплено ${fmt(gp.saved)}</div></div>
      <input type="number" min="0" value="${amount || ""}" placeholder="0" data-manual="${it.id}" />
    </div>`;
    })
    .join("");
  return `
  <div class="view-head row-between">
    <div><h1>План распределения</h1><p>Распределяйте только излишки после обязательных расходов, страховки и инвестиций; авто-план остаётся подсказкой рядом.</p></div>
    <button class="btn btn-outline" data-act="close-month">Закрыть месяц</button>
  </div>
  <div class="card pad-lg" style="margin-bottom:16px">
    <div class="row-between"><div><div class="section-title" style="margin:0">Ручной план</div><p class="muted small" style="margin:4px 0 0">Введите, сколько отправить на каждое желание в этом месяце.</p></div>
      <div><div class="stat-value sm ${planned > available ? "red-num" : "green-num"}">${fmt(planned)}</div><div class="muted small">из ${fmt(available)}</div></div></div>
    <div class="manual-list">${manualRows || richEmpty("🎯", "Пока нечего распределять", "Добавьте желания в очередь — здесь появится ручной план распределения излишков.", "add-item", "+ Добавить желание")}</div>
    <div class="row-between" style="margin-top:12px">
      <span class="${planned > available ? "red-num" : "muted"}">${planned > available ? "План выше доступного бюджета" : `Свободно ещё ${fmt(available - planned)}`}</span>
      <button class="btn btn-primary" data-act="save-manual-plan">Сохранить ручной план</button>
    </div>
  </div>`;
}

function viewMore() {
  return `<div class="view-head"><h1>Ещё</h1><p>Редкие разделы и настройки собраны здесь, чтобы нижняя навигация не перегружала телефон.</p></div>
    <div class="more-grid">
      <button class="card more-tile" data-act="go-view" data-target-view="wallets"><span>◫</span><b>Кошельки</b><p>Карманы текущего месяца</p></button>
      <button class="card more-tile" data-act="go-view" data-target-view="history"><span>↺</span><b>История</b><p>Закрытые месяцы и решения</p></button>
      <button class="card more-tile" data-act="go-view" data-target-view="assistant"><span>✦</span><b>AI-ассистент</b><p>Пояснения и trade-off</p></button>
      <button class="card more-tile" data-act="open-plan"><span>⚙</span><b>Настройки плана</b><p>Зарплата, расходы, резерв</p></button>
      <button class="card more-tile danger" id="logoutBtnMobileMore" type="button"><span>⏻</span><b>Выйти</b><p>Завершить сессию</p></button>
    </div>`;
}

function viewHistory() {
  if (!state.history.length) {
    return `<div class="view-head"><h1>История решений</h1><p>Закрытые месяцы появятся здесь.</p></div>
      ${richEmpty("↺", "История начнётся после первого закрытого месяца", "Когда зарплата распределена и решения выполнены — закройте месяц на экране плана, чтобы сохранить снимок.", "go-view", "Открыть план", "plan")}`;
  }
  return `<div class="view-head"><h1>История решений</h1><p>Что ты решал в прошлые месяцы: купленное, отложенное, остаток.</p></div>
    ${state.history
      .map((h) => {
        const s = h.snapshot || {};
        const t = s.totals || {};
        return `<div class="card pad-lg" style="margin-bottom:14px">
        <div class="row-between"><div><b>${escapeHtml(h.name)}</b> <span class="muted small">· зарплата ${fmtDate(h.payday)} · закрыт ${fmtDate(h.closedAt)}</span></div>
          <span class="status-badge status-${t.status || "safe"}">${STATUS_LABELS[t.status] || ""}</span></div>
        <div class="grid cards" style="margin-top:12px">
          <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value sm">${fmt(t.salary || h.salary)}</div></div>
          <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(t.allocated)}</div></div>
          <div class="card"><div class="stat-label">Осталось</div><div class="stat-value sm green-num">${fmt(t.remaining)}</div></div>
        </div>
        <div style="margin-top:12px"><span class="muted small">Куплено:</span> ${(s.approved || []).map((x) => escapeHtml(x.title)).join(", ") || "—"}</div>
        <div style="margin-top:6px"><span class="muted small">Отложено:</span> ${(s.deferred || []).map((x) => escapeHtml(x.title)).join(", ") || "—"}</div>
      </div>`;
      })
      .join("")}`;
}

// ---------- assistant ----------
let chatHistory = [];
function sanitizeChatMessage(message) {
  const role = message?.role === "assistant" ? "assistant" : "user";
  const content = String(message?.content || "")
    .slice(0, 4000)
    .trim();
  return content ? { role, content } : null;
}
function loadChatHistory() {
  try {
    const saved = localStorage.getItem("chatHistory");
    const parsed = saved ? JSON.parse(saved) : [];
    chatHistory = Array.isArray(parsed)
      ? parsed.map(sanitizeChatMessage).filter(Boolean).slice(-50)
      : [];
  } catch {
    chatHistory = [];
  }
}
function saveChatHistory() {
  try {
    const safeHistory = chatHistory
      .map(sanitizeChatMessage)
      .filter(Boolean)
      .slice(-50);
    chatHistory = safeHistory;
    localStorage.setItem("chatHistory", JSON.stringify(safeHistory));
  } catch {}
}
loadChatHistory();

function md(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^- (.+)/gm, "• $1")
    .replace(/\n/g, "<br>");
}

function viewAssistant() {
  const enabled = state.meta?.ai?.enabled;
  return `<div class="view-head"><h1>AI-ассистент</h1><p>Советует, что купить первым, что отложить и поясняет trade-off на основе твоего плана.</p></div>
  ${!enabled ? `<div class="tradeoff" style="background:rgba(245,177,61,.1);border-color:var(--amber)"><b style="color:var(--amber)">AI выключен.</b> Добавьте AI_PROVIDER и AI_API_KEY в окружение сервера, чтобы включить ассистента. Остальное приложение работает без него.</div>` : ""}
  ${enabled ? `<div class="tradeoff"><b>Приватность:</b> вопросы и краткий контекст плана (суммы, покупки, кошельки, портфель) отправляются выбранному AI-провайдеру. Не пишите PIN, ключи или другие секреты.</div>` : ""}
  <div class="chat" id="assistantRoot">
    <div class="chip-row">
      <button class="chip" data-q="Что мне купить в первую очередь в этом месяце?">Что купить первым?</button>
      <button class="chip" data-q="Что лучше отложить на следующую зарплату и почему?">Что отложить?</button>
      <button class="chip" data-q="Мой план выглядит сбалансированным? Дай короткую оценку.">Оценка плана</button>
      <button class="chip" data-q="Как дела у моего инвестиционного портфеля? Дай краткий анализ.">Портфель</button>
      <button class="chip" data-q="Посмотри мои финансы в целом. Что советуешь улучшить?">Общий совет</button>
      <button class="chip chip-clear" data-act="clear-chat">✕ Очистить</button>
    </div>
    <div class="chat-log" id="chatLog"></div>
    <div class="chip-row" id="suggestions" style="margin-bottom:8px"></div>
    <form class="chat-input" id="chatForm">
      <input id="chatInput" placeholder="Спросите про свой план..." ${enabled ? "" : "disabled"} autocomplete="off" />
      <button class="btn btn-primary" type="submit" ${enabled ? "" : "disabled"}>Спросить</button>
    </form>
  </div>`;
}
function chatMessageHtml(message) {
  const safe = sanitizeChatMessage(message);
  if (!safe) return "";
  return `<div class="msg ${safe.role}">${md(safe.content)}</div>`;
}

function initAssistant() {
  const log = $("#chatLog");
  log.innerHTML = chatHistory.map(chatMessageHtml).join("");
  log.scrollTop = log.scrollHeight;
  $$("#assistantRoot .chip").forEach((c) => {
    if (c.dataset.act === "clear-chat") return;
    c.addEventListener("click", () => {
      $("#chatInput").value = c.dataset.q;
      $("#chatForm").requestSubmit();
    });
  });
  $("#chatForm")?.addEventListener("submit", sendChat);
}
async function sendChat(e) {
  e.preventDefault();
  const input = $("#chatInput");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  chatHistory.push({ role: "user", content: text });
  saveChatHistory();
  const log = $("#chatLog");
  log.insertAdjacentHTML(
    "beforeend",
    `${chatMessageHtml({ role: "user", content: text })}<div class="msg bot" id="pending"><span class="typing">…</span></div>`,
  );
  log.scrollTop = log.scrollHeight;
  document.getElementById("suggestions").innerHTML = "";
  try {
    const res = await fetch("/api/ai/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: chatHistory }),
    });
    if (res.status === 401) {
      showAuthGate();
      throw new Error("unauthorized");
    }
    if (!res.ok) throw new Error(await res.text());
    if (!res.body) throw new Error("stream_unavailable");
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const pending = $("#pending");
    let reply = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      reply += dec.decode(value, { stream: true });
      pending.innerHTML = md(reply);
      log.scrollTop = log.scrollHeight;
    }
    chatHistory.push({ role: "assistant", content: reply });
    saveChatHistory();
    pending.removeAttribute("id");
    // suggested follow-ups
    const sug = document.getElementById("suggestions");
    const followUps = [
      "А что конкретно мне отложить?",
      "Какие риски я не учёл?",
      "Сколько останется после всего?",
      "Посоветуй, что изменить в плане",
    ];
    sug.innerHTML = followUps
      .map(
        (q) =>
          `<button class="chip" data-q="${escapeAttr(q)}">${escapeHtml(q)}</button>`,
      )
      .join("");
    sug.querySelectorAll(".chip").forEach((b) =>
      b.addEventListener("click", () => {
        $("#chatInput").value = b.dataset.q;
        $("#chatForm").requestSubmit();
      }),
    );
  } catch (ex) {
    $("#pending").outerHTML =
      `<div class="msg bot">❌ ${escapeHtml(ex.message)}<br><button class="chip" data-retry-chat="${escapeAttr(text)}">↻ Повторить</button></div>`;
    $("[data-retry-chat]")?.addEventListener("click", (event) => {
      $("#chatInput").value = event.currentTarget.dataset.retryChat || text;
      $("#chatForm").requestSubmit();
    });
  }
  $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
}

// ============================================================
// EVENTS (delegated)
// ============================================================
function bindViewEvents() {
  $$("[data-act]").forEach((el) => {
    if (el._bound) return;
    el._bound = true;
    el.addEventListener("click", async () => {
      const act = el.dataset.act;
      const id = Number(el.dataset.id);
      if (act === "open-plan") openPlanModal();
      else if (act === "add-item") openItemModal();
      else if (act === "save-goal")
        openSavingsModal(state.items.find((i) => i.id === id));
      else if (act === "add-asset") openAssetModal();
      else if (act === "add-tx") openTxModal();
      else if (act === "add-valuation") openValuationModal();
      else if (act === "add-wallet") openWalletModal();
      else if (act === "save-manual-plan") saveManualPlan();
      else if (act === "edit")
        openItemModal(state.items.find((i) => i.id === id));
      else if (act === "bought") await markBought(id);
      else if (act === "tradeoff") await showTradeoff(id);
      else if (act === "close-month") closeMonth();
      else if (act === "ai-explain") await explainItem(id);
      else if (act === "delete") await deleteItem(id);
      else if (act === "delete-wallet") await deleteWallet(el.dataset.id);
      else if (act === "go-view") setView(el.dataset.targetView || "dashboard");
      else if (act === "dismiss-onboarding") {
        localStorage.setItem("onboardingDismissed", "1");
        closeModal();
        renderView();
      }
      else if (act === "refresh-prices") await refreshPrices();
      else if (act === "clear-chat") {
        chatHistory = [];
        saveChatHistory();
        $("#chatLog").innerHTML = "";
        document.getElementById("suggestions").innerHTML = "";
      }
    });
  });
  $$(".queue-swipe").forEach((row) => bindSwipe(row));
  $("#quickAddForm")?.addEventListener("submit", quickAddItem);
  $$(".th-sort").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.sort;
      state.queueSort = {
        key,
        dir:
          state.queueSort.key === key && state.queueSort.dir === "desc"
            ? "asc"
            : "desc",
      };
      renderView();
    }),
  );
  $("#mobileSort")?.addEventListener("change", (e) => {
    const [key, dir] = e.target.value.split(":");
    state.queueSort = { key, dir };
    renderView();
  });
  $$("[data-filter]").forEach((el) =>
    el.addEventListener("input", () => {
      state.queueFilters[el.dataset.filter] = el.value;
      renderView();
    }),
  );
  $$("[data-inv-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.invTab = btn.dataset.invTab;
      renderView();
    }),
  );
  $("#logoutBtnMobileMore")?.addEventListener("click", doLogout);
}

async function quickAddItem(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  const category = f.get("category") || "lifestyle";
  const priority = Number(f.get("priority") || 3);
  await api.post("/api/items", {
    title: f.get("title"),
    cost: +f.get("cost"),
    type: f.get("type"),
    category,
    priority,
    deadline: f.get("deadline") || null,
    emotional: 3,
    trajectory: category === "tool" || category === "growth" ? 4 : 3,
    canDefer: f.get("type") !== "must",
    scoreType: "none",
  });
  toast("Желание добавлено");
  await refresh();
}

async function exportData() {
  const data = await api.get("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `capital-queue-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(e) {
  try {
    const file = e.target.files?.[0];
    if (!file) return;
    const data = JSON.parse(await file.text());
    const isFullBackup = Array.isArray(data.plans) && Array.isArray(data.items);
    if (
      isFullBackup &&
      !confirm(
        "Это полный backup. Текущие планы, желания, кошельки и инвестиции будут заменены. Продолжить?",
      )
    )
      return;
    const result = await api.post("/api/import", data);
    closeModal();
    toast(result.mode === "full" ? "Backup восстановлен" : "Импортировано");
    await refresh();
  } catch (ex) {
    toast("Ошибка импорта: " + ex.message);
  } finally {
    if (e.target) e.target.value = "";
  }
}

async function markBought(id) {
  await api.post(`/api/items/${id}/status`, { status: "bought" });
  toast("Отмечено как купленное");
  await refresh();
}

async function deleteItem(id) {
  const item = state.items.find((i) => i.id === id);
  const ok = await confirmDialog({
    title: "Удалить желание?",
    text: `«${item?.title || "Желание"}» будет удалено из очереди и планов. Если покупка уже сделана — лучше отметьте её купленной.`,
    confirmText: "Удалить навсегда",
    danger: true,
  });
  if (!ok) return;
  await api.del(`/api/items/${id}`);
  toast("Удалено");
  await refresh();
}

function bindSwipe(row) {
  let startX = 0;
  row.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
    },
    { passive: true },
  );
  row.addEventListener(
    "touchend",
    async (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) < 80) return;
      if (dx < 0) await markBought(Number(row.dataset.id));
      else await deleteItem(Number(row.dataset.id));
    },
    { passive: true },
  );
}

async function showTradeoff(id) {
  const box = $("#tradeoffBox");
  const t = await api.get(`/api/tradeoff/${id}?scenario=balanced`);
  const item = state.items.find((i) => i.id === id);
  let html;
  if (t.approved) {
    html = `<b>${escapeHtml(item.title)}</b> уже в плане. Если отказаться — освободится <b>${fmt(t.freedIfRemoved)}</b>, останется <b>${fmt(t.remainingIfRemoved)}</b>.`;
  } else {
    html = `Если купить <b>${escapeHtml(item.title)}</b> (${fmt(item.cost)}) — останется <b>${fmt(t.remainingIfAdded)}</b>.`;
    if (t.belowReserve || t.belowBuffer)
      html += ` ⚠️ Резерв опустится ниже безопасного уровня.`;
    if (t.displaces?.length)
      html += `<br>Это вытеснит: ${t.displaces.map((d) => escapeHtml(d.title)).join(", ")}.`;
  }
  box.innerHTML = `<div class="tradeoff">${html}</div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function explainItem(id) {
  const box = $("#tradeoffBox");
  box.innerHTML = '<div class="tradeoff">AI думает…</div>';
  try {
    const out = await api.post("/api/ai/explain", {
      itemId: id,
      scenario: "balanced",
    });
    box.innerHTML = `<div class="tradeoff"><b>Почему так:</b><br>${escapeHtml(out.reply)}</div>`;
  } catch (ex) {
    box.innerHTML = `<div class="tradeoff">AI недоступен: ${escapeHtml(ex.message)}</div>`;
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function saveManualPlan() {
  const manualPlan = $$("[data-manual]").map((el) => ({
    itemId: Number(el.dataset.manual),
    amount: Number(el.value) || 0,
  }));
  await api.post("/api/manual-plan", { manualPlan });
  toast("Ручной план сохранён");
  await refresh();
}

async function closeMonth() {
  if (
    !confirm(
      "Закрыть месяц? Одобренные покупки уйдут в архив (купленные), отложенные останутся в очереди на следующую зарплату.",
    )
  )
    return;
  await api.post("/api/plan/close", { scenario: "balanced" });
  toast("Месяц закрыт и сохранён в истории");
  await refresh();
}

async function deleteWallet(id) {
  const wallet = state.wallets.find((w) => String(w.id) === String(id));
  const ok = await confirmDialog({
    title: "Удалить кошелёк?",
    text: `Кошелёк «${wallet?.name || "без названия"}» исчезнет из текущего месяца. Деньги в истории не меняются.`,
    confirmText: "Удалить",
    danger: true,
  });
  if (!ok) return;
  await api.del(`/api/wallets/${id}`);
  toast("Кошелёк удалён");
  await refresh();
}

async function refreshPrices() {
  toast("Обновление цен...");
  try {
    await api.post("/api/investments/refresh-prices");
    toast("Цены обновлены");
    await refresh();
  } catch (ex) {
    toast("Ошибка: " + ex.message);
  }
}

async function downloadCSV(type) {
  try {
    const resp = await fetch(`/api/export/csv/${type}`);
    if (resp.status === 401) {
      showAuthGate();
      return toast("Сессия истекла");
    }
    if (!resp.ok) return toast("Ошибка загрузки CSV");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    toast("CSV скачан");
  } catch (e) {
    console.error("CSV error", e);
    toast("Ошибка: " + e.message);
  }
}

// ============================================================
// MODALS
// ============================================================
function openModal(html) {
  $("#modalRoot").innerHTML =
    `<div class="modal-overlay" id="ov">${html}</div>`;
  $("#ov").addEventListener("click", (e) => {
    if (e.target.id === "ov") closeModal();
  });
  $$("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", closeModal),
  );
}
function closeModal() {
  $("#modalRoot").innerHTML = "";
}

function confirmDialog({ title, text, confirmText = "Подтвердить", cancelText = "Отмена", danger = false }) {
  return new Promise((resolve) => {
    openModal(`<div class="modal narrow confirm-modal">
      <div class="modal-head"><h2>${escapeHtml(title)}</h2><button class="close-x" data-confirm="0">×</button></div>
      <p class="muted">${escapeHtml(text)}</p>
      <div class="confirm-note">Это действие нельзя отменить автоматически.</div>
      <div class="modal-foot">
        <button type="button" class="btn btn-ghost" data-confirm="0">${escapeHtml(cancelText)}</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-confirm="1">${escapeHtml(confirmText)}</button>
      </div>
    </div>`);
    $$("[data-confirm]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const yes = btn.dataset.confirm === "1";
        closeModal();
        resolve(yes);
      }),
    );
  });
}

function openQuickItemModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Быстро добавить желание</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="quickItemForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" required /></div>
      <div class="field"><label>Сумма</label><input name="cost" type="number" min="0" required /></div>
      <div class="field"><label>Тип</label><select name="type"><option value="should">Should</option><option value="must">Must</option><option value="nice">Nice</option></select></div>
      <div class="modal-foot field full" style="flex-direction:row"><button type="button" class="btn btn-ghost" data-close-modal>Отмена</button><button class="btn btn-primary">Добавить</button></div>
    </form></div>`);
  $("#quickItemForm").addEventListener("submit", quickAddItem);
}

function openDataModal() {
  const goalRows = state.items
    .map((it) => {
      const gp = goalProgress(it);
      return `<div class="wallet-row"><div><b>${escapeHtml(it.title)}</b><div class="muted small">${fmt(gp.saved)} / ${fmt(gp.cost)}${gp.monthsLeft ? ` · ~${gp.monthsLeft} мес.` : ""}</div></div>
      <button class="btn btn-sm btn-outline" data-act="save-goal" data-id="${it.id}">Цель</button></div>`;
    })
    .join("");
  openModal(`<div class="modal">
    <div class="modal-head"><h2>Данные и цели</h2><button class="close-x" data-close-modal>×</button></div>
    <div class="grid cards">
      <button class="btn btn-primary" id="exportBtn" type="button">Экспорт JSON</button>
      <label class="btn btn-outline" style="text-align:center">Импорт JSON<input id="importFile" type="file" accept="application/json" hidden></label>
      <button class="btn btn-outline" id="csvItemsBtn">CSV желания</button>
      <button class="btn btn-outline" id="csvTxBtn">CSV операции</button>
      <button class="btn btn-outline" id="csvValBtn">CSV оценки</button>
    </div>
    <div class="section-title">Курс USD</div>
    <div style="display:flex;gap:10px;align-items:center">
      <input type="number" id="currencyRateInput" value="${state.currencyRate}" min="1" step="0.1" style="width:120px;background:var(--bg-2);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;color:var(--text);font-size:14px" />
      <button class="btn btn-primary btn-sm" id="saveRateBtn">Сохранить курс</button>
    </div>
    <div class="section-title">Цели-накопления</div>
    <div>${goalRows || '<p class="muted">Пока нет желаний.</p>'}</div>
  </div>`);
  $("#exportBtn").addEventListener("click", exportData);
  $("#importFile").addEventListener("change", importData);
  $("#csvItemsBtn").addEventListener("click", () => downloadCSV("items"));
  $("#csvTxBtn").addEventListener("click", () => downloadCSV("transactions"));
  $("#csvValBtn").addEventListener("click", () => downloadCSV("valuations"));
  $("#saveRateBtn").addEventListener("click", async () => {
    const rate = +$("#currencyRateInput").value;
    if (rate < 1) return toast("Некорректный курс");
    await api.post("/api/currency", { rate });
    state.currencyRate = rate;
    closeModal();
    toast("Курс сохранён");
    await refresh();
  });
  bindViewEvents();
}

function openPlanModal() {
  const p = state.plan || {
    name: "Зарплата",
    payday: new Date().toISOString().slice(0, 10),
    ...state.meta.defaults,
  };
  const reservePct = p.salary
    ? Math.round((Number(p.buffer || 0) / Number(p.salary)) * 100)
    : 0;
  const investPct = p.salary
    ? Math.round((Number(p.investmentFixed || 0) / Number(p.salary)) * 100)
    : 0;
  openModal(`<div class="modal">
    <div class="modal-head"><h2>Стабильные пункты зарплаты</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="planForm" class="form-grid">
      <div class="field full"><label>Название (например, «Зарплата июнь»)</label><input name="name" value="${escapeAttr(p.name)}" /></div>
      <div class="field"><label>Дата зарплаты</label><input type="date" name="payday" value="${p.payday}" /></div>
      <div class="field"><label>Зарплата, грн</label><input type="number" name="salary" value="${p.salary}" min="0" /></div>
      <div class="field"><label>Обязательные расходы, грн</label><input type="number" name="survivalCost" value="${p.survivalCost}" min="0" />
        <span class="muted small">стабильные траты, которые списываются первыми</span></div>
      <div class="field"><label>Страховка, грн</label><input type="number" name="buffer" value="${p.buffer}" min="0" />
        <span class="muted small">на чёрный день, не трогаем. Сейчас ~${reservePct}% от зп</span></div>
      <div class="field"><label>Инвестиции, грн</label><input type="number" name="investmentFixed" value="${p.investmentFixed || 0}" min="0" />
        <span class="muted small">стабильно отложить с зарплаты. Сейчас ~${investPct}% от зп</span></div>
      <div class="field full"><span class="muted small">Излишки после этих пунктов пойдут в желания, кошельки и ручной план распределения.</span></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $("#planForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post("/api/plan", {
      name: f.get("name"),
      payday: f.get("payday"),
      salary: +f.get("salary"),
      survivalCost: +f.get("survivalCost"),
      buffer: +f.get("buffer"),
      investmentFixed: +f.get("investmentFixed"),
    });
    closeModal();
    toast("Зарплата сохранена");
    await refresh();
  });
}

function openSavingsModal(item) {
  if (!item) return;
  const gp = goalProgress(item);
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Копить на желание</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="savingsForm" class="form-grid">
      <div class="field full"><label>Желание</label><input value="${escapeAttr(item.title)}" disabled /></div>
      <div class="field"><label>Цена</label><input value="${fmt(item.cost)}" disabled /></div>
      <div class="field"><label>Уже накоплено, грн</label><input type="number" name="savedAmount" min="0" value="${gp.saved}" /></div>
      <div class="field"><label>Откладывать в месяц, грн</label><input type="number" name="monthlyContribution" min="0" value="${gp.monthly || 0}" /></div>
      <div class="field full"><div class="goal-mini big"><div style="width:${gp.pct}%"></div></div><span class="muted small">${gp.pct}% · осталось ${fmt(gp.left)}</span></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $("#savingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post(`/api/items/${item.id}/savings`, {
      savedAmount: +f.get("savedAmount"),
      monthlyContribution: +f.get("monthlyContribution"),
    });
    closeModal();
    toast("Накопление обновлено");
    await refresh();
  });
}

function openAssetModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Добавить актив</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="assetForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="name" placeholder="BTC, ETF, депозит..." required /></div>
      <div class="field"><label>Тип</label><select name="type"><option value="crypto">Крипто</option><option value="stock">Акция</option><option value="etf">ETF</option><option value="bond">Облигация</option><option value="deposit">Депозит</option><option value="other">Другое</option></select></div>
      <div class="field"><label>Тикер (опц.)</label><input name="ticker" placeholder="BTC, AAPL..." /></div>
      <div class="field full"><label>Валюта автоцен</label><select name="currency"><option value="USD">USD — внешние цены конвертировать в грн</option><option value="UAH">UAH — цена уже в гривне</option></select>
        <span class="hint">Покупки и ручные оценки вводите в гривнах; поле нужно для автообновления цен.</span></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $("#assetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post("/api/investments/assets", {
      name: f.get("name"),
      type: f.get("type"),
      ticker: f.get("ticker"),
      currency: f.get("currency"),
    });
    closeModal();
    toast("Актив добавлен");
    await refresh();
  });
}

function openTxModal() {
  const assetOpts = (state.portfolio?.assets || [])
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
    .join("");
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Операция покупки/продажи</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="txForm" class="form-grid">
      <div class="field full"><label>Актив</label><select name="assetId" required>${assetOpts || "<option>Сначала добавьте актив</option>"}</select></div>
      <div class="field"><label>Тип</label><select name="type"><option value="buy">Покупка</option><option value="sell">Продажа</option></select></div>
      <div class="field"><label>Дата</label><input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Количество</label><input type="number" name="quantity" min="0" step="any" required /></div>
      <div class="field"><label>Цена за единицу</label><input type="number" name="price" min="0" step="any" required /></div>
      <div class="field"><label>Комиссия</label><input type="number" name="fee" min="0" step="any" value="0" /></div>
      <div class="field full"><label>Заметка</label><input name="note" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $("#txForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post("/api/investments/transactions", {
      assetId: f.get("assetId"),
      type: f.get("type"),
      date: f.get("date"),
      quantity: +f.get("quantity"),
      price: +f.get("price"),
      fee: +f.get("fee"),
      note: f.get("note"),
    });
    closeModal();
    toast("Операция сохранена");
    await refresh();
  });
}

function openValuationModal() {
  const assetOpts = (state.portfolio?.assets || [])
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`)
    .join("");
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Ежемесячная оценка</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="valForm" class="form-grid">
      <div class="field full"><label>Актив</label><select name="assetId" required>${assetOpts || "<option>Сначала добавьте актив</option>"}</select></div>
      <div class="field"><label>Дата</label><input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Текущая стоимость</label><input type="number" name="value" min="0" required /></div>
      <div class="field full"><label>Заметка</label><input name="note" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $("#valForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post("/api/investments/valuations", {
      assetId: f.get("assetId"),
      date: f.get("date"),
      value: +f.get("value"),
      note: f.get("note"),
    });
    closeModal();
    toast("Оценка сохранена");
    await refresh();
  });
}

function openWalletModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Новый кошелёк месяца</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="walletForm" class="form-grid">
      <div class="field full"><label>Название кармана</label><input name="name" placeholder="На AirPods / еда / транспорт" required /></div>
      <div class="field"><label>Сумма, грн</label><input type="number" name="amount" min="0" required /></div>
      <div class="field"><label>На что пойдёт</label><input name="purpose" placeholder="цель на этот месяц" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $("#walletForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const wallets = [
      {
        id: Date.now(),
        name: f.get("name"),
        purpose: f.get("purpose"),
        amount: +f.get("amount"),
      },
      ...state.wallets,
    ];
    await api.post("/api/wallets", { wallets });
    closeModal();
    toast("Кошелёк добавлен");
    await refresh();
  });
}

function clientBand(cost) {
  const c = Number(cost) || 0;
  for (const b of state.meta.bands) {
    if (b.max == null || c < b.max) return b.id;
  }
  return "major";
}

function openItemModal(item) {
  const i = item || {
    title: "",
    cost: "",
    category: "lifestyle",
    layer: "",
    priority: 3,
    type: "should",
    deadline: "",
    earliestDate: "",
    canDefer: true,
    emotional: 3,
    trajectory: 3,
    notes: "",
    scoreType: "none",
    scores: {},
  };
  const scores = i.scores || {};
  const catOpts = state.meta.categories
    .map(
      (c) =>
        `<option value="${c.id}" ${c.id === i.category ? "selected" : ""}>${c.ru} · ${c.label}</option>`,
    )
    .join("");
  const layerOpts = Object.entries(state.meta.layers)
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === (i.layer || i.bucket) ? "selected" : ""}>${v.ru} · ${v.label}</option>`,
    )
    .join("");
  const range = (
    name,
    val,
    label,
  ) => `<div class="field"><label>${label}</label><div class="range-row">
      <input type="range" name="${name}" min="1" max="5" value="${val}" oninput="this.nextElementSibling.textContent=this.value">
      <span class="range-val">${val}</span></div></div>`;
  const critRow = (c) => `<div class="score-row" data-crit="${c.id}">
      <div><div class="sr-label">${c.ru} ${c.dir === "neg" ? '<span class="muted small">(чем меньше — тем лучше)</span>' : ""}</div><div class="sr-hint">${c.hint}</div></div>
      <div class="range-row"><input type="range" class="score-input" data-id="${c.id}" data-dir="${c.dir}" min="1" max="5" value="${scores[c.id] || 3}">
        <span class="range-val">${scores[c.id] || 3}</span></div>
    </div>`;
  const quickRows = state.meta.scoreCriteria.quick.map(critRow).join("");
  const fullRows = state.meta.scoreCriteria.full.map(critRow).join("");

  openModal(`<div class="modal">
    <div class="modal-head"><h2>${item ? "Редактировать желание" : "Новое желание"}</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="itemForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" value="${escapeAttr(i.title)}" required /></div>
      <div class="field"><label>Стоимость, грн</label><input type="number" id="costInput" name="cost" value="${i.cost}" min="0" required /></div>
      <div class="field"><label>Band (авто по сумме)</label><input id="bandDisplay" value="" disabled style="opacity:.8" /></div>
      <div class="field"><label>Категория покупки</label><select name="category" id="catSelect">${catOpts}</select></div>
      <div class="field"><label>Слой капитала</label><select name="layer" id="layerSelect">${layerOpts}</select>
        <span class="hint">Подставляется из категории, можно изменить.</span></div>
      <div class="field"><label>Тип</label><select name="type">
        <option value="must" ${i.type === "must" ? "selected" : ""}>Must-have (обязательно)</option>
        <option value="should" ${i.type === "should" ? "selected" : ""}>Should-have (желательно)</option>
        <option value="nice" ${i.type === "nice" ? "selected" : ""}>Nice-to-have (по желанию)</option>
      </select></div>
      ${range("priority", i.priority, "Приоритет 1–5")}
      <div class="field"><label>Дедлайн (если есть)</label><input type="date" name="deadline" value="${i.deadline || ""}" /></div>
      <div class="field"><label>Не раньше даты (если есть)</label><input type="date" name="earliestDate" value="${i.earliestDate || ""}" /></div>
      ${range("emotional", i.emotional, "Эмоциональное желание 1–5")}
      ${range("trajectory", i.trajectory, "Долгосрочная ценность 1–5")}
      <div class="field full"><label class="switch-row"><input type="checkbox" name="canDefer" ${i.canDefer ? "checked" : ""} style="width:18px;height:18px;accent-color:var(--accent)"> Можно отложить на следующую зарплату</label></div>
      <div class="field full"><label>Заметки</label><textarea name="notes">${escapeHtml(i.notes || "")}</textarea></div>

      <div class="subhead">Оценка покупки</div>
      <div class="field full"><label>Тип оценки</label><select name="scoreType" id="scoreType">
        <option value="none" ${i.scoreType === "none" ? "selected" : ""}>Без оценки</option>
        <option value="quick" ${i.scoreType === "quick" ? "selected" : ""}>Quick — 5 критериев (для Medium)</option>
        <option value="full" ${i.scoreType === "full" ? "selected" : ""}>Full — 13 критериев (для Large / Major)</option>
      </select><span class="hint" id="scoreHint"></span></div>
      <div class="field full hidden" id="verdictBanner"></div>
      <div class="field full hidden" id="quickWrap"><div class="score-grid">${quickRows}</div></div>
      <div class="field full hidden" id="fullWrap"><div class="subhead" style="margin-top:0">Дополнительно (Full)</div><div class="score-grid">${fullRows}</div></div>

      <div class="modal-foot field full" style="flex-direction:row;justify-content:space-between">
        <div>${item ? `<button type="button" class="btn btn-danger" id="delItem">Удалить</button>` : ""}</div>
        <div style="display:flex;gap:10px">
          <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
          <button type="submit" class="btn btn-primary">Сохранить</button>
        </div>
      </div>
    </form></div>`);

  const costInput = $("#costInput");
  const bandDisplay = $("#bandDisplay");
  const catSelect = $("#catSelect");
  const layerSelect = $("#layerSelect");
  const scoreTypeSel = $("#scoreType");
  let layerTouched = !!(item && (item.layer || item.bucket)); // слой следует за категорией, пока его не трогали
  if (!layerTouched) {
    const c0 = catObj(catSelect.value);
    if (c0) layerSelect.value = c0.layer;
  }

  function collectScores() {
    const s = {};
    $$(".score-input").forEach((el) => {
      s[el.dataset.id] = +el.value;
    });
    return s;
  }
  function refreshBand() {
    const band = clientBand(costInput.value);
    bandDisplay.value = bandLabel(band);
    const rec =
      band === "large" || band === "major"
        ? "Full"
        : band === "medium"
          ? "Quick"
          : "—";
    $("#scoreHint").textContent =
      rec === "—"
        ? "Для мелких покупок оценка не нужна."
        : `Рекомендуется: ${rec}.`;
  }
  function refreshVerdict() {
    const v = clientVerdict(scoreTypeSel.value, collectScores());
    const banner = $("#verdictBanner");
    if (!v) {
      banner.classList.add("hidden");
      return;
    }
    banner.classList.remove("hidden");
    const col =
      v.verdict === "keep"
        ? "var(--green)"
        : v.verdict === "drop"
          ? "var(--red)"
          : "var(--amber)";
    banner.innerHTML = `<div class="verdict-banner" style="background:color-mix(in srgb, ${col} 14%, transparent);color:${col}">
      <span>Вердикт: ${VERDICT_LABELS[v.verdict]}</span><span>${v.score}/100</span></div>`;
  }
  function refreshScoreSections() {
    const t = scoreTypeSel.value;
    $("#quickWrap").classList.toggle("hidden", t === "none");
    $("#fullWrap").classList.toggle("hidden", t !== "full");
    refreshVerdict();
  }

  costInput.addEventListener("input", refreshBand);
  catSelect.addEventListener("change", () => {
    if (!layerTouched) {
      const c = catObj(catSelect.value);
      if (c) layerSelect.value = c.layer;
    }
  });
  layerSelect.addEventListener("change", () => {
    layerTouched = true;
  });
  scoreTypeSel.addEventListener("change", refreshScoreSections);
  $$(".score-input").forEach((el) =>
    el.addEventListener("input", (e) => {
      e.target.nextElementSibling.textContent = e.target.value;
      refreshVerdict();
    }),
  );
  refreshBand();
  refreshScoreSections();

  $("#itemForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scoreType = f.get("scoreType");
    const payload = {
      title: f.get("title"),
      cost: +f.get("cost"),
      category: f.get("category"),
      layer: f.get("layer"),
      type: f.get("type"),
      priority: +f.get("priority"),
      emotional: +f.get("emotional"),
      trajectory: +f.get("trajectory"),
      deadline: f.get("deadline") || null,
      earliestDate: f.get("earliestDate") || null,
      canDefer: f.get("canDefer") === "on",
      notes: f.get("notes"),
      scoreType,
      scores: scoreType === "none" ? null : collectScores(),
    };
    if (item) await api.put(`/api/items/${item.id}`, payload);
    else await api.post("/api/items", payload);
    closeModal();
    toast("Сохранено");
    await refresh();
  });
  if (item)
    $("#delItem")?.addEventListener("click", async () => {
      const ok = await confirmDialog({
        title: "Удалить желание навсегда?",
        text: `«${item.title}» будет удалено из очереди, накоплений и ручного плана.`,
        confirmText: "Удалить",
        danger: true,
      });
      if (!ok) return;
      await api.del(`/api/items/${item.id}`);
      closeModal();
      toast("Удалено");
      await refresh();
    });
}

// ---------- util ----------
function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

let deferredInstallPrompt = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $("#installBtn")?.classList.remove("hidden");
});
$("#installBtn")?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $("#installBtn")?.classList.add("hidden");
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js?v=20260605-ux1").then((registration) => {
    registration.update?.();
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!sessionStorage.getItem("cq-sw-refreshed-20260605-ux1")) {
      sessionStorage.setItem("cq-sw-refreshed-20260605-ux1", "1");
      location.reload();
    }
  });
}

// ============================================================
// СИНХРОНИЗАЦИЯ ДАННЫХ МЕЖДУ ВКЛАДКАМИ И УСТРОЙСТВАМИ
// ------------------------------------------------------------
// Любое изменение в одной вкладке мгновенно подхватывается другими
// вкладками этого браузера (BroadcastChannel + событие storage),
// а вкладки на других устройствах догоняют опросом /api/version.
// Перерисовку откладываем, пока открыта модалка или пользователь
// печатает, чтобы не сбить ввод.
// ============================================================
const SYNC_CHANNEL = (() => {
  try {
    return new BroadcastChannel("cq-sync");
  } catch {
    return null;
  }
})();
let lastKnownVersion = null;
let lastLocalChange = 0;
let syncing = false;
let pendingSync = false;

function appIsActive() {
  const app = $("#app");
  return app && !app.classList.contains("hidden");
}

function syncIsSafe() {
  if ($("#modalRoot")?.firstChild) return false; // открыта модалка
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false; // идёт ввод
  return true;
}

function notifyDataChanged() {
  lastLocalChange = Date.now();
  try {
    SYNC_CHANNEL?.postMessage({ t: "changed", at: lastLocalChange });
  } catch {}
  try {
    localStorage.setItem("cq-sync", String(lastLocalChange));
  } catch {}
}

async function syncFromRemote() {
  if (syncing || !appIsActive()) return;
  if (!syncIsSafe()) {
    pendingSync = true;
    return;
  }
  pendingSync = false;
  syncing = true;
  try {
    await refresh();
  } catch {
  } finally {
    syncing = false;
  }
}

async function pollVersion() {
  if (document.hidden || !appIsActive()) return;
  let version;
  try {
    ({ version } = await api.get("/api/version"));
  } catch {
    return;
  }
  if (lastKnownVersion === null) {
    lastKnownVersion = version;
    return;
  }
  if (version === lastKnownVersion) return;
  lastKnownVersion = version;
  // Своё же изменение уже отрисовано локально — не дёргаем повторно.
  if (Date.now() - lastLocalChange < 6000) return;
  await syncFromRemote();
}

if (SYNC_CHANNEL)
  SYNC_CHANNEL.onmessage = (e) => {
    if (e?.data?.t === "changed") syncFromRemote();
  };
window.addEventListener("storage", (e) => {
  if (e.key === "cq-sync") syncFromRemote();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pollVersion();
});
// Когда закрывается модалка / уходит фокус — досинхронизируем отложенное.
document.addEventListener("click", () => {
  if (pendingSync && syncIsSafe()) syncFromRemote();
});
setInterval(pollVersion, 5000);

bootstrap().catch((e) => console.error(e));
