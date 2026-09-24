// 持仓与投资估值：单元 + 集成测试。
//
// 覆盖交接文档「必须验收」第 2 条要求的全部项目：
//   migration、校验、报价去重、缓存/强刷、FX、估值、空/部分失败、
//   全量配置事务、版本冲突、外键级联。
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
const cfgMod = await import('../server/portfolio/config.js');
const { buildValuation, weightedChange, groupByType, groupByChannel, valueHolding } =
  await import('../server/portfolio/valuation.js');
const { toBaseCurrency, createFxService } = await import('../server/portfolio/fx.js');
const { createPortfolioQuoteService } = await import('../server/portfolio/quote-service.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'invest-portfolio-')); }
function freshDb() { return openDb(path.join(tmpDir(), 'invest.sqlite')); }

function baseConfig(over = {}) {
  return {
    channels: [
      { id: 'tiger', name: '老虎证券', color: '#b97d10' },
      { id: 'binance', name: '币安交易所', color: '#1746c7' },
    ],
    asset_types: [
      { id: 'stock', name: '美股资产', color: '#1746c7' },
      { id: 'crypto', name: '加密货币', color: '#b97d10' },
    ],
    holdings: [
      { id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'BMNR', quote_category: 'us', quantity: 2850 },
      { id: 'h2', channel_id: 'binance', asset_type_id: 'crypto', symbol: 'BTC', quote_category: 'crypto', quantity: 1.578 },
    ],
    display_currency: 'USD',
    usd_cny_rate: 6.8,
    ...over,
  };
}

// ── migration ───────────────────────────────────────────────────────────
test('migration v6：建出 portfolio_* 表，config_version 从 0 起', () => {
  const db = freshDb();
  assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION());
  for (const t of ['portfolio_channels', 'portfolio_asset_types', 'portfolio_holdings',
    'portfolio_preferences', 'portfolio_quotes', 'portfolio_meta', 'portfolio_refresh_jobs']) {
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t), `缺表 ${t}`);
  }
  assert.equal(cfgMod.getVersion(db), 0);
  db.close();
});

test('migration v6：重放不报错（幂等），且不动 watchlist 数据', () => {
  const p = path.join(tmpDir(), 'invest.sqlite');
  const a = openDb(p);
  cfgMod.replaceConfig(a, baseConfig());
  const v = cfgMod.getVersion(a);
  a.close();
  const b = openDb(p);   // 再次打开 = 重放 migrations
  assert.equal(schemaVersion(b), LATEST_SCHEMA_VERSION());
  assert.equal(cfgMod.getVersion(b), v, '重放不该重置配置版本');
  assert.equal(cfgMod.listHoldings(b).length, 2);
  b.close();
});

test('migration v6：持仓表带 quote_category 校验与外键', () => {
  const db = freshDb();
  // 非法 quote_category 直接被 CHECK 拒绝
  assert.throws(() => db.prepare(`
    INSERT INTO portfolio_holdings
      (id, channel_id, asset_type_id, symbol, quote_category, normalized_symbol, quantity, created_at, updated_at)
    VALUES ('x','none','none','BTC','bogus','BTC',1,'t','t')
  `).run());
  db.close();
});

// ── 校验 ────────────────────────────────────────────────────────────────
test('校验：至少一个资产类型', () => {
  assert.throws(() => cfgMod.validateConfig(baseConfig({ asset_types: [] })),
    /至少保留一个资产类型/);
});

test('校验：渠道 id 重复、名称重复都拒绝', () => {
  const dupId = baseConfig({
    channels: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
  });
  assert.throws(() => cfgMod.validateConfig(dupId), /渠道 ID 重复/);
  const dupName = baseConfig({
    channels: [{ id: 'a', name: '同名' }, { id: 'b', name: '同名' }],
  });
  assert.throws(() => cfgMod.validateConfig(dupName), /渠道名称重复/);
});

test('校验：数量必须是有限正数（0、负数、NaN、字符串都拒绝）', () => {
  for (const bad of [0, -1, 'abc', null, undefined, Infinity]) {
    const c = baseConfig({ holdings: [{ id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'AAPL', quote_category: 'us', quantity: bad }] });
    assert.throws(() => cfgMod.validateConfig(c), /数量必须是大于 0 的有限数/, `quantity=${bad} 应被拒绝`);
  }
});

test('校验：持仓引用不存在的渠道/类型被拒绝', () => {
  const c1 = baseConfig({ holdings: [{ id: 'h1', channel_id: 'ghost', asset_type_id: 'stock', symbol: 'AAPL', quote_category: 'us', quantity: 1 }] });
  assert.throws(() => cfgMod.validateConfig(c1), /不存在的渠道/);
  const c2 = baseConfig({ holdings: [{ id: 'h1', channel_id: 'tiger', asset_type_id: 'ghost', symbol: 'AAPL', quote_category: 'us', quantity: 1 }] });
  assert.throws(() => cfgMod.validateConfig(c2), /不存在的资产类型/);
});

test('校验：quote_category 与 symbol 必须自洽，非法分类被拒绝', () => {
  const bad = baseConfig({ holdings: [{ id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'AAPL', quote_category: 'nope', quantity: 1 }] });
  assert.throws(() => cfgMod.validateConfig(bad), /行情分类不合法/);
  // us 分类下放港股代码 → 被 normalize 的规则拒绝
  const mism = baseConfig({ holdings: [{ id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', symbol: '0700', quote_category: 'us', quantity: 1 }] });
  assert.throws(() => cfgMod.validateConfig(mism));
});

test('校验：持仓上限 100 条', () => {
  const holdings = Array.from({ length: 101 }, (_, i) => ({
    id: `h${i}`, channel_id: 'tiger', asset_type_id: 'stock',
    symbol: 'AAPL', quote_category: 'us', quantity: 1,
  }));
  assert.throws(() => cfgMod.validateConfig(baseConfig({ holdings })), /持仓最多 100 条/);
});

test('校验：normalized_symbol 复用 validateAndNormalize（港股补零、A股加后缀、加密去 USDT）', () => {
  const c = baseConfig({
    asset_types: [{ id: 't', name: 'T' }],
    channels: [{ id: 'c', name: 'C' }],
    holdings: [
      { id: 'a', channel_id: 'c', asset_type_id: 't', symbol: '0700', quote_category: 'hk', quantity: 1 },
      { id: 'b', channel_id: 'c', asset_type_id: 't', symbol: '600519', quote_category: 'a_share', quantity: 1 },
      { id: 'd', channel_id: 'c', asset_type_id: 't', symbol: 'BTCUSDT', quote_category: 'crypto', quantity: 1 },
    ],
  });
  const out = cfgMod.validateConfig(c);
  const byId = Object.fromEntries(out.holdings.map(h => [h.id, h]));
  assert.equal(byId.a.normalized_symbol, '0700.HK');
  assert.equal(byId.b.normalized_symbol, '600519.SS');
  assert.equal(byId.d.normalized_symbol, 'BTC', 'BTCUSDT 与 BTC 视为同一基础币种');
});

test('校验：非法汇率为 null（保留原值），合法汇率被保存', () => {
  const bad = cfgMod.validateConfig(baseConfig({ usd_cny_rate: -5 }));
  assert.equal(bad.usd_cny_rate, null);
  const good = cfgMod.validateConfig(baseConfig({ usd_cny_rate: 7.31 }));
  assert.equal(good.usd_cny_rate, 7.31);
});

// ── 事务与版本冲突 ──────────────────────────────────────────────────────
test('全量替换：一次写入，版本 +1', () => {
  const db = freshDb();
  const r1 = cfgMod.replaceConfig(db, baseConfig());
  assert.equal(r1.version, 1);
  assert.equal(cfgMod.listChannels(db).length, 2);
  assert.equal(cfgMod.listHoldings(db).length, 2);
  // 第二次只留 tiger + 一条持仓：binance 及其持仓应随之消失
  const r2 = cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'tiger', name: '老虎证券' }],
    holdings: [{ id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'BMNR', quote_category: 'us', quantity: 2850 }],
  }));
  assert.equal(r2.version, 2);
  assert.equal(cfgMod.listChannels(db).length, 1);
  assert.equal(cfgMod.listHoldings(db).length, 1, '删掉的渠道其持仓也应随全量替换消失');
  db.close();
});

