// Monobank: «план vs факт» по тратам текущего месяца.
// API жёстко лимитировано (выписка — 1 запрос в 60 секунд), поэтому кэшируем агрессивно.
const API = "https://api.monobank.ua";
const CACHE_MINUTES = 10;
const TOKEN = () => process.env.MONOBANK_TOKEN || "";

export function monobankEnabled() {
  return !!TOKEN();
}

// MCC → человеческая группа трат (минимальный, но покрывает 90% карточных трат).
const MCC_GROUPS = [
  { label: "Продукты", test: (m) => [5411, 5422, 5441, 5451, 5462, 5499, 5921].includes(m) },
  { label: "Кафе и рестораны", test: (m) => (m >= 5811 && m <= 5814) || m === 5462 },
  { label: "Транспорт и такси", test: (m) => [4111, 4112, 4121, 4131, 4789, 4011].includes(m) },
  {
    label: "Авто и топливо",
    test: (m) => [5541, 5542, 5531, 5532, 5533, 7523, 7531, 7538].includes(m),
  },
  { label: "Коммуналка и связь", test: (m) => [4814, 4815, 4899, 4900].includes(m) },
  { label: "Здоровье", test: (m) => (m >= 8011 && m <= 8099) || [5912, 5122].includes(m) },
  {
    label: "Развлечения",
    test: (m) => (m >= 7800 && m <= 7999) || [5815, 5816, 5817, 5818].includes(m),
  },
  {
    label: "Шопинг",
    test: (m) =>
      (m >= 5611 && m <= 5699) ||
      [5311, 5331, 5399, 5732, 5733, 5734, 5735, 5941, 5942, 5945, 5977].includes(m),
  },
];

function mccGroup(mcc) {
  const m = Number(mcc) || 0;
  for (const g of MCC_GROUPS) if (g.test(m)) return g.label;
  return "Другое";
}

let cache = { key: "", at: 0, data: null };
let lastApiCall = 0;

async function mbFetch(path) {
  // Грубая защита от rate limit: не чаще 1 запроса в 61 сек на выписку.
  const res = await fetch(`${API}${path}`, {
    headers: { "X-Token": TOKEN() },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429) throw new Error("monobank_rate_limited");
  if (!res.ok) throw new Error(`monobank_http_${res.status}`);
  return res.json();
}

/**
 * Сводка трат за месяц (по умолчанию — текущий) по основной карте.
 * Кэш: 10 минут (или до явного refresh, но не чаще 1 раза в 65 сек).
 */
export async function getMonthSummary({ month, refresh = false } = {}) {
  if (!monobankEnabled()) return { enabled: false };
  const targetMonth = month || new Date().toISOString().slice(0, 7);
  const now = Date.now();
  const cacheTtl = CACHE_MINUTES * 60 * 1000;
  const fresh = cache.key === targetMonth && now - cache.at < cacheTtl;
  const canCallApi = now - lastApiCall > 65 * 1000;
  if (cache.data && (fresh || !canCallApi) && (!refresh || !canCallApi)) {
    return { ...cache.data, cached: true };
  }

  lastApiCall = now;
  const monthStart = new Date(`${targetMonth}-01T00:00:00Z`);
  const monthEndMs = Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1) - 1000;
  const from = Math.floor(monthStart.getTime() / 1000);
  // Для прошлых месяцев нельзя тянуть диапазон до «сейчас»: API ограничивает
  // выписку 31 днём и вернёт 400. Обрезаем концом месяца.
  const to = Math.floor(Math.min(now, monthEndMs) / 1000);
  // account "0" — основной счёт; отдельный запрос client-info не делаем, чтобы
  // не съедать лимит (для plan/fact достаточно основной карты).
  const statements = await mbFetch(`/personal/statement/0/${from}/${to}`);

  let spent = 0;
  let income = 0;
  const byGroup = new Map();
  const biggest = [];
  for (const tx of Array.isArray(statements) ? statements : []) {
    const amount = (Number(tx.amount) || 0) / 100; // копейки → грн
    if (amount < 0) {
      const abs = Math.abs(amount);
      spent += abs;
      const g = mccGroup(tx.mcc);
      byGroup.set(g, (byGroup.get(g) || 0) + abs);
      biggest.push({ description: tx.description || "", amount: abs, time: tx.time });
    } else {
      income += amount;
    }
  }
  biggest.sort((a, b) => b.amount - a.amount);

  const data = {
    enabled: true,
    month: targetMonth,
    totals: {
      spent: Math.round(spent),
      income: Math.round(income),
      operations: Array.isArray(statements) ? statements.length : 0,
    },
    topCategories: [...byGroup.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, amount]) => ({ label, amount: Math.round(amount) })),
    biggest: biggest.slice(0, 5).map((b) => ({ ...b, amount: Math.round(b.amount) })),
    fetchedAt: new Date().toISOString(),
  };
  cache = { key: targetMonth, at: now, data };
  return data;
}
