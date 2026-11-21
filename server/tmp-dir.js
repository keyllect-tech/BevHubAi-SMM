// Startup preparation of `uploads/tmp`.
//
// The directory holds scratch trees that a running render may be writing into right now, and there is no
// cross-process ownership record for a scratch directory. So nothing inside it is ever removed here:
// the category is locked in `cleanup-policy.js`, and this module only reports what it found. The single
// thing it does is create the directory when it is missing.

import fs from 'fs';
import path from 'path';

/**
 * @param {{tmpDir: string, policy: object, log?: {info: Function, warn: Function}}} options
 * @returns {{created: boolean, leftovers: number, removed: 0, locked: boolean}}
 */
export function prepareTmpDir({ tmpDir, policy, log = console }) {
  let leftovers = -1;
  try {
    leftovers = fs.readdirSync(tmpDir).length;
  } catch {
    /* missing or unreadable: reported below */
  }

  if (policy.uploadTemp.blockedByLock) {
    log.warn(`[TMP] ${tmpDir}: recursive cleanup is disabled (no cross-process ownership for scratch directories)`);
  }
  if (leftovers > 0) {
    log.info(`[TMP] ${leftovers} leftover entr${leftovers === 1 ? 'y' : 'ies'} kept (CLEANUP_UPLOAD_TMP_MODE=${policy.uploadTemp.mode})`);
  }

  let created = false;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    created = leftovers < 0;
  } catch (err) {
    // A tmp directory that cannot be created will fail the render with a clear error later; refusing to
    // start would be worse, and deleting anything is never an option.
    log.warn(`[TMP] cannot create ${path.basename(tmpDir)} (${err.code || err.message})`);
  }

  // `removed` is part of the contract: it is always 0 while the category is locked.
  return { created, leftovers: Math.max(0, leftovers), removed: 0, locked: policy.uploadTemp.locked };
}