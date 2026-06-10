// Доступ к данным и сборка агрегатов поверх prepared statements.
import db, {
  getJSON,
  getSetting,
  setSetting,
  rowToItem,
  rowToPlan,
  rowToWallet,
  rowToGoal,
  rowToGoalContribution,
  rowToInvestmentUpdate,
  rowToAllocationDecision,
  rateForCurrency,
} from "./db.js";
import { stmt, DEFAULTS, SETTINGS } from "./statements.js";
import {
  CATEGORIES,
  LAYERS,
  TYPES,
  BANDS,
  SCORE_TYPES,
  SCORE_CRITERIA,
  layerForCategory,
  bandForCost,
} from "./categories.js";
import {
  allocate,
  allocationFromManualPlan,
  SCENARIOS,
} from "./allocation.js";
import { aiStatus } from "./ai.js";
import { monobankEnabled } from "./monobank.js";
import { offsiteEnabled } from "./offsite.js";
import { getVapidKeys } from "./webpush.js";
import {
  textValue,
  positiveNumber,
  boundedInteger,
  oneOf,
  isoDateValue,
} from "./sanitize.js";

export function getActivePlan() {
  return rowToPlan(stmt.activePlan.get());
}
export function getActiveItems() {
  return stmt.activeItems.all().map(rowToItem);
}
export function currentPlanId() {
  return getActivePlan()?.id || null;
}
// Маркер «таблица уже жила»: после первых строк в SQL легаси-JSON больше не читаем,
// иначе удалённые пользователем данные «воскресают» из старых настроек.
function legacyDone(key) {
  return getSetting(`legacy_migrated_${key}`) === "1";
}
function markLegacyDone(key) {
  if (!legacyDone(key)) setSetting(`legacy_migrated_${key}`, "1");
}

