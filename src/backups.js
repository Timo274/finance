// Локальные JSON-бэкапы по расписанию + offsite-копия в GitHub.
import fs from "node:fs/promises";
import path from "node:path";
import { DB_PATH } from "./db.js";
import { exportPayload } from "./store.js";
import { offsiteEnabled, uploadOffsiteBackup } from "./offsite.js";
import { structuredLog } from "./log.js";

export const BACKUP_DIR =
  process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), "backups");
const BACKUP_INTERVAL_HOURS = Math.max(
  1,
  Number(process.env.BACKUP_INTERVAL_HOURS) || 24,
);
export const BACKUP_RETENTION = Math.max(
  1,
  Number(process.env.BACKUP_RETENTION) || 14,
);
let backupsScheduled = false;

function backupFileName(reason = "scheduled") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeReason =
    String(reason)
      .replace(/[^a-z0-9_-]/gi, "-")
      .slice(0, 32) || "backup";
  return `capital-queue-${safeReason}-${stamp}.json`;
}
export async function listBackupFiles() {
  try {
    const entries = await fs.readdir(BACKUP_DIR, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const fullPath = path.join(BACKUP_DIR, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            size: stat.size,
            createdAt: stat.birthtime.toISOString(),
            modifiedAt: stat.mtime.toISOString(),
          };
        }),
    );
    return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function pruneBackups() {
  const files = await listBackupFiles();
  await Promise.all(
    files
      .slice(BACKUP_RETENTION)
      .map((file) => fs.unlink(file.path).catch(() => {})),
  );
}
export async function writeBackup(reason = "scheduled") {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const payload = exportPayload();
  const filePath = path.join(BACKUP_DIR, backupFileName(reason));
  const json = JSON.stringify(payload, null, 2);
  await fs.writeFile(filePath, json);
  await pruneBackups();
  // Offsite-копия в GitHub (если настроена) — не валим основной бэкап при сбое.
  let offsite = null;
  if (offsiteEnabled()) {
    try {
      offsite = await uploadOffsiteBackup(json);
    } catch (error) {
      structuredLog("error", "offsite_backup_failed", {
        error: String(error.message || error),
      });
    }
  }
  return {
    file: path.basename(filePath),
    path: filePath,
    exportedAt: payload.exportedAt,
    offsite,
  };
}
export function scheduleBackups() {
  if (
    backupsScheduled ||
    process.env.NODE_ENV === "test" ||
    process.env.BACKUP_ENABLED === "false"
  )
    return;
  backupsScheduled = true;
  setTimeout(
    () =>
      writeBackup("startup").catch((error) =>
        console.error("Backup failed:", error.message),
      ),
    30_000,
  ).unref?.();
  setInterval(
    () =>
      writeBackup("scheduled").catch((error) =>
        console.error("Backup failed:", error.message),
      ),
    BACKUP_INTERVAL_HOURS * 60 * 60 * 1000,
  ).unref?.();
}

