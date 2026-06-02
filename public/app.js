// Salary Allocation Planner — фронтенд (vanilla JS).

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const api = {
  async req(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) { showAuthGate(); throw new Error('unauthorized'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    if (method !== 'GET') notifyDataChanged();
    return data;
  },
  get: (u) => api.req('GET', u),
  post: (u, b) => api.req('POST', u, b),
  put: (u, b) => api.req('PUT', u, b),
  del: (u) => api.req('DELETE', u),
};

// ---------- state ----------
const state = {
  meta: null,
  plan: null,
  items: [],
  allocation: null,
  history: [],
  investments: [],
  portfolio: null,
  wallets: [],
  manualPlan: [],
  goals: [],
  view: 'dashboard',
  queueFilters: { q: '', layer: 'all', type: 'all', band: 'all', status: 'all' },
  queueSort: { key: 'priority', dir: 'desc' },
  invTab: 'overview',
};

// ---------- helpers ----------
const fmt = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU') + ' грн';
const fmtShort = (n) => (Math.round(Number(n) || 0)).toLocaleString('ru-RU');
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2400);
}
function layerLabel(key) { const l = state.meta?.layers?.[key]; return l ? `${l.ru}` : key; }
function layerColor(key) { return state.meta?.layers?.[key]?.color || '#64748b'; }
// Совместимость со старыми вызовами.
const bucketLabel = layerLabel;
const bucketColor = layerColor;
function catObj(id) { return state.meta?.categories?.find((c) => c.id === id); }
function catLabel(id) { const c = catObj(id); return c ? `${c.ru} · ${c.label}` : id; }
function catLabelShort(id) { const c = catObj(id); return c ? c.ru : id; }
function bandLabel(id) { const b = state.meta?.bands?.find((x) => x.id === id); return b ? b.label : id; }
const TYPE_LABELS = { must: 'Must', should: 'Should', nice: 'Nice' };
const STATUS_LABELS = { safe: 'Безопасно', tight: 'Впритык', overallocated: 'Перерасход' };
const VERDICT_LABELS = { keep: 'Брать', reconsider: 'Подумать', drop: 'Отказаться' };
const queueStatusLabel = { all: 'Все', funded: 'Копится', complete: 'Накоплено', planned: 'В плане' };

// ---------- charts (vanilla canvas, без библиотек) ----------
function cssVar(name, fallback = '#888') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.clientHeight || 200;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function drawDonut(canvas, segments) {
  const { ctx, w, h } = setupCanvas(canvas);
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return;
  const cx = w / 2, cy = h / 2;
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
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath(); ctx.arc(cx, cy, inner, 0, Math.PI * 2); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  // подпись в центре
  ctx.fillStyle = cssVar('--text', '#111');
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '700 18px Inter, sans-serif';
  ctx.fillText(fmtShort(total), cx, cy - 4);
  ctx.fillStyle = cssVar('--muted', '#888');
  ctx.font = '500 11px Inter, sans-serif';
  ctx.fillText('грн распределено', cx, cy + 13);
}
function drawLine(canvas, points) {
  const { ctx, w, h } = setupCanvas(canvas);
  if (points.length < 2) return;
  const padL = 8, padR = 8, padT = 14, padB = 22;
  const vals = points.map((p) => p.value);
  const maxV = Math.max(...vals, 0);
  const minV = Math.min(...vals, 0);
  const span = (maxV - minV) || 1;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const x = (i) => padL + (innerW * i) / (points.length - 1);
  const y = (v) => padT + innerH - ((v - minV) / span) * innerH;
  const accent = cssVar('--accent', '#2f6bff');
  // нулевая линия
  if (minV < 0) {
    ctx.strokeStyle = cssVar('--border', '#ddd');
    ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();
    ctx.setLineDash([]);
  }
  // заливка под линией
  const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
  grad.addColorStop(0, accent + '55');
  grad.addColorStop(1, accent + '00');
  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0].value));
  points.forEach((p, i) => ctx.lineTo(x(i), y(p.value)));
  ctx.lineTo(x(points.length - 1), padT + innerH);
  ctx.lineTo(x(0), padT + innerH);
  ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
  // линия
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
  ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
  // точки
  points.forEach((p, i) => {
    ctx.beginPath(); ctx.arc(x(i), y(p.value), 3.2, 0, Math.PI * 2);
    ctx.fillStyle = p.value < 0 ? cssVar('--red', '#e44') : accent;
    ctx.fill();
    ctx.strokeStyle = cssVar('--panel', '#fff'); ctx.lineWidth = 1.5; ctx.stroke();
  });
}
function drawBars(canvas, segments) {
  const { ctx, w, h } = setupCanvas(canvas);
  const maxV = Math.max(...segments.map((s) => s.value), 1);
  const pad = 18;
  const gap = 10;
  const barW = (w - pad * 2 - gap * (segments.length - 1)) / Math.max(segments.length, 1);
  segments.forEach((seg, i) => {
    const x = pad + i * (barW + gap);
    const bh = ((h - 44) * seg.value) / maxV;
    const y = h - 26 - bh;
    ctx.fillStyle = seg.color || cssVar('--accent', '#2f6bff');
    ctx.fillRect(x, y, Math.max(8, barW), bh);
    ctx.fillStyle = cssVar('--muted', '#888');
    ctx.textAlign = 'center';
    ctx.font = '600 10px Inter, sans-serif';
    ctx.fillText(seg.label, x + barW / 2, h - 8);
  });
}
function drawCharts() {
  const donut = $('#donutAlloc');
  if (donut && state.allocation) {
    const t = state.allocation.totals;
    const segs = [
      { value: t.survival, color: '#64708f' },
      { value: t.reserve, color: cssVar('--accent', '#2f6bff') },
      { value: t.fixedInvestment, color: cssVar('--green', '#16a34a') },
    ];
    Object.entries(committedBuckets()).filter(([, v]) => v > 0)
      .forEach(([k, v]) => segs.push({ value: v, color: layerColor(k) }));
    const rem = remainingSurplus();
    if (rem > 0) segs.push({ value: rem, color: cssVar('--border', '#ccd') });
    drawDonut(donut, segs);
  }
  const inv = $('#investBars');
  if (inv) {
    const assets = state.portfolio?.assets || [];
    if (assets.length) {
      drawBars(inv, assets.map((a) => ({ label: a.name.slice(0, 8), value: a.currentValue, color: cssVar('--green', '#16a34a') })));
    }
  }
}

// Клиентская копия логики вердикта (для живого отображения в модалке/таблице).
function clientVerdict(scoreType, scores) {
  if (!scoreType || scoreType === 'none' || !scores) return null;
  const crit = scoreType === 'full'
    ? [...(state.meta.scoreCriteria.quick), ...(state.meta.scoreCriteria.full)]
    : state.meta.scoreCriteria.quick;
  let sum = 0; let count = 0;
  for (const c of crit) {
    const v = Number(scores[c.id]);
    if (!v) continue;
    sum += c.dir === 'neg' ? (6 - v) : v;
    count += 1;
  }
  if (count === 0) return null;
  const score = Math.round((sum / count / 5) * 100);
  let verdict = 'reconsider';
  if (score >= 68) verdict = 'keep'; else if (score < 45) verdict = 'drop';
  return { score, verdict };
}

