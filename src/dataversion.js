// Версия данных для синхронизации вкладок/устройств: любая успешная
// мутация (POST/PUT/DELETE) поднимает версию, фронт опрашивает /api/version.
let dataVersion = Date.now();

export function getDataVersion() {
  return dataVersion;
}
export function bumpDataVersion() {
  dataVersion = Date.now();
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
