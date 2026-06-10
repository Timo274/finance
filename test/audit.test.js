// Регрессионные тесты на фиксы из docs/DEEP_AUDIT_2026-06-11.md.
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
  { method = "GET", body, cookie = sessionCookie, headers: extra = {} } = {},
) {
  const headers = { ...extra };
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-test-"));
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "audit-test-secret";
  process.env.DB_PATH = path.join(tmpDir, "app.db");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.BACKUP_ENABLED = "false";

  const mod = await import(`../server.js?audit=${Date.now()}`);
  server = mod.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  const setup = await request("/api/auth/setup", {
    method: "POST",
    body: { pin: "432100" },
    cookie: null,
  });
  assert.equal(setup.res.status, 200);
  sessionCookie = setup.res.headers.get("set-cookie")?.split(";")[0];
});

after(async () => {
  // SSE-соединения держат сервер открытым — рубим их перед close.
  server?.closeAllConnections?.();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("audit fixes", () => {
  it("13.6: todayISO returns Kyiv-local YYYY-MM-DD", async () => {
    const { todayISO } = await import("../src/sanitize.js");
    assert.match(todayISO(), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("16.3: rejects mutations from a foreign Origin", async () => {
    const { res, data } = await request("/api/plan", {
      method: "POST",
      body: { name: "x", salary: 1000 },
      headers: { Origin: "https://evil.example.com" },
    });
    assert.equal(res.status, 403);
    assert.equal(data.error, "bad_origin");
  });

  it("16.3: allows mutations without Origin and with same Origin", async () => {
    const noOrigin = await request("/api/plan", {
      method: "POST",
      body: { name: "План", payday: "2026-07-01", salary: 50000, survivalCost: 20000 },
    });
    assert.equal(noOrigin.res.status, 200);
    const sameOrigin = await request("/api/plan", {
      method: "POST",
      body: { name: "План", payday: "2026-07-01", salary: 50000, survivalCost: 20000 },
      headers: { Origin: baseUrl },
    });
    assert.equal(sameOrigin.res.status, 200);
  });

  it("13.3: accepts EUR investment assets", async () => {
    const { res, data } = await request("/api/investments/assets", {
      method: "POST",
      body: { name: "EU ETF", type: "etf", currency: "eur" },
    });
    assert.equal(res.status, 200);
    const asset = data.assets.find((a) => a.name === "EU ETF");
    assert.equal(asset.currency, "EUR");
  });

  it("13.1: rejects selling more than held", async () => {
    const created = await request("/api/investments/assets", {
      method: "POST",
      body: { name: "Test Stock", type: "stock", currency: "USD" },
    });
    const asset = created.data.assets.find(
      (a) => a.name === "Test Stock",
    );
    const buy = await request("/api/investments/transactions", {
      method: "POST",
      body: { assetId: asset.id, type: "buy", quantity: 5, price: 10 },
    });
    assert.equal(buy.res.status, 200);
    const sell = await request("/api/investments/transactions", {
      method: "POST",
      body: { assetId: asset.id, type: "sell", quantity: 6, price: 10 },
    });
    assert.equal(sell.res.status, 400);
    assert.equal(sell.data.error, "sell_exceeds_holdings");
    assert.equal(sell.data.held, 5);
    const okSell = await request("/api/investments/transactions", {
      method: "POST",
      body: { assetId: asset.id, type: "sell", quantity: 5, price: 12 },
    });
    assert.equal(okSell.res.status, 200);
  });

  it("12.5: file-like paths get 404, page paths get SPA fallback", async () => {
    const missingFile = await request("/missing-asset.js", { cookie: null });
    assert.equal(missingFile.res.status, 404);
    const page = await request("/queue", { cookie: null });
    assert.equal(page.res.status, 200);
    assert.match(page.text, /<!doctype html>/i);
  });

  it("12.2: data version persists in settings and bumps on mutations", async () => {
    const v1 = await request("/api/version");
    const mutate = await request("/api/items", {
      method: "POST",
      body: { title: "Тест", cost: 100 },
    });
    assert.equal(mutate.res.status, 200);
    // bump происходит в res.on("finish") — даём событию обработаться
    await new Promise((r) => setTimeout(r, 50));
    const v2 = await request("/api/version");
    assert.ok(v2.data.version > v1.data.version);
  });

  it("13.4: manual rate sets manual source", async () => {
    const { res, data } = await request("/api/currency", {
      method: "POST",
      body: { rate: 44.1, eurRate: 48.2 },
    });
    assert.equal(res.status, 200);
    assert.equal(data.source, "manual");
    assert.equal(data.rate, 44.1);
  });

  it("16.2: backup encryption round-trips and hides plaintext", async () => {
    const { encryptBackup, decryptBackup } = await import("../src/offsite.js");
    const crypto = await import("node:crypto");
    const secret = JSON.stringify({ salary: 50000, items: ["секрет"] });
    const key = crypto.createHash("sha256").update("passphrase", "utf8").digest();
    const out = encryptBackup(secret, key);
    assert.equal(out.encrypted, true);
    assert.ok(!out.content.includes("50000"));
    assert.equal(decryptBackup(out.content, "passphrase"), secret);
    // без ключа — сквозная передача
    const plain = encryptBackup(secret, null);
    assert.equal(plain.encrypted, false);
    assert.equal(plain.content, secret);
  });

  it("16.1: new PIN shorter than 6 digits is rejected", async () => {
    const { res } = await request("/api/auth/change-pin", {
      method: "POST",
      body: { currentPin: "432100", newPin: "1234" },
    });
    assert.equal(res.status, 400);
    const { data } = await request("/api/auth/change-pin", {
      method: "POST",
      body: { currentPin: "432100", newPin: "1234" },
    });
    assert.equal(data.error, "pin_too_short");
  });

  it("12.4: absurd transaction inputs are clamped/rejected", async () => {
    const asset = await request("/api/investments/assets", {
      method: "POST",
      body: { name: "Клампы", type: "crypto", currency: "USD" },
    });
    const a = asset.data.assets.find((x) => x.name === "Клампы");
    const zero = await request("/api/investments/transactions", {
      method: "POST",
      body: { assetId: a.id, type: "buy", quantity: 0, price: 10 },
    });
    assert.equal(zero.res.status, 400);
    const huge = await request("/api/investments/transactions", {
      method: "POST",
      body: { assetId: a.id, type: "buy", quantity: 1, price: 1e308, date: "9999-99-99" },
    });
    assert.equal(huge.res.status, 200);
    const tx = huge.data.assets.find((x) => x.id === a.id);
    // цена обрезана до 1e12; в грн с курсом — не больше 1e14 (вместо Infinity)
    assert.ok(tx.totalInvested <= 1e14);
  });

  it("17.2: /api/events streams the current version over SSE", async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/events`, {
      headers: { Cookie: sessionCookie },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: version/);
    assert.match(text, /data: \d+/);
    ac.abort();
    await reader.cancel().catch(() => {});
  });
});
