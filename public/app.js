// Salary Allocation Planner — фронтенд (vanilla JS).
// План 11.1 этап 1: библиотеки вынесены в lib/ (api, dom, format, charts).
import { api, configureApi } from "./lib/api.js?v=__STATIC_VERSION__";
import { $, $$, toast, confettiBurst } from "./lib/dom.js?v=__STATIC_VERSION__";
import {
  fmt,
  fmtShort,
  fmtDate,
  roundPercents,
  escapeHtml,
  escapeAttr,
  TYPE_LABELS,
  STATUS_LABELS,
  VERDICT_LABELS,
  queueStatusLabel,
  wishEmojiTag,
} from "./lib/format.js?v=__STATIC_VERSION__";
import {
  cssVar,
  drawDonut,
  drawLine,
  drawBars,
} from "./lib/charts.js?v=__STATIC_VERSION__";

// Инъекция зависимостей в HTTP-клиент: демо-режим, auth-гейт, тосты,
// уведомление вкладок об изменении данных.
configureApi({
  isDemo: () => state.demo,
  onDemoWrite: () => toast("Это демо — изменения не сохраняются"),
  onUnauthorized: () => showAuthGate(),
  onMutation: () => notifyDataChanged(),
});



// ---------- state ----------
const state = {
  authed: false,
  demo: false,
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
const fmtUsd = (n) =>
  state.currencyRate > 0
    ? `(~$${((Number(n) || 0) / state.currencyRate).toLocaleString("ru-RU", { maximumFractionDigits: 0 })})`
    : "";
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
function catLabelShort(id) {
  const c = catObj(id);
  return c ? c.ru : id;
}

function bandLabel(id) {
  const b = state.meta?.bands?.find((x) => x.id === id);
  return b ? b.ru || b.label : id;
}
function overallocTitle(t) {
  return t.statusReason === "must_unfunded" ? "Не хватает на обязательное." : "Перерасход.";
}
function overallocText(t) {
  if (t.statusReason === "stable_over_salary")
    return "База (обязательные траты + страховка + инвестиции) больше зарплаты — пересмотрите стабильные расходы в настройках плана.";
  if (t.statusReason === "must_unfunded") {
    const names = (t.unfundedMust || []).map((x) => escapeHtml(x)).join(", ");
    return `Свободного бюджета не хватает на: ${names || "обязательные покупки"}. Остаток уходит в накопление на них — желания подождут.`;
  }
  return "Распределено больше, чем доступно — откройте «План распределения» и перенесите лишнее.";
}
function drawCharts() {
  const donut = $("#donutAlloc");
  if (donut && state.allocation) {
    const t = state.allocation.totals;
    const segs = [
      { value: t.survival, color: cssVar("--layer-base", "#64708f") },
      { value: t.reserve, color: cssVar("--accent", "#2f6bff") },
      { value: t.fixedInvestment, color: cssVar("--color-positive", "#16a34a") },
    ];
    Object.entries(committedBuckets())
      .filter(([, v]) => v > 0)
      .forEach(([k, v]) => segs.push({ value: v, color: layerColor(k) }));
    const rem = remainingSurplus();
    if (rem > 0) segs.push({ value: rem, color: cssVar("--border", "#ccd") });
    // Центр = сумма кольца (аудит 7.2): глаз читает «число в центре — это всё кольцо».
    // Кольцо — вся зарплата по слоям, значит в центре — зарплата целиком.
    const ringTotal = segs.reduce((a, x) => a + Math.max(0, x.value || 0), 0);
    drawDonut(donut, segs, {
      title: fmtShort(ringTotal),
      sub: "зарплата по слоям",
    });
  }
  const portChart = $("#portChart");
  if (portChart && state.portfolio && state.portfolio.valuations.length) {
    // Нормализация по количеству (аудит 8.4): месячная точка — это
    // Σ по активам (количество на конец месяца × цена за единицу из
    // последней оценки ≤ месяца). Проданный актив выходит из линии,
    // а не «роняет» её старыми оценками.
    const txByAsset = new Map();
    (state.portfolio.transactions || []).forEach((t) => {
      if (!txByAsset.has(t.assetId)) txByAsset.set(t.assetId, []);
      txByAsset.get(t.assetId).push(t);
    });
    txByAsset.forEach((list) =>
      list.sort(
        (a, b) =>
          String(a.date || "").localeCompare(String(b.date || "")) ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      ),
    );
    const qtyAt = (assetId, dateEnd) => {
      let held = 0;
      for (const tx of txByAsset.get(assetId) || []) {
        if (String(tx.date || "") > dateEnd) break;
        const q = Math.max(0, Number(tx.quantity) || 0);
        if (tx.type === "buy") held += q;
        else if (tx.type === "sell") held -= Math.min(q, held);
      }
      return Math.max(0, held);
    };
    const valsByAsset = new Map();
    state.portfolio.valuations.forEach((v) => {
      if (!v.assetId) return;
      if (!valsByAsset.has(v.assetId)) valsByAsset.set(v.assetId, []);
      valsByAsset.get(v.assetId).push(v);
    });
    valsByAsset.forEach((list) =>
      list.sort(
        (a, b) =>
          String(a.date || "").localeCompare(String(b.date || "")) ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || "")),
      ),
    );
    const monthSet = new Set();
    state.portfolio.valuations.forEach((v) => {
      const m = String(v.date || "").slice(0, 7);
      if (m) monthSet.add(m);
    });
    (state.portfolio.transactions || []).forEach((t) => {
      const m = String(t.date || "").slice(0, 7);
      if (m) monthSet.add(m);
    });
    const monthsSorted = [...monthSet].sort();
    const points = monthsSorted.map((m) => {
      const monthEnd = m + "-31";
      let total = 0;
      valsByAsset.forEach((vals, assetId) => {
        const qty = qtyAt(assetId, monthEnd);
        if (qty <= 0 && txByAsset.has(assetId)) return; // продано — не тянем старую оценку
        let last = null;
        for (const v of vals) {
          if (String(v.date || "") > monthEnd) break;
          last = v;
        }
        if (!last) return;
        const valTotal = Number(last.value) || 0;
        const qtyAtVal = qtyAt(assetId, String(last.date || ""));
        // Без транзакций количество неизвестно — берём оценку как есть.
        total +=
          qtyAtVal > 0 && txByAsset.has(assetId)
            ? (valTotal / qtyAtVal) * qty
            : valTotal;
      });
      return { value: Math.round(total) };
    });
    drawLine(portChart, points, {
      xStart: monthsSorted[0],
      xEnd: monthsSorted[monthsSorted.length - 1],
    });
  }
}

