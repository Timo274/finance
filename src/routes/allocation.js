// Распределение: сценарии, custom-набор, trade-off анализ, what-if симулятор.
import { setJSON } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  getActivePlan,
  getActiveItems,
  getManualPlan,
  effectiveAllocation,
  customIds,
} from "../store.js";
import {
  allocate,
  allocationFromManualPlan,
  amountToFund,
  tradeoff,
  scenarioSummaries,
} from "../allocation.js";
import { positiveNumber } from "../sanitize.js";

export default function registerAllocationRoutes(app) {
  app.get("/api/allocation", requireAuth, (req, res) => {
    const plan = getActivePlan();
    if (!plan) return res.json({ plan: null, allocation: null });
    const scenario = req.query.scenario || "balanced";
    const allocation = effectiveAllocation(plan, getActiveItems(), scenario);
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
    const ids = Array.isArray(req.body?.includeIds) ? req.body.includeIds.map(Number) : [];
    setJSON("custom_include", ids);
    res.json({ includeIds: ids });
  });

  app.get("/api/tradeoff/:id", requireAuth, (req, res) => {
    const plan = getActivePlan();
    if (!plan) return res.status(400).json({ error: "no_active_plan" });
    const scenario = req.query.scenario || "balanced";
    const items = getActiveItems();
    const targetId = Number(req.params.id);
    const manualPlan = getManualPlan() || [];

    if (scenario === "balanced" && manualPlan.length > 0) {
      const result = allocationFromManualPlan(plan, items, manualPlan, { scenario });
      const target = items.find((item) => Number(item.id) === targetId);
      if (!target) return res.status(404).json({ error: "not_found" });
      const approvedEntry = result.approved.find((a) => Number(a.item.id) === targetId);
      const targetAmount = amountToFund(target);
      if (approvedEntry) {
        const freed = Number(approvedEntry.allocatedAmount) || 0;
        return res.json({
          itemId: targetId,
          approved: true,
          remainingIfKept: result.totals.remaining,
          freedIfRemoved: freed,
          remainingIfRemoved: result.totals.remaining + freed,
        });
      }
      let need = Math.max(0, targetAmount - result.totals.remaining);
      const displaces = [];
      const removable = [...result.approved].sort(
        (a, b) => (a.item.priority || 1) - (b.item.priority || 1),
      );
      for (const a of removable) {
        if (need <= 0) break;
        displaces.push(a.item);
        need -= Number(a.allocatedAmount) || amountToFund(a.item);
      }
      return res.json({
        itemId: targetId,
        approved: false,
        remainingIfAdded: result.totals.remaining - targetAmount,
        belowBuffer: result.totals.remaining - targetAmount < 0,
        belowReserve: result.totals.remaining - targetAmount < 0,
        displaces,
      });
    }

    const t = tradeoff(targetId, plan, items, {
      scenario,
      includeIds: scenario === "custom" ? customIds() : null,
    });
    if (!t) return res.status(404).json({ error: "not_found" });
    res.json(t);
  });

  // ================= WHAT-IF СИМУЛЯТОР =================
  // Виртуальное распределение с переопределёнными параметрами плана — ничего не сохраняет.
  app.get("/api/allocation/simulate", requireAuth, (req, res) => {
    const plan = getActivePlan();
    if (!plan) return res.status(400).json({ error: "no_active_plan" });
    const overrides = {};
    for (const key of ["salary", "survivalCost", "buffer", "investmentFixed"]) {
      if (req.query[key] != null) overrides[key] = positiveNumber(req.query[key]);
    }
    const simPlan = { ...plan, ...overrides };
    const scenario = req.query.scenario || "balanced";
    const allocation = allocate(simPlan, getActiveItems(), {
      scenario,
      includeIds: scenario === "custom" ? customIds() : null,
    });
    res.json({ plan: simPlan, overrides, allocation });
  });
}
