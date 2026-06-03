import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import db, {
  getJSON,
  setJSON,
  rowToItem,
  rowToPlan,
  rowToWallet,
  rowToGoal,
  rowToInvestmentUpdate,
  rowToAllocationDecision,
  currencyRate,
  setCurrencyRate,
  DB_PATH,
} from "./src/db.js";
import {
  pinIsSet,
  setPin,
  verifyPin,
  issueToken,
  clearToken,
  isAuthed,
  requireAuth,
} from "./src/auth.js";
import {
  CATEGORIES,
  LAYERS,
  TYPES,
  BANDS,
  SCORE_TYPES,
  SCORE_CRITERIA,
  layerForCategory,
  bandForCost,
  recommendedScoreType,
} from "./src/categories.js";
import {
  allocate,
  tradeoff,
  scenarioSummaries,
  SCENARIOS,
  scoreVerdict,
} from "./src/allocation.js";
import { aiStatus, askAssistant, askAssistantText } from "./src/ai.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// ---------- live data version ----------
// Любая успешная мутация (POST/PUT/DELETE) поднимает версию данных.
// Фронтенд опрашивает /api/version и обновляет все вкладки/устройства.
let dataVersion = Date.now();
app.use((req, res, next) => {
  const m = req.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    res.on("finish", () => {
      if (res.statusCode < 400) dataVersion = Date.now();
    });
  }
  next();
});

// Разумные дефолты под жизнь с родителями и доход ~25k грн.
const DEFAULTS = {
  salary: 25000,
  survivalCost: 6000,
  buffer: 1000,
  investmentFixed: 2000,
};
const SETTINGS = {
  investments: "investments",
  monthlyWallets: "monthly_wallets",
  manualPlan: "manual_plan",
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthForPlan = (plan) => String(plan?.payday || todayISO()).slice(0, 7);

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;
function authClientKey(req) {
  const forwarded = String(
    req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || "",
  )
    .split(",")[0]
    .trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}
function authRateLimit(req, res, next) {
  const key = authClientKey(req);
  const now = Date.now();
  const row = stmt.authAttemptByKey.get(key);
  const entry =
    row && row.reset_at > now
      ? {
          count: Number(row.count) || 0,
          resetAt: Number(row.reset_at) || now + LOGIN_WINDOW_MS,
        }
      : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "too_many_attempts", retryAfter });
  }
  entry.count += 1;
  stmt.upsertAuthAttempt.run({
    key,
    count: entry.count,
    resetAt: entry.resetAt,
  });
  req.authRateLimitKey = key;
  next();
}
setInterval(() => {
  try {
    stmt.deleteExpiredAuthAttempts.run(Date.now());
  } catch {}
}, LOGIN_WINDOW_MS).unref?.();