test('重命名渠道和资产类型：保留稳定 ID 与已关联持仓', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig());

  const renamed = baseConfig({
    channels: [
      { id: 'tiger', name: '老虎证券国际版', color: '#b97d10' },
      { id: 'binance', name: '币安现货账户', color: '#1746c7' },
    ],
    asset_types: [
      { id: 'stock', name: '美股', color: '#1746c7' },
      { id: 'crypto', name: '数字资产', color: '#b97d10' },
    ],
  });
  cfgMod.replaceConfig(db, renamed, 1);

  assert.deepEqual(cfgMod.listChannels(db).map(({ id, name }) => ({ id, name })), [
    { id: 'tiger', name: '老虎证券国际版' },
    { id: 'binance', name: '币安现货账户' },
  ]);
  assert.deepEqual(cfgMod.listAssetTypes(db).map(({ id, name }) => ({ id, name })), [
    { id: 'stock', name: '美股' },
    { id: 'crypto', name: '数字资产' },
  ]);
  assert.deepEqual(cfgMod.listHoldings(db).map(({ id, channel_id, asset_type_id, quantity }) =>
    ({ id, channel_id, asset_type_id, quantity })), [
    { id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', quantity: 2850 },
    { id: 'h2', channel_id: 'binance', asset_type_id: 'crypto', quantity: 1.578 },
  ], '重命名不能改变持仓关联、数量或顺序');
  db.close();
});

test('事务：校验失败时一行都不写（不留半套配置）', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig());
  const before = { ch: cfgMod.listChannels(db).length, hd: cfgMod.listHoldings(db).length, v: cfgMod.getVersion(db) };
  // 第二条持仓非法：整体应失败
  const bad = baseConfig({
    holdings: [
      { id: 'ok', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'AAPL', quote_category: 'us', quantity: 1 },
      { id: 'bad', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'AAPL', quote_category: 'us', quantity: -3 },
    ],
  });
  assert.throws(() => cfgMod.replaceConfig(db, bad));
  assert.equal(cfgMod.listChannels(db).length, before.ch);
  assert.equal(cfgMod.listHoldings(db).length, before.hd);
  assert.equal(cfgMod.getVersion(db), before.v, '失败不能推进版本号');
  db.close();
});

test('版本冲突：expected_version 不匹配返回 409 且不覆盖', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig());                        // version 1
  const err = (() => { try { cfgMod.replaceConfig(db, baseConfig(), 0); } catch (e) { return e; } })();
  assert.equal(err.code, 'VERSION_CONFLICT');
  assert.equal(err.current_version, 1);
  assert.equal(cfgMod.getVersion(db), 1, '冲突后版本不变');
  assert.equal(cfgMod.listHoldings(db).length, 2, '冲突后配置不变');
  db.close();
});

test('版本冲突：expected_version 匹配时正常写入', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig());
  const r = cfgMod.replaceConfig(db, baseConfig(), 1);
  assert.equal(r.version, 2);
  db.close();
});

test('外键级联：删除渠道/类型会带走其持仓', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig());
  assert.equal(cfgMod.listHoldings(db).length, 2);
  db.prepare('DELETE FROM portfolio_channels WHERE id = ?').run('binance');
  assert.equal(cfgMod.listHoldings(db).length, 1, '删渠道应级联删持仓');
  db.prepare('DELETE FROM portfolio_asset_types WHERE id = ?').run('stock');
  assert.equal(cfgMod.listHoldings(db).length, 0, '删类型应级联删持仓');
  db.close();
});

test('uniqueQuoteTargets：多渠渠道持有同一标的只算一个目标', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }],
    asset_types: [{ id: 't', name: 'T' }],
    holdings: [
      // 真实数据里 BMNR 就在 3 个渠道持有
      { id: 'a', channel_id: 'c1', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 100 },
      { id: 'b', channel_id: 'c2', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 200 },
      { id: 'c', channel_id: 'c1', asset_type_id: 't', symbol: 'BTC', quote_category: 'crypto', quantity: 1 },
    ],
  }));
  const targets = cfgMod.uniqueQuoteTargets(db);
  assert.equal(targets.length, 2, 'BMNR 两条持仓应合并成一个报价目标');
  assert.deepEqual(targets.map(t => `${t.quote_category}|${t.normalized_symbol}`),
    ['crypto|BTC', 'us|BMNR']);
  db.close();
});

// ── 报价去重与缓存 ──────────────────────────────────────────────────────
function fakeAdapters(map, calls) {
  return {
    async fetchWatchlistQuote(cat, sym) {
      calls.push(`${cat}|${sym}`);
      const k = `${cat}|${sym}`;
      if (map[k] === undefined) throw new Error(`无行情：${k}`);
      return map[k];
    },
  };
}

test('报价去重：同一标的多渠道只打一次上游', async () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }],
    asset_types: [{ id: 't', name: 'T' }],
    holdings: [
      { id: 'a', channel_id: 'c1', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 1 },
      { id: 'b', channel_id: 'c2', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 1 },
    ],
  }));
  const calls = [];
  const svc = createPortfolioQuoteService({
    db, adapters: fakeAdapters({ 'us|BMNR': { price: 26, price_currency: 'USD', chg_pct: 8.8, source_name: 'yahoo' } }, calls),
  });
  await svc.refresh(true);
  assert.equal(calls.length, 1, '同标的应只请求一次，实际 ' + calls.length);
  assert.equal(calls[0], 'us|BMNR');
  db.close();
});

test('报价缓存：60 秒内不重拉，force=1 强刷', async () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({ holdings: [{ id: 'h', channel_id: 'binance', asset_type_id: 'crypto', symbol: 'BTC', quote_category: 'crypto', quantity: 1 }] }));
  let nowMs = 1000000;
  const calls = [];
  const svc = createPortfolioQuoteService({
    db, cacheMs: 60000, now: () => nowMs,
    adapters: fakeAdapters({ 'crypto|BTC': { price: 98000, price_currency: 'USDT', source_name: 'binance' } }, calls),
  });
  await svc.refresh();
  assert.equal(calls.length, 1);
  await svc.refresh();          // 缓存新鲜 → 不该再打
  assert.equal(calls.length, 1, '缓存内应复用');
  nowMs += 61000;               // 越过 TTL
  await svc.refresh();
  assert.equal(calls.length, 2, '超时应重拉（isFresh 依赖注入的时钟）');
  await svc.refresh(true);      // 强刷
  assert.equal(calls.length, 3, 'force=1 应跳过缓存');
  db.close();
});

test('报价部分失败：失败项保留上次成功价，只改状态', async () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [
      { id: 'a', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 1 },
      { id: 'b', channel_id: 'c', asset_type_id: 't', symbol: 'BTC', quote_category: 'crypto', quantity: 1 },
    ],
  }));
  // 第一轮：两个都成功
  let fail = false;
  const adapters = {
    async fetchWatchlistQuote(cat, sym) {
      if (fail && sym === 'AAPL') throw new Error('上游 503');
      return sym === 'AAPL'
        ? { price: 200, price_currency: 'USD', source_name: 'yahoo' }
        : { price: 98000, price_currency: 'USDT', source_name: 'binance' };
    },
  };
  const svc = createPortfolioQuoteService({ db, adapters, cacheMs: 0 });
  await svc.refresh(true);
  const before = svc.snapshot().quotes.find(q => q.normalized_symbol === 'AAPL');
  assert.equal(before.status, 'ok');
  assert.equal(before.price, 200);

  // 第二轮：AAPL 失败
  fail = true;
  await svc.refresh(true);
  const after = svc.snapshot().quotes.find(q => q.normalized_symbol === 'AAPL');
  assert.equal(after.status, 'unavailable');
  assert.match(after.error_message, /503/);
  assert.equal(after.price, 200, '失败必须保留上次成功的价格，不能被清成 null/0');
  db.close();
});

