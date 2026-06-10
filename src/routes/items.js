// Очередь желаний: CRUD, накопления, взносы, цели, проверка цены по ссылке.
import { rowToItem, rowToGoal, rowToGoalContribution } from "../db.js";
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import { aiRateLimit } from "../middleware.js";
import { checkPrice } from "../pricecheck.js";
import {
  normalizeItemInput,
  currentPlanId,
  getGoals,
} from "../store.js";
import {
  textValue,
  positiveNumber,
  isoDateValue,
  oneOf,
  todayISO,
} from "../sanitize.js";

export default function registerItemRoutes(app) {
app.get("/api/items", requireAuth, (req, res) => {
  const rows = req.query.all ? stmt.allItems.all() : stmt.activeItems.all();
  res.json({ items: rows.map(rowToItem) });
});

const MAX_ITEM_COST = 100_000_000;
function costError(payload) {
  if (!(payload.cost > 0)) return "cost_must_be_positive";
  if (payload.cost > MAX_ITEM_COST) return "cost_too_large";
  return null;
}

app.post("/api/items", requireAuth, (req, res) => {
  const payload = normalizeItemInput(req.body || {});
  const err = costError(payload);
  if (err) return res.status(400).json({ error: err });
  const info = stmt.insertItem.run(payload);
  res.json({ item: rowToItem(stmt.itemById.get(info.lastInsertRowid)) });
});

app.put("/api/items/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!stmt.itemById.get(id))
    return res.status(404).json({ error: "not_found" });
  const payload = normalizeItemInput(req.body || {});
  const err = costError(payload);
  if (err) return res.status(400).json({ error: err });
  stmt.updateItem.run({ ...payload, id });
  // Цена изменилась — цель накопления должна указывать на новую цену.
  const goal = stmt.goalByItem.get(id);
  if (goal && Number(goal.target_amount) !== payload.cost) {
    stmt.upsertGoal.run({
      itemId: id,
      targetAmount: payload.cost,
      savedAmount: Number(goal.saved_amount) || 0,
      monthlyContribution: Number(goal.monthly_contribution) || 0,
      deadline: goal.deadline || null,
      status:
        (Number(goal.saved_amount) || 0) >= payload.cost ? "complete" : "active",
    });
  }
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
  const cost = positiveNumber(item.cost);
  const currentSaved = positiveNumber(item.saved_amount);
  const contribution = positiveNumber(req.body?.contributionAmount);
  // savedAmount задаёт абсолют только если поле передано явно; иначе взнос
  // прибавляется к текущему. Вызов без полей НЕ обнуляет накопления.
  const requested =
    req.body?.savedAmount != null
      ? positiveNumber(req.body.savedAmount)
      : currentSaved + contribution;
  // Валидация: накопление не может быть отрицательным или абсурдно больше цели.
  const savedAmount = Math.min(requested, Math.max(cost * 2, cost + 1_000_000));
  stmt.updateItemSavings.run({ id, savedAmount });
  const existingGoal = stmt.goalByItem.get(id);
  const goalPayload = {
    itemId: id,
    targetAmount: cost,
    savedAmount,
    monthlyContribution: positiveNumber(
      req.body?.monthlyContribution ?? existingGoal?.monthly_contribution ?? 0,
    ),
    deadline:
      isoDateValue(req.body?.deadline) ||
      existingGoal?.deadline ||
      item.deadline,
    status: savedAmount >= cost ? "complete" : "active",
  };
  stmt.upsertGoal.run(goalPayload);
  const goal = stmt.goalByItem.get(id);
  if (positiveNumber(req.body?.contributionAmount) > 0) {
    stmt.insertGoalContribution.run({
      goalId: goal.id,
      planId: currentPlanId(),
      amount: positiveNumber(req.body.contributionAmount),
      date: isoDateValue(req.body?.date, todayISO()),
      note: textValue(req.body?.note, "", 500),
    });
  }
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

// История взносов по желанию (таймлайн накоплений).
app.get("/api/items/:id/contributions", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const item = stmt.itemById.get(id);
  if (!item) return res.status(404).json({ error: "not_found" });
  const goal = stmt.goalByItem.get(id);
  const contributions = goal
    ? stmt.contributionsByGoal.all(goal.id).map(rowToGoalContribution)
    : [];
  res.json({
    itemId: id,
    goal: goal ? rowToGoal(goal) : null,
    contributions,
  });
});

// Ручная проверка цены по ссылке желания.
app.post("/api/items/:id/check-price", requireAuth, aiRateLimit, async (req, res) => {
  const id = Number(req.params.id);
  const item = stmt.itemById.get(id);
  if (!item) return res.status(404).json({ error: "not_found" });
  if (!item.url) return res.status(400).json({ error: "no_url" });
  const result = await checkPrice(item.url);
  if (result.found) {
    stmt.updateItemLinkPrice.run({ id, linkPrice: result.price });
    stmt.insertPriceCheck.run({
      itemId: id,
      price: result.price,
      currency: result.currency || null,
      source: "manual",
    });
  }
  res.json({ ...result, item: rowToItem(stmt.itemById.get(id)) });
});

// История проверок цены по ссылке: тренд для карточки желания.
app.get("/api/items/:id/price-history", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const item = stmt.itemById.get(id);
  if (!item) return res.status(404).json({ error: "not_found" });
  const checks = stmt.priceChecksByItem.all(id).map((row) => ({
    id: row.id,
    price: row.price,
    currency: row.currency || null,
    source: row.source,
    checkedAt: row.checked_at,
  }));
  // Тренд: сравнение последней цены с предыдущей и с первой известной.
  const latest = checks[0] || null;
  const previous = checks[1] || null;
  const first = checks.length > 1 ? checks[checks.length - 1] : null;
  res.json({
    itemId: id,
    linkPrice: item.link_price ?? null,
    linkPriceAt: item.link_price_at || null,
    checks,
    trend: latest
      ? {
          latest: latest.price,
          previous: previous?.price ?? null,
          first: first?.price ?? null,
          changeFromPrevious: previous ? latest.price - previous.price : null,
          changeFromFirst: first ? latest.price - first.price : null,
        }
      : null,
  });
});

app.get("/api/goals", requireAuth, (req, res) => {
  res.json({ goals: getGoals() });
});
app.post("/api/goals", requireAuth, (req, res) => {
  const itemId = Number(req.body?.itemId);
  const item = stmt.itemById.get(itemId);
  if (!item) return res.status(404).json({ error: "item_not_found" });
  const savedAmount = positiveNumber(req.body?.savedAmount);
  stmt.upsertGoal.run({
    itemId,
    targetAmount: positiveNumber(req.body?.targetAmount ?? item.cost),
    savedAmount,
    monthlyContribution: positiveNumber(req.body?.monthlyContribution),
    deadline: isoDateValue(req.body?.deadline) || item.deadline || null,
    status:
      oneOf(req.body?.status, ["active", "complete", "archived"], null) ||
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
}
