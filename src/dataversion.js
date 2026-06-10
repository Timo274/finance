// Версия данных для синхронизации вкладок/устройств: любая успешная
// мутация (POST/PUT/DELETE) поднимает версию, фронт опрашивает /api/version.
// Версия хранится в settings: рестарт процесса (deploy, fly auto_stop)
// больше не выглядит для клиентов как «всё изменилось» (аудит 12.2).
import { getSetting, setSetting } from "./db.js";

const KEY = "data_version";
let dataVersion = Number(getSetting(KEY)) || Date.now();
// Подписчики SSE: версия пушится при изменении, без поллинга (аудит 17.2).
const subscribers = new Set();
export function onVersionChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getDataVersion() {
  return dataVersion;
}
export function bumpDataVersion() {
  // Монотонность: при быстрых мутациях в один мс всё равно растём.
  dataVersion = Math.max(Date.now(), dataVersion + 1);
  try {
    setSetting(KEY, String(dataVersion));
  } catch {}
  for (const fn of subscribers) {
    try {
      fn(dataVersion);
    } catch {}
  }
}
export function dataVersionMiddleware(req, res, next) {
  const m = req.method.toUpperCase();
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    res.on("finish", () => {
      if (res.statusCode < 400) bumpDataVersion();
    });
  }
  next();
}
