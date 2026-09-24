// K 线 API + 缓存服务集成测试：真实 HTTP 服务 + 临时 SQLite + 可编程 mock 上游。
// 覆盖：鉴权、参数白名单、资产不存在、migration v3、按需缓存命中、过期刷新、
// 上游失败保留旧缓存并标 stale、空结果不落库、外键级联删除、/quotes 不回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.INVEST_API_TOKEN = 'test-token';
process.env.INVEST_AUTH_USER = 'tester@example.com';
process.env.INVEST_AUTH_PASS = 'test-pass';

const { createServer } = await import('../server/index.js');
const { openDb, schemaVersion, LATEST_SCHEMA_VERSION } = await import('../server/db.js');
// 断言「升到最新版本」而不是写死数字：将来加 migration 时这些用例不该无辜变红
const LATEST_SCHEMA = LATEST_SCHEMA_VERSION();
const { createAsset } = await import('../server/assets.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'invest-candles-'));
}

// 可编程 mock：按 (category, symbol, interval) 决定返回或抛错，并统计调用次数
function fakeCandleAdapters() {
  const calls = [];
  const fail = new Set();
  const empty = new Set();
  const override = new Map();

  function series(interval, n = 5) {
    const step = { '1d': 86400000, '1w': 7 * 86400000, '1M': 31 * 86400000 }[interval] || 86400000;
    // 生成“贴着现在”的序列：最后一根就是当前未收盘桶。
    // 这样把 fetched_at 推旧后，新鲜度判定会认为当前 candle 未收盘且抓取已过期
    // → 会重新打上游，而 upsert 会按同一个 open_time_ms 覆盖，不会凭空多出行。
    const last = Date.now() - (Date.now() % step);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const t = last - i * step;
      out.push({
        open_time_ms: t,
        open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i,
        volume: 1000 + i,
      });
    }
    return out;
  }

  // 把最后一根推到“现在”（未收盘）并把 fetched_at 推旧，强制过期
  function expireCache(db, assetId, interval = '1d', ageMs = 6 * 60 * 60 * 1000) {
    db.prepare("UPDATE candle_cache SET fetched_at = ? WHERE owner='watch' AND owner_key = ? AND interval = ?")
      .run(new Date(Date.now() - ageMs).toISOString(), assetId, interval);
  }

  return {
    calls, fail, empty, override, expireCache,
    async fetchCandles(category, symbol, { interval }) {
      const key = `${category}:${symbol}:${interval}`;
      calls.push(key);
      if (fail.has(key) || fail.has(`${category}:${symbol}`)) {
        throw new Error('上游暂时不可用（模拟）');
      }
      if (empty.has(`${category}:${symbol}`)) {
        return { candles: [], currency: 'USD', source_name: 'yahoo' };
      }
      const o = override.get(key);
      return o || {
        candles: series(interval),
        currency: category === 'crypto' ? 'USDT' : 'USD',
        source_name: category === 'crypto' ? 'binance' : 'yahoo',
      };
    },
  };
}

function makeEnv() {
  const dir = tmpDir();
  const candleAdapters = fakeCandleAdapters();
  const { server, db, candleService } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    candleAdapters,
    // 行情刷新不参与本测试；给个不触网的适配器
    adapters: { async fetchWatchlistQuote() { throw new Error('not used'); } },
    intervalMs: 60 * 60 * 1000,
  });
  trackDrain(candleService);
  return { dir, server, db, candleAdapters, close: () => closeEnv(server, db) };
}

// 必须同时关服务与数据库：SQLite 句柄不关，node:test 进程不会退出。
// 另外要等后台重拉（SWR）落地 —— 未决的 promise 同样会让进程挂着。
function closeEnv(server, db) {
  try { server.close(); } catch { /* ignore */ }
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  const drain = globalThis.__candleDrain;
  if (drain) {
    try { drain(); } catch { /* ignore */ }
  }
  try { db.close(); } catch { /* ignore */ }
}

