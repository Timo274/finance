import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import db, {
  getJSON, setJSON, rowToItem, rowToPlan,
} from './src/db.js';
import {
  pinIsSet, setPin, verifyPin, issueToken, clearToken, isAuthed, requireAuth,
} from './src/auth.js';
import {
  CATEGORIES, LAYERS, TYPES, BANDS, SCORE_TYPES, SCORE_CRITERIA,
  layerForCategory, bandForCost, recommendedScoreType,
} from './src/categories.js';
import {
  allocate, tradeoff, scenarioSummaries, SCENARIOS, scoreVerdict,
} from './src/allocation.js';
import { aiStatus, askAssistant } from './src/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Разумные дефолты под жизнь с родителями и доход ~25k грн.
const DEFAULTS = { salary: 25000, survivalCost: 6000, buffer: 3000 };
const SETTINGS = {
  investments: 'investments',
  monthlyWallets: 'monthly_wallets',
  manualPlan: 'manual_plan',
};

// ---------- prepared statements ----------
const stmt = {
  activePlan: db.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1"),
  planById: db.prepare('SELECT * FROM plans WHERE id = ?'),
  insertPlan: db.prepare(
    'INSERT INTO plans (name, payday, salary, survival_cost, buffer) VALUES (@name, @payday, @salary, @survivalCost, @buffer)'
  ),
  updatePlan: db.prepare(
    'UPDATE plans SET name=@name, payday=@payday, salary=@salary, survival_cost=@survivalCost, buffer=@buffer WHERE id=@id'
  ),
  closePlan: db.prepare("UPDATE plans SET status='closed', snapshot=@snapshot, closed_at=datetime('now') WHERE id=@id"),
  closedPlans: db.prepare("SELECT * FROM plans WHERE status='closed' ORDER BY closed_at DESC"),

  activeItems: db.prepare("SELECT * FROM items WHERE status='active' ORDER BY id DESC"),
  allItems: db.prepare('SELECT * FROM items ORDER BY id DESC'),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertItem: db.prepare(`INSERT INTO items
    (title, cost, category, bucket, band, score_type, scores, priority, type, deadline, earliest_date, can_defer, emotional, trajectory, notes)
    VALUES (@title,@cost,@category,@layer,@band,@scoreType,@scores,@priority,@type,@deadline,@earliestDate,@canDefer,@emotional,@trajectory,@notes)`),
  updateItem: db.prepare(`UPDATE items SET
    title=@title, cost=@cost, category=@category, bucket=@layer, band=@band, score_type=@scoreType, scores=@scores,
    priority=@priority, type=@type, deadline=@deadline, earliest_date=@earliestDate, can_defer=@canDefer, emotional=@emotional,
    trajectory=@trajectory, notes=@notes, updated_at=datetime('now') WHERE id=@id`),
  setItemStatus: db.prepare("UPDATE items SET status=@status, updated_at=datetime('now') WHERE id=@id"),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
  updateItemSavings: db.prepare('UPDATE items SET saved_amount=@savedAmount, updated_at=datetime(\'now\') WHERE id=@id'),
};

function getActivePlan() {
  return rowToPlan(stmt.activePlan.get());
}
function getActiveItems() {
  return stmt.activeItems.all().map(rowToItem);
}
function getInvestments() {
  return getJSON(SETTINGS.investments, []);
}
function getWallets() {
  return getJSON(SETTINGS.monthlyWallets, []);
}
function getManualPlan() {
  return getJSON(SETTINGS.manualPlan, null);
}
function sanitizeEntries(entries, fields) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const out = { id: String(entry.id || Date.now() + Math.random()) };
    for (const field of fields) {
      if (field.type === 'number') out[field.key] = Math.max(0, Number(entry[field.key]) || 0);
      else out[field.key] = String(entry[field.key] || '').trim();
    }
    return out;
  }).filter((entry) => fields.some((field) => field.type === 'number' ? entry[field.key] > 0 : entry[field.key]));
}
function sanitizeManualPlan(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    itemId: Number(entry.itemId),
    amount: Math.max(0, Number(entry.amount) || 0),
  })).filter((entry) => entry.itemId && entry.amount > 0);
}

const VALID_CATEGORIES = new Set(CATEGORIES.map((c) => c.id));
const VALID_LAYERS = new Set(Object.keys(LAYERS));

