// Read-only inventory of the media directories, plus the only sanctioned way to delete from them.
//
// `scan()` never writes: it reads the directory listings and the database and classifies every file.
// Deletion happens only through `apply(scan)`, only for entries that survived every check, and only
// when the caller is in `apply` mode. Any doubt (database unreadable, storage unreadable, database
// barely populated, suspicious name, symlink) blocks the whole run rather than a single file.
//
// Scopes: every file below the uploads root is reported, not just the two directories the database
// happens to reference.
//
//   images  uploads/images   database-vouched (files.filename)
//   videos  uploads/videos   database-vouched (videos.video_file)
//   audio   uploads/audio    no database table references these: manual review only
//   root    uploads          files directly in uploads and any other nested directory; the four
//                            reserved names (images, videos, audio, tmp) are owned by another scope
//
// A file outside the two database-vouched directories can never be matched to a row with certainty,
// so it is `NEEDS_MANUAL_REVIEW` and never a deletion candidate. That is the point of the wider walk:
// it makes the blind spots visible instead of deleting what it cannot vouch for.

import fs from 'fs';
import path from 'path';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 200;
// How deep below a scope root the walk goes. Deeper trees are reported as truncated, and a truncated
// scan is blocked, so an unreadable-deep tree can never be mistaken for a complete inventory.
const MAX_DEPTH = 4;
// A hard stop on how many entries one scan reports: a runaway tree must not hang the cleanup pass.
const MAX_ENTRIES = 5000;

/** `unknown > known` means the database is probably partial/foreign — never sweep then. */
const MIN_DB_COVERAGE = 0.5;

function safeStat(abs) {
  try {
    return { ok: true, stat: fs.lstatSync(abs) };
  } catch (err) {
    return { ok: false, code: err.code || 'ESTAT', message: err.message };
  }
}

function listDir(dir) {
  try {
    return { ok: true, names: fs.readdirSync(dir) };
  } catch (err) {
    return { ok: false, code: err.code || 'EREADDIR', message: err.message };
  }
}

function query(db, sql, ...params) {
  try {
    return { ok: true, rows: db.prepare(sql).all(...params) };
  } catch (err) {
    return { ok: false, code: err.code || 'ESQL', message: err.message };
  }
}

/** Forward slashes, so a report reads the same on Windows and on Linux. */
function toPosix(p) {
  return p.split(path.sep).join('/');
}