// createServer 返回 candleService，把它挂到全局供 closeEnv 收尾（仅测试用）
function trackDrain(svc) {
  globalThis.__candleDrain = () => svc?.drainBackground?.();
}

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function req(base, p, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(base + p, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json };
}

const SVC = 'test-token';

test('migration：schema 升到最新，candle_cache 存在且带索引', () => {
  const env = makeEnv(); const { db } = env;
  assert.equal(schemaVersion(db), LATEST_SCHEMA);
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='candle_cache'").get();
  assert.ok(t, 'candle_cache 表应存在（v7 起取代 watchlist_candles）');
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_candle_cache_lookup'").get();
  assert.ok(idx, '查询索引应存在');
  const cols = db.prepare('PRAGMA table_info(candle_cache)').all().map(c => c.name);
  // v7 起用 owner/owner_key 区分「自选」与「持仓」两个键空间
  for (const c of ['owner', 'owner_key', 'interval', 'open_time_ms', 'open', 'high', 'low',
                   'close', 'volume', 'source_name', 'fetched_at', 'range', 'watch_asset_id']) {
    assert.ok(cols.includes(c), `缺列 ${c}`);
  }
  env.close();
});

test('旧库升级到最新 schema：已有资产保留，K 线表可用', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'invest.sqlite');
  // 先建一个「v2 时代」的库：手工建到 v2 再让 openDb 补 v3
  const first = openDb(p);
  const { asset } = createAsset(first, { category: 'us', symbol: 'AAPL', name: 'Apple' });
  assert.equal(schemaVersion(first), LATEST_SCHEMA);

  // 模拟 v2 时代的老库：把 v3+ 的痕迹都撤掉，回退到 v2 形态。
  // 注意 v5 是 ALTER TABLE 加列，只删 migration 记录不够 —— 必须把列也去掉，
  // 否则重放 v5 会报 "duplicate column name"。v6 建的表同理要先 DROP。
  first.exec('DROP TABLE candle_cache');
  for (const col of ['pre_price', 'pre_chg_pct', 'pre_session']) {
    first.exec(`ALTER TABLE watchlist_quotes DROP COLUMN ${col}`);
  }
  first.exec('DROP TABLE portfolio_refresh_jobs');
  first.exec('DROP TABLE portfolio_quotes');
  first.exec('DROP TABLE portfolio_holdings');
  first.exec('DROP TABLE portfolio_preferences');
  first.exec('DROP TABLE portfolio_asset_types');
  first.exec('DROP TABLE portfolio_channels');
  first.exec('DROP TABLE portfolio_meta');
  // v8 建的标签三表同理：不回退就会在重放 v8 时报 "table watchlist_tags already exists"。
  // 先删次序表（引用标签与资产），再删关系表，最后删标签表。
  first.exec('DROP TABLE watchlist_tag_order');
  first.exec('DROP TABLE watchlist_asset_tags');
  first.exec('DROP TABLE watchlist_tags');
  first.prepare('DELETE FROM schema_migrations WHERE version >= 3').run();
  assert.equal(schemaVersion(first), 2);
  first.close();

  // 重新打开：应自动补上 v3..v6，且资产数据完好
  const again = openDb(p);
  assert.equal(schemaVersion(again), LATEST_SCHEMA);
  const kept = again.prepare('SELECT * FROM watchlist_assets WHERE id = ?').get(asset.id);
  assert.ok(kept, '升级后原资产应保留');
  assert.equal(kept.symbol, 'AAPL');
  assert.equal(again.prepare('SELECT COUNT(*) n FROM candle_cache').get().n, 0);
  // v6 的表也应补上，且 portfolio 配置版本从 0 开始
  assert.equal(again.prepare("SELECT value v FROM portfolio_meta WHERE key='config_version'").get().v, '0');
});