function normalizeItemInput(b) {
  const category = VALID_CATEGORIES.has(b.category) ? b.category : 'lifestyle';
  // Слой по умолчанию берётся из категории, но пользователь может переопределить.
  const layer = VALID_LAYERS.has(b.layer) ? b.layer : layerForCategory(category);
  const cost = Math.max(0, Number(b.cost) || 0);
  const band = bandForCost(cost);
  const scoreType = ['none', 'quick', 'full'].includes(b.scoreType) ? b.scoreType : 'none';
  let scores = null;
  if (scoreType !== 'none' && b.scores && typeof b.scores === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(b.scores)) {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 5) clean[k] = n;
    }
    if (Object.keys(clean).length) scores = JSON.stringify(clean);
  }
  return {
    title: String(b.title || '').trim() || 'Без названия',
    cost,
    category,
    layer,
    band,
    scoreType,
    scores,
    priority: Math.min(5, Math.max(1, parseInt(b.priority, 10) || 3)),
    type: ['must', 'should', 'nice'].includes(b.type) ? b.type : 'should',
    deadline: b.deadline || null,
    earliestDate: b.earliestDate || null,
    canDefer: b.canDefer === false || b.canDefer === 0 ? 0 : 1,
    emotional: Math.min(5, Math.max(1, parseInt(b.emotional, 10) || 3)),
    trajectory: Math.min(5, Math.max(1, parseInt(b.trajectory, 10) || 3)),
    notes: b.notes ? String(b.notes) : null,
  };
}

// ================= AUTH =================
app.get('/api/auth/status', (req, res) => {
  res.json({ pinSet: pinIsSet(), authed: isAuthed(req) });
});

app.post('/api/auth/setup', (req, res) => {
  if (pinIsSet()) return res.status(400).json({ error: 'pin_already_set' });
  const pin = String(req.body?.pin || '');
  if (pin.length < 4) return res.status(400).json({ error: 'pin_too_short' });
  setPin(pin);
  issueToken(res);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!verifyPin(pin)) return res.status(401).json({ error: 'bad_pin' });
  issueToken(res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

// ================= META =================
function metaPayload() {
  return {
    categories: CATEGORIES,
    layers: LAYERS,
    buckets: LAYERS, // обратная совместимость
    types: TYPES,
    bands: BANDS,
    scoreTypes: SCORE_TYPES,
    scoreCriteria: SCORE_CRITERIA,
    scenarios: Object.entries(SCENARIOS).map(([key, v]) => ({ key, label: v.label })),
    defaults: DEFAULTS,
    ai: aiStatus(),
  };
}

app.get('/api/meta', requireAuth, (req, res) => {
  res.json(metaPayload());
});

// ================= PLAN =================
app.get('/api/plan', requireAuth, (req, res) => {
  res.json({ plan: getActivePlan() });
});

app.post('/api/plan', requireAuth, (req, res) => {
  const b = req.body || {};
  const payload = {
    name: String(b.name || 'Зарплата').trim() || 'Зарплата',
    payday: b.payday || new Date().toISOString().slice(0, 10),
    salary: Math.max(0, Number(b.salary) || 0),
    survivalCost: Math.max(0, Number(b.survivalCost) || 0),
    buffer: Math.max(0, Number(b.buffer) || 0),
  };
  const existing = getActivePlan();
  if (existing) {
    stmt.updatePlan.run({ ...payload, id: existing.id });
    res.json({ plan: rowToPlan(stmt.planById.get(existing.id)) });
  } else {
    const info = stmt.insertPlan.run(payload);
    res.json({ plan: rowToPlan(stmt.planById.get(info.lastInsertRowid)) });
  }
});

// Закрыть месяц: snapshot, купленное -> bought, отложенное остаётся active.
app.post('/api/plan/close', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: 'no_active_plan' });
  const items = getActiveItems();
  const result = allocate(plan, items, { scenario: req.body?.scenario || 'balanced' });

  const snapshot = {
    closedScenario: result.scenario,
    totals: result.totals,
    buckets: result.buckets,
    approved: result.approved.map((a) => ({ title: a.item.title, cost: a.item.cost, layer: a.item.layer })),
    deferred: result.deferred.map((d) => ({ title: d.item.title, cost: d.item.cost, reason: d.reason })),
  };
  stmt.closePlan.run({ id: plan.id, snapshot: JSON.stringify(snapshot) });

  // Купленное архивируем (bought), отложенное оставляем в мастер-листе.
  const approvedIds = new Set(result.approved.map((a) => a.item.id));
  const mark = db.transaction(() => {
    for (const id of approvedIds) stmt.setItemStatus.run({ id, status: 'bought' });
  });
  mark();

  res.json({ ok: true, snapshot });
});

// ================= ITEMS (master wishlist) =================
app.get('/api/items', requireAuth, (req, res) => {
  const rows = req.query.all ? stmt.allItems.all() : stmt.activeItems.all();
  res.json({ items: rows.map(rowToItem) });
});

