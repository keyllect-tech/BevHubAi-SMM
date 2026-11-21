import { parentPort, workerData } from 'node:worker_threads';
import { openDatabase } from '../server/db.js';
import { createRateLimiter } from '../server/rate-limit.js';

const db = openDatabase(workerData.file);
const limiter = createRateLimiter(db);
const barrier = new Int32Array(workerData.barrier);

parentPort.postMessage('ready');
parentPort.once('message', (message) => {
  if (message !== 'start') return;
  try {
    Atomics.wait(barrier, 0, 0);
    const results = [];
    for (let attempt = 0; attempt < workerData.attempts; attempt++) {
      results.push(
        limiter.hit({
          bucket: workerData.bucket,
          key: workerData.key,
          limit: workerData.limit,
          windowMs: 60 * 60 * 1000,
        }),
      );
    }
    db.close();
    parentPort.postMessage({ results });
  } catch (error) {
    db.close();
    parentPort.postMessage({ error: error.message });
  }
});
