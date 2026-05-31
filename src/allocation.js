// Ядро распределения зарплаты (Allocation engine).
// Чистые функции без побочных эффектов — используются и API, и AI-контекстом.

import { LAYERS, SCORE_CRITERIA } from './categories.js';

const TYPE_WEIGHT = { must: 1000, should: 500, nice: 0 };

// Сценарии меняют только веса ранжирования и целевой буфер.
export const SCENARIOS = {
  balanced: { label: 'Сбалансированный', bufferMultiplier: 1, boost: {} },
  save_more: { label: 'Больше копить', bufferMultiplier: 1.6, boost: { stability: 320, investment: 260 } },
  career: { label: 'Карьерный капитал', bufferMultiplier: 1, boost: { career: 450, investment: 120 } },
  enjoy: { label: 'Наслаждаться жизнью', bufferMultiplier: 0.85, boost: { quality: 350 } },
  custom: { label: 'Свой сценарий', bufferMultiplier: 1, boost: {} },
};

// Оценка спорной покупки (Quick/Full). Возвращает 0–100 и вердикт.
export function scoreVerdict(item) {
  const scores = item.scores || {};
  const type = item.scoreType || 'none';
  if (type === 'none') return null;
  const crit = type === 'full'
    ? [...SCORE_CRITERIA.quick, ...SCORE_CRITERIA.full]
    : SCORE_CRITERIA.quick;
  let pos = 0; let posMax = 0; let neg = 0; let negMax = 0;
  for (const c of crit) {
    const v = Number(scores[c.id]);
    if (!v) continue;
    if (c.dir === 'pos') { pos += v; posMax += 5; }
    else { neg += v; negMax += 5; }
  }
  if (posMax === 0 && negMax === 0) return null;
  const posPart = posMax ? pos / posMax : 0.5;
  const negPart = negMax ? neg / negMax : 0;
  const score = Math.round(Math.max(0, Math.min(1, posPart - negPart * 0.6)) * 100);
  let verdict = 'reconsider';
  if (score >= 62) verdict = 'keep';
  else if (score < 38) verdict = 'drop';
  return { score, verdict, type };
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}