test('鉴权：无凭据 401；服务令牌可读', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });

  const noAuth = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d`);
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.json.error.code, 'UNAUTHORIZED');

  const ok = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d`, { token: SVC });
  assert.equal(ok.status, 200);
  env.close();
});

test('参数校验：非法 interval / 不匹配 range 均 400', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });

  const a = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=5m`, { token: SVC });
  assert.equal(a.status, 400);
  assert.equal(a.json.error.code, 'VALIDATION_ERROR');

  const b = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=10y`, { token: SVC });
  assert.equal(b.status, 400);
  assert.equal(b.json.error.code, 'VALIDATION_ERROR');

  const c = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1w&range=6mo`, { token: SVC });
  assert.equal(c.status, 400);
  env.close();
});

test('资产不存在 → 404 NOT_FOUND', async () => {
  const env = makeEnv(); const { server } = env;
  const base = await listen(server);
  const r = await req(base, '/api/v1/watchlist/assets/nope-123/candles?interval=1d', { token: SVC });
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, 'NOT_FOUND');
  env.close();
});

test('成功响应形状：candles 为 [t,o,h,l,c,v]，含 source/interval/range/stale', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });

  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.status, 200);
  const d = r.json;
  assert.equal(d.ok, true);
  assert.equal(d.asset_id, asset.id);
  assert.equal(d.interval, '1d');
  assert.equal(d.range, '6mo');
  assert.equal(d.source_name, 'yahoo');
  assert.equal(d.currency, 'USD');
  assert.equal(d.stale, false);
  assert.ok(typeof d.updated_at === 'string');
  assert.equal(d.candles.length, 5);
  for (const c of d.candles) {
    assert.equal(c.length, 6, '每根固定 6 个字段');
    assert.ok(Number.isInteger(c[0]), '时间戳为整数毫秒');
    for (let i = 1; i <= 4; i++) assert.ok(Number.isFinite(c[i]), 'OHLC 为数字');
  }
  // OHLC 不变量
  for (const [, o, h, l, cl] of d.candles) {
    assert.ok(h >= o && h >= cl && h >= l, 'high 应为最大');
    assert.ok(l <= o && l <= cl && l <= h, 'low 应为最小');
  }
  env.close();
});

test('缓存命中：第二次请求不再打上游，updated_at 不变', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`;

  const r1 = await req(base, url, { token: SVC });
  const afterFirst = candleAdapters.calls.length;
  const r2 = await req(base, url, { token: SVC });

  assert.equal(candleAdapters.calls.length, afterFirst, '第二次不应再调上游');
  assert.equal(r2.json.updated_at, r1.json.updated_at, 'updated_at 应保持不变');
  assert.deepEqual(r2.json.candles, r1.json.candles);
  env.close();
});

test('过期刷新：未收盘 candle 且 fetched_at 超 TTL → 重新拉上游并 upsert', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`;

  await req(base, url, { token: SVC });
  const countAfterFirst = candleAdapters.calls.length;

  candleAdapters.expireCache(db, asset.id);

  const r = await req(base, url, { token: SVC });
  assert.equal(r.status, 200);
  assert.ok(candleAdapters.calls.length > countAfterFirst, '过期后应重新拉上游');
  assert.equal(r.json.stale, false);
  // upsert 不产生重复行（同 (asset,interval,open_time) 覆盖）
  const rows = db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch' AND owner_key=? AND interval='1d'").get(asset.id).n;
  assert.equal(rows, 5, 'upsert 后仍是 5 根，不应重复插入');
  env.close();
});

test('缓存过期 + 有数据 → 立刻返回缓存并标 refreshing（stale-while-revalidate）', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`;

  const first = await req(base, url, { token: SVC });
  const original = first.json.candles;
  candleAdapters.expireCache(db, asset.id);

  const r = await req(base, url, { token: SVC });
  assert.equal(r.status, 200);
  assert.equal(r.json.refreshing, true, '应告知调用方后台正在重拉');
  assert.equal(r.json.stale, false, '数据没有失败，只是正在更新');
  assert.deepEqual(r.json.candles, original, '立刻拿到旧缓存，不干等上游');
  // 后台重拉应已排上（不阻塞响应）
  await new Promise(res => setTimeout(res, 50));
  assert.ok(candleAdapters.calls.some(c => c === 'us:AAPL:1d'), '后台应发起重拉');
  env.close();
});