function prioDots(p) {
  let s = '<span class="prio">';
  for (let i = 1; i <= 5; i++) s += `<i class="${i <= p ? 'on' : ''}"></i>`;
  return s + '</span>';
}
function goalProgress(item) {
  const cost = Number(item.cost) || 0;
  const goal = state.goals.find((g) => g.itemId === item.id);
  const saved = Math.min(cost, Math.max(0, Number(goal?.savedAmount ?? item.savedAmount) || 0));
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
function hasManualPlan() { return manualPlanTotal() > 0; }
function committedTotal() {
  return hasManualPlan() ? manualPlanTotal() : (state.allocation?.totals?.allocated || 0);
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
    const layer = (it && (it.layer || it.bucket)) || 'quality';
    b[layer] = (b[layer] || 0) + amt;
  }
  return b;
}
function sortValue(item, key) {
  const layer = item.layer || item.bucket;
  const map = {
    title: item.title || '',
    cost: Number(item.cost) || 0,
    layer: layerLabel(layer),
    category: catLabelShort(item.category),
    band: item.band || '',
    type: item.type || '',
    priority: Number(item.priority) || 0,
    deadline: item.deadline || '9999-12-31',
  };
  return map[key] ?? '';
}
function sortedItems(items) {
  const { key, dir } = state.queueSort;
  const mul = dir === 'asc' ? 1 : -1;
  return [...items].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * mul;
    return String(av).localeCompare(String(bv), 'ru') * mul;
  });
}

// ---------- theme ----------
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'light';
}
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('cq-theme', t); } catch {}
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0a1020' : '#ffffff');
  const icon = t === 'dark' ? '☀' : '☾';
  const a = $('#themeBtn'); if (a) a.textContent = icon;
  const b = $('#themeBtnAuth'); if (b) b.textContent = icon;
  if (typeof drawCharts === 'function') requestAnimationFrame(drawCharts);
}
function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
$('#themeBtn')?.addEventListener('click', toggleTheme);
$('#themeBtnAuth')?.addEventListener('click', toggleTheme);
applyTheme(currentTheme());

// ============================================================
// AUTH
// ============================================================
async function bootstrap() {
  const st = await api.get('/api/auth/status');
  if (st.authed) { await loadAndRender(); }
  else { showAuthGate(st.pinSet); }
}

function showAuthGate(pinSet = true) {
  $('#app').classList.add('hidden');
  const gate = $('#authGate');
  gate.classList.remove('hidden');
  const isSetup = pinSet === false;
  $('#authTitle').textContent = isSetup ? 'Создайте PIN' : 'Вход';
  $('#authHint').textContent = isSetup
    ? 'Это персональное приложение. Придумайте PIN (минимум 4 цифры).'
    : 'Введите PIN, чтобы открыть свой план.';
  $('#pinConfirm').classList.toggle('hidden', !isSetup);
  $('#authSubmit').textContent = isSetup ? 'Создать' : 'Войти';
  $('#authForm').dataset.mode = isSetup ? 'setup' : 'login';
  $('#pinInput').value = ''; $('#pinConfirm').value = ''; $('#authError').textContent = '';
  $('#pinInput').focus();
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const mode = e.currentTarget.dataset.mode;
  const pin = $('#pinInput').value.trim();
  const err = $('#authError');
  err.textContent = '';
  try {
    if (mode === 'setup') {
      if (pin.length < 4) return (err.textContent = 'PIN слишком короткий.');
      if (pin !== $('#pinConfirm').value.trim()) return (err.textContent = 'PIN не совпадает.');
      await api.post('/api/auth/setup', { pin });
    } else {
      await api.post('/api/auth/login', { pin });
    }
    $('#authGate').classList.add('hidden');
    await loadAndRender();
  } catch (ex) {
    err.textContent = ex.message === 'bad_pin' ? 'Неверный PIN.' : 'Ошибка: ' + ex.message;
  }
});

$('#logoutBtn')?.addEventListener('click', doLogout);
$('#logoutBtnMobile')?.addEventListener('click', doLogout);

// ============================================================
// LOAD + RENDER
// ============================================================
async function loadAndRender() {
  const data = await api.get(`/api/state?scenario=balanced`);
  state.meta = data.meta;
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.history = data.history;
  state.investments = data.investments || [];
  state.portfolio = data.portfolio || null;
  state.wallets = data.wallets || [];
  state.manualPlan = data.manualPlan || [];
  state.goals = data.goals || [];
  $('#app').classList.remove('hidden');
  renderTopbar();
  renderView();
}

async function refresh() {
  const data = await api.get(`/api/state?scenario=balanced`);
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.history = data.history;
  state.investments = data.investments || [];
  state.portfolio = data.portfolio || null;
  state.wallets = data.wallets || [];
  state.manualPlan = data.manualPlan || [];
  state.goals = data.goals || [];
  renderTopbar();
  renderView();
}

function renderTopbar() {
  $('#topPlanName').textContent = state.plan ? state.plan.name : 'Зарплата не настроена';
  $('#topPayday').textContent = state.plan
    ? `Зарплата ${fmtDate(state.plan.payday)} · ${fmt(state.plan.salary)}`
    : 'Нажмите «Настроить зарплату»';
  const badge = $('#topStatus');
  if (state.allocation) {
    const s = state.allocation.totals.status;
    badge.className = 'status-badge status-' + s;
    badge.textContent = STATUS_LABELS[s] || s;
    badge.classList.remove('hidden');
  } else { badge.classList.add('hidden'); }
}

$$('.nav-item[data-view]').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  $$('.nav-item[data-view]').forEach((x) => x.classList.toggle('active', x.dataset.view === b.dataset.view));
  renderView();
}));

async function doLogout() {
  await api.post('/api/auth/logout');
  location.reload();
}

$('#editPlanBtn').addEventListener('click', openPlanModal);
$('#dataBtn').addEventListener('click', openDataModal);
$('#fabAdd')?.addEventListener('click', openQuickItemModal);

function renderView() {
  const root = $('#views');
  const v = state.view;
  if (v === 'dashboard') root.innerHTML = viewDashboard();
  else if (v === 'queue') root.innerHTML = viewQueue();
  else if (v === 'wallets') root.innerHTML = viewWallets();
  else if (v === 'investments') root.innerHTML = viewInvestments();
  else if (v === 'plan') root.innerHTML = viewPlan();
  else if (v === 'history') root.innerHTML = viewHistory();
  else if (v === 'assistant') { root.innerHTML = viewAssistant(); initAssistant(); }
  bindViewEvents();
  requestAnimationFrame(drawCharts);
}

let _resizeT;
window.addEventListener('resize', () => { clearTimeout(_resizeT); _resizeT = setTimeout(drawCharts, 150); });

// ============================================================
// VIEWS
// ============================================================
function noPlanBlock() {
  return `<div class="empty"><div class="big">◎</div>
    <p>Сначала настройте будущую зарплату.</p>
    <button class="btn btn-primary" data-act="open-plan">Настроить зарплату</button></div>`;
}

