// 行情适配器：从 MyInfo lib/investmentPrices.js 迁出并由 Invest 独立维护。
// 降级链（契约 docs/api-contract.md）：
//   us/a_share/index → Yahoo Chart（us 市值补 Nasdaq）
//   hk → Yahoo Chart（市值补 TradingView，HKD）
//   crypto → Binance Spot 日线（市值补 CoinGecko）；不在 Binance Spot（如 HYPE）整体回退 CoinGecko
// 缺失字段一律 null，绝不编 0。fetchImpl 可注入以便测试。
import { config } from '../config.js';

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const NASDAQ_SUMMARY_BASE = 'https://api.nasdaq.com/api/quote';
const TRADINGVIEW_SCANNER_BASE = 'https://scanner.tradingview.com';

function roundUsd(value) {
  return value >= 1000 ? Math.round(value * 100) / 100 : Math.round(value * 10000) / 10000;
}

export function createQuoteAdapters(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || config.requestTimeoutMs;
  let dispatcher = null; // undici ProxyAgent，仅配置了代理时创建

  async function getDispatcher() {
    if (dispatcher) return dispatcher;
    if (!config.proxyUrl) return undefined;
    const { ProxyAgent } = await import('undici');
    dispatcher = new ProxyAgent(config.proxyUrl);
    return dispatcher;
  }

  async function fetchJson(url, timeout = timeoutMs, headers = {}, init = {}) {
    const d = await getDispatcher();
    const resp = await fetchImpl(url, {
      dispatcher: d,
      signal: AbortSignal.timeout(timeout),
      ...init,
      headers: { accept: 'application/json', ...headers, ...(init.headers || {}) },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${hostOf(url)}`);
    return resp.json();
  }

  // ── Yahoo Finance Chart：股票 / 指数 / A股 / 港股 主行情 ──
  async function fetchYahooChart(symbol) {
    const data = await fetchJson(`${YAHOO_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1mo`);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo 无图表数据：${symbol}`);
    const meta = result.meta;
    const price = meta.regularMarketPrice ?? meta.previousClose;
    if (price == null || !Number.isFinite(price) || price <= 0) {
      throw new Error(`Yahoo 价格无效：${symbol}`);
    }
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const valid = closes.filter(c => c != null && Number.isFinite(c) && c > 0);
    let chg_pct = null;
    if (meta.previousClose > 0) {
      chg_pct = (price - meta.previousClose) / meta.previousClose * 100;
    } else if (valid.length >= 2) {
      const lastC = valid[valid.length - 1];
      const prevC = valid[valid.length - 2];
      chg_pct = prevC > 0 ? (lastC - prevC) / prevC * 100 : null;
    }
    // 盘中用现价当“最新”；周=约 5 个交易日前，月=区间首个有效收盘
    const weekClose = valid.length ? valid[Math.max(0, valid.length - 6)] : null;
    const monthClose = valid.length ? valid[0] : null;

    // ── 盘前 / 盘后（仅美股有） ──
    // Yahoo Chart 的 meta 里：
    //   regularMarketPrice = 上一个「正常时段」的收盘价
    //   fulldayPrice       = 含盘前/盘后的最新价
    //   hasPrePostMarketData = 该交易所是否提供扩展时段数据（港股为 false）
    // 用户要求涨跌基准用「上一日收盘价」，也就是 regularMarketPrice，
    // **不使用 Yahoo 的 fulldayChangePercent** —— 实测它用的是 chartPreviousClose
    // （再前一日收盘），与我们要求的基准不同，直接用会算出不一致的数字。
    const ext = extendedHours(meta);

    return {
      price: Math.round(price * 100) / 100,
      price_currency: meta.currency || null,
      chg_pct,
      week_pct: weekClose ? (price - weekClose) / weekClose * 100 : null,
      month_pct: monthClose ? (price - monthClose) / monthClose * 100 : null,
      name: meta.longName || meta.shortName || null,
      market_cap: Number.isFinite(meta.marketCap) ? meta.marketCap : null,
      market_cap_currency: meta.marketCap != null ? (meta.currency || null) : null,
      source_name: 'yahoo',
      // 没有扩展时段数据时为 null（港股、指数等）—— 缺失一律 null，不编 0
      pre_price: ext.price,
      pre_chg_pct: ext.chgPct,
      pre_session: ext.session,          // 'pre' | 'post' | null
    };
  }

  // 从 chart meta 里提取盘前/盘后价与涨跌幅（基准＝上一日收盘）。
  // 返回 { price, chgPct, session }，任一项不满足就整体为 null。
  function extendedHours(meta) {
    if (!meta || meta.hasPrePostMarketData !== true) return { price: null, chgPct: null, session: null };
    const fullday = numOrNull(meta.fulldayPrice);
    const regular = numOrNull(meta.regularMarketPrice);
    if (fullday == null || regular == null || fullday <= 0 || regular <= 0) {
      return { price: null, chgPct: null, session: null };
    }
    // 当前处于哪个时段？用来给前端标注「盘前」还是「盘后」。
    const session = sessionNow(meta.currentTradingPeriod);
    if (!session) return { price: null, chgPct: null, session: null };
    // 扩展时段价格与常规收盘相同 → 说明没有真实盘前/盘后成交，不展示（避免显示 0.00%）
    if (Math.abs(fullday - regular) < 1e-9) return { price: null, chgPct: null, session: null };
    const chgPct = (fullday - regular) / regular * 100;
    return {
      price: Math.round(fullday * 100) / 100,
      chgPct,
      session,
    };
  }

  // 用 currentTradingPeriod 判断此刻在 pre / regular / post 哪一段。
  // 不在 pre/post 时返回 null（正常时段没有「盘前盘后」可展示）。
  function sessionNow(period) {
    if (!period) return null;
    const now = Math.floor(Date.now() / 1000);
    for (const key of ['pre', 'post']) {
      const p = period[key];
      if (p && Number.isFinite(p.start) && Number.isFinite(p.end)
        && now >= p.start && now < p.end) {
        return key;
      }
    }
    return null;
  }

  function numOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async function fetchNasdaqMarketCap(symbol) {
    const data = await fetchJson(
      `${NASDAQ_SUMMARY_BASE}/${encodeURIComponent(symbol)}/summary?assetclass=stocks`,
      timeoutMs,
      { 'user-agent': 'Mozilla/5.0' }
    );
    return parseNasdaqCap(data?.data?.summaryData?.MarketCap?.value);
  }

  async function fetchHongKongMarketCap(symbol) {
    const code = symbol.replace(/\.HK$/, '').replace(/^0+/, '') || '0';
    const data = await fetchJson(
      `${TRADINGVIEW_SCANNER_BASE}/hongkong/scan`,
      timeoutMs,
      { 'content-type': 'application/json', origin: 'https://www.tradingview.com', 'user-agent': 'Mozilla/5.0' },
      {
        method: 'POST',
        body: JSON.stringify({
          filter: [],
          options: { lang: 'en' },
          symbols: { query: { types: [] }, tickers: [`HKEX:${code}`] },
          columns: ['name', 'market_cap_basic'],
        }),
      }
    );
    const value = Number(data?.data?.[0]?.d?.[1]);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  // ── CoinGecko：加密货币市值榜（250 名缓存 10 分钟，整批共用避免限流） ──
  let cryptoMarkets = new Map();
  let cryptoMarketsFetchedAt = 0;
  let cryptoMarketsRequest = null;

  async function warmCryptoMarkets() {
    if (Date.now() - cryptoMarketsFetchedAt < 10 * 60 * 1000 && cryptoMarkets.size) return;
    if (!cryptoMarketsRequest) {
      cryptoMarketsRequest = fetchJson(
        `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false`
      ).then(data => {
        cryptoMarkets = new Map(
          (Array.isArray(data) ? data : []).map(m => [String(m.symbol || '').toUpperCase(), m])
        );
        cryptoMarketsFetchedAt = Date.now();
      }).finally(() => { cryptoMarketsRequest = null; });
    }
    await cryptoMarketsRequest;
  }

  async function fetchCoinGeckoMarket(symbol) {
    const base = symbol.replace(/USDT$/, '').toUpperCase();
    await warmCryptoMarkets();
    if (cryptoMarkets.has(base)) return cryptoMarkets.get(base);
    const data = await fetchJson(
      `${COINGECKO_BASE}/coins/markets?vs_currency=usd&symbols=${encodeURIComponent(base.toLowerCase())}&order=market_cap_desc&per_page=1&page=1&sparkline=false`
    );
    return Array.isArray(data) && data.length ? data[0] : null;
  }

  async function fetchCoinGeckoCryptoQuote(symbol) {
    const market = await fetchCoinGeckoMarket(symbol);
    if (!market?.id || !Number.isFinite(Number(market.current_price))) {
      throw new Error(`CoinGecko 无该币种数据：${symbol}`);
    }
    let week_pct = null;
    let month_pct = null;
    try {
      const history = await fetchJson(
        `${COINGECKO_BASE}/coins/${encodeURIComponent(market.id)}/market_chart?vs_currency=usd&days=31&interval=daily`
      );
      const prices = (history?.prices || []).map(r => Number(r?.[1])).filter(v => Number.isFinite(v) && v > 0);
      const current = Number(market.current_price);
      const weekAgo = prices[Math.max(0, prices.length - 8)];
      const monthAgo = prices[0];
      week_pct = weekAgo ? (current - weekAgo) / weekAgo * 100 : null;
      month_pct = monthAgo ? (current - monthAgo) / monthAgo * 100 : null;
    } catch { /* 现价和市值仍可用 */ }
    const marketCap = Number(market.market_cap);
    return {
      price: roundUsd(Number(market.current_price)),
      price_currency: 'USD',
      chg_pct: Number.isFinite(Number(market.price_change_percentage_24h))
        ? Number(market.price_change_percentage_24h) : null,
      week_pct,
      month_pct,
      name: market.name || null,
      market_cap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
      market_cap_currency: 'USD',
      source_name: 'coingecko',
    };
  }

  async function fetchBinanceCryptoQuote(base) {
    const pair = `${base}USDT`;
    const data = await fetchJson(`${BINANCE_BASE}/klines?symbol=${pair}&interval=1d&limit=31`);
    if (!Array.isArray(data) || data.length < 2) throw new Error(`Binance K 线无效：${pair}`);
    const last = parseFloat(data[data.length - 1][4]);
    const prev = parseFloat(data[data.length - 2][4]);
    const weekAgo = parseFloat(data[Math.max(0, data.length - 8)][4]);
    const monthAgo = parseFloat(data[0][4]);
    if (!Number.isFinite(last) || last <= 0) throw new Error(`Binance 价格无效：${pair}`);
    const quote = {
      price: roundUsd(last),
      price_currency: 'USDT',
      chg_pct: prev > 0 ? (last - prev) / prev * 100 : null,
      week_pct: weekAgo > 0 ? (last - weekAgo) / weekAgo * 100 : null,
      month_pct: monthAgo > 0 ? (last - monthAgo) / monthAgo * 100 : null,
      name: null,
      market_cap: null,
      market_cap_currency: 'USD',
      source_name: 'binance',
    };
    try {
      const market = await fetchCoinGeckoMarket(base);
      const marketCap = Number(market?.market_cap);
      quote.market_cap = Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null;
    } catch { /* 市值是可选补充 */ }
    return quote;
  }

  // 主入口：fetchWatchlistQuote(category, normalizedSymbol) → 契约中的行情对象
  async function fetchWatchlistQuote(category, normalizedSymbol) {
    if (!normalizedSymbol) throw new Error('空代码');
    if (category === 'crypto') {
      try {
        return await fetchBinanceCryptoQuote(normalizedSymbol);
      } catch {
        // HYPE 等不在 Binance Spot 的币种整体回退 CoinGecko
        return fetchCoinGeckoCryptoQuote(normalizedSymbol);
      }
    }
    const quote = await fetchYahooChart(normalizedSymbol);
    if (category === 'us' && quote.market_cap == null) {
      try {
        quote.market_cap = await fetchNasdaqMarketCap(normalizedSymbol);
        quote.market_cap_currency = quote.market_cap != null ? 'USD' : null;
      } catch { /* 可选补充 */ }
    }
    if (category === 'hk' && quote.market_cap == null) {
      try {
        quote.market_cap = await fetchHongKongMarketCap(normalizedSymbol);
        quote.market_cap_currency = quote.market_cap != null ? 'HKD' : null;
      } catch { /* 可选补充 */ }
    }
    return quote;
  }

  return { fetchWatchlistQuote, fetchYahooChart, fetchBinanceCryptoQuote, fetchCoinGeckoCryptoQuote,
    fetchNasdaqMarketCap, fetchHongKongMarketCap, fetchCoinGeckoMarket };
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Nasdaq MarketCap.value 可能是裸数字串（"3419500000000.00"）或带后缀（"$3.42T"）
export function parseNasdaqCap(raw) {
  const m = String(raw ?? '').trim().match(/([\d.,]+)\s*([KMBT])?\s*$/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || '').toUpperCase()] ?? 1;
  return n * mult;
}
