// Данные: meta, экспорт/импорт, бэкапы, история, агрегированный state, CSV-отчёты.
import db, { rowToPlan, currencyRate, eurRate } from "../db.js";
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import { importRateLimit, backupRateLimit } from "../middleware.js";
import {
  metaPayload,
  exportPayload,
  getActivePlan,
  getActiveItems,
  getInvestments,
  getPortfolio,
  getWallets,
  getManualPlan,
  getGoals,
  effectiveAllocation,
  currentPlanId,
} from "../store.js";
import { validateImportData, restoreFullBackup } from "../restore.js";
import {
  BACKUP_DIR,
  BACKUP_RETENTION,
  listBackupFiles,
  writeBackup,
} from "../backups.js";
import { buildDecisionInsights } from "../insights.js";
import { getDataVersion, onVersionChange } from "../dataversion.js";
import { csvLine, todayISO, monthForPlan } from "../sanitize.js";

export default function registerDataRoutes(app) {
app.get("/api/meta", requireAuth, (req, res) => {
  res.json(metaPayload());
});

app.get("/api/export", requireAuth, (req, res) => {
  res.json(exportPayload());
});

app.post("/api/import/validate", requireAuth, importRateLimit, (req, res) => {
  const validation = validateImportData(req.body || {});
  res.status(validation.ok ? 200 : 400).json(validation);
});

app.post("/api/import", requireAuth, importRateLimit, (req, res) => {
  const data = req.body || {};
  const isFullBackup = Array.isArray(data.plans) && Array.isArray(data.items);
  const validation = validateImportData(data);
  if (!validation.ok)
    return res
      .status(400)
      .json({ error: "invalid_backup", errors: validation.errors });
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
app.post("/api/backups/run", requireAuth, backupRateLimit, async (req, res) => {
  try {
    res.json({ ok: true, backup: await writeBackup("manual") });
  } catch (error) {
    res
      .status(500)
      .json({ error: "backup_failed", detail: String(error.message || error) });
  }
});

app.get("/api/history", requireAuth, (req, res) => {
  res.json({ history: stmt.closedPlans.all().map(rowToPlan) });
});

app.get("/api/version", requireAuth, (req, res) =>
  res.json({ version: getDataVersion() }),
);

// SSE: одно keep-alive соединение вместо поллинга каждые 5с (аудит 17.2).
// Поллинг остаётся фолбэком на клиенте.
app.get("/api/events", requireAuth, (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`event: version\ndata: ${getDataVersion()}\n\n`);
  const unsubscribe = onVersionChange((v) => {
    res.write(`event: version\ndata: ${v}\n\n`);
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.get("/api/state", requireAuth, (req, res) => {
  const plan = getActivePlan();
  const items = getActiveItems();
  const scenario = req.query.scenario || "balanced";
  const allocation = effectiveAllocation(plan, items, scenario);
  res.json({
    plan,
    items,
    allocation,
    insights: buildDecisionInsights(plan, items, allocation),
    history: stmt.closedPlans.all().map(rowToPlan),
    meta: metaPayload(),
    investments: getInvestments(),
    portfolio: getPortfolio(),
    wallets: getWallets(),
    manualPlan: getManualPlan() || [],
    goals: getGoals(),
    currencyRate: currencyRate(),
    eurRate: eurRate(),
  });
});

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

app.get("/api/export/report/:year", requireAuth, (req, res) => {
  const year = String(req.params.year || "");
  if (!/^\d{4}$/.test(year)) return res.status(400).json({ error: "bad_year" });
  const plans = stmt.closedPlans
    .all()
    .map(rowToPlan)
    .filter((p) => String(p.closedAt || p.payday || "").startsWith(year))
    .sort((a, b) => String(a.payday).localeCompare(String(b.payday)));

  const rows = [];
  const totals = { salary: 0, allocated: 0, remaining: 0, purchased: 0 };
  for (const plan of plans) {
    const s = plan.snapshot || {};
    const t = s.totals || {};
    const purchasedList = (s.approved || []).filter((a) => a.purchased !== false);
    const purchasedSum = purchasedList.reduce(
      (sum, a) => sum + (Number(a.allocatedAmount ?? a.cost) || 0),
      0,
    );
    const salary = Number(t.salary ?? plan.salary) || 0;
    const allocated = Number(t.allocated) || 0;
    const remaining = Number(t.remaining) || 0;
    totals.salary += salary;
    totals.allocated += allocated;
    totals.remaining += remaining;
    totals.purchased += purchasedSum;
    rows.push(
      csvLine([
        String(plan.payday || "").slice(0, 7),
        plan.name,
        salary,
        allocated,
        remaining,
        purchasedSum,
        purchasedList.map((a) => a.title).join("; "),
        (s.deferred || []).map((d) => d.title).join("; "),
      ]),
    );
  }
  rows.push(
    csvLine([
      "ИТОГО",
      "",
      totals.salary,
      totals.allocated,
      totals.remaining,
      totals.purchased,
      "",
      "",
    ]),
  );
  const headers = [
    "month",
    "plan",
    "salary",
    "allocated",
    "remaining",
    "purchased_sum",
    "purchased_items",
    "deferred_items",
  ];
  const csv = "\uFEFF" + csvLine(headers) + "\n" + rows.join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="report-${year}.csv"`,
  );
  res.send(csv);
});

app.get("/api/history/charts", requireAuth, (req, res) => {
  // Динамика капитала: сумма последних оценок всех активов на каждую дату.
  const valuations = stmt.allValuations.all();
  const dates = [...new Set(valuations.map((v) => v.date))].sort();
  const latestByAsset = new Map();
  const netWorthSeries = [];
  for (const date of dates) {
    for (const v of valuations.filter((x) => x.date === date)) {
      latestByAsset.set(v.asset_id, Number(v.value) || 0);
    }
    netWorthSeries.push({
      date,
      value:
        Math.round(
          [...latestByAsset.values()].reduce((s, x) => s + x, 0) * 100,
        ) / 100,
    });
  }
  // Свободный остаток по закрытым месяцам.
  const monthly = stmt.closedPlans
    .all()
    .map(rowToPlan)
    .map((p) => ({
      month: String(p.payday || "").slice(0, 7),
      name: p.name,
      salary: Number(p.snapshot?.totals?.salary ?? p.salary) || 0,
      allocated: Number(p.snapshot?.totals?.allocated) || 0,
      remaining: Number(p.snapshot?.totals?.remaining) || 0,
    }))
    .reverse();
  res.json({ netWorth: netWorthSeries, monthly });
});
}