function viewDashboard() {
  if (!state.plan || !state.allocation) {
    return `<div class="view-head"><h1>Кабинет</h1><p>Обзор будущей зарплаты до её прихода.</p></div>${noPlanBlock()}`;
  }
  const t = state.allocation.totals;
  const stablePct = (value) => (t.salary ? (value / t.salary) * 100 : 0);
  const segs = Object.entries(committedBuckets())
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<div class="alloc-seg" style="width:${(v / t.salary) * 100}%;background:${bucketColor(k)}" title="${bucketLabel(k)}: ${fmt(v)}"></div>`)
    .join('');

  return `
  <div class="view-head"><h1>Кабинет</h1><p>Как разложить зарплату заранее — до того, как деньги пришли.</p></div>
  <div class="grid cards">
    <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value">${fmt(t.salary)}</div><div class="stat-sub">${fmtDate(state.plan.payday)}</div></div>
    <div class="card"><div class="stat-label">Обязательные расходы</div><div class="stat-value sm">${fmt(t.survival)}</div><div class="stat-sub">стабильный расходник</div></div>
    <div class="card"><div class="stat-label">Страховка</div><div class="stat-value sm accent-num">${fmt(t.reserve)}</div><div class="stat-sub">чёрный день, не трогаем</div></div>
    <div class="card"><div class="stat-label">Инвестиции</div><div class="stat-value sm green-num">${fmt(t.fixedInvestment)}</div><div class="stat-sub">стабильно отложить</div></div>
    <div class="card"><div class="stat-label">Излишки на желания</div><div class="stat-value accent-num">${fmt(t.availableToAllocate)}</div><div class="stat-sub">после стабильных пунктов</div></div>
    <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(committedTotal())}</div><div class="stat-sub">${hasManualPlan() ? 'ручной план распределения' : `${state.allocation.approved.length} покупок одобрено`}</div></div>
    <div class="card"><div class="stat-label">Останется из излишков</div><div class="stat-value ${remainingSurplus() < 0 ? 'red-num' : 'green-num'}">${fmt(remainingSurplus())}</div><div class="stat-sub">${hasManualPlan() ? 'по ручному плану' : 'по авто-распределению'}</div></div>
  </div>

  <div class="card pad-lg" style="margin-top:16px">
    <div class="row-between"><div class="stat-label">Распределение по слоям</div>
      <span class="status-badge status-${t.status}">${STATUS_LABELS[t.status]}</span></div>
    <div class="donut-wrap">
      <canvas id="donutAlloc" class="chart-donut"></canvas>
      <div class="legend legend-col">
        <span><span class="dot" style="background:#64708f"></span>Обязательные <b>${fmt(t.survival)}</b></span>
        <span><span class="dot" style="background:var(--accent)"></span>Страховка <b>${fmt(t.reserve)}</b></span>
        <span><span class="dot" style="background:var(--green)"></span>Инвестиции <b>${fmt(t.fixedInvestment)}</b></span>
        ${Object.entries(committedBuckets()).filter(([, v]) => v > 0).map(([k, v]) => `<span><span class="dot" style="background:${bucketColor(k)}"></span>${bucketLabel(k)} <b>${fmt(v)}</b></span>`).join('')}
        <span><span class="dot" style="background:var(--border)"></span>Останется <b>${fmt(remainingSurplus())}</b></span>
      </div>
    </div>
    <div class="alloc-bar" style="margin-top:16px">
      <div class="alloc-seg" style="width:${stablePct(t.survival)}%;background:#64708f" title="Обязательные"></div>
      <div class="alloc-seg" style="width:${stablePct(t.reserve)}%;background:var(--accent)" title="Страховка"></div>
      <div class="alloc-seg" style="width:${stablePct(t.fixedInvestment)}%;background:var(--green)" title="Инвестиции"></div>${segs}
    </div>
    ${t.status === 'overallocated' ? `<div class="tradeoff" style="background:color-mix(in srgb,var(--red) 10%,transparent);border-color:var(--red)"><b style="color:var(--red)">Перерасход.</b> Стабильные пункты и желания выше зарплаты — посмотрите «План распределения», что перенести.</div>` : ''}
  </div>
  `;
}

function verdictChip(item) {
  const v = clientVerdict(item.scoreType, item.scores);
  if (!v) return '';
  return ` <span class="verdict verdict-${v.verdict}" title="Оценка ${v.score}/100">${VERDICT_LABELS[v.verdict]} ${v.score}</span>`;
}

function queueItemRow(item, extra = '', reason = '') {
  const layer = item.layer || item.bucket;
  const gp = goalProgress(item);
  return `<div class="queue-item queue-swipe" data-id="${item.id}">
    <div class="qi-main">
      <div class="qi-title"><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(item.title)}
        <span class="tag tag-${item.type}">${TYPE_LABELS[item.type]}</span>${verdictChip(item)}</div>
      <div class="qi-meta">${layerLabel(layer)} · ${catLabelShort(item.category)} · ${bandLabel(item.band)} · приоритет ${item.priority}/5 · траектория ${item.trajectory}/5${item.deadline ? ' · дедлайн ' + fmtDate(item.deadline) : ''}</div>
      ${gp.saved > 0 ? `<div class="goal-mini"><div style="width:${gp.pct}%"></div></div><div class="qi-meta">Накоплено ${fmt(gp.saved)} из ${fmt(gp.cost)} · осталось ${fmt(gp.left)}</div>` : ''}
      ${reason ? `<div class="reason">↪ ${reason}</div>` : ''}
      ${extra ? `<div class="qi-meta">${extra}</div>` : ''}
    </div>
    <div class="qi-cost">${fmt(item.cost)}</div>
  </div>`;
}

function viewQueue() {
  const q = state.queueFilters;
  const filtered = state.items.filter((it) => {
    const gp = goalProgress(it);
    const inPlan = state.allocation?.approved.some((a) => a.item.id === it.id);
    const textOk = !q.q || `${it.title} ${it.notes || ''}`.toLowerCase().includes(q.q.toLowerCase());
    const layerOk = q.layer === 'all' || (it.layer || it.bucket) === q.layer;
    const typeOk = q.type === 'all' || it.type === q.type;
    const bandOk = q.band === 'all' || it.band === q.band;
    const statusOk = q.status === 'all'
      || (q.status === 'funded' && gp.saved > 0 && gp.pct < 100)
      || (q.status === 'complete' && gp.pct >= 100)
      || (q.status === 'planned' && inPlan);
    return textOk && layerOk && typeOk && bandOk && statusOk;
  });
  const sortMark = (key) => state.queueSort.key === key ? (state.queueSort.dir === 'asc' ? ' ↑' : ' ↓') : '';
  const th = (key, label) => `<th><button class="th-sort" data-sort="${key}">${label}${sortMark(key)}</button></th>`;
  const rows = sortedItems(filtered).map((it) => {
    const inPlan = state.allocation?.approved.some((a) => a.item.id === it.id);
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
      <td>${it.deadline ? fmtDate(it.deadline) : '—'}</td>
      <td>${inPlan ? '<span class="green-num">в плане</span>' : '<span class="muted">позже</span>'}</td>
      <td style="text-align:right">
        <button class="btn btn-sm btn-ghost" data-act="tradeoff" data-id="${it.id}">Trade-off</button>
        <button class="btn btn-sm btn-ghost" data-act="ai-explain" data-id="${it.id}">✦ почему</button>
        <button class="btn btn-sm btn-outline" data-act="save-goal" data-id="${it.id}">Копить</button>
        <button class="btn btn-sm btn-outline" data-act="edit" data-id="${it.id}">✎</button>
        <button class="btn btn-sm btn-ghost" data-act="bought" data-id="${it.id}" title="Отметить купленным">✓</button>
        <button class="btn btn-sm btn-danger" data-act="delete" data-id="${it.id}" title="Удалить">×</button>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="view-head row-between">
    <div><h1>Очередь желаний</h1><p>Единый список желаний — переносится из месяца в месяц. Купленное архивируется.</p></div>
    <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button>
  </div>
  <form class="quick-add card" id="quickAddForm">
    <input name="title" placeholder="Быстро добавить желание..." required />
    <input name="cost" type="number" min="0" placeholder="Сумма" required />
    <select name="type"><option value="should">Should</option><option value="must">Must</option><option value="nice">Nice</option></select>
    <button class="btn btn-primary" type="submit">Добавить</button>
  </form>
  <div class="filters card">
    <input data-filter="q" placeholder="Поиск по желаниям..." value="${escapeAttr(q.q)}" />
    <select data-filter="layer"><option value="all">Все слои</option>${Object.entries(state.meta.layers).map(([k, v]) => `<option value="${k}" ${q.layer === k ? 'selected' : ''}>${v.ru}</option>`).join('')}</select>
    <select data-filter="type"><option value="all">Все типы</option>${Object.entries(TYPE_LABELS).map(([k, v]) => `<option value="${k}" ${q.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select data-filter="band"><option value="all">Все размеры</option>${state.meta.bands.map((b) => `<option value="${b.id}" ${q.band === b.id ? 'selected' : ''}>${b.label}</option>`).join('')}</select>
    <select data-filter="status">${Object.entries(queueStatusLabel).map(([k, v]) => `<option value="${k}" ${q.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select id="mobileSort" class="mobile-sort"><option value="priority:desc">Сорт: приоритет ↓</option><option value="cost:desc">Стоимость ↓</option><option value="cost:asc">Стоимость ↑</option><option value="deadline:asc">Дедлайн ↑</option><option value="title:asc">Название ↑</option></select>
  </div>
  ${state.items.length && filtered.length ? `<div class="table-wrap queue-table"><table>
    <thead><tr>${th('title', 'Желание')}${th('cost', 'Стоимость')}<th>Накоплено</th>${th('layer', 'Слой')}${th('category', 'Категория')}${th('band', 'Band')}${th('type', 'Тип')}${th('priority', 'Приоритет')}${th('deadline', 'Дедлайн')}<th>Статус</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
    : `<div class="empty"><div class="big">≡</div><p>Очередь пуста. Добавьте первое желание.</p>
       <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button></div>`}
  ${state.items.length && !filtered.length ? '<div class="empty"><p>По фильтрам ничего не найдено.</p></div>' : ''}
  <div class="mobile-queue">${sortedItems(filtered).map((it) => queueItemRow(it, 'Свайп влево — куплено, вправо — удалить')).join('')}</div>
  <div id="tradeoffBox"></div>`;
}

function viewInvestments() {
  const p = state.portfolio;
  const tabs = [
    { key: 'overview', label: 'Обзор' },
    { key: 'assets', label: 'Активы' },
    { key: 'transactions', label: 'Операции' },
    { key: 'valuations', label: 'Оценки' },
  ];
  const tabBtns = tabs.map(t => `<button class="chip ${state.invTab === t.key ? 'active' : ''}" data-inv-tab="${t.key}">${t.label}</button>`).join('');

  let content = '';
  if (state.invTab === 'overview') content = investOverview(p);
  else if (state.invTab === 'assets') content = investAssets(p);
  else if (state.invTab === 'transactions') content = investTransactions(p);
  else if (state.invTab === 'valuations') content = investValuations(p);

  return `<div class="view-head row-between">
    <div><h1>Инвестиции</h1><p>Отслеживайте активы, покупки/продажи и рыночную стоимость.</p></div>
  </div>
  <div class="chip-row" style="margin-bottom:14px">${tabBtns}</div>
  <div id="investContent">${content}</div>`;
}
function investOverview(p) {
  if (!p || !p.assets.length) return '<div class="empty"><div class="big">↗</div><p>Добавьте первый актив, чтобы увидеть портфель.</p></div>';
  const total = p.totals;
  const allocations = p.assets.map(a => `<div class="prop-row"><div class="row-between small"><b>${escapeHtml(a.name)}</b><span>${total.totalValue ? Math.round((a.currentValue / total.totalValue) * 100) : 0}%</span></div><div class="goal-mini"><div style="width:${total.totalValue ? (a.currentValue / total.totalValue) * 100 : 0}%"></div></div><div class="muted small">${fmt(a.currentValue)} · ${a.type}</div></div>`).join('');
  return `
  <div class="grid cards">
    <div class="card"><div class="stat-label">Стоимость портфеля</div><div class="stat-value">${fmt(total.totalValue)}</div></div>
    <div class="card"><div class="stat-label">Вложено</div><div class="stat-value sm">${fmt(total.totalInvested)}</div></div>
    <div class="card"><div class="stat-label">Прибыль / Убыток</div><div class="stat-value sm ${total.totalPnL >= 0 ? 'green-num' : 'red-num'}">${fmt(total.totalPnL)}</div></div>
  </div>
  <div class="card pad-lg" style="margin-top:16px">
    <div class="row-between"><div class="stat-label">Распределение портфеля</div></div>
    <div style="margin-top:14px">${allocations}</div>
    <div class="chart-cols" style="margin-top:16px">
      <div><canvas id="investBars" class="chart-line"></canvas></div>
    </div>
  </div>`;
}
function investAssets(p) {
  const rows = p ? p.assets.map(a => `<div class="wallet-row">
    <div><b>${escapeHtml(a.name)}</b><div class="muted small">${a.type}${a.ticker ? ' · ' + a.ticker : ''}</div></div>
    <div style="min-width:200px">
      <div class="row-between small"><span>${fmt(a.currentValue)}</span><span class="${a.totalPnL >= 0 ? 'green-num' : 'red-num'}">${a.totalPnL >= 0 ? '+' : ''}${fmt(a.totalPnL)}</span></div>
      <div class="muted small">кол-во: ${a.quantityHeld} · вложено: ${fmt(a.totalInvested)}</div>
    </div>
  </div>`).join('') : '';
  return `<div class="card pad-lg"><div class="row-between"><div class="section-title" style="margin:0">Активы</div><button class="btn btn-primary btn-sm" data-act="add-asset">+ Актив</button></div>
    <div style="margin-top:14px">${rows || '<p class="muted">Нет активов.</p>'}</div></div>`;
}
function investTransactions(p) {
  const rows = p ? p.transactions.map(t => {
    const asset = p.assets.find(a => a.id === t.assetId);
    return `<div class="wallet-row">
      <div><b>${escapeHtml(asset?.name || t.assetId)}</b><div class="muted small">${fmtDate(t.date)} · ${t.type === 'buy' ? 'Покупка' : 'Продажа'}</div></div>
      <div style="min-width:180px">
        <div class="row-between small"><span>${t.quantity} × ${fmt(t.price)}</span><span>${fmt(t.totalAmount)}</span></div>
        <div class="muted small">комиссия: ${fmt(t.fee)}${t.note ? ' · ' + escapeHtml(t.note) : ''}</div>
      </div>
    </div>`;
  }).join('') : '';
  return `<div class="card pad-lg"><div class="row-between"><div class="section-title" style="margin:0">Операции покупки/продажи</div><button class="btn btn-primary btn-sm" data-act="add-tx">+ Операция</button></div>
    <div style="margin-top:14px">${rows || '<p class="muted">Нет операций.</p>'}</div></div>`;
}
function investValuations(p) {
  const rows = p ? p.valuations.map(v => {
    const asset = p.assets.find(a => a.id === v.assetId);
    return `<div class="wallet-row">
      <div><b>${escapeHtml(asset?.name || v.assetId)}</b><div class="muted small">${fmtDate(v.date)}${v.note ? ' · ' + escapeHtml(v.note) : ''}</div></div>
      <div class="stat-value sm">${fmt(v.value)}</div>
    </div>`;
  }).join('') : '';
  return `<div class="card pad-lg"><div class="row-between"><div class="section-title" style="margin:0">Ежемесячные оценки</div><button class="btn btn-primary btn-sm" data-act="add-valuation">+ Оценка</button></div>
    <div style="margin-top:14px">${rows || '<p class="muted">Добавьте оценку стоимости актива.</p>'}</div></div>`;
}

function viewWallets() {
  const total = walletTotal();
  const available = state.allocation?.totals?.availableToAllocate || 0;
  const rows = state.wallets.map((w) => `<div class="wallet-row">
    <div><b>${escapeHtml(w.name || 'Кошелёк')}</b><div class="muted small">${escapeHtml(w.purpose || 'на этот месяц')}</div></div>
    <div style="min-width:170px"><div class="row-between small"><span>${fmt(w.amount)}</span><b>${total ? Math.round((w.amount / total) * 100) : 0}%</b></div><div class="goal-mini"><div style="width:${total ? (w.amount / total) * 100 : 0}%"></div></div></div>
    <button class="btn btn-sm btn-danger" data-act="delete-wallet" data-id="${w.id}" title="Удалить">×</button>
  </div>`).join('');
  return `<div class="view-head row-between">
    <div><h1>Кошельки месяца</h1><p>Карманы с суммой и назначением именно на текущий месяц.</p></div>
    <button class="btn btn-primary" data-act="add-wallet">+ Кошелёк</button>
  </div>
  <div class="grid cards">
    <div class="card"><div class="stat-label">В кошельках</div><div class="stat-value">${fmt(total)}</div><div class="stat-sub">${state.wallets.length} карманов</div></div>
    <div class="card"><div class="stat-label">Излишки после стабильных пунктов</div><div class="stat-value sm">${fmt(available)}</div><div class="stat-sub">${total > available ? 'кошельки выше излишков' : 'в пределах излишков'}</div></div>
  </div>
  <div class="card pad-lg" style="margin-top:16px"><div class="section-title" style="margin-top:0">Карманы</div>${rows || '<p class="muted">Создайте карманы: еда, транспорт, инвестиции...</p>'}</div>`;
}

function viewPlan() {
  if (!state.allocation) return `<div class="view-head"><h1>План распределения</h1></div>${noPlanBlock()}`;
  const a = state.allocation;
  const available = a.totals.availableToAllocate;
  const planned = manualPlanTotal();
  const sortedItems = [...state.items].sort((a, b) => (Number(b.cost) || 0) - (Number(a.cost) || 0));
  const manualRows = sortedItems.map((it) => {
    const amount = manualAmountFor(it.id);
    const gp = goalProgress(it);
    return `<div class="manual-row">
      <div><b>${escapeHtml(it.title)}</b><div class="muted small">${fmt(it.cost)} · накоплено ${fmt(gp.saved)}</div></div>
      <input type="number" min="0" value="${amount || ''}" placeholder="0" data-manual="${it.id}" />
    </div>`;
  }).join('');
  return `
  <div class="view-head row-between">
    <div><h1>План распределения</h1><p>Распределяйте только излишки после обязательных расходов, страховки и инвестиций; авто-план остаётся подсказкой рядом.</p></div>
    <button class="btn btn-outline" data-act="close-month">Закрыть месяц</button>
  </div>
  <div class="card pad-lg" style="margin-bottom:16px">
    <div class="row-between"><div><div class="section-title" style="margin:0">Ручной план</div><p class="muted small" style="margin:4px 0 0">Введите, сколько отправить на каждое желание в этом месяце.</p></div>
      <div><div class="stat-value sm ${planned > available ? 'red-num' : 'green-num'}">${fmt(planned)}</div><div class="muted small">из ${fmt(available)}</div></div></div>
    <div class="manual-list">${manualRows || '<p class="muted">Добавьте желания, чтобы распределять вручную.</p>'}</div>
    <div class="row-between" style="margin-top:12px">
      <span class="${planned > available ? 'red-num' : 'muted'}">${planned > available ? 'План выше доступного бюджета' : `Свободно ещё ${fmt(available - planned)}`}</span>
      <button class="btn btn-primary" data-act="save-manual-plan">Сохранить ручной план</button>
    </div>
  </div>`;
}

function viewHistory() {
  if (!state.history.length) {
    return `<div class="view-head"><h1>История решений</h1><p>Закрытые месяцы появятся здесь.</p></div>
      <div class="empty"><div class="big">↺</div><p>Пока нет закрытых месяцев.<br>Когда зарплата потрачена по плану — нажмите «Закрыть месяц» на экране плана.</p></div>`;
  }
  return `<div class="view-head"><h1>История решений</h1><p>Что ты решал в прошлые месяцы: купленное, отложенное, остаток.</p></div>
    ${state.history.map((h) => {
      const s = h.snapshot || {};
      const t = s.totals || {};
      return `<div class="card pad-lg" style="margin-bottom:14px">
        <div class="row-between"><div><b>${escapeHtml(h.name)}</b> <span class="muted small">· зарплата ${fmtDate(h.payday)} · закрыт ${fmtDate(h.closedAt)}</span></div>
          <span class="status-badge status-${t.status || 'safe'}">${STATUS_LABELS[t.status] || ''}</span></div>
        <div class="grid cards" style="margin-top:12px">
          <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value sm">${fmt(t.salary || h.salary)}</div></div>
          <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(t.allocated)}</div></div>
          <div class="card"><div class="stat-label">Осталось</div><div class="stat-value sm green-num">${fmt(t.remaining)}</div></div>
        </div>
        <div style="margin-top:12px"><span class="muted small">Куплено:</span> ${(s.approved || []).map((x) => escapeHtml(x.title)).join(', ') || '—'}</div>
        <div style="margin-top:6px"><span class="muted small">Отложено:</span> ${(s.deferred || []).map((x) => escapeHtml(x.title)).join(', ') || '—'}</div>
      </div>`;
    }).join('')}`;
}

// ---------- assistant ----------
let chatHistory = [];
function viewAssistant() {
  const enabled = state.meta?.ai?.enabled;
  return `<div class="view-head"><h1>AI-ассистент</h1><p>Советует, что купить первым, что отложить и поясняет trade-off на основе твоего плана.</p></div>
  ${!enabled ? `<div class="tradeoff" style="background:rgba(245,177,61,.1);border-color:var(--amber)"><b style="color:var(--amber)">AI выключен.</b> Добавьте AI_PROVIDER и AI_API_KEY в окружение сервера, чтобы включить ассистента. Остальное приложение работает без него.</div>` : ''}
  <div class="chat">
    <div class="chip-row">
      <button class="chip" data-q="Что мне купить в первую очередь в этом месяце?">Что купить первым?</button>
      <button class="chip" data-q="Что лучше отложить на следующую зарплату и почему?">Что отложить?</button>
      <button class="chip" data-q="Мой план выглядит сбалансированным? Дай короткую оценку.">Оценка плана</button>
    </div>
    <div class="chat-log" id="chatLog"></div>
    <form class="chat-input" id="chatForm">
      <input id="chatInput" placeholder="Спросите про свой план..." ${enabled ? '' : 'disabled'} autocomplete="off" />
      <button class="btn btn-primary" type="submit" ${enabled ? '' : 'disabled'}>Спросить</button>
    </form>
  </div>`;
}
function initAssistant() {
  const log = $('#chatLog');
  log.innerHTML = chatHistory.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}">${escapeHtml(m.content)}</div>`).join('');
  log.scrollTop = log.scrollHeight;
  $$('.chip').forEach((c) => c.addEventListener('click', () => { $('#chatInput').value = c.dataset.q; $('#chatForm').requestSubmit(); }));
  $('#chatForm')?.addEventListener('submit', sendChat);
}
async function sendChat(e) {
  e.preventDefault();
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatHistory.push({ role: 'user', content: text });
  const log = $('#chatLog');
  log.innerHTML += `<div class="msg user">${escapeHtml(text)}</div><div class="msg bot" id="pending">…</div>`;
  log.scrollTop = log.scrollHeight;
  try {
    const res = await fetch('/api/ai/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: chatHistory }),
    });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const pending = $('#pending');
    let reply = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      reply += dec.decode(value, { stream: true });
      pending.textContent = reply;
      log.scrollTop = log.scrollHeight;
    }
    chatHistory.push({ role: 'assistant', content: reply });
    pending.removeAttribute('id');
  } catch (ex) {
    $('#pending').outerHTML = `<div class="msg bot">Ошибка ассистента: ${escapeHtml(ex.message)}</div>`;
  }
  $('#chatLog').scrollTop = $('#chatLog').scrollHeight;
}

