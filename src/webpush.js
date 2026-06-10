// Web Push без зависимостей: VAPID (RFC 8292) + шифрование aes128gcm (RFC 8291/8188)
// на чистом node:crypto. Ключи VAPID генерируются один раз и живут в settings.
import crypto from "node:crypto";
import { getJSON, setJSON } from "./db.js";

const CURVE = "prime256v1";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:owner@salary-planner.local";

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64(value) {
  // Подписки могут присылать ключи и в base64, и в base64url.
  const normalized = String(value || "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return Buffer.from(normalized, "base64url");
}

export function getVapidKeys() {
  let keys = getJSON("vapid_keys", null);
  if (keys?.publicKey && keys?.privateKey) return keys;
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  keys = {
    publicKey: b64url(ecdh.getPublicKey()),
    privateKey: b64url(ecdh.getPrivateKey()),
  };
  setJSON("vapid_keys", keys);
  return keys;
}

function vapidAuthHeader(endpoint, keys) {
  const aud = new URL(endpoint).origin;
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64url(
    JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: VAPID_SUBJECT,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const pub = fromB64(keys.publicKey); // 65 байт: 0x04 || x || y
  const privateKey = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: keys.privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
    format: "jwk",
  });
  const signature = crypto.sign("sha256", Buffer.from(unsigned), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${b64url(signature)}, k=${keys.publicKey}`;
}

function hkdf(salt, ikm, info, length) {
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
}

// RFC 8291: шифруем полезную нагрузку под ключи подписки (p256dh + auth).
export function encryptPayload(plaintext, p256dh, auth) {
  const uaPublic = fromB64(p256dh);
  const authSecret = fromB64(auth);
  const ecdh = crypto.createECDH(CURVE);
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  const padded = Buffer.concat([Buffer.from(String(plaintext)), Buffer.from([2])]);
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/**
 * Отправить push-уведомление по подписке.
 * @returns {Promise<{ok:boolean,status:number,gone:boolean}>} gone=true — подписка мертва, удалить.
 */
export async function sendPush(subscription, payload, keys = getVapidKeys()) {
  const body = encryptPayload(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    subscription.p256dh,
    subscription.auth,
  );
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      Urgency: "normal",
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Content-Length": String(body.length),
      Authorization: vapidAuthHeader(subscription.endpoint, keys),
    },
    body,
  });
  // 404/410 — endpoint протух, подписку нужно удалить.
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
