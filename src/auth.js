import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getSetting, setSetting } from "./db.js";

const SECRET =
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === "production"
    ? ""
    : "dev-insecure-secret-change-me");
if (!SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

const COOKIE = "sap_session";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 дней
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
};

export function pinIsSet() {
  return !!getSetting("pin_hash");
}

export function setPin(pin) {
  const hash = bcrypt.hashSync(String(pin), 10);
  setSetting("pin_hash", hash);
}

export function verifyPin(pin) {
  const hash = getSetting("pin_hash");
  if (!hash) return false;
  return bcrypt.compareSync(String(pin), hash);
}

// Версия токенов: при смене PIN или «выйти на всех устройствах» версия
// инкрементируется, и все ранее выданные токены перестают действовать.
export function tokenVersion() {
  const v = parseInt(getSetting("token_version") || "1", 10);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function bumpTokenVersion() {
  setSetting("token_version", String(tokenVersion() + 1));
}

export function issueToken(res) {
  const token = jwt.sign({ sub: "owner", tv: tokenVersion() }, SECRET, {
    expiresIn: MAX_AGE,
  });
  res.cookie(COOKIE, token, { ...COOKIE_OPTIONS, maxAge: MAX_AGE * 1000 });
}

export function clearToken(res) {
  res.clearCookie(COOKIE, COOKIE_OPTIONS);
}

export function isAuthed(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  try {
    const payload = jwt.verify(token, SECRET);
    // Старые токены без tv считаем версией 1 (не разлогиниваем при деплое).
    const tv = payload?.tv ?? 1;
    return tv === tokenVersion();
  } catch {
    return false;
  }
}

export function requireAuth(req, res, next) {
  if (!isAuthed(req)) return res.status(401).json({ error: "unauthorized" });
  next();
}
