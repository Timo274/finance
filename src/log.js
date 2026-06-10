// Структурированные JSON-логи: один формат для запросов, ошибок и фоновых задач.
export function structuredLog(level, event, fields = {}) {
  if (process.env.NODE_ENV === "test") return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}
