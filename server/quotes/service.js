// 刷新服务：10 分钟调度 / 手动合并去重 / 并发上限 / 单项失败隔离 / 快照落库。
// 关键约束：刷新失败不清空上次成功行情（保留 price 等字段，仅改 status 与 error）。
import { randomUUID } from 'node:crypto';
import { listAssets } from '../assets.js';
import { withTransaction } from '../db.js';

const MANUAL_DEDUPE_MS = 30 * 1000;

export function createRefreshService({
  db, adapters, intervalMs,
  concurrency = 4,                    // 定时刷新用（保守，避免长期占用上游配额）
  manualConcurrency = 10,             // 手动刷新用（用户在前台等待，值得多打一点并发）
}) {
  let running = null;       // 当前任务（内存态）
  let timer = null;

  function lastJob() {
    const r = db.prepare(
      'SELECT * FROM watchlist_refresh_jobs ORDER BY started_at DESC, id DESC LIMIT 1'
    ).get();
    return r ? jobRowToJson(r) : null;
  }

  function jobRowToJson(r) {
    return {
      id: r.id,
      trigger: r.trigger_source,
      status: r.status,
      started_at: r.started_at,
      finished_at: r.finished_at,
      ok_count: r.ok_count,
      failed_count: r.failed_count,
    };
  }

  function nextAt() {
    const last = lastJob();
    if (!last) return new Date().toISOString();
    return new Date(Date.parse(last.started_at) + intervalMs).toISOString();
  }

  function getInfo() {
    return {
      running: !!running,
      last: running ? jobRowToJson(runningRow()) : lastJob(),
      next_at: nextAt(),
    };
  }

  // 当前运行任务的库内行（内存引用 + 落库行保持同步）
  let runningRowCache = null;
  function runningRow() {
    return runningRowCache
      || (runningRowCache = db.prepare('SELECT * FROM watchlist_refresh_jobs WHERE id = ?').get(running));
  }

  // 触发刷新：运行中 → 合并返回当前任务；手动且距上次开始 <30s → 复用最近任务
  // （force=true 跳过 30s 去重，用于新增资产后立即拉行情；运行中仍合并）。
  function requestRefresh(trigger = 'manual', force = false) {
    if (running) return { status: 202, merged: true, job: jobRowToJson(runningRow()) };
    const last = lastJob();
    if (!force && trigger === 'manual' && last
      && Date.now() - Date.parse(last.started_at) < MANUAL_DEDUPE_MS) {
      return { status: 200, merged: true, job: last };
    }
    const id = `rj-${randomUUID()}`;
    const startedAt = new Date().toISOString();
    db.prepare(
      'INSERT INTO watchlist_refresh_jobs (id, trigger_source, started_at, status) VALUES (?, ?, ?, ?)'
    ).run(id, trigger, startedAt, 'running');
    running = id;
    runningRowCache = null;
    // 异步执行，不阻塞响应
    runJob(id, trigger).catch(err => {
      console.error('[refresh] job failed unexpectedly:', err);
    });
    const job = { id, trigger, status: 'running', started_at: startedAt, finished_at: null, ok_count: 0, failed_count: 0 };
    return { status: 202, merged: false, job };
  }

  async function runJob(jobId, trigger = 'scheduled') {
    const assets = listAssets(db);
    // 手动刷新是「用户在前台等」，用更高的并发尽快跑完；定时任务按原保守值，
    // 免得在用户不注意的时候长时间占满上游配额。
    const limit = trigger === 'manual' ? manualConcurrency : concurrency;
    // 全部行标记 refreshing（保留旧值）；无快照的资产插入占位行
    withTransaction(db, () => {
      const mark = db.prepare(`
        UPDATE watchlist_quotes SET status = 'refreshing', error_message = NULL, updated_at = ? WHERE asset_id = ?
      `);
      const ins = db.prepare(`
        INSERT OR IGNORE INTO watchlist_quotes (asset_id, status, updated_at) VALUES (?, 'refreshing', ?)
      `);
      for (const a of assets) {
        mark.run(new Date().toISOString(), a.id);
        ins.run(a.id, new Date().toISOString());
      }
    });

    let ok = 0;
    let failed = 0;
    const details = {};
    const queue = assets.slice();
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length || 1)) }, async () => {
      while (queue.length) {
        const asset = queue.shift();
        if (!asset) break;
        try {
          const q = await adapters.fetchWatchlistQuote(asset.category, asset.normalized_symbol);
          writeQuoteSuccess(asset, q);
          ok += 1;
        } catch (err) {
          writeQuoteFailure(asset, err?.message || String(err));
          failed += 1;
          details[asset.symbol] = err?.message || String(err);
        }
      }
    });
    await Promise.all(workers);

    const status = failed === 0 ? 'ok' : (ok === 0 ? 'failed' : 'partial');
    const finishedAt = new Date().toISOString();
    db.prepare(`
      UPDATE watchlist_refresh_jobs
      SET finished_at = ?, status = ?, ok_count = ?, failed_count = ?, detail_json = ?
      WHERE id = ?
    `).run(finishedAt, status, ok, failed, JSON.stringify(details), jobId);
    running = null;
    runningRowCache = null;
  }

  function writeQuoteSuccess(asset, q) {
    const now = new Date().toISOString();
    // partial = 价格成功但市值补充失败（us/hk/crypto 期望有市值；指数类不适用）
    const expectsCap = ['us', 'hk', 'crypto'].includes(asset.category);
    const status = expectsCap && q.market_cap == null ? 'partial' : 'ok';
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO watchlist_quotes
          (asset_id, price, price_currency, chg_pct, week_pct, month_pct,
           market_cap, market_cap_currency, source_name, status, error_message, updated_at, last_success_at,
           pre_price, pre_chg_pct, pre_session)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
        ON CONFLICT(asset_id) DO UPDATE SET
          price = excluded.price,
          price_currency = excluded.price_currency,
          chg_pct = excluded.chg_pct,
          week_pct = excluded.week_pct,
          month_pct = excluded.month_pct,
          market_cap = excluded.market_cap,
          market_cap_currency = excluded.market_cap_currency,
          source_name = excluded.source_name,
          status = excluded.status,
          error_message = NULL,
          updated_at = excluded.updated_at,
          last_success_at = excluded.last_success_at,
          pre_price = excluded.pre_price,
          pre_chg_pct = excluded.pre_chg_pct,
          pre_session = excluded.pre_session
      `).run(
        asset.id, q.price ?? null, q.price_currency ?? null,
        q.chg_pct ?? null, q.week_pct ?? null, q.month_pct ?? null,
        q.market_cap ?? null, q.market_cap_currency ?? null,
        q.source_name ?? null, status, now, now,
        q.pre_price ?? null, q.pre_chg_pct ?? null, q.pre_session ?? null
      );
    });
  }

  function writeQuoteFailure(asset, message) {
    const now = new Date().toISOString();
    withTransaction(db, () => {
      // 保留上次成功值：只更新状态、错误与写入时间；无历史快照则占位 unavailable
      const exists = db.prepare('SELECT 1 FROM watchlist_quotes WHERE asset_id = ?').get(asset.id);
      if (exists) {
        db.prepare(`
          UPDATE watchlist_quotes SET status = 'unavailable', error_message = ?, updated_at = ?
          WHERE asset_id = ?
        `).run(message, now, asset.id);
      } else {
        db.prepare(`
          INSERT INTO watchlist_quotes (asset_id, status, error_message, updated_at)
          VALUES (?, 'unavailable', ?, ?)
        `).run(asset.id, message, now);
      }
    });
  }

  function start() {
    stop();
    timer = setInterval(() => {
      const info = getInfo();
      if (!info.running && Date.now() >= Date.parse(info.next_at)) {
        requestRefresh('scheduled');
      }
    }, Math.min(15 * 1000, intervalMs));
    timer.unref?.();
    // 启动即返回库内快照；若从无快照或已陈旧，尽快补一次
    const staleBefore = Date.now() - intervalMs;
    const last = lastJob();
    const hasFresh = last && last.finished_at && Date.parse(last.finished_at) > staleBefore;
    if (!hasFresh) {
      const t = setTimeout(() => requestRefresh('scheduled'), 3000);
      t.unref?.();
    }
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { requestRefresh, getInfo, start, stop, _runJob: runJob, _concurrency: { concurrency, manualConcurrency } };
}
