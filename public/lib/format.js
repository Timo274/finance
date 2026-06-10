// Чистые функции форматирования и словари подписей — без обращения к state.
// Вынесено из app.js (план 11.1, этап 1).

export const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU") + " грн";
export const fmtShort = (n) => Math.round(Number(n) || 0).toLocaleString("ru-RU");

export function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// Проценты, дающие в сумме ровно 100 (метод наибольших остатков):
// иначе независимые Math.round дают 99/101% (аудит 7.1).
export function roundPercents(values, total) {
  if (!total || total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, Number(v) || 0) / total) * 100);
  const floors = raw.map(Math.floor);
  let left = Math.round(raw.reduce((s, v) => s + v, 0)) - floors.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => ({ i, frac: v - Math.floor(v) })).sort((a, b) => b.frac - a.frac);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors;
}

export function escapeHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}
export function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export const TYPE_LABELS = { must: "Обязательно", should: "Желательно", nice: "По желанию" };
export const STATUS_LABELS = {
  safe: "Безопасно",
  tight: "Впритык",
  overallocated: "Перерасход",
};
export const VERDICT_LABELS = {
  keep: "Брать",
  reconsider: "Подумать",
  drop: "Отказаться",
};
export const queueStatusLabel = {
  all: "Все",
  funded: "Копится",
  complete: "Накоплено",
  planned: "В плане",
};

// --- эмодзи-приколюхи: подбираем иконку желания по названию ---
export const WISH_EMOJI_RULES = [
  [/macbook|ноутбук|laptop|компьютер|видеокарт|\bпк\b|\bpc\b/i, "💻"],
  [/iphone|айфон|телефон|смартфон|pixel|galaxy/i, "📱"],
  [/playstation|\bps[45]\b|xbox|nintendo|switch|steam *deck|консол|игров/i, "🎮"],
  [/кроссовк|кеды|ботин|обувь|туфл|sneaker/i, "👟"],
  [/куртк|пальто|джинс|худи|футболк|одежд|костюм|плать/i, "🧥"],
  [/резин|шин[аы]|колес|колёс/i, "🛞"],
  [/машин|\bавто\b|bmw|audi|tesla|toyota/i, "🚗"],
  [/велосипед|самокат|\bbike\b/i, "🚲"],
  [/подарок|подарк|\bgift\b/i, "🎁"],
  [/путешеств|отпуск|поездк|билет|trip|мор[ея]/i, "✈️"],
  [/час(ы|ов)\b|watch/i, "⌚"],
  [/наушник|airpods|колонк|саундбар/i, "🎧"],
  [/камер|фотоаппарат|объектив|gopro/i, "📷"],
  [/телевизор|монитор|\bтв\b|\btv\b|oled/i, "📺"],
  [/ремонт|мебел|диван|кресл|шкаф|матрас/i, "🛋️"],
  [/курс|обучен|книг|учеб|школ/i, "📚"],
  [/спортзал|тренаж|гантел|абонемент|фитнес/i, "🏋️"],
  [/кофемашин|кофеварк|кофе/i, "☕"],
  [/собак|кошк|\bкот\b|питомц/i, "🐾"],
  [/дрель|шуруповёрт|инструмент|перфоратор/i, "🛠️"],
  [/страховк|депозит|резерв|подушк/i, "🛡️"],
];
export const CATEGORY_EMOJI = {
  asset: "💎",
  tool: "🛠️",
  infrastructure: "🏗️",
  growth: "🚀",
  experience: "🌍",
  lifestyle: "🛋️",
  status: "👑",
  dopamine: "🍩",
  waste: "🗑️",
};
export function wishEmoji(item) {
  const title = String(item?.title || "");
  for (const [re, emoji] of WISH_EMOJI_RULES) if (re.test(title)) return emoji;
  return CATEGORY_EMOJI[item?.category] || "✨";
}
export function wishEmojiTag(item) {
  return `<span class="wish-emoji" aria-hidden="true">${wishEmoji(item)}</span>`;
}