// Графики на экране истории: динамика капитала и свободный остаток по месяцам.
async function initHistoryCharts() {
  let data;
  try {
    data = await api.get("/api/history/charts");
  } catch {
    return;
  }
  const nw = $("#nwChart");
  if (nw) {
    if ((data.netWorth || []).length >= 2) {
      drawLine(nw, data.netWorth.map((p) => ({ value: p.value })), {
        xStart: fmtDate(data.netWorth[0].date),
        xEnd: fmtDate(data.netWorth[data.netWorth.length - 1].date),
      });
      const last = data.netWorth[data.netWorth.length - 1];
      nw.setAttribute("role", "img");
      nw.setAttribute(
        "aria-label",
        `Стоимость портфеля по оценкам: ${fmtDate(data.netWorth[0].date)} ${fmt(data.netWorth[0].value)} → ${fmtDate(last.date)} ${fmt(last.value)}`,
      );
      const hint = $("#nwHint");
      if (hint)
        hint.textContent = `${fmtDate(data.netWorth[0].date)} → ${fmtDate(last.date)} · сейчас ${fmt(last.value)}`;
    } else {
      const hint = $("#nwHint");
      if (hint) hint.textContent = "Появится после двух и более оценок активов.";
    }
  }
  const mc = $("#monthChart");
  if (mc) {
    const monthly = (data.monthly || []).slice(-12);
    if (monthly.length) {
      drawBars(
        mc,
        monthly.map((m) => ({
          value: Math.max(0, m.remaining),
          label: m.month.slice(5),
        })),
      );
      const hint = $("#monthHint");
      if (hint)
        hint.textContent = monthly
          .map((m) => `${m.month.slice(5)}: ${fmtShort(m.remaining)}`)
          .join(" · ");
    }
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
function amountToFund(item) {
  const cost = Math.max(0, Number(item?.cost) || 0);
  const saved = Math.max(0, Number(item?.savedAmount) || 0);
  return Math.max(0, cost - saved);
}
// Курс изменил цену валютного желания — объясняем «откат» прогресса (аудит 13.7).
function fxDeltaNote(item) {
  const d = Number(item.fxDelta) || 0;
  if (Math.abs(d) < 1) return "";
  const word = d > 0 ? "подорожала" : "подешевела";
  return `<div class="qi-meta fx-note" style="color:${d > 0 ? "var(--color-warning)" : "var(--color-positive)"}">Цель ${word} на ${fmt(Math.abs(d))} из-за курса ${item.currency || ""}</div>`;
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
function itemById(itemId) {
  return state.items.find((i) => Number(i.id) === Number(itemId));
}
function normalizedManualEntries() {
  return state.manualPlan
    .map((p) => {
      const item = itemById(p.itemId);
      if (!item) return null;
      const requested = Math.max(0, Number(p.amount) || 0);
      const amount = Math.min(requested, amountToFund(item));
      return amount > 0 ? { itemId: Number(p.itemId), amount, item } : null;
    })
    .filter(Boolean);
}
function manualPlanTotal() {
  return normalizedManualEntries().reduce((sum, p) => sum + p.amount, 0);
}
function manualAmountFor(itemId) {
  const item = itemById(itemId);
  const raw =
    state.manualPlan.find((p) => Number(p.itemId) === Number(itemId))?.amount ||
    0;
  return item
    ? Math.min(Math.max(0, Number(raw) || 0), amountToFund(item))
    : 0;
}
function plannedAmountFor(itemId) {
  if (hasManualPlan()) return manualAmountFor(itemId);
  const entry = state.allocation?.approved?.find(
    (a) => Number(a.item?.id) === Number(itemId),
  );
  return entry
    ? Number(entry.allocatedAmount ?? entry.remainingCost ?? entry.item?.cost) ||
        0
    : 0;
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
// Единственная формула «Свободно» для Кабинета, Плана и Кошельков (аудит 14.1):
// излишки после стабильных пунктов минус ручной план (или авто-распределение).
function remainingSurplus() {
  const avail = state.allocation?.totals?.availableToAllocate || 0;
  return avail - committedTotal();
}
// Разбивка распределённого по слоям капитала — из ручного плана либо из авто.
function committedBuckets() {
  if (!hasManualPlan()) return state.allocation?.buckets || {};
  const b = {};
  for (const p of normalizedManualEntries()) {
    const layer = (p.item && (p.item.layer || p.item.bucket)) || "quality";
    b[layer] = (b[layer] || 0) + p.amount;
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
function queueCostTotal(items = state.items) {
  return items.reduce((sum, item) => sum + amountToFund(item), 0);
}
function queueFundedTotal(items = state.items) {
  return items.reduce((sum, item) => sum + goalProgress(item).saved, 0);
}
function isUrgentItem(item) {
  if (!item.deadline) return false;
  const now = new Date();
  const deadline = new Date(`${item.deadline}T23:59:59`);
  if (Number.isNaN(deadline.getTime())) return false;
  const days = Math.ceil((deadline - now) / 86400000);
  return days >= 0 && days <= 30 && goalProgress(item).pct < 100;
}
function urgentItems(items = state.items) {
  return items.filter(isUrgentItem).sort((a, b) => String(a.deadline || "").localeCompare(String(b.deadline || ""), "ru"));
}
function sortOption(value, label) {
  const current = `${state.queueSort.key}:${state.queueSort.dir}`;
  return `<option value="${value}" ${current === value ? "selected" : ""}>${label}</option>`;
}
function planPulseData() {
  const totals = state.allocation?.totals || {};
  const salary = Number(totals.salary) || 0;
  const fixed = (Number(totals.survival) || 0) + (Number(totals.reserve) || 0) + (Number(totals.fixedInvestment) || 0);
  const available = Number(totals.availableToAllocate) || 0;
  const committed = committedTotal();
  const remaining = remainingSurplus();
  const queueLeft = queueCostTotal();
  const urgentCount = urgentItems().length;
  const pressure = available > 0 ? Math.round((committed / available) * 100) : 0;
  const fixedPct = salary > 0 ? Math.round((fixed / salary) * 100) : 0;
  const queueMonths = available > 0 ? Math.ceil(queueLeft / available) : null;
  const tone = remaining < 0 ? "danger" : pressure >= 85 || urgentCount ? "warn" : "good";
  const headline =
    tone === "danger"
      ? "Плану нужен компромисс: что-то отложить"
      : tone === "warn"
        ? "План рабочий, но есть зоны внимания"
        : "План выглядит устойчивым";
  const advice =
    tone === "danger"
      ? "Сначала перенесите часть ручного плана или снизьте сумму по желаниям — сейчас обязательства выше свободных денег."
      : urgentCount
        ? "Проверьте ближайшие дедлайны: срочные желания лучше либо профинансировать, либо честно перенести."
        : pressure >= 85
          ? "Оставьте небольшой буфер вместо распределения всех излишков — так меньше риск импульсивных решений."
          : "Можно выбрать 1–2 покупки из очереди и остальное оставить в буфере/кошельках.";
  return { salary, fixed, available, committed, remaining, queueLeft, urgentCount, pressure, fixedPct, queueMonths, tone, headline, advice };
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
  themeFade();
  document.documentElement.setAttribute("data-palette", palette);
  try {
    localStorage.setItem("cq-palette", palette);
  } catch {}
  if (typeof pushUiPrefs === "function") pushUiPrefs({ palette });
  syncThemeControls(currentTheme(), palette);
  if (typeof drawCharts === "function") requestAnimationFrame(drawCharts);
}
// плавный кроссфейд при смене темы/палитры (класс снимается через 600 мс)
let _themeFadeT = null;
function themeFade() {
  const el = document.documentElement;
  el.classList.add("theme-fade");
  clearTimeout(_themeFadeT);
  _themeFadeT = setTimeout(() => el.classList.remove("theme-fade"), 600);
}
function applyTheme(t) {
  const theme = isTheme(t) ? t : "light";
  themeFade();
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("cq-theme", theme);
  } catch {}
  const mode = THEME_MODES.find((x) => x.id === theme) || THEME_MODES[0];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", mode.meta);
  if (typeof pushUiPrefs === "function") pushUiPrefs({ theme });
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
// ---------- демо-режим (аудит 3.9): смотрим на примере, ничего не пишем ----------
async function enterDemoMode() {
  let data;
  try {
    const res = await fetch("/demo-data.json");
    data = await res.json();
  } catch {
    toast("Не удалось загрузить демо-данные");
    return;
  }
  state.demo = true;
  state.meta = data.meta;
  state.plan = data.plan;
  state.items = data.items || [];
  state.allocation = data.allocation;
  state.insights = data.insights || null;
  state.history = data.history || [];
  state.investments = data.investments || [];
  state.portfolio = data.portfolio || null;
  state.wallets = data.wallets || [];
  state.manualPlan = data.manualPlan || [];
  state.goals = data.goals || [];
  state.currencyRate = data.currencyRate || 43.5;
  state.eurRate = data.eurRate || 47;
  $("#authGate").classList.add("hidden");
  $("#app").classList.remove("hidden");
  if (!$("#demoBanner")) {
    const banner = document.createElement("div");
    banner.id = "demoBanner";
    banner.className = "demo-banner";
    banner.innerHTML = `<span>👀 Это демо — изменения не сохраняются.</span><button class="btn btn-secondary" id="demoExit">Начать со своих данных</button>`;
    document.body.prepend(banner);
    banner.querySelector("#demoExit").addEventListener("click", () => {
      location.reload();
    });
  }
  renderTopbar();
  renderView();
}
$("#demoBtn")?.addEventListener("click", enterDemoMode);

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
      if (pin.length < 6) return (err.textContent = "PIN слишком короткий — минимум 6 цифр.");
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
  state.authed = true;
  pullUiPrefs(); // тема/палитра/чат с сервера, не блокируем рендер (аудит 14.4)
  // Холодный старт Fly-машины занимает 2-4с — объясняем ожидание (аудит 17.3).
  const wakeTimer = setTimeout(
    () => toast("Сервер просыпается, секунду…", { duration: 4000 }),
    2500,
  );
  let data;
  try {
    data = await api.get(`/api/state?scenario=balanced`);
  } finally {
    clearTimeout(wakeTimer);
  }
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
  state.eurRate = data.eurRate || 47;
  // Открываем вкладку из URL (deep-link / перезагрузка).
  const hashView = viewFromHash();
  if (hashView) state.view = hashView;
  $("#app").classList.remove("hidden");
  $$(".nav-item[data-view]").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === state.view),
  );
  renderTopbar();
  renderView();
  maybeShowOnboardingAfterLogin();
}

async function refresh() {
  if (state.demo) return; // в демо данные статичны
  // Лёгкий синк (аудит 17.7): history/portfolio запрашиваем только на их экранах.
  const needHeavy = state.view === "history" || state.view === "investments";
  const data = await api.get(
    `/api/state?scenario=balanced${needHeavy ? "" : "&lite=1"}`,
  );
  state.plan = data.plan;
  state.items = pendingDeletes.size
    ? data.items.filter((i) => !pendingDeletes.has(i.id))
    : data.items;
  state.allocation = data.allocation;
  state.insights = data.insights || null;
  if (data.history) state.history = data.history;
  state.investments = data.investments || [];
  if (data.portfolio) state.portfolio = data.portfolio;
  state.wallets = data.wallets || [];
  state.manualPlan = data.manualPlan || [];
  state.goals = data.goals || [];
  state.currencyRate = data.currencyRate || 43.5;
  state.eurRate = data.eurRate || 47;
  renderTopbar();
  renderView();
}

// Фича-флаги модулей (план 1.1): сателлиты можно выключать в настройках.
// Флаги скрывают только UI — данные и формула «Свободно» не меняются.
const MODULE_VIEWS = ["wallets", "investments"];
function moduleEnabled(key) {
  return state.meta?.modules?.[key] !== false;
}
function applyModuleFlags() {
  for (const key of MODULE_VIEWS) {
    $$(`.nav-item[data-view="${key}"]`).forEach((b) =>
      b.classList.toggle("hidden", !moduleEnabled(key)),
    );
  }
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
  applyModuleFlags();
}

$$(".nav-item[data-view]").forEach((b) =>
  b.addEventListener("click", () => setView(b.dataset.view)),
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

// ---------- premium motion: цифры «отсчитываются» при входе на экран ----------
let _lastCountupView = null;
function animateNumbers(root) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  root.querySelectorAll(".stat-value, .decision-metric b, .pulse-metric b, .runway-ring b").forEach((el) => {
    if (el.children.length) return; // внутри разметка — не трогаем
    const original = el.textContent;
    const m = original.match(/^([^\d-]*)(-?[\d\s\u00A0\u202F]+)(.*)$/);
    if (!m) return;
    const target = Number(m[2].replace(/[^\d-]/g, ""));
    if (!Number.isFinite(target) || target === 0 || Math.abs(target) > 1e12) return;
    const dur = 700;
    const t0 = performance.now();
    el.classList.add("num-ticking");
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p < 1 && el.isConnected) {
        el.textContent = m[1] + Math.round(target * eased).toLocaleString("ru-RU") + m[3];
        requestAnimationFrame(tick);
      } else {
        el.textContent = original;
        el.classList.remove("num-ticking");
      }
    };
    requestAnimationFrame(tick);
  });
}

function renderView() {
  const root = $("#views");
  const v = state.view;
  // Сохраняем скролл и фокус через полный ререндер (аудит 17.1, частично).
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const focusId = document.activeElement?.id || null;
  if (v === "dashboard") {
    root.innerHTML = viewDashboard();
    initDashboardSpark();
  }
  else if (v === "queue") root.innerHTML = viewQueue();
  else if (v === "wallets") root.innerHTML = viewWallets();
  else if (v === "investments") root.innerHTML = viewInvestments();
  else if (v === "plan") root.innerHTML = viewPlan();
  else if (v === "history") {
    root.innerHTML = viewHistory();
    initHistoryCharts();
  }
  else if (v === "assistant") {
    root.innerHTML = viewAssistant();
    initAssistant();
  } else if (v === "more") root.innerHTML = viewMore();
  else if (v === "settings") {
    root.innerHTML = viewSettings();
    initSettings();
  }
  bindViewEvents();
  if (focusId) document.getElementById(focusId)?.focus?.();
  window.scrollTo(scrollX, scrollY);
  if (v !== _lastCountupView) {
    _lastCountupView = v;
    root.classList.remove("view-enter");
    void root.offsetWidth; // перезапуск анимации входа
    root.classList.add("view-enter");
    animateNumbers(root);
  }
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
// Hash-роутер: вкладка живёт в URL, «назад» и перезагрузка работают (аудит 2.1).
const ROUTABLE_VIEWS = ["dashboard", "queue", "wallets", "investments", "plan", "history", "assistant", "more", "settings"];
function viewFromHash() {
  const v = (location.hash || "").replace(/^#\/?/, "");
  if (!ROUTABLE_VIEWS.includes(v)) return null;
  if (MODULE_VIEWS.includes(v) && !moduleEnabled(v)) return null;
  return v;
}
function setView(view, { fromHash = false } = {}) {
  if (MODULE_VIEWS.includes(view) && !moduleEnabled(view)) view = "dashboard";
  state.view = view;
  if (!fromHash && viewFromHash() !== view) {
    try {
      location.hash = "#/" + view;
    } catch {}
  }
  $$(".nav-item[data-view]").forEach((x) =>
    x.classList.toggle("active", x.dataset.view === view),
  );
  renderView();
  // Тяжёлые блоки (history/portfolio) подтягиваем при заходе на их экраны (аудит 17.7).
  if (view === "history" || view === "investments") refresh().catch(() => {});
}
window.addEventListener("hashchange", () => {
  const v = viewFromHash();
  if (v && v !== state.view) setView(v, { fromHash: true });
});
// Эко-режим: на слабом железе отключаем постоянные фоновые анимации (аудит 17.5).
if ((navigator.hardwareConcurrency || 8) <= 4 || matchMedia("(prefers-reduced-motion: reduce)").matches) {
  document.body.classList.add("eco");
}
// Подсказка-формат для денежных полей: «150000» → «= 150 000 ₴» (аудит 3.7).
document.addEventListener("input", (e) => {
  const el = e.target;
  if (!el?.matches?.('input[type="number"]')) return;
  const field = el.closest(".field");
  if (!field) return;
  let hint = field.querySelector(".money-hint");
  const v = Number(el.value);
  if (!Number.isFinite(v) || Math.abs(v) < 1000) {
    hint?.remove();
    return;
  }
  if (!hint) {
    hint = document.createElement("div");
    hint.className = "money-hint";
    el.insertAdjacentElement("afterend", hint);
  }
  hint.textContent = "= " + v.toLocaleString("ru-RU");
});
// Ошибки из «забытых» промисов показываем пользователю (аудит 11.2).
window.addEventListener("unhandledrejection", (e) => {
  const msg = e?.reason?.message || "";
  if (msg === "unauthorized") return;
  toast("Ошибка: " + (msg || "что-то пошло не так"));
});

function onboardingSteps() {
  const hasPlan = !!state.plan;
  const hasItems = state.items.length > 0;
  const hasPriorities = state.items.some((i) => Number(i.priority) >= 4 || i.deadline);
  const hasManual = hasManualPlan();
  const hasWallet = state.wallets.length > 0;
  return [
    { id: "plan", done: hasPlan, label: "Ввести зарплату и обязательные расходы", hint: "Это база для всех расчётов.", action: "open-plan", button: "Настроить" },
    { id: "items", done: hasItems, label: "Добавить 3–5 желаний", hint: "От мелких покупок до больших целей.", action: "add-item", button: "Добавить" },
    { id: "priority", done: hasPriorities, label: "Отметить приоритеты и дедлайны", hint: "Так кабина решений поймёт, что важно сейчас.", view: "queue", button: "Открыть" },
    { id: "manual", done: hasManual, label: "Собрать план месяца", hint: "Распределите излишки по желаниям.", view: "plan", button: "План" },
    ...(moduleEnabled("wallets")
      ? [{ id: "wallet", done: hasWallet, label: "Разложить остаток по кошелькам", hint: "Карманы снижают хаос после зарплаты.", action: "add-wallet", button: "Кошелёк" }]
      : []),
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
  if (moduleEnabled("wallets") && !state.wallets.length) {
    return { tone: "neutral", title: "Разложите остаток по карманам", text: "Кошельки помогают не смешивать еду, транспорт, накопления и свободные траты.", action: "add-wallet", button: "+ Кошелёк" };
  }
  const buy = state.insights?.buyNow?.[0];
  return { tone: "good", title: buy ? `Можно действовать: ${buy.title}` : "План месяца собран", text: buy ? `Первое безопасное действие по плану — ${fmt(buy.remainingCost ?? buy.cost)}.` : "Проверьте план перед зарплатой и закрывайте месяц, когда решения выполнены.", view: buy ? "queue" : "plan", button: buy ? "Открыть очередь" : "Открыть план" };
}

// Один «следующий шаг» вместо трёх конкурирующих блоков (аудит 7.4):
// критичное из кабины решений важнее обычного CTA; пульс-метрики — вторичная строка.
function smartCtaCard() {
  let cta = smartDashboardCta();
  if (state.insights?.status === "danger") {
    cta = {
      tone: "danger",
      title: "Сначала разгрузите план",
      text: state.insights.headline || "План превышает излишки — отложите что-то перед новыми покупками.",
      view: "plan",
      button: "Открыть план",
    };
  }
  const pulse = planPulseData();
  const queueMonthsText = pulse.queueMonths == null ? "—" : `${pulse.queueMonths} мес.`;
  const remainingTone = pulse.remaining < 0 ? "danger" : "good";
  return `<section class="smart-cta card smart-${cta.tone}">
    <div><div class="eyebrow">следующий шаг</div><h2>${escapeHtml(cta.title)}</h2><p>${escapeHtml(cta.text)}</p></div>
    <button class="btn btn-primary" data-act="${cta.action || "go-view"}" ${cta.view ? `data-target-view="${cta.view}"` : ""}>${escapeHtml(cta.button)}</button>
    <div class="pulse-metrics cta-pulse">
      <div class="pulse-metric"><span>База</span><b>${pulse.fixedPct}%</b><em>${fmt(pulse.fixed)}</em></div>
      <div class="pulse-metric"><span>Занято излишков</span><b>${pulse.pressure}%</b><em>${fmt(pulse.committed)} / ${fmt(pulse.available)}</em></div>
      <div class="pulse-metric pulse-${remainingTone}"><span>${pulse.remaining < 0 ? "Не хватает" : "Буфер"}</span><b>${fmt(pulse.remaining)}</b><em>после плана</em></div>
      <div class="pulse-metric"><span>Очередь</span><b>${queueMonthsText}</b><em>${fmt(pulse.queueLeft)} осталось</em></div>
    </div>
    ${pulse.urgentCount ? `<div class="pulse-note"><b>${pulse.urgentCount}</b> дедлайн(ов) в ближайшие 30 дней — проверьте очередь перед зарплатой.</div>` : ""}
  </section>`;
}

function queueSummaryCard(filtered) {
  const allLeft = queueCostTotal();
  const filteredLeft = queueCostTotal(filtered);
  const funded = queueFundedTotal();
  const planned = state.items.filter((it) => plannedAmountFor(it.id) > 0).length;
  const urgent = urgentItems();
  const top = sortedItems(filtered).slice(0, 3);
  return `<section class="queue-summary card">
    <div class="queue-summary-head">
      <div><div class="eyebrow">срез очереди</div><h2>Что сейчас давит на план</h2><p>Короткая диагностика перед сортировкой: сколько осталось профинансировать, что уже в плане и где горят дедлайны.</p></div>
      <button class="btn btn-outline" data-act="go-view" data-target-view="plan">Открыть план</button>
    </div>
    <div class="queue-summary-grid">
      <div><span>Всего осталось</span><b>${fmt(allLeft)}</b><em>${state.items.length} желаний</em></div>
      <div><span>В текущем фильтре</span><b>${fmt(filteredLeft)}</b><em>${filtered.length} позиций</em></div>
      <div><span>Накоплено</span><b>${fmt(funded)}</b><em>по всем желаниям</em></div>
      <div class="${urgent.length ? "warn" : "good"}"><span>Дедлайны 30 дней</span><b>${urgent.length}</b><em>${planned} в плане</em></div>
    </div>
    ${top.length ? `<div class="queue-focus"><span>Фокус:</span>${top.map((it, i) => `<button class="chip-btn ticket-chip" data-act="tradeoff" data-id="${it.id}"><span class="ticket-no">№${i + 1}</span><span class="ticket-body">${wishEmojiTag(it)}${escapeHtml(it.title)} · ${fmtShort(amountToFund(it))}</span></button>`).join("")}</div>` : ""}
  </section>`;
}

function richEmpty(icon, title, text, action = "", button = "", targetView = "") {
  return `<div class="empty rich-empty"><div class="big"><i class="spark s1">✦</i><i class="spark s2">✧</i><span>${icon}</span></div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action ? `<button class="btn btn-primary" data-act="${action}" ${targetView ? `data-target-view="${targetView}"` : ""}>${escapeHtml(button)}</button>` : ""}</div>`;
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
      <div class="insight-item-title"><span class="dot" style="background:${layerColor(layer)}"></span>${wishEmojiTag(item)}${escapeHtml(item.title)}</div>
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
      ? "Нужен компромисс"
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
        <div class="eyebrow" title="Сводка месяца: лимит, обязательства и безопасный следующий шаг">Кабина решений</div>
        <h2>${escapeHtml(insights.headline || "План готов")}</h2>
        <p>Один экран для решения: что купить сейчас, что держать под контролем и где лучше нажать паузу.</p>
      </div>
      <div class="runway-ring" style="--pct:${runway}" title="Запас = какая часть излишков останется свободной после плана. 100% — ничего не потрачено, 0% — всё распределено.">
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
  // Сумма долей должна давать ровно 100%, а не 99/101 (аудит 7.1).
  const [fixedPct, committedPct, remainingPct] = roundPercents(
    [fixedBase, committed, remaining],
    salary,
  );
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
          <span>Свободно после базы</span>
          <b>${fmt(t.availableToAllocate)}</b>
          <em>${fmtUsd(t.availableToAllocate)} на желания</em>
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
        <span><span class="dot" style="background:var(--layer-base)"></span>Обязательные <b>${fmt(t.survival)}</b></span>
        <span><span class="dot" style="background:var(--accent)"></span>Страховка <b>${fmt(t.reserve)}</b></span>
        <span><span class="dot" style="background:var(--color-positive)"></span>Инвестиции <b>${fmt(t.fixedInvestment)}</b></span>
        ${layerRows}
        <span><span class="dot" style="background:var(--border)"></span>Останется <b>${fmt(remaining)}</b></span>
      </div>
    </div>

    <div class="alloc-bar allocation-main-bar" aria-label="Полоса распределения зарплаты">
      <div class="alloc-seg" style="width:${stablePct(t.survival)}%;background:var(--layer-base)" title="Обязательные"></div>
      <div class="alloc-seg" style="width:${stablePct(t.reserve)}%;background:var(--accent)" title="Страховка"></div>
      <div class="alloc-seg" style="width:${stablePct(t.fixedInvestment)}%;background:var(--color-positive)" title="Инвестиции"></div>${segs}
    </div>
    <div class="allocation-axis"><span>обязательное</span><span>защита</span><span>рост</span><span>желания</span><span>остаток</span></div>
    ${t.status === "overallocated" ? `<div class="tradeoff" style="background:color-mix(in srgb,var(--color-risk) 10%,transparent);border-color:var(--color-risk)"><b style="color:var(--color-risk)">${overallocTitle(t)}</b> ${overallocText(t)}</div>` : ""}
  </section>`;
}

// Компактный чип вместо большой stat-карты (аудит 4.1: меньше повторов и скролла).
function statChip(label, value, valueCls = "", sub = "") {
  return `<div class="stat-chip" role="listitem" ${sub ? `title="${escapeAttr(sub)}"` : ""}><span>${label}</span><b class="${valueCls}">${value}</b></div>`;
}

// Свёрнутый спарклайн капитала на кабинете (аудит 2.4): динамика — в один взгляд, детали — в Истории.
function capitalSparkCard() {
  return `<section class="card capital-spark" data-act="go-view" data-target-view="history" role="button" tabindex="0" aria-label="Динамика капитала — открыть историю">
    <div class="capital-spark-head"><div class="eyebrow">динамика капитала</div><span class="muted small">открыть историю →</span></div>
    <canvas id="dashSpark" height="56" aria-hidden="true"></canvas>
    <div class="muted small" id="dashSparkHint">Загружаю…</div>
  </section>`;
}

let _sparkCache = null;
async function initDashboardSpark() {
  const canvas = $("#dashSpark");
  if (!canvas) return;
  try {
    _sparkCache = _sparkCache || (await api.get("/api/history/charts"));
    const series = _sparkCache.netWorth || [];
    const pts = series.map((p) => ({ value: p.value }));
    const hint = $("#dashSparkHint");
    if (pts.length < 2) {
      if (hint) hint.textContent = "График появится, когда накопится несколько оценок активов.";
      return;
    }
    if (hint) {
      const first = pts[0].y || 0;
      const last = pts[pts.length - 1].y || 0;
      const delta = last - first;
      hint.textContent = `${fmt(last)} сейчас · ${delta >= 0 ? "+" : ""}${fmt(delta)} за период`;
    }
    drawLine(canvas, pts, {
      xStart: series[0]?.date?.slice(0, 7),
      xEnd: series[series.length - 1]?.date?.slice(0, 7),
    });
  } catch {
    const hint = $("#dashSparkHint");
    if (hint) hint.textContent = "Не удалось загрузить динамику.";
  }
}


function viewDashboard() {
  if (!state.plan || !state.allocation) {
    return `<div class="view-head"><h1>Кабинет</h1><p>Обзор будущей зарплаты до её прихода.</p></div>${noPlanBlock()}`;
  }
  const t = state.allocation.totals;
  // Перерасход не должен «обрезаться» справа: нормируем на max(зарплата,
  // распределено) и показываем засечку 100% (аудит 4.5).
  const allocatedTotal =
    (Number(t.survival) || 0) +
    (Number(t.reserve) || 0) +
    (Number(t.fixedInvestment) || 0) +
    committedTotal();
  const barDenom = Math.max(Number(t.salary) || 0, allocatedTotal);
  const stablePct = (value) => (barDenom ? (value / barDenom) * 100 : 0);
  const salaryTick =
    barDenom > (Number(t.salary) || 0)
      ? `<div class="alloc-tick" style="left:${((Number(t.salary) || 0) / barDenom) * 100}%" title="100% зарплаты"></div>`
      : "";
  const segs =
    Object.entries(committedBuckets())
      .filter(([, v]) => v > 0)
      .map(
        ([k, v]) =>
          `<div class="alloc-seg" style="width:${stablePct(v)}%;background:${bucketColor(k)}" title="${bucketLabel(k)}: ${fmt(v)}"></div>`,
      )
      .join("") + salaryTick;

  const pf = state.portfolio;
  const pfTotals = pf?.totals || pf || {};
  const pfValue = pfTotals.totalValue || 0;
  const pfPL = pfTotals.totalPnL || 0;
  const pfInvested = pfTotals.totalInvested || 0;
  const pfPLpct =
    pfInvested > 0 ? ((pfPL / pfInvested) * 100).toFixed(1) : null;

  return `
  <div class="dashboard-shell">
    <div class="view-head dashboard-head"><div><h1>Кабинет</h1><p>Главный срез зарплаты: слои, остаток и следующие действия.</p></div><span class="page-kicker">личный финансовый штаб</span></div>
    ${allocationLayerCard(t, segs, stablePct)}
    ${smartCtaCard()}
    ${decisionCockpit()}
    <div class="stat-chips" role="list" aria-label="Сводка месяца">
      ${statChip("Зарплата", fmt(t.salary), "", `${fmtDate(state.plan.payday)} · ${fmtUsd(t.salary)}`)}
      ${statChip("Обязательные", fmt(t.survival), "", "стабильный расходник")}
      ${statChip("Страховка", fmt(t.reserve), "accent-num", "чёрный день")}
      ${statChip("Инвестиции", fmt(t.fixedInvestment), "green-num", "стабильно отложить")}
      ${statChip("Излишки", fmt(t.availableToAllocate), "accent-num", "после стабильных пунктов")}
      ${statChip("Распределено", fmt(committedTotal()), "", hasManualPlan() ? "ручной план" : `${state.allocation.approved.length} покупок`)}
      ${pfValue > 0 ? statChip("Портфель", fmt(pfValue), pfPL >= 0 ? "green-num" : "red-num", pfPLpct ? `${pfPL >= 0 ? "+" : ""}${pfPLpct}% к вложенному` : "") : ""}
    </div>
    ${capitalSparkCard()}
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
      <div class="qi-title"><span class="dot" style="background:${layerColor(layer)}"></span>${wishEmojiTag(item)}${escapeHtml(item.title)}
        <span class="tag tag-${item.type}">${TYPE_LABELS[item.type]}</span>${verdictChip(item)}</div>
      <div class="qi-meta">${layerLabel(layer)} · ${catLabelShort(item.category)} · ${bandLabel(item.band)} · приоритет ${item.priority}/5 · траектория ${item.trajectory}/5${item.deadline ? " · дедлайн " + fmtDate(item.deadline) : ""}</div>
      ${gp.saved > 0 ? `<div class="goal-mini" role="progressbar" aria-valuenow="${gp.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Прогресс накопления"><div style="width:${gp.pct}%"></div></div><div class="qi-meta">Накоплено ${fmt(gp.saved)} из ${fmt(gp.cost)} · осталось ${fmt(gp.left)}</div>` : ""}
      ${fxDeltaNote(item)}
      ${reason ? `<div class="reason">↪ ${escapeHtml(reason)}</div>` : ""}
      ${extra ? `<div class="qi-meta mobile-swipe-hint">${extra}</div>` : ""}
      <div class="mobile-item-actions" aria-label="Действия с желанием">
        <button class="btn btn-sm btn-outline" data-act="tradeoff" data-id="${item.id}" title="Что отложить, чтобы это поместилось в бюджет">Компромисс</button>
        <button class="btn btn-sm btn-outline" data-act="save-goal" data-id="${item.id}">Копить</button>
        <button class="btn btn-sm btn-ghost" data-act="edit" data-id="${item.id}">Изм.</button>
        <button class="btn btn-sm btn-ghost" data-act="bought" data-id="${item.id}">Куплено</button>
      </div>
    </div>
    <div class="qi-cost">${fmt(item.cost)}</div>
  </div>`;
}

function viewQueue() {
  const q = state.queueFilters;
  const filtered = state.items.filter((it) => {
    const gp = goalProgress(it);
    const inPlan = plannedAmountFor(it.id) > 0;
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
    `<th ${state.queueSort.key === key ? `aria-sort="${state.queueSort.dir === "asc" ? "ascending" : "descending"}"` : ""}><button class="th-sort" data-sort="${key}">${label}${sortMark(key)}</button></th>`;
  const rows = sortedItems(filtered)
    .map((it) => {
      const inPlan = state.allocation?.approved.some(
        (a) => a.item.id === it.id,
      );
      const layer = it.layer || it.bucket;
      const gp = goalProgress(it);
      return `<tr data-id="${it.id}">
      <td><span class="dot" style="background:${layerColor(layer)}"></span>${wishEmojiTag(it)}${escapeHtml(it.title)}${verdictChip(it)}</td>
      <td>${fmt(it.cost)}</td>
      <td><div class="goal-cell"><b>${gp.pct}%</b><div class="goal-mini" role="progressbar" aria-valuenow="${gp.pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Прогресс накопления"><div style="width:${gp.pct}%"></div></div><span>${fmtShort(gp.saved)} / ${fmtShort(gp.cost)}</span></div></td>
      <td>${layerLabel(layer)}</td>
      <td>${catLabelShort(it.category)}</td>
      <td><span class="band">${bandLabel(it.band)}</span></td>
      <td><span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span></td>
      <td>${prioDots(it.priority)}</td>
      <td>${it.deadline ? fmtDate(it.deadline) : "—"}</td>
      <td>${inPlan ? '<span class="stamp stamp-plan">в плане</span>' : '<span class="stamp stamp-later">позже</span>'}</td>
      <td style="text-align:right">
        <details class="row-menu">
          <summary aria-label="Действия с желанием">⋯</summary>
          <div class="row-menu-pop">
            <button class="btn btn-sm btn-ghost" data-act="tradeoff" data-id="${it.id}" title="Что отложить, чтобы это поместилось в бюджет">Компромисс</button>
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
  ${queueSummaryCard(filtered)}
  <form class="quick-add card quick-add-smart" id="quickAddForm">
    <input name="title" placeholder="Быстро добавить желание..." required />
    <input name="cost" type="number" min="0" placeholder="Сумма" required />
    <select name="category">${state.meta.categories.map((c) => `<option value="${c.id}">${c.ru}</option>`).join("")}</select>
    <select name="type"><option value="should">Желательно</option><option value="must">Обязательно</option><option value="nice">По желанию</option></select>
    <select name="priority"><option value="3">Приоритет 3</option><option value="5">Приоритет 5</option><option value="4">Приоритет 4</option><option value="2">Приоритет 2</option><option value="1">Приоритет 1</option></select>
    <input name="deadline" type="date" title="Дедлайн" />
    <button class="btn btn-primary" type="submit">Добавить</button>
    <button class="btn btn-ghost" type="button" id="quickAddDetails" title="Открыть полную форму: слой, валюта, оценки, заметки">Детали…</button>
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
    <select id="mobileSort" class="mobile-sort">${sortOption("priority:desc", "Сорт: приоритет ↓")}${sortOption("cost:desc", "Стоимость ↓")}${sortOption("cost:asc", "Стоимость ↑")}${sortOption("deadline:asc", "Дедлайн ↑")}${sortOption("title:asc", "Название ↑")}</select>
  </div>
  ${
    state.items.length && filtered.length
      ? `<div class="table-wrap queue-table"><table>
    <thead><tr>${th("title", "Желание")}${th("cost", "Стоимость")}<th>Накоплено</th>${th("layer", "Слой")}${th("category", "Категория")}${th("band", "Размер")}${th("type", "Тип")}${th("priority", "Приоритет")}${th("deadline", "Дедлайн")}<th>Статус</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
      : richEmpty("≡", "Очередь желаний пока пустая", "Добавьте то, что хотите купить: от обязательных покупок до мечт. Потом кабина решений сама покажет, что помещается в излишки.", "add-item", "+ Добавить желание")
  }
  ${state.items.length && !filtered.length ? richEmpty("⌕", "По фильтрам ничего не найдено", "Сбросьте поиск или выберите другой слой, тип или статус.") : ""}
  <div class="mobile-queue">${sortedItems(filtered)
    .map((it) => queueItemRow(it, "Свайп влево — куплено, вправо — удалить"))
    .join("")}</div>
  <div id="tradeoffBox"></div>`;
}

function assetTypeLabel(type) {
  return (
    {
      crypto: "Крипто",
      stock: "Акция",
      etf: "ETF",
      bond: "Облигация",
      deposit: "Депозит",
      other: "Другое",
    }[type] || type || "Другое"
  );
}
function investPct(part, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(part || 0) / total) * 100)));
}
function signedPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}
function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}
function investmentStats(p) {
  const assets = p?.assets || [];
  const transactions = p?.transactions || [];
  const valuations = p?.valuations || [];
  const total = p?.totals || { totalValue: 0, totalInvested: 0, totalPnL: 0 };
  const currentMonth = monthKey();
  const monthlyBuy = transactions
    .filter((t) => t.type === "buy" && String(t.date || "").slice(0, 7) === currentMonth)
    .reduce((sum, t) => sum + (Number(t.totalAmount) || 0), 0);
  const monthlyTarget = Number(state.plan?.investmentFixed) || 0;
  const lastValuation = valuations.reduce((latest, v) => {
    const stamp = `${v.date || ""} ${v.createdAt || ""}`;
    return !latest || stamp > latest.stamp ? { ...v, stamp } : latest;
  }, null);
  const lastValDate = lastValuation?.date || "";
  const daysSinceValuation = lastValDate
    ? Math.max(0, Math.round((Date.now() - new Date(lastValDate).getTime()) / 86400000))
    : null;
  const topAsset = assets.reduce(
    (best, a) => (!best || (Number(a.currentValue) || 0) > (Number(best.currentValue) || 0) ? a : best),
    null,
  );
  const bestAsset = assets.reduce(
    (best, a) => (!best || (Number(a.totalPnL) || 0) > (Number(best.totalPnL) || 0) ? a : best),
    null,
  );
  const worstAsset = assets.reduce(
    (worst, a) => (!worst || (Number(a.totalPnL) || 0) < (Number(worst.totalPnL) || 0) ? a : worst),
    null,
  );
  return {
    total,
    assets,
    transactions,
    valuations,
    monthlyBuy,
    monthlyTarget,
    monthlyGap: Math.max(0, monthlyTarget - monthlyBuy),
    monthlyProgress: investPct(monthlyBuy, monthlyTarget),
    lastValuation,
    lastValDate,
    daysSinceValuation,
    topAsset,
    topShare: topAsset && total.totalValue ? (topAsset.currentValue / total.totalValue) * 100 : 0,
    bestAsset,
    worstAsset,
    pnlPct: total.totalInvested > 0 ? (total.totalPnL / total.totalInvested) * 100 : null,
  };
}
function investmentInsights(p) {
  const st = investmentStats(p);
  const tips = [];
  if (!st.assets.length) {
    tips.push({ tone: "action", title: "Начните с первого актива", text: "Добавьте ETF, крипту, депозит или акцию — после этого появятся доходность, концентрация и динамика.", action: "add-asset", button: "+ Актив" });
    return tips;
  }
  if (st.monthlyTarget > 0 && st.monthlyGap > 0) {
    tips.push({ tone: "action", title: "Довести взнос месяца", text: `По плану нужно инвестировать ещё ${fmt(st.monthlyGap)} из ${fmt(st.monthlyTarget)}.`, action: "add-tx", button: "+ Покупка" });
  }
  if (!st.valuations.length || (st.daysSinceValuation != null && st.daysSinceValuation > 32)) {
    tips.push({ tone: "warning", title: "Обновить текущую стоимость", text: st.lastValDate ? `Последняя оценка была ${fmtDate(st.lastValDate)} — график и P/L могут устареть.` : "Добавьте оценку стоимости, чтобы видеть реальную прибыль/убыток.", action: "add-valuation", button: "+ Оценка" });
  }
  if (st.topShare > 60) {
    tips.push({ tone: "warning", title: "Высокая концентрация", text: `${st.topAsset.name} занимает ${Math.round(st.topShare)}% портфеля. Полезно проверить, комфортен ли такой риск.`, view: "assets", button: "Активы" });
  }
  if (st.total.totalInvested > 0 && st.total.totalPnL < 0) {
    tips.push({ tone: "danger", title: "Портфель в минусе", text: `Текущий результат ${fmt(st.total.totalPnL)} (${signedPct(st.pnlPct)}). Проверьте худшие позиции и дату оценок.`, view: "assets", button: "Разобрать" });
  }
  if (!tips.length) {
    tips.push({ tone: "good", title: "Портфель выглядит актуально", text: "Есть активы, операции и оценки. Следующий шаг — поддерживать регулярный взнос и не терять баланс по долям.", action: "add-tx", button: "+ Операция" });
  }
  return tips.slice(0, 3);
}
function allocationByType(p) {
  const totalValue = Number(p?.totals?.totalValue) || 0;
  const groups = new Map();
  (p?.assets || []).forEach((a) => {
    const key = a.type || "other";
    groups.set(key, (groups.get(key) || 0) + (Number(a.currentValue) || 0));
  });
  return [...groups.entries()]
    .map(([type, value]) => ({ type, value, pct: investPct(value, totalValue) }))
    .sort((a, b) => b.value - a.value);
}
function assetLatestValuation(assetId, p) {
  return (p?.valuations || []).find((v) => String(v.assetId) === String(assetId)) || null;
}
function assetLastTx(assetId, p) {
  return (p?.transactions || []).find((t) => String(t.assetId) === String(assetId)) || null;
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

  const st = investmentStats(p);
  const monthlyTargetText = st.monthlyTarget > 0 ? `${fmt(st.monthlyBuy)} / ${fmt(st.monthlyTarget)} в этом месяце` : "задайте регулярный взнос в настройках";
  return `<div class="view-head row-between investment-head">
    <div><div class="eyebrow">портфель и дисциплина</div><h1>Инвестиции</h1><p>Контроль активов, операций, регулярного взноса и актуальности оценок.</p></div>
    <div class="investment-head-actions">
      <button class="btn btn-outline" data-act="open-plan">План взноса</button>
      <button class="btn btn-primary" data-act="add-tx">+ Операция</button>
    </div>
  </div>
  <section class="investment-pulse card">
    <div class="investment-pulse-main">
      <span class="pulse-icon">↗</span>
      <div><div class="stat-label">Регулярный инвестиционный взнос</div><b>${monthlyTargetText}</b><p>${st.monthlyGap > 0 ? `Осталось внести ${fmt(st.monthlyGap)}.` : st.monthlyTarget > 0 ? "План месяца закрыт." : "Укажите сумму в стабильных пунктах зарплаты."}</p></div>
    </div>
    <div class="investment-pulse-bar"><div style="width:${st.monthlyTarget ? st.monthlyProgress : 8}%"></div></div>
  </section>
  <div class="chip-row investment-tabs mb-14">${tabBtns}</div>
  <div id="investContent">${content}</div>`;
}
function investOverview(p) {
  if (!p || !p.assets.length)
    return `<div class="investment-empty-grid">
      ${richEmpty("↗", "Портфель пока пустой", "Добавьте первый актив, чтобы отслеживать вложения, текущую стоимость и прибыль/убыток.", "add-asset", "+ Добавить актив")}
      <div class="card pad-lg investment-guide"><div class="section-title mt-0">Как лучше заполнить</div>
        <ol>
          <li><b>Актив</b> — название, тип и тикер для автоцен.</li>
          <li><b>Операция</b> — покупка или продажа в гривнах.</li>
          <li><b>Оценка</b> — текущая стоимость раз в месяц, чтобы P/L был честным.</li>
        </ol>
      </div>
    </div>`;
  const st = investmentStats(p);
  const total = st.total;
  const pnlClass = total.totalPnL >= 0 ? "green-num" : "red-num";
  // Стрелка дублирует цвет — важно для дальтоников (аудит 6.1/10.4).
  const pnlBadge = st.pnlPct != null
    ? `<span style="color:${total.totalPnL >= 0 ? "var(--color-positive)" : "var(--color-risk)"};font-size:14px;font-weight:800">${total.totalPnL >= 0 ? "▲" : "▼"} ${signedPct(st.pnlPct)}</span>`
    : "";
  const insights = investmentInsights(p)
    .map((tip) => `<div class="investment-tip ${tip.tone}">
      <div><b>${escapeHtml(tip.title)}</b><p>${escapeHtml(tip.text)}</p></div>
      <button class="btn btn-sm ${tip.tone === "action" ? "btn-primary" : "btn-outline"}" data-act="${tip.action || "set-inv-tab"}" ${tip.view ? `data-inv-target="${tip.view}"` : ""}>${escapeHtml(tip.button)}</button>
    </div>`)
    .join("");
  const typeRows = allocationByType(p)
    .map((g) => `<div class="prop-row invest-prop"><div class="row-between small"><b>${assetTypeLabel(g.type)}</b><span>${g.pct}% · ${fmt(g.value)}</span></div><div class="goal-mini"><div style="width:${g.pct}%"></div></div></div>`)
    .join("");
  const assetRows = [...p.assets]
    .sort((a, b) => (Number(b.currentValue) || 0) - (Number(a.currentValue) || 0))
    .slice(0, 5)
    .map((a) => {
      const share = investPct(a.currentValue, total.totalValue);
      return `<div class="investment-asset-mini"><div><b>${escapeHtml(a.name)}</b><span>${assetTypeLabel(a.type)}${a.ticker ? ` · ${escapeHtml(a.ticker)}` : ""}</span></div><div><strong>${fmt(a.currentValue)}</strong><em class="${a.totalPnL >= 0 ? "green-num" : "red-num"}">${a.totalPnL >= 0 ? "▲ +" : "▼ "}${fmt(a.totalPnL)} · ${share}%</em></div></div>`;
    })
    .join("");
  const chartHtml = st.valuations.length
    ? `<div class="card pad-lg"><div class="stat-label">Динамика портфеля по месяцам</div><canvas id="portChart" class="chart-line"></canvas></div>`
    : `<div class="card pad-lg investment-guide"><div class="section-title mt-0">Динамика появится после оценок</div><p class="muted">Добавляйте одну оценку стоимости активов в месяц — здесь будет график портфеля.</p><button class="btn btn-outline btn-sm" data-act="add-valuation">+ Оценка</button></div>`;
  return `
  <div class="grid cards investment-kpis">
    <div class="card"><div class="stat-label"><span class="stat-ico">💼</span> Стоимость портфеля</div><div class="stat-value">${fmt(total.totalValue)}</div><div class="stat-sub">${fmtUsd(total.totalValue)} · ${p.assets.length} активов</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">💸</span> Вложено</div><div class="stat-value sm">${fmt(total.totalInvested)}</div><div class="stat-sub">себестоимость открытых позиций</div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">📊</span> Прибыль / Убыток</div><div class="stat-value sm ${pnlClass}">${fmt(total.totalPnL)}</div><div class="stat-sub">${fmtUsd(total.totalPnL)} ${pnlBadge} <span class="muted" title="P/L в гривне пересчитан по текущему курсу и включает курсовую переоценку, а не только рыночный результат">ⓘ с учётом курса</span></div></div>
    <div class="card"><div class="stat-label"><span class="stat-ico">⏱</span> Актуальность</div><div class="stat-value sm">${st.lastValDate ? fmtDate(st.lastValDate) : "—"}</div><div class="stat-sub">${st.daysSinceValuation == null ? "нет оценок" : `${st.daysSinceValuation} дн. назад`}</div></div>
  </div>
  <div class="investment-layout">
    <div class="investment-left">
      <div class="card pad-lg"><div class="row-between"><div class="section-title m-0">Следующие действия</div><button class="btn btn-sm btn-outline" data-act="refresh-prices">🔄 Обновить цены</button></div><div class="investment-tips">${insights}</div></div>
      ${chartHtml}
    </div>
    <div class="investment-right">
      <div class="card pad-lg"><div class="section-title mt-0">Аллокация по типам</div>${typeRows || '<p class="muted">Нет стоимости по типам.</p>'}</div>
      <div class="card pad-lg"><div class="row-between"><div class="section-title m-0">Крупнейшие позиции</div><button class="btn btn-sm btn-outline" data-act="set-inv-tab" data-inv-target="assets">Все</button></div><div class="investment-mini-list">${assetRows}</div></div>
    </div>
  </div>`;
}
function investAssets(p) {
  const rows = p
    ? p.assets
        .map((a) => {
          const latestVal = assetLatestValuation(a.id, p);
          const lastTx = assetLastTx(a.id, p);
          const pct = investPct(a.currentValue, p.totals?.totalValue || 0);
          return `<div class="wallet-row investment-row">
    <div class="investment-row-title"><b>${escapeHtml(a.name)}</b><div class="muted small">${assetTypeLabel(a.type)}${a.ticker ? " · " + escapeHtml(a.ticker) : ""}${a.currency ? " · цены " + escapeHtml(a.currency) : ""}</div></div>
    <div class="investment-row-metrics">
      <div class="row-between small"><span>${fmt(a.currentValue)}</span><span class="${a.totalPnL >= 0 ? "green-num" : "red-num"}">${a.totalPnL >= 0 ? "▲ +" : "▼ "}${fmt(a.totalPnL)}</span></div>
      <div class="goal-mini"><div style="width:${pct}%"></div></div>
      <div class="muted small">${pct}% портфеля · кол-во ${a.quantityHeld} · вложено ${fmt(a.totalInvested)}</div>
      <div class="muted small">последняя оценка: ${latestVal ? fmtDate(latestVal.date) : "—"}${lastTx ? ` · операция: ${fmtDate(lastTx.date)}` : ""}</div>
    </div>
    <button class="btn btn-sm btn-danger" data-act="delete-invest-asset" data-id="${escapeAttr(a.id)}" title="Удалить актив">×</button>
  </div>`;
        })
        .join("")
    : "";
  return `<div class="card pad-lg"><div class="row-between"><div><div class="section-title m-0">Активы</div><p class="muted small mt-4-clear">Доля, P/L, количество и дата последней оценки по каждой позиции.</p></div><button class="btn btn-primary btn-sm" data-act="add-asset">+ Актив</button></div>
    <div class="mt-14">${rows || richEmpty("↗", "Нет активов", "Добавьте первый актив, затем покупки и оценки стоимости.", "add-asset", "+ Актив")}</div></div>`;
}
function investTransactions(p) {
  if (!p?.assets?.length) return richEmpty("↗", "Сначала нужен актив", "Операции привязываются к активу — добавьте ETF, акцию, крипту или депозит.", "add-asset", "+ Актив");
  const rows = p
    ? p.transactions
        .map((t) => {
          const asset = p.assets.find((a) => a.id === t.assetId);
          return `<div class="wallet-row investment-row">
      <div><b>${escapeHtml(asset?.name || t.assetId)}</b><div class="muted small">${fmtDate(t.date)} · ${t.type === "buy" ? "Покупка" : "Продажа"}${t.note ? " · " + escapeHtml(t.note) : ""}</div></div>
      <div class="investment-row-metrics compact">
        <div class="row-between small"><span>${t.quantity} × ${fmt(t.price)}</span><span>${fmt(t.totalAmount)}</span></div>
        <div class="muted small">комиссия: ${fmt(t.fee)}</div>
      </div>
      <button class="btn btn-sm btn-danger" data-act="delete-invest-tx" data-id="${escapeAttr(t.id)}" title="Удалить операцию">×</button>
    </div>`;
        })
        .join("")
    : "";
  const monthTotal = investmentStats(p).monthlyBuy;
  return `<div class="card pad-lg"><div class="row-between"><div><div class="section-title m-0">Операции покупки/продажи</div><p class="muted small mt-4-clear">Покупки за текущий месяц: ${fmt(monthTotal)}</p></div><button class="btn btn-primary btn-sm" data-act="add-tx">+ Операция</button></div>
    <div class="mt-14">${rows || '<p class="muted">Нет операций.</p>'}</div></div>`;
}
function investValuations(p) {
  if (!p?.assets?.length) return richEmpty("↗", "Сначала нужен актив", "Оценки показывают текущую стоимость активов и строят график портфеля.", "add-asset", "+ Актив");
  const rows = p
    ? p.valuations
        .map((v) => {
          const asset = p.assets.find((a) => a.id === v.assetId);
          return `<div class="wallet-row investment-row">
      <div><b>${escapeHtml(asset?.name || v.assetId)}</b><div class="muted small">${fmtDate(v.date)}${v.note ? " · " + escapeHtml(v.note) : ""}</div></div>
      <div class="stat-value sm">${fmt(v.value)}</div>
      <button class="btn btn-sm btn-danger" data-act="delete-invest-valuation" data-id="${escapeAttr(v.id)}" title="Удалить оценку">×</button>
    </div>`;
        })
        .join("")
    : "";
  return `<div class="card pad-lg"><div class="row-between"><div><div class="section-title m-0">Ежемесячные оценки</div><p class="muted small mt-4-clear">Одна актуальная оценка в месяц делает P/L и график полезными.</p></div><button class="btn btn-primary btn-sm" data-act="add-valuation">+ Оценка</button></div>
    <div class="mt-14">${rows || '<p class="muted">Добавьте оценку стоимости актива.</p>'}</div></div>`;
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
    <div class="card"><div class="stat-label">Свободно из излишков</div><div class="stat-value sm ${remainingSurplus() < 0 ? "red-num" : ""}">${fmt(remainingSurplus())}</div><div class="stat-sub">та же формула, что в кабинете и плане</div></div>
  </div>
  <div class="card pad-lg" style="margin-top:16px"><div class="section-title mt-0">Карманы</div>${rows || richEmpty("◫", "Кошельков ещё нет", "Создайте карманы для еды, транспорта, инвестиций и свободных трат — так остаток не смешивается.", "add-wallet", "+ Кошелёк")}</div>`;
}

function viewPlan() {
  if (!state.allocation)
    return `<div class="view-head"><h1>План распределения</h1></div>${noPlanBlock()}`;
  const a = state.allocation;
  const available = a.totals.availableToAllocate;
  const planned = manualPlanTotal();
  const sortedItems = [...state.items].sort(
    (a, b) => amountToFund(b) - amountToFund(a),
  );
  const manualRows = sortedItems
    .map((it) => {
      const amount = manualAmountFor(it.id);
      const gp = goalProgress(it);
      const left = amountToFund(it);
      return `<div class="manual-row">
      <div><b>${escapeHtml(it.title)}</b><div class="muted small">к распределению ${fmt(left)} · накоплено ${fmt(gp.saved)} из ${fmt(gp.cost)}</div></div>
      <input type="number" min="0" max="${left}" value="${amount || ""}" placeholder="0" inputmode="decimal" data-manual="${it.id}" />
    </div>`;
    })
    .join("");
  return `
  <div class="view-head row-between">
    <div><h1>План распределения</h1><p>Распределяйте только излишки после обязательных расходов, страховки и инвестиций; авто-план остаётся подсказкой рядом.</p></div>
    <div class="row-gap-8"><button class="btn btn-ghost" data-act="what-if">Что если…</button>
    <button class="btn btn-outline" data-act="close-month">Закрыть месяц</button></div>
  </div>
  ${state.meta?.monobank?.enabled ? `<div class="card pad-lg mb-16" id="monoCard"><div class="row-between"><div class="section-title m-0">План vs факт (Monobank)</div><button class="btn btn-sm btn-outline" data-act="load-mono">Показать</button></div><div id="monoBody"></div></div>` : ""}
  <div class="card pad-lg mb-16">
    <div class="row-between"><div><div class="section-title m-0">Ручной план</div><p class="muted small mt-4-clear">Введите, сколько отправить на каждое желание в этом месяце.</p></div>
      <div><div class="stat-value sm ${planned > available ? "red-num" : "green-num"}" data-manual-total>${fmt(planned)}</div><div class="muted small">из ${fmt(available)}</div></div></div>
    <div class="manual-list">${manualRows || richEmpty("🎯", "Пока нечего распределять", "Добавьте желания в очередь — здесь появится ручной план распределения излишков.", "add-item", "+ Добавить желание")}</div>
    <div class="row-between mt-12">
      <span class="${remainingSurplus() < 0 ? "red-num" : "muted"}" data-manual-remaining>${remainingSurplus() < 0 ? "План выше доступного бюджета" : `Свободно ещё ${fmt(remainingSurplus())}${planned > 0 ? "" : " (авто-распределение)"}`}</span>
      <button class="btn btn-primary" data-act="save-manual-plan">Сохранить ручной план</button>
    </div>
  </div>
  ${planWalletsStrip()}`;
}

// Кошельки участвуют в распределении, поэтому видны прямо на «Плане» (аудит 2.4).
function planWalletsStrip() {
  if (!state.wallets.length)
    return `<div class="card pad-lg plan-wallets"><div class="row-between"><div><div class="section-title m-0">Кошельки месяца</div><p class="muted small mt-4-clear">Карманов пока нет — заведите их, чтобы видеть, где лежат деньги месяца.</p></div><button class="btn btn-outline btn-sm" data-act="go-view" data-target-view="wallets">Открыть кошельки</button></div></div>`;
  const total = state.wallets.reduce((sum, w) => sum + Number(w.amount || 0), 0);
  const chips = state.wallets
    .slice(0, 6)
    .map((w) => `<div class="stat-chip"><span>${escapeHtml(w.name)}</span><b>${fmt(Number(w.amount || 0))}</b></div>`)
    .join("");
  return `<div class="card pad-lg plan-wallets">
    <div class="row-between"><div><div class="section-title m-0">Кошельки месяца</div><p class="muted small mt-4-clear">Всего по карманам: <b>${fmt(total)}</b></p></div>
    <button class="btn btn-outline btn-sm" data-act="go-view" data-target-view="wallets">Открыть кошельки</button></div>
    <div class="stat-chips" style="margin:10px 0 0">${chips}</div>
  </div>`;
}

function viewMore() {
  return `<div class="view-head"><h1>Ещё</h1><p>Редкие разделы и настройки собраны здесь, чтобы нижняя навигация не перегружала телефон.</p></div>
    <div class="more-grid">
      ${moduleEnabled("wallets") ? `<button class="card more-tile" data-act="go-view" data-target-view="wallets"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-wallet"/></svg></span><b>Кошельки</b><p>Карманы текущего месяца</p></button>` : ""}
      <button class="card more-tile" data-act="go-view" data-target-view="history"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-history"/></svg></span><b>История</b><p>Закрытые месяцы и решения</p></button>
      <button class="card more-tile" data-act="go-view" data-target-view="assistant"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-spark"/></svg></span><b>AI-ассистент</b><p>Пояснения и компромиссы</p></button>
      <button class="card more-tile" data-act="open-plan"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-pencil"/></svg></span><b>Настройки плана</b><p>Зарплата, расходы, резерв</p></button>
      <button class="card more-tile" data-act="go-view" data-target-view="settings"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-gear"/></svg></span><b>Настройки</b><p>Безопасность, валюты, данные</p></button>
      <button class="card more-tile" data-act="toggle-theme"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-theme"/></svg></span><b>Тема</b><p>Светлая / тёмная / авто</p></button>
      <button class="card more-tile danger" id="logoutBtnMobileMore" type="button"><span class="tile-ico"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-power"/></svg></span><b>Выйти</b><p>Завершить сессию</p></button>
    </div>`;
}

function viewHistory() {
  if (!state.history.length) {
    return `<div class="view-head"><h1>История решений</h1><p>Закрытые месяцы появятся здесь.</p></div>
      ${richEmpty("↺", "История начнётся после первого закрытого месяца", "Когда зарплата распределена и решения выполнены — закройте месяц на экране плана, чтобы сохранить снимок.", "go-view", "Открыть план", "plan")}`;
  }
  const years = [
    ...new Set(
      state.history.map((h) => String(h.closedAt || h.payday || "").slice(0, 4)),
    ),
  ].filter(Boolean);
  // Итоги за все закрытые месяцы: аналитика должна делать выводы (аудит 8.3).
  const months = state.history
    .map((h) => {
      const t = h.snapshot?.totals || {};
      return {
        name: h.name,
        salary: Number(t.salary ?? h.salary) || 0,
        allocated: Number(t.allocated) || 0,
        remaining: Number(t.remaining) || 0,
      };
    })
    .filter((m) => m.salary > 0);
  let summaryBlock = "";
  if (months.length >= 2) {
    const avgRemaining =
      months.reduce((acc, m) => acc + m.remaining, 0) / months.length;
    const avgWishShare =
      (months.reduce((acc, m) => acc + (m.salary ? m.allocated / m.salary : 0), 0) /
        months.length) *
      100;
    const best = months.reduce((a, b) => (b.remaining > a.remaining ? b : a));
    const worst = months.reduce((a, b) => (b.remaining < a.remaining ? b : a));
    summaryBlock = `<div class="card pad-lg mb-16">
      <div class="section-title mt-0">Итоги за ${months.length} мес.</div>
      <div class="grid cards mt-10">
        <div class="card"><div class="stat-label">Средний остаток</div><div class="stat-value sm ${avgRemaining < 0 ? "red-num" : "green-num"}">${fmt(Math.round(avgRemaining))}</div></div>
        <div class="card"><div class="stat-label">Распределяется в среднем</div><div class="stat-value sm">${Math.round(avgWishShare)}%</div><div class="stat-sub">от зарплаты</div></div>
        <div class="card"><div class="stat-label">Лучший месяц</div><div class="stat-value sm green-num">${fmt(best.remaining)}</div><div class="stat-sub">${escapeHtml(best.name)}</div></div>
        <div class="card"><div class="stat-label">Сложный месяц</div><div class="stat-value sm ${worst.remaining < 0 ? "red-num" : ""}">${fmt(worst.remaining)}</div><div class="stat-sub">${escapeHtml(worst.name)}</div></div>
      </div>
    </div>`;
  }
  return `<div class="view-head row-between">
    <div><h1>История решений</h1><p>Что ты решал в прошлые месяцы: купленное, отложенное, остаток.</p></div>
    <div class="row-gap-8">${years.map((y) => `<button class="btn btn-outline btn-sm" data-act="year-report" data-year="${y}">Отчёт ${y} CSV</button>`).join("")}</div>
  </div>
  ${summaryBlock}
  <div class="grid cards mb-16">
    <div class="card pad-lg"><div class="section-title mt-0">Портфель по оценкам</div><canvas id="nwChart" height="160"></canvas><p class="muted small" id="nwHint"></p></div>
    <div class="card pad-lg"><div class="section-title mt-0">Свободный остаток по месяцам</div><canvas id="monthChart" height="160"></canvas><p class="muted small" id="monthHint"></p></div>
  </div>
    ${state.history
      .map((h) => {
        const s = h.snapshot || {};
        const t = s.totals || {};
        return `<div class="card pad-lg mb-14">
        <div class="row-between"><div><b>${escapeHtml(h.name)}</b> <span class="muted small">· зарплата ${fmtDate(h.payday)} · закрыт ${fmtDate(h.closedAt)}</span></div>
          <span class="status-badge status-${t.status || "safe"}">${STATUS_LABELS[t.status] || ""}</span></div>
        <div class="grid cards mt-12">
          <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value sm">${fmt(t.salary || h.salary)}</div></div>
          <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(t.allocated)}</div></div>
          <div class="card"><div class="stat-label">Осталось</div><div class="stat-value sm green-num">${fmt(t.remaining)}</div></div>
        </div>
        <div class="mt-12"><span class="muted small">Куплено:</span> ${(s.approved || []).filter((x) => x.purchased !== false).map((x) => escapeHtml(x.title)).join(", ") || "—"}</div>
        ${(s.approved || []).some((x) => x.purchased === false) ? `<div class="mt-6"><span class="muted small">Не куплено (ушло в накопление):</span> ${(s.approved || []).filter((x) => x.purchased === false).map((x) => escapeHtml(x.title)).join(", ")}</div>` : ""}
        <div class="mt-6"><span class="muted small">Отложено:</span> ${(s.deferred || []).map((x) => escapeHtml(x.title)).join(", ") || "—"}</div>
        ${state.meta?.ai?.enabled ? `<div class="mt-10"><button class="btn btn-ghost btn-sm" data-act="month-review" data-id="${h.id}">✦ AI-разбор месяца</button></div>` : ""}
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
  pushUiPrefs({ chatHistory });
}
loadChatHistory();

// ---------- ui-prefs: тема/палитра/чат переносятся между устройствами (аудит 14.4) ----------
let _prefsT = null;
function pushUiPrefs(patch) {
  if (!state.authed) return;
  clearTimeout(_prefsT);
  _prefsT = setTimeout(() => {
    api.put("/api/ui-prefs", patch).catch(() => {});
  }, 800);
}
async function pullUiPrefs() {
  try {
    const prefs = await api.get("/api/ui-prefs");
    if (prefs.theme && isTheme(prefs.theme) && prefs.theme !== currentTheme())
      applyTheme(prefs.theme);
    if (
      prefs.palette &&
      isPalette(prefs.palette) &&
      prefs.palette !== currentPalette()
    )
      applyPalette(prefs.palette);
    if (Array.isArray(prefs.chatHistory) && prefs.chatHistory.length) {
      const local = JSON.stringify(chatHistory);
      const remote = JSON.stringify(prefs.chatHistory);
      // Сервер — источник истины, если локальной истории нет или она короче.
      if (local !== remote && prefs.chatHistory.length >= chatHistory.length) {
        chatHistory = prefs.chatHistory
          .map(sanitizeChatMessage)
          .filter(Boolean)
          .slice(-50);
        try {
          localStorage.setItem("chatHistory", JSON.stringify(chatHistory));
        } catch {}
      }
    }
  } catch {}
}

function md(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/^- (.+)/gm, "• $1")
    .replace(/\n/g, "<br>");
}

function viewAssistant() {
  const enabled = state.meta?.ai?.enabled;
  return `<div class="view-head"><h1>AI-ассистент</h1><p>Советует, что купить первым, что отложить, и поясняет компромиссы на основе твоего плана.</p></div>
  ${!enabled ? `<div class="tradeoff" style="background:rgba(245,177,61,.1);border-color:var(--color-warning)"><b style="color:var(--color-warning)">AI выключен.</b> Добавьте AI_PROVIDER и AI_API_KEY в окружение сервера, чтобы включить ассистента. Остальное приложение работает без него.</div>` : ""}
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
    el.addEventListener("click", async (ev) => {
      const act = el.dataset.act;
      const id = Number(el.dataset.id);
      try {
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
      else if (act === "bought") await markBought(id, ev);
      else if (act === "tradeoff") await showTradeoff(id);
      else if (act === "close-month") closeMonth();
      else if (act === "what-if") openSimulatorModal();
      else if (act === "load-mono") await loadMonobankSummary(el);
      else if (act === "month-review") openMonthReviewModal(id || undefined);
      else if (act === "year-report") await downloadYearReport(el.dataset.year);
      else if (act === "ai-explain") await explainItem(id);
      else if (act === "delete") await deleteItem(id);
      else if (act === "delete-wallet") await deleteWallet(el.dataset.id);
      else if (act === "delete-invest-asset") await deleteInvestmentAsset(el.dataset.id);
      else if (act === "delete-invest-tx") await deleteInvestmentTransaction(el.dataset.id);
      else if (act === "delete-invest-valuation") await deleteInvestmentValuation(el.dataset.id);
      else if (act === "set-inv-tab") {
        state.invTab = el.dataset.invTarget || "overview";
        renderView();
      }
      else if (act === "go-view") setView(el.dataset.targetView || "dashboard");
      else if (act === "dismiss-onboarding") {
        localStorage.setItem("onboardingDismissed", "1");
        closeModal();
        renderView();
      }
      else if (act === "refresh-prices") await refreshPrices();
      else if (act === "toggle-theme") toggleTheme();
      else if (act === "clear-chat") {
        chatHistory = [];
        saveChatHistory();
        $("#chatLog").innerHTML = "";
        document.getElementById("suggestions").innerHTML = "";
      }
      } catch (ex) {
        // Ошибка действия не должна теряться в консоли (аудит 3.8/11.2).
        if (ex?.message !== "unauthorized")
          toast("Ошибка: " + (ex?.message || "что-то пошло не так"));
      }
    });
  });
  $$(".queue-swipe").forEach((row) => bindSwipe(row));
  $("#quickAddForm")?.addEventListener("submit", quickAddItem);
  $("#quickAddDetails")?.addEventListener("click", () => {
    const f = new FormData($("#quickAddForm"));
    openItemModal(null, {
      title: String(f.get("title") || ""),
      cost: f.get("cost") ? Number(f.get("cost")) : "",
      category: String(f.get("category") || "lifestyle"),
      type: String(f.get("type") || "should"),
      priority: Number(f.get("priority") || 3),
      deadline: String(f.get("deadline") || ""),
    });
  });
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
  $$("[data-filter]").forEach((el) => {
    // Текстовый поиск: debounce + возврат фокуса и каретки после перерисовки,
    // иначе фокус теряется на каждом символе (аудит 3.1).
    if (el.tagName === "INPUT") {
      el.addEventListener("input", () => {
        state.queueFilters[el.dataset.filter] = el.value;
        clearTimeout(el._filterT);
        el._filterT = setTimeout(() => {
          const pos = el.selectionStart;
          renderView();
          const next = $(`[data-filter="${el.dataset.filter}"]`);
          if (next) {
            next.focus();
            try {
              next.setSelectionRange(pos, pos);
            } catch {}
          }
        }, 250);
      });
    } else {
      el.addEventListener("input", () => {
        state.queueFilters[el.dataset.filter] = el.value;
        renderView();
      });
    }
  });
  $$("[data-inv-tab]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.invTab = btn.dataset.invTab;
      renderView();
    }),
  );
  $("#logoutBtnMobileMore")?.addEventListener("click", doLogout);
  $$('[data-manual]').forEach((el) => {
    el.addEventListener("input", updateManualPlanDraft);
  });
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