test('上游失败 + 无缓存 → 502（不会拿空数据冒充成功）', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  candleAdapters.fail.add('us:AAPL');
  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'UPSTREAM_FAILED');
  env.close();
});

test('上游失败 + 无缓存 → 502，不返回空图假成功', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  candleAdapters.fail.add('us:AAPL');

  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.status, 502);
  assert.equal(r.json.error.code, 'UPSTREAM_FAILED');
  assert.equal(r.json.candles, undefined, '不应带 candles 字段');
  env.close();
});

test('上游返回空数组 → 不落库，下次仍会重试', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  candleAdapters.empty.add('us:AAPL');

  const r1 = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r1.status, 502, '空数据视为失败');
  const n = db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch' AND owner_key=?").get(asset.id).n;
  assert.equal(n, 0, '空结果不应落库');

  // 恢复后应能正常拉到
  candleAdapters.empty.delete('us:AAPL');
  const r2 = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.candles.length, 5);
  env.close();
});

test('不同周期各自独立缓存（1d 与 1w 互不影响）', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });

  const d = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  const w = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1w&range=3y`, { token: SVC });
  assert.equal(d.json.interval, '1d');
  assert.equal(w.json.interval, '1w');
  // 两者时间步长不同 → 时间戳集合不同
  assert.notDeepEqual(d.json.candles.map(c => c[0]), w.json.candles.map(c => c[0]));
  assert.ok(candleAdapters.calls.includes('us:AAPL:1d'));
  assert.ok(candleAdapters.calls.includes('us:AAPL:1w'));
  env.close();
});

test('默认 range：不传 range 时按 interval 取默认值', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1w`, { token: SVC });
  assert.equal(r.status, 200);
  assert.equal(r.json.range, '3y');
  env.close();
});

test('外键级联：删除资产后其 K 线随之清空', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.ok(db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch' AND owner_key=?").get(asset.id).n > 0);

  const del = await req(base, `/api/v1/watchlist/assets/${asset.id}`, { method: 'DELETE', token: SVC });
  assert.equal(del.status, 200);
  assert.equal(
    db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch' AND owner_key=?").get(asset.id).n, 0,
    '删资产应级联清掉 K 线'
  );
  env.close();
});

test('crypto 走 Binance，返回 USDT 且 volume 有值', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'crypto', symbol: 'BTC' });
  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.json.source_name, 'binance');
  assert.equal(r.json.currency, 'USDT');
  assert.ok(r.json.candles.every(c => c[5] !== null));
  env.close();
});