test('报价：无持仓时返回空且不打上游', async () => {
  const db = freshDb();
  const calls = [];
  const svc = createPortfolioQuoteService({ db, adapters: fakeAdapters({}, calls) });
  const r = await svc.refresh(true);
  assert.equal(calls.length, 0);
  assert.equal(r.quotes.length, 0);
  assert.equal(r.empty, true);
  db.close();
});

// ── FX ──────────────────────────────────────────────────────────────────
test('FX：USD/USDT 按 1:1，不查汇率', async () => {
  assert.equal(toBaseCurrency(100, 'USD', {}), 100);
  assert.equal(toBaseCurrency(100, 'USDT', {}), 100);
  assert.equal(toBaseCurrency(100, 'usd', {}), 100, '币种大小写不敏感');
});

test('FX：HKD/CNY 缺汇率时返回 null（绝不假设 1:1）', () => {
  assert.equal(toBaseCurrency(100, 'HKD', {}), null);
  assert.equal(toBaseCurrency(100, 'CNY', {}), null);
  assert.equal(toBaseCurrency(100, 'HKD', { HKD: 0 }), null);
  assert.equal(toBaseCurrency(100, 'HKD', { HKD: -1 }), null);
  assert.equal(toBaseCurrency(100, 'HKD', { HKD: NaN }), null);
});

test('FX：HKD/CNY 有汇率时正确换算', () => {
  // 浮点乘法有尾差，用容差比较
  assert.ok(Math.abs(toBaseCurrency(1000, 'HKD', { HKD: 0.1279 }) - 127.9) < 1e-9);
  assert.ok(Math.abs(toBaseCurrency(1000, 'CNY', { CNY: 0.1399 }) - 139.9) < 1e-9);
});

test('FX：汇率服务拿不到时只给面值币种并报错，不编造 HKD/CNY', async () => {
  const fx = createFxService({
    fetchRateImpl: async () => { throw new Error('FX 上游不可用'); },
  });
  const snap = await fx.getRates(true);
  assert.equal(snap.rates.USD, 1);
  assert.equal(snap.rates.USDT, 1);
  assert.equal(snap.rates.HKD, undefined, '不能凭空给 HKD 汇率');
  assert.ok(snap.error, '应带错误说明');
  assert.equal(await fx.rateFor('HKD', true), null);
});

test('FX：USDHKD 取倒数（1 USD = x HKD → 1 HKD = 多少 USD）', async () => {
  const fx = createFxService({
    // 模拟 Yahoo 返回 7.8 HKD per USD
    fetchRateImpl: async (cur) => (cur === 'HKD' ? 1 / 7.8 : null),
  });
  const r = await fx.rateFor('HKD', true);
  assert.ok(Math.abs(r - 1 / 7.8) < 1e-9);
});

test('FX：汇率缓存 TTL 内复用', async () => {
  let n = 0; let nowMs = 0;
  const fx = createFxService({
    cacheMs: 1000, now: () => nowMs,
    fetchRateImpl: async () => { n++; return 0.13; },
  });
  await fx.getRates();
  const first = n;
  await fx.getRates();               // 缓存内
  assert.equal(n, first, 'TTL 内不应重复请求');
  nowMs += 2000;
  await fx.getRates();
  assert.ok(n > first, '超时后应重新请求');
});

// ── 估值 ────────────────────────────────────────────────────────────────
test('估值：缺行情 value=null 且标 missing_quote，不用 0 冒充', () => {
  const row = valueHolding({ quantity: 10 }, null, { USD: 1 });
  assert.equal(row.value, null);
  assert.equal(row.valued, false);
  assert.equal(row.unpriced_reason, 'missing_quote');
});

test('估值：行情 status 非 ok 也算缺行情', () => {
  const row = valueHolding({ quantity: 10 }, { status: 'unavailable', price: 100 }, { USD: 1 });
  assert.equal(row.valued, false);
  assert.equal(row.unpriced_reason, 'missing_quote');
});

test('估值：缺 FX 时 value=null 但保留原币单价与币种', () => {
  const row = valueHolding({ quantity: 100 },
    { status: 'ok', price: 612.4, price_currency: 'HKD', chg_pct: 0.9 }, { USD: 1, USDT: 1 });
  assert.equal(row.value, null);
  assert.equal(row.valued, false);
  assert.equal(row.unpriced_reason, 'missing_fx');
  assert.equal(row.price, 612.4, '保留原币单价，让用户看出问题在汇率');
  assert.equal(row.price_currency, 'HKD');
});

test('估值：有价格但无币种也算不可估值（不猜 USD）', () => {
  const row = valueHolding({ quantity: 1 }, { status: 'ok', price: 10, price_currency: null }, { USD: 1 });
  assert.equal(row.valued, false);
  assert.equal(row.unpriced_reason, 'missing_fx');
});

test('估值：正常换算（USDT 1:1、HKD 用汇率）', () => {
  const usd = valueHolding({ quantity: 2 }, { status: 'ok', price: 100, price_currency: 'USD' }, { USD: 1 });
  assert.equal(usd.value, 200);
  const usdt = valueHolding({ quantity: 2 }, { status: 'ok', price: 100, price_currency: 'USDT' }, { USD: 1, USDT: 1 });
  assert.equal(usdt.value, 200, 'USDT 应按 1:1');
  const hkd = valueHolding({ quantity: 100 }, { status: 'ok', price: 10, price_currency: 'HKD' }, { HKD: 0.128 });
  assert.ok(Math.abs(hkd.value - 128) < 1e-9);
});

test('估值：加权日涨跌的分母只含有效市值', () => {
  const rows = [
    { valued: true, value: 100, chg_pct: 10 },   // 权重 100
    { valued: true, value: 300, chg_pct: -2 },   // 权重 300
    { valued: false, value: null, chg_pct: 50 }, // 不可估值 → 不参与
  ];
  const got = weightedChange(rows);
  assert.ok(Math.abs(got - ((100 * 10 + 300 * -2) / 400)) < 1e-9);
});

test('估值：无可参与仓位时加权涨跌为 null，不是 0', () => {
  assert.equal(weightedChange([]), null);
  assert.equal(weightedChange([{ valued: false, value: null, chg_pct: 3 }]), null);
  assert.equal(weightedChange([{ valued: true, value: 100, chg_pct: null }]), null, '缺 chg_pct 不参与');
});

test('估值：buildValuation 端到端 —— 总额只含已估值，且暴露 unpriced_count', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'futu', name: '富途' }, { id: 'binance', name: '币安' }],
    asset_types: [{ id: 'stock', name: '美股资产' }, { id: 'crypto', name: '加密货币' }],
    holdings: [
      { id: 'h1', channel_id: 'futu', asset_type_id: 'stock', symbol: 'BMNR', quote_category: 'us', quantity: 100 },
      { id: 'h2', channel_id: 'futu', asset_type_id: 'stock', symbol: '0700', quote_category: 'hk', quantity: 200 },
      { id: 'h3', channel_id: 'binance', asset_type_id: 'crypto', symbol: 'BTC', quote_category: 'crypto', quantity: 1 },
    ],
  }));
  const quotes = [
    { quote_category: 'us', normalized_symbol: 'BMNR', status: 'ok', price: 26, price_currency: 'USD', chg_pct: 8.79 },
    // 港股：有行情但**没有 HKD 汇率** → 必须不可估值
    { quote_category: 'hk', normalized_symbol: '0700.HK', status: 'ok', price: 612.4, price_currency: 'HKD', chg_pct: 0.9 },
    { quote_category: 'crypto', normalized_symbol: 'BTC', status: 'ok', price: 98000, price_currency: 'USDT', chg_pct: 2.1 },
  ];
  const v = buildValuation(db, { quotes, fx: { rates: { USD: 1, USDT: 1 }, as_of: 'x' } });
  // 只有 BMNR(2600) + BTC(98000) 可估值
  assert.equal(v.total, 100600);
  assert.equal(v.valued_count, 2);
  assert.equal(v.unpriced_count, 1);
  assert.equal(v.by_channel.find(c => c.id === 'futu').share, 2600 / 100600);
  const hk = v.positions.find(p => p.normalized_symbol === '0700.HK');
  assert.equal(hk.value, null);
  assert.equal(hk.unpriced_reason, 'missing_fx');
  assert.deepEqual(v.missing_fx_currencies, ['HKD']);
  // 加权涨跌只含有效市值
  assert.ok(Math.abs(v.chg_pct - ((2600 * 8.79 + 98000 * 2.1) / 100600)) < 0.01);
  db.close();
});

