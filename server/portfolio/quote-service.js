// 持仓报价服务：按 (quote_category, normalized_symbol) 去重缓存 + 并发受限刷新。
//
// 与自选报价（watchlist_quotes）是**两套独立缓存**：
//   - 不把持仓偷偷插进 watchlist_assets，也不污染自选列表；
//   - 只复用底层适配器 createQuoteAdapters().fetchWatchlistQuote()。
//
// 两个关键点：
//   1. **去重**：同一标的在多个渠道持有（真实数据里 BMNR 就在 3 个渠道），
//      上游只请求一次。落库主键就是 (quote_category, normalized_symbol)。
//   2. **失败不清旧值**：上游挂了要保留上次成功的 price，只改 status/error_message，
//      否则一次抖动会让整份估值全变 null。
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db.js';
import { uniqueQuoteTargets } from './config.js';

export const DEFAULT_QUOTE_CACHE_MS = 60 * 1000;

function nowIso() { return new Date().toISOString(); }

// 并发受限的 map：保持顺序，单任务失败不影响其它任务。
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function createPortfolioQuoteService({
  db,
  adapters,
  cacheMs = DEFAULT_QUOTE_CACHE_MS,
  manualConcurrency = 6,
  now = () => Date.now(),
}) {
  let inflight = null;
  // 上次成功刷新完成的**本机时钟**时间戳。
  // 不能拿库里 updated_at 去和 now() 比：updated_at 是真实 ISO 时间，
  // 而 now() 是可注入的（测试里是假时钟），两者混用会让 TTL 判断失真。
  // 用同一个时钟记录、同一个时钟比较才自洽。
  let lastFetchedAtMs = null;

  function cachedAt() {
    const r = db.prepare('SELECT MAX(updated_at) AS t FROM portfolio_quotes').get();
    return r?.t || null;
  }

  function isFresh() {
    if (lastFetchedAtMs === null) return false;
    if (db.prepare('SELECT COUNT(*) AS n FROM portfolio_quotes').get().n === 0) return false;
    return (now() - lastFetchedAtMs) < cacheMs;
  }

  function rowsToJson() {
    const rows = db.prepare(`
      SELECT * FROM portfolio_quotes
      ORDER BY quote_category ASC, normalized_symbol ASC
    `).all();
    return rows.map(r => ({
      quote_category: r.quote_category,
      normalized_symbol: r.normalized_symbol,
      price: r.price ?? null,
      price_currency: r.price_currency ?? null,
      chg_pct: r.chg_pct ?? null,
      week_pct: r.week_pct ?? null,
      month_pct: r.month_pct ?? null,
      source_name: r.source_name ?? null,
      status: r.status,
      error_message: r.error_message ?? null,
      updated_at: r.updated_at ?? null,
      last_success_at: r.last_success_at ?? null,
    }));
  }

  function getCachedMap() {
    const m = new Map();
    for (const q of rowsToJson()) m.set(`${q.quote_category}|${q.normalized_symbol}`, q);
    return m;
  }

  // 真正拉取。targets 已去重，所以这里每个标的只会请求一次。
  async function doRefresh(targets) {
    const results = await mapLimit(targets, manualConcurrency, async (t) => {
      try {
        const q = await adapters.fetchWatchlistQuote(t.quote_category, t.normalized_symbol);
        return { target: t, quote: q, error: null };
      } catch (e) {
        return { target: t, quote: null, error: e.message || '行情源失败' };
      }
    });

    const ts = nowIso();
    let ok = 0, failed = 0;
    withTransaction(db, () => {
      const upsert = db.prepare(`
        INSERT INTO portfolio_quotes
          (quote_category, normalized_symbol, price, price_currency, chg_pct, week_pct, month_pct,
           source_name, status, error_message, updated_at, last_success_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(quote_category, normalized_symbol) DO UPDATE SET
          price           = excluded.price,
          price_currency  = excluded.price_currency,
          chg_pct         = excluded.chg_pct,
          week_pct        = excluded.week_pct,
          month_pct       = excluded.month_pct,
          source_name     = excluded.source_name,
          status          = excluded.status,
          error_message   = excluded.error_message,
          updated_at      = excluded.updated_at,
          last_success_at = excluded.last_success_at
      `);
      // 失败分支只改状态：用 COALESCE 保留旧价格，避免一次上游抖动把估值清空
      const markFail = db.prepare(`
        INSERT INTO portfolio_quotes
          (quote_category, normalized_symbol, status, error_message, updated_at)
        VALUES (?, ?, 'unavailable', ?, ?)
        ON CONFLICT(quote_category, normalized_symbol) DO UPDATE SET
          status        = 'unavailable',
          error_message = excluded.error_message,
          updated_at    = excluded.updated_at
      `);
      for (const r of results) {
        if (r.quote) {
          ok++;
          const q = r.quote;
          upsert.run(
            r.target.quote_category, r.target.normalized_symbol,
            numOrNull(q.price), q.price_currency ?? null,
            numOrNull(q.chg_pct), numOrNull(q.week_pct), numOrNull(q.month_pct),
            q.source_name ?? null, 'ok', null, ts, ts,
          );
        } else {
          failed++;
          markFail.run(r.target.quote_category, r.target.normalized_symbol, r.error, ts);
        }
      }
    });
    return { ok, failed, updated_at: ts };
  }

  // 进程重启后 lastFetchedAtMs 是 null，此时无法判断库里的快照有多旧。
  // 保守起见按「不新鲜」处理：宁可多拉一次，也不要把陈旧价格当成实时的。
  function noteFetched() { lastFetchedAtMs = now(); }

  // force=1 跳过缓存（手动刷新/估值强制刷新用）
  async function refresh(force = false) {
    const targets = uniqueQuoteTargets(db);
    if (targets.length === 0) {
      return { quotes: [], from_cache: false, refreshed_at: nowIso(), empty: true, counts: { ok: 0, failed: 0 } };
    }
    // 并发合流：同一时刻只跑一个刷新任务，后到的等它的结果
    if (inflight) {
      const r = await inflight;
      return { ...r, from_cache: true };
    }
    if (!force && isFresh()) {
      return { quotes: rowsToJson(), from_cache: true, refreshed_at: cachedAt() };
    }
    inflight = doRefresh(targets).finally(() => { inflight = null; });
    const counts = await inflight;
    noteFetched();
    return { quotes: rowsToJson(), from_cache: false, refreshed_at: counts.updated_at, counts };
  }

  // 只读缓存（不触发上游），用于估值默认路径
  function snapshot() {
    return { quotes: rowsToJson(), updated_at: cachedAt() };
  }

  // 库里是否有任何一行快照。用于区分「首次部署/新增标的（没东西可展示，只能等）」
  // 与「有旧数据但过期了（可以先展示旧的，后台再补）」。
  function hasSnapshot() {
    return db.prepare('SELECT COUNT(*) AS n FROM portfolio_quotes').get().n > 0;
  }

  // 后台刷新：不阻塞调用方。已有任务在跑就复用，不重复打上游。
  // 失败只记日志 —— 调用方已经拿到旧数据了，不该因为后台失败而报错。
  function refreshInBackground() {
    if (inflight) return inflight;
    Promise.resolve().then(() => {
      if (inflight) return inflight;                 // 微任务里再确认一次
      return refresh(false);
    }).catch(err => {
      console.error('[portfolio quotes] background refresh failed:', err?.message || err);
    });
    return null;
  }

  return { refresh, refreshInBackground, snapshot, hasSnapshot, isFresh, cacheMs };
}

function numOrNull(v) {
  return Number.isFinite(v) ? v : null;
}