test('并发去重：同一资产同一周期同时打两次，上游只被调一次', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`;
  const [a, b] = await Promise.all([
    req(base, url, { token: SVC }),
    req(base, url, { token: SVC }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(candleAdapters.calls.length, 1, '并发应合并为一次上游调用');
  env.close();
});

test('不回归：/quotes 响应形状不变', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  createAsset(db, { category: 'us', symbol: 'AAPL' });
  const r = await req(base, '/api/v1/watchlist/quotes', { token: SVC });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(Array.isArray(r.json.quotes));
  assert.ok('version' in r.json);
  assert.ok('refresh' in r.json);
  assert.ok(!('candles' in r.json), '/quotes 不应混入 K 线字段');
  env.close();
});

test('limited_history：CoinGecko 回退源在响应里如实标注 + note', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'crypto', symbol: 'HYPE' });
  candleAdapters.override.set('crypto:HYPE:1d', {
    candles: [{ open_time_ms: 1725148800000, open: 76.9, high: 94.5, low: 76.6, close: 92.1, volume: null }],
    currency: 'USD',
    source_name: 'coingecko',
    limited_history: true,
  });

  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.status, 200, '历史深度不足不应报错');
  assert.equal(r.json.limited_history, true);
  assert.ok(typeof r.json.note === 'string' && r.json.note.length > 0, '应带可读提示');
  assert.equal(r.json.candles.length, 1);
  assert.equal(r.json.candles[0][5], null, 'CoinGecko 无成交量 → null');
  env.close();
});

test('limited_history：命中缓存时仍标注（换进程后也能提示）', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'crypto', symbol: 'HYPE' });
  candleAdapters.override.set('crypto:HYPE:1d', {
    candles: [{ open_time_ms: 1725148800000, open: 1, high: 2, low: 0.5, close: 1.5, volume: null }],
    currency: 'USD', source_name: 'coingecko', limited_history: true,
  });
  await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  // 第二次走缓存，仍应保留 limited_history
  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.json.limited_history, true);
  assert.ok(r.json.note);
  env.close();
});

test('limited_history：Yahoo/Binance 源为 false，且无 note', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const r = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(r.json.limited_history, false);
  assert.equal(r.json.note, undefined);
  env.close();
});

test('档位升级：请求更深的 range 时不能拿浅档缓存当命中', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  // 让上游按 range 返回不同根数，模拟真实（6mo 短、1y 长）
  candleAdapters.override.clear();
  const orig = candleAdapters.fetchCandles;
  candleAdapters.fetchCandles = async (cat, sym, { interval, range }) => {
    candleAdapters.calls.push(`${cat}:${sym}:${interval}:${range}`);
    const n = range === '6mo' ? 5 : 12;
    const step = 86400000;
    const last = Date.now() - (Date.now() % step);
    const candles = [];
    for (let i = n - 1; i >= 0; i--) {
      candles.push({ open_time_ms: last - i * step, open: 100 + i, high: 105 + i, low: 95 + i, close: 102 + i, volume: 10 });
    }
    return { candles, currency: 'USD', source_name: 'yahoo' };
  };

  // 先拉浅档
  const a = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(a.status, 200);
  assert.equal(a.json.candles.length, 5);
  assert.equal(a.json.range, '6mo');

  // 再拉深档：必须重新打上游并返回更多根，而不是复用 5 根
  const b = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=1y`, { token: SVC });
  assert.equal(b.status, 200);
  assert.equal(b.json.range, '1y');
  assert.ok(b.json.candles.length > 5, `深档应拿到更多根，实际 ${b.json.candles.length}`);
  assert.ok(candleAdapters.calls.some(c => c.endsWith(':1y')), '应真的请求过 1y');

  // 反过来：已有深档数据时请求浅档，应直接命中缓存（不必回退重拉）
  const before = candleAdapters.calls.length;
  const c = await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { token: SVC });
  assert.equal(c.status, 200);
  assert.equal(candleAdapters.calls.length, before, '浅档请求不应再打上游');
  assert.ok(c.json.candles.length >= 12, '浅档请求也应看到已缓存的全部数据');

  candleAdapters.fetchCandles = orig;
  env.close();
});

test('range 列：写入时落库，重启后仍能判断档位深度', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  await req(base, `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=1y`, { token: SVC });
  const rows = db.prepare("SELECT DISTINCT range FROM candle_cache WHERE owner='watch' AND owner_key=?").all(asset.id);
  assert.deepEqual(rows.map(r => r.range), ['1y'], 'range 必须落库');
  env.close();
});

// ── 代码模糊搜索端点 ──

function fakeSearch(results = [], fail = false) {
  const calls = [];
  return {
    calls, results, fail,
    async search(q, { limit = 8 } = {}) {
      calls.push(q);
      if (fail) throw new Error('搜索上游挂了（模拟）');
      return results.slice(0, limit);
    },
  };
}

