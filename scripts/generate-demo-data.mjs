// Одноразовый генератор public/demo-data.json: поднимает реальный сервер
// на временной БД, заводит демо-данные через API и сохраняет /api/state.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "demo-gen-"));
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "demo-gen-secret";
process.env.DB_PATH = path.join(tmpDir, "app.db");
process.env.BACKUP_DIR = path.join(tmpDir, "backups");
process.env.BACKUP_ENABLED = "false";

const mod = await import(`./server.js?demo=${Date.now()}`);
const server = mod.app.listen(0);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = null;

async function req(p, method = "GET", body) {
  const res = await fetch(base + p, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) console.error("FAIL", method, p, res.status, text.slice(0, 200));
  return data;
}

await req("/api/auth/setup", "POST", { pin: "123456" });
await req("/api/plan", "POST", {
  name: "Июнь 2026",
  payday: 5,
  salary: 62000,
  survivalCost: 28500,
  buffer: 6000,
  investmentFixed: 5000,
});

const items = [
  { title: "Наушники Sony WH-1000XM5", cost: 14500, category: "техника", layer: "joy", type: "purchase", priority: 4, notes: "Для работы и поездок", emotional: 4, trajectory: 3 },
  { title: "Курс по Python", cost: 4200, category: "образование", layer: "growth", type: "purchase", priority: 5, trajectory: 5, emotional: 2 },
  { title: "Кроссовки для бега", cost: 3800, category: "спорт", layer: "joy", type: "purchase", priority: 3, emotional: 3, trajectory: 4 },
  { title: "Подарок маме", cost: 2500, category: "семья", layer: "care", type: "purchase", priority: 5, deadline: "2026-07-10", emotional: 5, trajectory: 2 },
  { title: "MacBook Air M4", cost: 58000, category: "техника", layer: "growth", type: "goal", priority: 4, savedAmount: 21000, currency: "USD", costOriginal: 1400, emotional: 4, trajectory: 5 },
  { title: "Поездка в Карпаты", cost: 9500, category: "путешествия", layer: "joy", type: "goal", priority: 3, savedAmount: 4000, emotional: 5, trajectory: 3 },
  { title: "Абонемент в зал (продление)", cost: 1800, category: "спорт", layer: "care", type: "purchase", priority: 4, recurring: true, emotional: 2, trajectory: 4 },
  { title: "Электрогриль", cost: 5600, category: "дом", layer: "joy", type: "purchase", priority: 2, canDefer: true, emotional: 3, trajectory: 2 },
];
for (const it of items) await req("/api/items", "POST", it);

await req("/api/wallets", "POST", {
  wallets: [
    { name: "Подушка безопасности", amount: 5000 },
    { name: "Отпуск", amount: 3000 },
    { name: "Подарки", amount: 1500 },
  ],
});

const state = await req("/api/state?scenario=balanced");
state.meta = state.meta || {};
if (state.meta.ai) state.meta.ai.enabled = false; // в демо чат недоступен
await fs.writeFile(
  "public/demo-data.json",
  JSON.stringify(state, null, 1),
);
console.log("written, items:", state.items?.length, "alloc approved:", state.allocation?.approved?.length);
await new Promise((r) => server.close(r));
await fs.rm(tmpDir, { recursive: true, force: true });