// ---------- prepared statements ----------
const stmt = {
  authAttemptByKey: db.prepare(
    "SELECT key, count, reset_at FROM auth_attempts WHERE key = ?",
  ),
  upsertAuthAttempt:
    db.prepare(`INSERT INTO auth_attempts (key, count, reset_at, updated_at)
    VALUES (@key, @count, @resetAt, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at, updated_at=datetime('now')`),
  deleteAuthAttempt: db.prepare("DELETE FROM auth_attempts WHERE key = ?"),
  deleteExpiredAuthAttempts: db.prepare(
    "DELETE FROM auth_attempts WHERE reset_at <= ?",
  ),

  activePlan: db.prepare(
    "SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1",
  ),
  planById: db.prepare("SELECT * FROM plans WHERE id = ?"),
  insertPlan: db.prepare(
    "INSERT INTO plans (name, payday, salary, survival_cost, buffer, investment_fixed) VALUES (@name, @payday, @salary, @survivalCost, @buffer, @investmentFixed)",
  ),
  updatePlan: db.prepare(
    "UPDATE plans SET name=@name, payday=@payday, salary=@salary, survival_cost=@survivalCost, buffer=@buffer, investment_fixed=@investmentFixed WHERE id=@id",
  ),
  closePlan: db.prepare(
    "UPDATE plans SET status='closed', snapshot=@snapshot, closed_at=datetime('now') WHERE id=@id",
  ),
  closedPlans: db.prepare(
    "SELECT * FROM plans WHERE status='closed' ORDER BY closed_at DESC",
  ),

  activeItems: db.prepare(
    "SELECT * FROM items WHERE status='active' ORDER BY id DESC",
  ),
  allItems: db.prepare("SELECT * FROM items ORDER BY id DESC"),
  itemById: db.prepare("SELECT * FROM items WHERE id = ?"),
  insertItem: db.prepare(`INSERT INTO items
    (title, cost, category, bucket, band, score_type, scores, priority, type, deadline, earliest_date, can_defer, emotional, trajectory, notes)
    VALUES (@title,@cost,@category,@layer,@band,@scoreType,@scores,@priority,@type,@deadline,@earliestDate,@canDefer,@emotional,@trajectory,@notes)`),
  updateItem: db.prepare(`UPDATE items SET
    title=@title, cost=@cost, category=@category, bucket=@layer, band=@band, score_type=@scoreType, scores=@scores,
    priority=@priority, type=@type, deadline=@deadline, earliest_date=@earliestDate, can_defer=@canDefer, emotional=@emotional,
    trajectory=@trajectory, notes=@notes, updated_at=datetime('now') WHERE id=@id`),
  setItemStatus: db.prepare(
    "UPDATE items SET status=@status, updated_at=datetime('now') WHERE id=@id",
  ),
  deleteItem: db.prepare("DELETE FROM items WHERE id = ?"),
  updateItemSavings: db.prepare(
    "UPDATE items SET saved_amount=@savedAmount, updated_at=datetime('now') WHERE id=@id",
  ),

  walletsByPlan: db.prepare(
    "SELECT * FROM wallets WHERE plan_id IS @planId ORDER BY created_at DESC",
  ),
  upsertWallet:
    db.prepare(`INSERT INTO wallets (id, plan_id, name, purpose, amount, month)
    VALUES (@id, @planId, @name, @purpose, @amount, @month)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, purpose=excluded.purpose,
      amount=excluded.amount, month=excluded.month, updated_at=datetime('now')`),
  deleteWalletsForPlan: db.prepare(
    "DELETE FROM wallets WHERE plan_id IS @planId",
  ),

  goalsByItems: db.prepare(
    "SELECT * FROM goals WHERE item_id IN (SELECT id FROM items) ORDER BY updated_at DESC",
  ),
  goalByItem: db.prepare("SELECT * FROM goals WHERE item_id = ?"),
  upsertGoal:
    db.prepare(`INSERT INTO goals (item_id, target_amount, saved_amount, monthly_contribution, deadline, status)
    VALUES (@itemId, @targetAmount, @savedAmount, @monthlyContribution, @deadline, @status)
    ON CONFLICT(item_id) DO UPDATE SET target_amount=excluded.target_amount,
      saved_amount=excluded.saved_amount, monthly_contribution=excluded.monthly_contribution,
      deadline=excluded.deadline, status=excluded.status, updated_at=datetime('now')`),
  insertGoalContribution:
    db.prepare(`INSERT INTO goal_contributions (goal_id, plan_id, amount, date, note)
    VALUES (@goalId, @planId, @amount, @date, @note)`),

  investmentUpdates:
    db.prepare(`SELECT iu.*, ia.name AS account_name, ia.type AS account_type
    FROM investment_updates iu JOIN investment_accounts ia ON ia.id = iu.account_id
    ORDER BY iu.date DESC, iu.created_at DESC`),
  upsertInvestmentAccount:
    db.prepare(`INSERT INTO investment_accounts (id, name, type)
    VALUES (@id, @name, @type)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, updated_at=datetime('now')`),
  upsertInvestmentUpdate:
    db.prepare(`INSERT INTO investment_updates (id, account_id, plan_id, amount, date, note)
    VALUES (@id, @accountId, @planId, @amount, @date, @note)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, plan_id=excluded.plan_id,
      amount=excluded.amount, date=excluded.date, note=excluded.note`),
  deleteInvestmentUpdates: db.prepare("DELETE FROM investment_updates"),
  deleteUnusedInvestmentAccounts: db.prepare(
    "DELETE FROM investment_accounts WHERE id NOT IN (SELECT account_id FROM investment_updates)",
  ),

  decisionsByPlan: db.prepare(
    "SELECT * FROM allocation_decisions WHERE plan_id IS @planId AND source='manual' ORDER BY updated_at DESC",
  ),
  upsertDecision:
    db.prepare(`INSERT INTO allocation_decisions (plan_id, item_id, amount, scenario, source)
    VALUES (@planId, @itemId, @amount, @scenario, 'manual')
    ON CONFLICT(plan_id, item_id, source) DO UPDATE SET amount=excluded.amount,
      scenario=excluded.scenario, updated_at=datetime('now')`),
  deleteDecisionsForPlan: db.prepare(
    "DELETE FROM allocation_decisions WHERE plan_id IS @planId AND source='manual'",
  ),
  deleteGoal: db.prepare("DELETE FROM goals WHERE id = ?"),
  deleteGoalByItem: db.prepare("DELETE FROM goals WHERE item_id = ?"),
  allGoals: db.prepare("SELECT * FROM goals ORDER BY updated_at DESC"),
  allWallets: db.prepare("SELECT * FROM wallets ORDER BY created_at DESC"),
  allDecisions: db.prepare(
    "SELECT * FROM allocation_decisions ORDER BY updated_at DESC",
  ),
  allInvestmentAccounts: db.prepare(
    "SELECT * FROM investment_accounts ORDER BY name",
  ),
  deleteWalletById: db.prepare("DELETE FROM wallets WHERE id = ?"),

  // New investment model
  allAssets: db.prepare("SELECT * FROM investment_assets ORDER BY name"),
  assetById: db.prepare("SELECT * FROM investment_assets WHERE id = ?"),
  insertAsset:
    db.prepare(`INSERT INTO investment_assets (id, name, type, ticker, currency)
    VALUES (@id, @name, @type, @ticker, @currency)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,
      ticker=excluded.ticker, currency=excluded.currency, updated_at=datetime('now')`),
  deleteAsset: db.prepare("DELETE FROM investment_assets WHERE id = ?"),

  transactionsByAsset: db.prepare(
    "SELECT * FROM asset_transactions WHERE asset_id = ? ORDER BY date DESC, created_at DESC",
  ),
  allTransactions: db.prepare(
    "SELECT * FROM asset_transactions ORDER BY date DESC, created_at DESC",
  ),
  insertTransaction:
    db.prepare(`INSERT INTO asset_transactions (id, asset_id, type, date, quantity, price, fee, total_amount, note)
    VALUES (@id, @asset_id, @type, @date, @quantity, @price, @fee, @total_amount, @note)`),
  deleteTransaction: db.prepare("DELETE FROM asset_transactions WHERE id = ?"),

  valuationsByAsset: db.prepare(
    "SELECT * FROM asset_valuations WHERE asset_id = ? ORDER BY date DESC, created_at DESC",
  ),
  allValuations: db.prepare(
    "SELECT * FROM asset_valuations ORDER BY date DESC, created_at DESC",
  ),
  insertValuation:
    db.prepare(`INSERT INTO asset_valuations (id, asset_id, date, value, quantity, note)
    VALUES (@id, @asset_id, @date, @value, @quantity, @note)`),
  deleteValuation: db.prepare("DELETE FROM asset_valuations WHERE id = ?"),
};

function getActivePlan() {
  return rowToPlan(stmt.activePlan.get());
}
function getActiveItems() {
  return stmt.activeItems.all().map(rowToItem);
}
function currentPlanId() {
  return getActivePlan()?.id || null;
}
function getInvestments() {
  const rows = stmt.investmentUpdates.all().map(rowToInvestmentUpdate);
  if (rows.length) return rows;
  return getJSON(SETTINGS.investments, []);
}
function getPortfolio() {
  const assets = stmt.allAssets.all();
  const allTx = stmt.allTransactions.all();
  const allVal = stmt.allValuations.all();
  const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;

  const assetData = assets.map((a) => {
    const txs = allTx
      .filter((t) => t.asset_id === a.id)
      .sort(
        (left, right) =>
          String(left.date || "").localeCompare(String(right.date || "")) ||
          String(left.created_at || "").localeCompare(
            String(right.created_at || ""),
          ),
      );
    const vals = allVal.filter((v) => v.asset_id === a.id);

    let quantityHeld = 0;
    let costBasis = 0;
    let realizedPnL = 0;

    for (const tx of txs) {
      const qty = Math.max(0, Number(tx.quantity) || 0);
      const fee = Math.max(0, Number(tx.fee) || 0);
      const gross = qty * Math.max(0, Number(tx.price) || 0);
      const storedTotal = Math.max(0, Number(tx.total_amount) || 0);

      if (tx.type === "buy") {
        const buyCost = storedTotal > 0 ? storedTotal : gross + fee;
        quantityHeld += qty;
        costBasis += buyCost;
      } else if (tx.type === "sell") {
        const sellQty = Math.min(qty, quantityHeld);
        if (sellQty <= 0) continue;
        const sellProceeds =
          storedTotal > 0 ? storedTotal : Math.max(0, gross - fee);
        const avgCost = quantityHeld > 0 ? costBasis / quantityHeld : 0;
        const soldBasis = avgCost * sellQty;
        realizedPnL += sellProceeds - soldBasis;
        quantityHeld -= sellQty;
        costBasis -= soldBasis;
      }
    }

    quantityHeld = Math.max(0, quantityHeld);
    costBasis = Math.max(0, costBasis);

    const latestVal = vals.length > 0 ? vals[0] : null;
    const currentValue = latestVal
      ? Number(latestVal.value) || 0
      : quantityHeld > 0
        ? costBasis
        : 0;
    const unrealizedPnL = currentValue - costBasis;

    return {
      id: a.id,
      name: a.name,
      type: a.type,
      ticker: a.ticker,
      currency: a.currency,
      currentValue: roundMoney(currentValue),
      quantityHeld: roundMoney(quantityHeld),
      totalInvested: roundMoney(costBasis),
      realizedPnL: roundMoney(realizedPnL),
      unrealizedPnL: roundMoney(unrealizedPnL),
      totalPnL: roundMoney(realizedPnL + unrealizedPnL),
    };
  });

  const totalValue = roundMoney(
    assetData.reduce((s, a) => s + a.currentValue, 0),
  );
  const totalInvestedAll = roundMoney(
    assetData.reduce((s, a) => s + a.totalInvested, 0),
  );
  const totalPnL = roundMoney(assetData.reduce((s, a) => s + a.totalPnL, 0));

  return {
    assets: assetData,
    transactions: allTx.map((t) => ({
      id: t.id,
      assetId: t.asset_id,
      type: t.type,
      date: t.date,
      quantity: t.quantity,
      price: t.price,
      fee: t.fee,
      totalAmount: t.total_amount,
      note: t.note,
      createdAt: t.created_at,
    })),
    valuations: allVal.map((v) => ({
      id: v.id,
      assetId: v.asset_id,
      date: v.date,
      value: v.value,
      quantity: v.quantity,
      note: v.note,
      createdAt: v.created_at,
    })),
    totals: {
      totalValue,
      totalInvested: totalInvestedAll,
      totalPnL,
    },
    totalValue,
    totalInvested: totalInvestedAll,
    totalPnL,
  };
}
function getWallets() {
  const plan = getActivePlan();
  const rows = stmt.walletsByPlan
    .all({ planId: plan?.id || null })
    .map(rowToWallet);
  if (rows.length) return rows;
  return getJSON(SETTINGS.monthlyWallets, []);
}
function getManualPlan() {
  const rows = stmt.decisionsByPlan
    .all({ planId: currentPlanId() })
    .map(rowToAllocationDecision);
  if (rows.length)
    return rows.map(({ itemId, amount }) => ({ itemId, amount }));
  return getJSON(SETTINGS.manualPlan, null);
}
function getGoals() {
  return stmt.goalsByItems.all().map(rowToGoal);
}