test('估值：全部行情失败 → total=0、unpriced_count=全部、chg_pct=null', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 5 }],
  }));
  const v = buildValuation(db, { quotes: [], fx: { rates: { USD: 1 } } });
  assert.equal(v.total, 0);
  assert.equal(v.valued_count, 0);
  assert.equal(v.unpriced_count, 1);
  assert.equal(v.chg_pct, null, '全失败时组合涨跌必须是 null 而不是 0');
  assert.equal(v.positions[0].value, null, '单条 value 必须是 null 而不是 0');
  db.close();
});

test('估值：按类型合并跨渠道的同一标的（数量与市值相加）', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }],
    asset_types: [{ id: 't', name: '美股资产' }],
    holdings: [
      { id: 'a', channel_id: 'c1', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 100 },
      { id: 'b', channel_id: 'c2', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 200 },
    ],
  }));
  const quotes = [{ quote_category: 'us', normalized_symbol: 'BMNR', status: 'ok', price: 10, price_currency: 'USD', chg_pct: 1 }];
  const v = buildValuation(db, { quotes, fx: { rates: { USD: 1 } } });
  assert.equal(v.by_type.length, 1);
  const grp = v.by_type[0];
  assert.equal(grp.items.length, 1, '跨渠道同一标的应合并为一行');
  assert.equal(grp.items[0].quantity, 300, '数量应相加');
  assert.equal(grp.items[0].value, 3000, '市值应相加');
  assert.deepEqual(grp.items[0].channels.sort(), ['c1', 'c2']);
  db.close();
});

test('估值：按渠道不跨渠道合并（同一标的在两个渠道各占一行）', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }],
    asset_types: [{ id: 't', name: '美股资产' }],
    holdings: [
      { id: 'a', channel_id: 'c1', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 100 },
      { id: 'b', channel_id: 'c2', asset_type_id: 't', symbol: 'BMNR', quote_category: 'us', quantity: 200 },
    ],
  }));
  const quotes = [{ quote_category: 'us', normalized_symbol: 'BMNR', status: 'ok', price: 10, price_currency: 'USD', chg_pct: 1 }];
  const v = buildValuation(db, { quotes, fx: { rates: { USD: 1 } } });
  const c1 = v.by_channel.find(c => c.id === 'c1');
  const c2 = v.by_channel.find(c => c.id === 'c2');
  assert.equal(c1.value, 1000, 'c1 只算自己的 100 股');
  assert.equal(c2.value, 2000, 'c2 只算自己的 200 股');
  assert.equal(v.positions.length, 2, '按渠道明细里两条持仓各自保留');
  db.close();
});

test('估值：不同分类的同名代码不合并（A股 000001 vs 港股 00001）', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [
      { id: 'a', channel_id: 'c', asset_type_id: 't', symbol: '000001', quote_category: 'a_share', quantity: 10 },
      { id: 'b', channel_id: 'c', asset_type_id: 't', symbol: '1', quote_category: 'hk', quantity: 20 },
    ],
  }));
  const quotes = [
    { quote_category: 'a_share', normalized_symbol: '000001.SZ', status: 'ok', price: 10, price_currency: 'CNY', chg_pct: 1 },
    { quote_category: 'hk', normalized_symbol: '0001.HK', status: 'ok', price: 20, price_currency: 'HKD', chg_pct: 1 },
  ];
  const v = buildValuation(db, { quotes, fx: { rates: { USD: 1, CNY: 0.14, HKD: 0.128 } } });
  // 两条都要独立保留，不能被当成同一个标的
  assert.equal(v.positions.length, 2);
  assert.equal(v.by_type[0].items.length, 2, '不同 quote_category 不能合并');
  db.close();
});

test('估值：CNY 展示模式按 usd_cny_rate 换算 total_display', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    display_currency: 'CNY', usd_cny_rate: 7,
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  const quotes = [{ quote_category: 'us', normalized_symbol: 'AAPL', status: 'ok', price: 100, price_currency: 'USD', chg_pct: 0 }];
  const v = buildValuation(db, { quotes, fx: { rates: { USD: 1 } } });
  assert.equal(v.total, 100, 'total 恒为 USD');
  assert.equal(v.total_display, 700);
  assert.equal(v.display_currency, 'CNY');
  assert.equal(v.usd_cny_rate, 7);
  db.close();
});

test('估值：占比分母为零时为 0（不产生 NaN）', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  const v = buildValuation(db, { quotes: [], fx: { rates: { USD: 1 } } });
  for (const g of [...v.by_type, ...v.by_channel]) {
    assert.ok(Number.isFinite(g.share), `share 不能是 NaN：${JSON.stringify(g)}`);
  }
  db.close();
});

test('估值：空配置返回全零结构，不报错', () => {
  const db = freshDb();
  const v = buildValuation(db, { quotes: [], fx: { rates: { USD: 1 } } });
  assert.equal(v.total, 0);
  assert.equal(v.position_count, 0);
  assert.equal(v.chg_pct, null);
  assert.deepEqual(v.by_type, []);
  assert.deepEqual(v.by_channel, []);
  db.close();
});

// ── HTTP 集成 ───────────────────────────────────────────────────────────
// 默认注入一个**不发网络请求**的汇率服务：
// 否则 valuation 会真去请求 Yahoo 的 USDHKD/USDCNY，测试会挂住（实测卡死 40s+）。
function stubFx(rates = { USD: 1, USDT: 1, HKD: 0.128, CNY: 0.14, as_of: 'test' }) {
  return {
    async getRates() { return { ...rates, source: 'test', error: null, stale: false }; },
    async rateFor(cur) { return rates[String(cur).toUpperCase()] ?? null; },
    peek() { return rates; },
  };
}

function makeEnv(adapterOpts = {}) {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'invest.sqlite'));
  const { server, ...rest } = createServer({
    db,
    adapters: adapterOpts.adapters || { async fetchWatchlistQuote() { throw new Error('no upstream'); } },
    fxService: adapterOpts.fxService || stubFx(),
    portfolioQuotes: adapterOpts.portfolioQuotes,
    refreshService: {
      requestRefresh: () => ({ status: 202, merged: false, job: { id: 'j', status: 'running', started_at: 'now', finished_at: null, ok_count: 0, failed_count: 0, trigger: 'manual' } }),
      getInfo: () => ({ running: false, last: null, next_at: null }),
      start() {}, stop() {},
    },
  });
  return { dir, db, server, ...rest };
}
function listen(server) {
  return new Promise(res => server.listen(0, '127.0.0.1', () => res(`http://127.0.0.1:${server.address().port}`)));
}
const AUTH = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

test('HTTP：portfolio 端点需要鉴权', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  for (const p of ['/api/v1/portfolio/config', '/api/v1/portfolio/quotes', '/api/v1/portfolio/valuation']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 401, `${p} 应需要鉴权`);
  }
  env.server.close(); env.db.close();
});