app.post('/api/items', requireAuth, (req, res) => {
  const payload = normalizeItemInput(req.body || {});
  const info = stmt.insertItem.run(payload);
  res.json({ item: rowToItem(stmt.itemById.get(info.lastInsertRowid)) });
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!stmt.itemById.get(id)) return res.status(404).json({ error: 'not_found' });
  const payload = normalizeItemInput(req.body || {});
  stmt.updateItem.run({ ...payload, id });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.post('/api/items/:id/status', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const status = ['active', 'bought', 'archived'].includes(req.body?.status) ? req.body.status : 'active';
  if (!stmt.itemById.get(id)) return res.status(404).json({ error: 'not_found' });
  stmt.setItemStatus.run({ id, status });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.post('/api/items/:id/savings', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!stmt.itemById.get(id)) return res.status(404).json({ error: 'not_found' });
  stmt.updateItemSavings.run({ id, savedAmount: Math.max(0, Number(req.body?.savedAmount) || 0) });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  stmt.deleteItem.run(Number(req.params.id));
  res.json({ ok: true });
});

// ================= ALLOCATION =================
function customIds() {
  return getJSON('custom_include', null);
}

app.get('/api/allocation', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.json({ plan: null, allocation: null });
  const scenario = req.query.scenario || 'balanced';
  const allocation = allocate(plan, getActiveItems(), {
    scenario,
    includeIds: scenario === 'custom' ? customIds() : null,
  });
  res.json({ plan, allocation });
});

app.get('/api/scenarios', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.json({ scenarios: [] });
  res.json({ scenarios: scenarioSummaries(plan, getActiveItems(), customIds()) });
});

app.get('/api/custom-scenario', requireAuth, (req, res) => {
  res.json({ includeIds: customIds() || [] });
});
app.post('/api/custom-scenario', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.includeIds) ? req.body.includeIds.map(Number) : [];
  setJSON('custom_include', ids);
  res.json({ includeIds: ids });
});

app.get('/api/investments', requireAuth, (req, res) => {
  res.json({ investments: getInvestments() });
});
app.post('/api/investments', requireAuth, (req, res) => {
  const investments = sanitizeEntries(req.body?.investments, [
    { key: 'name', type: 'text' },
    { key: 'amount', type: 'number' },
    { key: 'date', type: 'text' },
  ]);
  setJSON(SETTINGS.investments, investments);
  res.json({ investments });
});

app.get('/api/wallets', requireAuth, (req, res) => {
  res.json({ wallets: getWallets() });
});
app.post('/api/wallets', requireAuth, (req, res) => {
  const wallets = sanitizeEntries(req.body?.wallets, [
    { key: 'name', type: 'text' },
    { key: 'purpose', type: 'text' },
    { key: 'amount', type: 'number' },
  ]);
  setJSON(SETTINGS.monthlyWallets, wallets);
  res.json({ wallets });
});

app.get('/api/manual-plan', requireAuth, (req, res) => {
  res.json({ manualPlan: getManualPlan() || [] });
});
app.post('/api/manual-plan', requireAuth, (req, res) => {
  const manualPlan = sanitizeManualPlan(req.body?.manualPlan);
  setJSON(SETTINGS.manualPlan, manualPlan);
  res.json({ manualPlan });
});

app.get('/api/tradeoff/:id', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: 'no_active_plan' });
  const scenario = req.query.scenario || 'balanced';
  const t = tradeoff(Number(req.params.id), plan, getActiveItems(), {
    scenario,
    includeIds: scenario === 'custom' ? customIds() : null,
  });
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json(t);
});

// ================= HISTORY =================
app.get('/api/history', requireAuth, (req, res) => {
  res.json({ history: stmt.closedPlans.all().map(rowToPlan) });
});

// ================= AGGREGATE STATE =================
app.get('/api/state', requireAuth, (req, res) => {
  const plan = getActivePlan();
  const items = getActiveItems();
  const scenario = req.query.scenario || 'balanced';
  const allocation = plan
    ? allocate(plan, items, { scenario, includeIds: scenario === 'custom' ? customIds() : null })
    : null;
  res.json({
    plan,
    items,
    allocation,
    scenarios: plan ? scenarioSummaries(plan, items, customIds()) : [],
    history: stmt.closedPlans.all().map(rowToPlan),
    meta: metaPayload(),
    investments: getInvestments(),
    wallets: getWallets(),
    manualPlan: getManualPlan() || [],
  });
});

// ================= AI =================
app.get('/api/ai/status', requireAuth, (req, res) => res.json(aiStatus()));

app.post('/api/ai/chat', requireAuth, async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const plan = getActivePlan();
    const items = getActiveItems();
    const allocation = plan ? allocate(plan, items, { scenario: 'balanced' }) : null;
    const context = {
      plan,
      allocation: allocation && {
        totals: allocation.totals,
        approved: allocation.approved.map((a) => ({ title: a.item.title, cost: a.item.cost })),
        deferred: allocation.deferred.map((d) => ({ title: d.item.title, cost: d.item.cost, reason: d.reason })),
      },
      itemsCount: items.length,
    };
    const out = await askAssistant(messages, context);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'ai_failed', detail: String(e.message || e) });
  }
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Salary Allocation Planner на http://localhost:${PORT}`));