function buildAIContext(scenario = "balanced") {
  const plan = getActivePlan();
  const items = getActiveItems();
  const allocation = plan
    ? allocate(plan, items, {
        scenario,
        includeIds: scenario === "custom" ? customIds() : null,
      })
    : null;
  const portfolio = getPortfolio();
  return {
    plan,
    allocation: allocation && {
      totals: allocation.totals,
      approved: allocation.approved.map((a) => ({
        title: a.item.title,
        cost: a.item.cost,
      })),
      deferred: allocation.deferred.map((d) => ({
        title: d.item.title,
        cost: d.item.cost,
        reason: d.reason,
      })),
      policyTargets: allocation.policyTargets,
    },
    goals: getGoals(),
    wallets: getWallets(),
    investments: getInvestments(),
    portfolio: {
      totalValue: portfolio.totals.totalValue,
      totalInvested: portfolio.totals.totalInvested,
      totalPnL: portfolio.totals.totalPnL,
      assets: portfolio.assets.map((a) => ({
        name: a.name,
        type: a.type,
        value: a.currentValue,
      })),
    },
    manualPlan: getManualPlan() || [],
    itemsCount: items.length,
  };
}
function sanitizeEntries(entries, fields) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const out = { id: String(entry.id || Date.now() + Math.random()) };
      for (const field of fields) {
        if (field.type === "number")
          out[field.key] = Math.max(0, Number(entry[field.key]) || 0);
        else out[field.key] = String(entry[field.key] || "").trim();
      }
      return out;
    })
    .filter((entry) =>
      fields.some((field) =>
        field.type === "number" ? entry[field.key] > 0 : entry[field.key],
      ),
    );
}
function sanitizeManualPlan(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      itemId: Number(entry.itemId),
      amount: Math.max(0, Number(entry.amount) || 0),
    }))
    .filter((entry) => entry.itemId && entry.amount > 0);
}

const VALID_CATEGORIES = new Set(CATEGORIES.map((c) => c.id));
const VALID_LAYERS = new Set(Object.keys(LAYERS));

function normalizeItemInput(b) {
  const category = VALID_CATEGORIES.has(b.category) ? b.category : "lifestyle";
  // Слой по умолчанию берётся из категории, но пользователь может переопределить.
  const layer = VALID_LAYERS.has(b.layer)
    ? b.layer
    : layerForCategory(category);
  const cost = Math.max(0, Number(b.cost) || 0);
  const band = bandForCost(cost);
  const scoreType = ["none", "quick", "full"].includes(b.scoreType)
    ? b.scoreType
    : "none";
  let scores = null;
  if (scoreType !== "none" && b.scores && typeof b.scores === "object") {
    const clean = {};
    for (const [k, v] of Object.entries(b.scores)) {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 5) clean[k] = n;
    }
    if (Object.keys(clean).length) scores = JSON.stringify(clean);
  }
  return {
    title: String(b.title || "").trim() || "Без названия",
    cost,
    category,
    layer,
    band,
    scoreType,
    scores,
    priority: Math.min(5, Math.max(1, parseInt(b.priority, 10) || 3)),
    type: ["must", "should", "nice"].includes(b.type) ? b.type : "should",
    deadline: b.deadline || null,
    earliestDate: b.earliestDate || null,
    canDefer: b.canDefer === false || b.canDefer === 0 ? 0 : 1,
    emotional: Math.min(5, Math.max(1, parseInt(b.emotional, 10) || 3)),
    trajectory: Math.min(5, Math.max(1, parseInt(b.trajectory, 10) || 3)),
    notes: b.notes ? String(b.notes) : null,
  };
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-20)
    .map((message) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = String(message?.content || "")
        .slice(0, 4000)
        .trim();
      return { role, content };
    })
    .filter((message) => message.content);
}

// ================= AUTH =================
app.get("/api/auth/status", (req, res) => {
  const pinSet = pinIsSet();
  res.json({
    pinSet,
    authed: isAuthed(req),
    setupTokenRequired: !pinSet && !!process.env.SETUP_TOKEN,
  });
});

app.post("/api/auth/setup", (req, res) => {
  if (pinIsSet()) return res.status(400).json({ error: "pin_already_set" });
  if (
    process.env.SETUP_TOKEN &&
    String(req.body?.setupToken || "") !== process.env.SETUP_TOKEN
  ) {
    return res.status(403).json({ error: "bad_setup_token" });
  }
  const pin = String(req.body?.pin || "");
  if (pin.length < 4) return res.status(400).json({ error: "pin_too_short" });
  setPin(pin);
  issueToken(res);
  res.json({ ok: true });
});

