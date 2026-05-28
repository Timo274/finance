// Бакеты (большие группы) и категории внутри них.
// Бакеты используются в сценариях и графиках, категории — для удобной разметки items.

export const BUCKETS = {
  survival: { label: 'Выживание / Обязательства', color: '#64748b' },
  stability: { label: 'Стабильность / Подушка', color: '#0ea5e9' },
  career: { label: 'Карьерный капитал', color: '#6366f1' },
  quality: { label: 'Качество жизни', color: '#22c55e' },
  health: { label: 'Здоровье', color: '#f59e0b' },
  gifts: { label: 'Подарки / Социальное', color: '#ec4899' },
};

export const CATEGORIES = [
  // survival
  { id: 'food', label: 'Еда / продукты', bucket: 'survival' },
  { id: 'transport', label: 'Транспорт', bucket: 'survival' },
  { id: 'connectivity', label: 'Связь / интернет', bucket: 'survival' },
  { id: 'essential_subs', label: 'Необходимые подписки', bucket: 'survival' },
  { id: 'family_debt', label: 'Родителям / долги', bucket: 'survival' },

  // stability
  { id: 'savings', label: 'Накопления', bucket: 'stability' },
  { id: 'emergency', label: 'Подушка безопасности', bucket: 'stability' },
  { id: 'insurance', label: 'Страховка', bucket: 'stability' },

  // career
  { id: 'courses', label: 'Курсы / обучение', bucket: 'career' },
  { id: 'books', label: 'Книги', bucket: 'career' },
  { id: 'work_software', label: 'Софт / подписки для учёбы', bucket: 'career' },
  { id: 'work_gear', label: 'Техника для работы', bucket: 'career' },
  { id: 'certification', label: 'Сертификации', bucket: 'career' },
  { id: 'networking', label: 'Нетворкинг / конференции', bucket: 'career' },

  // quality of life
  { id: 'clothing', label: 'Одежда / внешний вид', bucket: 'quality' },
  { id: 'dining', label: 'Кафе / рестораны', bucket: 'quality' },
  { id: 'entertainment', label: 'Развлечения', bucket: 'quality' },
  { id: 'hobby', label: 'Хобби', bucket: 'quality' },
  { id: 'travel', label: 'Путешествия', bucket: 'quality' },
  { id: 'gadgets', label: 'Гаджеты', bucket: 'quality' },

  // health
  { id: 'gym', label: 'Спортзал', bucket: 'health' },
  { id: 'nutrition', label: 'Питание / добавки', bucket: 'health' },
  { id: 'medical', label: 'Медицина', bucket: 'health' },

  // gifts / social
  { id: 'gifts', label: 'Подарки', bucket: 'gifts' },
  { id: 'events', label: 'Мероприятия', bucket: 'gifts' },
];

export const TYPES = {
  must: { label: 'Must-have', rank: 0 },
  should: { label: 'Should-have', rank: 1 },
  nice: { label: 'Nice-to-have', rank: 2 },
};

const CATEGORY_BUCKET = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.bucket]));

export function bucketForCategory(categoryId) {
  return CATEGORY_BUCKET[categoryId] || 'quality';
}
