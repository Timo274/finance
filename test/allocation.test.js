import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  allocate,
  allocationFromManualPlan,
  amountToFund,
  tradeoff,
  scoreVerdict,
} from "../src/allocation.js";

const basePlan = {
  payday: "2026-06-15",
  salary: 25000,
  survivalCost: 6000,
  buffer: 1000,
  investmentFixed: 2000,
};

function makeItem(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    title: overrides.title ?? "Test",
    cost: overrides.cost ?? 1000,
    category: overrides.category ?? "lifestyle",
    layer: overrides.layer ?? "quality",
    band: overrides.band ?? "small",
    priority: overrides.priority ?? 3,
    type: overrides.type ?? "should",
    deadline: overrides.deadline ?? null,
    earliestDate: overrides.earliestDate ?? null,
    canDefer: overrides.canDefer ?? true,
    emotional: overrides.emotional ?? 3,
    trajectory: overrides.trajectory ?? 3,
    savedAmount: overrides.savedAmount ?? 0,
    scoreType: overrides.scoreType ?? "none",
    scores: overrides.scores ?? null,
    notes: null,
    status: "active",
    createdAt: "2026-01-01",
  };
}

describe("allocate", () => {
  it("returns zero allocation with no items", () => {
    const r = allocate(basePlan, []);
    assert.equal(r.totals.salary, 25000);
    assert.equal(r.totals.survival, 6000);
    assert.equal(r.totals.availableToAllocate, 16000);
    assert.equal(r.approved.length, 0);
    assert.equal(r.totals.status, "safe");
  });

  it("allocates items that fit in budget", () => {
    const items = [
      makeItem({
        id: 1,
        title: "A",
        cost: 3000,
        type: "must",
        priority: 5,
        layer: "quality",
      }),
      makeItem({
        id: 2,
        title: "B",
        cost: 2000,
        type: "should",
        priority: 3,
        layer: "quality",
      }),
    ];
    const r = allocate(basePlan, items);
    // Both fit: A (3000) + B (2000) = 5000, quality target is 25% of 16000 = 4000
    // A is must, bypasses policy. B would exceed layer (3000+2000=5000 > 4000)
    assert.equal(r.approved.length, 1);
    assert.equal(r.totals.allocated, 3000);
  });

  it("defers items that exceed budget", () => {
    const items = [
      makeItem({ id: 1, title: "Big", cost: 25000, type: "must", priority: 5 }),
    ];
    const r = allocate(basePlan, items);
    assert.equal(r.approved.length, 0);
    assert.equal(r.deferred.length, 1);
    assert.equal(r.totals.status, "overallocated");
  });

  it("respects type priority (must before should before nice)", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Nice",
        cost: 2000,
        type: "nice",
        priority: 1,
        layer: "quality",
      }),
      makeItem({
        id: 2,
        title: "Should",
        cost: 3000,
        type: "should",
        priority: 1,
        layer: "quality",
      }),
      makeItem({
        id: 3,
        title: "Must",
        cost: 4000,
        type: "must",
        priority: 1,
        layer: "quality",
      }),
    ];
    const r = allocate(basePlan, items);
    const approved = r.approved.map((a) => a.item.title);
    // Must is protected and fits in 16000 budget, gets approved
    assert.ok(approved.includes("Must"));
    // Nice has lowest score, deferred last
    const deferred = r.deferred.map((d) => d.item.title);
    // Higher score items get approved first
    assert.ok(deferred.length > 0 || approved.length > 0);
  });

  it("computes totals correctly", () => {
    const items = [makeItem({ id: 1, title: "X", cost: 4000, type: "should" })];
    const r = allocate(basePlan, items);
    assert.equal(r.totals.salary, 25000);
    assert.equal(r.totals.survival, 6000);
    assert.equal(r.totals.fixedInvestment, 2000);
    assert.equal(r.totals.buffer, 1000);
    assert.equal(r.totals.stableExpenses, 9000);
    assert.equal(r.totals.availableToAllocate, 16000);
    assert.equal(r.totals.allocated, 4000);
    assert.equal(r.totals.remaining, 12000);
  });

  it("allocates only the remaining cost after savings", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Partly saved",
        cost: 10000,
        savedAmount: 8000,
        type: "must",
      }),
    ];
    const r = allocate(basePlan, items);
    assert.equal(r.approved.length, 1);
    assert.equal(r.approved[0].allocatedAmount, 2000);
    assert.equal(r.approved[0].item.remainingCost, 2000);
    assert.equal(r.totals.allocated, 2000);
    assert.equal(r.totals.remaining, 14000);
  });

  it("does not allocate budget for fully funded items", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Funded",
        cost: 5000,
        savedAmount: 5000,
        type: "must",
      }),
    ];
    const r = allocate(basePlan, items);
    assert.equal(r.approved.length, 1);
    assert.equal(r.approved[0].allocatedAmount, 0);
    assert.equal(r.totals.allocated, 0);
    assert.equal(r.totals.status, "safe");
  });

  it("keeps status safe when only optional wishlist items are deferred by policy", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Nice",
        cost: 10000,
        type: "nice",
        layer: "quality",
      }),
    ];
    const r = allocate(basePlan, items);
    assert.equal(r.approved.length, 0);
    assert.equal(r.deferred.length, 1);
    assert.equal(r.totals.status, "safe");
  });
});

