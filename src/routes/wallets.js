// Кошельки месяца и ручной план распределения.
import db from "../db.js";
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import {
  getActivePlan,
  getActiveItems,
  getWallets,
  getManualPlan,
} from "../store.js";
import { allocate, amountToFund } from "../allocation.js";
import {
  sanitizeEntries,
  sanitizeManualPlan,
  monthForPlan,
} from "../sanitize.js";

export default function registerWalletRoutes(app) {
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

  const cappedManualPlan = manualPlan
    .map((entry) => {
      const item = items.find((it) => Number(it.id) === Number(entry.itemId));
      const amount = Math.min(entry.amount, amountToFund(item));
      return { ...entry, amount };
    })
    .filter((entry) => entry.amount > 0);
  const allocation = allocate(plan, items, { scenario: "balanced" });
  const total = cappedManualPlan.reduce((sum, entry) => sum + entry.amount, 0);
  const availableToAllocate = allocation.totals.availableToAllocate;
  const overBudget = total > availableToAllocate;

  const save = db.transaction(() => {
    stmt.deleteDecisionsForPlan.run({ planId });
    cappedManualPlan.forEach((entry) =>
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
}