// ============================================================
// EVENTS (delegated)
// ============================================================
function bindViewEvents() {
  $$('[data-act]').forEach((el) => {
    if (el._bound) return; el._bound = true;
    el.addEventListener('click', async () => {
      const act = el.dataset.act;
      const id = Number(el.dataset.id);
      if (act === 'open-plan') openPlanModal();
      else if (act === 'add-item') openItemModal();
      else if (act === 'save-goal') openSavingsModal(state.items.find((i) => i.id === id));
      else if (act === 'add-asset') openAssetModal();
      else if (act === 'add-tx') openTxModal();
      else if (act === 'add-valuation') openValuationModal();
      else if (act === 'add-wallet') openWalletModal();
      else if (act === 'save-manual-plan') saveManualPlan();
      else if (act === 'edit') openItemModal(state.items.find((i) => i.id === id));
      else if (act === 'bought') await markBought(id);
      else if (act === 'tradeoff') await showTradeoff(id);
      else if (act === 'close-month') closeMonth();
      else if (act === 'ai-explain') await explainItem(id);
      else if (act === 'delete') await deleteItem(id);
      else if (act === 'delete-wallet') await deleteWallet(el.dataset.id);
    });
  });
  $$('.queue-swipe').forEach((row) => bindSwipe(row));
  $('#quickAddForm')?.addEventListener('submit', quickAddItem);
  $$('.th-sort').forEach((btn) => btn.addEventListener('click', () => {
    const key = btn.dataset.sort;
    state.queueSort = { key, dir: state.queueSort.key === key && state.queueSort.dir === 'desc' ? 'asc' : 'desc' };
    renderView();
  }));
  $('#mobileSort')?.addEventListener('change', (e) => {
    const [key, dir] = e.target.value.split(':');
    state.queueSort = { key, dir };
    renderView();
  });
  $$('[data-filter]').forEach((el) => el.addEventListener('input', () => {
    state.queueFilters[el.dataset.filter] = el.value;
    renderView();
  }));
  $$('[data-inv-tab]').forEach((btn) => btn.addEventListener('click', () => {
    state.invTab = btn.dataset.invTab;
    renderView();
  }));
}

