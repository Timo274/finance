import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocate } from "../src/allocation.js";
import { buildDecisionInsights } from "../src/insights.js";

const plan = {
  payday: "2026-06-15",
  salary: 25000,
  survivalCost: 6000,
  buffer: 1000,
  investmentFixed: 2000,
};

function item(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Item",
    cost: overrides.cost ?? 1000,
    category: overrides.category ?? "lifestyle",
    layer: overrides.layer ?? "quality",
    priority: overrides.priority ?? 3,
    type: overrides.type ?? "should",
    deadline: overrides.deadline ?? null,
    canDefer: overrides.canDefer ?? true,
    emotional: overrides.emotional ?? 3,
    trajectory: overrides.trajectory ?? 3,
    savedAmount: overrides.savedAmount ?? 0,
    status: "active",
  };
}

describe("buildDecisionInsights", () => {
  it("returns no-plan state without a plan", () => {
    const insights = buildDecisionInsights(null, [], null, { today: "2026-06-01" });
    assert.equal(insights.status, "no_plan");
    assert.equal(insights.buyNow.length, 0);
  });

  it("summarizes approved items as buy-now decisions", () => {
    const items = [item({ id: 1, title: "Course", cost: 3000, layer: "career", type: "must" })];
    const allocation = allocate(plan, items);
    const insights = buildDecisionInsights(plan, items, allocation, { today: "2026-06-01" });
    assert.equal(insights.status, "safe");
    assert.equal(insights.buyNow[0].title, "Course");
    assert.equal(insights.metrics.plannedCount, 1);
  });

  it("flags urgent deferred items", () => {
    const items = [
      item({ id: 1, title: "Laptop", cost: 50000, type: "must", deadline: "2026-06-10", canDefer: false }),
      item({ id: 2, title: "Game", cost: 4000, type: "nice", layer: "leakage" }),
    ];
    const allocation = allocate(plan, items);
    const insights = buildDecisionInsights(plan, items, allocation, { today: "2026-06-01" });
    assert.equal(insights.status, "danger");
    assert.equal(insights.watch[0].title, "Laptop");
    assert.match(insights.watch[0].deadlineText, /через 9 дн\./);
  });
});
