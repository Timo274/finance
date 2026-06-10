// Портфель: активы, транзакции, оценки, обновление цен, legacy-эндпоинт.
import db from "../db.js";
import { stmt } from "../statements.js";
import { requireAuth } from "../auth.js";
import { getPortfolio, currentPlanId } from "../store.js";
import { CG_MAP, fetchYahooPrice, fetchCgPrice, valuationForAsset } from "../prices.js";
import { sanitizeEntries, todayISO } from "../sanitize.js";
import { structuredLog } from "../log.js";

export default function registerInvestmentRoutes(app) {
app.get("/api/investments", requireAuth, (req, res) => {
  res.json(getPortfolio());
});
app.post("/api/investments/assets", requireAuth, (req, res) => {
  const { id, name, type, ticker, currency } = req.body || {};
  const assetId = String(
    id || Date.now() + "-" + Math.random().toString(36).slice(2, 8),
  );
  const assetName = String(name || "").trim() || "Актив";
  stmt.insertAsset.run({
    id: assetId,
    name: assetName,
    type: String(type || "other").trim(),
    ticker: ticker ? String(ticker).trim() : null,
    currency: ["USD", "UAH"].includes(String(currency || "USD").toUpperCase())
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
  const qty = Math.max(0, Number(quantity) || 0);
  const px = Math.max(0, Number(price) || 0);
  const txFee = Math.max(0, Number(fee) || 0);
  const total = txType === "buy" ? qty * px + txFee : qty * px - txFee;
  stmt.insertTransaction.run({
    id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    asset_id: String(assetId),
    type: txType,
    date: date || todayISO(),
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
  if (!assetId) return res.status(400).json({ error: "assetId_required" });
  if (!stmt.assetById.get(String(assetId)))
    return res.status(404).json({ error: "asset_not_found" });
  stmt.insertValuation.run({
    id: String(Date.now() + "-" + Math.random().toString(36).slice(2, 8)),
    asset_id: String(assetId),
    date: date || todayISO(),
    value: Math.max(0, Number(value) || 0),
    quantity: quantity != null ? Math.max(0, Number(quantity) || 0) : null,
    note: note ? String(note) : "",
  });
  res.json(getPortfolio());
});
app.delete("/api/investments/valuations/:id", requireAuth, (req, res) => {
  stmt.deleteValuation.run(String(req.params.id));
  res.json(getPortfolio());
});

// Legacy investment endpoints (backward compat)
app.post("/api/investments", requireAuth, (req, res) => {
  const investments = sanitizeEntries(req.body?.investments, [
    { key: "name", type: "text" },
    { key: "accountType", type: "text" },
    { key: "amount", type: "number" },
    { key: "date", type: "text" },
    { key: "note", type: "text" },
  ]);
  const planId = currentPlanId();
  const save = db.transaction(() => {
    stmt.deleteInvestmentUpdates.run();
    investments.forEach((entry) => {
      const accountName = entry.name || "Инвестиция";
      const accountId = String(
        entry.accountId || accountName.toLowerCase().replace(/\s+/g, "-"),
      );
      const updateId = String(
        entry.id || `${accountId}-${entry.date || todayISO()}-${Date.now()}`,
      );
      stmt.upsertInvestmentAccount.run({
        id: accountId,
        name: accountName,
        type: entry.accountType || "asset",
      });
      stmt.upsertInvestmentUpdate.run({
        id: updateId,
        accountId,
        planId,
        amount: entry.amount,
        date: entry.date || todayISO(),
        note: entry.note || "",
      });
    });
    stmt.deleteUnusedInvestmentAccounts.run();
  });
  save();
  res.json(getPortfolio());
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
        if (price == null)
          errors.push({ ticker, reason: "coingecko_no_price" });
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

  if (errors.length)
    structuredLog("info", "price_refresh_errors", { errors });
  const result = getPortfolio();
  // errors теперь массив с причинами по каждому тикеру — фронт показывает детали.
  result._meta = { updated, errors };
  res.json(result);
});
}