app.post("/api/auth/login", authRateLimit, (req, res) => {
  const pin = String(req.body?.pin || "");
  if (!verifyPin(pin)) return res.status(401).json({ error: "bad_pin" });
  if (req.authRateLimitKey) stmt.deleteAuthAttempt.run(req.authRateLimitKey);
  issueToken(res);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
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
    scenarios: Object.entries(SCENARIOS).map(([key, v]) => ({
      key,
      label: v.label,
    })),
    defaults: DEFAULTS,
    ai: aiStatus(),
  };
}

app.get("/api/meta", requireAuth, (req, res) => {
  res.json(metaPayload());
});

// ================= PLAN =================
app.get("/api/plan", requireAuth, (req, res) => {
  res.json({ plan: getActivePlan() });
});

app.post("/api/plan", requireAuth, (req, res) => {
  const b = req.body || {};
  const payload = {
    name: String(b.name || "Зарплата").trim() || "Зарплата",
    payday: b.payday || new Date().toISOString().slice(0, 10),
    salary: Math.max(0, Number(b.salary) || 0),
    survivalCost: Math.max(0, Number(b.survivalCost) || 0),
    buffer: Math.max(0, Number(b.buffer) || 0),
    investmentFixed: Math.max(0, Number(b.investmentFixed) || 0),
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
app.post("/api/plan/close", requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: "no_active_plan" });
  const items = getActiveItems();
  const result = allocate(plan, items, {
    scenario: req.body?.scenario || "balanced",
  });

  const snapshot = {
    closedScenario: result.scenario,
    totals: result.totals,
    buckets: result.buckets,
    approved: result.approved.map((a) => ({
      title: a.item.title,
      cost: a.item.cost,
      layer: a.item.layer,
    })),
    deferred: result.deferred.map((d) => ({
      title: d.item.title,
      cost: d.item.cost,
      reason: d.reason,
    })),
  };
  // Купленное архивируем (bought), отложенное оставляем в мастер-листе.
  const approvedIds = new Set(result.approved.map((a) => a.item.id));
  const close = db.transaction(() => {
    stmt.closePlan.run({ id: plan.id, snapshot: JSON.stringify(snapshot) });
    for (const id of approvedIds)
      stmt.setItemStatus.run({ id, status: "bought" });
  });
  close();

  res.json({ ok: true, snapshot });
});

// ================= CURRENCY =================
app.get("/api/currency", requireAuth, (req, res) => {
  res.json({ rate: currencyRate() });
});
app.post("/api/currency", requireAuth, (req, res) => {
  const rate = Math.max(1, Number(req.body?.rate) || 43.5);
  setCurrencyRate(rate);
  res.json({ rate: currencyRate() });
});

// ================= ITEMS (master wishlist) =================
app.get("/api/items", requireAuth, (req, res) => {
  const rows = req.query.all ? stmt.allItems.all() : stmt.activeItems.all();
  res.json({ items: rows.map(rowToItem) });
});

app.post("/api/items", requireAuth, (req, res) => {
  const payload = normalizeItemInput(req.body || {});
  const info = stmt.insertItem.run(payload);
  res.json({ item: rowToItem(stmt.itemById.get(info.lastInsertRowid)) });
});

app.put("/api/items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!stmt.itemById.get(id))
    return res.status(404).json({ error: "not_found" });
  const payload = normalizeItemInput(req.body || {});
  stmt.updateItem.run({ ...payload, id });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.post("/api/items/:id/status", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const status = ["active", "bought", "archived"].includes(req.body?.status)
    ? req.body.status
    : "active";
  if (!stmt.itemById.get(id))
    return res.status(404).json({ error: "not_found" });
  stmt.setItemStatus.run({ id, status });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.post("/api/items/:id/savings", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const item = stmt.itemById.get(id);
  if (!item) return res.status(404).json({ error: "not_found" });
  const savedAmount = Math.max(0, Number(req.body?.savedAmount) || 0);
  stmt.updateItemSavings.run({ id, savedAmount });
  const existingGoal = stmt.goalByItem.get(id);
  const goalPayload = {
    itemId: id,
    targetAmount: Number(item.cost) || 0,
    savedAmount,
    monthlyContribution: Math.max(
      0,
      Number(
        req.body?.monthlyContribution ??
          existingGoal?.monthly_contribution ??
          0,
      ),
    ),
    deadline: req.body?.deadline || existingGoal?.deadline || item.deadline,
    status: savedAmount >= (Number(item.cost) || 0) ? "complete" : "active",
  };
  stmt.upsertGoal.run(goalPayload);
  const goal = stmt.goalByItem.get(id);
  if (Number(req.body?.contributionAmount) > 0) {
    stmt.insertGoalContribution.run({
      goalId: goal.id,
      planId: currentPlanId(),
      amount: Math.max(0, Number(req.body.contributionAmount) || 0),
      date: req.body?.date || todayISO(),
      note: req.body?.note || "",
    });
  }
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.get("/api/goals", requireAuth, (req, res) => {
  res.json({ goals: getGoals() });
});
app.post("/api/goals", requireAuth, (req, res) => {
  const itemId = Number(req.body?.itemId);
  const item = stmt.itemById.get(itemId);
  if (!item) return res.status(404).json({ error: "item_not_found" });
  const savedAmount = Math.max(0, Number(req.body?.savedAmount) || 0);
  stmt.upsertGoal.run({
    itemId,
    targetAmount: Math.max(0, Number(req.body?.targetAmount ?? item.cost) || 0),
    savedAmount,
    monthlyContribution: Math.max(
      0,
      Number(req.body?.monthlyContribution) || 0,
    ),
    deadline: req.body?.deadline || item.deadline || null,
    status:
      req.body?.status ||
      (savedAmount >= Number(item.cost) ? "complete" : "active"),
  });
  stmt.updateItemSavings.run({ id: itemId, savedAmount });
  res.json({
    goal: rowToGoal(stmt.goalByItem.get(itemId)),
    item: rowToItem(stmt.itemById.get(itemId)),
  });
});
app.delete("/api/goals/:id", requireAuth, (req, res) => {
  stmt.deleteGoal.run(Number(req.params.id));
  res.json({ ok: true });
});

app.delete("/api/items/:id", requireAuth, (req, res) => {
  stmt.deleteItem.run(Number(req.params.id));
  res.json({ ok: true });
});

// ================= ALLOCATION =================
function customIds() {
  return getJSON("custom_include", null);
}

app.get("/api/allocation", requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.json({ plan: null, allocation: null });
  const scenario = req.query.scenario || "balanced";
  const allocation = allocate(plan, getActiveItems(), {
    scenario,
    includeIds: scenario === "custom" ? customIds() : null,
  });
  res.json({ plan, allocation });
});

app.get("/api/scenarios", requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.json({ scenarios: [] });
  res.json({
    scenarios: scenarioSummaries(plan, getActiveItems(), customIds()),
  });
});

app.get("/api/custom-scenario", requireAuth, (req, res) => {
  res.json({ includeIds: customIds() || [] });
});
app.post("/api/custom-scenario", requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.includeIds)
    ? req.body.includeIds.map(Number)
    : [];
  setJSON("custom_include", ids);
  res.json({ includeIds: ids });
});

