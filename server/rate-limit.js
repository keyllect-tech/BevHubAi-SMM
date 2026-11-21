// Persistent sliding-window rate limiter.
//
// The previous limiter lived in a Map, so a restart wiped every counter (and a login flood could be
// repeated after each restart). Events are stored in SQLite: the window is a timestamp column, so
// no cron is needed and the limit survives restarts and multiple workers reading the same file.

import { nowIso, transaction } from './db.js';

const SCHEMA = `
CREATE TABLE rate_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket   TEXT NOT NULL,
  key      TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
CREATE INDEX idx_rate_events_bucket_ts ON rate_events(bucket, ts);
`;

function ensureRateEventsSchema(db) {
  transaction(db, () => {
    const columns = db.prepare('PRAGMA table_info(rate_events)').all();
    if (columns.length === 0) {
      db.exec(SCHEMA);
      return;
    }

    if (columns.some((column) => column.name === 'event_id' && column.pk === 1)) {
      db.exec('CREATE INDEX IF NOT EXISTS idx_rate_events_bucket_ts ON rate_events(bucket, ts)');
      return;
    }

    const requiredColumns = new Set(columns.map((column) => column.name));
    if (!['bucket', 'key', 'ts'].every((name) => requiredColumns.has(name))) {
      throw new Error('Cannot migrate rate_events: expected bucket, key, and ts columns');
    }

    db.exec(`
      CREATE TABLE rate_events_new (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket   TEXT NOT NULL,
        key      TEXT NOT NULL,
        ts       INTEGER NOT NULL
      );
      INSERT INTO rate_events_new (bucket, key, ts) SELECT bucket, key, ts FROM rate_events;
      DROP TABLE rate_events;
      ALTER TABLE rate_events_new RENAME TO rate_events;
      CREATE INDEX idx_rate_events_bucket_ts ON rate_events(bucket, ts);
    `);
  });
}

export function createRateLimiter(db) {
  ensureRateEventsSchema(db);

  const insert = db.prepare('INSERT INTO rate_events (bucket, key, ts) VALUES (?, ?, ?)');
  const countSince = db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ? AND key = ? AND ts > ?');
  const oldest = db.prepare('SELECT MIN(ts) AS ts FROM rate_events WHERE bucket = ? AND key = ? AND ts > ?');
  const pruneBucket = db.prepare('DELETE FROM rate_events WHERE bucket = ? AND ts < ?');
  // Sweeping is global on purpose: the point is to bound table growth for every bucket at once. It only
  // removes rows older than the cutoff, so a live window is never touched.
  const pruneAged = db.prepare('DELETE FROM rate_events WHERE ts < ?');

  return {
    /**
     * Records one attempt and reports whether it is allowed.
     * @returns {{allowed: boolean, remaining: number, retryAfterMs: number, count: number}}
     */
    hit({ bucket, key, limit, windowMs }) {
      return transaction(db, () => {
        const now = Date.now();
        const since = now - windowMs;
        // Opportunistic cleanup: a bucket rarely grows, and old rows would otherwise linger forever.
        pruneBucket.run(bucket, since);
        const { n } = countSince.get(bucket, key, since);
        if (n >= limit) {
          const row = oldest.get(bucket, key, since);
          const retryAfterMs = row?.ts ? Math.max(1000, row.ts + windowMs - now) : windowMs;
          return { allowed: false, remaining: 0, retryAfterMs, count: n };
        }
        insert.run(bucket, key, now);
        return { allowed: true, remaining: Math.max(0, limit - n - 1), retryAfterMs: 0, count: n + 1 };
      });
    },

    /** Clears a key (successful login, admin action). */
    reset({ bucket, key }) {
      const info = db.prepare('DELETE FROM rate_events WHERE bucket = ? AND key = ?').run(bucket, key);
      return info.changes;
    },

    /** Counts attempts in the window without recording one. */
    peek({ bucket, key, windowMs }) {
      return countSince.get(bucket, key, Date.now() - windowMs).n;
    },

    /** How long until the oldest attempt in the window ages out (for a Retry-After header). */
    retryAfter({ bucket, key, windowMs }) {
      const now = Date.now();
      const row = oldest.get(bucket, key, now - windowMs);
      return row?.ts ? Math.max(1000, row.ts + windowMs - now) : windowMs;
    },

    /** Drops rows of one bucket older than its window (callers use their own window). */
    prune({ bucket, windowMs }) {
      return pruneBucket.run(bucket, Date.now() - windowMs).changes;
    },

    /**
     * Drops rows older than the longest window we use, in every bucket.
     * Fixes the earlier `bucket = '%'` comparison, which matched a literal bucket name and never deleted
     * anything. Rows inside a live window are always kept.
     */
    sweep(maxAgeMs = 24 * 60 * 60 * 1000) {
      return pruneAged.run(Date.now() - maxAgeMs).changes;
    },

    stats() {
      return db.prepare('SELECT bucket, COUNT(*) AS events, COUNT(DISTINCT key) AS keys FROM rate_events GROUP BY bucket').all();
    },
  };
}

/** Formats a retry hint the way the API returns it. */
export const retryAfterSeconds = (ms) => Math.max(1, Math.ceil(ms / 1000));

export const isoNow = nowIso;