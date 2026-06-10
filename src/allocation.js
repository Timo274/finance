// Ядро распределения зарплаты (Allocation engine).
// Чистые функции без побочных эффектов — используются и API, и AI-контекстом.

import { LAYERS, SCORE_CRITERIA } from "./categories.js";

const TYPE_WEIGHT = { must: 1000, should: 500, nice: 0 };

// Сценарии — политики распределения излишка после стабильных пунктов.
export const SCENARIOS = {
  balanced: {
    label: "Сбалансированный",
    reserveMultiplier: 1,
    boost: {},
    weights: {
      stability: 25,
      career: 25,
      investment: 20,
      quality: 25,
      leakage: 5,
    },
  },
  save_more: {
    label: "Безопасный",
    reserveMultiplier: 1.35,
    boost: { stability: 180, investment: 150 },
    weights: {
      stability: 35,
      career: 15,
      investment: 30,
      quality: 15,
      leakage: 5,
    },
  },
  career: {
    label: "Рост / карьера",
    reserveMultiplier: 1,
    boost: { career: 300, investment: 120 },
    weights: {
      stability: 15,
      career: 45,
      investment: 25,
      quality: 10,
      leakage: 5,
    },
  },
  enjoy: {
    label: "Жить сейчас",
    reserveMultiplier: 0.8,
    boost: { quality: 220 },
    weights: {
      stability: 10,
      career: 15,
      investment: 15,
      quality: 55,
      leakage: 5,
    },
  },
  custom: {
    label: "Свой сценарий",
    reserveMultiplier: 1,
    boost: {},
    weights: null,
  },
};

// Оценка спорной покупки (Quick/Full). Возвращает 0–100 и вердикт.
export function scoreVerdict(item) {
  const scores = item.scores || {};
  const type = item.scoreType || "none";
  if (type === "none") return null;
  const crit =
    type === "full" ? [...SCORE_CRITERIA.quick, ...SCORE_CRITERIA.full] : SCORE_CRITERIA.quick;
  // Каждый критерий приводим «к лучшему»: для negative инвертируем (6 - v).
  let sum = 0;
  let count = 0;
  for (const c of crit) {
    const v = Number(scores[c.id]);
    if (!v) continue;
    sum += c.dir === "neg" ? 6 - v : v;
    count += 1;
  }
  if (count === 0) return null;
  const score = Math.round((sum / count / 5) * 100); // нейтральные тройки → ~60
  let verdict = "reconsider";
  if (score >= 68) verdict = "keep";
  else if (score < 45) verdict = "drop";
  return { score, verdict, type };
}

function daysBetween(a, b) {
  const diff = new Date(b) - new Date(a);
  if (!Number.isFinite(diff)) return 0;
  return Math.round(diff / (1000 * 60 * 60 * 24));
}

// Композитный ранг покупки. Чем выше — тем раньше распределяем.
function scoreItem(item, payday, boost) {
  let score = TYPE_WEIGHT[item.type] ?? 0;

  // Покупки с дедлайном выигрывают, особенно близкие.
  // Просроченный дедлайн срочный, но бонус ограничен, чтобы старые даты не ломали ранжирование.
  if (item.deadline) {
    score += 400;
    const d = daysBetween(payday, item.deadline);
    if (d < 0) score += 160;
    else if (d <= 30) score += Math.max(0, 120 - d * 4); // ближе дедлайн — выше
  }

  score += (item.priority || 1) * 50;
  score += (item.trajectory || 1) * 30;
  // Эмоциональное желание влияет слабо и не может перебить приоритет/траекторию.
  score += (item.emotional || 1) * 8;

  // Неоткладываемые покупки защищаем — распределяем раньше.
  if (!item.canDefer) score += 150;

  // Утечки (Leakage: dopamine/waste) распределяем в последнюю очередь.
  if (item.layer === "leakage") score -= 200;

  // Оценка покупки влияет на ранг: keep поднимает, drop опускает.
  const v = scoreVerdict(item);
  if (v) score += (v.score - 50) * 2;

  // Бонус сценария по слою капитала.
  score += boost[item.layer] || 0;

  return score;
}

function emptyBuckets() {
  return Object.fromEntries(Object.keys(LAYERS).map((k) => [k, 0]));
}

function policyTargets(available, weights) {
  if (!weights) return null;
  const totalWeight =
    Object.values(weights).reduce((sum, value) => sum + Number(value || 0), 0) || 1;
  return Object.fromEntries(
    Object.keys(LAYERS).map((layer) => [
      layer,
      Math.round(available * (Number(weights[layer] || 0) / totalWeight)),
    ]),
  );
}