// ================= INVESTMENTS (new model) =================
app.get("/api/investments", requireAuth, (req, res) => {
  res.json(getPortfolio());
});
app.post("/api/investments/assets", requireAuth, (req, res) => {
  const { id, name, type, ticker, currency } = req.body || {};
  const assetId = String(
    id || Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  );
  const assetName = String(name || "").trim() || "Актив";
  stmt.insertAsset.run({
    id: assetId,
    name: assetName,
    type: String(type || "other").trim(),
    ticker: ticker ? String(ticker).trim() : null,
    currency: ["USD", "UAH"].includes(String(currency || "USD").toUpperCase())
      ? String(currency || "USD").toUpperCase()
      : "USD",
  });
  res.json(getPortfolio());
});
app.delete("/api/investments/assets/:id", requireAuth, (req, res) => {
  stmt.deleteAsset.run(String(req.params.id));
  res.json(getPortfolio());
});
app.post("/api/investments/transactions", requireAuth, (req, res) => {
  const { assetId, type, date, quantity, price, fee, note } = req.body || {};
  if (!assetId) return res.status(400).json({ error: "assetId_required" });
  if (!stmt.assetById.get(String(assetId)))
    return res.status(404).json({ error: "asset_not_found" });
  const txType = ["buy", "sell"].includes(type) ? type : "buy";
  const qty = Math.max(0, Number(quantity) || 0);
  const px = Math.max(0, Number(price) || 0);
  const txFee = Math.max(0, Number(fee) || 0);
  const total = txType === "buy" ? qty * px + txFee : qty * px - txFee;
  stmt.insertTransaction.run({
    id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    asset_id: String(assetId),
    type: txType,
    date: date || todayISO(),
    quantity: qty,
    price: px,
    fee: txFee,
    total_amount: Math.max(0, total),
    note: note ? String(note) : "",
  });
  res.json(getPortfolio());
});
app.delete("/api/investments/transactions/:id", requireAuth, (req, res) => {
  stmt.deleteTransaction.run(String(req.params.id));
  res.json(getPortfolio());
});
app.post("/api/investments/valuations", requireAuth, (req, res) => {
  const { assetId, date, value, quantity, note } = req.body || {};
  if (!assetId) return res.status(400).json({ error: "assetId_required" });
  if (!stmt.assetById.get(String(assetId)))
    return res.status(404).json({ error: "asset_not_found" });
  stmt.insertValuation.run({
    id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    asset_id: String(assetId),
    date: date || todayISO(),
    value: Math.max(0, Number(value) || 0),
    quantity: quantity != null ? Math.max(0, Number(quantity) || 0) : null,
    note: note ? String(note) : "",
  });
  res.json(getPortfolio());
});
app.delete("/api/investments/valuations/:id", requireAuth, (req, res) => {
  stmt.deleteValuation.run(String(req.params.id));
  res.json(getPortfolio());
});

// Legacy investment endpoints (backward compat)
app.post("/api/investments", requireAuth, (req, res) => {
  const investments = sanitizeEntries(req.body?.investments, [
    { key: "name", type: "text" },
    { key: "accountType", type: "text" },
    { key: "amount", type: "number" },
    { key: "date", type: "text" },
    { key: "note", type: "text" },
  ]);
  const planId = currentPlanId();
  const save = db.transaction(() => {
    stmt.deleteInvestmentUpdates.run();
    investments.forEach((entry) => {
      const accountName = entry.name || "Инвестиция";
      const accountId = String(
        entry.accountId || accountName.toLowerCase().replace(/\s+/g, "-"),
      );
      const updateId = String(
        entry.id || `${accountId}-${entry.date || todayISO()}-${Date.now()}`,
      );
      stmt.upsertInvestmentAccount.run({
        id: accountId,
        name: accountName,
        type: entry.accountType || "asset",
      });
      stmt.upsertInvestmentUpdate.run({
        id: updateId,
        accountId,
        planId,
        amount: entry.amount,
        date: entry.date || todayISO(),
        note: entry.note || "",
      });
    });
    stmt.deleteUnusedInvestmentAccounts.run();
  });
  save();
  res.json(getPortfolio());
});

// Price refresh for all asset types
const CG_MAP = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  xrp: "ripple",
  ada: "cardano",
  dot: "polkadot",
  avax: "avalanche-2",
  matic: "matic-network",
  link: "chainlink",
  atom: "cosmos",
  uni: "uniswap",
  ltc: "litecoin",
  bch: "bitcoin-cash",
  near: "near",
  trx: "tron",
  fil: "filecoin",
  apt: "aptos",
  arb: "arbitrum",
  op: "optimism",
  inj: "injective",
  doge: "dogecoin",
  pepe: "pepe",
  sui: "sui",
  sei: "sei-network",
};

async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.chart?.result?.[0]?.meta?.regularMarketPrice || null;
}

async function fetchCgPrice(cgId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.[cgId]?.usd || null;
}

async function valuationForAsset(asset, priceUsd) {
  if (!priceUsd || priceUsd <= 0) return;
  const txs = stmt.transactionsByAsset.all(asset.id);
  const qty = txs.reduce(
    (s, t) => s + (t.type === "buy" ? t.quantity : -t.quantity),
    0,
  );
  if (qty <= 0) return;
  const quoteCurrency = String(asset.currency || "USD").toUpperCase();
  const rate = quoteCurrency === "UAH" ? 1 : currencyRate();
  const valueUah = qty * priceUsd * rate;
  stmt.insertValuation.run({
    id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    asset_id: asset.id,
    date: todayISO(),
    value: Math.round(valueUah * 100) / 100,
    quantity: qty,
    note: `PriceFeed auto (${quoteCurrency} ${priceUsd})`,
  });
}

app.post("/api/investments/refresh-prices", requireAuth, async (req, res) => {
  const assets = stmt.allAssets.all().filter((a) => a.ticker);
  let updated = 0;
  const errors = [];

  for (const asset of assets) {
    try {
      const ticker = asset.ticker.trim().toUpperCase();
      const type = (asset.type || "").toLowerCase();
      let price = null;

      if (type === "crypto") {
        const cgId = CG_MAP[ticker.toLowerCase()];
        if (cgId) price = await fetchCgPrice(cgId);
      } else {
        // stock, etf, bond, other — через Yahoo Finance
        price = await fetchYahooPrice(ticker);
      }

      if (price != null && price > 0) {
        await valuationForAsset(asset, price);
        updated++;
      }
    } catch (e) {
      errors.push(asset.ticker + ": " + e.message);
    }
  }

  if (errors.length) console.error("Price refresh errors:", errors.join("; "));
  const result = getPortfolio();
  result._meta = { updated, errors: errors.length };
  res.json(result);
});