/** True when `target` is `root` itself or lies inside it (lexical check, symlinks are never followed). */
function isInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Windows paths are case-insensitive; two spellings of one directory are one directory. */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Comparison key for directories: case-insensitive on Windows, exact elsewhere. */
function dirKey(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** Real path of `abs`, or the reason it could not be resolved. */
function realpathOf(abs) {
  try {
    return { ok: true, path: fs.realpathSync(abs) };
  } catch (err) {
    return { ok: false, code: err.code || 'ESTAT', message: err.message };
  }
}

/**
 * Does the last component of `abs` redirect somewhere else — a symbolic link, a Windows junction, a
 * mount point, any other reparse point?
 *
 * On Linux `lstat().isSymbolicLink()` is exact. On Windows libuv reports a junction as a symbolic link
 * as well, but a reparse point Node does not classify as a link would slip through, so the path is
 * also resolved and compared with "the real parent plus the same name": if resolution lands anywhere
 * else, the last component redirects.
 *
 * The comparison is relative to the parent on purpose: a redirected *ancestor* (a temp directory that
 * itself sits under a junction) must not be reported as a link here, and a plain directory is never
 * mistaken for one.
 *
 * A resolution failure is reported as `resolved: false`, never as "not a link": a caller that cannot
 * establish the physical path must block the scope instead of assuming it is safe.
 *
 * @returns {{link: boolean, resolved: boolean, reason: string}}
 */
function linkState(abs, stat) {
  if (stat && stat.isSymbolicLink()) return { link: true, resolved: true, reason: 'symbolic link or reparse point' };
  const self = realpathOf(abs);
  if (!self.ok) return { link: false, resolved: false, reason: `physical path unresolved (${self.code})` };
  const parent = realpathOf(path.dirname(abs));
  if (!parent.ok) return { link: false, resolved: false, reason: `parent physical path unresolved (${parent.code})` };
  return {
    link: dirKey(self.path) !== dirKey(path.join(parent.path, path.basename(abs))),
    resolved: true,
    reason: 'physical path resolved',
  };
}

/** A directory that is simply not there yet holds nothing: that is not a storage failure. */
function isMissingDir(problem) {
  return problem && (problem.code === 'ENOENT' || problem.code === 'ENOTDIR');
}

export function createFileInventory({ db, imagesDir, videosDir, uploadsDir, audioDir, trustedRoot, ttlHours = 24 }) {
  const ttlMs = Math.max(1, Number(ttlHours) || 24) * 60 * 60 * 1000;
  // The uploads root is the parent of the images directory, and the audio directory sits next to it:
  // a caller that names only the two classic directories still gets the wider walk, without a new option.
  const rootDir = path.resolve(uploadsDir || path.dirname(path.resolve(imagesDir)));
  const audioRoot = path.resolve(audioDir || path.join(rootDir, 'audio'));
  // The trusted physical root: uploads must resolve inside it. It is a required trust boundary — a
  // caller that does not name one provides no anchor to compare against, so the inventory must block
  // instead of assuming any parent directory is safe. A deployment that keeps uploads outside the
  // project tree must pass the boundary it trusts explicitly.
  const trustedRootAbs = trustedRoot == null ? null : path.resolve(trustedRoot);

  // Candidates issued by scans of this inventory instance. Internal only: `apply` refuses a result or a
  // candidate that cannot be matched here, so a caller cannot fabricate a deletable candidate.
  const scanRegistry = new Map();

  /** What the database knows. Never throws. */
  function probeDatabase() {
    const images = query(db, 'SELECT id, filename FROM files');
    const videos = query(db, "SELECT id, video_file FROM videos WHERE video_file <> ''");
    const assets = query(db, 'SELECT file_id FROM video_assets');
    const logos = query(db, "SELECT logo_url FROM brand_kits");
    const orphanRows = query(
      db,
      `SELECT id, filename FROM files
       WHERE created_at < ?
         AND id NOT IN (SELECT file_id FROM video_assets)`,
      new Date(Date.now() - ttlMs).toISOString()
    );

    const errors = [];
    for (const [name, res] of [
      ['files', images],
      ['videos', videos],
      ['video_assets', assets],
      ['brand_kits', logos],
      ['orphan_query', orphanRows],
    ]) {
      if (!res.ok) errors.push({ query: name, code: res.code, message: res.message });
    }

    const knownImages = new Set((images.rows || []).map((r) => r.filename));
    const knownVideos = new Set((videos.rows || []).map((r) => r.video_file));
    const referencedFiles = new Set((assets.rows || []).map((r) => r.file_id));
    // Fail-closed logo interpretation: only clearly recognized, unambiguous references count as "this id
    // is referenced". A non-empty value that cannot be recognized may refer to any file, so it blocks
    // orphan proof for all files rather than guessing.
    const logoState = interpretLogos(logos.rows || []);
    const orphanIds = new Set();
    const orphanNames = new Set();
    for (const row of orphanRows.rows || []) {
      if (!logoState.ok) continue; // an unrecognizable logo makes no file provably orphan
      if (logoState.ids.has(row.id)) continue;
      orphanIds.add(row.id);
      orphanNames.add(row.filename);
    }

    return {
      available: errors.length === 0,
      errors,
      knownImages,
      knownVideos,
      referencedFiles,
      logoState,
      orphanIds,
      orphanNames,
      counts: {
        files: knownImages.size,
        videos: knownVideos.size,
        assets: referencedFiles.size,
        logos: logos.ok ? (logos.rows || []).length : 0,
        orphanRows: orphanIds.size,
      },
    };
  }

  const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  /**
   * Interprets a `brand_kits.logo_url` value. The project stores it as a user-entered string (UI reads
   * and writes it verbatim), so the only unambiguous references are forms that clearly name a file id:
   *   - canonical:  /api/files/<id>
   *   - bare id:   <id>
   *   - URL whose pathname ends with /api/files/<id> (absolute or relative, query/hash allowed)
   * Anything non-empty that cannot be recognized as one of these may refer to a file in a form this code
   * does not understand; treating it as "not a reference" would risk deleting a referenced file, so it is
   * reported as ambiguous and blocks orphan proof (fail-closed).
   */
  function parseLogoReference(value) {
    if (value == null) return { kind: 'empty' };
    const raw = String(value).trim();
    if (raw === '') return { kind: 'empty' };
    if (FILE_ID_RE.test(raw)) return { kind: 'id', id: raw.toLowerCase() };
    if (raw.startsWith('/api/files/')) {
      const tail = raw.slice('/api/files/'.length).split(/[?#]/, 1)[0];
      if (FILE_ID_RE.test(tail)) return { kind: 'id', id: tail.toLowerCase() };
      return { kind: 'ambiguous' };
    }
    // Absolute/relative URL: only the pathname is authoritative. If it cannot be parsed as a URL at all
    // (or carries no /api/files/ path), the value is not a recognizable file reference — but because it
    // is non-empty we cannot prove it references no file, so it is ambiguous.
    try {
      const u = new URL(raw, 'http://local.invalid');
      const m = /\/api\/files\/([^/?#]+)/i.exec(u.pathname);
      if (m && FILE_ID_RE.test(m[1])) return { kind: 'id', id: m[1].toLowerCase() };
      // A URL that does not point at /api/files/<id> is not a recognized file reference; it is still a
      // non-empty value whose meaning is unknown to this inventory.
      if (/\/api\/files\//i.test(u.pathname)) return { kind: 'ambiguous' };
      return { kind: 'ambiguous' };
    } catch {
      return { kind: 'ambiguous' };
    }
  }

  function interpretLogos(rows) {
    const ids = new Set();
    let ambiguous = false;
    for (const r of rows || []) {
      const ref = parseLogoReference(r && r.logo_url);
      if (ref.kind === 'id') ids.add(ref.id);
      else if (ref.kind === 'ambiguous') ambiguous = true;
    }
    return { ok: !ambiguous, ambiguous, ids };
  }

  /**
   * Independent proof that a `files` row is orphaned, recomputed at delete time — never inferred from
   * the scan's `reason`. The row must exist, be old enough, have no `video_assets` reference and not be
   * named as a brand-kit logo by any recognizable reference. A non-empty, unrecognizable `logo_url`
   * makes orphan status unprovable for every file (fail-closed). A query failure is treated the same.
   *
   * Schema (read-only, `server/db.js`): `files(id, filename, created_at, ...)`,
   * `video_assets(file_id REFERENCES files.id)`, `brand_kits(logo_url)`.
   */
  function orphanProof(name, now) {
    const cutoff = new Date(now - ttlMs).toISOString();
    const row = query(
      db,
      `SELECT id FROM files
       WHERE filename = ?
         AND created_at < ?
         AND id NOT IN (SELECT file_id FROM video_assets)`,
      name,
      cutoff
    );
    if (!row.ok) return { ok: false, proven: false, code: row.code, message: row.message };
    if (row.rows.length === 0) return { ok: true, proven: false, count: 0 };

    const logos = query(db, 'SELECT logo_url FROM brand_kits');
    if (!logos.ok) return { ok: false, proven: false, code: logos.code, message: logos.message };
    const state = interpretLogos(logos.rows);
    if (!state.ok) return { ok: true, proven: false, ambiguousLogo: true };
    const proven = row.rows.some((r) => !state.ids.has(String(r.id).toLowerCase()));
    return { ok: true, proven, count: row.rows.length };
  }

  /**
   * Resolves the trusted physical boundary at the moment of the call. Used both by `scan` and, again,
   * by `apply`: a boundary that vanished or moved between the two is not a boundary.
   */
  function resolveBoundary() {
    const uploadsCheck = checkRoot(rootDir);
    const uploadsReal = uploadsCheck.ok ? realpathOf(rootDir) : null;
    const trustedCheck =
      trustedRootAbs == null
        ? { ok: false, missing: true, path: null, code: 'ETRUST', message: 'trusted root not provided' }
        : realpathOf(trustedRootAbs);
    const trustedReal = trustedCheck.ok ? trustedCheck : null;
    const uploadsOutside = Boolean(
      uploadsCheck.ok &&
        uploadsReal.ok &&
        trustedReal &&
        trustedReal.ok &&
        !isInside(trustedReal.path, uploadsReal.path)
    );
    const usable = uploadsCheck.ok && trustedReal != null && uploadsReal != null && uploadsReal.ok && !uploadsOutside;
    return { uploadsCheck, uploadsReal, trustedCheck, trustedReal, uploadsOutside, usable };
  }

  function boundaryBlockCode(boundary) {
    const { uploadsCheck, uploadsReal, trustedCheck, trustedReal } = boundary;
    if (trustedReal == null) return trustedCheck.missing ? 'TRUSTED_ROOT_MISSING' : 'TRUSTED_ROOT_UNRESOLVED';
    if (uploadsCheck.link) return 'UPLOADS_DIR_IS_LINK';
    if (uploadsCheck.unresolved) return 'UPLOADS_DIR_PATH_UNRESOLVED';
    if (uploadsReal == null || !uploadsReal.ok) return 'UPLOADS_DIR_PATH_UNRESOLVED';
    if (uploadsCheck.ok) return 'UPLOADS_DIR_OUTSIDE_ROOT';
    return 'UPLOADS_DIR_UNAVAILABLE';
  }

  /**
   * Checks a scope root *before* anything is read from it.
   *
   * A root that is a symbolic link, a Windows junction or any other reparse point is not walked and
   * not followed: the inventory would otherwise describe (and a delete would otherwise act on) a tree
   * outside the directory the operator configured. A missing root is only tolerated where a missing
   * root is normal (`uploads/audio`).
   *
   * A root whose physical path cannot be established is refused as well (`EPATH`): "not a link" must
   * never be inferred from "could not look".
   *
   * @returns {{ok: boolean, link?: boolean, unresolved?: boolean, missing?: boolean, dir?: string, realPath?: string, code?: string, message?: string}}
   */
  function checkRoot(dir, { allowMissing = false } = {}) {
    const abs = path.resolve(dir);
    const stat = safeStat(abs);
    if (!stat.ok) {
      if (allowMissing && isMissingDir(stat)) return { ok: true, missing: true, dir: abs, realPath: abs };
      return { ok: false, dir: abs, code: stat.code, message: stat.message };
    }
    const state = linkState(abs, stat.stat);
    if (state.link) {
      return { ok: false, link: true, dir: abs, code: 'EISLINK', message: `directory is a ${state.reason}` };
    }
    if (!state.resolved) {
      return { ok: false, unresolved: true, dir: abs, code: 'EPATH', message: `physical path unknown: ${state.reason}` };
    }
    if (!stat.stat.isDirectory()) {
      return { ok: false, dir: abs, code: 'ENOTDIR', message: 'path exists but is not a directory' };
    }
    return { ok: true, dir: abs, realPath: (realpathOf(abs).path || abs) };
  }

  /**
   * Classifies one directory tree.
   *
   * A file the database cannot vouch for is `UNKNOWN_IN_DB` / `NEEDS_MANUAL_REVIEW` and is **never**
   * deletable automatically, whatever its age and whatever the unknown/known ratio is. Only a file whose
   * own `files` row the database marks as an orphan (no video asset, no brand-kit logo) and that is older
   * than the TTL is a candidate.
   *
   * `dbScope` is `'images'`, `'videos'` or `null`. With `null` the database is not consulted at all:
   * nothing in `uploads/audio` or in the uploads root is referenced by a row, so every file there is
   * reported for manual review instead of being quietly treated as "unknown but fine".
   *
   * @param {{kind: string, root: string, dbInfo: object, now: number, dbScope: ('images'|'videos'|null), skipDirs?: Set<string>, allowMissing?: boolean}} options
   */
  function scanScope({ kind, root, dbInfo, now, dbScope = null, skipDirs = new Set(), allowMissing = false }) {
    const files = [];
    const errors = [];
    let truncated = false;
    let escaped = false;
    let entries = 0;

    const push = (entry) => {
      files.push(entry);
      entries += 1;
    };

    const walk = (dir, relDir, depth) => {
      // The physical boundary, not the lexical one: a directory that resolves outside the scope root is
      // not walked, because a delete would act on the resolved path. This also catches a redirect that
      // appeared after the root was checked.
      const real = realpathOf(dir);
      if (!real.ok) {
        errors.push({ dir, code: real.code, message: `physical path unresolved: ${real.message}` });
        escaped = true;
        return;
      }
      if (!isInside(rootCheck.realPath || root, real.path)) {
        errors.push({ dir, code: 'EESCAPE', message: 'directory resolves outside the scope root' });
        escaped = true;
        return;
      }

      const listing = listDir(dir);
      if (!listing.ok) {
        errors.push({ dir, code: listing.code, message: listing.message });
        return;
      }

      for (const name of listing.names) {
        if (entries >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, name);
        // The scope root is the boundary: a directory entry that resolves outside it is not reported on.
        if (!isInside(root, abs)) {
          errors.push({ file: toPosix(path.relative(root, abs)), code: 'EESCAPE', message: 'path escapes the scope root' });
          continue;
        }
        const rel = relDir ? `${kind}/${relDir}/${name}` : `${kind}/${name}`;

        const stat = safeStat(abs);
        if (!stat.ok) {
          // Cannot even look at it: unknown, and unknown is never deleted.
          push({
            rel, name, kind, abs, depth, size: null, mtime: null, ageHours: null, inDb: null,
            status: 'NEEDS_MANUAL_REVIEW', reason: 'unreadable', deletable: false, needsManualReview: true,
            note: `stat failed (${stat.code}) — ownership cannot be determined`,
            error: { code: stat.code, message: stat.message },
          });
          errors.push({ file: rel, code: stat.code, message: stat.message });
          continue;
        }
        if (stat.stat.isSymbolicLink()) {
          // A reparse point is never followed: on Windows a junction reports as a symbolic link here,
          // and following one could walk out of the uploads root.
          push({
            rel, name, kind, abs, depth, size: 0, mtime: null, ageHours: null, inDb: null,
            status: 'NEEDS_MANUAL_REVIEW', reason: 'symlink', deletable: false, needsManualReview: true,
            note: 'symlink is never followed or removed',
          });
          continue;
        }

        if (stat.stat.isDirectory()) {
          // A directory another scope owns (images, videos, audio, tmp) is not reported here: walking it
          // twice would show the same tree twice with two different verdicts.
          if (skipDirs.has(dirKey(abs))) continue;
          push({
            rel, name, kind, abs, depth, size: 0, mtime: null, ageHours: null, inDb: null,
            status: 'PATH_INVALID', reason: 'not-a-regular-file', deletable: false, needsManualReview: true,
            note: 'directory or special file',
          });
          // Still look inside it: a subdirectory is where a stray file hides, and a directory that is
          // never opened is a blind spot of exactly the kind this walk exists to remove.
          if (depth + 1 > MAX_DEPTH) {
            truncated = true;
            continue;
          }
          walk(abs, relDir ? `${relDir}/${name}` : name, depth + 1);
          continue;
        }

        if (!stat.stat.isFile()) {
          push({
            rel, name, kind, abs, depth, size: 0, mtime: null, ageHours: null, inDb: null,
            status: 'PATH_INVALID', reason: 'not-a-regular-file', deletable: false, needsManualReview: true,
            note: 'directory or special file',
          });
          continue;
        }
        if (name.length > MAX_NAME || name !== path.basename(name)) {
          push({
            rel, name, kind, abs, depth, size: stat.stat.size, mtime: null, ageHours: null, inDb: null,
            status: 'PATH_INVALID', reason: 'invalid-name', deletable: false, needsManualReview: true,
            note: 'name is not a plain basename',
          });
          continue;
        }

        const ageMs = now - stat.stat.mtimeMs;
        let status;
        let reason;
        let inDb = null;
        let note;

        if (depth > 0) {
          // A row stores a bare filename, so a nested file cannot be matched with certainty: two files
          // may share a name and deleting the row would strip the other one of its reference.
          status = 'NEEDS_MANUAL_REVIEW';
          reason = 'nested-path';
          note = 'file is below the media directory: a database row cannot vouch for it';
        } else if (!dbScope) {
          // No table references files in this directory, so there is nothing to check the file against.
          status = 'NEEDS_MANUAL_REVIEW';
          reason = 'outside-database-scope';
          note = 'no database table references files in this directory: manual review only';
        } else {
          inDb = dbScope === 'images' ? dbInfo.knownImages.has(name) : dbInfo.knownVideos.has(name);
          const tooNew = ageMs < ttlMs;

          // `too-new` wins over everything: nothing younger than the TTL is ever a candidate, whatever the
          // database says. For images the database alone decides between "orphan row" (candidate) and
          // "referenced" (user data); for videos only the video row can vouch for the file. A file with no
          // row at all is UNKNOWN_IN_DB — never a candidate, at any age.
          if (tooNew) {
            reason = 'too-new';
            status = inDb ? 'KNOWN_IN_DB' : 'UNKNOWN_IN_DB';
          } else if (dbScope === 'images') {
            if (!inDb) {
              reason = 'unknown-in-db';
              status = 'UNKNOWN_IN_DB';
            } else if (dbInfo.orphanNames.has(name)) {
              reason = 'orphan-row';
              status = 'KNOWN_IN_DB';
            } else {
              reason = 'referenced';
              status = 'KNOWN_IN_DB';
            }
          } else if (inDb) {
            reason = 'referenced';
            status = 'KNOWN_IN_DB';
          } else {
            reason = 'unknown-in-db';
            status = 'UNKNOWN_IN_DB';
          }
        }

        const manual = status === 'UNKNOWN_IN_DB' || status === 'NEEDS_MANUAL_REVIEW' || status === 'PATH_INVALID';
        push({
          rel,
          name,
          kind,
          abs,
          depth,
          size: stat.stat.size,
          mtime: new Date(stat.stat.mtimeMs).toISOString(),
          ageHours: Number((ageMs / 3600000).toFixed(2)),
          inDb,
          status,
          reason,
          deletable: false,
          needsManualReview: manual,
          note: manual
            ? note || 'no database row vouches for this file: manual review only'
            : undefined,
          // Fingerprint of the scanned file, used by `apply` to notice a file that changed between the
          // scan and the delete. `ino` is 0 on filesystems that do not report it.
          fingerprint: { size: stat.stat.size, mtimeMs: stat.stat.mtimeMs, ino: stat.stat.ino ?? 0 },
        });
      }
    };

    // The root is verified before the first readdir: a link at the root is reported and the scope is
    // closed, so nothing inside it is ever classified — and therefore nothing inside it can be deleted.
    const rootCheck = checkRoot(root, { allowMissing });
    if (!rootCheck.ok) {
      errors.push({ dir: root, code: rootCheck.code, message: rootCheck.message });
      return { ok: false, link: rootCheck.link === true, unresolved: rootCheck.unresolved === true, dir: root, files, errors, truncated, escaped, missing: rootCheck.missing === true, realPath: root };
    }
    // A tolerated absence (`uploads/audio` before anything wrote there) is empty, not unreadable.
    if (rootCheck.missing) return { ok: true, dir: root, files, errors, truncated, escaped, missing: true, realPath: rootCheck.realPath };

    const rootListing = listDir(root);
    if (!rootListing.ok) {
      errors.push({ dir: root, code: rootListing.code, message: rootListing.message });
      return { ok: false, dir: root, files, errors, truncated, escaped, missing: false, realPath: rootCheck.realPath };
    }

    walk(root, '', 0);
    return { ok: true, dir: root, files, errors, truncated, escaped, missing: false, realPath: rootCheck.realPath };
  }

  /**
   * Read-only scan. Safe with an empty, partial, locked or missing database: every database failure
   * ends up in `blocked`, and a blocked scan has no deletable files.
   */
  function scan({ now = Date.now() } = {}) {
    const dbInfo = probeDatabase();

    // A scope root outside the uploads root means the configuration points somewhere else: nothing from
    // it may be reported, and the run is blocked rather than half-read.
    const outsideRoot = [];
    for (const [name, dir] of [['images', imagesDir], ['videos', videosDir], ['audio', audioRoot]]) {
      if (!isInside(rootDir, path.resolve(dir))) outsideRoot.push(name);
    }

    // `uploads` is checked first: every other scope lives below it. If the uploads root is a link, cannot
    // be resolved, or resolves outside the trusted physical root, no scope may be read at all — a path
    // below such a root describes a tree the operator never configured. The trusted root is mandatory:
    // without it there is no boundary to compare against, and "unknown boundary" is never safe.
    const boundary = resolveBoundary();
    const { uploadsCheck, uploadsReal, trustedReal, usable: uploadsUsable } = boundary;
    const closed = {
      ok: false,
      link: uploadsCheck.link === true,
      unresolved: uploadsCheck.unresolved === true,
      dir: rootDir,
      files: [],
      errors: [],
      truncated: false,
      missing: uploadsCheck.missing === true,
    };

    // Every scope must sit inside uploads, both lexically and physically: a scope that redirects outside
    // the uploads tree would be read, but the paths it reports would not be the ones being deleted.
    // A scope that is a link, or that does not resolve, is left to `checkRoot`: it reports the precise
    // reason (link, unresolved, missing), and a missing optional scope must stay empty instead of being
    // turned into an escape.
    const scopes = { images: path.resolve(imagesDir), videos: path.resolve(videosDir), audio: audioRoot };
    if (uploadsUsable) {
      for (const [name, dir] of Object.entries(scopes)) {
        if (outsideRoot.includes(name)) continue;
        const stat = safeStat(dir);
        if (!stat.ok) continue;
        if (linkState(dir, stat.stat).link) continue;
        const real = realpathOf(dir);
        if (!real.ok) continue;
        if (!isInside(uploadsReal.path, real.path)) outsideRoot.push(name);
      }
    }

    const images = uploadsUsable && !outsideRoot.includes('images') ? scanScope({ kind: 'images', root: scopes.images, dbInfo, now, dbScope: 'images' }) : closed;
    const videos = uploadsUsable && !outsideRoot.includes('videos') ? scanScope({ kind: 'videos', root: scopes.videos, dbInfo, now, dbScope: 'videos' }) : closed;
    const audio = uploadsUsable && !outsideRoot.includes('audio') ? scanScope({ kind: 'audio', root: scopes.audio, dbInfo, now, dbScope: null, allowMissing: true }) : closed;
    const root = uploadsUsable ? scanScope({
      kind: 'root',
      root: rootDir,
      dbInfo,
      now,
      dbScope: null,
      // The root scope covers files directly in uploads and any other nested directory. The four
      // directories with their own scope — plus uploads/tmp, which is a separate locked cleanup
      // category — are left to whoever owns them, so no file is reported twice.
      skipDirs: new Set(
        [path.resolve(imagesDir), path.resolve(videosDir), audioRoot, path.join(rootDir, 'tmp')].map(dirKey)
      ),
    }) : closed;

    const blocked = [];
    if (!dbInfo.available) blocked.push('DB_UNAVAILABLE');
    if (!uploadsUsable) {
      // The boundary is checked before the contents: no trusted root, or an unresolvable one, blocks the
      // whole run. "Unknown boundary" is never treated as "inside the boundary".
      blocked.push(boundaryBlockCode(boundary));
    } else {
      for (const [name, scope] of [['IMAGES', images], ['VIDEOS', videos], ['AUDIO', audio]]) {
        if (scope.ok) continue;
        const reason = scope.link ? `${name}_DIR_IS_LINK` : scope.unresolved ? `${name}_DIR_PATH_UNRESOLVED` : `${name}_DIR_UNAVAILABLE`;
        blocked.push(reason);
      }
    }
    if (images.truncated || videos.truncated || audio.truncated || root.truncated) blocked.push('INVENTORY_LIMIT_REACHED');
    if (images.escaped || videos.escaped || audio.escaped || root.escaped) blocked.push('INVENTORY_PATH_ESCAPE');
    if (outsideRoot.length) blocked.push('SCOPE_OUTSIDE_ROOT');
    if (dbInfo.available && dbInfo.knownImages.size === 0 && dbInfo.knownVideos.size === 0) blocked.push('DB_EMPTY');

    // One file, one entry. The scopes are disjoint by construction (the root scope skips the reserved
    // directories); this is the guard that keeps it true if the configuration overlaps them.
    const seen = new Set();
    const files = [];
    for (const f of [...images.files, ...videos.files, ...audio.files, ...root.files]) {
      const key = dirKey(f.abs);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      files.push(f);
    }

    // A database that knows far fewer files than the disk holds may be partial or foreign, so the
    // orphan rows it does report are not trustworthy either. This is an extra block, not a licence:
    // unknown files are never deletable, at any ratio. Only the two database-vouched directories count:
    // files no table can reference (audio, uploads root) are not what this ratio measures.
    if (dbInfo.available) {
      const known = dbInfo.knownImages.size + dbInfo.knownVideos.size;
      const unknown = [...images.files, ...videos.files].filter(
        (f) => f.depth === 0 && !f.inDb && f.reason !== 'symlink' && f.reason !== 'not-a-regular-file'
      ).length;
      if (known === 0 || unknown > known) blocked.push('DB_COVERAGE_LOW');
    }

    const deletable = blocked.length === 0;
    for (const f of files) {
      // Only a database-confirmed orphan row qualifies — and only in `apply` mode, which the caller
      // gates on the cleanup policy. `unknown-in-db` is deliberately absent from this list, and so is
      // any file that is not directly inside its media directory.
      if (deletable && f.status === 'KNOWN_IN_DB' && f.reason === 'orphan-row' && f.depth === 0) f.deletable = true;
    }

    // Internal, non-secret binding: `apply` accepts only candidate objects issued by this inventory
    // instance for this specific scan. The value is not sufficient on its own — `apply` checks it against
    // server-side state — and it is not derived from user input.
    const __scanId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const issued = new Set(files.filter((f) => f.deletable));
    scanRegistry.set(__scanId, { issued, createdAt: now });
    // Keep the registry bounded: a long-lived process only needs recent scans.
    if (scanRegistry.size > 50) {
      const first = scanRegistry.keys().next().value;
      if (first && first !== __scanId) scanRegistry.delete(first);
    }

    // Only a file that is where the row says it is counts as present: a same-named file buried in a
    // subdirectory does not make a missing video exist.
    const presentImages = new Set(images.files.filter((f) => f.depth === 0).map((f) => f.name));
    const presentVideos = new Set(videos.files.filter((f) => f.depth === 0).map((f) => f.name));
    const missing = dbInfo.available
      ? [
          ...[...dbInfo.knownImages].filter((n) => !presentImages.has(n)).map((n) => ({ rel: `images/${n}`, status: 'MISSING_ON_DISK' })),
          ...[...dbInfo.knownVideos].filter((n) => !presentVideos.has(n)).map((n) => ({ rel: `videos/${n}`, status: 'MISSING_ON_DISK' })),
        ]
      : [];

    const errors = [
      ...dbInfo.errors.map((e) => ({ scope: 'database', ...e })),
      ...images.errors.map((e) => ({ scope: 'images', ...e })),
      ...videos.errors.map((e) => ({ scope: 'videos', ...e })),
      ...audio.errors.map((e) => ({ scope: 'audio', ...e })),
      ...root.errors.map((e) => ({ scope: 'uploads', ...e })),
    ];

    const byStatus = (status) => files.filter((f) => f.status === status).length;
    return {
      __scanId,
      checkedAt: new Date(now).toISOString(),
      ttlHours: Math.round(ttlMs / 3600000),
      storage: {
        uploadsDir: rootDir,
        imagesDir,
        videosDir,
        audioDir: audioRoot,
        trustedRoot: trustedRootAbs,
        uploadsRealPath: uploadsReal && uploadsReal.ok ? uploadsReal.path : null,
        trustedRootRealPath: trustedReal && trustedReal.ok ? trustedReal.path : null,
        readable: images.ok && videos.ok && audio.ok && root.ok,
        imageCount: images.files.length,
        videoCount: videos.files.length,
        audioCount: audio.files.length,
        rootCount: root.files.length,
      },
      database: { available: dbInfo.available, ...dbInfo.counts, errors: dbInfo.errors },
      files,
      candidates: files.filter((f) => f.deletable),
      manualReview: files.filter((f) => f.needsManualReview),
      missing,
      blocked,
      counts: {
        scanned: files.length,
        deletable: files.filter((f) => f.deletable).length,
        knownInDb: byStatus('KNOWN_IN_DB'),
        unknownInDb: byStatus('UNKNOWN_IN_DB'),
        needsManualReview: byStatus('NEEDS_MANUAL_REVIEW'),
        pathInvalid: byStatus('PATH_INVALID'),
        tooNew: files.filter((f) => f.reason === 'too-new').length,
        referenced: files.filter((f) => f.reason === 'referenced').length,
        orphanRows: files.filter((f) => f.reason === 'orphan-row').length,
        nested: files.filter((f) => f.reason === 'nested-path').length,
        outsideDbScope: files.filter((f) => f.reason === 'outside-database-scope').length,
        missingOnDisk: missing.length,
        errors: errors.length,
      },
      errors,
    };
  }

  /** Report without absolute paths and without database internals. */
  function toReport(result) {
    return {
      checkedAt: result.checkedAt,
      ttlHours: result.ttlHours,
      storage: {
        uploadsDir: result.storage.uploadsDir,
        imagesDir: result.storage.imagesDir,
        videosDir: result.storage.videosDir,
        audioDir: result.storage.audioDir,
        trustedRoot: result.storage.trustedRoot,
        uploadsRealPath: result.storage.uploadsRealPath,
        trustedRootRealPath: result.storage.trustedRootRealPath,
        readable: result.storage.readable,
        imageCount: result.storage.imageCount,
        videoCount: result.storage.videoCount,
        audioCount: result.storage.audioCount,
        rootCount: result.storage.rootCount,
      },
      database: { available: result.database.available, files: result.database.files, videos: result.database.videos, orphanRows: result.database.orphanRows },
      counts: result.counts,
      blocked: result.blocked,
      // Every file the scan saw, with everything a human needs to judge it: where it is, how big, how
      // old, what kind, whether the database knows it, why it got this verdict and whether deleting it
      // would be allowed at all.
      files: result.files.map((f) => ({
        rel: f.rel,
        kind: f.kind,
        size: f.size,
        mtime: f.mtime,
        ageHours: f.ageHours,
        inDb: f.inDb,
        status: f.status,
        reason: f.reason,
        deletable: f.deletable,
        needsManualReview: Boolean(f.needsManualReview),
        note: f.note,
      })),
      manualReview: result.manualReview.map((f) => ({ rel: f.rel, status: f.status, reason: f.reason, size: f.size, mtime: f.mtime })),
      candidates: result.candidates.map((f) => ({ rel: f.rel, kind: f.kind, size: f.size, mtime: f.mtime, ageHours: f.ageHours, inDb: f.inDb, status: f.status, reason: f.reason })),
      missing: result.missing,
      errors: result.errors,
    };
  }

  function asArray(v) {
    return Array.isArray(v) ? v : null;
  }

  /**
   * Re-verifies one candidate against the current filesystem, database and trusted boundary. Returns a
   * plan item when removal is still proven, or a refusal reason. This is the same check used during
   * pre-removal planning and again immediately before each `rmSync`: state can change at any moment.
   *
   * TOCTOU note: between this check and the actual `rmSync` another process can still replace the
   * directory entry (symlink substitution, inode swap, delete-and-recreate). Node.js exposes no
   * portable "unlink this exact inode" call, so the window is reduced but not eliminated.
   */
  function verifyCandidate(f, now, boundary, imagesAbs, imagesReal) {
    if (!f || typeof f !== 'object') return { ok: false, rel: '(candidate)', reason: 'candidate-invalid' };
    const rel = typeof f.rel === 'string' ? f.rel : '(candidate)';

    if (f.status !== 'KNOWN_IN_DB') return { ok: false, rel, reason: `not-deletable:${String(f.status)}` };
    if (f.reason !== 'orphan-row') return { ok: false, rel, reason: `not-deletable:${String(f.reason)}` };
    if (f.needsManualReview !== false) return { ok: false, rel, reason: 'needs-manual-review' };
    if (f.kind !== 'images') return { ok: false, rel, reason: `not-deletable:kind-${String(f.kind)}` };
    if (typeof f.name !== 'string' || f.name.length === 0 || f.name.length > MAX_NAME || f.name !== path.basename(f.name)) {
      return { ok: false, rel, reason: 'outside-dir' };
    }

    const abs = path.resolve(f.abs || path.join(imagesAbs, f.name));
    const baseName = path.basename(abs);
    if (!samePath(path.dirname(abs), imagesAbs) || !samePath(baseName, f.name)) return { ok: false, rel, reason: 'outside-dir' };
    if (!isInside(imagesAbs, abs)) return { ok: false, rel, reason: 'outside-dir' };

    // Parent directory must still be a real directory inside the verified root — a symlinked or
    // redirected parent would mean the resolved path is no longer the one the scan vetted.
    const parentStat = safeStat(path.dirname(abs));
    if (!parentStat.ok || !parentStat.stat.isDirectory() || parentStat.stat.isSymbolicLink()) {
      return { ok: false, rel, reason: 'parent-not-plain-dir' };
    }
    const parentReal = realpathOf(path.dirname(abs));
    if (!parentReal.ok) return { ok: false, rel, reason: 'parent-unresolved' };
    if (!isInside(imagesReal.path, parentReal.path)) return { ok: false, rel, reason: 'parent-outside-root' };
    if (dirKey(parentReal.path) !== dirKey(imagesReal.path)) return { ok: false, rel, reason: 'parent-changed' };

    const absReal = realpathOf(abs);
    if (!absReal.ok) return { ok: false, rel, reason: 'changed-since-scan' };
    if (!isInside(imagesReal.path, absReal.path)) return { ok: false, rel, reason: 'outside-dir' };
    if (dirKey(path.dirname(absReal.path)) !== dirKey(imagesReal.path) || !samePath(path.basename(absReal.path), f.name)) {
      return { ok: false, rel, reason: 'changed-since-scan' };
    }

    const stat = safeStat(abs);
    if (!stat.ok || !stat.stat.isFile() || stat.stat.isSymbolicLink()) return { ok: false, rel, reason: 'changed-since-scan' };

    const fp = f.fingerprint;
    if (!fp || typeof fp !== 'object') return { ok: false, rel, reason: 'fingerprint-missing' };
    const sizeOk = Number.isInteger(fp.size) && fp.size >= 0;
    const mtimeOk = typeof fp.mtimeMs === 'number' && Number.isFinite(fp.mtimeMs) && fp.mtimeMs > 0;
    const inoOk = Number.isInteger(fp.ino) && fp.ino >= 0;
    if (!sizeOk || !mtimeOk || !inoOk) return { ok: false, rel, reason: 'fingerprint-invalid' };
    if (stat.stat.size !== fp.size || stat.stat.mtimeMs !== fp.mtimeMs || (stat.stat.ino ?? 0) !== fp.ino) {
      return { ok: false, rel, reason: 'changed-since-scan' };
    }

    const proof = orphanProof(f.name, now);
    if (!proof.ok) return { ok: false, rel, reason: `orphan-unproven:${proof.code}` };
    if (!proof.proven) return { ok: false, rel, reason: 'orphan-unproven' };

    // Containment relative to the current trusted boundary is re-asserted by the caller each time; the
    // resolved paths above are sufficient to confirm the file is still inside the verified images root.
    return { ok: true, rel, abs, name: f.name };
  }

  function resolveVerifiedImages(boundary) {
    if (!boundary || !boundary.usable) return { ok: false, blocked: [boundaryBlockCode(boundary || { trustedCheck: { missing: true } })], reason: 'boundary-unverified' };
    const uploadsReal = boundary.uploadsReal.path;
    const imagesAbs = path.resolve(imagesDir);
    const imagesCheck = checkRoot(imagesAbs);
    if (!imagesCheck.ok) {
      const base = 'IMAGES_DIR';
      const code = imagesCheck.link ? `${base}_IS_LINK` : imagesCheck.unresolved ? `${base}_PATH_UNRESOLVED` : `${base}_UNAVAILABLE`;
      return { ok: false, blocked: [code], reason: imagesCheck.link ? 'root-is-link' : imagesCheck.unresolved ? 'root-path-unresolved' : 'root-unavailable' };
    }
    const imagesReal = realpathOf(imagesAbs);
    if (!imagesReal.ok) return { ok: false, blocked: ['IMAGES_DIR_PATH_UNRESOLVED'], reason: 'root-path-unresolved' };
    if (!isInside(uploadsReal, imagesReal.path)) return { ok: false, blocked: ['IMAGES_DIR_OUTSIDE_UPLOADS'], reason: 'boundary-unverified' };
    return { ok: true, imagesAbs, imagesReal };
  }

  /**
   * Deletes only candidates issued by this inventory instance for the given scan result, re-checking the
   * trusted boundary, the images root, the candidate's identity, its fingerprint and its orphan proof
   * before planning and again immediately before every `rmSync`. A blocked or unverified scan deletes
   * nothing. Never throws.
   *
   * Semantics (not a transaction): the full plan is verified before the first removal, but state can still
   * change during execution. If a pre-removal re-check fails after earlier files were deleted, the
   * operation stops with a partial result (`removed` contains what was already removed). An fs/DB error on
   * a single item is reported in `failed` and does not make the run atomic.
   *
   * Known limitation (TOCTOU, not eliminated): between the final pre-rm check and `rmSync` another process
   * can still replace the directory entry. Node exposes no portable "unlink this exact inode" call; the
   * observable checks reduce the window but do not remove it.
   */
  function apply(result) {
    try {
      const removed = [];
      const failed = [];
      const skipped = [];
      if (!result || typeof result !== 'object') {
        return { removed, failed, skipped: [{ rel: '(result)', reason: 'invalid-result' }], blocked: ['INVALID_RESULT'] };
      }
      const blockedList = asArray(result.blocked);
      if (!blockedList) {
        return { removed, failed, skipped: [{ rel: '(result)', reason: 'invalid-result' }], blocked: ['INVALID_RESULT'] };
      }
      if (blockedList.length) return { removed, failed, skipped, blocked: [...blockedList] };

      const scanId = result.__scanId;
      if (typeof scanId !== 'string' || !scanRegistry.has(scanId)) {
        return { removed, failed, skipped: [{ rel: '(scan)', reason: 'scan-result-unverified' }], blocked: ['SCAN_RESULT_UNVERIFIED'] };
      }
      const issued = scanRegistry.get(scanId).issued;
      const candidates = asArray(result.candidates);
      if (!candidates) {
        return { removed, failed, skipped: [{ rel: '(result)', reason: 'invalid-result' }], blocked: ['INVALID_RESULT'] };
      }

      const boundary = resolveBoundary();
      const env = resolveVerifiedImages(boundary);
      if (!env.ok) {
        return { removed, failed, skipped: [{ rel: '(boundary)', reason: env.reason }], blocked: env.blocked };
      }

      const now = Date.now();
      const plan = [];
      for (const f of candidates) {
        const rel = f && typeof f === 'object' && typeof f.rel === 'string' ? f.rel : '(candidate)';
        if (!issued.has(f)) {
          return { removed, failed, skipped: [{ rel, reason: 'candidate-not-issued' }], blocked: ['CANDIDATE_UNVERIFIED'] };
        }
        const v = verifyCandidate(f, now, boundary, env.imagesAbs, env.imagesReal);
        if (!v.ok) {
          return { removed, failed, skipped: [{ rel: v.rel, reason: v.reason }], blocked: ['CANDIDATE_UNVERIFIED'] };
        }
        plan.push({ f, rel: v.rel, abs: v.abs, name: v.name });
      }

      for (const item of plan) {
        // Re-verify the trusted boundary, the images root and the file immediately before deletion.
        const b2 = resolveBoundary();
        const e2 = resolveVerifiedImages(b2);
        if (!e2.ok) {
          return { removed, failed, skipped: [{ rel: item.rel, reason: e2.reason }], blocked: e2.blocked };
        }
        const v2 = verifyCandidate(item.f, Date.now(), b2, e2.imagesAbs, e2.imagesReal);
        if (!v2.ok) {
          return { removed, failed, skipped: [{ rel: item.rel, reason: v2.reason }], blocked: ['CANDIDATE_UNVERIFIED'] };
        }

        // Final pre-rmSync parent stability check: the parent directory must still resolve to the
        // same physical path inside the verified root, and must not have become a link.
        const parentStat2 = safeStat(path.dirname(v2.abs));
        if (!parentStat2.ok || !parentStat2.stat.isDirectory() || parentStat2.stat.isSymbolicLink()) {
          return { removed, failed, skipped: [{ rel: item.rel, reason: 'parent-not-plain-dir' }], blocked: ['PARENT_UNSTABLE'] };
        }
        const parentReal2 = realpathOf(path.dirname(v2.abs));
        if (!parentReal2.ok) {
          return { removed, failed, skipped: [{ rel: item.rel, reason: 'parent-unresolved' }], blocked: ['PARENT_UNRESOLVED'] };
        }
        if (dirKey(parentReal2.path) !== dirKey(e2.imagesReal.path)) {
          return { removed, failed, skipped: [{ rel: item.rel, reason: 'parent-changed' }], blocked: ['PARENT_CHANGED'] };
        }

        try {
          fs.rmSync(v2.abs, { force: true });
          // Post-delete verification: the path must no longer resolve to the same file. If it still
          // exists with the same fingerprint, something else was deleted or a replacement appeared.
          const after = safeStat(v2.abs);
          if (after.ok && after.stat.isFile() && after.stat.size === item.f.fingerprint?.size && after.stat.mtimeMs === item.f.fingerprint?.mtimeMs) {
            // A file with the same fingerprint now sits at the path — the original may have been
            // replaced after our check. Do not delete the DB row either.
            removed.pop();
            return { removed, failed: [{ rel: item.rel, stage: 'file', code: 'EREPLACED', message: 'file replaced after deletion check' }], skipped: [{ rel: item.rel, reason: 'replaced-after-delete' }], blocked: ['FILE_REPLACED'] };
          }
          removed.push(item.rel);
          // Before dropping the DB row, re-verify it still exists and is still provably orphan —
          // another process may have added a video_assets reference between checks.
          const row = query(db, 'SELECT id FROM files WHERE filename = ? AND created_at < ? AND id NOT IN (SELECT file_id FROM video_assets)', item.name, new Date(Date.now() - ttlMs).toISOString());
          if (!row.ok || row.rows.length === 0) {
            failed.push({ rel: item.rel, stage: 'db', code: 'EROWGONE', message: 'db row no longer provably orphan' });
          } else {
            try {
              db.prepare('DELETE FROM files WHERE filename = ?').run(item.name);
            } catch (err) {
              failed.push({ rel: item.rel, stage: 'db', code: err && err.code || 'ESQL', message: err && err.message || String(err) });
            }
          }
        } catch (err) {
          failed.push({ rel: item.rel, stage: 'file', code: err && err.code || 'EFS', message: err && err.message || String(err) });
        }
      }
      return { removed, failed, skipped, blocked: [] };
    } catch (err) {
      return { removed: [], failed: [{ rel: '(apply)', stage: 'internal', code: err && err.code || 'EINTERNAL', message: err && err.message || String(err) }], skipped: [], blocked: ['APPLY_ERROR'] };
    }
  }

  return { scan, apply, toReport, probeDatabase };
}