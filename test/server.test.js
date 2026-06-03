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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "salary-planner-test-"));
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "integration-test-secret";
  process.env.DB_PATH = path.join(tmpDir, "app.db");
  process.env.BACKUP_DIR = path.join(tmpDir, "backups");
  process.env.BACKUP_ENABLED = "false";

  const mod = await import(`../server.js?test=${Date.now()}`);
  server = mod.app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("server API", () => {
  it("protects state before auth", async () => {
    const { res, data } = await request("/api/state", { cookie: null });
    assert.equal(res.status, 401);
    assert.equal(data.error, "unauthorized");
  });

  it("sets up PIN and creates an authenticated session", async () => {
    const status = await request("/api/auth/status", { cookie: null });
    assert.equal(status.res.status, 200);
    assert.equal(status.data.pinSet, false);

    const setup = await request("/api/auth/setup", {
      method: "POST",
      body: { pin: "1234" },
      cookie: null,
    });
    assert.equal(setup.res.status, 200);
    sessionCookie = setup.res.headers.get("set-cookie")?.split(";")[0];
    assert.ok(sessionCookie);
  });

  it("creates plan and item, then returns aggregate state", async () => {
    const plan = await request("/api/plan", {
      method: "POST",
      body: {
        name: "Test salary",
        payday: "2026-06-15",
        salary: 25000,
        survivalCost: 6000,
        buffer: 1000,
        investmentFixed: 2000,
      },
    });
    assert.equal(plan.res.status, 200);
    assert.equal(plan.data.plan.name, "Test salary");

    const item = await request("/api/items", {
      method: "POST",
      body: {
        title: "Laptop",
        cost: 5000,
        type: "must",
        category: "tool",
        priority: 5,
      },
    });
    assert.equal(item.res.status, 200);
    assert.equal(item.data.item.title, "Laptop");

    const state = await request("/api/state?scenario=balanced");
    assert.equal(state.res.status, 200);
    assert.equal(state.data.plan.name, "Test salary");
    assert.equal(state.data.items.length, 1);
    assert.equal(state.data.allocation.approved.length, 1);
  });

  it("returns 404 instead of a database error for missing valuation asset", async () => {
    const valuation = await request("/api/investments/valuations", {
      method: "POST",
      body: { assetId: "missing-asset", value: 1000, date: "2026-06-15" },
    });
    assert.equal(valuation.res.status, 404);
    assert.equal(valuation.data.error, "asset_not_found");
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const missing = await request("/api/does-not-exist");
    assert.equal(missing.res.status, 404);
    assert.equal(missing.data.error, "not_found");
  });

  it("runs and lists JSON backups", async () => {
    const run = await request("/api/backups/run", { method: "POST", body: {} });
    assert.equal(run.res.status, 200);
    assert.equal(run.data.ok, true);
    assert.match(run.data.backup.file, /capital-queue-manual-.+\.json/);

    const list = await request("/api/backups");
    assert.equal(list.res.status, 200);
    assert.equal(list.data.backups.length, 1);
    assert.equal(list.data.backups[0].name, run.data.backup.file);
  });
});