app.get("/api/wallets", requireAuth, (req, res) => {
  res.json({ wallets: getWallets() });
});
app.post("/api/wallets", requireAuth, (req, res) => {
  const wallets = sanitizeEntries(req.body?.wallets, [
    { key: "name", type: "text" },
    { key: "purpose", type: "text" },
    { key: "amount", type: "number" },
  ]);
  const plan = getActivePlan();
  const planId = plan?.id || null;
  const month = monthForPlan(plan);
  const save = db.transaction(() => {
    stmt.deleteWalletsForPlan.run({ planId });
    wallets.forEach((wallet) =>
      stmt.upsertWallet.run({
        id: String(wallet.id || Date.now() + Math.random()),
        planId,
        name: wallet.name || "Кошелёк",
        purpose: wallet.purpose || "",
        amount: wallet.amount,
        month,
      }),
    );
  });
  save();
  res.json({ wallets: getWallets() });
});
app.delete("/api/wallets/:id", requireAuth, (req, res) => {
  const id = String(req.params.id);
  stmt.deleteWalletById.run(id);
  res.json({ ok: true, wallets: getWallets() });
});

app.get("/api/manual-plan", requireAuth, (req, res) => {
  res.json({ manualPlan: getManualPlan() || [] });
});
app.post("/api/manual-plan", requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: "no_active_plan" });
  const manualPlan = sanitizeManualPlan(req.body?.manualPlan);
  const planId = plan.id;
  const items = getActiveItems();
  const activeItemIds = new Set(items.map((item) => item.id));
  const invalid = manualPlan.find((entry) => !activeItemIds.has(entry.itemId));
  if (invalid)
    return res
      .status(400)
      .json({ error: "item_not_found", itemId: invalid.itemId });

  const allocation = allocate(plan, items, { scenario: "balanced" });
  const total = manualPlan.reduce((sum, entry) => sum + entry.amount, 0);
  const availableToAllocate = allocation.totals.availableToAllocate;
  const overBudget = total > availableToAllocate;

  const save = db.transaction(() => {
    stmt.deleteDecisionsForPlan.run({ planId });
    manualPlan.forEach((entry) =>
      stmt.upsertDecision.run({
        planId,
        itemId: entry.itemId,
        amount: entry.amount,
        scenario: req.body?.scenario || "manual",
      }),
    );
  });
  save();
  res.json({
    manualPlan: getManualPlan() || [],
    total,
    availableToAllocate,
    overBudget,
  });
});

function rawInvestmentAssets() {
  return stmt.allAssets.all().map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    ticker: a.ticker,
    currency: a.currency,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  }));
}
function rawAssetTransactions() {
  return stmt.allTransactions.all().map((t) => ({
    id: t.id,
    assetId: t.asset_id,
    type: t.type,
    date: t.date,
    quantity: t.quantity,
    price: t.price,
    fee: t.fee,
    totalAmount: t.total_amount,
    note: t.note,
    createdAt: t.created_at,
  }));
}
function rawAssetValuations() {
  return stmt.allValuations.all().map((v) => ({
    id: v.id,
    assetId: v.asset_id,
    date: v.date,
    value: v.value,
    quantity: v.quantity,
    note: v.note,
    createdAt: v.created_at,
  }));
}

function restoreFullBackup(data) {
  const now = new Date().toISOString();
  db.exec(`
    DELETE FROM allocation_decisions;
    DELETE FROM goal_contributions;
    DELETE FROM goals;
    DELETE FROM wallets;
    DELETE FROM asset_transactions;
    DELETE FROM asset_valuations;
    DELETE FROM investment_updates;
    DELETE FROM investment_accounts;
    DELETE FROM investment_assets;
    DELETE FROM items;
    DELETE FROM plans;
  `);

  const planIds = new Set();
  const itemIds = new Set();
  const assetIds = new Set();

  const insertPlan = db.prepare(`INSERT INTO plans
    (id, name, payday, salary, survival_cost, buffer, investment_fixed, status, snapshot, created_at, closed_at)
    VALUES (@id, @name, @payday, @salary, @survivalCost, @buffer, @investmentFixed, @status, @snapshot, @createdAt, @closedAt)`);
  for (const p of data.plans || []) {
    const id = Number(p.id);
    if (!id) continue;
    const snapshot =
      p.snapshot == null
        ? null
        : typeof p.snapshot === "string"
          ? p.snapshot
          : JSON.stringify(p.snapshot);
    insertPlan.run({
      id,
      name: String(p.name || "Зарплата"),
      payday: p.payday || todayISO(),
      salary: Math.max(0, Number(p.salary) || 0),
      survivalCost: Math.max(0, Number(p.survivalCost ?? p.survival_cost) || 0),
      buffer: Math.max(0, Number(p.buffer) || 0),
      investmentFixed: Math.max(
        0,
        Number(p.investmentFixed ?? p.investment_fixed) || 0,
      ),
      status: ["active", "closed"].includes(p.status) ? p.status : "closed",
      snapshot,
      createdAt: p.createdAt || p.created_at || now,
      closedAt: p.closedAt || p.closed_at || null,
    });
    planIds.add(id);
  }

  const insertItem = db.prepare(`INSERT INTO items
    (id, title, cost, category, bucket, band, score_type, scores, saved_amount, priority, type,
     deadline, earliest_date, can_defer, emotional, trajectory, notes, status, created_at, updated_at)
    VALUES (@id, @title, @cost, @category, @layer, @band, @scoreType, @scores, @savedAmount, @priority, @type,
     @deadline, @earliestDate, @canDefer, @emotional, @trajectory, @notes, @status, @createdAt, @updatedAt)`);
  for (const item of data.items || []) {
    const id = Number(item.id);
    if (!id) continue;
    const normalized = normalizeItemInput(item);
    insertItem.run({
      id,
      ...normalized,
      savedAmount: Math.max(
        0,
        Number(item.savedAmount ?? item.saved_amount) || 0,
      ),
      status: ["active", "bought", "archived"].includes(item.status)
        ? item.status
        : "active",
      createdAt: item.createdAt || item.created_at || now,
      updatedAt:
        item.updatedAt ||
        item.updated_at ||
        item.createdAt ||
        item.created_at ||
        now,
    });
    itemIds.add(id);
  }

  const insertGoal = db.prepare(`INSERT INTO goals
    (id, item_id, target_amount, saved_amount, monthly_contribution, deadline, status, created_at, updated_at)
    VALUES (@id, @itemId, @targetAmount, @savedAmount, @monthlyContribution, @deadline, @status, @createdAt, @updatedAt)`);
  for (const g of data.goals || []) {
    const itemId = Number(g.itemId ?? g.item_id);
    if (!itemIds.has(itemId)) continue;
    insertGoal.run({
      id: Number(g.id) || null,
      itemId,
      targetAmount: Math.max(0, Number(g.targetAmount ?? g.target_amount) || 0),
      savedAmount: Math.max(0, Number(g.savedAmount ?? g.saved_amount) || 0),
      monthlyContribution: Math.max(
        0,
        Number(g.monthlyContribution ?? g.monthly_contribution) || 0,
      ),
      deadline: g.deadline || null,
      status: ["active", "complete", "archived"].includes(g.status)
        ? g.status
        : "active",
      createdAt: g.createdAt || g.created_at || now,
      updatedAt:
        g.updatedAt || g.updated_at || g.createdAt || g.created_at || now,
    });
  }

  for (const w of data.wallets || []) {
    const planId = Number(w.planId ?? w.plan_id) || null;
    stmt.upsertWallet.run({
      id: String(w.id || Date.now() + Math.random()),
      planId: planId && planIds.has(planId) ? planId : null,
      name: String(w.name || "Кошелёк"),
      purpose: String(w.purpose || ""),
      amount: Math.max(0, Number(w.amount) || 0),
      month: w.month || monthForPlan(getActivePlan()),
    });
  }

  const assets = data.investmentAssets || data.portfolio?.assets || [];
  for (const asset of assets) {
    const id = String(asset.id || "").trim();
    if (!id) continue;
    stmt.insertAsset.run({
      id,
      name: String(asset.name || "Актив"),
      type: String(asset.type || "other"),
      ticker: asset.ticker ? String(asset.ticker) : null,
      currency: ["USD", "UAH"].includes(
        String(asset.currency || "USD").toUpperCase(),
      )
        ? String(asset.currency || "USD").toUpperCase()
        : "USD",
    });
    assetIds.add(id);
  }

  const transactions =
    data.assetTransactions || data.portfolio?.transactions || [];
  for (const tx of transactions) {
    const assetId = String((tx.assetId ?? tx.asset_id) || "");
    if (!assetIds.has(assetId)) continue;
    const txType = ["buy", "sell"].includes(tx.type) ? tx.type : "buy";
    const qty = Math.max(0, Number(tx.quantity) || 0);
    const price = Math.max(0, Number(tx.price) || 0);
    const fee = Math.max(0, Number(tx.fee) || 0);
    const totalAmount = Math.max(
      0,
      Number(tx.totalAmount ?? tx.total_amount) ||
        (txType === "buy" ? qty * price + fee : qty * price - fee),
    );
    stmt.insertTransaction.run({
      id: String(
        tx.id || Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      ),
      asset_id: assetId,
      type: txType,
      date: tx.date || todayISO(),
      quantity: qty,
      price,
      fee,
      total_amount: totalAmount,
      note: tx.note ? String(tx.note) : "",
    });
  }

  const valuations = data.assetValuations || data.portfolio?.valuations || [];
  for (const val of valuations) {
    const assetId = String((val.assetId ?? val.asset_id) || "");
    if (!assetIds.has(assetId)) continue;
    stmt.insertValuation.run({
      id: String(
        val.id || Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      ),
      asset_id: assetId,
      date: val.date || todayISO(),
      value: Math.max(0, Number(val.value) || 0),
      quantity:
        val.quantity != null ? Math.max(0, Number(val.quantity) || 0) : null,
      note: val.note ? String(val.note) : "",
    });
  }

  const activePlanId =
    Number((data.plans || []).find((p) => p.status === "active")?.id) || null;
  for (const d of data.allocationDecisions || []) {
    const itemId = Number(d.itemId ?? d.item_id);
    if (!itemIds.has(itemId)) continue;
    const planId = Number(d.planId ?? d.plan_id) || activePlanId;
    stmt.upsertDecision.run({
      planId: planId && planIds.has(planId) ? planId : null,
      itemId,
      amount: Math.max(0, Number(d.amount) || 0),
      scenario: d.scenario || "manual",
    });
  }
}

