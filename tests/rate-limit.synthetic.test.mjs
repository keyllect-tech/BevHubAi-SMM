import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { openDatabase } from '../server/db.js';
import { createRateLimiter } from '../server/rate-limit.js';

const roots = [];
const databases = new Set();

test.after(() => {
  for (const db of databases) db.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function createSyntheticDatabase(name = 'synthetic.sqlite') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bevhub-rate-limit-synthetic-'));
  roots.push(root);
  const db = openDatabase(path.join(root, name));
  databases.add(db);
  return { db, file: path.join(root, name) };
}

test('new schema counts distinct requests in the same millisecond exactly once each', () => {
  const { db } = createSyntheticDatabase();
  const limiter = createRateLimiter(db);
  const originalNow = Date.now;
  const fixedNow = 1_800_000_000_000;

  try {
    Date.now = () => fixedNow;
    const results = Array.from({ length: 8 }, () =>
      limiter.hit({ bucket: 'scripts', key: 'workspace-a', limit: 3, windowMs: 60 * 60 * 1000 }),
    );
    assert.deepEqual(results.map((result) => result.allowed), [true, true, true, false, false, false, false, false]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_events').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(DISTINCT event_id) AS n FROM rate_events').get().n, 3);

    assert.equal(limiter.hit({ bucket: 'scripts', key: 'workspace-b', limit: 3, windowMs: 60 * 60 * 1000 }).allowed, true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = 'workspace-b'").get().n, 1);
    const eventId = db.prepare("SELECT event_id FROM rate_events WHERE key = 'workspace-b'").get().event_id;
    assert.equal(typeof eventId, 'number');
  } finally {
    Date.now = originalNow;
  }
});

test('legacy rate events are preserved while migrating the synthetic schema', () => {
  const { db } = createSyntheticDatabase('legacy.sqlite');
  db.exec(`
    CREATE TABLE rate_events (
      bucket TEXT NOT NULL,
      key TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (bucket, key, ts)
    );
    CREATE INDEX idx_rate_events_bucket_ts ON rate_events(bucket, ts);
    INSERT INTO rate_events (bucket, key, ts) VALUES
      ('scripts', 'workspace-a', 1799999999000),
      ('scripts', 'workspace-a', 1799999999500);
  `);

  const limiter = createRateLimiter(db);
  const columns = db.prepare('PRAGMA table_info(rate_events)').all();
  assert.ok(columns.some((column) => column.name === 'event_id' && column.pk === 1));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_events').get().n, 2);
  assert.equal(limiter.peek({ bucket: 'scripts', key: 'workspace-a', windowMs: 60 * 60 * 1000 }), 2);
});

test('SQLite insertion failure rolls back the quota event and surfaces the error', () => {
  const { db } = createSyntheticDatabase();
  const limiter = createRateLimiter(db);
  db.exec(`
    CREATE TRIGGER reject_rate_event
    BEFORE INSERT ON rate_events
    BEGIN
      SELECT RAISE(FAIL, 'synthetic quota insert failure');
    END;
  `);

  assert.throws(
    () => limiter.hit({ bucket: 'scripts', key: 'workspace-a', limit: 3, windowMs: 60 * 60 * 1000 }),
    /synthetic quota insert failure/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_events').get().n, 0);
});

test('parallel worker connections cannot exceed the shared workspace limit', async () => {
  const { db, file } = createSyntheticDatabase();
  const limiter = createRateLimiter(db);
  const workerCount = 4;
  const attemptsPerWorker = 24;
  const limit = 9;
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workers = Array.from({ length: workerCount }, () =>
    new Worker(new URL('./rate-limit.worker.mjs', import.meta.url), {
      workerData: { file, bucket: 'scripts', key: 'shared-workspace', limit, attempts: attemptsPerWorker, barrier },
    }),
  );

  try {
    const ready = workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          const onMessage = (message) => {
            if (message === 'ready') {
              worker.off('error', reject);
              resolve();
              return;
            }
            if (message?.error) reject(new Error(message.error));
          };
          worker.on('message', onMessage);
          worker.once('error', reject);
        }),
    );
    await Promise.all(ready);
    for (const worker of workers) worker.postMessage('start');
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0, workerCount);

    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise((resolve, reject) => {
            worker.on('message', (message) => {
              if (message?.results) resolve(message.results);
              if (message?.error) reject(new Error(message.error));
            });
            worker.once('error', reject);
            worker.once('exit', (code) => {
              if (code !== 0) reject(new Error(`rate-limit worker exited with code ${code}`));
            });
          }),
      ),
    );
    assert.equal(results.flat().filter((result) => result.allowed).length, limit);
    assert.equal(limiter.peek({ bucket: 'scripts', key: 'shared-workspace', windowMs: 60 * 60 * 1000 }), limit);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});