async function quickAddItem(e) {
  e.preventDefault();
  const f = new FormData(e.currentTarget);
  await api.post('/api/items', {
    title: f.get('title'),
    cost: +f.get('cost'),
    type: f.get('type'),
    category: 'lifestyle',
    priority: 3,
    emotional: 3,
    trajectory: 3,
    canDefer: true,
    scoreType: 'none',
  });
  toast('Желание добавлено');
  await refresh();
}

async function exportData() {
  const data = await api.get('/api/export');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `capital-queue-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importData(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  const data = JSON.parse(await file.text());
  await api.post('/api/import', data);
  closeModal();
  toast('Импортировано');
  await refresh();
}

async function markBought(id) {
  await api.post(`/api/items/${id}/status`, { status: 'bought' });
  toast('Отмечено как купленное');
  await refresh();
}

async function deleteItem(id) {
  if (!confirm('Удалить желание?')) return;
  await api.del(`/api/items/${id}`);
  toast('Удалено');
  await refresh();
}

function bindSwipe(row) {
  let startX = 0;
  row.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  row.addEventListener('touchend', async (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) < 80) return;
    if (dx < 0) await markBought(Number(row.dataset.id));
    else await deleteItem(Number(row.dataset.id));
  }, { passive: true });
}

async function showTradeoff(id) {
  const box = $('#tradeoffBox');
  const t = await api.get(`/api/tradeoff/${id}?scenario=balanced`);
  const item = state.items.find((i) => i.id === id);
  let html;
  if (t.approved) {
    html = `<b>${escapeHtml(item.title)}</b> уже в плане. Если отказаться — освободится <b>${fmt(t.freedIfRemoved)}</b>, останется <b>${fmt(t.remainingIfRemoved)}</b>.`;
  } else {
    html = `Если купить <b>${escapeHtml(item.title)}</b> (${fmt(item.cost)}) — останется <b>${fmt(t.remainingIfAdded)}</b>.`;
    if (t.belowReserve || t.belowBuffer) html += ` ⚠️ Резерв опустится ниже безопасного уровня.`;
    if (t.displaces?.length) html += `<br>Это вытеснит: ${t.displaces.map((d) => escapeHtml(d.title)).join(', ')}.`;
  }
  box.innerHTML = `<div class="tradeoff">${html}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function explainItem(id) {
  const box = $('#tradeoffBox');
  box.innerHTML = '<div class="tradeoff">AI думает…</div>';
  try {
    const out = await api.post('/api/ai/explain', { itemId: id, scenario: 'balanced' });
    box.innerHTML = `<div class="tradeoff"><b>Почему так:</b><br>${escapeHtml(out.reply)}</div>`;
  } catch (ex) {
    box.innerHTML = `<div class="tradeoff">AI недоступен: ${escapeHtml(ex.message)}</div>`;
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveManualPlan() {
  const manualPlan = $$('[data-manual]').map((el) => ({ itemId: Number(el.dataset.manual), amount: Number(el.value) || 0 }));
  await api.post('/api/manual-plan', { manualPlan });
  toast('Ручной план сохранён');
  await refresh();
}

async function closeMonth() {
  if (!confirm('Закрыть месяц? Одобренные покупки уйдут в архив (купленные), отложенные останутся в очереди на следующую зарплату.')) return;
  await api.post('/api/plan/close', { scenario: 'balanced' });
  toast('Месяц закрыт и сохранён в истории');
  await refresh();
}

async function deleteWallet(id) {
  if (!confirm('Удалить кошелёк?')) return;
  await api.del(`/api/wallets/${id}`);
  toast('Кошелёк удалён');
  await refresh();
}

// ============================================================
// MODALS
// ============================================================
function openModal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-overlay" id="ov">${html}</div>`;
  $('#ov').addEventListener('click', (e) => { if (e.target.id === 'ov') closeModal(); });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

function openQuickItemModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Быстро добавить желание</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="quickItemForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" required /></div>
      <div class="field"><label>Сумма</label><input name="cost" type="number" min="0" required /></div>
      <div class="field"><label>Тип</label><select name="type"><option value="should">Should</option><option value="must">Must</option><option value="nice">Nice</option></select></div>
      <div class="modal-foot field full" style="flex-direction:row"><button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button><button class="btn btn-primary">Добавить</button></div>
    </form></div>`);
  $('#quickItemForm').addEventListener('submit', quickAddItem);
}

function openDataModal() {
  const goalRows = state.items.map((it) => {
    const gp = goalProgress(it);
    return `<div class="wallet-row"><div><b>${escapeHtml(it.title)}</b><div class="muted small">${fmt(gp.saved)} / ${fmt(gp.cost)}${gp.monthsLeft ? ` · ~${gp.monthsLeft} мес.` : ''}</div></div>
      <button class="btn btn-sm btn-outline" data-act="save-goal" data-id="${it.id}">Цель</button></div>`;
  }).join('');
  openModal(`<div class="modal">
    <div class="modal-head"><h2>Данные и цели</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <div class="grid cards">
      <button class="btn btn-primary" id="exportBtn" type="button">Экспорт JSON</button>
      <label class="btn btn-outline" style="text-align:center">Импорт JSON<input id="importFile" type="file" accept="application/json" hidden></label>
    </div>
    <div class="section-title">Цели-накопления</div>
    <div>${goalRows || '<p class="muted">Пока нет желаний.</p>'}</div>
  </div>`);
  $('#exportBtn').addEventListener('click', exportData);
  $('#importFile').addEventListener('change', importData);
  bindViewEvents();
}

function openPlanModal() {
  const p = state.plan || { name: 'Зарплата', payday: new Date().toISOString().slice(0, 10), ...state.meta.defaults };
  const reservePct = p.salary ? Math.round((Number(p.buffer || 0) / Number(p.salary)) * 100) : 0;
  const investPct = p.salary ? Math.round((Number(p.investmentFixed || 0) / Number(p.salary)) * 100) : 0;
  openModal(`<div class="modal">
    <div class="modal-head"><h2>Стабильные пункты зарплаты</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
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
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#planForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/plan', {
      name: f.get('name'), payday: f.get('payday'),
      salary: +f.get('salary'), survivalCost: +f.get('survivalCost'), buffer: +f.get('buffer'), investmentFixed: +f.get('investmentFixed'),
    });
    closeModal(); toast('Зарплата сохранена'); await refresh();
  });
}

