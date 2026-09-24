// 适配器固定输入测试：mock fetch，不触网。
// 覆盖：Yahoo 解析（含 previousClose 缺失回退）、Binance K 线、CoinGecko 回退（HYPE）、
// Nasdaq/TradingView 市值补充、无效响应抛错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuoteAdapters } from '../server/quotes/adapters.js';

// 按 URL 前缀路由的 mock fetch
function mockFetch(routes) {
  return async (url) => {
    for (const [prefix, responder] of routes) {
      if (String(url).startsWith(prefix)) {
        const r = typeof responder === 'function' ? responder(String(url)) : responder;
        if (r instanceof Error) throw r;
        return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`mock: no route for ${url}`);
  };
}

function yahooChart({ price = 100, prevClose = 98, currency = 'USD', marketCap = null, name = 'Apple Inc.', closes = null }) {
  const series = closes || [90, 92, 94, 96, prevClose, price];
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: price,
          previousClose: prevClose,
          currency,
          marketCap,
          longName: name,
          shortName: name,
        },
        indicators: { quote: [{ close: series }] },
      }],
    },
  };
}

test('Yahoo：常规解析（价格/日/周/月/名称）', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({ price: 105, prevClose: 100, marketCap: 3.5e12 })],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'AAPL');
  assert.equal(q.price, 105);
  assert.equal(q.price_currency, 'USD');
  assert.equal(q.chg_pct, 5);                      // (105-100)/100
  assert.equal(q.source_name, 'yahoo');
  assert.equal(q.market_cap, 3.5e12);
  // 周 = 相对约 5 个交易日前（series[0]=90）；月 = 区间首个有效收盘
  assert.ok(Math.abs(q.week_pct - (105 - 90) / 90 * 100) < 1e-9);
  assert.ok(Math.abs(q.month_pct - (105 - 90) / 90 * 100) < 1e-9);
});

test('Yahoo：previousClose 缺失时回退 close 序列计算日涨跌', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({ price: 105, prevClose: 0, closes: [80, 100, 105] })],
  ]) });
  const q = await a.fetchWatchlistQuote('index', '^TNX');
  assert.equal(q.chg_pct, 5);                      // (105-100)/100，取次末收盘
});

test('美股：Yahoo 无市值 → Nasdaq Summary 补 USD 市值', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({ price: 105, prevClose: 100, marketCap: null })],
    ['https://api.nasdaq.com/api/quote/AAPL/summary', {
      data: { summaryData: { MarketCap: { value: '$3.42T' } } },
    }],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'AAPL');
  assert.equal(q.market_cap, 3.42e12);
  assert.equal(q.market_cap_currency, 'USD');
});

test('美股：Nasdaq 补市值失败不影响主行情', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({ price: 105, prevClose: 100, marketCap: null })],
    ['https://api.nasdaq.com', new Error('HTTP 403 from api.nasdaq.com')],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'AAPL');
  assert.equal(q.price, 105);
  assert.equal(q.market_cap, null);
});

test('港股：Yahoo 无市值 → TradingView 补 HKD 市值', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooChart({ price: 612, prevClose: 605, currency: 'HKD', marketCap: null })],
    ['https://scanner.tradingview.com/hongkong/scan', {
      data: [{ s: 'HKEX:0700', d: ['TENCENT', 5.62e12] }],
    }],
  ]) });
  const q = await a.fetchWatchlistQuote('hk', '0700.HK');
  assert.equal(q.market_cap, 5.62e12);
  assert.equal(q.market_cap_currency, 'HKD');
});

test('加密货币：Binance K 线 + CoinGecko 市值榜补市值', async () => {
  const klines = [];
  for (let i = 0; i < 30; i++) klines.push([i, 100, 100, 100, 90 + i, 0]);       // 收盘 90..119
  klines.push([30, 120, 120, 120, 120, 0]);                                       // 今日 120
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://api.binance.com/api/v3/klines', klines],
    ['https://api.coingecko.com/api/v3/coins/markets', [
      { symbol: 'btc', current_price: 120000, market_cap: 2.1e12, name: 'Bitcoin' },
    ]],
  ]) });
  const q = await a.fetchWatchlistQuote('crypto', 'BTC');
  assert.equal(q.price, 120);
  assert.equal(q.price_currency, 'USDT');
  assert.equal(q.chg_pct, (120 - 119) / 119 * 100);
  assert.equal(q.market_cap, 2.1e12);
  assert.equal(q.market_cap_currency, 'USD');
  assert.equal(q.source_name, 'binance');
});

test('加密货币：Binance 不支持（HYPE）→ 整体回退 CoinGecko', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://api.binance.com', new Error('HTTP 400 from api.binance.com')],
    ['https://api.coingecko.com/api/v3/coins/markets', [
      { id: 'hyperliquid', symbol: 'hype', current_price: 38.5, market_cap: 1.3e10, name: 'Hyperliquid',
        price_change_percentage_24h: 3.2 },
    ]],
    ['https://api.coingecko.com/api/v3/coins/hyperliquid/market_chart', {
      prices: [[0, 30], [1, 32], [2, 35], [3, 38.5]],
    }],
  ]) });
  const q = await a.fetchWatchlistQuote('crypto', 'HYPE');
  assert.equal(q.price, 38.5);
  assert.equal(q.price_currency, 'USD');
  assert.equal(q.source_name, 'coingecko');
  assert.equal(q.chg_pct, 3.2);
  assert.equal(q.market_cap, 1.3e10);
  assert.ok(q.week_pct != null);
});