function exportPayload() {
  return {
    version: 4,
    exportedAt: new Date().toISOString(),
    plans: db.prepare("SELECT * FROM plans ORDER BY id").all().map(rowToPlan),
    items: stmt.allItems.all().map(rowToItem),
    wallets: stmt.allWallets.all().map(rowToWallet),
    goals: stmt.allGoals.all().map(rowToGoal),
    investments: getInvestments(),
    investmentAssets: rawInvestmentAssets(),
    assetTransactions: rawAssetTransactions(),
    assetValuations: rawAssetValuations(),
    portfolio: getPortfolio(),
    allocationDecisions: stmt.allDecisions.all().map(rowToAllocationDecision),
  };
}

app.get("/api/export", requireAuth, (req, res) => {
  res.json(exportPayload());
});

app.post("/api/import", requireAuth, (req, res) => {
  const data = req.body || {};
  const isFullBackup = Array.isArray(data.plans) && Array.isArray(data.items);
  const save = db.transaction(() => {
    if (isFullBackup) {
      restoreFullBackup(data);
      return;
    }

    if (Array.isArray(data.wallets)) {
      stmt.deleteWalletsForPlan.run({ planId: currentPlanId() });
      data.wallets.forEach((w) =>
        stmt.upsertWallet.run({
          id: String(w.id || Date.now() + Math.random()),
          planId: currentPlanId(),
          name: String(w.name || "Кошелёк"),
          purpose: String(w.purpose || ""),
          amount: Math.max(0, Number(w.amount) || 0),
          month: w.month || monthForPlan(getActivePlan()),
        }),
      );
    }
    if (Array.isArray(data.investments)) {
      stmt.deleteInvestmentUpdates.run();
      data.investments.forEach((entry) => {
        const accountName = entry.name || "Инвестиция";
        const accountId = String(
          entry.accountId || accountName.toLowerCase().replace(/\s+/g, "-"),
        );
        stmt.upsertInvestmentAccount.run({
          id: accountId,
          name: accountName,
          type: entry.accountType || "asset",
        });
        stmt.upsertInvestmentUpdate.run({
          id: String(
            entry.id ||
              `${accountId}-${entry.date || todayISO()}-${Date.now()}`,
          ),
          accountId,
          planId: currentPlanId(),
          amount: Math.max(0, Number(entry.amount) || 0),
          date: entry.date || todayISO(),
          note: entry.note || "",
        });
      });
    }
    if (Array.isArray(data.goals)) {
      data.goals.forEach((g) => {
        if (stmt.itemById.get(Number(g.itemId)))
          stmt.upsertGoal.run({
            itemId: Number(g.itemId),
            targetAmount: Math.max(0, Number(g.targetAmount) || 0),
            savedAmount: Math.max(0, Number(g.savedAmount) || 0),
            monthlyContribution: Math.max(
              0,
              Number(g.monthlyContribution) || 0,
            ),
            deadline: g.deadline || null,
            status: g.status || "active",
          });
      });
    }
  });
  save();
  res.json({ ok: true, mode: isFullBackup ? "full" : "partial" });
});

const BACKUP_DIR =
  process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), "backups");
const BACKUP_INTERVAL_HOURS = Math.max(
  1,
  Number(process.env.BACKUP_INTERVAL_HOURS) || 24,
);
const BACKUP_RETENTION = Math.max(
  1,
  Number(process.env.BACKUP_RETENTION) || 14,
);
let backupsScheduled = false;

