// Тесты новых фич: мультивалютность, чек-лист закрытия месяца, регулярные
// желания, взносы в цели, бэкап v5, what-if, годовой отчёт, push, смена PIN.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let tmpDir;
let server;
let baseUrl;
let sessionCookie;

async function request(
  pathname,
  { method = "GET", body, cookie = sessionCookie } = {},
) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { res, data, text };
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "salary-planner-feat-"));
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "feature-test-secret";
  process.env.DB_PATH = path.join(tmpDir, "app.db");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.BACKUP_ENABLED = "false";

  const mod = await import(`../server.js?feat=${Date.now()}`);
  server = mod.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: { pin: "432100" },
    cookie: null,
  });
  sessionCookie = setup.res.headers.get("set-cookie")?.split(";")[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("новые фичи", () => {
  let usdItemId;
  let recurringId;
  let plainId;

  it("хранит валютные желания и пересчитывает их при смене курса", async () => {
    const rates = await request("/api/currency", {
      method: "POST",
      body: { rate: 40, eurRate: 44 },
    });
    assert.equal(rates.res.status, 200);
    assert.equal(rates.data.rate, 40);
    assert.equal(rates.data.eurRate, 44);

    const created = await request("/api/items", {
      method: "POST",
      body: { title: "Ноутбук", cost: 100, currency: "usd", url: "https://shop.example/x" },
    });
    assert.equal(created.res.status, 200);
    usdItemId = created.data.item.id;
    assert.equal(created.data.item.currency, "USD");
    assert.equal(created.data.item.costOriginal, 100);
    assert.equal(created.data.item.cost, 4000); // 100 * 40
    assert.equal(created.data.item.url, "https://shop.example/x");

    const bump = await request("/api/currency", {
      method: "POST",
      body: { rate: 42 },
    });
    assert.equal(bump.res.status, 200);
    assert.ok(bump.data.recalculated >= 1);
    const state = await request("/api/state");
    const item = state.data.items.find((i) => i.id === usdItemId);
    assert.equal(item.cost, 4200); // пересчёт по новому курсу
  });

  it("отклоняет небезопасные url", async () => {
    const created = await request("/api/items", {
      method: "POST",
      body: { title: "XSS", cost: 10, url: "javascript:alert(1)" },
    });
    assert.equal(created.res.status, 200);
    assert.equal(created.data.item.url, null);
  });

  it("закрывает месяц по чек-листу: некупленное уходит в накопление, регулярное возвращается", async () => {
    await request("/api/plan", {
      method: "POST",
      body: {
        name: "Тестовый месяц",
        payday: new Date().toISOString().slice(0, 10),
        salary: 100000,
        survivalCost: 10000,
        buffer: 5000,
        investmentFixed: 5000,
      },
    });
    const rec = await request("/api/items", {
      method: "POST",
      body: { title: "Подписка", cost: 1000, recurring: true, type: "must", priority: 5 },
    });
    recurringId = rec.data.item.id;
    assert.equal(rec.data.item.recurring, true);
    const plain = await request("/api/items", {
      method: "POST",
      body: { title: "Кресло", cost: 3000, type: "must", priority: 5 },
    });
    plainId = plain.data.item.id;

    const preview = await request("/api/plan/close-preview");
    assert.equal(preview.res.status, 200);
    const ids = preview.data.approved.map((a) => a.itemId);
    assert.ok(ids.includes(recurringId));
    assert.ok(ids.includes(plainId));

    const close = await request("/api/plan/close", {
      method: "POST",
      body: {
        scenario: "balanced",
        purchases: [
          { itemId: recurringId, purchased: true },
          { itemId: plainId, purchased: false },
        ],
      },
    });
    assert.equal(close.res.status, 200);
    const approvedSnap = close.data.snapshot.approved;
    assert.equal(approvedSnap.find((a) => a.title === "Кресло").purchased, false);

    const state = await request("/api/state");
    const recItem = state.data.items.find((i) => i.id === recurringId);
    const plainItem = state.data.items.find((i) => i.id === plainId);
    // Регулярное куплено, но вернулось в очередь с нулевым накоплением.
    assert.equal(recItem.status, "active");
    assert.equal(recItem.savedAmount || 0, 0);
    // Некупленное осталось активным, выделенные деньги стали накоплением.
    assert.equal(plainItem.status, "active");
    assert.equal(plainItem.savedAmount, 3000);
  });

  it("отдаёт историю взносов по желанию", async () => {
    const contrib = await request(`/api/items/${plainId}/contributions`);
    assert.equal(contrib.res.status, 200);
    assert.ok(contrib.data.contributions.length >= 1);
    assert.equal(contrib.data.contributions[0].amount, 3000);
  });

  it("отдаёт историю проверок цены и тренд", async () => {
    const history = await request(`/api/items/${plainId}/price-history`);
    assert.equal(history.res.status, 200);
    assert.equal(history.data.itemId, plainId);
    assert.ok(Array.isArray(history.data.checks));
    assert.equal(history.data.checks.length, 0);
    assert.equal(history.data.trend, null);

    const missing = await request(`/api/items/999999/price-history`);
    assert.equal(missing.res.status, 404);
  });

  it("экспортирует goalContributions (v5) и восстанавливает их без дублей решений", async () => {
    const exported = await request("/api/export");
    assert.equal(exported.res.status, 200);
    assert.equal(exported.data.version, 5);
    assert.ok(exported.data.goalContributions.length >= 1);
    assert.ok(exported.data.goalContributions[0].itemId);

    // Дубликаты решений с NULL plan_id в бэкапе должны схлопнуться.
    const payload = exported.data;
    payload.allocationDecisions = [
      { itemId: plainId, planId: null, amount: 100, scenario: "manual" },
      { itemId: plainId, planId: null, amount: 200, scenario: "manual" },
    ];
    const imported = await request("/api/import", {
      method: "POST",
      body: payload,
    });
    assert.equal(imported.res.status, 200);

    const reExported = await request("/api/export");
    assert.ok(reExported.data.goalContributions.length >= 1, "взносы выжили импорт");
    const decisions = reExported.data.allocationDecisions.filter(
      (d) => d.itemId === plainId && !d.planId,
    );
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].amount, 200); // последняя запись победила
  });

  it("симулирует распределение без сохранения", async () => {
    await request("/api/plan", {
      method: "POST",
      body: {
        name: "Симуляция",
        payday: new Date().toISOString().slice(0, 10),
        salary: 50000,
        survivalCost: 20000,
        buffer: 5000,
        investmentFixed: 5000,
      },
    });
    const sim = await request("/api/allocation/simulate?salary=200000");
    assert.equal(sim.res.status, 200);
    assert.equal(sim.data.plan.salary, 200000);
    const state = await request("/api/state");
    assert.equal(state.data.plan.salary, 50000); // реальный план не тронут
  });

  it("строит годовой CSV-отчёт", async () => {
    const year = new Date().getFullYear();
    const { res, text } = await request(`/api/export/report/${year}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(text, /ИТОГО/);
    assert.match(text, /Тестовый месяц/);
    const bad = await request("/api/export/report/20xx");
    assert.equal(bad.res.status, 400);
  });

  it("отдаёт данные для графиков истории", async () => {
    const charts = await request("/api/history/charts");
    assert.equal(charts.res.status, 200);
    assert.ok(Array.isArray(charts.data.netWorth));
    assert.ok(charts.data.monthly.length >= 1);
    assert.equal(typeof charts.data.monthly[0].remaining, "number");
  });

  it("выдаёт VAPID-ключ и управляет push-подписками", async () => {
    const key = await request("/api/push/vapid-key");
    assert.equal(key.res.status, 200);
    assert.ok(key.data.publicKey.length > 20);

    const sub = await request("/api/push/subscribe", {
      method: "POST",
      body: {
        subscription: {
          endpoint: "https://push.example/abc",
          keys: { p256dh: "BPdh", auth: "auth" },
        },
      },
    });
    assert.equal(sub.res.status, 200);
    const bad = await request("/api/push/subscribe", {
      method: "POST",
      body: { subscription: { endpoint: "http://insecure", keys: {} } },
    });
    assert.equal(bad.res.status, 400);
    const unsub = await request("/api/push/unsubscribe", {
      method: "POST",
      body: { endpoint: "https://push.example/abc" },
    });
    assert.equal(unsub.res.status, 200);
  });

  it("показывает push-ключ и фичи в meta", async () => {
    const state = await request("/api/state");
    assert.ok(state.data.meta.push.publicKey);
    assert.equal(state.data.meta.monobank.enabled, false);
    assert.equal(state.data.eurRate, 44);
  });

  it("рендерит статику с единой версией", async () => {
    const index = await request("/index.html", { cookie: null });
    assert.equal(index.res.status, 200);
    const m = index.text.match(/app\.js\?v=([0-9a-f]{12})/);
    assert.ok(m, "index.html содержит версию из hash");
    const sw = await request("/sw.js", { cookie: null });
    assert.match(sw.text, new RegExp(`VERSION = "${m[1]}"`));
    assert.ok(!sw.text.includes("__STATIC_VERSION__"));
  });

  it("переживает битый snapshot закрытого плана", async () => {
    // rowToPlan не должен ронять /api/state из-за кривого JSON в snapshot.
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(process.env.DB_PATH);
    raw
      .prepare("UPDATE plans SET snapshot = '{broken' WHERE status = 'closed'")
      .run();
    raw.close();
    const state = await request("/api/state");
    assert.equal(state.res.status, 200);
    assert.equal(state.data.history[0].snapshot, null);
  });

  it("меняет PIN и разлогинивает остальные устройства", async () => {
    const wrong = await request("/api/auth/change-pin", {
      method: "POST",
      body: { currentPin: "0000", newPin: "987600" },
    });
    assert.equal(wrong.res.status, 401);

    const oldCookie = sessionCookie;
    const ok = await request("/api/auth/change-pin", {
      method: "POST",
      body: { currentPin: "432100", newPin: "987600" },
    });
    assert.equal(ok.res.status, 200);
    // Текущее устройство получило новый токен.
    sessionCookie = ok.res.headers.get("set-cookie")?.split(";")[0];
    assert.ok(sessionCookie);
    // Старый токен мёртв.
    const stale = await request("/api/state", { cookie: oldCookie });
    assert.equal(stale.res.status, 401);
    // Новый PIN работает.
    const relog = await request("/api/auth/login", {
      method: "POST",
      body: { pin: "987600" },
      cookie: null,
    });
    assert.equal(relog.res.status, 200);
  });

  it("выходит на всех устройствах", async () => {
    const out = await request("/api/auth/logout-all", { method: "POST", body: {} });
    assert.equal(out.res.status, 200);
    const dead = await request("/api/state");
    assert.equal(dead.res.status, 401);
  });
});