function openSavingsModal(item) {
  if (!item) return;
  const gp = goalProgress(item);
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Копить на желание</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="savingsForm" class="form-grid">
      <div class="field full"><label>Желание</label><input value="${escapeAttr(item.title)}" disabled /></div>
      <div class="field"><label>Цена</label><input value="${fmt(item.cost)}" disabled /></div>
      <div class="field"><label>Уже накоплено, грн</label><input type="number" name="savedAmount" min="0" value="${gp.saved}" /></div>
      <div class="field"><label>Откладывать в месяц, грн</label><input type="number" name="monthlyContribution" min="0" value="${gp.monthly || 0}" /></div>
      <div class="field full"><div class="goal-mini big"><div style="width:${gp.pct}%"></div></div><span class="muted small">${gp.pct}% · осталось ${fmt(gp.left)}</span></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#savingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post(`/api/items/${item.id}/savings`, { savedAmount: +f.get('savedAmount'), monthlyContribution: +f.get('monthlyContribution') });
    closeModal(); toast('Накопление обновлено'); await refresh();
  });
}

function openAssetModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Добавить актив</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="assetForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="name" placeholder="BTC, ETF, депозит..." required /></div>
      <div class="field"><label>Тип</label><select name="type"><option value="crypto">Крипто</option><option value="stock">Акция</option><option value="etf">ETF</option><option value="bond">Облигация</option><option value="deposit">Депозит</option><option value="other">Другое</option></select></div>
      <div class="field"><label>Тикер (опц.)</label><input name="ticker" placeholder="BTC, AAPL..." /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#assetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/investments/assets', { name: f.get('name'), type: f.get('type'), ticker: f.get('ticker') });
    closeModal(); toast('Актив добавлен'); await refresh();
  });
}

