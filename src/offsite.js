// Offsite-копия бэкапа в приватный GitHub-репозиторий (Contents API).
// Включается переменными окружения:
//   GITHUB_BACKUP_TOKEN  — fine-grained token с правом contents:write на репо
//   GITHUB_BACKUP_REPO   — "owner/repo"
//   GITHUB_BACKUP_BRANCH — ветка (по умолчанию ветка по умолчанию репо)

//   BACKUP_ENCRYPTION_KEY — опционально: парольная фраза, бэкап шифруется
//                           AES-256-GCM перед заливкой (аудит 16.2)

import crypto from "node:crypto";

const API = "https://api.github.com";

export function offsiteEnabled() {
  return !!(process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO);
}

// ---- шифрование бэкапа: финансовые данные не должны лежать в чужом репо открытым текстом ----
function encryptionKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY || "";
  if (!raw) return null;
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

export function encryptBackup(content, key = encryptionKey()) {
  if (!key) return { content, encrypted: false };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  return {
    encrypted: true,
    content: JSON.stringify({
      format: "capital-queue-backup",
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    }),
  };
}

/** Расшифровать бэкап, созданный encryptBackup (для восстановления вручную). */
export function decryptBackup(content, passphrase) {
  const payload = JSON.parse(content);
  if (payload.alg !== "aes-256-gcm") throw new Error("unsupported_backup_format");
  const key = crypto.createHash("sha256").update(passphrase, "utf8").digest();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.data, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function gh(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_BACKUP_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "salary-planner-backup",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  return res;
}

async function putFile(repo, branch, path, content, message) {
  // Узнаём sha, если файл уже есть (нужен для перезаписи).
  let sha;
  const existing = await gh(
    `/repos/${repo}/contents/${path}${branch ? `?ref=${branch}` : ""}`,
  );
  if (existing.ok) {
    sha = (await existing.json())?.sha;
  }
  const res = await gh(`/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      ...(sha ? { sha } : {}),
      ...(branch ? { branch } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`offsite_put_failed_${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Залить JSON-бэкап в GitHub: датированный файл + перезаписываемый latest.json.
 * Ошибки не роняют основной процесс — логируются вызывающей стороной.
 */
export async function uploadOffsiteBackup(content, date = new Date()) {
  if (!offsiteEnabled()) return { uploaded: false, reason: "disabled" };
  const repo = process.env.GITHUB_BACKUP_REPO;
  const branch = process.env.GITHUB_BACKUP_BRANCH || "";
  const day = date.toISOString().slice(0, 10);
  const message = `backup: ${day}`;
  const { content: payload, encrypted } = encryptBackup(content);
  const ext = encrypted ? "json.enc" : "json";
  await putFile(repo, branch, `backups/capital-queue-${day}.${ext}`, payload, message);
  await putFile(repo, branch, `backups/latest.${ext}`, payload, message);
  return { uploaded: true, day, encrypted };
}
