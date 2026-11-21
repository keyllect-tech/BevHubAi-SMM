import { DatabaseSync } from 'node:sqlite';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  demo_mode INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  plan TEXT NOT NULL DEFAULT 'starter',
  monthly_limit INTEGER NOT NULL DEFAULT 15,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  month_start TEXT NOT NULL,
  videos_created INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, month_start)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);

CREATE TABLE IF NOT EXISTS brand_kits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  brand_name TEXT NOT NULL DEFAULT '',
  logo_url TEXT NOT NULL DEFAULT '',
  primary_color TEXT NOT NULL DEFAULT '#A3E635',
  secondary_color TEXT NOT NULL DEFAULT '#0B0D0C',
  default_language TEXT NOT NULL DEFAULT 'ru',
  default_cta TEXT NOT NULL DEFAULT 'Купить сейчас',
  created_at TEXT NOT NULL
);

-- Uploaded images. Files live in uploads/images and are served only to the owning workspace.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspace_id);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  client_request_id TEXT NOT NULL,
  title TEXT NOT NULL,
  product_name TEXT NOT NULL,
  product_description TEXT NOT NULL DEFAULT '',
  price TEXT NOT NULL DEFAULT '',
  cta TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL,
  voice_type TEXT NOT NULL DEFAULT 'female',
  style TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'product',
  script_hook TEXT NOT NULL DEFAULT '',
  script_body TEXT NOT NULL DEFAULT '',
  script_cta TEXT NOT NULL DEFAULT '',
  script_source TEXT NOT NULL DEFAULT '',
  audio_kind TEXT NOT NULL DEFAULT '',
  voice_language TEXT NOT NULL DEFAULT '',
  voice_exact INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'processing',
  video_file TEXT NOT NULL DEFAULT '',
  duration_sec INTEGER NOT NULL DEFAULT 15,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, client_request_id)
);
CREATE INDEX IF NOT EXISTS idx_videos_workspace_created ON videos(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_assets (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id),
  asset_type TEXT NOT NULL DEFAULT 'image',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assets_video ON video_assets(video_id);

CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'processing',
  progress INTEGER NOT NULL DEFAULT 0,
  current_step TEXT NOT NULL DEFAULT 'Queued',
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_video ON generation_jobs(video_id);
`;

export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // WAL keeps readers from blocking the render worker; NORMAL sync is safe with WAL (a power loss can
  // lose the last transaction, but never corrupts the file) and avoids an fsync per commit.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Databases created before ad categories / voice metadata existed.
  const videoColumns = db.prepare('PRAGMA table_info(videos)').all().map((c) => c.name);
  if (!videoColumns.includes('category')) db.exec("ALTER TABLE videos ADD COLUMN category TEXT NOT NULL DEFAULT 'product'");
  if (!videoColumns.includes('voice_language')) db.exec("ALTER TABLE videos ADD COLUMN voice_language TEXT NOT NULL DEFAULT ''");
  if (!videoColumns.includes('voice_exact')) db.exec('ALTER TABLE videos ADD COLUMN voice_exact INTEGER NOT NULL DEFAULT 1');
  return db;
}

export const newId = () => crypto.randomUUID();
export const nowIso = () => new Date().toISOString();

// Only snapshots written by backupDatabase() itself, in exactly its format. Rotation must never be
// able to match a file it did not create. All three spellings this function has ever produced are
// accepted — seconds resolution, milliseconds, and the millisecond collision suffix.
const OWN_BACKUP_RE = /^bevhub-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?(-\d+)?\.db$/;

/**
 * Consistent snapshot of the live database into data/backups.
 * `VACUUM INTO` writes a fresh file from a read transaction, so it is safe while renders are writing.
 * A failed backup must never stop the server: it is logged and retried on the next start.
 *
 * Rotation (`rotate = false` disables it) only ever looks at this function's own naming scheme, only removes
 * plain regular files, never removes the snapshot that was just written, and keeps at least `keep` files
 * in total — so a misconfigured or interrupted run cannot destroy the last good copy.
 *
 * @param {{keep?: number, rotate?: boolean, directory: string}} options
 */
export function backupDatabase(db, file, { keep = 10, rotate = true, directory } = {}) {
  if (!directory) throw new Error('backup directory must be supplied by the centralized storage configuration');
  const dir = directory;
  fs.mkdirSync(dir, { recursive: true });
  // Millisecond resolution: two backups in the same second must not collide, because `VACUUM INTO`
  // refuses to overwrite an existing file.
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${String(new Date().getMilliseconds()).padStart(3, '0')}`;
  let target = path.join(dir, `bevhub-${stamp}.db`);
  for (let n = 2; fs.existsSync(target) && n < 100; n++) target = path.join(dir, `bevhub-${stamp}-${n}.db`);

  // Single quotes only: the path may contain spaces or apostrophes, and this is not parameterised SQL.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  const keepCount = Math.max(1, Math.floor(Number(keep) || 1));
  const backups = [];
  for (const name of fs.readdirSync(dir)) {
    if (!OWN_BACKUP_RE.test(name)) continue;
    if (path.join(dir, name) === target) continue;
    try {
      const stat = fs.lstatSync(path.join(dir, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) continue;
      backups.push({ name, mtimeMs: stat.mtimeMs });
    } catch (err) {
      // An unreadable entry is unknown, and unknown is never a rotation candidate.
      console.warn(`[BACKUP] keeping ${name}: ${err.code || err.message}`);
    }
  }

  const removed = [];
  if (!rotate) return { target, removed, rotated: false };
  // `keep` counts the snapshot that was just written too: `keep = 10` means "at most ten files in
  // data/backups", so one old snapshot is dropped only when there are already ten.
  const surplus = backups
    .sort((a, b) => (a.mtimeMs === b.mtimeMs ? a.name.localeCompare(b.name) : b.mtimeMs - a.mtimeMs))
    .slice(Math.max(0, keepCount - 1));

  for (const { name } of surplus) {
    const full = path.join(dir, name);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      fs.rmSync(full, { force: true });
      removed.push(name);
    } catch (err) {
      // A locked or vanished file must not fail the backup that already succeeded.
      console.warn(`[BACKUP] could not rotate ${name}: ${err.code || err.message}`);
    }
  }
  return { target, removed, rotated: true };
}

export function currentMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
