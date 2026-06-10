// Аутентификация: PIN, сессии, смена PIN, выход на всех устройствах.
import {
  pinIsSet,
  setPin,
  verifyPin,
  issueToken,
  clearToken,
  isAuthed,
  requireAuth,
  bumpTokenVersion,
} from "../auth.js";
import { stmt } from "../statements.js";
import { authRateLimit } from "../middleware.js";
import { structuredLog } from "../log.js";

export default function registerAuthRoutes(app) {
app.get("/api/auth/status", (req, res) => {
  const pinSet = pinIsSet();
  res.json({
    pinSet,
    authed: isAuthed(req),
    setupTokenRequired: !pinSet && !!process.env.SETUP_TOKEN,
  });
});

app.post("/api/auth/setup", (req, res) => {
  if (pinIsSet()) return res.status(400).json({ error: "pin_already_set" });
  if (
    process.env.SETUP_TOKEN &&
    String(req.body?.setupToken || "") !== process.env.SETUP_TOKEN
  ) {
    return res.status(403).json({ error: "bad_setup_token" });
  }
  const pin = String(req.body?.pin || "");
  // Новые PIN — минимум 6 цифр: 4 цифры перебираются офлайн за секунды (аудит 16.1).
  if (pin.length < 6) return res.status(400).json({ error: "pin_too_short" });
  setPin(pin);
  issueToken(res);
  res.json({ ok: true });
});

app.post("/api/auth/login", authRateLimit, (req, res) => {
  const pin = String(req.body?.pin || "");
  if (!verifyPin(pin)) return res.status(401).json({ error: "bad_pin" });
  if (req.authRateLimitKey) stmt.deleteAuthAttempt.run(req.authRateLimitKey);
  issueToken(res);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

// Смена PIN: требует текущий PIN. Инвалидирует все старые сессии.
app.post("/api/auth/change-pin", requireAuth, authRateLimit, (req, res) => {
  const currentPin = String(req.body?.currentPin || "");
  const newPin = String(req.body?.newPin || "");
  if (!verifyPin(currentPin)) return res.status(401).json({ error: "bad_pin" });
  if (newPin.length < 6) return res.status(400).json({ error: "pin_too_short" });
  if (req.authRateLimitKey) stmt.deleteAuthAttempt.run(req.authRateLimitKey);
  setPin(newPin);
  bumpTokenVersion();
  issueToken(res); // текущее устройство остаётся залогиненным
  structuredLog("info", "pin_changed", { requestId: req.requestId });
  res.json({ ok: true });
});

// «Выйти на всех устройствах»: поднимает версию токенов, все cookie протухают.
app.post("/api/auth/logout-all", requireAuth, (req, res) => {
  bumpTokenVersion();
  clearToken(res);
  structuredLog("info", "logout_all", { requestId: req.requestId });
  res.json({ ok: true });
});
}