function makeSearchEnv(searchAdapter) {
  const dir = tmpDir();
  const { server, db } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    searchAdapter,
    candleAdapters: fakeCandleAdapters(),
    adapters: { async fetchWatchlistQuote() { throw new Error('not used'); } },
    intervalMs: 60 * 60 * 1000,
  });
  return { dir, server, db, searchAdapter, close: () => closeEnv(server, db) };
}

test('搜索端点：需鉴权（无凭据 401）', async () => {
  const env = makeSearchEnv(fakeSearch([]));
  const base = await listen(env.server);
  const r = await req(base, '/api/v1/watchlist/search?q=apple');
  assert.equal(r.status, 401);
  env.close();
});

test('搜索端点：返回裁剪后的字段（symbol/input_symbol/name/category/exchange）', async () => {
  const env = makeSearchEnv(fakeSearch([
    { symbol: '002594', name: '比亚迪', category: 'a_share', exchange: '深A', normalized_symbol: '002594.SZ' },
    { symbol: '00700', name: '腾讯控股', category: 'hk', exchange: '港股', normalized_symbol: '0700.HK' },
  ]));
  const base = await listen(env.server);
  const r = await req(base, '/api/v1/watchlist/search?q=BYD', { token: SVC });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.results.length, 2);
  const first = r.json.results[0];
  assert.deepEqual(Object.keys(first).sort(), ['category', 'exchange', 'input_symbol', 'name', 'symbol']);
  assert.equal(first.symbol, '002594');
  assert.equal(first.input_symbol, '002594');   // A股原样
  // 不得把上游的 normalized_symbol 等内部字段透给浏览器
  assert.equal(first.normalized_symbol, undefined);
  // 港股回填时去前导零
  assert.equal(r.json.results[1].input_symbol, '700');
  env.close();
});

test('搜索端点：空 q 返回空结果且不打上游', async () => {
  const adapter = fakeSearch([{ symbol: 'AAPL', name: '苹果', category: 'us', exchange: '美股' }]);
  const env = makeSearchEnv(adapter);
  const base = await listen(env.server);
  const r = await req(base, '/api/v1/watchlist/search?q=', { token: SVC });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results, []);
  assert.equal(adapter.calls.length, 0);
  env.close();
});

test('搜索端点：上游失败降级为空结果 + degraded，不影响新增流程', async () => {
  const env = makeSearchEnv(fakeSearch([], true));
  const base = await listen(env.server);
  const r = await req(base, '/api/v1/watchlist/search?q=apple', { token: SVC });
  assert.equal(r.status, 200, '搜索是辅助功能，上游挂了也不该报错');
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.results, []);
  assert.equal(r.json.degraded, true);
  env.close();
});

test('不回归：新增资产仍可手输代码（不依赖搜索）', async () => {
  const env = makeEnv(); const { server, db } = env;
  const base = await listen(server);
  const r = await req(base, '/api/v1/watchlist/assets', {
    method: 'POST', token: SVC,
    body: { category: 'us', symbol: 'AAPL', name: '苹果', verify: false },
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.asset.normalized_symbol, 'AAPL');
  env.close();
});

// ── 并发策略：手动刷新比定时刷新更激进 ──

test('并发策略：手动刷新用 manualConcurrency，定时刷新用 concurrency', async () => {
  const dir = tmpDir();
  const order = [];
  // 适配器记录同时在飞的数量
  let inflight = 0, peak = 0;
  const adapters = {
    async fetchWatchlistQuote(category, symbol) {
      inflight += 1; peak = Math.max(peak, inflight);
      order.push(symbol);
      await new Promise(r => setTimeout(r, 30));
      inflight -= 1;
      return {
        price: 1, price_currency: 'USD', chg_pct: 0, week_pct: 0, month_pct: 0,
        market_cap: null, market_cap_currency: null, source_name: 'test', name: symbol,
      };
    },
  };
  const { db, refreshService } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    adapters,
    candleAdapters: fakeCandleAdapters(),
    intervalMs: 60 * 60 * 1000,
    concurrency: 2,
    manualConcurrency: 6,
  });
  // 造 12 个资产，足够看出并发差异（美股代码需满足服务端校验：1-6 位大写字母/点）
  const syms = ['AA','AB','AC','AD','AE','AF','AG','AH','AI','AJ','AK','AL'];
  for (const sym of syms) createAsset(db, { category: 'us', symbol: sym });

  // 定时：并发上限 2
  peak = 0; inflight = 0;
  await refreshService._runJob('job-scheduled', 'scheduled');
  assert.ok(peak <= 2, `定时刷新并发应 <=2，实际峰值 ${peak}`);

  // 手动：并发上限 6
  peak = 0; inflight = 0;
  await refreshService._runJob('job-manual', 'manual');
  assert.ok(peak > 2, `手动刷新并发应高于定时，实际峰值 ${peak}`);
  assert.ok(peak <= 6, `手动刷新并发不应超过 6，实际峰值 ${peak}`);

  assert.deepEqual(refreshService._concurrency, { concurrency: 2, manualConcurrency: 6 });
  db.close();
});

