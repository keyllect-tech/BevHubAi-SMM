import crypto from 'crypto';
import { promisify } from 'util';
import { Router } from 'express';
import { newId, nowIso, transaction } from './db.js';
import { createRateLimiter, retryAfterSeconds } from './rate-limit.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'bh_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
// A second, independent counter: one address may try many different emails (credential stuffing).
// Counting per email alone lets a single host spray the whole user list.
const LOGIN_MAX_FAILURES_PER_IP = 10;
const IP_RE = /^[0-9a-f:.]+$/i;
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-proto'];

/**
 * Client address as Express sees it. `req.ip` already applies `trust proxy`: with the shipped
 * `trust proxy = 'loopback'` a spoofed X-Forwarded-For is ignored unless the request really came
 * from the local reverse proxy, so an outside client cannot pick its own bucket key.
 * Returns null when the address is missing or malformed (never guess).
 */
function clientIp(req) {
  const raw = String(req.ip || req.socket?.remoteAddress || '')
    .trim()
    .replace(/^::ffff:/i, '');
  if (!raw || raw.includes(',') || !IP_RE.test(raw)) return null;
  return raw;
}

const isProxyAddress = (ip) =>
  ip === '::1' ||
  /^127\./.test(ip) ||
  /^10\./.test(ip) ||
  /^192\.168\./.test(ip) ||
  /^169\.254\./.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
  /^f[cd][0-9a-f]{2}:/i.test(ip);
const looksProxied = (req) => PROXY_HEADERS.some((name) => req.headers[name] !== undefined);

// Set once per process so a misconfigured proxy is visible in the log without flooding it.
let warnedSharedIp = false;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// A dummy hash so login timing does not reveal whether an email exists.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function cookieOptions() {
  // SameSite=None (needed when the frontend runs on a different origin than the API) only works
  // on HTTPS, so it implies Secure.
  const sameSite = (process.env.COOKIE_SAMESITE || 'lax').toLowerCase();
  return {
    httpOnly: true,
    sameSite,
    secure: process.env.COOKIE_SECURE === 'true' || sameSite === 'none',
    path: '/',
  };
}

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
}

function publicWorkspace(row) {
  return row ? { id: row.id, user_id: row.user_id, name: row.name, demo_mode: Boolean(row.demo_mode), created_at: row.created_at } : null;
}

