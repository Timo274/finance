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
  scenarios: [],
  history: [],
  view: 'dashboard',
  scenario: 'balanced',
  customInclude: [],
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

// Клиентская копия логики вердикта (для живого отображения в модалке/таблице).
function clientVerdict(scoreType, scores) {
  if (!scoreType || scoreType === 'none' || !scores) return null;
  const crit = scoreType === 'full'
    ? [...(state.meta.scoreCriteria.quick), ...(state.meta.scoreCriteria.full)]
    : state.meta.scoreCriteria.quick;
  let pos = 0; let posMax = 0; let neg = 0; let negMax = 0;
  for (const c of crit) {
    const v = Number(scores[c.id]);
    if (!v) continue;
    if (c.dir === 'pos') { pos += v; posMax += 5; } else { neg += v; negMax += 5; }
  }
  if (posMax === 0 && negMax === 0) return null;
  const posPart = posMax ? pos / posMax : 0.5;
  const negPart = negMax ? neg / negMax : 0;
  const score = Math.round(Math.max(0, Math.min(1, posPart - negPart * 0.6)) * 100);
  let verdict = 'reconsider';
  if (score >= 62) verdict = 'keep'; else if (score < 38) verdict = 'drop';
  return { score, verdict };
}

function prioDots(p) {
  let s = '<span class="prio">';
  for (let i = 1; i <= 5; i++) s += `<i class="${i <= p ? 'on' : ''}"></i>`;
  return s + '</span>';
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
}
function toggleTheme() { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
$('#themeBtn')?.addEventListener('click', toggleTheme);
$('#themeBtnAuth')?.addEventListener('click', toggleTheme);
$('#logoutBtnTop')?.addEventListener('click', async () => { await api.post('/api/auth/logout'); location.reload(); });
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

$('#logoutBtn').addEventListener('click', async () => {
  await api.post('/api/auth/logout');
  location.reload();
});

// ============================================================
// LOAD + RENDER
// ============================================================
async function loadAndRender() {
  const data = await api.get(`/api/state?scenario=${state.scenario}`);
  state.meta = data.meta;
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.scenarios = data.scenarios;
  state.history = data.history;
  try { state.customInclude = (await api.get('/api/custom-scenario')).includeIds || []; } catch {}
  $('#app').classList.remove('hidden');
  renderTopbar();
  renderView();
}

async function refresh() {
  const data = await api.get(`/api/state?scenario=${state.scenario}`);
  state.plan = data.plan;
  state.items = data.items;
  state.allocation = data.allocation;
  state.scenarios = data.scenarios;
  state.history = data.history;
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

$$('.nav-item').forEach((b) => b.addEventListener('click', () => {
  state.view = b.dataset.view;
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x === b));
  renderView();
}));

$('#editPlanBtn').addEventListener('click', openPlanModal);

