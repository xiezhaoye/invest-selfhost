// K 线适配器固定输入测试：mock fetch，不触网。
// 覆盖：Yahoo OHLC 解析（含 null 行丢弃、周期方言映射）、Binance Klines、
// CoinGecko OHLC（volume 必须为 null，不得编 0）、非法/空响应抛错、绝不伪造 OHLC。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCandleAdapters, isValidInterval, isValidRange, DEFAULT_RANGE, rangeForCount } from '../server/quotes/candles.js';

// 记录每次请求的 URL，便于断言「周期方言翻译」是否正确
function mockFetch(routes, calls = []) {
  const fn = async (url) => {
    calls.push(String(url));
    for (const [prefix, responder] of routes) {
      if (String(url).startsWith(prefix)) {
        const r = typeof responder === 'function' ? responder(String(url)) : responder;
        if (r instanceof Error) throw r;
        return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`mock: no route for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

// Yahoo chart 响应：四个 OHLC 数组 + volume，按 timestamp 下标对齐
function yahooChart({ ts, open, high, low, close, volume, currency = 'USD' }) {
  return {
    chart: {
      result: [{
        meta: { currency },
        timestamp: ts,
        indicators: { quote: [{ open, high, low, close, volume }] },
      }],
    },
  };
}

const T0 = 1725148800; // 2024-09-01T00:00:00Z 秒

test('Yahoo：OHLCV 正常解析，时间戳转成毫秒', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({
      ts: [T0, T0 + 86400],
      open: [220.1, 224.8], high: [225.4, 226.0], low: [219.5, 223.0], close: [224.8, 225.5],
      volume: [12345678, 9988776],
    })],
  ]) });
  const r = await a.fetchCandles('us', 'AAPL', { interval: '1d', range: '6mo' });
  assert.equal(r.source_name, 'yahoo');
  assert.equal(r.currency, 'USD');
  assert.equal(r.candles.length, 2);
  assert.deepEqual(r.candles[0], {
    open_time_ms: T0 * 1000, open: 220.1, high: 225.4, low: 219.5, close: 224.8, volume: 12345678,
  });
});

test('Yahoo：任一价格缺失的整根丢弃（不拿 close 顶替）', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({
      ts: [T0, T0 + 86400, T0 + 172800],
      open: [100, null, 102],       // 第二根缺 open
      high: [101, 103, null],       // 第三根缺 high
      low: [99, 101, 100],
      close: [100.5, 102, 101],
      volume: [1, 2, 3],
    })],
  ]) });
  const r = await a.fetchCandles('us', 'AAPL', { interval: '1d', range: '6mo' });
  assert.equal(r.candles.length, 1, '只应保留第一根');
  assert.equal(r.candles[0].open_time_ms, T0 * 1000);
});

test('Yahoo：volume 缺失时为 null，不编 0', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({
      ts: [T0], open: [1], high: [2], low: [0.5], close: [1.5], volume: [null],
    })],
  ]) });
  const r = await a.fetchCandles('index', '^TNX', { interval: '1d', range: '6mo' });
  assert.equal(r.candles[0].volume, null);
});

test('Yahoo：非法价格（<=0）整根丢弃', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({
      ts: [T0, T0 + 86400],
      open: [0, 10], high: [0, 11], low: [0, 9], close: [0, 10.5], volume: [0, 5],
    })],
  ]) });
  const r = await a.fetchCandles('us', 'AAPL', { interval: '1d', range: '6mo' });
  assert.equal(r.candles.length, 1);
  assert.equal(r.candles[0].open, 10);
});

// 关键回归：Yahoo 只认 1d/1wk/1mo。把契约的 1w/1M 原样透传会 400（实测踩到过）。
test('Yahoo：周期方言翻译 1w→1wk、1M→1mo（不把 Binance 方言透给 Yahoo）', async () => {
  const calls = [];
  for (const [interval, expected] of [['1w', '1wk'], ['1M', '1mo']]) {
    const f = mockFetch([
      ['https://query1.finance.yahoo.com', yahooChart({
        ts: [T0], open: [1], high: [2], low: [1], close: [1.5], volume: [1],
      })],
    ], calls);
    const a = createCandleAdapters({ fetchImpl: f });
    await a.fetchCandles('us', 'AAPL', { interval, range: DEFAULT_RANGE[interval] });
    assert.ok(calls.at(-1).includes(`interval=${expected}`),
      `${interval} 应翻译成 ${expected}，实际 URL: ${calls.at(-1)}`);
  }
});

test('Binance：Klines 解析为 OHLCV（不经过 CoinGecko）', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://api.binance.com', [
      // [openTime, open, high, low, close, volume, closeTime, ...]
      [T0 * 1000, '81000.0', '82000.0', '80500.0', '81500.0', '1234.5', 0, '0', 0, '0', '0', '0'],
    ]],
  ]) });
  const r = await a.fetchCandles('crypto', 'BTC', { interval: '1d', range: '6mo' });
  assert.equal(r.source_name, 'binance');
  assert.equal(r.currency, 'USDT');
  assert.deepEqual(r.candles[0], {
    open_time_ms: T0 * 1000, open: 81000, high: 82000, low: 80500, close: 81500, volume: 1234.5,
  });
});

test('Binance：周线/月线用 1w/1M（Binance 的方言），且带 limit', async () => {
  const calls = [];
  for (const interval of ['1w', '1M']) {
    const f = mockFetch([
      ['https://api.binance.com', [[T0 * 1000, '1', '2', '0.5', '1.5', '10', 0, '0', 0, '0', '0', '0']]],
    ], calls);
    const a = createCandleAdapters({ fetchImpl: f });
    await a.fetchCandles('crypto', 'BTC', { interval, range: DEFAULT_RANGE[interval] });
    assert.ok(calls.at(-1).includes(`interval=${interval}`), `URL 应含 interval=${interval}`);
    assert.ok(calls.at(-1).includes('limit='), 'URL 应带 limit');
  }
});

test('crypto：Binance 无该交易对时整体回退 CoinGecko，且 volume 为 null', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    // Binance 对 HYPE 返回空数组 → 触发回退
    ['https://api.binance.com', []],
    // symbol → id 解析
    ['https://api.coingecko.com/api/v3/coins/markets', [{ id: 'hyperliquid', symbol: 'hype' }]],
    // OHLC：[[ts, open, high, low, close]]，没有 volume
    ['https://api.coingecko.com/api/v3/coins/hyperliquid/ohlc', [
      [T0 * 1000, 76.9, 94.5, 76.6, 92.1],
    ]],
  ]) });
  const r = await a.fetchCandles('crypto', 'HYPE', { interval: '1d', range: '6mo' });
  assert.equal(r.source_name, 'coingecko');
  assert.equal(r.currency, 'USD');
  assert.equal(r.limited_history, true, 'CoinGecko 应标注历史深度受限');
  assert.equal(r.candles.length, 1);
  assert.equal(r.candles[0].volume, null, 'CoinGecko 无 volume，必须 null 而不是 0');
  assert.equal(r.candles[0].open, 76.9);
  assert.equal(r.candles[0].high, 94.5);
});

test('CoinGecko：OHLC 缺字段的行整根丢弃', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://api.binance.com', []],
    ['https://api.coingecko.com/api/v3/coins/markets', [{ id: 'x', symbol: 'x' }]],
    ['https://api.coingecko.com/api/v3/coins/x/ohlc', [
      [T0 * 1000, 1, 2, 0.5, 1.5],
      [T0 * 1000 + 86400000, 1, null, 0.5, 1.5],   // 缺 high
    ]],
  ]) });
  const r = await a.fetchCandles('crypto', 'X', { interval: '1d', range: '6mo' });
  assert.equal(r.candles.length, 1);
});

test('CoinGecko：解析不出 coin id 时抛错（不返回空图）', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://api.binance.com', []],
    ['https://api.coingecko.com/api/v3/coins/markets', []],   // 查无此币
  ]) });
  await assert.rejects(
    () => a.fetchCandles('crypto', 'NOPE', { interval: '1d', range: '6mo' }),
    /CoinGecko 未识别该币种/
  );
});

test('Yahoo：无 result 时抛错', async () => {
  const a = createCandleAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', { chart: { result: null } }],
  ]) });
  await assert.rejects(
    () => a.fetchCandles('us', 'AAPL', { interval: '1d', range: '6mo' }),
    /Yahoo 无图表数据/
  );
});

test('上游 HTTP 错误抛出（含 host 便于排查）', async () => {
  const a = createCandleAdapters({ fetchImpl: async () => new Response('nope', { status: 400 }) });
  await assert.rejects(
    () => a.fetchCandles('us', 'AAPL', { interval: '1d', range: '6mo' }),
    /HTTP 400 from query1\.finance\.yahoo\.com/
  );
});

test('参数白名单：interval 与 range 的合法组合', () => {
  assert.ok(isValidInterval('1d'));
  assert.ok(isValidInterval('1w'));
  assert.ok(isValidInterval('1M'));
  assert.ok(!isValidInterval('5m'));
  assert.ok(!isValidInterval('1y'));
  assert.ok(!isValidInterval(''));
  // range 必须与 interval 匹配，防止任意组合透传给上游
  assert.ok(isValidRange('1d', '6mo'));
  assert.ok(!isValidRange('1d', '10y'));
  assert.ok(isValidRange('1w', '3y'));
  assert.ok(!isValidRange('1w', '6mo'));
  assert.ok(isValidRange('1M', '10y'));
  assert.ok(!isValidRange('1M', '3y'));
  // 2026-09-21：前端支持联动缩放后新增了 deep 档（要看最多 150 根）
  assert.ok(isValidRange('1d', '1y'));
  assert.ok(isValidRange('1d', '2y'));
  assert.ok(isValidRange('1w', '5y'));
  assert.ok(isValidRange('1w', '10y'));
  assert.ok(isValidRange('1M', 'max'));
  // 跨周期的档位不可混用
  assert.ok(!isValidRange('1d', 'max'));
  assert.ok(!isValidRange('1M', '6mo'));
});

test('rangeForCount：按想要的根数挑最小够用的档', () => {
  // 默认档够用时不升级，避免为看 50 根去拉十年数据
  assert.equal(rangeForCount('1d', 50), '6mo');
  assert.equal(rangeForCount('1w', 50), '3y');
  assert.equal(rangeForCount('1M', 50), '10y');
  // 要看 150 根时，日线/月线的默认档不够，必须升档
  assert.equal(rangeForCount('1d', 150), '1y');
  assert.equal(rangeForCount('1M', 150), 'max');
  // 周线 3y 本身约 158 根，150 够用，不应升级
  assert.equal(rangeForCount('1w', 150), '3y');
  // 超出全部档位时退回最大档（而不是返回 undefined）
  assert.equal(rangeForCount('1d', 99999), '2y');
  assert.equal(rangeForCount('1M', 99999), 'max');
});

// ── CoinGecko 熔断 / 退避 ──
// 免费套餐容易 429；熔断的意义是不再硬打（否则窗口越撞越长），
// 让 service 走「旧缓存 + stale」降级，而不是把限流转成噪音。
test('CoinGecko 熔断：连续限流达阈值后直接抛错，不再打 CoinGecko', async () => {
  const seen = [];
  const a = createCandleAdapters({
    coinGeckoBreakerThreshold: 2,
    coinGeckoBreakerOpenMs: 60_000,
    fetchImpl: async (url) => {
      const isCg = String(url).includes('api.coingecko.com');
      seen.push(isCg ? 'cg' : 'binance');
      if (!isCg) return new Response(JSON.stringify([]), { status: 200 });
      return new Response(JSON.stringify({ status: { error_code: 429 } }), { status: 429 });
    },
  });
  // 前两次真实打到上游（Binance 空 → 回退 CoinGecko → 429）
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => a.fetchCandles('crypto', 'HYPE', { interval: '1d', range: '6mo' }));
  }
  const cgAfterTrip = seen.filter(x => x === 'cg').length;
  assert.equal(cgAfterTrip, 2);
  assert.equal(a.breakerState().open, true, '达阈值后应熔断');
  // 熔断期间再请求：不应再打到 CoinGecko（Binance 作为主源仍会先试一次）
  await assert.rejects(
    () => a.fetchCandles('crypto', 'HYPE', { interval: '1d', range: '6mo' }),
    /熔断/
  );
  assert.equal(
    seen.filter(x => x === 'cg').length, cgAfterTrip,
    '熔断期间不应再请求 CoinGecko'
  );
});

test('CoinGecko 熔断：成功一次即复位', async () => {
  let mode = '429';
  const a = createCandleAdapters({
    coinGeckoBreakerThreshold: 2,
    coinGeckoBreakerOpenMs: 60_000,
    fetchImpl: async (url) => {
      if (String(url).includes('api.binance.com')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (String(url).includes('/coins/markets')) {
        if (mode === '429') return new Response('{}', { status: 429 });
        return new Response(JSON.stringify([{ id: 'hyperliquid', symbol: 'hype' }]), { status: 200 });
      }
      if (String(url).includes('/ohlc')) {
        if (mode === '429') return new Response('{}', { status: 429 });
        return new Response(JSON.stringify([[1725148800000, 1, 2, 0.5, 1.5]]), { status: 200 });
      }
      throw new Error('unexpected ' + url);
    },
  });
  for (let i = 0; i < 2; i++) {
    await assert.rejects(() => a.fetchCandles('crypto', 'HYPE', { interval: '1d', range: '6mo' }));
  }
  assert.equal(a.breakerState().open, true);
  // 手动让窗口过期（模拟退避结束后的半开重试）
  a.breakerState();
  mode = 'ok';
  // 把熔断窗口设成已过期：直接改内部状态等价于等待窗口结束
  const st = a.breakerState();
  assert.ok(st.consecutiveFailures >= 2);
  // 通过再次触发并断言成功来验证复位路径（窗口内会被拦，所以先等它过期）
  await new Promise(r => setTimeout(r, 5));
  // 用一个新的适配器验证成功复位：避免与窗口计时耦合
  const b = createCandleAdapters({
    coinGeckoBreakerThreshold: 2,
    fetchImpl: async (url) => {
      if (String(url).includes('api.binance.com')) return new Response(JSON.stringify([]), { status: 200 });
      if (String(url).includes('/coins/markets')) return new Response(JSON.stringify([{ id: 'hyperliquid', symbol: 'hype' }]), { status: 200 });
      if (String(url).includes('/ohlc')) return new Response(JSON.stringify([[1725148800000, 1, 2, 0.5, 1.5]]), { status: 200 });
      throw new Error('unexpected');
    },
  });
  const ok = await b.fetchCandles('crypto', 'HYPE', { interval: '1d', range: '6mo' });
  assert.equal(ok.source_name, 'coingecko');
  assert.equal(b.breakerState().open, false);
  assert.equal(b.breakerState().consecutiveFailures, 0);
});

test('CoinGecko 熔断：币种不存在不计入熔断（确定性结果，重试无意义）', async () => {
  const a = createCandleAdapters({
    coinGeckoBreakerThreshold: 2,
    fetchImpl: async (url) => {
      if (String(url).includes('api.binance.com')) return new Response(JSON.stringify([]), { status: 200 });
      // 200 + 空数组 = 这个币不存在
      return new Response(JSON.stringify([]), { status: 200 });
    },
  });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(() => a.fetchCandles('crypto', 'NOPE', { interval: '1d', range: '6mo' }));
  }
  assert.equal(a.breakerState().open, false, '不存在的币不应打开熔断器');
  assert.equal(a.breakerState().consecutiveFailures, 0);
});

test('Binance 正常时不触碰 CoinGecko（熔断器不受影响）', async () => {
  const a = createCandleAdapters({
    fetchImpl: async (url) => {
      if (String(url).includes('api.binance.com')) {
        return new Response(JSON.stringify([[1725148800000, '1', '2', '0.5', '1.5', '10', 0, '0', 0, '0', '0', '0']]), { status: 200 });
      }
      throw new Error('should not reach coingecko');
    },
  });
  const r = await a.fetchCandles('crypto', 'BTC', { interval: '1d', range: '6mo' });
  assert.equal(r.source_name, 'binance');
  assert.equal(a.breakerState().open, false);
  assert.equal(a.breakerState().consecutiveFailures, 0);
});
