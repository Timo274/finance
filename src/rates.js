// Курсы валют НБУ с дневным кэшем в settings (аудит 13.4).
// Авто-обновление раз в день в фоновом свипе; ручной ввод курса
// (POST /api/currency) ставит source=manual и отключает авто до явного refresh.
import { getSetting, setSetting, setCurrencyRate, setEurRate } from "./db.js";
import { todayISO } from "./sanitize.js";
import { structuredLog } from "./log.js";

const NBU_API = "https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json";

export async function fetchNbuRates() {
  const res = await fetch(NBU_API, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`nbu_http_${res.status}`);
  const list = await res.json();
  const find = (cc) => Number(list.find?.((r) => r.cc === cc)?.rate) || null;
  const usd = find("USD");
  const eur = find("EUR");
  if (!usd || !eur) throw new Error("nbu_missing_rates");
  const round = (v) => Math.round(v * 100) / 100;
  return { usd: round(usd), eur: round(eur) };
}

export function rateSource() {
  return getSetting("currency_rate_source") || "default";
}
export function markRatesManual() {
  setSetting("currency_rate_source", "manual");
}

/**
 * Обновить курсы из НБУ. Без force уважает ручной override и дневной кэш.
 * Возвращает { updated, usd?, eur?, reason? }; сетевые ошибки пробрасывает.
 */
export async function refreshRatesFromNbu({ force = false } = {}) {
  const today = todayISO();
  if (!force) {
    if (rateSource() === "manual") return { updated: false, reason: "manual_override" };
    if (getSetting("rate_refresh_date") === today)
      return { updated: false, reason: "already_refreshed_today" };
  }
  const rates = await fetchNbuRates();
  setCurrencyRate(rates.usd);
  setEurRate(rates.eur);
  setSetting("currency_rate_source", "nbu");
  setSetting("rate_refresh_date", today);
  structuredLog("info", "nbu_rates_refreshed", rates);
  return { updated: true, ...rates };
}
