// Capital Queue — тонкая точка входа.
// Вся логика разнесена по модулям в src/: данные (store), middleware,
// маршруты (src/routes/*), бэкапы, напоминания, статика.
import "dotenv/config";
import express from "express";
import cookieParser from "cookie-parser";
import compression from "compression";
import crypto from "node:crypto";

import db from "./src/db.js";
import { structuredLog } from "./src/log.js";
import { authClientKey, originCheck } from "./src/middleware.js";
import { dataVersionMiddleware } from "./src/dataversion.js";
import { scheduleBackups } from "./src/backups.js";
import { scheduleReminders } from "./src/reminders.js";
import { registerStatic, STATIC_VERSION } from "./src/staticfiles.js";

import registerAuthRoutes from "./src/routes/auth.js";
import registerPlanRoutes from "./src/routes/plan.js";
import registerItemRoutes from "./src/routes/items.js";
import registerAllocationRoutes from "./src/routes/allocation.js";
import registerInvestmentRoutes from "./src/routes/investments.js";
import registerWalletRoutes from "./src/routes/wallets.js";
import registerDataRoutes from "./src/routes/data.js";
import registerAiRoutes from "./src/routes/ai.js";
import registerIntegrationRoutes from "./src/routes/integrations.js";

export { STATIC_VERSION };
export const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

// ---------- security headers ----------
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  if (process.env.NODE_ENV === "production")
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
});

// ---------- request id + структурированный лог запросов ----------
app.use((req, res, next) => {
  const rawRequestId = String(req.headers["x-request-id"] || "").trim();
  const requestId = rawRequestId.slice(0, 100) || crypto.randomUUID();
  const startedAt = performance.now();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  res.on("finish", () => {
    if (req.path === "/healthz" && res.statusCode < 500) return;
    structuredLog(res.statusCode >= 500 ? "error" : "info", "http_request", {
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      ip: authClientKey(req),
    });
  });
  next();
});

// Импорт бэкапа может быть заметно больше обычных запросов — отдельный лимит 10mb.
const jsonParser = express.json({ limit: "1mb" });
const importJsonParser = express.json({ limit: "10mb" });
app.use((req, res, next) => {
  if (req.path === "/api/import" || req.path === "/api/import/validate")
    return importJsonParser(req, res, next);
  return jsonParser(req, res, next);
});
app.use(cookieParser());
// gzip/brotli для JSON и статики: app.js ~120KB → в разы меньше по сети (аудит 17.4).
app.use(
  compression({
    // SSE нельзя буферизовать — события должны уходить сразу (аудит 17.2).
    filter: (req, res) =>
      req.path === "/api/events" ? false : compression.filter(req, res),
  }),
);
// Мутации принимаем только со своего Origin (аудит 16.3).
app.use(originCheck);

app.get("/healthz", (req, res) => {
  try {
    db.prepare("SELECT 1").get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use(dataVersionMiddleware);

// ---------- API-маршруты ----------
registerAuthRoutes(app);
registerDataRoutes(app);
registerPlanRoutes(app);
registerItemRoutes(app);
registerAllocationRoutes(app);
registerInvestmentRoutes(app);
registerWalletRoutes(app);
registerAiRoutes(app);
registerIntegrationRoutes(app);

// ---------- API errors ----------
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found" });
});
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  structuredLog("error", "request_error", {
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl || req.url,
    error: error?.message || String(error),
  });
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ error: "internal_error" });
  }
  next(error);
});

// ---------- статика ----------
registerStatic(app);

export function startServer(port = process.env.PORT || 3000) {
  scheduleBackups();
  scheduleReminders();
  return app.listen(port, () =>
    console.log(`Salary Allocation Planner на http://localhost:${port}`),
  );
}

if (process.env.NODE_ENV !== "test" && process.env.NO_LISTEN !== "1") {
  startServer();
}