async function markBought(id, ev) {
  const item = state.items.find((i) => i.id === id);
  await api.post(`/api/items/${id}/status`, { status: "bought" });
  // Конфетти — только после успешного ответа сервера (аудит 3.2).
  confettiBurst(
    ev?.clientX || window.innerWidth / 2,
    ev?.clientY || window.innerHeight * 0.4,
  );
  await refresh();
  // «Куплено» можно отменить — особенно важно из-за свайпа (аудит 3.2).
  toast(`«${item ? item.title : "Желание"}» куплено`, {
    duration: 6000,
    action: {
      label: "Отменить",
      onClick: async () => {
        await api.post(`/api/items/${id}/status`, { status: "active" });
        await refresh();
        toast("Возвращено в очередь");
      },
    },
  });
}

// Удаление с возможностью отмены: желание сразу убирается из интерфейса,
// а реальный DELETE уходит на сервер через 6 секунд, если не нажали «Отменить».
const pendingDeletes = new Map();

function flushPendingDeletes() {
  for (const [id, pending] of pendingDeletes) {
    clearTimeout(pending.timer);
    // keepalive — запрос доживёт даже при закрытии вкладки
    fetch(`/api/items/${id}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }
  pendingDeletes.clear();
}
window.addEventListener("pagehide", flushPendingDeletes);

async function commitDelete(id) {
  const pending = pendingDeletes.get(id);
  if (!pending || pending.remote) return; // удаляет только вкладка-инициатор
  pendingDeletes.delete(id);
  try {
    await api.del(`/api/items/${id}`);
  } catch {}
  try {
    SYNC_CHANNEL?.postMessage({ t: "pending-commit", id });
  } catch {}
  await refresh();
}

async function deleteItem(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item || pendingDeletes.has(id)) return;
  const timer = setTimeout(() => commitDelete(id), 6000);
  pendingDeletes.set(id, { timer });
  try {
    SYNC_CHANNEL?.postMessage({ t: "pending-delete", id });
  } catch {}
  state.items = state.items.filter((i) => i.id !== id);
  // Кабинет не должен 6 секунд показывать удалённое в плане (аудит 3.10).
  if (state.allocation?.approved)
    state.allocation.approved = state.allocation.approved.filter(
      (a) => (a.itemId ?? a.item?.id) !== id,
    );
  if (state.allocation?.deferred)
    state.allocation.deferred = state.allocation.deferred.filter(
      (a) => (a.itemId ?? a.item?.id) !== id,
    );
  renderView();
  toast(`«${item.title}» удалено`, {
    duration: 6000,
    action: {
      label: "Отменить",
      onClick: async () => {
        const pending = pendingDeletes.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingDeletes.delete(id);
        try {
          SYNC_CHANNEL?.postMessage({ t: "pending-restore", id });
        } catch {}
        await refresh();
        toast("Восстановлено");
      },
    },
  });
}

function bindSwipe(row) {
  let startX = 0;
  let startY = 0;
  row.addEventListener(
    "touchstart",
    (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true },
  );
  row.addEventListener(
    "touchend",
    async (e) => {
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      // Диагональный скролл не должен случайно «покупать»/удалять:
      // жест засчитываем только при явной горизонтали (аудит 9.2).
      if (Math.abs(dx) < 80 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) await markBought(Number(row.dataset.id), e);
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

function readManualPlanInputs() {
  let wasCapped = false;
  const manualPlan = $$("[data-manual]").map((el) => {
    const itemId = Number(el.dataset.manual);
    const item = itemById(itemId);
    const raw = Math.max(0, Number(el.value) || 0);
    const amount = item ? Math.min(raw, amountToFund(item)) : raw;
    if (raw !== amount) wasCapped = true;
    return { itemId, amount };
  });
  return { manualPlan, wasCapped };
}

function renderManualPlanDraftTotals() {
  if (state.view !== "plan") return;
  const available = state.allocation?.totals?.availableToAllocate || 0;
  const planned = manualPlanTotal();
  const totalEl = $("[data-manual-total]");
  if (totalEl) {
    totalEl.textContent = fmt(planned);
    totalEl.classList.toggle("red-num", planned > available);
    totalEl.classList.toggle("green-num", planned <= available);
  }
  const remainingEl = $("[data-manual-remaining]");
  if (remainingEl) {
    const free = remainingSurplus();
    remainingEl.textContent =
      free < 0
        ? "План выше доступного бюджета"
        : `Свободно ещё ${fmt(free)}${planned > 0 ? "" : " (авто-распределение)"}`;
    remainingEl.classList.toggle("red-num", free < 0);
    remainingEl.classList.toggle("muted", free >= 0);
  }
}

function updateManualPlanDraft() {
  state.manualPlan = readManualPlanInputs().manualPlan;
  renderManualPlanDraftTotals();
}

async function saveManualPlan() {
  const { manualPlan, wasCapped } = readManualPlanInputs();
  state.manualPlan = manualPlan;
  renderManualPlanDraftTotals();
  await api.post("/api/manual-plan", { manualPlan });
  toast(
    wasCapped
      ? "Ручной план сохранён; суммы выше остатка обрезаны"
      : "Ручной план сохранён",
  );
  await refresh();
}

async function closeMonth() {
  // Чек-лист закрытия месяца: отмечаем, что реально куплено.
  let preview;
  try {
    preview = await api.get("/api/plan/close-preview");
  } catch (ex) {
    return toast("Ошибка: " + ex.message);
  }
  const rows = (preview.approved || [])
    .map(
      (a) => `<label class="wallet-row" style="cursor:pointer">
        <div><b>${escapeHtml(a.title)}</b>
          <div class="muted small">${fmt(a.allocatedAmount)} из ${fmt(a.cost)}${a.recurring ? " · 🔁 регулярное" : ""}${a.fullyFunded ? "" : " · накоплено не всё"}</div></div>
        <input type="checkbox" class="close-purchase check-20" data-id="${a.itemId}" ${a.fullyFunded ? "checked" : ""} />
      </label>`,
    )
    .join("");
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Закрыть месяц</h2><button class="close-x" data-close-modal>×</button></div>
    <p class="muted small">Отметь, что реально куплено. Неотмеченное останется в очереди, а выделенные на него деньги превратятся в накопление. Отложенных желаний: ${preview.deferredCount}.</p>
    <p class="small" style="color:var(--color-warning)">⚠️ Закрытие месяца необратимо: план уйдёт в историю, а текущие распределения зафиксируются.</p>
    <div>${rows || '<p class="muted">В этом месяце ничего не было одобрено.</p>'}</div>
    <div class="modal-foot mt-14">
      <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
      <button type="button" class="btn btn-primary" id="confirmCloseBtn">Закрыть месяц</button>
    </div>
  </div>`);
  $("#confirmCloseBtn").addEventListener("click", async () => {
    const purchases = $$(".close-purchase").map((el) => ({
      itemId: +el.dataset.id,
      purchased: el.checked,
    }));
    await api.post("/api/plan/close", { scenario: "balanced", purchases });
    closeModal();
    confettiBurst(window.innerWidth / 2, window.innerHeight * 0.3, 48);
    toast("Месяц закрыт и сохранён в истории 🎉");
    await refresh();
    // Предложим AI-разбор месяца, если ассистент включён.
    if (state.meta?.ai?.enabled) openMonthReviewModal();
  });
}

async function openMonthReviewModal(planId) {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Разбор месяца</h2><button class="close-x" data-close-modal>×</button></div>
    <div id="reviewBody"><p class="muted">Ассистент анализирует месяц…</p></div>
    <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close-modal>Закрыть</button></div>
  </div>`);
  try {
    const out = await api.post("/api/ai/month-review", planId ? { planId } : {});
    const body = $("#reviewBody");
    if (body) body.innerHTML = `<div class="msg bot">${md(out.reply || "")}</div>`;
  } catch (ex) {
    const body = $("#reviewBody");
    if (body) body.innerHTML = `<p class="muted">Не получилось: ${escapeHtml(ex.message)}</p>`;
  }
}

// What-if симулятор: двигаем параметры плана и смотрим виртуальное распределение.
function openSimulatorModal() {
  const p = state.plan;
  if (!p) return toast("Сначала настройте план");
  const slider = (name, label, value, max) => `<div class="field full"><label>${label}: <b data-sim-val="${name}">${fmtShort(value)}</b> грн</label>
    <input type="range" data-sim="${name}" min="0" max="${max}" step="100" value="${value}" class="w-full" /></div>`;
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Что если…</h2><button class="close-x" data-close-modal>×</button></div>
    <p class="muted small">Виртуальный расчёт — ничего не сохраняется.</p>
    <div class="form-grid">
      ${slider("salary", "Зарплата", p.salary || 0, Math.max(100000, (p.salary || 0) * 2))}
      ${slider("survivalCost", "Обязательные расходы", p.survivalCost || 0, Math.max(50000, (p.salary || 0)))}
      ${slider("buffer", "Страховка", p.buffer || 0, Math.max(20000, (p.salary || 0)))}
      ${slider("investmentFixed", "Инвестиции", p.investmentFixed || 0, Math.max(20000, (p.salary || 0)))}
    </div>
    <div id="simResult" class="mt-12"><p class="muted small">Двигайте ползунки…</p></div>
    <div class="modal-foot"><button type="button" class="btn btn-ghost" data-close-modal>Закрыть</button></div>
  </div>`);
  let timer = null;
  async function runSim() {
    const params = new URLSearchParams();
    $$("[data-sim]").forEach((el) => params.set(el.dataset.sim, el.value));
    try {
      const { allocation } = await api.get(`/api/allocation/simulate?${params}`);
      const t = allocation.totals || {};
      const box = $("#simResult");
      if (!box) return;
      box.innerHTML = `<div class="grid cards">
        <div class="card"><div class="stat-label">На желания</div><div class="stat-value sm">${fmt(t.availableToAllocate)}</div></div>
        <div class="card"><div class="stat-label">Остаток</div><div class="stat-value sm ${t.remaining < 0 ? "red-num" : "green-num"}">${fmt(t.remaining)}</div></div>
      </div>
      <div class="mt-10"><span class="muted small">Купится:</span> ${(allocation.approved || []).map((a) => escapeHtml(a.item.title)).join(", ") || "—"}</div>
      <div class="mt-6"><span class="muted small">Отложится:</span> ${(allocation.deferred || []).map((d) => escapeHtml(d.item.title)).join(", ") || "—"}</div>`;
    } catch {}
  }
  $$("[data-sim]").forEach((el) =>
    el.addEventListener("input", () => {
      const lbl = $(`[data-sim-val="${el.dataset.sim}"]`);
      if (lbl) lbl.textContent = fmtShort(el.value);
      clearTimeout(timer);
      timer = setTimeout(runSim, 250);
    }),
  );
  runSim();
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

async function deleteInvestmentAsset(id) {
  const asset = state.portfolio?.assets?.find((a) => String(a.id) === String(id));
  const ok = await confirmDialog({
    title: "Удалить актив?",
    text: `Актив «${asset?.name || "без названия"}» будет удалён вместе с его операциями и оценками.`,
    confirmText: "Удалить",
    danger: true,
  });
  if (!ok) return;
  await api.del(`/api/investments/assets/${encodeURIComponent(id)}`);
  toast("Актив удалён");
  await refresh();
}
async function deleteInvestmentTransaction(id) {
  const ok = await confirmDialog({ title: "Удалить операцию?", text: "Покупка/продажа будет убрана из расчёта количества, себестоимости и P/L.", confirmText: "Удалить", danger: true });
  if (!ok) return;
  await api.del(`/api/investments/transactions/${encodeURIComponent(id)}`);
  toast("Операция удалена");
  await refresh();
}
async function deleteInvestmentValuation(id) {
  const ok = await confirmDialog({ title: "Удалить оценку?", text: "Эта запись исчезнет из графика и расчёта текущей стоимости.", confirmText: "Удалить", danger: true });
  if (!ok) return;
  await api.del(`/api/investments/valuations/${encodeURIComponent(id)}`);
  toast("Оценка удалена");
  await refresh();
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

async function downloadYearReport(year) {
  const y = year || new Date().getFullYear();
  try {
    const resp = await fetch(`/api/export/report/${y}`);
    if (resp.status === 401) {
      showAuthGate();
      return toast("Сессия истекла");
    }
    if (!resp.ok) return toast("Ошибка загрузки отчёта");
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${y}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    toast("Годовой отчёт скачан");
  } catch (e) {
    toast("Ошибка: " + e.message);
  }
}

async function loadMonobankSummary(btn) {
  if (btn) btn.disabled = true;
  try {
    const s = await api.get("/api/monobank/summary");
    const box = $("#monoBody");
    if (!box) return;
    if (!s.enabled && s.enabled === false) {
      box.innerHTML = '<p class="muted small">Monobank не настроен (MONOBANK_TOKEN).</p>';
      return;
    }
    const plannedSpend = Number(s.plan?.survivalCost) || 0;
    const diff = (s.totals?.spent || 0) - plannedSpend;
    box.innerHTML = `<div class="grid cards mt-12">
      <div class="card"><div class="stat-label">Потрачено (${s.month})</div><div class="stat-value sm">${fmt(s.totals?.spent)}</div></div>
      <div class="card"><div class="stat-label">План обязательных</div><div class="stat-value sm">${fmt(plannedSpend)}</div></div>
      <div class="card"><div class="stat-label">Разница</div><div class="stat-value sm ${diff > 0 ? "red-num" : "green-num"}">${diff > 0 ? "+" : ""}${fmtShort(diff)} грн</div></div>
    </div>
    <div class="mt-10"><span class="muted small">Топ категорий:</span> ${(s.topCategories || []).map((c) => `${escapeHtml(c.label)} ${fmtShort(c.amount)}`).join(" · ") || "—"}</div>
    ${s.biggest?.length ? `<div class="mt-6"><span class="muted small">Самая крупная трата:</span> ${escapeHtml(s.biggest[0].description || "")} — ${fmt(s.biggest[0].amount)}</div>` : ""}`;
  } catch (ex) {
    const box = $("#monoBody");
    if (box) box.innerHTML = `<p class="muted small">Ошибка Monobank: ${escapeHtml(ex.message)}</p>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- push-уведомления ----------
function urlBase64ToUint8Array(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}
async function getPushSubscription() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function enablePush() {
  const publicKey = state.meta?.push?.publicKey;
  if (!publicKey) return toast("Push не настроен на сервере");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return toast("Уведомления запрещены в браузере");
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await api.post("/api/push/subscribe", { subscription: sub.toJSON() });
  toast("Уведомления включены 🎉");
}
async function disablePush() {
  const sub = await getPushSubscription();
  if (sub) {
    await api.post("/api/push/unsubscribe", { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
  toast("Уведомления выключены");
}

// ============================================================
// MODALS
// ============================================================
// Модалки: Esc закрывает, фокус заходит внутрь и возвращается обратно,
// Tab не убегает под оверлей (аудит 3.4 / 10.1).
let _modalReturnFocus = null;
function modalFocusables() {
  return $$(
    '#ov a[href], #ov button:not([disabled]), #ov input:not([disabled]):not([type="hidden"]), #ov select:not([disabled]), #ov textarea:not([disabled]), #ov [tabindex]:not([tabindex="-1"])',
  ).filter((el) => el.offsetParent !== null);
}
function openModal(html) {
  _modalReturnFocus = document.activeElement;
  $("#modalRoot").innerHTML =
    `<div class="modal-overlay" id="ov" role="dialog" aria-modal="true">${html}</div>`;
  const ov = $("#ov");
  ov.addEventListener("click", (e) => {
    if (e.target.id === "ov") closeModal();
  });
  $$("[data-close-modal]").forEach((el) =>
    el.addEventListener("click", closeModal),
  );
  ov.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;
    const els = modalFocusables();
    if (!els.length) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  const focusTarget =
    modalFocusables().find((el) => !el.classList.contains("close-x")) ||
    modalFocusables()[0];
  focusTarget?.focus();
}
function closeModal() {
  $("#modalRoot").innerHTML = "";
  if (_modalReturnFocus?.isConnected) {
    try {
      _modalReturnFocus.focus();
    } catch {}
  }
  _modalReturnFocus = null;
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
      <div class="field"><label>Тип</label><select name="type"><option value="should">Желательно</option><option value="must">Обязательно</option><option value="nice">По желанию</option></select></div>
      <div class="modal-foot field full flex-row"><button type="button" class="btn btn-ghost" data-close-modal>Отмена</button><button class="btn btn-primary">Добавить</button></div>
    </form></div>`);
  $("#quickItemForm").addEventListener("submit", quickAddItem);
}

// Полноценный экран настроек вместо модалки-свалки (аудит 2.2).
function viewSettings() {
  return `<div class="view-head"><h1>Настройки</h1><p>Безопасность, валюты, уведомления и данные — каждая группа на своём месте.</p></div>
  <div class="settings-grid">
    <section class="card pad-lg">
      <div class="section-title mt-0">Безопасность</div>
      <p class="muted small">PIN — минимум 6 цифр. «Выйти везде» разлогинит все устройства, кроме текущего.</p>
      <div class="settings-actions">
        <button class="btn btn-outline btn-sm" id="changePinBtn">Сменить PIN</button>
        <button class="btn btn-danger btn-sm" id="logoutAllBtn">Выйти на всех устройствах</button>
      </div>
    </section>
    <section class="card pad-lg">
      <div class="section-title mt-0">Курсы валют (грн)</div>
      <p class="muted small">Валютные желания пересчитываются автоматически при изменении курса.</p>
      <div class="settings-actions">
        <label class="muted small">USD <input type="number" id="currencyRateInput" class="settings-input" value="${state.currencyRate}" min="1" step="0.1" /></label>
        <label class="muted small">EUR <input type="number" id="eurRateInput" class="settings-input" value="${state.eurRate || 47}" min="1" step="0.1" /></label>
        <button class="btn btn-primary btn-sm" id="saveRateBtn">Сохранить</button>
        <button class="btn btn-outline btn-sm" id="nbuRateBtn" title="Подтянуть официальный курс НБУ">Курс НБУ</button>
      </div>
    </section>
    <section class="card pad-lg">
      <div class="section-title mt-0">Уведомления</div>
      <p class="muted small">День зарплаты, дедлайны желаний, падение цен по ссылкам.</p>
      <div class="settings-actions">
        <button class="btn btn-outline btn-sm" id="pushToggleBtn">…</button>
        <button class="btn btn-ghost btn-sm" id="pushTestBtn">Тестовый push</button>
      </div>
    </section>
    <section class="card pad-lg">
      <div class="section-title mt-0">Оформление</div>
      <p class="muted small">Тема и палитра. Палитры доступны в меню сверху.</p>
      <div class="settings-actions">
        <button class="btn btn-outline btn-sm" data-act="toggle-theme">Переключить тему</button>
      </div>
    </section>
    <section class="card pad-lg">
      <div class="section-title mt-0">Модули</div>
      <p class="muted small">Выключенные модули скрываются из навигации, данные не удаляются, расчёт «Свободно» не меняется.</p>
      <div class="settings-actions" style="flex-direction:column;align-items:flex-start;gap:8px">
        <label class="switch-row"><input type="checkbox" class="check-18 module-toggle" data-module="investments" ${moduleEnabled("investments") ? "checked" : ""}> Инвестиции</label>
        <label class="switch-row"><input type="checkbox" class="check-18 module-toggle" data-module="wallets" ${moduleEnabled("wallets") ? "checked" : ""}> Кошельки</label>
        <label class="switch-row"><input type="checkbox" class="check-18 module-toggle" data-module="pricecheck" ${moduleEnabled("pricecheck") ? "checked" : ""}> Прайс-трекер по ссылкам</label>
      </div>
      <p class="muted small mt-10">AI-ассистент: ${state.meta?.ai?.enabled ? "включён" : "выключен"} · Monobank: ${state.meta?.monobank?.enabled ? "подключён" : "не подключён"} — управляются переменными окружения (AI_PROVIDER, MONOBANK_TOKEN).</p>
    </section>
    <section class="card pad-lg">
      <div class="section-title mt-0">Данные</div>
      <p class="muted small">Экспорт — полный снимок в JSON. Импорт заменяет все данные.</p>
      <div class="settings-actions">
        <button class="btn btn-primary btn-sm" id="exportBtn" type="button">Экспорт JSON</button>
        <label class="btn btn-outline btn-sm" style="text-align:center">Импорт JSON<input id="importFile" type="file" accept="application/json" hidden></label>
        <button class="btn btn-outline btn-sm" id="csvItemsBtn">CSV желания</button>
        <button class="btn btn-outline btn-sm" id="csvTxBtn">CSV операции</button>
        <button class="btn btn-outline btn-sm" id="csvValBtn">CSV оценки</button>
        <button class="btn btn-outline btn-sm" data-act="year-report" data-year="${new Date().getFullYear()}">Годовой отчёт CSV</button>
      </div>
    </section>
    <section class="card pad-lg">
      <div class="section-title mt-0">Цели-накопления</div>
      <p class="muted small">Цели живут в очереди желаний: фильтр «Копится» покажет всё, на что вы откладываете.</p>
      <div class="settings-actions">
        <button class="btn btn-outline btn-sm" data-act="go-view" data-target-view="queue">Открыть очередь</button>
      </div>
    </section>
  </div>`;
}

function initSettings() {
  $$(".module-toggle").forEach((box) =>
    box.addEventListener("change", async () => {
      try {
        const r = await api.put("/api/settings/modules", { [box.dataset.module]: box.checked });
        if (state.meta) state.meta.modules = r.modules;
        applyModuleFlags();
        toast(box.checked ? "Модуль включён" : "Модуль скрыт из навигации");
      } catch (e) {
        box.checked = !box.checked;
        if (e.message !== "demo") toast("Не удалось сохранить: " + e.message);
      }
    }),
  );
  $("#exportBtn")?.addEventListener("click", exportData);
  $("#importFile")?.addEventListener("change", importData);
  $("#csvItemsBtn")?.addEventListener("click", () => downloadCSV("items"));
  $("#csvTxBtn")?.addEventListener("click", () => downloadCSV("transactions"));
  $("#csvValBtn")?.addEventListener("click", () => downloadCSV("valuations"));
  $("#saveRateBtn")?.addEventListener("click", async () => {
    const rate = +$("#currencyRateInput").value;
    const eurRate = +$("#eurRateInput").value;
    if (rate < 1 || eurRate < 1) return toast("Некорректный курс");
    await api.post("/api/currency", { rate, eurRate });
    state.currencyRate = rate;
    state.eurRate = eurRate;
    toast("Курсы сохранены, валютные желания пересчитаны");
    await refresh();
  });
  $("#nbuRateBtn")?.addEventListener("click", async () => {
    const btn = $("#nbuRateBtn");
    btn.disabled = true;
    btn.textContent = "Загружаю…";
    try {
      const out = await api.post("/api/currency/refresh");
      state.currencyRate = out.rate;
      state.eurRate = out.eurRate;
      $("#currencyRateInput").value = out.rate;
      $("#eurRateInput").value = out.eurRate;
      toast(`Курс НБУ: $ ${out.rate} · € ${out.eurRate}`);
      await refresh();
    } catch {
      toast("НБУ недоступен, попробуйте позже");
    } finally {
      btn.disabled = false;
      btn.textContent = "Курс НБУ";
    }
  });
  const pushBtn = $("#pushToggleBtn");
  if (pushBtn) {
    (async () => {
      const sub = await getPushSubscription().catch(() => null);
      pushBtn.textContent = sub ? "Выключить уведомления" : "Включить уведомления";
      pushBtn.dataset.on = sub ? "1" : "0";
    })();
    pushBtn.addEventListener("click", async () => {
      try {
        if (pushBtn.dataset.on === "1") {
          await disablePush();
          pushBtn.textContent = "Включить уведомления";
          pushBtn.dataset.on = "0";
        } else {
          await enablePush();
          pushBtn.textContent = "Выключить уведомления";
          pushBtn.dataset.on = "1";
        }
      } catch (ex) {
        toast("Ошибка: " + ex.message);
      }
    });
  }
  $("#pushTestBtn")?.addEventListener("click", async () => {
    const { sent } = await api.post("/api/push/test", {});
    toast(sent ? "Push отправлен" : "Нет активных подписок");
  });
  bindSettingsSecurity();
}

// «Данные и цели» переехали на полноценный экран настроек (аудит 2.2).
function openDataModal() {
  setView("settings");
}

function bindSettingsSecurity() {
  $("#changePinBtn")?.addEventListener("click", openChangePinModal);
  $("#logoutAllBtn")?.addEventListener("click", async () => {
    const ok = await confirmDialog({
      title: "Выйти на всех устройствах?",
      text: "Все сессии (включая эту) станут недействительными — потребуется заново ввести PIN.",
      confirmText: "Выйти везде",
      danger: true,
    });
    if (!ok) return;
    await api.post("/api/auth/logout-all", {});
    location.reload();
  });
}

function openChangePinModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Сменить PIN</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="changePinForm" class="form-grid">
      <div class="field full"><label>Текущий PIN</label><input type="password" name="currentPin" inputmode="numeric" autocomplete="current-password" required /></div>
      <div class="field full"><label>Новый PIN (4–12 цифр)</label><input type="password" name="newPin" inputmode="numeric" autocomplete="new-password" minlength="4" maxlength="12" required /></div>
      <div class="field full"><span class="muted small">После смены PIN остальные устройства будут разлогинены.</span></div>
      <div class="modal-foot field full flex-row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сменить</button>
      </div>
    </form></div>`);
  $("#changePinForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api.post("/api/auth/change-pin", {
        currentPin: f.get("currentPin"),
        newPin: f.get("newPin"),
      });
      closeModal();
      toast("PIN изменён. Другие устройства разлогинены.");
    } catch (ex) {
      toast(ex.message === "bad_pin" ? "Неверный текущий PIN" : "Ошибка: " + ex.message);
    }
  });
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
      <div class="modal-foot field full flex-row">
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
      <div class="field full"><label>Довнести сейчас, грн (опц.)</label><input type="number" name="contributionAmount" min="0" placeholder="0" />
        <span class="muted small">Запишется в историю взносов отдельной строкой.</span></div>
      <div class="field full"><div class="goal-mini big"><div style="width:${gp.pct}%"></div></div><span class="muted small">${gp.pct}% · осталось ${fmt(gp.left)}</span></div>
      <div class="field full"><div class="section-title" style="margin:6px 0">История взносов</div><div id="contribTimeline"><p class="muted small">Загрузка…</p></div></div>
      <div class="modal-foot field full flex-row">
        <button type="button" class="btn btn-ghost" data-close-modal>Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  // Таймлайн взносов: когда и сколько откладывалось на это желание.
  api
    .get(`/api/items/${item.id}/contributions`)
    .then(({ contributions }) => {
      const box = $("#contribTimeline");
      if (!box) return;
      box.innerHTML = contributions?.length
        ? contributions
            .map(
              (c) => `<div class="row-between" style="padding:4px 0;border-bottom:1px solid var(--border)">
                <span class="muted small">${fmtDate(c.date)}${c.note ? ` · ${escapeHtml(c.note)}` : ""}</span>
                <b class="small green-num">+${fmtShort(c.amount)} грн</b></div>`,
            )
            .join("")
        : '<p class="muted small">Взносов пока не было.</p>';
    })
    .catch(() => {
      const box = $("#contribTimeline");
      if (box) box.innerHTML = "";
    });
  $("#savingsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const contributionAmount = +f.get("contributionAmount") || 0;
    await api.post(`/api/items/${item.id}/savings`, {
      savedAmount: +f.get("savedAmount") + contributionAmount,
      monthlyContribution: +f.get("monthlyContribution"),
      contributionAmount: contributionAmount || undefined,
      note: contributionAmount ? "Ручной взнос" : undefined,
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
      <div class="modal-foot field full flex-row">
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
  if (!(state.portfolio?.assets || []).length) {
    toast("Сначала добавьте актив");
    return openAssetModal();
  }
  const assetOpts = (state.portfolio?.assets || [])
    .map((a) => `<option value="${escapeAttr(a.id)}">${escapeHtml(a.name)}</option>`)
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
      <div class="modal-foot field full flex-row">
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
  if (!(state.portfolio?.assets || []).length) {
    toast("Сначала добавьте актив");
    return openAssetModal();
  }
  const assetOpts = (state.portfolio?.assets || [])
    .map((a) => `<option value="${escapeAttr(a.id)}">${escapeHtml(a.name)}</option>`)
    .join("");
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Ежемесячная оценка</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="valForm" class="form-grid">
      <div class="field full"><label>Актив</label><select name="assetId" required>${assetOpts || "<option>Сначала добавьте актив</option>"}</select></div>
      <div class="field"><label>Дата</label><input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Текущая стоимость</label><input type="number" name="value" min="0" required /></div>
      <div class="field full"><label>Заметка</label><input name="note" /></div>
      <div class="modal-foot field full flex-row">
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
      <div class="modal-foot field full flex-row">
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

function openItemModal(item, prefill) {
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
  ...(prefill || {}),
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
  // Сегмент-контрол 1–5 вместо ползунка: на таче один тап точнее перетаскивания (аудит 9.4).
  const segBtns = (val) =>
    [1, 2, 3, 4, 5]
      .map(
        (n) =>
          `<button type="button" class="seg-btn${n === Number(val) ? " active" : ""}" data-val="${n}" aria-pressed="${n === Number(val)}">${n}</button>`,
      )
      .join("");
  const range = (
    name,
    val,
    label,
  ) => `<div class="field"><label>${label}</label><div class="seg-scale" role="group" aria-label="${label}">
      <input type="hidden" name="${name}" value="${val}">${segBtns(val)}</div></div>`;
  const critRow = (c) => `<div class="score-row" data-crit="${c.id}">
      <div><div class="sr-label">${c.ru} ${c.dir === "neg" ? '<span class="muted small">(чем меньше — тем лучше)</span>' : ""}</div><div class="sr-hint">${c.hint}</div></div>
      <div class="seg-scale" role="group" aria-label="${c.ru}"><input type="hidden" class="score-input" data-id="${c.id}" data-dir="${c.dir}" value="${scores[c.id] || 3}">${segBtns(scores[c.id] || 3)}</div>
    </div>`;
  const quickRows = state.meta.scoreCriteria.quick.map(critRow).join("");
  const fullRows = state.meta.scoreCriteria.full.map(critRow).join("");

  // modal-sheet: на мобильном раскрывается на весь экран со sticky-футером (аудит 9.3).
  openModal(`<div class="modal modal-sheet">
    <div class="modal-head"><h2>${item ? "Редактировать желание" : "Новое желание"}</h2><button class="close-x" data-close-modal>×</button></div>
    <form id="itemForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" value="${escapeAttr(i.title)}" required /></div>
      <div class="field"><label>Стоимость</label><input type="number" id="costInput" name="cost" value="${i.currency && i.currency !== "UAH" ? (i.costOriginal ?? i.cost) : i.cost}" min="0" step="any" required /></div>
      <div class="field"><label>Валюта</label><select name="currency" id="currencySelect">
        <option value="UAH" ${(i.currency || "UAH") === "UAH" ? "selected" : ""}>UAH ₴</option>
        <option value="USD" ${i.currency === "USD" ? "selected" : ""}>USD $</option>
        <option value="EUR" ${i.currency === "EUR" ? "selected" : ""}>EUR €</option>
      </select><span class="hint" id="currencyHint"></span></div>
      <div class="field"><label>Размер покупки (авто по сумме)</label><input id="bandDisplay" value="" disabled style="opacity:.8" /></div>
      <div class="field"><label>Ссылка на товар (опц.)</label><input name="url" type="url" placeholder="https://..." value="${escapeAttr(i.url || "")}" />
        ${i.linkPrice && moduleEnabled("pricecheck") ? `<span class="hint">Цена по ссылке: ${fmtShort(i.linkPrice)} (${fmtDate(i.linkPriceAt)})</span>` : ""}
        <span class="hint" id="priceTrendHint"></span></div>
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
      <div class="field full"><label class="switch-row"><input type="checkbox" name="canDefer" ${i.canDefer ? "checked" : ""} class="check-18"> Можно отложить на следующую зарплату</label></div>
      <div class="field full"><label class="switch-row"><input type="checkbox" name="recurring" ${i.recurring ? "checked" : ""} class="check-18"> 🔁 Регулярное (после покупки вернётся в очередь)</label></div>
      <div class="field full"><label>Заметки</label><textarea name="notes">${escapeHtml(i.notes || "")}</textarea></div>

      <div class="subhead">Оценка покупки</div>
      <div class="field full"><label>Тип оценки</label><select name="scoreType" id="scoreType">
        <option value="none" ${i.scoreType === "none" ? "selected" : ""}>Без оценки</option>
        <option value="quick" ${i.scoreType === "quick" ? "selected" : ""}>Quick — 5 критериев (для Medium)</option>
        <option value="full" ${i.scoreType === "full" ? "selected" : ""}>Full — 13 критериев (для Large / Major)</option>
      </select><span class="hint" id="scoreHint"></span></div>
      <div class="field full hidden" id="verdictBanner"></div>
      <div class="field full hidden" id="quickWrap"><div class="score-grid">${quickRows}</div></div>
      <div class="field full hidden" id="fullWrap"><div class="subhead mt-0">Дополнительно (Full)</div><div class="score-grid">${fullRows}</div></div>

      ${item ? `<div class="field full" style="display:flex;gap:10px;flex-wrap:wrap">
        ${item.url && moduleEnabled("pricecheck") ? `<button type="button" class="btn btn-outline btn-sm" id="checkPriceBtn">Проверить цену по ссылке</button>` : ""}
        ${state.meta?.ai?.enabled ? `<button type="button" class="btn btn-outline btn-sm" id="talkMeOutBtn">😈 Отговори меня</button>` : ""}
      </div><div class="field full hidden" id="talkMeOutBox"></div>` : ""}
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
  function itemCostUah() {
    const cur = $("#currencySelect")?.value || "UAH";
    const raw = +costInput.value || 0;
    if (cur === "USD") return raw * (state.currencyRate || 43.5);
    if (cur === "EUR") return raw * (state.eurRate || 47);
    return raw;
  }
  function refreshCurrencyHint() {
    const cur = $("#currencySelect")?.value || "UAH";
    const hint = $("#currencyHint");
    if (hint)
      hint.textContent =
        cur === "UAH" ? "" : `≈ ${fmtShort(itemCostUah())} грн по текущему курсу`;
  }
  function refreshBand() {
    refreshCurrencyHint();
    const band = clientBand(itemCostUah());
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
        ? "var(--color-positive)"
        : v.verdict === "drop"
          ? "var(--color-risk)"
          : "var(--color-warning)";
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
  $("#currencySelect")?.addEventListener("change", refreshBand);

// Тренд цены по ссылке: история проверок из /api/items/:id/price-history.
async function renderPriceTrend(itemId) {
  const el = $("#priceTrendHint");
  if (!el || !moduleEnabled("pricecheck")) return;
  try {
    const h = await api.get(`/api/items/${itemId}/price-history`);
    if (!h.trend || h.checks.length < 2) {
      el.textContent = h.checks.length === 1 ? "Проверок цены: 1 — тренд появится после следующей" : "";
      return;
    }
    const dPrev = h.trend.changeFromPrevious;
    const dFirst = h.trend.changeFromFirst;
    const arrow = dPrev > 0 ? "📈" : dPrev < 0 ? "📉" : "➡️";
    const sign = (v) => (v > 0 ? "+" : "") + fmtShort(v);
    const parts = [`${arrow} ${sign(dPrev)} с прошлой проверки`];
    if (dFirst !== null && Math.abs(dFirst - dPrev) > 0.005)
      parts.push(`${sign(dFirst)} с первой`);
    parts.push(`проверок: ${h.checks.length}`);
    el.textContent = parts.join(" · ");
    el.style.color = dPrev < 0 ? "var(--ok, #16a34a)" : dPrev > 0 ? "var(--danger, #dc2626)" : "";
  } catch {
    el.textContent = "";
  }
}

  $("#checkPriceBtn")?.addEventListener("click", async () => {
    const btn = $("#checkPriceBtn");
    btn.disabled = true;
    btn.textContent = "Проверяю…";
    try {
      const r = await api.post(`/api/items/${item.id}/check-price`, {});
      toast(
        r.found
          ? `Цена по ссылке: ${fmtShort(r.price)}${r.currency ? " " + r.currency : ""}`
          : "Не удалось распознать цену на странице",
      );
    } catch (ex) {
      toast("Ошибка: " + ex.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Проверить цену по ссылке";
    }
    renderPriceTrend(item.id);
  });
  if (item?.url) renderPriceTrend(item.id);
  $("#talkMeOutBtn")?.addEventListener("click", async () => {
    const box = $("#talkMeOutBox");
    box.classList.remove("hidden");
    box.innerHTML = '<p class="muted small">Ассистент готовит контраргументы…</p>';
    try {
      const out = await api.post("/api/ai/talk-me-out", { itemId: item.id });
      box.innerHTML = `<div class="msg bot">${md(out.reply || "")}</div>`;
    } catch (ex) {
      box.innerHTML = `<p class="muted small">Не получилось: ${escapeHtml(ex.message)}</p>`;
    }
  });
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
  // Один делегированный обработчик на все сегмент-шкалы формы (аудит 9.4).
  $("#itemForm").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    const scale = btn.closest(".seg-scale");
    const input = scale.querySelector("input[type=hidden]");
    input.value = btn.dataset.val;
    scale.querySelectorAll(".seg-btn").forEach((b) => {
      const on = b === btn;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    if (input.classList.contains("score-input")) refreshVerdict();
  });
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
      recurring: f.get("recurring") === "on",
      currency: f.get("currency") || "UAH",
      url: f.get("url") || null,
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
      closeModal();
      await deleteItem(item.id);
    });
}

// ---------- util ----------

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
// Версия статики приходит из query-параметра, который сервер подставил в index.html.
const STATIC_VERSION =
  new URL(import.meta.url).searchParams.get("v") || "dev";
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(`/sw.js?v=${STATIC_VERSION}`).then((registration) => {
    registration.update?.();
  }).catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!sessionStorage.getItem(`cq-sw-refreshed-${STATIC_VERSION}`)) {
      sessionStorage.setItem(`cq-sw-refreshed-${STATIC_VERSION}`, "1");
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
  // Запоминаем свою версию сразу — поллинг не примет её за чужую (аудит 14.2).
  setTimeout(() => {
    api
      .get("/api/version")
      .then((v) => {
        lastKnownVersion = v.version;
      })
      .catch(() => {});
  }, 250);
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
  if (state.demo || document.hidden || !appIsActive()) return;
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
  // Версии сравниваются напрямую: своя версия запоминается сразу после
  // мутации (notifyDataChanged), сюда доходят только чужие изменения (аудит 14.2).
  await syncFromRemote();
}

