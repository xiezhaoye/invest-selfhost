// K 线缓存服务：按需拉取 + 增量 upsert + 过期刷新 + 上游失败保留旧缓存。
//
// 与 quotes/service.js 的分工（刻意分开，契约里有明确要求）：
//   - quotes/service.js 负责「10 分钟一跑的全量最新快照」，只碰 watchlist_quotes。
//   - 这里负责「用户打开详情时才发起的单资产历史」，只碰 watchlist_candles。
//   两者不共享定时器，K 线历史永远不会被塞进那次 10 分钟批量刷新。
import { INTERVAL_MS, RANGES_BY_INTERVAL } from './candles.js';

// 已收盘的历史 candle 长期保留；只有「当前这根未收盘的」会过期重取。
//
// TTL 按「这根 candle 多久才会真正变化」来定，而不是一刀切：
//   - 日线：盘中一直在变，10 分钟（契约指定）。
//   - 周线：本周这根要到周末才定稿，日内变化很小；10 分钟重拉等于白白打上游
//     （实测 Yahoo 单次 0.9~4.5 秒）。用户决定放宽到 4 小时。
//   - 月线：同理，本月这根一天内基本不动。放宽到 24 小时。
// 放宽只影响「未收盘那根」的重取频率；历史 candle 一直是长期保留的，
// 且上游失败时仍会降级返回旧缓存，不会因为 TTL 变长而少拿到数据。
const OPEN_CANDLE_TTL_MS = {
  '1d': 10 * 60 * 1000,        // 10 分钟
  '1w': 4 * 60 * 60 * 1000,    // 4 小时
  '1M': 24 * 60 * 60 * 1000,   // 24 小时
};

// CoinGecko 免费套餐拿不到长历史：如实告知，而不是当成错误。
const COINGECKO_NOTE = '该币种的历史深度受数据源（CoinGecko）限制，实际区间可能短于所选范围';