test('并发策略：默认值是 定时 4 / 手动 6（代理并发上限所致）', async () => {
  const dir = tmpDir();
  const { db, refreshService } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    adapters: { async fetchWatchlistQuote() { throw new Error('n/a'); } },
    candleAdapters: fakeCandleAdapters(),
    intervalMs: 60 * 60 * 1000,
  });
  assert.deepEqual(refreshService._concurrency, { concurrency: 4, manualConcurrency: 6 });
  db.close();
});

// ── TTL：日 10 分钟 / 周 4 小时 / 月 24 小时 ──

test('TTL：周线 4 小时内视为新鲜（不重拉），超过才重拉', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1w&range=3y`;

  await req(base, url, { token: SVC });
  const n1 = candleAdapters.calls.length;

  // 3 小时前抓的：仍在 4 小时 TTL 内 -> 命中缓存，不再打上游
  db.prepare("UPDATE candle_cache SET fetched_at=? WHERE owner='watch' AND owner_key=? AND interval='1w'")
    .run(new Date(Date.now() - 3 * 3600 * 1000).toISOString(), asset.id);
  const r1 = await req(base, url, { token: SVC });
  assert.equal(r1.json.refreshing, false, '3 小时前应仍算新鲜');
  assert.equal(candleAdapters.calls.length, n1, '不应重拉');

  // 5 小时前抓的：超出 4 小时 -> SWR 立刻返回并后台重拉
  db.prepare("UPDATE candle_cache SET fetched_at=? WHERE owner='watch' AND owner_key=? AND interval='1w'")
    .run(new Date(Date.now() - 5 * 3600 * 1000).toISOString(), asset.id);
  const r2 = await req(base, url, { token: SVC });
  assert.equal(r2.json.refreshing, true, '超过 4 小时应触发后台重拉');
  await new Promise(res => setTimeout(res, 50));
  assert.ok(candleAdapters.calls.length > n1, '应已发起重拉');
  env.close();
});

test('TTL：月线 24 小时内新鲜、超过才重拉', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1M&range=10y`;

  await req(base, url, { token: SVC });
  const n1 = candleAdapters.calls.length;

  db.prepare("UPDATE candle_cache SET fetched_at=? WHERE owner='watch' AND owner_key=? AND interval='1M'")
    .run(new Date(Date.now() - 20 * 3600 * 1000).toISOString(), asset.id);
  const r1 = await req(base, url, { token: SVC });
  assert.equal(r1.json.refreshing, false, '20 小时前应仍算新鲜');
  assert.equal(candleAdapters.calls.length, n1, '不应重拉');

  db.prepare("UPDATE candle_cache SET fetched_at=? WHERE owner='watch' AND owner_key=? AND interval='1M'")
    .run(new Date(Date.now() - 30 * 3600 * 1000).toISOString(), asset.id);
  const r2 = await req(base, url, { token: SVC });
  assert.equal(r2.json.refreshing, true, '超过 24 小时应触发后台重拉');
  env.close();
});