test('HTTP：GET/PUT config 往返，PUT 走原子替换并推进版本', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  let r = await fetch(`${base}/api/v1/portfolio/config`, { headers: AUTH });
  let d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.version, 0);
  assert.deepEqual(d.holdings, []);
  assert.equal(d.base_currency, 'USD');

  r = await fetch(`${base}/api/v1/portfolio/config`, {
    method: 'PUT', headers: AUTH, body: JSON.stringify(baseConfig()),
  });
  d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.version, 1);

  r = await fetch(`${base}/api/v1/portfolio/config`, { headers: AUTH });
  d = await r.json();
  assert.equal(d.version, 1);
  assert.equal(d.channels[0].id, 'tiger', '保持提交顺序');
  assert.equal(d.holdings[1].normalized_symbol, 'BTC');
  assert.equal(d.usd_cny_rate, 6.8);
  env.server.close(); env.db.close();
});

test('HTTP：PUT 校验失败返回 400 且不落库', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  const r = await fetch(`${base}/api/v1/portfolio/config`, {
    method: 'PUT', headers: AUTH, body: JSON.stringify(baseConfig({ asset_types: [] })),
  });
  assert.equal(r.status, 400);
  const d = await r.json();
  assert.equal(d.ok, false);
  assert.match(d.error.message, /至少保留一个资产类型/);
  const after = await (await fetch(`${base}/api/v1/portfolio/config`, { headers: AUTH })).json();
  assert.equal(after.version, 0);
  assert.equal(after.channels.length, 0, '失败不能留下半套配置');
  env.server.close(); env.db.close();
});

test('HTTP：版本冲突 409 带 current_version（If-Match 与 expected_version 都支持）', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  await fetch(`${base}/api/v1/portfolio/config`, { method: 'PUT', headers: AUTH, body: JSON.stringify(baseConfig()) });

  // expected_version 方式
  let r = await fetch(`${base}/api/v1/portfolio/config`, {
    method: 'PUT', headers: AUTH,
    body: JSON.stringify(baseConfig({ expected_version: 99 })),
  });
  assert.equal(r.status, 409);
  let d = await r.json();
  assert.equal(d.error.code, 'VERSION_CONFLICT');
  assert.equal(d.error.details.current_version, 1);

  // If-Match 方式
  r = await fetch(`${base}/api/v1/portfolio/config`, {
    method: 'PUT', headers: { ...AUTH, 'if-match': '"99"' },
    body: JSON.stringify(baseConfig()),
  });
  assert.equal(r.status, 409);
  d = await r.json();
  assert.equal(d.error.details.current_version, 1);

  // 正确版本可写
  r = await fetch(`${base}/api/v1/portfolio/config`, {
    method: 'PUT', headers: { ...AUTH, 'if-match': '"1"' },
    body: JSON.stringify(baseConfig()),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).version, 2);
  env.server.close(); env.db.close();
});

test('HTTP：valuation 汇总缺行情时 value=null 且给出 unpriced_count', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  cfgMod.replaceConfig(env.db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 3 }],
  }));
  const r = await fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.total, 0);
  assert.equal(d.unpriced_count, 1);
  assert.equal(d.positions[0].value, null, 'value 必须是 null 不是 0');
  assert.equal(d.chg_pct, null, '组合涨跌必须是 null 不是 0');
  // 没有持仓 → 没有任何报价行 → empty
  assert.equal(d.price_source, 'partial', '一次刷新后存在失败记录，属 partial 而非 empty');
  env.server.close(); env.db.close();
});

test('HTTP：无持仓时 price_source=empty、total=0、chg_pct=null', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  const d = await (await fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH })).json();
  assert.equal(d.price_source, 'empty');
  assert.equal(d.total, 0);
  assert.equal(d.chg_pct, null);
  assert.equal(d.position_count, 0);
  env.server.close(); env.db.close();
});

test('HTTP：全部报价成功时 price_source=live', async () => {
  const adapters = {
    async fetchWatchlistQuote() { return { price: 100, price_currency: 'USD', chg_pct: 1, source_name: 'mock' }; },
  };
  const env = makeEnv({ adapters });
  const base = await listen(env.server);
  cfgMod.replaceConfig(env.db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 2 }],
  }));
  const d = await (await fetch(`${base}/api/v1/portfolio/valuation?force=1`, { headers: AUTH })).json();
  assert.equal(d.price_source, 'live');
  assert.equal(d.total, 200);
  assert.equal(d.valued_count, 1);
  env.server.close(); env.db.close();
});

test('HTTP：refresh 返回 202 不阻塞', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  const r = await fetch(`${base}/api/v1/portfolio/refresh?force=1`, { method: 'POST', headers: AUTH });
  assert.equal(r.status, 202);
  const d = await r.json();
  assert.equal(d.accepted, true);
  env.server.close(); env.db.close();
});

test('HTTP：持仓报价与自选报价互不影响（隔离验证）', async () => {
  const calls = [];
  const adapters = {
    async fetchWatchlistQuote(cat, sym) {
      calls.push(`${cat}|${sym}`);
      return { price: 100, price_currency: 'USD', chg_pct: 1, source_name: 'mock' };
    },
  };
  const env = makeEnv({ adapters });
  const base = await listen(env.server);
  cfgMod.replaceConfig(env.db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  await fetch(`${base}/api/v1/portfolio/quotes?force=1`, { headers: AUTH });
  // 持仓报价不该往自选表里写任何东西
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM watchlist_assets').get().n, 0,
    '持仓不能自动进入自选');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM watchlist_quotes').get().n, 0,
    '持仓报价不能写进自选报价缓存');
  assert.equal(env.db.prepare('SELECT COUNT(*) n FROM portfolio_quotes').get().n, 1);
  env.server.close(); env.db.close();
});

test('HTTP：/watchlist/quotes 形状未回归', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  const r = await fetch(`${base}/api/v1/watchlist/quotes`, { headers: AUTH });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(d.quotes));
  assert.ok(d.refresh !== undefined);
  env.server.close(); env.db.close();
});

// ── 迁移工具 ────────────────────────────────────────────────────────────
const { exportOldPortfolio, portfolioSourceHash, mapLegacyHoldings, importPortfolio, reconcilePortfolio } =
  await import('../server/portfolio/importer.js');
const { DatabaseSync } = await import('node:sqlite');