function renderView() {
  const root = $('#views');
  const v = state.view;
  if (v === 'dashboard') root.innerHTML = viewDashboard();
  else if (v === 'queue') root.innerHTML = viewQueue();
  else if (v === 'plan') root.innerHTML = viewPlan();
  else if (v === 'timeline') root.innerHTML = viewTimeline();
  else if (v === 'scenarios') root.innerHTML = viewScenarios();
  else if (v === 'history') root.innerHTML = viewHistory();
  else if (v === 'assistant') { root.innerHTML = viewAssistant(); initAssistant(); }
  bindViewEvents();
}

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
  const segs = Object.entries(state.allocation.buckets)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `<div class="alloc-seg" style="width:${(v / t.salary) * 100}%;background:${bucketColor(k)}" title="${bucketLabel(k)}: ${fmt(v)}"></div>`)
    .join('');
  const survW = (t.survival / t.salary) * 100;

  return `
  <div class="view-head"><h1>Кабинет</h1><p>Как разложить зарплату заранее — до того, как деньги пришли.</p></div>
  <div class="grid cards">
    <div class="card"><div class="stat-label">Зарплата</div><div class="stat-value">${fmt(t.salary)}</div><div class="stat-sub">${fmtDate(state.plan.payday)}</div></div>
    <div class="card"><div class="stat-label">Обязательные расходы</div><div class="stat-value sm">${fmt(t.survival)}</div><div class="stat-sub">списываются первыми</div></div>
    <div class="card"><div class="stat-label">Защищённый буфер</div><div class="stat-value sm accent-num">${fmt(t.buffer)}</div><div class="stat-sub">не трогаем</div></div>
    <div class="card"><div class="stat-label">Доступно распределить</div><div class="stat-value accent-num">${fmt(t.availableToAllocate)}</div></div>
    <div class="card"><div class="stat-label">Распределено</div><div class="stat-value sm">${fmt(t.allocated)}</div><div class="stat-sub">${state.allocation.approved.length} покупок одобрено</div></div>
    <div class="card"><div class="stat-label">Останется</div><div class="stat-value ${t.freeAfterBuffer < 0 ? 'red-num' : 'green-num'}">${fmt(t.remaining)}</div><div class="stat-sub">сверх буфера: ${fmt(t.freeAfterBuffer)}</div></div>
  </div>

  <div class="card pad-lg" style="margin-top:16px">
    <div class="row-between"><div class="stat-label">Распределение зарплаты</div>
      <span class="status-badge status-${t.status}">${STATUS_LABELS[t.status]}</span></div>
    <div class="alloc-bar" style="margin-top:14px">
      <div class="alloc-seg" style="width:${survW}%;background:#64708f"></div>${segs}
    </div>
    <div class="legend">
      <span><span class="dot" style="background:#64708f"></span>Обязательные ${fmt(t.survival)}</span>
      ${Object.entries(state.allocation.buckets).filter(([, v]) => v > 0).map(([k, v]) => `<span><span class="dot" style="background:${bucketColor(k)}"></span>${bucketLabel(k)} ${fmt(v)}</span>`).join('')}
      <span><span class="dot" style="background:#142244"></span>Останется ${fmt(t.remaining)}</span>
    </div>
    ${t.status === 'overallocated' ? `<div class="tradeoff" style="background:rgba(240,98,98,.1);border-color:var(--red)"><b style="color:#ff9b9b">Перерасход.</b> Часть покупок не помещается без нарушения буфера — посмотрите «План распределения», что перенести.</div>` : ''}
  </div>

  <div class="section-title">Одобрено в этой зарплате · ${state.allocation.approved.length}</div>
  ${state.allocation.approved.length ? state.allocation.approved.map((a) => queueItemRow(a.item, `Остаток после: ${fmt(a.balanceAfter)}`)).join('') : '<p class="muted">Пока ничего не одобрено — добавьте желания в очередь.</p>'}

  ${state.allocation.deferred.length ? `<div class="section-title">Перенести на потом · ${state.allocation.deferred.length}</div>
    ${state.allocation.deferred.map((d) => queueItemRow(d.item, '', d.reason)).join('')}` : ''}
  `;
}

function verdictChip(item) {
  const v = clientVerdict(item.scoreType, item.scores);
  if (!v) return '';
  return ` <span class="verdict verdict-${v.verdict}" title="Оценка ${v.score}/100">${VERDICT_LABELS[v.verdict]} ${v.score}</span>`;
}

function queueItemRow(item, extra = '', reason = '') {
  const layer = item.layer || item.bucket;
  return `<div class="queue-item">
    <div class="qi-main">
      <div class="qi-title"><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(item.title)}
        <span class="tag tag-${item.type}">${TYPE_LABELS[item.type]}</span>${verdictChip(item)}</div>
      <div class="qi-meta">${layerLabel(layer)} · ${catLabelShort(item.category)} · ${bandLabel(item.band)} · приоритет ${item.priority}/5 · траектория ${item.trajectory}/5${item.deadline ? ' · дедлайн ' + fmtDate(item.deadline) : ''}</div>
      ${reason ? `<div class="reason">↪ ${reason}</div>` : ''}
      ${extra ? `<div class="qi-meta">${extra}</div>` : ''}
    </div>
    <div class="qi-cost">${fmt(item.cost)}</div>
  </div>`;
}