function openTxModal() {
  const assetOpts = (state.portfolio?.assets || []).map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Операция покупки/продажи</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="txForm" class="form-grid">
      <div class="field full"><label>Актив</label><select name="assetId" required>${assetOpts || '<option>Сначала добавьте актив</option>'}</select></div>
      <div class="field"><label>Тип</label><select name="type"><option value="buy">Покупка</option><option value="sell">Продажа</option></select></div>
      <div class="field"><label>Дата</label><input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Количество</label><input type="number" name="quantity" min="0" step="any" required /></div>
      <div class="field"><label>Цена за единицу</label><input type="number" name="price" min="0" step="any" required /></div>
      <div class="field"><label>Комиссия</label><input type="number" name="fee" min="0" step="any" value="0" /></div>
      <div class="field full"><label>Заметка</label><input name="note" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#txForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/investments/transactions', {
      assetId: f.get('assetId'), type: f.get('type'), date: f.get('date'),
      quantity: +f.get('quantity'), price: +f.get('price'), fee: +f.get('fee'), note: f.get('note'),
    });
    closeModal(); toast('Операция сохранена'); await refresh();
  });
}

function openValuationModal() {
  const assetOpts = (state.portfolio?.assets || []).map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('');
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Ежемесячная оценка</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="valForm" class="form-grid">
      <div class="field full"><label>Актив</label><select name="assetId" required>${assetOpts || '<option>Сначала добавьте актив</option>'}</select></div>
      <div class="field"><label>Дата</label><input type="date" name="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
      <div class="field"><label>Текущая стоимость</label><input type="number" name="value" min="0" required /></div>
      <div class="field full"><label>Заметка</label><input name="note" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#valForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    await api.post('/api/investments/valuations', {
      assetId: f.get('assetId'), date: f.get('date'), value: +f.get('value'), note: f.get('note'),
    });
    closeModal(); toast('Оценка сохранена'); await refresh();
  });
}

function openWalletModal() {
  openModal(`<div class="modal narrow">
    <div class="modal-head"><h2>Новый кошелёк месяца</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="walletForm" class="form-grid">
      <div class="field full"><label>Название кармана</label><input name="name" placeholder="На AirPods / еда / транспорт" required /></div>
      <div class="field"><label>Сумма, грн</label><input type="number" name="amount" min="0" required /></div>
      <div class="field"><label>На что пойдёт</label><input name="purpose" placeholder="цель на этот месяц" /></div>
      <div class="modal-foot field full" style="flex-direction:row">
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
        <button type="submit" class="btn btn-primary">Сохранить</button>
      </div>
    </form></div>`);
  $('#walletForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const wallets = [{ id: Date.now(), name: f.get('name'), purpose: f.get('purpose'), amount: +f.get('amount') }, ...state.wallets];
    await api.post('/api/wallets', { wallets });
    closeModal(); toast('Кошелёк добавлен'); await refresh();
  });
}

function clientBand(cost) {
  const c = Number(cost) || 0;
  for (const b of state.meta.bands) { if (b.max == null || c < b.max) return b.id; }
  return 'major';
}

