// Валидация и восстановление JSON-бэкапов (полный и частичный режимы).
import db from "./db.js";
import { stmt } from "./statements.js";
import {
  normalizeItemInput,
  getActivePlan,
} from "./store.js";
import { todayISO, monthForPlan, isoDateValue } from "./sanitize.js";

function addUniqueId(errors, seen, value, label) {
  const id = Number(value);
  if (!id) {
    errors.push(`${label}: missing or invalid id`);
    return null;
  }
  if (seen.has(id)) errors.push(`${label}: duplicate id ${id}`);
  seen.add(id);
  return id;
}
export function validateFullBackup(data) {
  const errors = [];
  if (!Array.isArray(data?.plans)) errors.push("plans must be an array");
  if (!Array.isArray(data?.items)) errors.push("items must be an array");
  if (errors.length) return { ok: false, mode: "full", errors };

  const planIds = new Set();
  const itemIds = new Set();
  const assetIds = new Set();
  for (const [idx, plan] of data.plans.entries()) {
    addUniqueId(errors, planIds, plan.id, `plans[${idx}]`);
    if (plan.payday && !isoDateValue(plan.payday))
      errors.push(`plans[${idx}]: invalid payday`);
  }
  for (const [idx, item] of data.items.entries()) {
    addUniqueId(errors, itemIds, item.id, `items[${idx}]`);
    if (item.deadline && !isoDateValue(item.deadline))
      errors.push(`items[${idx}]: invalid deadline`);
    if (
      (item.earliestDate || item.earliest_date) &&
      !isoDateValue(item.earliestDate ?? item.earliest_date)
    )
      errors.push(`items[${idx}]: invalid earliestDate`);
  }
  const goals = Array.isArray(data.goals) ? data.goals : [];
  for (const [idx, goal] of goals.entries()) {
    const itemId = Number(goal.itemId ?? goal.item_id);
    if (!itemIds.has(itemId))
      errors.push(`goals[${idx}]: item ${itemId || "?"} not found`);
  }
  const wallets = Array.isArray(data.wallets) ? data.wallets : [];
  for (const [idx, wallet] of wallets.entries()) {
    const planId = Number(wallet.planId ?? wallet.plan_id) || null;
    if (planId && !planIds.has(planId))
      errors.push(`wallets[${idx}]: plan ${planId} not found`);
  }
  const assets = data.investmentAssets || data.portfolio?.assets || [];
  if (assets && !Array.isArray(assets))
    errors.push("investmentAssets must be an array");
  for (const [idx, asset] of (Array.isArray(assets) ? assets : []).entries()) {
    const id = String(asset.id || "").trim();
    if (!id) errors.push(`investmentAssets[${idx}]: missing id`);
    else if (assetIds.has(id))
      errors.push(`investmentAssets[${idx}]: duplicate id ${id}`);
    else assetIds.add(id);
  }
  const transactions =
    data.assetTransactions || data.portfolio?.transactions || [];
  if (transactions && !Array.isArray(transactions))
    errors.push("assetTransactions must be an array");
  for (const [idx, tx] of (Array.isArray(transactions)
    ? transactions
    : []
  ).entries()) {
    const assetId = String((tx.assetId ?? tx.asset_id) || "");
    if (!assetIds.has(assetId))
      errors.push(
        `assetTransactions[${idx}]: asset ${assetId || "?"} not found`,
      );
  }
  const valuations = data.assetValuations || data.portfolio?.valuations || [];
  if (valuations && !Array.isArray(valuations))
    errors.push("assetValuations must be an array");
  for (const [idx, val] of (Array.isArray(valuations)
    ? valuations
    : []
  ).entries()) {
    const assetId = String((val.assetId ?? val.asset_id) || "");
    if (!assetIds.has(assetId))
      errors.push(`assetValuations[${idx}]: asset ${assetId || "?"} not found`);
  }
  const decisions = Array.isArray(data.allocationDecisions)
    ? data.allocationDecisions
    : [];
  for (const [idx, decision] of decisions.entries()) {
    const itemId = Number(decision.itemId ?? decision.item_id);
    const planId = Number(decision.planId ?? decision.plan_id) || null;
    if (!itemIds.has(itemId))
      errors.push(
        `allocationDecisions[${idx}]: item ${itemId || "?"} not found`,
      );
    if (planId && !planIds.has(planId))
      errors.push(`allocationDecisions[${idx}]: plan ${planId} not found`);
  }

  return { ok: errors.length === 0, mode: "full", errors };
}
export function validateImportData(data) {
  const isFullBackup = Array.isArray(data?.plans) && Array.isArray(data?.items);
  if (isFullBackup) return validateFullBackup(data);
  return { ok: true, mode: "partial", errors: [] };
}


export function restoreFullBackup(data) {
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

  // Взносы в цели: восстанавливаем по goal_id (id целей сохраняются) либо
  // по itemId, если в бэкапе он указан.
  const goalIdExists = db.prepare("SELECT id FROM goals WHERE id = ?");
  const goalByItemId = db.prepare("SELECT id FROM goals WHERE item_id = ?");
  for (const c of data.goalContributions || []) {
    let goalId = Number(c.goalId ?? c.goal_id) || null;
    if (goalId && !goalIdExists.get(goalId)) goalId = null;
    if (!goalId) {
      const itemId = Number(c.itemId ?? c.item_id);
      if (itemId) goalId = goalByItemId.get(itemId)?.id || null;
    }
    if (!goalId) continue;
    const planId = Number(c.planId ?? c.plan_id) || null;
    stmt.insertGoalContributionFull.run({
      id: Number(c.id) || null,
      goalId,
      planId: planId && planIds.has(planId) ? planId : null,
      amount: Math.max(0, Number(c.amount) || 0),
      date: c.date || todayISO(),
      note: c.note ? String(c.note) : "",
      createdAt: c.createdAt || c.created_at || now,
    });
  }

  const activePlanId =
    Number((data.plans || []).find((p) => p.status === "active")?.id) || null;
  // Дедупликация решений: UNIQUE(plan_id,item_id,source) не ловит NULL plan_id
  // (в SQLite NULL != NULL), поэтому дедупим в JS — последняя запись побеждает.
  const decisionByKey = new Map();
  for (const d of data.allocationDecisions || []) {
    const itemId = Number(d.itemId ?? d.item_id);
    if (!itemIds.has(itemId)) continue;
    const rawPlanId = Number(d.planId ?? d.plan_id) || activePlanId;
    const planId = rawPlanId && planIds.has(rawPlanId) ? rawPlanId : null;
    decisionByKey.set(`${planId}|${itemId}`, {
      planId,
      itemId,
      amount: Math.max(0, Number(d.amount) || 0),
      scenario: d.scenario || "manual",
    });
  }
  for (const decision of decisionByKey.values()) {
    stmt.upsertDecision.run(decision);
  }
}