// 造一个「旧 MyInfo」库：investment_* 四张表
function makeOldDb({ channels, types, holdings, prefs } = {}) {
  const p = path.join(tmpDir(), 'old-dashboard.sqlite');
  const db = new DatabaseSync(p);
  db.exec(`
    CREATE TABLE investment_channels (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE investment_asset_types (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE investment_holdings (id INTEGER PRIMARY KEY, channel_id TEXT NOT NULL, asset_symbol TEXT NOT NULL, asset_type_id TEXT NOT NULL, quantity REAL NOT NULL);
    CREATE TABLE investment_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const ic = db.prepare('INSERT INTO investment_channels VALUES (?,?,?,?)');
  for (const c of channels ?? [
    { id: 'tiger', name: '老虎证券', color: '--tiger', order: 0 },
    // 真实数据里存在非 ASCII 渠道 ID，必须原样保留
    { id: '富途hk', name: '富途HK', color: '--stock', order: 1 },
  ]) ic.run(c.id, c.name, c.color, c.order);

  const it = db.prepare('INSERT INTO investment_asset_types VALUES (?,?,?,?)');
  for (const t of types ?? [
    { id: 'stock', name: '美股资产', color: '--stock', order: 0 },
    { id: 'crypto', name: '加密货币', color: '--crypto', order: 1 },
  ]) it.run(t.id, t.name, t.color, t.order);

  const ih = db.prepare('INSERT INTO investment_holdings VALUES (?,?,?,?,?)');
  for (const h of holdings ?? [
    { id: 1, channel_id: 'tiger', symbol: 'BMNR', type: 'stock', qty: 2850 },
    { id: 2, channel_id: '富途hk', symbol: 'MSTR', type: 'stock', qty: 38 },
    { id: 3, channel_id: 'tiger', symbol: 'BTC', type: 'crypto', qty: 1.578 },
  ]) ih.run(h.id, h.channel_id, h.symbol, h.type, h.qty);

  const ip = db.prepare('INSERT INTO investment_preferences VALUES (?,?)');
  for (const p2 of prefs ?? [{ key: 'currency', value: 'USD' }, { key: 'usd_cny_rate', value: '6.8' }]) {
    ip.run(p2.key, p2.value);
  }
  db.close();
  return p;
}

test('迁移：只读导出旧库四张表，含非 ASCII 渠道 ID', () => {
  const old = makeOldDb();
  const payload = exportOldPortfolio(old);
  assert.equal(payload.channels.length, 2);
  assert.equal(payload.asset_types.length, 2);
  assert.equal(payload.holdings.length, 3);
  assert.equal(payload.preferences.length, 2);
  assert.equal(payload.channels[1].id, '富途hk', '非 ASCII 渠道 ID 必须原样保留');
  assert.equal(payload.holdings[0].symbol, 'BMNR', '代码统一大写');
  assert.ok(payload.tables.investment_holdings);
});

test('迁移：源哈希稳定（同内容同哈希、内容变则哈希变）', () => {
  const a = exportOldPortfolio(makeOldDb());
  const b = exportOldPortfolio(makeOldDb());
  assert.equal(portfolioSourceHash(a), portfolioSourceHash(b), '同内容应同哈希');
  const c = exportOldPortfolio(makeOldDb({ holdings: [{ id: 1, channel_id: 'tiger', symbol: 'AAPL', type: 'stock', qty: 1 }] }));
  assert.notEqual(portfolioSourceHash(a), portfolioSourceHash(c), '内容不同应不同哈希');
});

test('迁移：已知类型映射 crypto→crypto、stock→us，并生成 normalized_symbol', () => {
  const payload = exportOldPortfolio(makeOldDb());
  const r = mapLegacyHoldings(payload);
  assert.equal(r.unmapped.length, 0);
  assert.equal(r.badSymbols.length, 0);
  const btc = r.mapped.find(h => h.symbol === 'BTC');
  assert.equal(btc.quote_category, 'crypto');
  assert.equal(btc.normalized_symbol, 'BTC');
  const bmnr = r.mapped.find(h => h.symbol === 'BMNR');
  assert.equal(bmnr.quote_category, 'us');
  assert.equal(bmnr.normalized_symbol, 'BMNR');
});

test('迁移：未知资产类型不猜成美股，列入 unmapped 并中止', () => {
  const old = makeOldDb({
    types: [{ id: 'stock', name: '美股', color: '--s', order: 0 }, { id: 'fund', name: '基金与理财', color: '--f', order: 1 }],
    holdings: [
      { id: 1, channel_id: 'tiger', symbol: 'BMNR', type: 'stock', qty: 1 },
      { id: 2, channel_id: 'tiger', symbol: '000001', type: 'fund', qty: 100 },
    ],
  });
  const payload = exportOldPortfolio(old);
  const r = mapLegacyHoldings(payload);
  assert.equal(r.unmapped.length, 1);
  assert.equal(r.unmapped[0].asset_type_id, 'fund');
  assert.equal(r.unmapped[0].holding_count, 1);

  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const rep = importPortfolio(dbPath, payload);
  assert.equal(rep.ok, false);
  assert.match(rep.checks.find(c => c.level === 'error').message, /无法确定行情分类/);
  // 关键：一行都不能写进去
  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_holdings').get().n, 0);
  db.close();
});

test('迁移：导入真实形状数据 → 来回一致 + 对账全绿', () => {
  const old = makeOldDb();
  const payload = exportOldPortfolio(old);
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();

  const rep = importPortfolio(dbPath, payload);
  assert.equal(rep.ok, true);
  assert.equal(rep.imported.channels, 2);
  assert.equal(rep.imported.holdings, 3);

  const rec = reconcilePortfolio(dbPath, payload);
  assert.equal(rec.ok, true, '对账应全绿：' + JSON.stringify(rec.checks.filter(c => c.level === 'error')));
  assert.equal(rec.counts.target.holdings, 3);

  const db = openDb(dbPath);
  // 保留渠道/类型 ID、名称、颜色、顺序与持仓数量
  assert.equal(db.prepare("SELECT name FROM portfolio_channels WHERE id='富途hk'").get().name, '富途HK');
  assert.equal(db.prepare("SELECT sort_order FROM portfolio_channels WHERE id='tiger'").get().sort_order, 0);
  assert.equal(db.prepare("SELECT quantity FROM portfolio_holdings WHERE symbol='BTC'").get().quantity, 1.578);
  assert.equal(db.prepare("SELECT value FROM portfolio_preferences WHERE key='usd_cny_rate'").get().value, '6.8');
  db.close();
});

test('迁移：幂等 —— 同一来源重放不重复写、版本不虚增', () => {
  const payload = exportOldPortfolio(makeOldDb());
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const r1 = importPortfolio(dbPath, payload);
  assert.equal(r1.ok, true);
  const v1 = r1.version_after;

  const r2 = importPortfolio(dbPath, payload);
  assert.equal(r2.ok, true);
  assert.equal(r2.idempotent_skip, true);
  assert.equal(r2.version_after, v1, '幂等重放不应推进版本');

  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_holdings').get().n, 3, '不能重复插入');
  db.close();
});

test('迁移：目标非空且来源不同 → 中止不覆盖', () => {
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const p1 = exportOldPortfolio(makeOldDb());
  assert.equal(importPortfolio(dbPath, p1).ok, true);

  // 另一份不同来源的数据
  const p2 = exportOldPortfolio(makeOldDb({
    holdings: [{ id: 9, channel_id: 'tiger', symbol: 'AAPL', type: 'stock', qty: 5 }],
  }));
  const r = importPortfolio(dbPath, p2);
  assert.equal(r.ok, false);
  assert.match(r.checks.find(c => c.level === 'error').message, /已有数据/);

  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_holdings').get().n, 3, '原数据不能被覆盖');
  db.close();
});

test('迁移：--force 允许覆盖（需显式指定）', () => {
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const p1 = exportOldPortfolio(makeOldDb());
  importPortfolio(dbPath, p1);
  const p2 = exportOldPortfolio(makeOldDb({
    holdings: [{ id: 9, channel_id: 'tiger', symbol: 'AAPL', type: 'stock', qty: 5 }],
  }));
  const r = importPortfolio(dbPath, p2, { force: true });
  assert.equal(r.ok, true);
  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_holdings').get().n, 1);
  assert.equal(db.prepare('SELECT symbol FROM portfolio_holdings').get().symbol, 'AAPL');
  db.close();
});

test('迁移：空旧库是合法状态（不播种、不报错）', () => {
  const old = makeOldDb({ channels: [], types: [], holdings: [], prefs: [] });
  const payload = exportOldPortfolio(old);
  assert.equal(payload.holdings.length, 0);
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const r = importPortfolio(dbPath, payload);
  // 空源：无类型会被 validate 拦住，但迁移工具按「无数据可导」处理
  assert.equal(r.counts.holdings, 0);
  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_holdings').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_channels').get().n, 0, '绝不能播种示例数据');
  db.close();
});

test('迁移：dry-run 不写入', () => {
  const payload = exportOldPortfolio(makeOldDb());
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const r = importPortfolio(dbPath, payload, { dryRun: true });
  assert.equal(r.ok, true);
  const db = openDb(dbPath);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_channels').get().n, 0);
  db.close();
});

test('迁移：孤儿持仓（引用不存在的渠道）被拒绝', () => {
  const old = makeOldDb({
    holdings: [{ id: 1, channel_id: 'ghost', symbol: 'AAPL', type: 'stock', qty: 1 }],
  });
  const payload = exportOldPortfolio(old);
  const dbPath = path.join(tmpDir(), 'invest.sqlite');
  openDb(dbPath).close();
  const r = importPortfolio(dbPath, payload);
  assert.equal(r.ok, false);
  assert.match(r.checks.find(c => c.level === 'error').message, /引用了不存在的渠道/);
});

// ── 持仓 K 线（owner='pf'，与自选缓存隔离） ──────────────────────────────
test('持仓 K 线：/portfolio/candles 参数校验', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  let r = await fetch(`${base}/api/v1/portfolio/candles?quote_category=bogus&normalized_symbol=X`, { headers: AUTH });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /quote_category/);

  r = await fetch(`${base}/api/v1/portfolio/candles?quote_category=us`, { headers: AUTH });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /normalized_symbol/);

  r = await fetch(`${base}/api/v1/portfolio/candles?quote_category=us&normalized_symbol=AAPL&interval=1w&range=6mo`, { headers: AUTH });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error.message, /range 与 interval 不匹配/);

  env.server.close(); env.db.close();
});

test('持仓 K 线：需要鉴权', async () => {
  const env = makeEnv();
  const base = await listen(env.server);
  const r = await fetch(`${base}/api/v1/portfolio/candles?quote_category=us&normalized_symbol=AAPL`);
  assert.equal(r.status, 401);
  env.server.close(); env.db.close();
});

test('持仓 K 线：合成 id 打 owner=pf，不写进自选，也不与自选缓存互相覆盖', async () => {
  const env = makeEnv();
  // 给 candleService 注入可控的适配器
  const calls = [];
  const { createCandleService } = await import('../server/quotes/candle-service.js');
  env.server.close(); env.db.close();

  const dir = tmpDir();
  const db = openDb(path.join(dir, 'invest.sqlite'));
  const { createAsset } = await import('../server/assets.js');
  const { asset } = createAsset(db, { category: 'us', symbol: 'BMNR', name: 'Bitmine' });
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'tiger', name: '老虎' }], asset_types: [{ id: 'stock', name: '美股' }],
    holdings: [{ id: 'h1', channel_id: 'tiger', asset_type_id: 'stock', symbol: 'BMNR', quote_category: 'us', quantity: 10 }],
  }));

  const candleAdapters = {
    async fetchCandles(category, sym) {
      calls.push(`${category}|${sym}`);
      return {
        candles: [
          { open_time_ms: 1000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
          { open_time_ms: 2000, open: 1.5, high: 3, low: 1, close: 2.5, volume: 20 },
        ],
        source_name: 'mock', currency: 'USD',
      };
    },
  };
  const candleService = createCandleService({ db, candleAdapters });
  const { server } = createServer({
    db,
    adapters: { async fetchWatchlistQuote() { throw new Error('no'); } },
    fxService: stubFx(),
    candleService,
    refreshService: { requestRefresh: () => ({}), getInfo: () => ({}), start() {}, stop() {} },
  });
  const base = await listen(server);

  // 自选资产的 K 线
  const w = await fetch(`${base}/api/v1/watchlist/assets/${asset.id}/candles?interval=1d&range=6mo`, { headers: AUTH });
  assert.equal(w.status, 200);
  const wd = await w.json();
  assert.equal(wd.candles.length, 2);
  assert.ok(!wd.asset_id.startsWith('pf:'), '自选的 asset_id 不应变成合成 id');

  // 同标的的持仓 K 线
  const p = await fetch(`${base}/api/v1/portfolio/candles?quote_category=us&normalized_symbol=BMNR&interval=1d&range=6mo`, { headers: AUTH });
  assert.equal(p.status, 200);
  const pd = await p.json();
  assert.equal(pd.candles.length, 2);
  assert.equal(pd.asset_id, 'pf:us:BMNR', '持仓用合成 id');
  assert.equal(calls.length, 2, '两个键空间各拉一次');

  // 落库应有两组 owner，互不干扰
  const byOwner = db.prepare('SELECT owner, COUNT(*) n FROM candle_cache GROUP BY owner').all();
  const map = Object.fromEntries(byOwner.map(r => [r.owner, r.n]));
  assert.equal(map.watch, 2);
  assert.equal(map.pf, 2);
  // 自选行有外键列，持仓行为 NULL（不挂自选表）
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='pf' AND watch_asset_id IS NOT NULL").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch' AND watch_asset_id IS NOT NULL").get().n, 2);

  server.close(); db.close();
});

test('持仓 K 线：删自选资产只级联清它的 K 线，不影响持仓缓存', async () => {
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'invest.sqlite'));
  const { createAsset, deleteAsset } = await import('../server/assets.js');
  const { asset } = createAsset(db, { category: 'us', symbol: 'BMNR', name: 'Bitmine' });
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 't', name: 'T' }], asset_types: [{ id: 's', name: 'S' }],
    holdings: [{ id: 'h', channel_id: 't', asset_type_id: 's', symbol: 'BMNR', quote_category: 'us', quantity: 1 }],
  }));
  // 手工写两组缓存
  const ins = db.prepare(`INSERT INTO candle_cache
    (owner, owner_key, interval, open_time_ms, open, high, low, close, volume, source_name, fetched_at, range, watch_asset_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('watch', asset.id, '1d', 1000, 1, 2, 1, 2, null, 'mock', 'now', '6mo', asset.id);
  ins.run('pf', 'us:BMNR', '1d', 1000, 1, 2, 1, 2, null, 'mock', 'now', '6mo', null);

  deleteAsset(db, asset.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch'").get().n, 0, '自选 K 线应被外键级联清掉');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='pf'").get().n, 1, '持仓 K 线不该被自选删除影响');
  db.close();
});

test('持仓 K 线：换配置后清掉不再持有标的的缓存', () => {
  const db = freshDb();
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 't', name: 'T' }], asset_types: [{ id: 's', name: 'S' }],
    holdings: [{ id: 'h', channel_id: 't', asset_type_id: 's', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  const ins = db.prepare(`INSERT INTO candle_cache
    (owner, owner_key, interval, open_time_ms, open, high, low, close, volume, source_name, fetched_at, range, watch_asset_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  ins.run('pf', 'us:AAPL', '1d', 1000, 1, 2, 1, 2, null, 'mock', 'now', '6mo', null);
  ins.run('pf', 'us:OLD', '1d', 1000, 1, 2, 1, 2, null, 'mock', 'now', '6mo', null);
  ins.run('watch', 'some-id', '1d', 1000, 1, 2, 1, 2, null, 'mock', 'now', '6mo', null);

  // 再保存一次（仍只持有 AAPL）→ OLD 的缓存应被清掉
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 't', name: 'T' }], asset_types: [{ id: 's', name: 'S' }],
    holdings: [{ id: 'h', channel_id: 't', asset_type_id: 's', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  const left = db.prepare("SELECT owner_key FROM candle_cache WHERE owner='pf'").all().map(r => r.owner_key);
  assert.deepEqual(left, ['us:AAPL']);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM candle_cache WHERE owner='watch'").get().n, 1, '自选那半不该被动');
  db.close();
});

// ── 打开资产页不应同步等上游（stale-while-revalidate） ──────────────────
// 背景：valuation 原先在缓存过期时 await refresh()，于是「打开资产页」要同步等
// 5 个标的拉完（实测 3.6s，force=1 6.0s），而自选页只要 1.8ms。
test('valuation：缓存过期时立即返回旧快照并标记 stale（不等上游）', async () => {
  const { createPortfolioQuoteService } = await import('../server/portfolio/quote-service.js');
  const dir = tmpDir();
  const db = openDb(path.join(dir, 'invest.sqlite'));
  let upstreamCalls = 0;
  let nowMs = 1000000;
  // ⚠️ 过期必须用「推进注入时钟」来制造，不能改库里 updated_at ——
  // isFresh() 用的是进程内的时钟（lastFetchedAtMs），与库里的时间戳是两回事。
  const portfolioQuotes = createPortfolioQuoteService({
    db, cacheMs: 60000, now: () => nowMs,
    adapters: {
      async fetchWatchlistQuote() {
        upstreamCalls++;
        await new Promise(r => setTimeout(r, 300));   // 慢上游：用来暴露「是否在等」
        return { price: 100, price_currency: 'USD', chg_pct: 1, source_name: 'mock' };
      },
    },
  });
  const { server } = createServer({
    db,
    adapters: { async fetchWatchlistQuote() { throw new Error('unused'); } },
    fxService: stubFx(),
    portfolioQuotes,
    refreshService: { requestRefresh: () => ({}), getInfo: () => ({}), start() {}, stop() {} },
  });
  const base = await listen(server);
  cfgMod.replaceConfig(db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 2 }],
  }));

  // ① 无快照：只能同步等上游
  const t0 = Date.now();
  let d = await (await fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH })).json();
  const firstMs = Date.now() - t0;
  assert.equal(d.stale, false, '首次（无快照）不该标 stale');
  assert.equal(d.total, 200);
  assert.ok(upstreamCalls >= 1, '首次应真的去拉上游');
  assert.ok(firstMs >= 250, `首次没有快照必须等上游（实测 ${firstMs}ms）`);

  // ② 推进时钟越过 TTL，模拟缓存过期
  nowMs += 61000;
  assert.equal(portfolioQuotes.isFresh(), false, '推进时钟后应判为过期');
  const before = upstreamCalls;

  // 关键：过期后再打开，必须**立刻**返回旧快照，不能等上游
  const t1 = Date.now();
  d = await (await fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH })).json();
  const expiredMs = Date.now() - t1;
  assert.ok(expiredMs < 150, `过期后应立即返回，实测 ${expiredMs}ms（不应等 300ms 的上游）`);
  assert.equal(d.stale, true, '过期时应标 stale（后台正在补拉）');
  assert.equal(d.total, 200, '过期时仍应返回旧快照的估值（100 × 2）');
  assert.equal(d.position_count, 1);

  // ③ 后台确实去刷新了（不阻塞，但最终会更新）
  await new Promise(r2 => setTimeout(r2, 900));
  assert.ok(upstreamCalls > before, '后台应发起刷新');
  const after = await (await fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH })).json();
  assert.equal(after.stale, false, '后台刷新完成后不应再标 stale');

  server.close(); db.close();
});

test('valuation：force=1 仍同步刷新（刷新按钮语义不变）', async () => {
  let calls = 0;
  const adapters = {
    async fetchWatchlistQuote() {
      calls++;
      await new Promise(r => setTimeout(r, 200));
      return { price: 50, price_currency: 'USD', chg_pct: 2, source_name: 'mock' };
    },
  };
  const env = makeEnv({ adapters });
  const base = await listen(env.server);
  cfgMod.replaceConfig(env.db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  const t0 = Date.now();
  const d = await (await fetch(`${base}/api/v1/portfolio/valuation?force=1`, { headers: AUTH })).json();
  assert.ok(Date.now() - t0 >= 180, 'force=1 应同步等上游（用户主动点了刷新）');
  assert.equal(d.stale, false);
  assert.equal(d.total, 50);
  env.server.close(); env.db.close();
});

test('valuation：无快照且上游失败时不崩溃，给出可读错误与空估值', async () => {
  const env = makeEnv({
    adapters: { async fetchWatchlistQuote() { throw new Error('上游 503'); } },
  });
  const base = await listen(env.server);
  cfgMod.replaceConfig(env.db, baseConfig({
    channels: [{ id: 'c', name: 'C' }], asset_types: [{ id: 't', name: 'T' }],
    holdings: [{ id: 'h', channel_id: 'c', asset_type_id: 't', symbol: 'AAPL', quote_category: 'us', quantity: 1 }],
  }));
  const r = await fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.total, 0);
  assert.equal(d.unpriced_count, 1, '拉不到行情应算未估值，而不是按 0 计入');
  assert.equal(d.chg_pct, null);
  env.server.close(); env.db.close();
});

test('valuation：冷启动时报价与汇率并行获取', async () => {
  const db = freshDb();
  let quoteStarted = false, fxStarted = false;
  let signalQuote, signalFx;
  const quoteStartedSignal = new Promise(resolve => { signalQuote = resolve; });
  const fxStartedSignal = new Promise(resolve => { signalFx = resolve; });
  let releaseQuote, releaseFx;
  const quoteGate = new Promise(resolve => { releaseQuote = resolve; });
  const fxGate = new Promise(resolve => { releaseFx = resolve; });
  const portfolioQuotes = {
    hasSnapshot: () => false,
    refresh: async () => {
      quoteStarted = true;
      signalQuote();
      await quoteGate;
      return { quotes: [], refreshed_at: new Date().toISOString() };
    },
  };
  const fxService = {
    getRates: async () => {
      fxStarted = true;
      signalFx();
      await fxGate;
      return { rates: { USD: 1, USDT: 1 }, as_of: new Date().toISOString() };
    },
  };
  const { server } = createServer({
    db, portfolioQuotes, fxService,
    refreshService: { requestRefresh: () => ({}), getInfo: () => ({}), start() {}, stop() {} },
  });
  const base = await listen(server);
  try {
    const response = fetch(`${base}/api/v1/portfolio/valuation`, { headers: AUTH });
    await Promise.race([
      Promise.all([quoteStartedSignal, fxStartedSignal]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('报价和汇率未能同时启动')), 500)),
    ]);
    assert.equal(quoteStarted, true);
    assert.equal(fxStarted, true, '不应等报价完成才开始查汇率');
    releaseQuote(); releaseFx();
    assert.equal((await response).status, 200);
  } finally {
    releaseQuote(); releaseFx();
    server.close(); db.close();
  }
});

// ── 汇率缓存 TTL：2 小时（汇率变动极慢，不必频繁拉） ──────────────────
test('FX：冷启动时 HKD 与 CNY 并行获取', async () => {
  const started = new Set();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fx = createFxService({
    fetchRateImpl: async cur => { started.add(cur); await gate; return 0.13; },
  });
  const ratesPromise = fx.getRates();
  try {
    assert.deepEqual([...started].sort(), ['CNY', 'HKD']);
  } finally {
    release();
  }
  const rates = await ratesPromise;
  assert.equal(rates.rates.HKD, 0.13);
  assert.equal(rates.rates.CNY, 0.13);
});

test('FX：默认 TTL 6 小时；未过期不重拉，超过才后台补拉', async () => {
  const { createFxService } = await import('../server/portfolio/fx.js');
  let nowMs = 1000000, calls = 0;
  const { config } = await import('../server/config.js');
  assert.equal(config.fxCacheMs, 6 * 60 * 60 * 1000, '默认应为 6 小时');

  const fx = createFxService({
    cacheMs: config.fxCacheMs,
    now: () => nowMs,
    fetchRateImpl: async () => { calls++; return 0.128; },
  });
  const H = 3600 * 1000, M = 60 * 1000;

  await fx.getRates(false);
  const afterCold = calls;
  assert.ok(afterCold > 0, '冷启动应拉一次');

  nowMs += 359 * M;                       // 5 小时 59 分：未过期
  let r = await fx.getRates(false);
  assert.equal(r.stale, false);
  assert.equal(calls, afterCold, '未过期不应重新拉上游');

  nowMs += 2 * M;                         // 6 小时 01 分：过期
  const t = Date.now();
  r = await fx.getRates(false);
  assert.ok(Date.now() - t < 50, '过期时应立即返回旧汇率（后台补拉，不阻塞）');
  assert.equal(r.stale, true);
  assert.ok(r.rates.HKD, '过期时仍应带着旧汇率');
  await new Promise(x => setTimeout(x, 100));
  assert.ok(calls > afterCold, '后台应已补拉');
});

test('FX：部分币种失败时沿用上次成功的汇率（汇率源抖动不该清空估值）', async () => {
  const { createFxService } = await import('../server/portfolio/fx.js');
  let fail = false;
  const fx = createFxService({
    fetchRateImpl: async (cur) => {
      if (fail) throw new Error('FX down');
      return cur === 'HKD' ? 1 / 7.8 : 1 / 6.7;
    },
  });
  const ok = await fx.getRates(true);
  assert.ok(ok.rates.HKD && ok.rates.CNY);

  fail = true;
  const bad = await fx.getRates(true);
  assert.ok(bad.error, '应如实记录错误');
  assert.equal(bad.rates.HKD, ok.rates.HKD, 'HKD 应沿用上次成功的值');
  assert.equal(bad.rates.CNY, ok.rates.CNY, 'CNY 应沿用上次成功的值');
});