function openItemModal(item) {
  const i = item || {
    title: '', cost: '', category: 'lifestyle', layer: '', priority: 3, type: 'should',
    deadline: '', earliestDate: '', canDefer: true, emotional: 3, trajectory: 3, notes: '',
    scoreType: 'none', scores: {},
  };
  const scores = i.scores || {};
  const catOpts = state.meta.categories
    .map((c) => `<option value="${c.id}" ${c.id === i.category ? 'selected' : ''}>${c.ru} · ${c.label}</option>`).join('');
  const layerOpts = Object.entries(state.meta.layers)
    .map(([k, v]) => `<option value="${k}" ${k === (i.layer || i.bucket) ? 'selected' : ''}>${v.ru} · ${v.label}</option>`).join('');
  const range = (name, val, label) => `<div class="field"><label>${label}</label><div class="range-row">
      <input type="range" name="${name}" min="1" max="5" value="${val}" oninput="this.nextElementSibling.textContent=this.value">
      <span class="range-val">${val}</span></div></div>`;
  const critRow = (c) => `<div class="score-row" data-crit="${c.id}">
      <div><div class="sr-label">${c.ru} ${c.dir === 'neg' ? '<span class="muted small">(чем меньше — тем лучше)</span>' : ''}</div><div class="sr-hint">${c.hint}</div></div>
      <div class="range-row"><input type="range" class="score-input" data-id="${c.id}" data-dir="${c.dir}" min="1" max="5" value="${scores[c.id] || 3}">
        <span class="range-val">${scores[c.id] || 3}</span></div>
    </div>`;
  const quickRows = state.meta.scoreCriteria.quick.map(critRow).join('');
  const fullRows = state.meta.scoreCriteria.full.map(critRow).join('');

  openModal(`<div class="modal">
    <div class="modal-head"><h2>${item ? 'Редактировать желание' : 'Новое желание'}</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="itemForm" class="form-grid">
      <div class="field full"><label>Название</label><input name="title" value="${escapeAttr(i.title)}" required /></div>
      <div class="field"><label>Стоимость, грн</label><input type="number" id="costInput" name="cost" value="${i.cost}" min="0" required /></div>
      <div class="field"><label>Band (авто по сумме)</label><input id="bandDisplay" value="" disabled style="opacity:.8" /></div>
      <div class="field"><label>Категория покупки</label><select name="category" id="catSelect">${catOpts}</select></div>
      <div class="field"><label>Слой капитала</label><select name="layer" id="layerSelect">${layerOpts}</select>
        <span class="hint">Подставляется из категории, можно изменить.</span></div>
      <div class="field"><label>Тип</label><select name="type">
        <option value="must" ${i.type === 'must' ? 'selected' : ''}>Must-have (обязательно)</option>
        <option value="should" ${i.type === 'should' ? 'selected' : ''}>Should-have (желательно)</option>
        <option value="nice" ${i.type === 'nice' ? 'selected' : ''}>Nice-to-have (по желанию)</option>
      </select></div>
      ${range('priority', i.priority, 'Приоритет 1–5')}
      <div class="field"><label>Дедлайн (если есть)</label><input type="date" name="deadline" value="${i.deadline || ''}" /></div>
      <div class="field"><label>Не раньше даты (если есть)</label><input type="date" name="earliestDate" value="${i.earliestDate || ''}" /></div>
      ${range('emotional', i.emotional, 'Эмоциональное желание 1–5')}
      ${range('trajectory', i.trajectory, 'Долгосрочная ценность 1–5')}
      <div class="field full"><label class="switch-row"><input type="checkbox" name="canDefer" ${i.canDefer ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)"> Можно отложить на следующую зарплату</label></div>
      <div class="field full"><label>Заметки</label><textarea name="notes">${escapeHtml(i.notes || '')}</textarea></div>

      <div class="subhead">Оценка покупки</div>
      <div class="field full"><label>Тип оценки</label><select name="scoreType" id="scoreType">
        <option value="none" ${i.scoreType === 'none' ? 'selected' : ''}>Без оценки</option>
        <option value="quick" ${i.scoreType === 'quick' ? 'selected' : ''}>Quick — 5 критериев (для Medium)</option>
        <option value="full" ${i.scoreType === 'full' ? 'selected' : ''}>Full — 13 критериев (для Large / Major)</option>
      </select><span class="hint" id="scoreHint"></span></div>
      <div class="field full hidden" id="verdictBanner"></div>
      <div class="field full hidden" id="quickWrap"><div class="score-grid">${quickRows}</div></div>
      <div class="field full hidden" id="fullWrap"><div class="subhead" style="margin-top:0">Дополнительно (Full)</div><div class="score-grid">${fullRows}</div></div>

      <div class="modal-foot field full" style="flex-direction:row;justify-content:space-between">
        <div>${item ? `<button type="button" class="btn btn-danger" id="delItem">Удалить</button>` : ''}</div>
        <div style="display:flex;gap:10px">
          <button type="button" class="btn btn-ghost" onclick="document.getElementById('modalRoot').innerHTML=''">Отмена</button>
          <button type="submit" class="btn btn-primary">Сохранить</button>
        </div>
      </div>
    </form></div>`);

  const costInput = $('#costInput');
  const bandDisplay = $('#bandDisplay');
  const catSelect = $('#catSelect');
  const layerSelect = $('#layerSelect');
  const scoreTypeSel = $('#scoreType');
  let layerTouched = !!(item && (item.layer || item.bucket)); // слой следует за категорией, пока его не трогали
  if (!layerTouched) { const c0 = catObj(catSelect.value); if (c0) layerSelect.value = c0.layer; }

  function collectScores() {
    const s = {};
    $$('.score-input').forEach((el) => { s[el.dataset.id] = +el.value; });
    return s;
  }
  function refreshBand() {
    const band = clientBand(costInput.value);
    bandDisplay.value = bandLabel(band);
    const rec = (band === 'large' || band === 'major') ? 'Full' : (band === 'medium' ? 'Quick' : '—');
    $('#scoreHint').textContent = rec === '—' ? 'Для мелких покупок оценка не нужна.' : `Рекомендуется: ${rec}.`;
  }
  function refreshVerdict() {
    const v = clientVerdict(scoreTypeSel.value, collectScores());
    const banner = $('#verdictBanner');
    if (!v) { banner.classList.add('hidden'); return; }
    banner.classList.remove('hidden');
    const col = v.verdict === 'keep' ? 'var(--green)' : v.verdict === 'drop' ? 'var(--red)' : 'var(--amber)';
    banner.innerHTML = `<div class="verdict-banner" style="background:color-mix(in srgb, ${col} 14%, transparent);color:${col}">
      <span>Вердикт: ${VERDICT_LABELS[v.verdict]}</span><span>${v.score}/100</span></div>`;
  }
  function refreshScoreSections() {
    const t = scoreTypeSel.value;
    $('#quickWrap').classList.toggle('hidden', t === 'none');
    $('#fullWrap').classList.toggle('hidden', t !== 'full');
    refreshVerdict();
  }

  costInput.addEventListener('input', refreshBand);
  catSelect.addEventListener('change', () => {
    if (!layerTouched) {
      const c = catObj(catSelect.value);
      if (c) layerSelect.value = c.layer;
    }
  });
  layerSelect.addEventListener('change', () => { layerTouched = true; });
  scoreTypeSel.addEventListener('change', refreshScoreSections);
  $$('.score-input').forEach((el) => el.addEventListener('input', (e) => {
    e.target.nextElementSibling.textContent = e.target.value; refreshVerdict();
  }));
  refreshBand();
  refreshScoreSections();

  $('#itemForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const scoreType = f.get('scoreType');
    const payload = {
      title: f.get('title'), cost: +f.get('cost'), category: f.get('category'), layer: f.get('layer'), type: f.get('type'),
      priority: +f.get('priority'), emotional: +f.get('emotional'), trajectory: +f.get('trajectory'),
      deadline: f.get('deadline') || null, earliestDate: f.get('earliestDate') || null,
      canDefer: f.get('canDefer') === 'on', notes: f.get('notes'),
      scoreType, scores: scoreType === 'none' ? null : collectScores(),
    };
    if (item) await api.put(`/api/items/${item.id}`, payload);
    else await api.post('/api/items', payload);
    closeModal(); toast('Сохранено'); await refresh();
  });
  if (item) $('#delItem')?.addEventListener('click', async () => {
    if (!confirm('Удалить желание навсегда?')) return;
    await api.del(`/api/items/${item.id}`); closeModal(); toast('Удалено'); await refresh();
  });
}

// ---------- util ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/"/g, '&quot;'); }

let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  $('#installBtn')?.classList.remove('hidden');
});
$('#installBtn')?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  $('#installBtn')?.classList.add('hidden');
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// ============================================================
// СИНХРОНИЗАЦИЯ ДАННЫХ МЕЖДУ ВКЛАДКАМИ И УСТРОЙСТВАМИ
// ------------------------------------------------------------
// Любое изменение в одной вкладке мгновенно подхватывается другими
// вкладками этого браузера (BroadcastChannel + событие storage),
// а вкладки на других устройствах догоняют опросом /api/version.
// Перерисовку откладываем, пока открыта модалка или пользователь
// печатает, чтобы не сбить ввод.
// ============================================================
const SYNC_CHANNEL = (() => { try { return new BroadcastChannel('cq-sync'); } catch { return null; } })();
let lastKnownVersion = null;
let lastLocalChange = 0;
let syncing = false;
let pendingSync = false;

function appIsActive() {
  const app = $('#app');
  return app && !app.classList.contains('hidden');
}

function syncIsSafe() {
  if ($('#modalRoot')?.firstChild) return false; // открыта модалка
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return false; // идёт ввод
  return true;
}

function notifyDataChanged() {
  lastLocalChange = Date.now();
  try { SYNC_CHANNEL?.postMessage({ t: 'changed', at: lastLocalChange }); } catch {}
  try { localStorage.setItem('cq-sync', String(lastLocalChange)); } catch {}
}

async function syncFromRemote() {
  if (syncing || !appIsActive()) return;
  if (!syncIsSafe()) { pendingSync = true; return; }
  pendingSync = false;
  syncing = true;
  try { await refresh(); } catch {} finally { syncing = false; }
}

async function pollVersion() {
  if (document.hidden || !appIsActive()) return;
  let version;
  try { ({ version } = await api.get('/api/version')); } catch { return; }
  if (lastKnownVersion === null) { lastKnownVersion = version; return; }
  if (version === lastKnownVersion) return;
  lastKnownVersion = version;
  // Своё же изменение уже отрисовано локально — не дёргаем повторно.
  if (Date.now() - lastLocalChange < 6000) return;
  await syncFromRemote();
}

if (SYNC_CHANNEL) SYNC_CHANNEL.onmessage = (e) => { if (e?.data?.t === 'changed') syncFromRemote(); };
window.addEventListener('storage', (e) => { if (e.key === 'cq-sync') syncFromRemote(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) pollVersion(); });
// Когда закрывается модалка / уходит фокус — досинхронизируем отложенное.
document.addEventListener('click', () => { if (pendingSync && syncIsSafe()) syncFromRemote(); });
setInterval(pollVersion, 5000);

bootstrap().catch((e) => console.error(e));