function viewQueue() {
  const rows = state.items.map((it) => {
    const inPlan = state.allocation?.approved.some((a) => a.item.id === it.id);
    const layer = it.layer || it.bucket;
    return `<tr data-id="${it.id}">
      <td><span class="dot" style="background:${layerColor(layer)}"></span>${escapeHtml(it.title)}${verdictChip(it)}</td>
      <td>${fmt(it.cost)}</td>
      <td>${layerLabel(layer)}</td>
      <td>${catLabelShort(it.category)}</td>
      <td><span class="band">${bandLabel(it.band)}</span></td>
      <td><span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span></td>
      <td>${prioDots(it.priority)}</td>
      <td>${it.deadline ? fmtDate(it.deadline) : '—'}</td>
      <td>${inPlan ? '<span class="green-num">в плане</span>' : '<span class="muted">позже</span>'}</td>
      <td style="text-align:right">
        <button class="btn btn-sm btn-ghost" data-act="tradeoff" data-id="${it.id}">Trade-off</button>
        <button class="btn btn-sm btn-outline" data-act="edit" data-id="${it.id}">✎</button>
        <button class="btn btn-sm btn-ghost" data-act="bought" data-id="${it.id}" title="Отметить купленным">✓</button>
      </td>
    </tr>`;
  }).join('');

  return `
  <div class="view-head row-between">
    <div><h1>Очередь желаний</h1><p>Единый список желаний — переносится из месяца в месяц. Купленное архивируется.</p></div>
    <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button>
  </div>
  ${state.items.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Желание</th><th>Стоимость</th><th>Слой</th><th>Категория</th><th>Band</th><th>Тип</th><th>Приоритет</th><th>Дедлайн</th><th>Статус</th><th></th></tr></thead>
    <tbody>${rows}</tbody></table></div>`
    : `<div class="empty"><div class="big">≡</div><p>Очередь пуста. Добавьте первое желание.</p>
       <button class="btn btn-primary" data-act="add-item">+ Добавить желание</button></div>`}
  <div id="tradeoffBox"></div>`;
}

function viewPlan() {
  if (!state.allocation) return `<div class="view-head"><h1>План распределения</h1></div>${noPlanBlock()}`;
  const a = state.allocation;
  return `
  <div class="view-head row-between">
    <div><h1>План распределения</h1><p>Авто-распределение: сначала обязательное и дедлайны, потом приоритет и долгосрочная ценность.</p></div>
    <button class="btn btn-outline" data-act="close-month">Закрыть месяц</button>
  </div>
  <div class="plan-cols">
    <div>
      <div class="section-title green-num">Одобрено в этой зарплате · ${a.approved.length}</div>
      ${a.approved.length ? a.approved.map((x) => queueItemRow(x.item, `Остаток после покупки: ${fmt(x.balanceAfter)}`)).join('') : '<p class="muted">Ничего не одобрено.</p>'}
    </div>
    <div>
      <div class="section-title amber-num">Перенести на потом · ${a.deferred.length}</div>
      ${a.deferred.length ? a.deferred.map((x) => queueItemRow(x.item, '', x.reason)).join('') : '<p class="muted">Всё помещается — отложенного нет.</p>'}
    </div>
  </div>`;
}

function viewTimeline() {
  if (!state.allocation) return `<div class="view-head"><h1>Таймлайн</h1></div>${noPlanBlock()}`;
  const tl = state.allocation.timeline;
  return `
  <div class="view-head"><h1>Таймлайн покупок</h1><p>План по датам после зарплаты с остатком на счёте после каждой покупки.</p></div>
  <div class="card pad-lg">
    <div class="row-between"><div class="stat-label">Старт — зарплата ${fmtDate(state.plan.payday)}</div>
      <div class="stat-value sm">${fmt(state.allocation.totals.salary - state.allocation.totals.survival)} <span class="muted small">после обязательных</span></div></div>
    ${tl.length ? `<div class="timeline" style="margin-top:18px">
      ${tl.map((n) => `<div class="tl-node">
        <div class="tl-date">${fmtDate(n.date)}</div>
        <div class="tl-card"><div><b>${escapeHtml(n.item.title)}</b> <span class="muted small">${fmt(n.item.cost)}</span></div>
          <div class="tl-bal">остаток ${fmt(n.balanceAfter)}</div></div>
      </div>`).join('')}
      <div class="tl-node"><div class="tl-date">Итог</div>
        <div class="tl-card"><div><b>Защищённый буфер</b></div><div class="tl-bal accent-num">${fmt(state.allocation.totals.buffer)}</div></div></div>
    </div>` : '<p class="muted" style="margin-top:14px">Нет запланированных покупок.</p>'}
  </div>`;
}

function viewScenarios() {
  if (!state.scenarios.length) return `<div class="view-head"><h1>Сценарии</h1></div>${noPlanBlock()}`;
  const cards = state.scenarios.map((s) => {
    const total = s.allocated + s.remaining || 1;
    const bars = Object.entries(s.buckets).filter(([, v]) => v > 0)
      .map(([k, v]) => `<div style="width:${(v / total) * 100}%;background:${bucketColor(k)}"></div>`).join('');
    return `<div class="card scn-card ${s.key === state.scenario ? 'active' : ''}" data-act="pick-scenario" data-key="${s.key}">
      <div class="row-between"><div class="scn-name">${s.label}</div>
        <span class="status-badge status-${s.status}">${STATUS_LABELS[s.status]}</span></div>
      <div class="bucket-bar">${bars}<div style="flex:1;background:#142244"></div></div>
      <div class="legend small">
        <span class="muted">Карьера: ${fmtShort(s.career)}</span>
        <span class="muted">Жизнь: ${fmtShort(s.quality)}</span>
        <span class="muted">Буфер: ${fmtShort(s.buffer)}</span>
      </div>
      <div style="margin-top:10px;display:flex;justify-content:space-between">
        <span class="muted small">Включено ${s.includedCount} · позже ${s.excludedCount}</span>
        <b class="green-num">${fmt(s.remaining)}</b>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="view-head"><h1>Сценарии месяца</h1><p>Сравните стратегии распределения и выберите ту, что выглядит сбалансированной. Выбранный сценарий применяется ко всем экранам.</p></div>
  <div class="grid scn-grid">${cards}</div>
  ${state.scenario === 'custom' ? customScenarioEditor() : ''}`;
}

function customScenarioEditor() {
  const rows = state.items.map((it) => `<label class="queue-item" style="cursor:pointer">
    <div class="qi-main"><div class="qi-title">${escapeHtml(it.title)} <span class="tag tag-${it.type}">${TYPE_LABELS[it.type]}</span></div>
      <div class="qi-meta">${catLabel(it.category)} · ${fmt(it.cost)}</div></div>
    <input type="checkbox" data-cust="${it.id}" ${state.customInclude.includes(it.id) ? 'checked' : ''} style="width:18px;height:18px;accent-color:var(--accent)">
  </label>`).join('');
  return `<div class="section-title">Свой сценарий — выберите покупки вручную</div>${rows || '<p class="muted">Добавьте желания в очередь.</p>'}`;
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
    const out = await api.post('/api/ai/chat', { messages: chatHistory });
    chatHistory.push({ role: 'assistant', content: out.reply });
    $('#pending').outerHTML = `<div class="msg bot">${escapeHtml(out.reply)}</div>`;
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
      else if (act === 'edit') openItemModal(state.items.find((i) => i.id === id));
      else if (act === 'bought') await markBought(id);
      else if (act === 'tradeoff') await showTradeoff(id);
      else if (act === 'close-month') closeMonth();
      else if (act === 'pick-scenario') pickScenario(el.dataset.key);
    });
  });
  $$('[data-cust]').forEach((cb) => cb.addEventListener('change', saveCustomScenario));
}

async function markBought(id) {
  await api.post(`/api/items/${id}/status`, { status: 'bought' });
  toast('Отмечено как купленное');
  await refresh();
}

async function showTradeoff(id) {
  const box = $('#tradeoffBox');
  const t = await api.get(`/api/tradeoff/${id}?scenario=${state.scenario}`);
  const item = state.items.find((i) => i.id === id);
  let html;
  if (t.approved) {
    html = `<b>${escapeHtml(item.title)}</b> уже в плане. Если отказаться — освободится <b>${fmt(t.freedIfRemoved)}</b>, останется <b>${fmt(t.remainingIfRemoved)}</b>.`;
  } else {
    html = `Если купить <b>${escapeHtml(item.title)}</b> (${fmt(item.cost)}) — останется <b>${fmt(t.remainingIfAdded)}</b>.`;
    if (t.belowBuffer) html += ` ⚠️ Буфер опустится ниже безопасного уровня.`;
    if (t.displaces?.length) html += `<br>Это вытеснит: ${t.displaces.map((d) => escapeHtml(d.title)).join(', ')}.`;
  }
  box.innerHTML = `<div class="tradeoff">${html}</div>`;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function closeMonth() {
  if (!confirm('Закрыть месяц? Одобренные покупки уйдут в архив (купленные), отложенные останутся в очереди на следующую зарплату.')) return;
  await api.post('/api/plan/close', { scenario: state.scenario });
  toast('Месяц закрыт и сохранён в истории');
  await refresh();
}

async function pickScenario(key) {
  state.scenario = key;
  await refresh();
}

async function saveCustomScenario() {
  const ids = $$('[data-cust]').filter((c) => c.checked).map((c) => Number(c.dataset.cust));
  state.customInclude = ids;
  await api.post('/api/custom-scenario', { includeIds: ids });
  if (state.scenario === 'custom') await refresh();
}

// ============================================================
// MODALS
// ============================================================
function openModal(html) {
  $('#modalRoot').innerHTML = `<div class="modal-overlay" id="ov">${html}</div>`;
  $('#ov').addEventListener('click', (e) => { if (e.target.id === 'ov') closeModal(); });
}
function closeModal() { $('#modalRoot').innerHTML = ''; }

function openPlanModal() {
  const p = state.plan || { name: 'Зарплата', payday: new Date().toISOString().slice(0, 10), ...state.meta.defaults };
  openModal(`<div class="modal">
    <div class="modal-head"><h2>Будущая зарплата</h2><button class="close-x" onclick="document.getElementById('modalRoot').innerHTML=''">×</button></div>
    <form id="planForm" class="form-grid">
      <div class="field full"><label>Название (например, «Зарплата июнь»)</label><input name="name" value="${escapeAttr(p.name)}" /></div>
      <div class="field"><label>Дата зарплаты</label><input type="date" name="payday" value="${p.payday}" /></div>
      <div class="field"><label>Сумма зарплаты, грн</label><input type="number" name="salary" value="${p.salary}" min="0" /></div>
      <div class="field"><label>Обязательные расходы, грн</label><input type="number" name="survivalCost" value="${p.survivalCost}" min="0" />
        <span class="muted small">по умолчанию для жизни с родителями</span></div>
      <div class="field"><label>Защищённый буфер, грн</label><input type="number" name="buffer" value="${p.buffer}" min="0" />
        <span class="muted small">минимальный остаток, который нельзя трогать</span></div>
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
      salary: +f.get('salary'), survivalCost: +f.get('survivalCost'), buffer: +f.get('buffer'),
    });
    closeModal(); toast('Зарплата сохранена'); await refresh();
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
  let layerTouched = !!item; // у нового желания слой следует за категорией

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

bootstrap().catch((e) => console.error(e));
