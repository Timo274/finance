// Offsite-копия бэкапа в приватный GitHub-репозиторий (Contents API).
// Включается переменными окружения:
//   GITHUB_BACKUP_TOKEN  — fine-grained token с правом contents:write на репо
//   GITHUB_BACKUP_REPO   — "owner/repo"
//   GITHUB_BACKUP_BRANCH — ветка (по умолчанию ветка по умолчанию репо)

const API = "https://api.github.com";

export function offsiteEnabled() {
  return !!(process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO);
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
  await putFile(repo, branch, `backups/capital-queue-${day}.json`, content, message);
  await putFile(repo, branch, "backups/latest.json", content, message);
  return { uploaded: true, day };
}
