// HTTP-клиент и словарь ошибок API. Зависимости от приложения (демо-режим,
// auth-гейт, тосты, уведомление об изменении данных) инъектируются через
// configureApi — модуль не знает про state. Вынесено из app.js (план 11.1, этап 1).

// Серверные коды ошибок -> человеческие сообщения (аудит 16.4).
export const API_ERRORS = {
  validation_failed: "Проверьте введённые данные",
  not_found: "Запись не найдена — обновите страницу",
  bad_origin: "Запрос отклонён по соображениям безопасности",
  sell_exceeds_holdings: "Продажа превышает остаток актива",
  nbu_unavailable: "Сервис НБУ недоступен, попробуйте позже",
  rate_limited: "Слишком много запросов — подождите немного",
  internal_error: "Ошибка сервера, попробуйте ещё раз",
  asset_not_found: "Актив не найден",
  bad_pin: "Неверный PIN",
  pin_too_short: "PIN слишком короткий — минимум 6 цифр",
};

export function friendlyError(data) {
  if (!data?.error) return null;
  let msg = API_ERRORS[data.error] || data.error;
  if (data.error === "sell_exceeds_holdings" && data.held != null)
    msg += ` (в наличии: ${data.held})`;
  return msg;
}

const hooks = {
  isDemo: () => false,
  onDemoWrite: () => {},
  onUnauthorized: () => {},
  onMutation: () => {},
};
export function configureApi(overrides) {
  Object.assign(hooks, overrides);
}

export const api = {
  async req(method, url, body) {
    if (hooks.isDemo()) {
      // Демо-режим: ничего не пишем и не читаем с сервера (аудит 3.9).
      if (method !== "GET") hooks.onDemoWrite();
      throw new Error("demo");
    }
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 401) {
      hooks.onUnauthorized();
      throw new Error("unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(friendlyError(data) || res.statusText);
    if (method !== "GET") hooks.onMutation();
    return data;
  },
  get: (u) => api.req("GET", u),
  post: (u, b) => api.req("POST", u, b),
  put: (u, b) => api.req("PUT", u, b),
  del: (u) => api.req("DELETE", u),
};