// Композитный ранг покупки. Чем выше — тем раньше распределяем.
function scoreItem(item, payday, boost) {
  let score = TYPE_WEIGHT[item.type] ?? 0;

  // Покупки с дедлайном выигрывают, особенно близкие.
  if (item.deadline) {
    score += 400;
    const d = daysBetween(payday, item.deadline);
    if (d <= 30) score += Math.max(0, 120 - d * 4); // ближе дедлайн — выше
  }

  score += (item.priority || 1) * 50;
  score += (item.trajectory || 1) * 30;
  // Эмоциональное желание влияет слабо и не может перебить приоритет/траекторию.
  score += (item.emotional || 1) * 8;

  // Неоткладываемые покупки защищаем — распределяем раньше.
  if (!item.canDefer) score += 150;

  // Утечки (Leakage: dopamine/waste) распределяем в последнюю очередь.
  if (item.layer === 'leakage') score -= 200;

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

/**
 * Построить план распределения.
 * @param {{payday:string, salary:number, survivalCost:number, buffer:number}} plan
 * @param {Array} items активные покупки
 * @param {{scenario?:string, includeIds?:Array}} [options]
 */
export function allocate(plan, items, options = {}) {
  const scenarioKey = options.scenario || 'balanced';
  const scenario = SCENARIOS[scenarioKey] || SCENARIOS.balanced;
  const includeSet = options.includeIds ? new Set(options.includeIds) : null;

  const salary = Number(plan.salary) || 0;
  const survival = Number(plan.survivalCost) || 0;
  const baseBuffer = Number(plan.buffer) || 0;
  const effectiveBuffer = Math.round(baseBuffer * scenario.bufferMultiplier);

  const availableToAllocate = Math.max(0, salary - survival - effectiveBuffer);

  const ranked = items
    .map((it) => ({ item: it, score: scoreItem(it, plan.payday, scenario.boost) }))
    .sort((a, b) => b.score - a.score);

  const approved = [];
  const deferred = [];
  const buckets = emptyBuckets();
  let spent = 0;
  let mustDeferredForMoney = false;

  for (const { item } of ranked) {
    // Кастомный сценарий: учитываем только выбранные вручную покупки.
    if (scenarioKey === 'custom' && includeSet && !includeSet.has(item.id)) {
      deferred.push({ item, reason: 'Не выбрано в этом сценарии' });
      continue;
    }

    const fits = item.cost <= availableToAllocate - spent;
    if (fits) {
      approved.push({ item, balanceAfter: salary - survival - (spent + item.cost) });
      spent += item.cost;
      buckets[item.layer] = (buckets[item.layer] || 0) + item.cost;
    } else if (item.type === 'must') {
      mustDeferredForMoney = true;
      deferred.push({ item, reason: 'Не хватает бюджета даже на обязательную покупку' });
    } else if (!item.canDefer) {
      deferred.push({ item, reason: 'Не помещается, хотя помечено как неоткладываемое — нужно увеличить бюджет' });
    } else {
      deferred.push({ item, reason: 'Не помещается без нарушения буфера — перенесено на потом' });
    }
  }

  const allocated = spent;
  const remaining = salary - survival - allocated; // включает буфер
  const freeAfterBuffer = remaining - effectiveBuffer;

  let status = 'safe';
  if (remaining < effectiveBuffer || mustDeferredForMoney) status = 'overallocated';
  else if (remaining < effectiveBuffer * 1.25 || deferred.length > 0) status = 'tight';

  // Таймлайн: дата = max(payday, earliestDate). Running balance после каждой покупки.
  const timeline = [];
  let balance = salary - survival;
  const scheduled = approved
    .map((a, idx) => {
      const earliest = a.item.earliestDate && new Date(a.item.earliestDate) > new Date(plan.payday)
        ? a.item.earliestDate
        : plan.payday;
      return { ...a, date: earliest, order: idx };
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

  for (const a of scheduled) {
    balance -= a.item.cost;
    timeline.push({ item: a.item, date: a.date, balanceAfter: balance });
  }

  return {
    scenario: scenarioKey,
    scenarioLabel: scenario.label,
    totals: {
      salary,
      survival,
      buffer: effectiveBuffer,
      baseBuffer,
      availableToAllocate,
      allocated,
      remaining,
      freeAfterBuffer,
      status,
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

  const isApproved = result.approved.some((a) => a.item.id === targetId);
  const remaining = result.totals.remaining;
  const buffer = result.totals.buffer;

  if (isApproved) {
    // Уже в плане: показываем, что освободится, если отказаться.
    return {
      itemId: targetId,
      approved: true,
      remainingIfKept: remaining,
      freedIfRemoved: target.cost,
      remainingIfRemoved: remaining + target.cost,
    };
  }

  // Не в плане: сколько останется, если впихнуть, и кого это вытеснит.
  const remainingAfter = remaining - target.cost;
  const belowBuffer = remainingAfter < buffer;

  // Кого пришлось бы убрать, чтобы поместить (от наименее ценных).
  const displaces = [];
  if (target.cost > result.totals.remaining - buffer) {
    let need = target.cost - (result.totals.remaining - buffer);
    const removable = [...result.approved].sort(
      (a, b) => (a.item.priority || 1) - (b.item.priority || 1)
    );
    for (const a of removable) {
      if (need <= 0) break;
      displaces.push(a.item);
      need -= a.item.cost;
    }
  }

  return {
    itemId: targetId,
    approved: false,
    remainingIfAdded: remainingAfter,
    belowBuffer,
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
      includeIds: key === 'custom' ? customIncludeIds : null,
    });
    return {
      key,
      label: SCENARIOS[key].label,
      buckets: r.buckets,
      survival: r.totals.survival,
      buffer: r.totals.buffer,
      career: r.buckets.career || 0,
      quality: r.buckets.quality || 0,
      allocated: r.totals.allocated,
      remaining: r.totals.remaining,
      status: r.totals.status,
      includedCount: r.approved.length,
      excludedCount: r.deferred.length,
    };
  });
}
