// План зарплаты: создание/обновление, закрытие месяца, курсы валют.
import db, {
  rowToPlan,
  currencyRate,
  setCurrencyRate,
  eurRate,
  setEurRate,
} from "../db.js";
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import {
  getActivePlan,
  getActiveItems,
  getManualPlan,
  customIds,
  recomputeForeignCurrencyCosts,
} from "../store.js";
import { allocate, allocationFromManualPlan } from "../allocation.js";
import {
  textValue,
  positiveNumber,
  isoDateValue,
  todayISO,
} from "../sanitize.js";

export default function registerPlanRoutes(app) {
app.get("/api/plan", requireAuth, (req, res) => {
  res.json({ plan: getActivePlan() });
});

app.post("/api/plan", requireAuth, (req, res) => {
  const b = req.body || {};
  const payload = {
    name: textValue(b.name, "Зарплата", 120),
    payday: isoDateValue(b.payday, todayISO()),
    salary: positiveNumber(b.salary),
    survivalCost: positiveNumber(b.survivalCost),
    buffer: positiveNumber(b.buffer),
    investmentFixed: positiveNumber(b.investmentFixed),
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
  const scenario = req.body?.scenario || "balanced";
  const manualPlan = getManualPlan() || [];
  const useManual = scenario === "balanced" && manualPlan.length > 0;
  const allocOptions = {
    scenario,
    includeIds: scenario === "custom" ? customIds() : null,
  };
  const result = useManual
    ? allocationFromManualPlan(plan, items, manualPlan, allocOptions)
    : allocate(plan, items, allocOptions);

  const snapshot = {
    closedScenario: result.scenario,
    source: useManual ? "manual" : "auto",
    totals: result.totals,
    buckets: result.buckets,
    approved: result.approved.map((a) => ({
      title: a.item.title,
      cost: a.item.cost,
      allocatedAmount: a.allocatedAmount,
      remainingCost: a.remainingCost,
      layer: a.item.layer,
      purchased: a.fullyFunded !== false,
    })),
    deferred: result.deferred.map((d) => ({
      title: d.item.title,
      cost: d.item.cost,
      remainingCost: d.remainingCost,
      reason: d.reason,
    })),
  };

  // Чек-лист закрытия: фронт может передать purchases=[{itemId, purchased}],
  // чтобы подтвердить, что реально куплено. Без purchases — прежнее поведение
  // (auto → всё approved куплено, manual → куплено только полностью накопленное).
  const purchasesRaw = Array.isArray(req.body?.purchases)
    ? req.body.purchases
    : null;
  const purchasedById = purchasesRaw
    ? new Map(
        purchasesRaw
          .map((p) => [Number(p?.itemId), p?.purchased === true])
          .filter(([id]) => Number.isFinite(id) && id > 0),
      )
    : null;
  const isPurchased = (entry) => {
    if (purchasedById) return purchasedById.get(Number(entry.item.id)) === true;
    return entry.fullyFunded !== false;
  };

  snapshot.approved = result.approved.map((a) => ({
    title: a.item.title,
    cost: a.item.cost,
    allocatedAmount: a.allocatedAmount,
    remainingCost: a.remainingCost,
    layer: a.item.layer,
    purchased: isPurchased(a),
    recurring: !!a.item.recurring,
  }));

  const recordContribution = (item, contribution, savedAmount, note) => {
    const cost = positiveNumber(item.cost);
    const existingGoal = stmt.goalByItem.get(item.id);
    stmt.upsertGoal.run({
      itemId: item.id,
      targetAmount: cost,
      savedAmount,
      monthlyContribution: Math.max(
        0,
        Number(existingGoal?.monthly_contribution) || 0,
      ),
      deadline: existingGoal?.deadline || item.deadline || null,
      status: savedAmount >= cost ? "complete" : "active",
    });
    const goal = stmt.goalByItem.get(item.id);
    if (goal) {
      stmt.insertGoalContribution.run({
        goalId: goal.id,
        planId: plan.id,
        amount: contribution,
        date: todayISO(),
        note,
      });
    }
  };

  const close = db.transaction(() => {
    stmt.closePlan.run({ id: plan.id, snapshot: JSON.stringify(snapshot) });

    for (const entry of result.approved) {
      const item = entry.item;
      const cost = positiveNumber(item.cost);
      const purchased = isPurchased(entry);

      if (purchased) {
        if (item.recurring) {
          // Регулярное желание: после покупки возвращается в очередь с нуля.
          stmt.updateItemSavings.run({ id: item.id, savedAmount: 0 });
          stmt.deleteGoalByItem.run(item.id);
          stmt.setItemStatus.run({ id: item.id, status: "active" });
        } else {
          stmt.setItemStatus.run({ id: item.id, status: "bought" });
        }
        continue;
      }

      // Не куплено: выделенные деньги превращаются в накопление.
      const savedBefore = positiveNumber(item.savedAmount);
      const contribution = Math.max(0, Number(entry.allocatedAmount) || 0);
      const savedAmount = Math.min(cost, savedBefore + contribution);
      stmt.updateItemSavings.run({ id: item.id, savedAmount });
      if (contribution > 0) {
        recordContribution(
          item,
          contribution,
          savedAmount,
          useManual
            ? "Закрытие месяца по ручному плану"
            : "Закрытие месяца (не куплено — в накопление)",
        );
      }
    }
  });
  close();

  res.json({ ok: true, snapshot });
});

// Превью закрытия месяца — данные для чек-листа на фронте.
app.get("/api/plan/close-preview", requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: "no_active_plan" });
  const items = getActiveItems();
  const scenario = req.query.scenario || "balanced";
  const manualPlan = getManualPlan() || [];
  const useManual = scenario === "balanced" && manualPlan.length > 0;
  const allocOptions = {
    scenario,
    includeIds: scenario === "custom" ? customIds() : null,
  };
  const result = useManual
    ? allocationFromManualPlan(plan, items, manualPlan, allocOptions)
    : allocate(plan, items, allocOptions);
  res.json({
    source: useManual ? "manual" : "auto",
    totals: result.totals,
    approved: result.approved.map((a) => ({
      itemId: a.item.id,
      title: a.item.title,
      cost: a.item.cost,
      allocatedAmount: a.allocatedAmount,
      savedAmount: a.item.savedAmount || 0,
      recurring: !!a.item.recurring,
      fullyFunded: a.fullyFunded !== false,
    })),
    deferredCount: result.deferred.length,
  });
});

// ================= CURRENCY =================
app.get("/api/currency", requireAuth, (req, res) => {
  res.json({ rate: currencyRate(), eurRate: eurRate() });
});
app.post("/api/currency", requireAuth, (req, res) => {
  if (req.body?.rate != null) {
    setCurrencyRate(Math.max(1, positiveNumber(req.body.rate, 43.5)));
  }
  if (req.body?.eurRate != null) {
    setEurRate(Math.max(1, positiveNumber(req.body.eurRate, 47)));
  }
  // Курс изменился — пересчитываем гривневую стоимость валютных желаний.
  const recalculated = recomputeForeignCurrencyCosts();
  res.json({ rate: currencyRate(), eurRate: eurRate(), recalculated });
});
}
