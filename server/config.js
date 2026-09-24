// 环境配置。凭据只从环境变量注入，不落盘、不进 git。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;

function num(name, fallback) {
  const v = Number(env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  root: ROOT,
  host: env.INVEST_HOST || '127.0.0.1',
  port: num('INVEST_PORT', 8787),
  dbPath: env.INVEST_DB_PATH || path.join(ROOT, 'data', 'invest.sqlite'),
  staticDir: env.INVEST_STATIC_DIR || path.join(ROOT, 'web'),
  // 人用的登录凭据（用户名/密码）
  authUser: env.INVEST_AUTH_USER || '',
  authPass: env.INVEST_AUTH_PASS || '',
  // 供其他服务调用 API 的令牌；浏览器登录不需要它。
  // 与登录会话是「或」的关系，两者都能通过鉴权。
  apiToken: env.INVEST_API_TOKEN || '',
  // 登录态有效期（滑动续期）；默认 180 天，够「一个浏览器只登一次」。
  sessionTtlMs: num('INVEST_SESSION_TTL_MS', 180 * 24 * 60 * 60 * 1000),
  // 出网代理（如 http://127.0.0.1:2140）；空 = 直连
  proxyUrl: (env.INVEST_PROXY_URL || '').replace(/\/+$/, ''),
  refreshIntervalMs: num('INVEST_REFRESH_INTERVAL_MS', 10 * 60 * 1000),
  quoteConcurrency: num('INVEST_QUOTE_CONCURRENCY', 4),
  // 手动刷新并发：用户在前台等待，比定时任务略高（默认 6）。
  manualQuoteConcurrency: num('INVEST_MANUAL_QUOTE_CONCURRENCY', 6),
  requestTimeoutMs: num('INVEST_REQUEST_TIMEOUT_MS', 8000),
  // 金十 MCP 的 Key 仅运行在服务端；不可下发浏览器、不可提交 git。
  jinshiToken: env.JIN10_MCP_TOKEN || '',
  jinshiCalendarCacheMs: num('INVEST_JINSHI_CALENDAR_CACHE_MS', 5 * 60 * 1000),
  // 持仓报价缓存：默认 60 秒（契约约定）。force=1 / 刷新按钮跳过。
  portfolioQuoteCacheMs: num('PORTFOLIO_QUOTE_CACHE_MS', 60 * 1000),
  // 汇率缓存：默认 6 小时。过期后会先返回旧值并在后台更新。
  fxCacheMs: num('INVEST_FX_CACHE_MS', 6 * 60 * 60 * 1000),
  // 开源版新库默认写入可见的演示数据；设为 0 可关闭。已有数据绝不受影响。
  seedDemoData: env.INVEST_SEED_DEMO_DATA !== '0',
};

// 有没有任何可用凭据。都没有时 v1 接口整体拒绝（只读/停工模式）。
export function authEnabled() {
  return !!(config.apiToken || (config.authUser && config.authPass));
}

export function describeConfig() {
  return {
    host: config.host,
    port: config.port,
    dbPath: config.dbPath,
    proxy: config.proxyUrl ? 'configured' : 'direct',
    refreshIntervalMs: config.refreshIntervalMs,
    auth: config.authUser ? 'login:configured' : 'none',
    apiToken: config.apiToken ? 'configured' : 'absent',
  };
}