export function createAuth(db) {
  // Login failures are counted in SQLite: a restart must not reset a brute-force counter.
  const loginLimiter = createRateLimiter(db);

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const expires = new Date(Date.now() + SESSION_TTL_MS);
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
      sha256(token),
      userId,
      expires.toISOString(),
      nowIso()
    );
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), expires });
  }

  function loadSession(req) {
    const token = readCookie(req, SESSION_COOKIE);
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT s.token_hash, s.expires_at, u.id AS user_id, u.email, u.name, u.created_at AS user_created_at,
                w.id AS workspace_id, w.name AS workspace_name, w.demo_mode, w.created_at AS workspace_created_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         JOIN workspaces w ON w.user_id = u.id
         WHERE s.token_hash = ?`
      )
      .get(sha256(token));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
      return null;
    }
    return {
      tokenHash: row.token_hash,
      user: { id: row.user_id, email: row.email, name: row.name, created_at: row.user_created_at },
      workspace: {
        id: row.workspace_id,
        user_id: row.user_id,
        name: row.workspace_name,
        demo_mode: Boolean(row.demo_mode),
        created_at: row.workspace_created_at,
      },
    };
  }

  function requireAuth(req, res, next) {
    const session = loadSession(req);
    if (!session) {
      res.clearCookie(SESSION_COOKIE, cookieOptions());
      return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
    }
    req.user = session.user;
    req.workspace = session.workspace;
    next();
  }

  const router = Router();

  router.post('/register', async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';

    if (!name) return res.status(400).json({ error: 'Укажите имя' });
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'Некорректный email' });
    if (password.length < 8) return res.status(400).json({ error: 'Пароль должен быть не менее 8 символов' });
    if (password.length > 200) return res.status(400).json({ error: 'Пароль слишком длинный' });

    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
    }

    const passwordHash = await hashPassword(password);
    const userId = newId();
    const workspaceId = newId();
    const createdAt = nowIso();
    try {
      transaction(db, () => {
        db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
          userId,
          email,
          name,
          passwordHash,
          createdAt
        );
        db.prepare('INSERT INTO workspaces (id, user_id, name, demo_mode, created_at) VALUES (?, ?, ?, 1, ?)').run(
          workspaceId,
          userId,
          `Пространство «${name}»`,
          createdAt
        );
        db.prepare(
          "INSERT INTO subscriptions (id, workspace_id, plan, monthly_limit, status, created_at) VALUES (?, ?, 'starter', 15, 'active', ?)"
        ).run(newId(), workspaceId, createdAt);
      });
    } catch (err) {
      if (String(err.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'Пользователь с таким email уже зарегистрирован' });
      }
      throw err;
    }

    startSession(res, userId);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const workspace = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId);
    res.status(201).json({ user: publicUser(user), workspace: publicWorkspace(workspace) });
  });

  router.post('/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'Введите email и пароль' });

    // Per-IP counter. It is skipped when the address is unknown, or when a proxy is in front but did
    // not forward the real client address: then every request looks like it came from the proxy
    // itself, and one key would lock out all users. The per-email counter still applies.
    const ip = clientIp(req);
    const sharedProxyIp = Boolean(ip) && isProxyAddress(ip) && looksProxied(req);
    if (sharedProxyIp && !warnedSharedIp) {
      warnedSharedIp = true;
      console.warn(
        '[AUTH] requests arrive from a proxy address that forwards no client IP — per-IP login limit is ' +
          'disabled (set X-Forwarded-For in the proxy and keep trust proxy limited to the proxy address)'
      );
    }
    const ipKey = ip && !sharedProxyIp ? sha256(ip) : null;

    // The address is hashed in both buckets: rate_events is plain SQLite, so raw client IPs stay out of it.
    const pairKey = `${sha256(ip || 'unknown')}|${email}`;
    const pairBlocked = loginLimiter.peek({ bucket: 'login', key: pairKey, windowMs: LOGIN_WINDOW_MS });
    const ipBlocked = ipKey
      ? loginLimiter.peek({ bucket: 'login_ip', key: ipKey, windowMs: LOGIN_WINDOW_MS })
      : 0;
    if (pairBlocked >= LOGIN_MAX_FAILURES || ipBlocked >= LOGIN_MAX_FAILURES_PER_IP) {
      const retryAfterMs =
        ipBlocked >= LOGIN_MAX_FAILURES_PER_IP
          ? loginLimiter.retryAfter({ bucket: 'login_ip', key: ipKey, windowMs: LOGIN_WINDOW_MS })
          : loginLimiter.retryAfter({ bucket: 'login', key: pairKey, windowMs: LOGIN_WINDOW_MS });
      res.setHeader('Retry-After', String(retryAfterSeconds(retryAfterMs)));
      return res.status(429).json({
        error:
          ipBlocked >= LOGIN_MAX_FAILURES_PER_IP
            ? 'Слишком много попыток входа с этого устройства. Попробуйте позже.'
            : 'Слишком много попыток входа. Попробуйте через 15 минут.',
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    const ok = await verifyPassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      loginLimiter.hit({ bucket: 'login', key: pairKey, limit: LOGIN_MAX_FAILURES, windowMs: LOGIN_WINDOW_MS });
      if (ipKey) {
        loginLimiter.hit({
          bucket: 'login_ip',
          key: ipKey,
          limit: LOGIN_MAX_FAILURES_PER_IP,
          windowMs: LOGIN_WINDOW_MS,
        });
      }
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    loginLimiter.reset({ bucket: 'login', key: pairKey });
    if (ipKey) loginLimiter.reset({ bucket: 'login_ip', key: ipKey });

    startSession(res, user.id);
    const workspace = db.prepare('SELECT * FROM workspaces WHERE user_id = ?').get(user.id);
    res.json({ user: publicUser(user), workspace: publicWorkspace(workspace) });
  });

  router.post('/logout', (req, res) => {
    const session = loadSession(req);
    if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(session.tokenHash);
    res.clearCookie(SESSION_COOKIE, cookieOptions());
    res.json({ ok: true });
  });

  // Guests get 200 with nulls: checking "am I logged in?" is not an error on public pages.
  router.get('/me', (req, res) => {
    const session = loadSession(req);
    if (!session) {
      if (readCookie(req, SESSION_COOKIE)) res.clearCookie(SESSION_COOKIE, cookieOptions());
      return res.json({ user: null, workspace: null });
    }
    res.json({ user: session.user, workspace: session.workspace });
  });

  // Expired sessions and old rate-limit rows are removed lazily; sweep them periodically. Both login
  // buckets are pruned by their own window, so live counters are never dropped.
  setInterval(() => {
    const ts = nowIso();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(ts);
    loginLimiter.prune({ bucket: 'login', windowMs: LOGIN_WINDOW_MS });
    loginLimiter.prune({ bucket: 'login_ip', windowMs: LOGIN_WINDOW_MS });
  }, 60 * 60 * 1000).unref();

  return { router, requireAuth };
}