test('加密货币：CoinGecko 周月历史失败仍返回现价与市值', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://api.binance.com', new Error('HTTP 400 from api.binance.com')],
    ['https://api.coingecko.com/api/v3/coins/markets', [
      { id: 'hyperliquid', symbol: 'hype', current_price: 38.5, market_cap: 1.3e10, name: 'Hyperliquid' },
    ]],
    ['https://api.coingecko.com/api/v3/coins/hyperliquid/market_chart', new Error('HTTP 429 from api.coingecko.com')],
  ]) });
  const q = await a.fetchWatchlistQuote('crypto', 'HYPE');
  assert.equal(q.price, 38.5);
  assert.equal(q.week_pct, null);
  assert.equal(q.month_pct, null);
  assert.equal(q.market_cap, 1.3e10);
});

test('Yahoo 无图表数据 → 抛错（调用方标记不可用）', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', { chart: { result: [] } }],
  ]) });
  await assert.rejects(() => a.fetchWatchlistQuote('us', 'FAKE'), /Yahoo 无图表数据/);
});

test('Yahoo 价格无效（0/null）→ 抛错', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', { chart: { result: [{ meta: {}, indicators: { quote: [{ close: [] }] } }] } }],
  ]) });
  await assert.rejects(() => a.fetchWatchlistQuote('us', 'FAKE'), /Yahoo 价格无效/);
});

// ── 盘前/盘后（2026-09-21）──
// Yahoo Chart 的 meta：regularMarketPrice = 上一时段收盘，fulldayPrice = 含扩展时段的最新价。
// 涨跌基准按用户要求用「上一日收盘」（即 regularMarketPrice），
// 不采用 Yahoo 的 fulldayChangePercent（它用的是 chartPreviousClose，基准不同）。

function yahooWithExtended({ fullday, regular, hasPre, sessionNow, currency = 'USD' }) {
  const now = Math.floor(Date.now() / 1000);
  const period = {};
  if (sessionNow === 'pre') {
    period.pre = { start: now - 60, end: now + 3600 };
    period.regular = { start: now + 3600, end: now + 7200 };
    period.post = { start: now + 7200, end: now + 10800 };
  } else if (sessionNow === 'post') {
    period.pre = { start: now - 7200, end: now - 5400 };
    period.regular = { start: now - 5400, end: now - 600 };
    period.post = { start: now - 600, end: now + 3600 };
  } else {
    period.pre = { start: now - 7200, end: now - 5400 };
    period.regular = { start: now - 600, end: now + 3600 };
    period.post = { start: now + 3600, end: now + 7200 };
  }
  return {
    chart: {
      result: [{
        meta: {
          regularMarketPrice: regular,
          fulldayPrice: fullday,
          hasPrePostMarketData: hasPre,
          currentTradingPeriod: period,
          currency,
          longName: 'Test Inc.',
          shortName: 'Test',
          previousClose: regular,
        },
        timestamp: [Math.floor(now / 86400) * 86400],
        indicators: { quote: [{ open: [regular], high: [regular], low: [regular], close: [regular], volume: [1] }] },
      }],
    },
  };
}

test('盘前：可取到价格与涨跌幅，基准用上一日收盘', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooWithExtended({
      fullday: 224.24, regular: 222.27, hasPre: true, sessionNow: 'pre',
    })],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'NVDA');
  assert.equal(q.pre_price, 224.24);
  assert.equal(q.pre_session, 'pre');
  // (224.24 - 222.27) / 222.27 * 100 = 0.8863...
  assert.ok(Math.abs(q.pre_chg_pct - 0.8864) < 0.01, `实际 ${q.pre_chg_pct}`);
});

test('盘后：session 标为 post', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooWithExtended({
      fullday: 370.5, regular: 364.27, hasPre: true, sessionNow: 'post',
    })],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'TSLA');
  assert.equal(q.pre_session, 'post');
  assert.ok(Math.abs(q.pre_chg_pct - 1.71) < 0.02);
});

test('港股：hasPrePostMarketData=false → 三项均为 null（不编 0）', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooWithExtended({
      fullday: 430, regular: 430, hasPre: false, sessionNow: 'pre',
    })],
  ]) });
  const q = await a.fetchWatchlistQuote('hk', '0700.HK');
  assert.equal(q.pre_price, null);
  assert.equal(q.pre_chg_pct, null);
  assert.equal(q.pre_session, null);
});

test('正常交易时段：没有 pre/post 时段 → 三项为 null', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooWithExtended({
      fullday: 225, regular: 222.27, hasPre: true, sessionNow: 'regular',
    })],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'NVDA');
  assert.equal(q.pre_session, null, '常规时段不应标成盘前/盘后');
  assert.equal(q.pre_price, null);
});

test('扩展时段价与收盘价相同（无成交）→ null，避免显示 0.00%', async () => {
  const a = createQuoteAdapters({ fetchImpl: mockFetch([
    ['https://query1.finance.yahoo.com', yahooWithExtended({
      fullday: 222.27, regular: 222.27, hasPre: true, sessionNow: 'pre',
    })],
  ]) });
  const q = await a.fetchWatchlistQuote('us', 'NVDA');
  assert.equal(q.pre_price, null);
  assert.equal(q.pre_chg_pct, null);
});