test('TTL：日线仍是 10 分钟（未被周/月的放宽带跑）', async () => {
  const env = makeEnv(); const { server, db, candleAdapters } = env;
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  const url = `/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`;

  await req(base, url, { token: SVC });
  const n1 = candleAdapters.calls.length;

  // 30 分钟前：超出日线 10 分钟 TTL -> 应重拉
  db.prepare("UPDATE candle_cache SET fetched_at=? WHERE owner='watch' AND owner_key=? AND interval='1d'")
    .run(new Date(Date.now() - 30 * 60 * 1000).toISOString(), asset.id);
  const r = await req(base, url, { token: SVC });
  assert.equal(r.json.refreshing, true, '日线超过 10 分钟应重拉');
  env.close();
});

// ── 盘前/盘后字段贯穿 API ──

test('盘前/盘后：/quotes 透出 pre_price / pre_chg_pct / pre_session', async () => {
  const dir = tmpDir();
  const adapters = {
    async fetchWatchlistQuote(category, symbol) {
      const base = {
        price: 222.27, price_currency: 'USD', chg_pct: 1.34, week_pct: 2, month_pct: 3,
        market_cap: 1e12, market_cap_currency: 'USD', source_name: 'yahoo', name: symbol,
      };
      // 只有美股给扩展时段数据
      if (category === 'us') return { ...base, pre_price: 224.24, pre_chg_pct: 0.886, pre_session: 'pre' };
      return base;
    },
  };
  const { server, db, refreshService } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    adapters,
    candleAdapters: fakeCandleAdapters(),
    intervalMs: 60 * 60 * 1000,
  });
  const base = await listen(server);
  createAsset(db, { category: 'us', symbol: 'NVDA' });
  createAsset(db, { category: 'hk', symbol: '0700' });
  await refreshService._runJob('job-pre', 'manual');

  const r = await req(base, '/api/v1/watchlist/quotes', { token: SVC });
  const us = r.json.quotes.find(q => q.pre_session === 'pre');
  const hk = r.json.quotes.find(q => q.pre_session == null);
  assert.ok(us, '美股应有 pre_session');
  assert.equal(us.pre_price, 224.24);
  assert.ok(Math.abs(us.pre_chg_pct - 0.886) < 1e-6);
  assert.ok(hk, '港股应无扩展时段数据');
  assert.equal(hk.pre_price, null);
  assert.equal(hk.pre_chg_pct, null);
  closeEnv(server, db);
});

test('盘前/盘后：上游不提供时落库为 NULL，不是 0', async () => {
  const dir = tmpDir();
  // 适配器不给扩展时段字段，模拟上游没有该数据
  const adapters = {
    async fetchWatchlistQuote() {
      return {
        price: 100, price_currency: 'USD', chg_pct: 1, week_pct: 1, month_pct: 1,
        market_cap: 1e9, market_cap_currency: 'USD', source_name: 'yahoo', name: 'Test',
      };
    },
  };
  const { server, db, refreshService } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    adapters,
    candleAdapters: fakeCandleAdapters(),
    intervalMs: 60 * 60 * 1000,
  });
  const base = await listen(server);
  const { asset } = createAsset(db, { category: 'us', symbol: 'AAPL' });
  await refreshService._runJob('job-nopre', 'manual');   // 必须先写入快照行

  const row = db.prepare('SELECT pre_price, pre_chg_pct, pre_session FROM watchlist_quotes WHERE asset_id=?').get(asset.id);
  assert.ok(row, '刷新后应有快照行');
  assert.equal(row.pre_price, null, '缺失应为 NULL 而不是 0');
  assert.equal(row.pre_chg_pct, null);
  assert.equal(row.pre_session, null);
  closeEnv(server, db);
});
