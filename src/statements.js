// Все prepared statements SQLite в одном месте + базовые дефолты.
import db from "./db.js";

// Разумные дефолты под жизнь с родителями и доход ~25k грн.
export const DEFAULTS = {
  salary: 25000,
  survivalCost: 6000,
  buffer: 1000,
  investmentFixed: 2000,
};
export const SETTINGS = {
  investments: "investments",
  monthlyWallets: "monthly_wallets",
  manualPlan: "manual_plan",
};

export const stmt = {
  authAttemptByKey: db.prepare(
    "SELECT key, count, reset_at FROM auth_attempts WHERE key = ?",
  ),
  upsertAuthAttempt:
    db.prepare(`INSERT INTO auth_attempts (key, count, reset_at, updated_at)
    VALUES (@key, @count, @resetAt, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET count=excluded.count, reset_at=excluded.reset_at, updated_at=datetime('now')`),
  deleteAuthAttempt: db.prepare("DELETE FROM auth_attempts WHERE key = ?"),
  deleteExpiredAuthAttempts: db.prepare(
    "DELETE FROM auth_attempts WHERE reset_at <= ?",
  ),

  activePlan: db.prepare(
    "SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1",
  ),
  planById: db.prepare("SELECT * FROM plans WHERE id = ?"),
  insertPlan: db.prepare(
    "INSERT INTO plans (name, payday, salary, survival_cost, buffer, investment_fixed) VALUES (@name, @payday, @salary, @survivalCost, @buffer, @investmentFixed)",
  ),
  updatePlan: db.prepare(
    "UPDATE plans SET name=@name, payday=@payday, salary=@salary, survival_cost=@survivalCost, buffer=@buffer, investment_fixed=@investmentFixed WHERE id=@id",
  ),
  closePlan: db.prepare(
    "UPDATE plans SET status='closed', snapshot=@snapshot, closed_at=datetime('now') WHERE id=@id",
  ),
  closedPlans: db.prepare(
    "SELECT * FROM plans WHERE status='closed' ORDER BY closed_at DESC",
  ),

  activeItems: db.prepare(
    "SELECT * FROM items WHERE status='active' ORDER BY id DESC",
  ),
  allItems: db.prepare("SELECT * FROM items ORDER BY id DESC"),
  itemById: db.prepare("SELECT * FROM items WHERE id = ?"),
  insertItem: db.prepare(`INSERT INTO items
    (title, cost, category, bucket, band, score_type, scores, priority, type, deadline, earliest_date, can_defer, emotional, trajectory, notes, recurring, url, currency, cost_original)
    VALUES (@title,@cost,@category,@layer,@band,@scoreType,@scores,@priority,@type,@deadline,@earliestDate,@canDefer,@emotional,@trajectory,@notes,@recurring,@url,@currency,@costOriginal)`),
  updateItem: db.prepare(`UPDATE items SET
    title=@title, cost=@cost, category=@category, bucket=@layer, band=@band, score_type=@scoreType, scores=@scores,
    priority=@priority, type=@type, deadline=@deadline, earliest_date=@earliestDate, can_defer=@canDefer, emotional=@emotional,
    trajectory=@trajectory, notes=@notes, recurring=@recurring, url=@url, currency=@currency, cost_original=@costOriginal,
    updated_at=datetime('now') WHERE id=@id`),
  itemsWithUrl: db.prepare(
    "SELECT * FROM items WHERE status='active' AND url IS NOT NULL AND url != ''",
  ),
  nonUahItems: db.prepare(
    "SELECT * FROM items WHERE currency != 'UAH' AND cost_original IS NOT NULL",
  ),
  updateItemCostBand: db.prepare(
    "UPDATE items SET cost=@cost, band=@band, updated_at=datetime('now') WHERE id=@id",
  ),
  updateItemLinkPrice: db.prepare(
    "UPDATE items SET link_price=@linkPrice, link_price_at=datetime('now') WHERE id=@id",
  ),
  setItemStatus: db.prepare(
    "UPDATE items SET status=@status, updated_at=datetime('now') WHERE id=@id",
  ),
  deleteItem: db.prepare("DELETE FROM items WHERE id = ?"),
  updateItemSavings: db.prepare(
    "UPDATE items SET saved_amount=@savedAmount, updated_at=datetime('now') WHERE id=@id",
  ),

  walletsByPlan: db.prepare(
    "SELECT * FROM wallets WHERE plan_id IS @planId ORDER BY created_at DESC",
  ),
  upsertWallet:
    db.prepare(`INSERT INTO wallets (id, plan_id, name, purpose, amount, month)
    VALUES (@id, @planId, @name, @purpose, @amount, @month)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, purpose=excluded.purpose,
      amount=excluded.amount, month=excluded.month, updated_at=datetime('now')`),
  deleteWalletsForPlan: db.prepare(
    "DELETE FROM wallets WHERE plan_id IS @planId",
  ),

  goalsByItems: db.prepare(
    "SELECT * FROM goals WHERE item_id IN (SELECT id FROM items) ORDER BY updated_at DESC",
  ),
  goalByItem: db.prepare("SELECT * FROM goals WHERE item_id = ?"),
  upsertGoal:
    db.prepare(`INSERT INTO goals (item_id, target_amount, saved_amount, monthly_contribution, deadline, status)
    VALUES (@itemId, @targetAmount, @savedAmount, @monthlyContribution, @deadline, @status)
    ON CONFLICT(item_id) DO UPDATE SET target_amount=excluded.target_amount,
      saved_amount=excluded.saved_amount, monthly_contribution=excluded.monthly_contribution,
      deadline=excluded.deadline, status=excluded.status, updated_at=datetime('now')`),
  insertGoalContribution:
    db.prepare(`INSERT INTO goal_contributions (goal_id, plan_id, amount, date, note)
    VALUES (@goalId, @planId, @amount, @date, @note)`),
  contributionsByGoal: db.prepare(
    "SELECT * FROM goal_contributions WHERE goal_id = ? ORDER BY date DESC, id DESC",
  ),
  allGoalContributions: db.prepare(
    "SELECT * FROM goal_contributions ORDER BY id",
  ),
  insertGoalContributionFull:
    db.prepare(`INSERT INTO goal_contributions (id, goal_id, plan_id, amount, date, note, created_at)
    VALUES (@id, @goalId, @planId, @amount, @date, @note, @createdAt)`),

  pushSubscriptions: db.prepare("SELECT * FROM push_subscriptions"),
  insertPushSubscription:
    db.prepare(`INSERT INTO push_subscriptions (endpoint, p256dh, auth)
    VALUES (@endpoint, @p256dh, @auth)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh, auth=excluded.auth`),
  deletePushSubscription: db.prepare(
    "DELETE FROM push_subscriptions WHERE endpoint = ?",
  ),

  investmentUpdates:
    db.prepare(`SELECT iu.*, ia.name AS account_name, ia.type AS account_type
    FROM investment_updates iu JOIN investment_accounts ia ON ia.id = iu.account_id
    ORDER BY iu.date DESC, iu.created_at DESC`),
  upsertInvestmentAccount:
    db.prepare(`INSERT INTO investment_accounts (id, name, type)
    VALUES (@id, @name, @type)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, updated_at=datetime('now')`),
  upsertInvestmentUpdate:
    db.prepare(`INSERT INTO investment_updates (id, account_id, plan_id, amount, date, note)
    VALUES (@id, @accountId, @planId, @amount, @date, @note)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, plan_id=excluded.plan_id,
      amount=excluded.amount, date=excluded.date, note=excluded.note`),
  deleteInvestmentUpdates: db.prepare("DELETE FROM investment_updates"),
  deleteUnusedInvestmentAccounts: db.prepare(
    "DELETE FROM investment_accounts WHERE id NOT IN (SELECT account_id FROM investment_updates)",
  ),

  decisionsByPlan: db.prepare(
    "SELECT * FROM allocation_decisions WHERE plan_id IS @planId AND source='manual' ORDER BY updated_at DESC",
  ),
  upsertDecision:
    db.prepare(`INSERT INTO allocation_decisions (plan_id, item_id, amount, scenario, source)
    VALUES (@planId, @itemId, @amount, @scenario, 'manual')
    ON CONFLICT(plan_id, item_id, source) DO UPDATE SET amount=excluded.amount,
      scenario=excluded.scenario, updated_at=datetime('now')`),
  deleteDecisionsForPlan: db.prepare(
    "DELETE FROM allocation_decisions WHERE plan_id IS @planId AND source='manual'",
  ),
  deleteGoal: db.prepare("DELETE FROM goals WHERE id = ?"),
  deleteGoalByItem: db.prepare("DELETE FROM goals WHERE item_id = ?"),
  allGoals: db.prepare("SELECT * FROM goals ORDER BY updated_at DESC"),
  allWallets: db.prepare("SELECT * FROM wallets ORDER BY created_at DESC"),
  allDecisions: db.prepare(
    "SELECT * FROM allocation_decisions ORDER BY updated_at DESC",
  ),
  allInvestmentAccounts: db.prepare(
    "SELECT * FROM investment_accounts ORDER BY name",
  ),
  deleteWalletById: db.prepare("DELETE FROM wallets WHERE id = ?"),

  // New investment model
  allAssets: db.prepare("SELECT * FROM investment_assets ORDER BY name"),
  assetById: db.prepare("SELECT * FROM investment_assets WHERE id = ?"),
  insertAsset:
    db.prepare(`INSERT INTO investment_assets (id, name, type, ticker, currency)
    VALUES (@id, @name, @type, @ticker, @currency)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,
      ticker=excluded.ticker, currency=excluded.currency, updated_at=datetime('now')`),
  deleteAsset: db.prepare("DELETE FROM investment_assets WHERE id = ?"),

  transactionsByAsset: db.prepare(
    "SELECT * FROM asset_transactions WHERE asset_id = ? ORDER BY date DESC, created_at DESC",
  ),
  allTransactions: db.prepare(
    "SELECT * FROM asset_transactions ORDER BY date DESC, created_at DESC",
  ),
  insertTransaction:
    db.prepare(`INSERT INTO asset_transactions (id, asset_id, type, date, quantity, price, fee, total_amount, note)
    VALUES (@id, @asset_id, @type, @date, @quantity, @price, @fee, @total_amount, @note)`),
  deleteTransaction: db.prepare("DELETE FROM asset_transactions WHERE id = ?"),

  valuationsByAsset: db.prepare(
    "SELECT * FROM asset_valuations WHERE asset_id = ? ORDER BY date DESC, created_at DESC",
  ),
  allValuations: db.prepare(
    "SELECT * FROM asset_valuations ORDER BY date DESC, created_at DESC",
  ),
  // Одна оценка на (актив, дату): повторная запись за тот же день обновляет значение.
  insertValuation:
    db.prepare(`INSERT INTO asset_valuations (id, asset_id, date, value, quantity, note)
    VALUES (@id, @asset_id, @date, @value, @quantity, @note)
    ON CONFLICT(asset_id, date) DO UPDATE SET value=excluded.value,
      quantity=excluded.quantity, note=excluded.note, created_at=datetime('now')`),
  deleteValuation: db.prepare("DELETE FROM asset_valuations WHERE id = ?"),
};