function backupFileName(reason = "scheduled") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeReason =
    String(reason)
      .replace(/[^a-z0-9_-]/gi, "-")
      .slice(0, 32) || "backup";
  return `capital-queue-${safeReason}-${stamp}.json`;
}
async function listBackupFiles() {
  try {
    const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const fullPath = path.join(BACKUP_DIR, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
          };
        }),
    );
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function pruneBackups() {
  const files = await listBackupFiles();
  await Promise.all(
    files
      .slice(BACKUP_RETENTION)
      .map((file) => fs.unlink(file.path).catch(() => {})),
  );
}
async function writeBackup(reason = "scheduled") {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const payload = exportPayload();
  const filePath = path.join(BACKUP_DIR, backupFileName(reason));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  await pruneBackups();
  return {
    file: path.basename(filePath),
    path: filePath,
    exportedAt: payload.exportedAt,
  };
}
function scheduleBackups() {
  if (
    backupsScheduled ||
    process.env.NODE_ENV === "test" ||
    process.env.BACKUP_ENABLED === "false"
  )
    return;
  backupsScheduled = true;
  setTimeout(
    () =>
      writeBackup("startup").catch((error) =>
        console.error("Backup failed:", error.message),
      ),
    30_000,
  ).unref?.();
  setInterval(
    () =>
      writeBackup("scheduled").catch((error) =>
        console.error("Backup failed:", error.message),
      ),
    BACKUP_INTERVAL_HOURS * 60 * 60 * 1000,
  ).unref?.();
}

app.get("/api/backups", requireAuth, async (req, res) => {
  try {
    const files = await listBackupFiles();
    res.json({
      backupDir: BACKUP_DIR,
      retention: BACKUP_RETENTION,
      backups: files.map(({ path: _path, ...file }) => file),
    });
  } catch (error) {
    res.status(500).json({
      error: "backup_list_failed",
      detail: String(error.message || error),
    });
  }
});
app.post("/api/backups/run", requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, backup: await writeBackup("manual") });
  } catch (error) {
    res
      .status(500)
      .json({ error: "backup_failed", detail: String(error.message || error) });
  }
});

app.get("/api/tradeoff/:id", requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: "no_active_plan" });
  const scenario = req.query.scenario || "balanced";
  const t = tradeoff(Number(req.params.id), plan, getActiveItems(), {
    scenario,
    includeIds: scenario === "custom" ? customIds() : null,
  });
  if (!t) return res.status(404).json({ error: "not_found" });
  res.json(t);
});

// ================= HISTORY =================
app.get("/api/history", requireAuth, (req, res) => {
  res.json({ history: stmt.closedPlans.all().map(rowToPlan) });
});

// ================= AGGREGATE STATE =================
// Лёгкий эндпоинт для синхронизации между вкладками/устройствами.
app.get("/api/version", requireAuth, (req, res) =>
  res.json({ version: dataVersion }),
);

app.get("/api/state", requireAuth, (req, res) => {
  const plan = getActivePlan();
  const items = getActiveItems();
  const scenario = req.query.scenario || "balanced";
  const allocation = plan
    ? allocate(plan, items, {
        scenario,
        includeIds: scenario === "custom" ? customIds() : null,
      })
    : null;
  res.json({
    plan,
    items,
    allocation,
    history: stmt.closedPlans.all().map(rowToPlan),
    meta: metaPayload(),
    investments: getInvestments(),
    portfolio: getPortfolio(),
    wallets: getWallets(),
    manualPlan: getManualPlan() || [],
    goals: getGoals(),
    currencyRate: currencyRate(),
  });
});

// ================= CSV EXPORT =================
function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
function csvLine(values) {
  return values.map(csvCell).join(",");
}

app.get("/api/export/csv/:type", requireAuth, (req, res) => {
  const type = req.params.type;
  let headers;
  let rows;
  if (type === "items") {
    headers = [
      "id",
      "title",
      "cost",
      "category",
      "layer",
      "band",
      "priority",
      "type",
      "status",
      "deadline",
    ];
    rows = stmt.allItems
      .all()
      .map((r) =>
        csvLine([
          r.id,
          r.title,
          r.cost,
          r.category,
          r.bucket,
          r.band,
          r.priority,
          r.type,
          r.status,
          r.deadline || "",
        ]),
      );
  } else if (type === "transactions") {
    headers = [
      "id",
      "asset_id",
      "type",
      "date",
      "quantity",
      "price",
      "fee",
      "total_amount",
      "note",
    ];
    rows = stmt.allTransactions
      .all()
      .map((r) =>
        csvLine([
          r.id,
          r.asset_id,
          r.type,
          r.date,
          r.quantity,
          r.price,
          r.fee,
          r.total_amount,
          r.note || "",
        ]),
      );
  } else if (type === "valuations") {
    headers = ["id", "asset_id", "date", "value", "quantity", "note"];
    rows = stmt.allValuations
      .all()
      .map((r) =>
        csvLine([
          r.id,
          r.asset_id,
          r.date,
          r.value,
          r.quantity || "",
          r.note || "",
        ]),
      );
  } else return res.status(400).json({ error: "unknown_type" });

  const csv = "\uFEFF" + csvLine(headers) + "\n" + rows.join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${type}-${todayISO()}.csv"`,
  );
  res.send(csv);
});

// ================= AI =================
app.get("/api/ai/status", requireAuth, (req, res) => res.json(aiStatus()));

app.post("/api/ai/explain", requireAuth, async (req, res) => {
  try {
    const item = stmt.itemById.get(Number(req.body?.itemId));
    if (!item) return res.status(404).json({ error: "not_found" });
    const cleanItem = rowToItem(item);
    const verdict = scoreVerdict(cleanItem);
    const context = {
      ...buildAIContext(req.body?.scenario || "balanced"),
      item: cleanItem,
      verdict,
    };
    const out = await askAssistantText(
      `Объясни кратко вердикт для желания "${cleanItem.title}" и что с ним делать.`,
      context,
    );
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "ai_failed", detail: String(e.message || e) });
  }
});

app.post("/api/ai/chat", requireAuth, async (req, res) => {
  try {
    const messages = sanitizeMessages(req.body?.messages);
    const context = buildAIContext("balanced");
    const out = await askAssistant(messages, context);
    res.json(out);
  } catch (e) {
    res
      .status(500)
      .json({ error: "ai_failed", detail: String(e.message || e) });
  }
});

app.post("/api/ai/chat/stream", requireAuth, async (req, res) => {
  try {
    const messages = sanitizeMessages(req.body?.messages);
    const out = await askAssistant(messages, buildAIContext("balanced"));
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    for (const word of String(out.reply || "").split(/(\s+)/)) res.write(word);
    res.end();
  } catch (e) {
    res.status(500).end(`Ошибка ассистента: ${String(e.message || e)}`);
  }
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

export function startServer(port = process.env.PORT || 3000) {
  scheduleBackups();
  return app.listen(port, () =>
    console.log(`Salary Allocation Planner на http://localhost:${port}`),
  );
}

if (process.env.NODE_ENV !== "test" && process.env.NO_LISTEN !== "1") {
  startServer();
}