export function createCandleService({ db, candleAdapters }) {
  // 同一资产+周期的并发请求合并，避免用户连点/多标签页打出重复上游请求
  const inflight = new Map();
  // 后台重拉的句柄（仅用于测试收尾 / 关停时等待，不参与业务逻辑）
  const background = new Set();

  // 缓存归属：'watch' = 自选资产（owner_key 是 watchlist asset id，
  // 仍由外键级联删除）；'pf' = 持仓标的（owner_key 是 `category:symbol`，无外键）。
  // 两者共用一张表、共用一个适配器，但键空间分开，互不覆盖。
  function ownerOf(asset) {
    return asset.owner === 'pf'
      ? { owner: 'pf', key: `${asset.category}:${asset.normalized_symbol}` }
      : { owner: 'watch', key: asset.id };
  }

  function keyOf(assetId, interval) {
    return `${assetId}\u0000${interval}`;
  }

  function readCached(asset, interval) {
    const o = ownerOf(asset);
    return db.prepare(`
      SELECT open_time_ms, open, high, low, close, volume, source_name, fetched_at, range
      FROM candle_cache
      WHERE owner = ? AND owner_key = ? AND interval = ?
      ORDER BY open_time_ms ASC
    `).all(o.owner, o.key, interval);
  }

  // range 的深度序：同一 interval 内越靠后覆盖越久。请求的档位比缓存「更深」
  // 说明缓存不够用，必须重新拉，不能当成命中。
  function rangeDepth(interval, range) {
    const list = RANGES_BY_INTERVAL[interval] || [];
    const i = list.indexOf(range);
    return i < 0 ? -1 : i;
  }
  // 这批缓存覆盖到哪个 range：取其中最深的那个。空串是 v4 之前写的老数据，
  // 按「只有默认档」处理（它在 v3 时代只能是默认档）。
  function cachedRangeOf(rows, interval) {
    let best = null, bestDepth = -1;
    for (const r of rows) {
      const rg = r.range || '';
      const d = rg ? rangeDepth(interval, rg) : 0;
      if (d > bestDepth) { bestDepth = d; best = rg || null; }
    }
    return best;
  }

  // 缓存是否可用：必须有 candles；且「最后一根已收盘」或「距上次抓取未超 TTL」。
  // 为空一律视为未命中（空结果不缓存，避免上游一次抖动把空数组钉死）。
  function assessFreshness(rows, interval, now = Date.now()) {
    if (!rows.length) return { hit: false, stale: false, updatedAt: null };
    const last = rows[rows.length - 1];
    const lastOpen = Number(last.open_time_ms);
    const bucket = INTERVAL_MS[interval] || INTERVAL_MS['1d'];
    const closed = now - lastOpen >= bucket;
    const fetchedAtMs = Date.parse(last.fetched_at);
    const fresh = Number.isFinite(fetchedAtMs)
      ? now - fetchedAtMs < (OPEN_CANDLE_TTL_MS[interval] || OPEN_CANDLE_TTL_MS['1d'])
      : false;
    // 已收盘 → 直接命中；未收盘 → 看这次抓取是否还在 TTL 内
    return { hit: closed || fresh, stale: false, updatedAt: last.fetched_at };
  }

  function upsertCandles(asset, interval, candles, sourceName, fetchedAt, range) {
    const o = ownerOf(asset);
    // watch_asset_id 只在自选时写：它挂着外键，删自选资产时由数据库级联清理。
    // 持仓没有对应行，写 NULL（自选删除与持仓缓存互不影响）。
    const stmt = db.prepare(`
      INSERT INTO candle_cache
        (owner, owner_key, interval, open_time_ms, open, high, low, close, volume,
         source_name, fetched_at, range, watch_asset_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner, owner_key, interval, open_time_ms) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume,
        source_name = excluded.source_name,
        fetched_at = excluded.fetched_at,
        range = excluded.range
    `);
    db.exec('BEGIN');
    try {
      for (const c of candles) {
        stmt.run(
          o.owner, o.key, interval, Number(c.open_time_ms),
          c.open, c.high, c.low, c.close,
          c.volume == null ? null : c.volume,
          sourceName, fetchedAt, range || '',
          o.owner === 'watch' ? o.key : null
        );
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  // 返回契约形状；stale=true 表示上游这次失败、给的是旧缓存。
  function toPayload(assetId, interval, range, rows, opts) {
    const {
      stale, sourceName, currency, updatedAt,
      limitedHistory = false, note = null, refreshing = false,
    } = opts;
    return {
      ok: true,
      asset_id: assetId,
      interval,
      range,
      currency: currency ?? null,
      source_name: sourceName ?? null,
      updated_at: updatedAt ?? null,
      stale: !!stale,
      // refreshing：这批数据是缓存命中、后台正在重拉，下一次请求拿到的是新的。
      // 与 stale 区分：stale 表示「上游失败、数据可能已过期」，refreshing 只是「正在更新」。
      refreshing: !!refreshing,
      // limited_history：数据源可用历史深度不足以覆盖请求范围（如 CoinGecko 免费套餐）。
      // 这是「能画多少画多少 + 明确提示」，不是错误。
      limited_history: !!limitedHistory,
      ...(note ? { note } : {}),
      candles: rows.map(r => [
        Number(r.open_time_ms),
        r.open, r.high, r.low, r.close,
        r.volume == null ? null : r.volume,
      ]),
    };
  }

  // 后台重拉：不阻塞请求方，失败静默（旧缓存仍可用）。
  // 与前台请求共用 inflight，避免同时打两次上游。
  function revalidate(asset, interval, range) {
    const k = keyOf(asset.id, interval);
    if (inflight.has(k)) return inflight.get(k);
    const task = (async () => {
      try {
        const res = await candleAdapters.fetchCandles(asset.category, asset.normalized_symbol, {
          interval, range,
        });
        if (!res.candles.length) return;
        upsertCandles(asset.id, interval, res.candles, res.source_name,
          new Date().toISOString(), range);
      } catch { /* 后台刷新失败：保留旧数据，等下次请求再试 */ }
      finally { inflight.delete(k); background.delete(task); }
    })();
    inflight.set(k, task);
    background.add(task);
    return task;
  }

  // 主入口：命中缓存直接返回；否则拉上游 → upsert → 返回。
  // 上游失败但缓存存在时返回缓存并标 stale；连缓存都没有才抛。
  async function getCandles({ asset, interval, range }) {
    const assetId = asset.id;
    const cachedRows = readCached(asset, interval);
    const fresh = assessFreshness(cachedRows, interval);
    // 缓存的时间新鲜度之外，还要看档位够不够深：请求 1y 却只有 6mo 的数据
    // 不能算命中，否则前端放大永远拿不到更长历史。
    const cachedRange = cachedRangeOf(cachedRows, interval);
    const deepEnough = cachedRows.length > 0
      && rangeDepth(interval, cachedRange || RANGES_BY_INTERVAL[interval][0]) >= rangeDepth(interval, range);
    if (fresh.hit && deepEnough) {
      const last = cachedRows[cachedRows.length - 1];
      return toPayload(assetId, interval, cachedRange || range, cachedRows, {
        stale: false,
        sourceName: last.source_name,
        currency: null,
        updatedAt: last.fetched_at,
        limitedHistory: last.source_name === 'coingecko',
        note: last.source_name === 'coingecko' ? COINGECKO_NOTE : null,
      });
    }

    // ── stale-while-revalidate ──
    // 有缓存但不够新鲜时，不再让用户干等上游（实测 Yahoo 单次要 0.9~4.5 秒）：
    // 立刻返回旧缓存，同时在后台重拉；下次进来就是新的。
    // 只有「连缓存都没有」或「档位不够深」才同步等上游 —— 前者没东西可给，
    // 后者是用户主动放大要更多数据，必须等到。
    const k = keyOf(assetId, interval);
    if (cachedRows.length && fresh.hit === false && deepEnough) {
      revalidate(asset, interval, range);
      const last = cachedRows[cachedRows.length - 1];
      return toPayload(assetId, interval, cachedRange || range, cachedRows, {
        stale: false,                       // 数据本身有效
        refreshing: true,                   // 后台正在重拉
        sourceName: last.source_name,
        currency: null,
        updatedAt: last.fetched_at,
        limitedHistory: last.source_name === 'coingecko',
        note: last.source_name === 'coingecko' ? COINGECKO_NOTE : null,
      });
    }

    // 并发合并：同一 asset+interval 的第二次请求挂到第一次上
    if (inflight.has(k)) return inflight.get(k);

    const task = (async () => {
      try {
        const res = await candleAdapters.fetchCandles(asset.category, asset.normalized_symbol, {
          interval, range,
        });
        if (!res.candles.length) throw new Error('上游没有可绘制的 K 线数据');
        const fetchedAt = new Date().toISOString();
        upsertCandles(asset, interval, res.candles, res.source_name, fetchedAt, range);
        const rows = readCached(asset, interval);
        const limited = res.source_name === 'coingecko' || res.limited_history === true;
        return toPayload(assetId, interval, range, rows, {
          stale: false,
          sourceName: res.source_name,
          currency: res.currency,
          updatedAt: fetchedAt,
          limitedHistory: limited,
          note: limited ? COINGECKO_NOTE : null,
        });
      } catch (err) {
        // 上游失败：有旧缓存就降级返回并标 stale，让前端能显示「陈旧」而不是空白
        if (cachedRows.length) {
          const last = cachedRows[cachedRows.length - 1];
          return toPayload(assetId, interval, cachedRange || range, cachedRows, {
            stale: true,
            sourceName: last.source_name,
            currency: null,
            updatedAt: last.fetched_at,
            limitedHistory: last.source_name === 'coingecko',
            note: last.source_name === 'coingecko' ? COINGECKO_NOTE : null,
          });
        }
        throw err;
      } finally {
        inflight.delete(k);
      }
    })();
    inflight.set(k, task);
    return task;
  }

  // 等待所有后台重拉结束。测试收尾必须调用，否则未决的 promise 会让
  // node:test 进程不退出（真实服务里这些请求会自然完成，无影响）。
  async function drainBackground() {
    while (background.size) {
      await Promise.allSettled([...background]);
    }
  }

  return {
    getCandles, drainBackground,
    _readCached: readCached, _assessFreshness: assessFreshness,
  };
}