if (SYNC_CHANNEL)
  SYNC_CHANNEL.onmessage = (e) => {
    if (e?.data?.t === "changed") syncFromRemote();
    // Оптимистичные удаления видны во всех вкладках (аудит 14.3):
    // вкладка-инициатор владеет таймером, остальные только фильтруют рендер.
    if (e?.data?.t === "pending-delete") {
      pendingDeletes.set(e.data.id, { timer: null, remote: true });
      state.items = state.items.filter((i) => i.id !== e.data.id);
      if (syncIsSafe()) renderView();
    }
    if (e?.data?.t === "pending-restore" || e?.data?.t === "pending-commit") {
      const pending = pendingDeletes.get(e.data.id);
      if (pending?.remote) {
        pendingDeletes.delete(e.data.id);
        syncFromRemote();
      }
    }
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

// Адаптивный поллинг: активная вкладка опрашивается раз в 5с,
// после 5 минут без взаимодействия — раз в 60с (экономия батареи/трафика).
let lastInteraction = Date.now();
for (const ev of ["click", "keydown", "touchstart", "scroll"]) {
  document.addEventListener(ev, () => { lastInteraction = Date.now(); }, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) lastInteraction = Date.now();
});
// SSE: версия пушится сервером по одному keep-alive соединению (аудит 17.2);
// поллинг ниже остаётся фолбэком и сильно замедляется, пока SSE живо.
let sseAlive = false;
function connectEvents() {
  if (!("EventSource" in window)) return;
  const es = new EventSource("/api/events");
  es.addEventListener("version", (e) => {
    sseAlive = true;
    const version = Number(e.data);
    if (!Number.isFinite(version)) return;
    if (lastKnownVersion === null) {
      lastKnownVersion = version;
      return;
    }
    if (version === lastKnownVersion) return;
    lastKnownVersion = version;
    syncFromRemote();
  });
  es.onerror = () => {
    sseAlive = false;
    es.close();
    setTimeout(connectEvents, 15000);
  };
}
connectEvents();
(function pollLoop() {
  const idleMs = Date.now() - lastInteraction;
  let interval = idleMs > 5 * 60 * 1000 ? 60000 : 5000;
  if (sseAlive) interval = 120000;
  setTimeout(async () => {
    try {
      await pollVersion();
    } catch {}
    pollLoop();
  }, interval);
})();

bootstrap().catch((e) => console.error(e));

// ---------- параллакс фона от мыши (desktop, без reduced-motion) ----------
(() => {
  const fine = window.matchMedia("(pointer: fine)");
  const noMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!fine.matches || noMotion.matches) return;
  const root = document.documentElement;
  let raf = 0;
  window.addEventListener("mousemove", (e) => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      root.style.setProperty("--par-x", (e.clientX / window.innerWidth - 0.5).toFixed(4));
      root.style.setProperty("--par-y", (e.clientY / window.innerHeight - 0.5).toFixed(4));
    });
  }, { passive: true });
})();
