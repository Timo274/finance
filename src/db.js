import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    payday TEXT NOT NULL,
    salary REAL NOT NULL,
    survival_cost REAL NOT NULL DEFAULT 0,
    buffer REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    snapshot TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'gadgets',
    bucket TEXT NOT NULL DEFAULT 'quality',
    priority INTEGER NOT NULL DEFAULT 3,
    type TEXT NOT NULL DEFAULT 'should',
    deadline TEXT,
    earliest_date TEXT,
    can_defer INTEGER NOT NULL DEFAULT 1,
    emotional INTEGER NOT NULL DEFAULT 3,
    trajectory INTEGER NOT NULL DEFAULT 3,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---- settings helpers ----
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}
export function getJSON(key, fallback) {
  const v = getSetting(key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
export function setJSON(key, value) {
  setSetting(key, JSON.stringify(value));
}

// ---- item row <-> api object ----
export function rowToItem(r) {
  return {
    id: r.id,
    title: r.title,
    cost: r.cost,
    category: r.category,
    bucket: r.bucket,
    priority: r.priority,
    type: r.type,
    deadline: r.deadline,
    earliestDate: r.earliest_date,
    canDefer: !!r.can_defer,
    emotional: r.emotional,
    trajectory: r.trajectory,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function rowToPlan(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    payday: r.payday,
    salary: r.salary,
    survivalCost: r.survival_cost,
    buffer: r.buffer,
    status: r.status,
    snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

export default db;
