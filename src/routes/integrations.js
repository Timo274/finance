// Интеграции: Monobank (план vs факт) и Web Push подписки.
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import { monobankEnabled, getMonthSummary } from "../monobank.js";
import { getVapidKeys } from "../webpush.js";
import { getActivePlan } from "../store.js";
import { sendPushToAll } from "../reminders.js";

export default function registerIntegrationRoutes(app) {
  app.get("/api/monobank/summary", requireAuth, async (req, res) => {
    if (!monobankEnabled()) return res.json({ enabled: false });
    try {
      const summary = await getMonthSummary({
        month: /^\d{4}-\d{2}$/.test(String(req.query.month || ""))
          ? String(req.query.month)
          : undefined,
        refresh: req.query.refresh === "1",
      });
      const plan = getActivePlan();
      res.json({
        ...summary,
        plan: plan
          ? {
              salary: plan.salary,
              survivalCost: plan.survivalCost,
              buffer: plan.buffer,
              investmentFixed: plan.investmentFixed,
            }
          : null,
      });
    } catch (e) {
      res.status(502).json({ error: "monobank_failed", detail: String(e.message || e) });
    }
  });

  app.get("/api/push/vapid-key", requireAuth, (req, res) => {
    res.json({ publicKey: getVapidKeys().publicKey });
  });
  app.post("/api/push/subscribe", requireAuth, (req, res) => {
    const sub = req.body?.subscription || req.body || {};
    const endpoint = String(sub.endpoint || "");
    const p256dh = String(sub.keys?.p256dh || "");
    const auth = String(sub.keys?.auth || "");
    if (!endpoint.startsWith("https://") || !p256dh || !auth)
      return res.status(400).json({ error: "bad_subscription" });
    stmt.insertPushSubscription.run({ endpoint, p256dh, auth });
    res.json({ ok: true });
  });
  app.post("/api/push/unsubscribe", requireAuth, (req, res) => {
    const endpoint = String(req.body?.endpoint || "");
    if (endpoint) stmt.deletePushSubscription.run(endpoint);
    res.json({ ok: true });
  });

  app.post("/api/push/test", requireAuth, async (req, res) => {
    const sent = await sendPushToAll({
      title: "Capital Queue",
      body: "Push-уведомления работают 🎉",
      url: "/",
    });
    res.json({ ok: true, sent });
  });
}