export function getInvestments() {
  const rows = stmt.investmentUpdates.all().map(rowToInvestmentUpdate);
  if (rows.length) {
    markLegacyDone("investments");
    return rows;
  }
  if (legacyDone("investments")) return [];
  return getJSON(SETTINGS.investments, []);
}
export function getPortfolio() {
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
    // Цена транзакции вводится в валюте актива; себестоимость и P&L считаем в грн,
    // иначе USD-базис сравнивается с UAH-оценкой и P&L превращается в мусор.
    const fxRate = rateForCurrency(String(a.currency || "UAH").toUpperCase());

    for (const tx of txs) {
      const qty = Math.max(0, Number(tx.quantity) || 0);
      const fee = Math.max(0, Number(tx.fee) || 0);
      const gross = qty * Math.max(0, Number(tx.price) || 0);
      const storedTotal = Math.max(0, Number(tx.total_amount) || 0);

      if (tx.type === "buy") {
        const buyCost = (storedTotal > 0 ? storedTotal : gross + fee) * fxRate;
        quantityHeld += qty;
        costBasis += buyCost;
      } else if (tx.type === "sell") {
        const sellQty = Math.min(qty, quantityHeld);
        if (sellQty <= 0) continue;
        const sellTotal =
          (storedTotal > 0 ? storedTotal : Math.max(0, gross - fee)) * fxRate;
        const sellProceeds = qty > 0 ? sellTotal * (sellQty / qty) : 0;
        const avgCost = quantityHeld > 0 ? costBasis / quantityHeld : 0;
        const soldBasis = avgCost * sellQty;
        realizedPnL += sellProceeds - soldBasis;
        quantityHeld -= sellQty;
        costBasis -= soldBasis;
      }
    }

    quantityHeld = Math.max(0, quantityHeld);
    costBasis = Math.max(0, costBasis);

    // Проданный в ноль актив не должен «висеть» в net worth со старой оценкой.
    const latestVal = vals.length > 0 ? vals[0] : null;
    const currentValue =
      quantityHeld <= 0
        ? 0
        : latestVal
          ? Number(latestVal.value) || 0
          : costBasis;
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
export function getWallets() {
  const plan = getActivePlan();
  const rows = stmt.walletsByPlan
    .all({ planId: plan?.id || null })
    .map(rowToWallet);
  if (rows.length) {
    markLegacyDone("wallets");
    return rows;
  }
  if (legacyDone("wallets")) return [];
  return getJSON(SETTINGS.monthlyWallets, []);
}
export function getManualPlan() {
  const rows = stmt.decisionsByPlan
    .all({ planId: currentPlanId() })
    .map(rowToAllocationDecision);
  if (rows.length) {
    markLegacyDone("manual_plan");
    return rows.map(({ itemId, amount }) => ({ itemId, amount }));
  }
  if (legacyDone("manual_plan")) return null;
  return getJSON(SETTINGS.manualPlan, null);
}
export function getGoals() {
  return stmt.goalsByItems.all().map(rowToGoal);
}
export function effectiveAllocation(plan, items, scenario = "balanced") {
  if (!plan) return null;
  const options = {
    scenario,
    includeIds: scenario === "custom" ? customIds() : null,
  };
  const manualPlan = getManualPlan() || [];
  if (scenario === "balanced" && manualPlan.length > 0) {
    return allocationFromManualPlan(plan, items, manualPlan, options);
  }
  return allocate(plan, items, options);
}

export function buildAIContext(scenario = "balanced") {
  const plan = getActivePlan();
  const items = getActiveItems();
  const allocation = effectiveAllocation(plan, items, scenario);
  const portfolio = getPortfolio();
  return {
    plan,
    allocation: allocation && {
      totals: allocation.totals,
      approved: allocation.approved.map((a) => ({
        title: a.item.title,
        cost: a.item.cost,
        allocatedAmount: a.allocatedAmount,
        remainingCost: a.remainingCost,
        manual: !!a.manual,
      })),
      deferred: allocation.deferred.map((d) => ({
        title: d.item.title,
        cost: d.item.cost,
        remainingCost: d.remainingCost,
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

export const VALID_CATEGORIES = new Set(CATEGORIES.map((c) => c.id));
export const VALID_LAYERS = new Set(Object.keys(LAYERS));

export function normalizeItemInput(b) {
  const category = VALID_CATEGORIES.has(b.category) ? b.category : "lifestyle";
  // Слой по умолчанию берётся из категории, но пользователь может переопределить.
  const layer = VALID_LAYERS.has(b.layer)
    ? b.layer
    : layerForCategory(category);
  // Мультивалютность: канонический cost всегда в грн. Для USD/EUR храним
  // оригинальную сумму (costOriginal) и пересчитываем по текущему курсу.
  const currency = oneOf(
    String(b.currency || "UAH").toUpperCase(),
    ["UAH", "USD", "EUR"],
    "UAH",
  );
  const costOriginal =
    currency === "UAH" ? null : positiveNumber(b.costOriginal ?? b.cost);
  const cost =
    currency === "UAH"
      ? positiveNumber(b.cost)
      : Math.round(costOriginal * rateForCurrency(currency) * 100) / 100;
  const band = bandForCost(cost);
  let url = null;
  if (b.url) {
    const raw = textValue(b.url, "", 1000);
    if (/^https?:\/\//i.test(raw)) url = raw;
  }
  const scoreType = oneOf(b.scoreType, ["none", "quick", "full"], "none");
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
    title: textValue(b.title, "Без названия", 160),
    cost,
    category,
    layer,
    band,
    scoreType,
    scores,
    priority: boundedInteger(b.priority, 1, 5, 3),
    type: oneOf(b.type, ["must", "should", "nice"], "should"),
    deadline: isoDateValue(b.deadline),
    earliestDate: isoDateValue(b.earliestDate),
    canDefer: b.canDefer === false || b.canDefer === 0 ? 0 : 1,
    emotional: boundedInteger(b.emotional, 1, 5, 3),
    trajectory: boundedInteger(b.trajectory, 1, 5, 3),
    notes: b.notes ? textValue(b.notes, "", 2000) : null,
    recurring: b.recurring === true || b.recurring === 1 ? 1 : 0,
    url,
    currency,
    costOriginal,
  };
}


export function recomputeForeignCurrencyCosts() {
  const rows = stmt.nonUahItems.all();
  const update = db.transaction(() => {
    for (const row of rows) {
      const original = Number(row.cost_original) || 0;
      if (original <= 0) continue;
      const cost =
        Math.round(original * rateForCurrency(row.currency) * 100) / 100;
      stmt.updateItemCostBand.run({ id: row.id, cost, band: bandForCost(cost) });
      // Цель накопления привязана к цене — пересчитываем target вместе с курсом.
      const goal = stmt.goalByItem.get(row.id);
      if (goal) {
        stmt.upsertGoal.run({
          itemId: row.id,
          targetAmount: cost,
          savedAmount: Number(goal.saved_amount) || 0,
          monthlyContribution: Number(goal.monthly_contribution) || 0,
          deadline: goal.deadline || null,
          status: (Number(goal.saved_amount) || 0) >= cost ? "complete" : "active",
        });
      }
    }
  });
  update();
  return rows.length;
}


export function customIds() {
  return getJSON("custom_include", null);
}


export function rawInvestmentAssets() {
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
export function rawAssetTransactions() {
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
export function rawAssetValuations() {
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


export function goalContributionsWithItems() {
  const goals = stmt.allGoals.all();
  const goalItem = new Map(goals.map((g) => [g.id, g.item_id]));
  return stmt.allGoalContributions.all().map((row) => ({
    ...rowToGoalContribution(row),
    itemId: goalItem.get(row.goal_id) || null,
  }));
}

export function exportPayload() {
  return {
    version: 5,
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
    goalContributions: goalContributionsWithItems(),
  };
}


export function metaPayload() {
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
    monobank: { enabled: monobankEnabled() },
    offsiteBackup: { enabled: offsiteEnabled() },
    push: { enabled: true, publicKey: getVapidKeys().publicKey },
  };
}

