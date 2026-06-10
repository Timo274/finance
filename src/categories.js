// Таксономия покупок.
// Слой капитала (layer) — куда относится трата (используется в сценариях/графиках).
// Категория (category) — что именно представляет покупка.
// Band — авто-классификация по размеру суммы.
// Score-критерии — для опциональной оценки спорных покупок (Quick / Full).

// ---- Слои капитала (Layer) ----
export const LAYERS = {
  survival: { label: "Survival", ru: "Выживание", color: "#64748b" },
  stability: { label: "Stability", ru: "Стабильность", color: "#0ea5e9" },
  career: { label: "Career Capital", ru: "Карьерный капитал", color: "#2f6bff" },
  investment: { label: "Investment", ru: "Инвестиции", color: "#16a34a" },
  quality: { label: "Quality of Life", ru: "Качество жизни", color: "#a855f7" },
  leakage: { label: "Leakage", ru: "Утечки", color: "#ef4444" },
};

// Совместимость: часть кода/контекста раньше называла слои «бакетами».
export const BUCKETS = LAYERS;

// ---- Категории покупки (Category) ----
export const CATEGORIES = [
  { id: "asset", label: "Asset", ru: "Актив", layer: "investment" },
  { id: "tool", label: "Tool", ru: "Инструмент", layer: "career" },
  { id: "infrastructure", label: "Infrastructure", ru: "Инфраструктура", layer: "stability" },
  { id: "growth", label: "Growth", ru: "Рост", layer: "career" },
  { id: "experience", label: "Experience", ru: "Опыт", layer: "quality" },
  { id: "lifestyle", label: "Lifestyle", ru: "Образ жизни", layer: "quality" },
  { id: "status", label: "Status", ru: "Статус", layer: "quality" },
  { id: "dopamine", label: "Dopamine", ru: "Дофамин", layer: "leakage" },
  { id: "waste", label: "Waste", ru: "Трата впустую", layer: "leakage" },
];

// ---- Тип покупки (приоритет в распределении) ----
export const TYPES = {
  must: { label: "Must-have", ru: "Обязательно", rank: 0 },
  should: { label: "Should-have", ru: "Желательно", rank: 1 },
  nice: { label: "Nice-to-have", ru: "По желанию", rank: 2 },
};

// ---- Band: авто-классификация по сумме (грн) ----
export const BANDS = [
  { id: "trivial", label: "Trivial", ru: "Мелочь", max: 300 },
  { id: "small", label: "Small", ru: "Небольшая", max: 1500 },
  { id: "medium", label: "Medium", ru: "Средняя", max: 5000 },
  { id: "large", label: "Large", ru: "Крупная", max: 12000 },
  { id: "major", label: "Major", ru: "Большая", max: null },
];

export function bandForCost(cost) {
  const c = Number(cost) || 0;
  for (const b of BANDS) {
    if (b.max == null || c < b.max) return b.id;
  }
  return "major";
}

// Какой тип оценки рекомендуется для band.
export function recommendedScoreType(band) {
  if (band === "large" || band === "major") return "full";
  if (band === "medium") return "quick";
  return "none";
}

export const SCORE_TYPES = {
  none: { ru: "Без оценки" },
  quick: { ru: "Быстрая (Quick)" },
  full: { ru: "Полная (Full)" },
};

// ---- Критерии оценки ----
// dir: 'pos' — больше = лучше, 'neg' — больше = хуже.
export const SCORE_CRITERIA = {
  quick: [
    {
      id: "retained_utility",
      ru: "Удержанная польза",
      hint: "Насколько вещь будет полезна и через месяцы",
      dir: "pos",
    },
    {
      id: "trajectory_alignment",
      ru: "Соответствие траектории",
      hint: "Двигает ли к долгосрочным целям",
      dir: "pos",
    },
    {
      id: "emotional_trigger",
      ru: "Эмоциональный триггер",
      hint: "Сколько здесь импульса «хочу сейчас»",
      dir: "neg",
    },
    {
      id: "capital_velocity",
      ru: "Скорость капитала",
      hint: "Как быстро вернёт ценность/деньги",
      dir: "pos",
    },
    {
      id: "predicted_30d",
      ru: "Ценность через 30 дней",
      hint: "Будешь ли ценить через месяц",
      dir: "pos",
    },
  ],
  full: [
    {
      id: "future_leverage",
      ru: "Будущий рычаг",
      hint: "Открывает ли новые возможности",
      dir: "pos",
    },
    {
      id: "opportunity_cost",
      ru: "Альтернативная стоимость",
      hint: "Что теряешь, потратив сюда",
      dir: "neg",
    },
    {
      id: "identity_congruence",
      ru: "Соответствие себе",
      hint: "Это «настоящий ты» или образ?",
      dir: "pos",
    },
    { id: "reversibility", ru: "Обратимость", hint: "Можно ли вернуть/перепродать", dir: "pos" },
    { id: "optionality", ru: "Опциональность", hint: "Сохраняет ли свободу выбора", dir: "pos" },
    {
      id: "social_signal_distortion",
      ru: "Соц. сигнал",
      hint: "Покупка ради впечатления других",
      dir: "neg",
    },
    {
      id: "maintenance_burden",
      ru: "Стоимость владения",
      hint: "Сколько ещё потребует потом",
      dir: "neg",
    },
    {
      id: "regret_probability",
      ru: "Вероятность сожаления",
      hint: "Шанс пожалеть о покупке",
      dir: "neg",
    },
  ],
};

const CATEGORY_LAYER = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.layer]));

export function layerForCategory(categoryId) {
  return CATEGORY_LAYER[categoryId] || "quality";
}
// Обратная совместимость со старым именем.
export const bucketForCategory = layerForCategory;