export function amountToFund(item) {
  const cost = Math.max(0, Number(item.cost) || 0);
  const saved = Math.max(0, Number(item.savedAmount) || 0);
  return Math.max(0, cost - saved);
}

/**
 * Построить план распределения.
 * @param {{payday:string, salary:number, survivalCost:number, buffer:number, investmentFixed:number}} plan
 * @param {Array} items активные покупки
 * @param {{scenario?:string, includeIds?:Array}} [options]
 */
export function allocate(plan, items, options = {}) {
  const scenarioKey = options.scenario || "balanced";
  const scenario = SCENARIOS[scenarioKey] || SCENARIOS.balanced;
  const includeSet = options.includeIds ? new Set(options.includeIds) : null;

  const salary = Number(plan.salary) || 0;
  const survival = Number(plan.survivalCost) || 0;
  const fixedInvestment = Number(plan.investmentFixed) || 0;
  const baseReserve = Number(plan.buffer) || 0;
  const effectiveReserve = Math.round(baseReserve * scenario.reserveMultiplier);
  const stableExpenses = survival + effectiveReserve + fixedInvestment;

  const availableToAllocate = Math.max(0, salary - stableExpenses);

  const ranked = items
    .map((it) => ({
      item: it,
      score: scoreItem(it, plan.payday, scenario.boost),
    }))
    .sort((a, b) => b.score - a.score);

  const approved = [];
  const deferred = [];
  const buckets = emptyBuckets();
  const targets =
    scenarioKey === "custom" ? null : policyTargets(availableToAllocate, scenario.weights);
  let spent = 0;

  for (const { item } of ranked) {
    const remainingCost = amountToFund(item);
    const itemForResult = { ...item, remainingCost };

    // Кастомный сценарий: учитываем только выбранные вручную покупки.
    if (scenarioKey === "custom" && includeSet && !includeSet.has(item.id)) {
      deferred.push({
        item: itemForResult,
        remainingCost,
        reason: "Не выбрано в этом сценарии",
      });
      continue;
    }

    const remainingBudget = availableToAllocate - spent;
    const layerSpent = buckets[item.layer] || 0;
    const layerTarget = targets?.[item.layer] ?? availableToAllocate;
    const protectedItem = item.type === "must" || !item.canDefer;
    const fits = remainingCost <= remainingBudget;
    const fitsPolicy = !targets || protectedItem || layerSpent + remainingCost <= layerTarget;
    if (fits && fitsPolicy) {
      approved.push({
        item: itemForResult,
        allocatedAmount: remainingCost,
        remainingCost,
        fullyFunded: true,
        balanceAfter: salary - stableExpenses - (spent + remainingCost),
      });
      spent += remainingCost;
      buckets[item.layer] = (buckets[item.layer] || 0) + remainingCost;
    } else if (protectedItem) {
      // Обязательная/неоткладываемая покупка не влезает целиком: резервируем под неё
      // весь остаток бюджета как накопление, чтобы мелкие желания не съели деньги раньше must.
      const partial = Math.max(0, Math.min(remainingCost, remainingBudget));
      if (partial > 0) {
        approved.push({
          item: itemForResult,
          allocatedAmount: partial,
          remainingCost,
          partial: true,
          fullyFunded: false,
          balanceAfter: salary - stableExpenses - (spent + partial),
        });
        spent += partial;
        buckets[item.layer] = (buckets[item.layer] || 0) + partial;
      }
      deferred.push({
        item: itemForResult,
        remainingCost: remainingCost - partial,
        partial: partial > 0,
        reason:
          partial > 0
            ? `Не влезает целиком: ${partial.toLocaleString("ru-RU")} грн уходит в накопление, не хватает ещё ${(remainingCost - partial).toLocaleString("ru-RU")} грн`
            : item.type === "must"
              ? "Не хватает бюджета даже на обязательную покупку"
              : "Не помещается, хотя помечено как неоткладываемое — нужно увеличить бюджет",
      });
    } else if (!fitsPolicy) {
      deferred.push({
        item: itemForResult,
        remainingCost,
        policyLimited: true,
        reason: `Не проходит политику сценария: лимит слоя «${LAYERS[item.layer]?.ru || item.layer}»`,
      });
    } else {
      deferred.push({
        item: itemForResult,
        remainingCost,
        reason: "Не помещается в излишки после стабильных пунктов — перенесено на потом",
      });
    }
  }

  // Перелив: лимиты слоёв не должны «замораживать» свободные деньги.
  // Отложенные только из-за политики покупки финансируем из остатка в порядке ранга.
  if (targets) {
    for (let i = 0; i < deferred.length; ) {
      const d = deferred[i];
      const budgetLeft = availableToAllocate - spent;
      if (d.policyLimited && d.remainingCost > 0 && d.remainingCost <= budgetLeft) {
        approved.push({
          item: d.item,
          allocatedAmount: d.remainingCost,
          remainingCost: d.remainingCost,
          fullyFunded: true,
          beyondPolicy: true,
          balanceAfter: salary - stableExpenses - (spent + d.remainingCost),
        });
        spent += d.remainingCost;
        buckets[d.item.layer] = (buckets[d.item.layer] || 0) + d.remainingCost;
        deferred.splice(i, 1);
      } else {
        i += 1;
      }
    }
  }

  const allocated = spent;
  const remaining = salary - stableExpenses - allocated;
  const freeAfterReserve = remaining;

  const unfundedMust = deferred
    .filter((d) => d.remainingCost > 0 && (d.item.type === "must" || !d.item.canDefer))
    .map((d) => d.item.title);

  let status = "safe";
  let statusReason = "safe";
  if (salary < stableExpenses) {
    status = "overallocated";
    statusReason = "stable_over_salary";
  } else if (remaining < 0) {
    status = "overallocated";
    statusReason = "overspent";
  } else if (unfundedMust.length) {
    status = "overallocated";
    statusReason = "must_unfunded";
  } else if (availableToAllocate > 0 && remaining < availableToAllocate * 0.15) {
    status = "tight";
    statusReason = "tight";
  }

  // Таймлайн: дата = max(payday, earliestDate). Running balance после каждой покупки.
  const timeline = [];
  let balance = salary - stableExpenses;
  const scheduled = approved
    .map((a, idx) => {
      const earliest =
        a.item.earliestDate && new Date(a.item.earliestDate) > new Date(plan.payday)
          ? a.item.earliestDate
          : plan.payday;
      return { ...a, date: earliest, order: idx };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  for (const a of scheduled) {
    const amount = a.allocatedAmount ?? amountToFund(a.item);
    balance -= amount;
    timeline.push({
      item: a.item,
      date: a.date,
      allocatedAmount: amount,
      balanceAfter: balance,
    });
  }

  return {
    scenario: scenarioKey,
    scenarioLabel: scenario.label,
    totals: {
      salary,
      survival,
      fixedInvestment,
      stableExpenses,
      buffer: effectiveReserve,
      reserve: effectiveReserve,
      baseReserve,
      availableToAllocate,
      allocated,
      remaining,
      freeAfterBuffer: freeAfterReserve,
      freeAfterReserve,
      status,
      statusReason,
      unfundedMust,
    },
    weights: scenario.weights,
    policyTargets: targets,
    buckets,
    approved,
    deferred,
    timeline,
  };
}

/**
 * Пересобрать allocation-результат вокруг ручного плана.
 * Ручной план — главный источник для UI/истории, но базовые расходы и доступный бюджет
 * остаются теми же, что в авто-распределении.
 */
export function allocationFromManualPlan(plan, items, manualPlan = [], options = {}) {
  const base = allocate(plan, items, options);
  const byId = new Map((items || []).map((item) => [Number(item.id), item]));
  const requestedById = new Map();

  for (const entry of Array.isArray(manualPlan) ? manualPlan : []) {
    const itemId = Number(entry?.itemId);
    const amount = Math.max(0, Number(entry?.amount) || 0);
    if (!itemId || amount <= 0 || !byId.has(itemId)) continue;
    requestedById.set(itemId, (requestedById.get(itemId) || 0) + amount);
  }

  const approved = [];
  const deferred = [];
  const buckets = emptyBuckets();
  let allocated = 0;

  for (const item of items || []) {
    const remainingCost = amountToFund(item);
    const requested = requestedById.get(Number(item.id)) || 0;
    const allocatedAmount = Math.min(requested, remainingCost);
    const itemForResult = { ...item, remainingCost };

    if (allocatedAmount > 0) {
      const balanceAfter = base.totals.availableToAllocate - (allocated + allocatedAmount);
      approved.push({
        item: itemForResult,
        allocatedAmount,
        remainingCost,
        balanceAfter,
        manual: true,
        fullyFunded: allocatedAmount >= remainingCost,
      });
      allocated += allocatedAmount;
      buckets[item.layer] = (buckets[item.layer] || 0) + allocatedAmount;
    }

    if (allocatedAmount < remainingCost) {
      deferred.push({
        item: itemForResult,
        remainingCost: remainingCost - allocatedAmount,
        reason:
          allocatedAmount > 0
            ? "Частично профинансировано ручным планом"
            : "Не выбрано в ручном плане",
      });
    }
  }

  const remaining = base.totals.availableToAllocate - allocated;
  const unfundedMust = deferred
    .filter((d) => d.remainingCost > 0 && (d.item.type === "must" || !d.item.canDefer))
    .map((d) => d.item.title);
  let status = "safe";
  let statusReason = "safe";
  if (base.totals.salary < base.totals.stableExpenses) {
    status = "overallocated";
    statusReason = "stable_over_salary";
  } else if (remaining < 0) {
    status = "overallocated";
    statusReason = "overspent";
  } else if (unfundedMust.length) {
    status = "overallocated";
    statusReason = "must_unfunded";
  } else if (
    base.totals.availableToAllocate > 0 &&
    remaining < base.totals.availableToAllocate * 0.15
  ) {
    status = "tight";
    statusReason = "tight";
  }

  const timeline = [];
  let balance = base.totals.availableToAllocate;
  const scheduled = approved
    .map((a, idx) => {
      const earliest =
        a.item.earliestDate && new Date(a.item.earliestDate) > new Date(plan.payday)
          ? a.item.earliestDate
          : plan.payday;
      return { ...a, date: earliest, order: idx };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  for (const a of scheduled) {
    balance -= a.allocatedAmount;
    timeline.push({
      item: a.item,
      date: a.date,
      allocatedAmount: a.allocatedAmount,
      balanceAfter: balance,
      manual: true,
    });
  }

  return {
    ...base,
    manual: true,
    totals: {
      ...base.totals,
      allocated,
      remaining,
      freeAfterBuffer: remaining,
      freeAfterReserve: remaining,
      status,
      statusReason,
      unfundedMust,
    },
    buckets,
    approved,
    deferred,
    timeline,
  };
}

/**
 * Trade-off для одной покупки: что будет, если её добавить/оставить.
 */
export function tradeoff(targetId, plan, items, options = {}) {
  const result = allocate(plan, items, options);
  const target = items.find((i) => i.id === targetId);
  if (!target) return null;

  const approvedEntry = result.approved.find((a) => a.item.id === targetId);
  const isApproved = !!approvedEntry;
  const remaining = result.totals.remaining;
  const targetAmount = amountToFund(target);

  if (isApproved) {
    const freed = approvedEntry.allocatedAmount ?? targetAmount;
    // Уже в плане: показываем, что освободится, если отказаться.
    return {
      itemId: targetId,
      approved: true,
      remainingIfKept: remaining,
      freedIfRemoved: freed,
      remainingIfRemoved: remaining + freed,
    };
  }

  // Не в плане: сколько останется, если впихнуть, и кого это вытеснит.
  const remainingAfter = remaining - targetAmount;
  const belowReserve = remainingAfter < 0;

  // Кого пришлось бы убрать, чтобы поместить (от наименее ценных).
  const displaces = [];
  if (targetAmount > result.totals.remaining) {
    let need = targetAmount - result.totals.remaining;
    // Обязательные и неоткладываемые покупки вытеснять нельзя.
    const removable = result.approved
      .filter((a) => a.item.type !== "must" && a.item.canDefer !== false)
      .sort((a, b) => (a.item.priority || 1) - (b.item.priority || 1));
    for (const a of removable) {
      if (need <= 0) break;
      displaces.push(a.item);
      need -= a.allocatedAmount ?? amountToFund(a.item);
    }
  }

  return {
    itemId: targetId,
    approved: false,
    remainingIfAdded: remainingAfter,
    belowBuffer: belowReserve,
    belowReserve,
    displaces,
  };
}

/**
 * Сводка по всем сценариям для экрана сравнения.
 */
export function scenarioSummaries(plan, items, customIncludeIds = null) {
  return Object.keys(SCENARIOS).map((key) => {
    const r = allocate(plan, items, {
      scenario: key,
      includeIds: key === "custom" ? customIncludeIds : null,
    });
    return {
      key,
      label: SCENARIOS[key].label,
      buckets: r.buckets,
      survival: r.totals.survival,
      fixedInvestment: r.totals.fixedInvestment,
      stableExpenses: r.totals.stableExpenses,
      buffer: r.totals.reserve,
      reserve: r.totals.reserve,
      career: r.buckets.career || 0,
      quality: r.buckets.quality || 0,
      investment: r.buckets.investment || 0,
      allocated: r.totals.allocated,
      remaining: r.totals.remaining,
      weights: r.weights,
      policyTargets: r.policyTargets,
      status: r.totals.status,
      includedCount: r.approved.length,
      excludedCount: r.deferred.length,
    };
  });
}
