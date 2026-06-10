// Прайс-фиды (Yahoo Finance, CoinGecko) и запись оценок активов.
import { stmt } from "./statements.js";
import { currencyRate, eurRate } from "./db.js";
import { todayISO } from "./sanitize.js";

export const CG_MAP = {
  btc: "bitcoin",
  eth: "ethereum",
  sol: "solana",
  xrp: "ripple",
  ada: "cardano",
  dot: "polkadot",
  avax: "avalanche-2",
  matic: "matic-network",
  link: "chainlink",
  atom: "cosmos",
  uni: "uniswap",
  ltc: "litecoin",
  bch: "bitcoin-cash",
  near: "near",
  trx: "tron",
  fil: "filecoin",
  apt: "aptos",
  arb: "arbitrum",
  op: "optimism",
  inj: "injective",
  doge: "dogecoin",
  pepe: "pepe",
  sui: "sui",
  sei: "sei-network",
};

export async function fetchYahooPrice(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d`;
  const resp = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta?.regularMarketPrice) return null;
  // Берём валюту котировки из ответа: акции бывают и в EUR/GBP/UAH, не только USD.
  return {
    price: meta.regularMarketPrice,
    currency: String(meta.currency || "USD").toUpperCase(),
  };
}

export async function fetchCgPrice(cgId) {
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd`;
  const resp = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.[cgId]?.usd || null;
}

export async function valuationForAsset(asset, price, quoteCurrencyRaw) {
  if (!price || price <= 0) return false;
  const txs = stmt.transactionsByAsset.all(asset.id);
  const qty = txs.reduce(
    (s, t) => s + (t.type === "buy" ? t.quantity : -t.quantity),
    0,
  );
  if (qty <= 0) return false;
  // Валюта котировки приходит от прайс-фида (Yahoo meta.currency / CoinGecko=USD),
  // а не из asset.currency — иначе UAH-актив с USD-котировкой считался без курса.
  const quoteCurrency = String(
    quoteCurrencyRaw || asset.currency || "USD",
  ).toUpperCase();
  const rate =
    quoteCurrency === "UAH"
      ? 1
      : quoteCurrency === "EUR"
        ? eurRate()
        : currencyRate();
  const valueUah = qty * price * rate;
  stmt.insertValuation.run({
    id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    asset_id: asset.id,
    date: todayISO(),
    value: Math.round(valueUah * 100) / 100,
    quantity: qty,
    note: `PriceFeed auto (${quoteCurrency} ${price})`,
  });
  return true;
}

