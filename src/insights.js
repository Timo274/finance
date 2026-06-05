// Decision cockpit insights.
// Pure functions: transform allocation + queue into a short, opinionated next-action layer.

function amountToFund(item) {
  const cost = Math.max(0, Number(item?.cost) || 0);
  const saved = Math.max(0, Number(item?.savedAmount) || 0);
  return Math.max(0, cost - saved);
}

function daysUntil(date, today = new Date()) {
  if (!date) return null;
  const dt = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  const start = new Date(today.toISOString().slice(0, 10) + "T00:00:00.000Z");
  return Math.ceil((dt - start) / (1000 * 60 * 60 * 24));
}

function priorityScore(item, today) {
  let score = 0;
  score += (Number(item.priority) || 1) * 16;
  score += (Number(item.trajectory) || 1) * 10;
  if (item.type === "must") score += 45;
  else if (item.type === "should") score += 20;
  if (!item.canDefer) score += 28;
  if (item.layer === "career" || item.layer === "investment") score += 12;
  if (item.layer === "leakage") score -= 20;

  const days = daysUntil(item.deadline, today);
  if (days !== null) {
    if (days < 0) score += 38;
    else if (days <= 7) score += 34;
    else if (days <= 30) score += 22;
    else if (days <= 60) score += 10;
  }
  return score;
}

function describeDeadline(item, today) {
  const days = daysUntil(item.deadline, today);
  if (days === null) return null;
  if (days < 0) return "дедлайн уже прошёл";
  if (days === 0) return "дедлайн сегодня";
  if (days === 1) return "дедлайн завтра";
  return `дедлайн через ${days} дн.`;
}

function compactItem(item, today) {
  return {
    id: item.id,
    title: item.title,
    cost: Number(item.cost) || 0,
    remainingCost: amountToFund(item),
    type: item.type,
    layer: item.layer || item.bucket,
    category: item.category,
    priority: Number(item.priority) || 1,
    deadline: item.deadline || null,
    deadlineText: describeDeadline(item, today),
    canDefer: item.canDefer !== false,
  };
}

export function buildDecisionInsights(plan, items, allocation, options = {}) {
  if (!plan || !allocation) {
    return {
      status: "no_plan",
      headline: "Сначала настрой зарплату",
      actions: [],
      buyNow: [],
      watch: [],
      postpone: [],
      metrics: {},
    };
  }

  const today = options.today ? new Date(`${options.today}T00:00:00.000Z`) : new Date();
  const totals = allocation.totals || {};
  const available = Number(totals.availableToAllocate) || 0;
  const remaining = Number(totals.remaining) || 0;
  const allocated = Number(totals.allocated) || 0;
  const runwayPct = available > 0 ? Math.round((remaining / available) * 100) : 0;
  const approvedIds = new Set((allocation.approved || []).map((a) => a.item?.id));

  const active = (items || []).filter((item) => item.status === "active" || !item.status);
  const approved = (allocation.approved || [])
    .map((entry) => compactItem({ ...entry.item, remainingCost: entry.remainingCost }, today))
    .slice(0, 3);

  const deferredRanked = (allocation.deferred || [])
    .map((entry) => ({
      item: entry.item,
      reason: entry.reason,
      remainingCost: entry.remainingCost ?? amountToFund(entry.item),
      score: priorityScore(entry.item, today),
    }))
    .sort((a, b) => b.score - a.score);

  const urgentDeferred = deferredRanked
    .filter(({ item }) => {
      const days = daysUntil(item.deadline, today);
      return item.type === "must" || !item.canDefer || (days !== null && days <= 30);
    })
    .slice(0, 3)
    .map(({ item, reason }) => ({ ...compactItem(item, today), reason }));

  const postpone = deferredRanked
    .filter(({ item }) => item.type !== "must" && item.canDefer !== false && !approvedIds.has(item.id))
    .slice(0, 4)
    .map(({ item, reason }) => ({ ...compactItem(item, today), reason }));

  const largestLeakage = active
    .filter((item) => (item.layer || item.bucket) === "leakage")
    .sort((a, b) => amountToFund(b) - amountToFund(a))
    .slice(0, 2)
    .map((item) => compactItem(item, today));

  let headline = "Можно покупать по плану";
  let status = "safe";
  if (totals.status === "overallocated" || remaining < 0) {
    status = "danger";
    headline = "План перегружен — сначала режем или переносим";
  } else if (urgentDeferred.length) {
    status = "warning";
    headline = "Есть срочные желания вне бюджета";
  } else if (runwayPct < 15 && allocated > 0) {
    status = "warning";
    headline = "Запас почти съеден — новые покупки только через trade-off";
  }

  const actions = [];
  if (remaining < 0) {
    actions.push({ tone: "danger", text: `Освободи минимум ${Math.abs(Math.round(remaining)).toLocaleString("ru-RU")} грн из желаний.` });
  } else if (remaining > 0) {
    actions.push({ tone: "good", text: `Оставь ${Math.round(remaining).toLocaleString("ru-RU")} грн свободными или докинь в цель.` });
  }
  if (urgentDeferred[0]) {
    actions.push({ tone: "warn", text: `Проверь срочное: «${urgentDeferred[0].title}» — ${urgentDeferred[0].reason}.` });
  }
  if (largestLeakage[0]) {
    actions.push({ tone: "neutral", text: `Самая крупная утечка: «${largestLeakage[0].title}» на ${Math.round(largestLeakage[0].remainingCost).toLocaleString("ru-RU")} грн.` });
  }
  if (!actions.length) {
    actions.push({ tone: "neutral", text: "Очередь спокойная: добавь желание или закрой месяц в истории." });
  }

  return {
    status,
    headline,
    actions,
    buyNow: approved,
    watch: urgentDeferred,
    postpone,
    leakage: largestLeakage,
    metrics: {
      available,
      allocated,
      remaining,
      runwayPct,
      activeCount: active.length,
      plannedCount: approvedIds.size,
      deferredCount: allocation.deferred?.length || 0,
    },
  };
}
