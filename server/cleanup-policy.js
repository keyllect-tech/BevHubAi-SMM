// Single decision point for every automatic deletion.
//
// Rules (fail-closed):
//   * a missing variable means OFF — nothing is deleted;
//   * an unknown or misspelled value means OFF — a typo never enables deletion;
//   * each category is configured separately, so enabling one can never enable another;
//   * `apply` additionally requires the global switch CLEANUP_ENABLED=true. The global switch can
//     only deny (it can never grant), so it cannot be the single flag that turns on several
//     deletions at once;
//   * `dry-run` is read-only and does not need the global switch: inventory must stay available
//     even when deletion is disabled.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
export const CLEANUP_MODES = ['off', 'dry-run', 'apply'];

/** Strict boolean: only 1/true/yes/on are true. Everything else (including typos) is false. */
export function parseToggle(value) {
  return TRUTHY.has(String(value ?? '').trim().toLowerCase());
}

/** Strict mode: unknown or missing falls back to 'off'. */
export function parseMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  return CLEANUP_MODES.includes(mode) ? mode : 'off';
}

// key in the policy object → environment variable prefix
const CATEGORIES = [
  ['orphan', 'ORPHAN'], // user files in uploads/images with no DB reference
  ['generationTemp', 'TMP'], // this run's own scratch dir and failed render (per-run UUID in the name)
  ['uploadTemp', 'UPLOAD_TMP'], // recursive wipe of uploads/tmp at startup
  ['backups', 'BACKUPS'], // rotation of data/backups/*.db
  ['missingLinks', 'MISSING_LINKS'], // clearing videos.video_file when the file is provably absent
];

// Categories whose deletion is not implemented safely yet. `apply` is refused for them no matter what
// the environment says, so a wrong or outdated config cannot enable a recursive wipe.
//
// `uploadTemp` deletes a directory tree that another process may be writing into right now. There is no
// cross-process ownership record for a scratch directory, so the wipe stays off until stage C adds one.
const LOCKED = new Set(['uploadTemp']);

export function readCleanupPolicy(env = process.env) {
  const globalEnabled = parseToggle(env.CLEANUP_ENABLED);
  const categories = {};
  for (const [key, prefix] of CATEGORIES) {
    const mode = parseMode(env[`CLEANUP_${prefix}_MODE`]);
    const locked = LOCKED.has(key);
    categories[key] = {
      mode,
      locked,
      dryRun: mode === 'dry-run' && !locked,
      apply: mode === 'apply' && globalEnabled && !locked,
      // true when the operator asked for deletion but the global switch or a lock still blocks it
      blockedByGlobal: mode === 'apply' && !globalEnabled && !locked,
      blockedByLock: mode === 'apply' && locked,
    };
  }
  return { globalEnabled, ...categories };
}

/** One-line-per-category summary for the startup log. Contains no secrets. */
export function describePolicy(policy) {
  return CATEGORIES.map(([key, prefix]) => {
    const c = policy[key];
    const state = c.blockedByLock ? `${c.mode} (locked: no cross-process ownership yet)` : c.blockedByGlobal ? `${c.mode} (blocked: CLEANUP_ENABLED is not true)` : c.mode;
    return `${prefix}=${state}`;
  }).join(' ');
}

export const CATEGORY_ENV = Object.fromEntries(CATEGORIES.map(([key, prefix]) => [key, `CLEANUP_${prefix}_MODE`]));