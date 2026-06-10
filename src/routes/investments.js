// Портфель: активы, транзакции, оценки, обновление цен, legacy-эндпоинт.
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import { getPortfolio } from "../store.js";
import { CG_MAP, fetchYahooPrice, fetchCgPrice, valuationForAsset } from "../prices.js";
import { todayISO } from "../sanitize.js";
import { structuredLog } from "../log.js";

const NUM_CAP = 1e12;
function clampNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, NUM_CAP);
}
function isoDateOrToday(v) {
  const s = String(v || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return todayISO();
  const d = new Date(s + "T00:00:00Z");
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? todayISO() : s;
}

export default function registerInvestmentRoutes(app) {
  app.get("/api/investments", requireAuth, (req, res) => {
    res.json(getPortfolio());
  });
  app.post("/api/investments/assets", requireAuth, (req, res) => {
    const { id, name, type, ticker, currency } = req.body || {};
    const assetId = String(id || Date.now() + "-" + Math.random().toString(36).slice(2, 8));
    const assetName = String(name || "").trim() || "Актив";
    stmt.insertAsset.run({
      id: assetId,
      name: assetName,
      type: String(type || "other").trim(),
      ticker: ticker ? String(ticker).trim() : null,
      currency: ["USD", "UAH", "EUR"].includes(String(currency || "USD").toUpperCase())
        ? String(currency || "USD").toUpperCase()
        : "USD",
    });
    res.json(getPortfolio());
  });
  app.delete("/api/investments/assets/:id", requireAuth, (req, res) => {
    stmt.deleteAsset.run(String(req.params.id));
    res.json(getPortfolio());
  });
  app.post("/api/investments/transactions", requireAuth, (req, res) => {
    const { assetId, type, date, quantity, price, fee, note } = req.body || {};
    if (!assetId) return res.status(400).json({ error: "assetId_required" });
    if (!stmt.assetById.get(String(assetId)))
      return res.status(404).json({ error: "asset_not_found" });
    const txType = ["buy", "sell"].includes(type) ? type : "buy";
    // Границы входных чисел и дат: 1e308/"9999-99-99" не должны попадать в БД (аудит 12.4).
    const qty = clampNum(quantity);
    const px = clampNum(price);
    const txFee = clampNum(fee);
    const txDate = isoDateOrToday(date);
    if (qty <= 0) return res.status(400).json({ error: "validation_failed", field: "quantity" });
    if (txType === "sell") {
      // Продажа больше, чем есть на руках, — ошибка ввода, а не «молчаливый кламп»
      // в отчётах (аудит 13.1).
      let held = 0;
      for (const t of stmt.allTransactions.all()) {
        if (t.asset_id !== String(assetId)) continue;
        const q = Math.max(0, Number(t.quantity) || 0);
        if (t.type === "buy") held += q;
        else if (t.type === "sell") held -= Math.min(q, held);
      }
      if (qty > held + 1e-9) return res.status(400).json({ error: "sell_exceeds_holdings", held });
    }
    const total = txType === "buy" ? qty * px + txFee : qty * px - txFee;
    stmt.insertTransaction.run({
      id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
      asset_id: String(assetId),
      type: txType,
      date: txDate,
      quantity: qty,
      price: px,
      fee: txFee,
      total_amount: Math.max(0, total),
      note: note ? String(note) : "",
    });
    res.json(getPortfolio());
  });
  app.delete("/api/investments/transactions/:id", requireAuth, (req, res) => {
    stmt.deleteTransaction.run(String(req.params.id));
    res.json(getPortfolio());
  });
  app.post("/api/investments/valuations", requireAuth, (req, res) => {
    const { assetId, date, value, quantity, note } = req.body || {};
    const safeValue = clampNum(value);
    const safeDate = isoDateOrToday(date);
    if (!assetId) return res.status(400).json({ error: "assetId_required" });
    if (!stmt.assetById.get(String(assetId)))
      return res.status(404).json({ error: "asset_not_found" });
    stmt.insertValuation.run({
      id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
      asset_id: String(assetId),
      date: safeDate,
      value: safeValue,
      quantity: quantity != null ? clampNum(quantity) : null,
      note: note ? String(note) : "",
    });
    res.json(getPortfolio());
  });
  app.delete("/api/investments/valuations/:id", requireAuth, (req, res) => {
    stmt.deleteValuation.run(String(req.params.id));
    res.json(getPortfolio());
  });

  // Legacy investment endpoints (backward compat)
  // Легаси-эндпоинт массовой перезаписи: стирал всю историю investment_updates
  // одним вызовом. Отключён — используйте /api/investments/assets|transactions.
  app.post("/api/investments", requireAuth, (req, res) => {
    res.status(410).json({
      error: "endpoint_removed",
      message:
        "Bulk-перезапись инвестиций отключена: она стирала всю историю. Используйте /api/investments/assets и /api/investments/transactions.",
    });
  });

  app.post("/api/investments/refresh-prices", requireAuth, async (req, res) => {
    const assets = stmt.allAssets.all().filter((a) => a.ticker);
    let updated = 0;
    const errors = [];

    for (const asset of assets) {
      const ticker = asset.ticker.trim().toUpperCase();
      try {
        const type = (asset.type || "").toLowerCase();
        let price = null;
        let quoteCurrency = "USD";

        if (type === "crypto") {
          const cgId = CG_MAP[ticker.toLowerCase()];
          if (!cgId) {
            errors.push({ ticker, reason: "unknown_crypto_ticker" });
            continue;
          }
          price = await fetchCgPrice(cgId);
          if (price == null) errors.push({ ticker, reason: "coingecko_no_price" });
        } else {
          // stock, etf, bond, other — через Yahoo Finance
          const quote = await fetchYahooPrice(ticker);
          if (!quote) {
            errors.push({ ticker, reason: "yahoo_no_price" });
            continue;
          }
          price = quote.price;
          quoteCurrency = quote.currency;
        }

        if (price != null && price > 0) {
          const ok = await valuationForAsset(asset, price, quoteCurrency);
          if (ok) updated++;
          else errors.push({ ticker, reason: "no_quantity_held" });
        }
      } catch (e) {
        errors.push({ ticker, reason: String(e.message || e) });
      }
    }

    if (errors.length) structuredLog("info", "price_refresh_errors", { errors });
    const result = getPortfolio();
    // errors теперь массив с причинами по каждому тикеру — фронт показывает детали.
    result._meta = { updated, errors };
    res.json(result);
  });
}
