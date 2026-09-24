// 登录会话：用户名/密码来自环境变量，登录成功后签发一个随机会话令牌。
//
// 两条安全约束决定了这里的实现：
//   1. 会话令牌是「持票即登录」的，等价于密码 —— 所以库里只存 sha256，
//      库被读走也不等于能登录。
//   2. 登录失败需要限流，避免在线猜测凭据。
import crypto from 'node:crypto';
import { config } from './config.js';

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

// 定长摘要比较：先各自 sha256 再比较，长度差和前缀差都不体现在耗时上。
export function sameSecret(a, b) {
  const da = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const db = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(da, db);
}

// 滑动续期的写库节流：登录态请求远多于 6 小时一次，没必要每个 GET 都写一次库。
const TOUCH_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function createAuth({ db, ttlMs = config.sessionTtlMs, now = () => Date.now() } = {}) {
  const stmt = {
    get: db.prepare('SELECT token_hash, username, created_at, last_seen_at, expires_at FROM auth_sessions WHERE token_hash = ?'),
    insert: db.prepare(`INSERT INTO auth_sessions (token_hash, username, created_at, last_seen_at, expires_at, user_agent)
                        VALUES (?, ?, ?, ?, ?, ?)`),
    touch: db.prepare('UPDATE auth_sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?'),
    remove: db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?'),
    purge: db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM auth_sessions WHERE expires_at > ?'),
  };

  const iso = ms => new Date(ms).toISOString();

  // 内存限流：{ ip: { fails, firstAt, blockedUntil } }。单进程单实例，够用。
  const MAX_FAILS = 8;
  const FAIL_WINDOW_MS = 15 * 60 * 1000;
  const BLOCK_MS = 15 * 60 * 1000;
  const attempts = new Map();

  function attemptState(ip) {
    const key = ip || 'unknown';
    let s = attempts.get(key);
    if (!s) { s = { fails: 0, firstAt: 0, blockedUntil: 0 }; attempts.set(key, s); }
    return s;
  }

  function blockedFor(ip) {
    const s = attemptState(ip);
    if (!s.blockedUntil) return 0;
    const left = s.blockedUntil - now();
    if (left <= 0) { s.blockedUntil = 0; s.fails = 0; return 0; }
    return left;
  }

  function noteFailure(ip) {
    const t = now();
    const s = attemptState(ip);
    if (!s.firstAt || t - s.firstAt > FAIL_WINDOW_MS) { s.firstAt = t; s.fails = 0; }
    s.fails += 1;
    if (s.fails >= MAX_FAILS) { s.blockedUntil = t + BLOCK_MS; s.fails = 0; s.firstAt = 0; }
  }

  function clearFailures(ip) {
    attempts.delete(ip || 'unknown');
  }

  function isConfigured() {
    return !!(config.authUser && config.authPass);
  }

  function login({ username, password, ip, userAgent } = {}) {
    if (!isConfigured()) return { ok: false, code: 'AUTH_DISABLED', message: '服务未启用登录（未配置用户名/密码）' };

    const wait = blockedFor(ip);
    if (wait > 0) {
      return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: `登录失败次数过多，请 ${Math.ceil(wait / 60000)} 分钟后再试` };
    }

    // 两个都算完再判断：不因为「用户名错」比「密码错」快一点而暴露用户名是否存在。
    const userOk = sameSecret(username || '', config.authUser);
    const passOk = sameSecret(password || '', config.authPass);
    if (!userOk || !passOk) {
      noteFailure(ip);
      return { ok: false, code: 'BAD_CREDENTIALS', message: '用户名或密码不正确' };
    }

    clearFailures(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const t = now();
    stmt.insert.run(sha256(token), config.authUser, iso(t), iso(t), iso(t + ttlMs), userAgent || null);
    return { ok: true, token, username: config.authUser, expires_at: iso(t + ttlMs) };
  }

  // 返回 { username, expires_at } 或 null；顺带按需滑动续期。
  function verify(token) {
    if (!token) return null;
    const row = stmt.get.get(sha256(token));
    if (!row) return null;
    const t = now();
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= t) {
      stmt.remove.run(row.token_hash);
      return null;
    }
    let nextExpiresAt = expiresAt;
    if (t - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
      nextExpiresAt = t + ttlMs;
      stmt.touch.run(iso(t), iso(nextExpiresAt), row.token_hash);
    }
    return { username: row.username, expires_at: iso(nextExpiresAt) };
  }

  function logout(token) {
    if (!token) return false;
    return stmt.remove.run(sha256(token)).changes > 0;
  }

  function purgeExpired() {
    return stmt.purge.run(iso(now())).changes;
  }

  function activeCount() {
    return stmt.count.get(iso(now())).n;
  }

  return { login, verify, logout, purgeExpired, activeCount, isConfigured, ttlMs };
}
