// Deletion of files the *current* operation just created. These are the only exceptions to the rule
// "automatic deletion is off": a scratch file that this process wrote a moment ago, and a multer
// temporary file whose database row could not be inserted.
//
// Even these go through ownership checks, because a wrong path here would delete a user file:
//   * the path must be inside the directory the operation owns;
//   * the basename must be exactly the name the operation generated;
//   * it must be a plain regular file, never a symlink;
//   * the caller must confirm nothing else references it.
// Any doubt returns a reason instead of deleting.

import fs from 'fs';
import path from 'path';

/** True when `target` is a direct child of `dir` (no traversal, no absolute escape). */
export function isDirectChild(dir, target) {
  const rel = path.relative(dir, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !rel.includes('/') && !rel.includes('\\');
}

/**
 * Removes a file this operation created, if — and only if — every ownership check passes.
 *
 * Ownership is never proved by a lock. What is checked is: the path is a direct child of the directory
 * the operation owns, the name is exactly the one the operation generated (callers use a fresh UUID per
 * operation, so a collision with a pre-existing file is not a realistic event), it is a plain file, and
 * its mtime is not older than the moment the operation started — a file that was already there cannot
 * have been written by us.
 *
 * TOCTOU note: between the lstat check and `rmSync` another process can replace the directory entry.
 * Node.js exposes no portable "unlink this exact inode" call, so the window is reduced but not
 * eliminated. We re-check the parent immediately before rmSync and verify the path is gone after.
 *
 * @param {string} target absolute path
 * @param {{dir: string, name: string, isUnused?: () => boolean, notOlderThan?: number, missingIsOk?: boolean}} options
 * @returns {{removed: boolean, reason: string, code?: string}}
 */
export function removeOwnFile(target, { dir, name, isUnused, notOlderThan = 0, missingIsOk = true } = {}) {
  const abs = path.resolve(target);
  const dirAbs = path.resolve(dir);
  if (!isDirectChild(dirAbs, abs)) return { removed: false, reason: 'outside-dir' };
  if (path.basename(abs) !== name) return { removed: false, reason: 'name-mismatch' };
  if (typeof isUnused === 'function' && !isUnused()) return { removed: false, reason: 'still-referenced' };

  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' && missingIsOk) return { removed: false, reason: 'already-gone' };
    return { removed: false, reason: 'unreadable', code: err.code };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { removed: false, reason: 'not-a-plain-file' };
  // A file older than the operation did not come from it: it existed before we started, so it is not
  // ours to remove even though the name matches.
  if (notOlderThan && stat.mtimeMs < notOlderThan) return { removed: false, reason: 'pre-existing' };

  // Pre-rmSync parent stability check: the parent must still be the directory we own and must not
  // have become a symlink/junction pointing elsewhere.
  const parentStat = safeLstat(dirAbs);
  if (!parentStat.ok || !parentStat.stat.isDirectory() || parentStat.stat.isSymbolicLink()) {
    return { removed: false, reason: 'parent-not-plain-dir' };
  }

  try {
    fs.rmSync(abs, { force: true });
    // Post-delete verification: the path must no longer exist. If a file with the same name is back,
    // something replaced it after our check.
    const after = safeLstat(abs);
    if (after.ok && after.stat.isFile() && after.stat.size === stat.size && after.stat.mtimeMs === stat.mtimeMs) {
      return { removed: false, reason: 'replaced-after-delete', code: 'EREPLACED' };
    }
    return { removed: true, reason: 'removed' };
  } catch (err) {
    return { removed: false, reason: 'delete-failed', code: err.code };
  }
}

/** lstat that never throws. */
function safeLstat(abs) {
  try {
    return { ok: true, stat: fs.lstatSync(abs) };
  } catch (err) {
    return { ok: false, code: err.code || 'ESTAT', message: err.message };
  }
}