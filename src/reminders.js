// Фоновые задачи: напоминания (payday, дедлайны) и ежедневная проверка цен.
import { stmt } from "./statements.js";
import { getSetting, setSetting } from "./db.js";
import { sendPush } from "./webpush.js";
import { checkPrice } from "./pricecheck.js";
import { getActivePlan, getActiveItems } from "./store.js";
import { todayISO } from "./sanitize.js";
import { structuredLog } from "./log.js";
import { refreshRatesFromNbu } from "./rates.js";

export async function sendPushToAll(payload) {
  const subs = stmt.pushSubscriptions.all();
  let sent = 0;
  for (const sub of subs) {
    try {
      const result = await sendPush(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      if (result?.gone) stmt.deletePushSubscription.run(sub.endpoint);
      else sent++;
    } catch (error) {
      structuredLog("error", "push_send_failed", {
        error: String(error.message || error),
      });
    }
  }
  return sent;
}


// ---------- планировщик напоминаний и проверки цен ----------
function reminderAlreadySent(key) {
  return getSetting(`notified_${key}`) != null;
}
function markReminderSent(key) {
  setSetting(`notified_${key}`, new Date().toISOString());
}

async function runReminderSweep() {
  if (!stmt.pushSubscriptions.all().length) return;
  const today = todayISO();
  const plan = getActivePlan();
  // Напоминание в день зарплаты: пора распределить деньги.
  if (plan?.payday === today && !reminderAlreadySent(`payday_${plan.id}_${today}`)) {
    await sendPushToAll({
      title: "День зарплаты 💰",
      body: `Пора распределить ${plan.salary} грн по плану «${plan.name}».`,
      url: "/",
    });
    markReminderSent(`payday_${plan.id}_${today}`);
  }
  // Дедлайны желаний в ближайшие 3 дня.
  const soon = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  for (const item of getActiveItems()) {
    if (!item.deadline || item.deadline < today || item.deadline > soon) continue;
    const key = `deadline_${item.id}_${item.deadline}`;
    if (reminderAlreadySent(key)) continue;
    await sendPushToAll({
      title: "Дедлайн близко ⏰",
      body: `«${item.title}» — дедлайн ${item.deadline}, накоплено ${item.savedAmount || 0} из ${item.cost} грн.`,
      url: "/",
    });
    markReminderSent(key);
  }
}

async function runDailyPriceSweep() {
  const today = todayISO();
  if (getSetting("price_sweep_date") === today) return;
  for (const row of stmt.itemsWithUrl.all()) {
    try {
      const result = await checkPrice(row.url);
      if (!result.found) continue;
      const oldPrice = Number(row.link_price) || Number(row.cost) || 0;
      stmt.updateItemLinkPrice.run({ id: row.id, linkPrice: result.price });
      stmt.insertPriceCheck.run({
        itemId: row.id,
        price: result.price,
        currency: result.currency || null,
        source: "daily",
      });
      // Push при удешевлении ≥5% относительно прошлой известной цены.
      if (oldPrice > 0 && result.price <= oldPrice * 0.95) {
        await sendPushToAll({
          title: "Цена упала 📉",
          body: `«${row.title}»: ${result.price} (было ${oldPrice}). Проверь ссылку!`,
          url: "/",
        });
      }
    } catch {}
  }
  // Дату фиксируем после успешного прохода: упавший процесс не теряет день.
  setSetting("price_sweep_date", today);
}

let remindersScheduled = false;
export function scheduleReminders() {
  if (
    remindersScheduled ||
    process.env.NODE_ENV === "test" ||
    process.env.PUSH_REMINDERS_ENABLED === "false"
  )
    return;
  remindersScheduled = true;
  const sweep = () => {
    runReminderSweep().catch((e) =>
      structuredLog("error", "reminder_sweep_failed", { error: String(e.message || e) }),
    );
    runDailyPriceSweep().catch((e) =>
      structuredLog("error", "price_sweep_failed", { error: String(e.message || e) }),
    );
    // Раз в день подтягиваем курс НБУ (если пользователь не зафиксировал свой).
    refreshRatesFromNbu().catch((e) =>
      structuredLog("error", "rate_sweep_failed", { error: String(e.message || e) }),
    );
  };
  setTimeout(sweep, 60_000).unref?.();
  setInterval(sweep, 30 * 60 * 1000).unref?.();
}

