// Rate-limiting и определение клиента за прокси (Fly.io).
import { stmt } from "./statements.js";
import { structuredLog } from "./log.js";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 20;

export function authClientKey(req) {
  const forwarded = String(req.headers["fly-client-ip"] || req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

// Лимит на вход по PIN: персистентный (SQLite), переживает рестарты.
export function authRateLimit(req, res, next) {
  const key = authClientKey(req);
  const now = Date.now();
  const row = stmt.authAttemptByKey.get(key);
  const entry =
    row && row.reset_at > now
      ? {
          count: Number(row.count) || 0,
          resetAt: Number(row.reset_at) || now + LOGIN_WINDOW_MS,
        }
      : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "too_many_attempts", retryAfter });
  }
  entry.count += 1;
  stmt.upsertAuthAttempt.run({
    key,
    count: entry.count,
    resetAt: entry.resetAt,
  });
  req.authRateLimitKey = key;
  next();
}
setInterval(() => {
  try {
    stmt.deleteExpiredAuthAttempts.run(Date.now());
  } catch {}
}, LOGIN_WINDOW_MS).unref?.();

// CSRF-страховка поверх SameSite-куки: мутации с чужим Origin отклоняем
// (аудит 16.3). Запросы без Origin (same-origin fetch, curl, keepalive)
// пропускаем — иначе сломаем легитимные сценарии.
export function originCheck(req, res, next) {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
  const origin = String(req.headers.origin || "");
  if (!origin || origin === "null") return next();
  let originHost;
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = "";
  }
  if (originHost && originHost === String(req.headers.host || "")) return next();
  structuredLog("info", "origin_rejected", {
    requestId: req.requestId,
    origin,
    host: req.headers.host,
    path: req.originalUrl || req.url,
  });
  return res.status(403).json({ error: "bad_origin" });
}

// Лёгкие in-memory лимиты для дорогих ручек (AI, импорт, бэкапы).
const rateLimitBuckets = new Map();
export function rateLimit({ name, windowMs, max }) {
  return (req, res, next) => {
    const key = `${name}:${authClientKey(req)}`;
    const now = Date.now();
    const current = rateLimitBuckets.get(key);
    const entry =
      current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
    if (entry.count >= max) {
      const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      structuredLog("info", "rate_limited", {
        requestId: req.requestId,
        bucket: name,
        ip: authClientKey(req),
        retryAfter,
      });
      return res.status(429).json({ error: "rate_limited", retryAfter });
    }
    entry.count += 1;
    rateLimitBuckets.set(key, entry);
    next();
  };
}
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of rateLimitBuckets.entries()) {
      if (entry.resetAt <= now) rateLimitBuckets.delete(key);
    }
  },
  15 * 60 * 1000,
).unref?.();

export const aiRateLimit = rateLimit({
  name: "ai",
  windowMs: 60 * 1000,
  max: 20,
});
export const importRateLimit = rateLimit({
  name: "import",
  windowMs: 15 * 60 * 1000,
  max: 10,
});
export const backupRateLimit = rateLimit({
  name: "backup",
  windowMs: 15 * 60 * 1000,
  max: 10,
});
