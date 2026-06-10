// Нормализация и валидация пользовательского ввода + CSV-хелперы.

// «Сегодня» считаем по Киеву, а не по UTC: иначе вечером месяц/дата
// уезжают на день вперёд-назад и ключи месяца ломаются (аудит 13.6).
export const APP_TZ = process.env.APP_TZ || "Europe/Kyiv";
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: APP_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const todayISO = () => dayFormatter.format(new Date());
export const monthForPlan = (plan) =>
  String(plan?.payday || todayISO()).slice(0, 7);

export function textValue(value, fallback = "", maxLength = 500) {
  const text = String(value ?? "")
    .trim()
    .slice(0, maxLength);
  return text || fallback;
}
export function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}
export function boundedInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}
export function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
export function isoDateValue(value, fallback = null) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return fallback;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
    ? fallback
    : text;
}

export function sanitizeEntries(entries, fields) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      const out = { id: String(entry.id || Date.now() + Math.random()) };
      for (const field of fields) {
        if (field.type === "number")
          out[field.key] = Math.max(0, Number(entry[field.key]) || 0);
        else out[field.key] = String(entry[field.key] || "").trim();
      }
      return out;
    })
    .filter((entry) =>
      fields.some((field) =>
        field.type === "number" ? entry[field.key] > 0 : entry[field.key],
      ),
    );
}
export function sanitizeManualPlan(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => ({
      itemId: Number(entry.itemId),
      amount: Math.max(0, Number(entry.amount) || 0),
    }))
    .filter((entry) => entry.itemId && entry.amount > 0);
}
export function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-20)
    .map((message) => {
      const role = message?.role === "assistant" ? "assistant" : "user";
      const content = String(message?.content || "")
        .slice(0, 4000)
        .trim();
      return { role, content };
    })
    .filter((message) => message.content);
}

// CSV: экранирование + защита от formula injection в Excel.
export function csvCell(value) {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csvLine(values) {
  return values.map(csvCell).join(",");
}