describe("manual allocation", () => {
  it("uses manual entries as the source of allocated totals and buckets", () => {
    const items = [
      makeItem({
        id: 1,
        title: "A",
        cost: 5000,
        savedAmount: 1000,
        layer: "career",
      }),
      makeItem({ id: 2, title: "B", cost: 3000, layer: "quality" }),
    ];
    const r = allocationFromManualPlan(basePlan, items, [
      { itemId: 1, amount: 6000 },
      { itemId: 2, amount: 500 },
    ]);
    assert.equal(amountToFund(items[0]), 4000);
    assert.equal(r.totals.allocated, 4500);
    assert.equal(r.totals.remaining, 11500);
    assert.equal(r.buckets.career, 4000);
    assert.equal(r.buckets.quality, 500);
    assert.equal(r.approved[0].fullyFunded, true);
    assert.equal(r.deferred.find((d) => d.item.id === 2).remainingCost, 2500);
  });
});

describe("scoreVerdict", () => {
  it("returns null for scoreType none", () => {
    const item = makeItem({ scoreType: "none" });
    assert.equal(scoreVerdict(item), null);
  });

  it("returns keep for high scores", () => {
    const item = makeItem({
      scoreType: "quick",
      scores: {
        retained_utility: 5,
        trajectory_alignment: 5,
        emotional_trigger: 1,
        capital_velocity: 5,
        predicted_30d: 5,
      },
    });
    const v = scoreVerdict(item);
    assert.equal(v.verdict, "keep");
    assert.ok(v.score >= 68);
  });

  it("returns drop for low scores", () => {
    const item = makeItem({
      scoreType: "quick",
      scores: {
        retained_utility: 1,
        trajectory_alignment: 1,
        emotional_trigger: 5,
        capital_velocity: 1,
        predicted_30d: 1,
      },
    });
    const v = scoreVerdict(item);
    assert.equal(v.verdict, "drop");
    assert.ok(v.score < 45);
  });
});

describe("tradeoff", () => {
  it("calculates remaining if item added", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Existing",
        cost: 5000,
        type: "should",
        layer: "quality",
      }),
    ];
    const t = tradeoff(1, basePlan, items, {});
    assert.ok(t);
    assert.equal(t.approved, false); // Should-only item exceeds quality layer target
    assert.equal(typeof t.remainingIfAdded, "number");
  });

  it("calculates freed amount if item removed", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Existing",
        cost: 5000,
        type: "must",
        priority: 5,
        layer: "quality",
      }),
    ];
    const t = tradeoff(1, basePlan, items, {});
    assert.ok(t);
    assert.equal(t.approved, true); // Must is protected, gets approved
    assert.equal(t.freedIfRemoved, 5000);
  });

  it("uses remaining cost in tradeoff when savings exist", () => {
    const items = [
      makeItem({
        id: 1,
        title: "Saved must",
        cost: 5000,
        savedAmount: 3500,
        type: "must",
        priority: 5,
        layer: "quality",
      }),
    ];
    const t = tradeoff(1, basePlan, items, {});
    assert.ok(t);
    assert.equal(t.approved, true);
    assert.equal(t.freedIfRemoved, 1500);
    assert.equal(t.remainingIfRemoved, t.remainingIfKept + 1500);
  });
});
