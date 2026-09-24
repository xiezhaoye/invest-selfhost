// K 线适配器：按分类从上游取 OHLCV，标准化为契约里的 candle 形状。
// 降级链（docs/api-contract.md）：
//   us / hk / a_share / index → Yahoo Chart（按请求周期直接取 OHLC）
//   crypto（Binance 有该交易对）→ Binance Spot Klines
//   crypto（Binance 无该交易对，如 HYPE）→ CoinGecko OHLC
//
// 铁律：绝不拿 close 序列伪造 OHLC。上游只给收盘价时，宁可返回空数组并说明，
// 也不拼出一组假的高低开。缺失的 volume 一律 null，不编 0。
import { config } from '../config.js';

const BINANCE_BASE = 'https://api.binance.com/api/v3';
const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

// 允许的周期与范围（白名单：浏览器传什么都不原样透传给上游）
export const INTERVALS = ['1d', '1w', '1M'];

// 前端首版默认范围：日线 6 个月、周线 3 年、月线 10 年。
// range 与 interval 的合法组合写死在这里，不做任意拼接。
// 每个周期两档：
//   - 默认档：首屏 50 根所需的量，够快够小
//   - deep 档：前端放大到最多 150 根时才请求（2026-09-21 前端支持联动缩放后新增）
// 实测各档实际根数（AAPL / BTC）见 交接.md 的 K 线章节。
export const RANGES_BY_INTERVAL = {
  '1d': ['6mo', '1y', '2y'],
  '1w': ['3y', '5y', '10y'],
  '1M': ['10y', 'max'],
};

export const DEFAULT_RANGE = { '1d': '6mo', '1w': '3y', '1M': '10y' };

// 前端要看的最大根数；超过默认档能提供的量时要换成 deep 档。
// 日线 6mo ≈ 127 根 < 150，所以 150 根必然落到更长的档位。
export const MAX_VIEW_COUNT = 150;

// 给定周期与想要的根数，挑最小够用的 range（避免为看 150 根拉十年数据）
export function rangeForCount(interval, want) {
  const ranges = RANGES_BY_INTERVAL[interval] || [];
  const approxPerRange = APPROX_COUNT[interval] || {};
  for (const r of ranges) {
    if ((approxPerRange[r] || 0) >= want) return r;
  }
  return ranges[ranges.length - 1] || DEFAULT_RANGE[interval];
}

// 各 range 的近似根数（保守估计，仅用于挑档，不作为正确性依据）
const APPROX_COUNT = {
  '1d': { '6mo': 127, '1y': 251, '2y': 501 },
  '1w': { '3y': 158, '5y': 262, '10y': 523 },
  '1M': { '10y': 121, max: 169 },
};

// 各上游的周期代码并不统一（实测）：
//   Yahoo 只认 1d / 1wk / 1mo；传 1w 或 1M 会直接 400。
//   Binance 只认 1d / 1w / 1M。
// 对外契约固定用 1d|1w|1M（前端与 API），这里再按上游翻译，不把 Yahoo 的方言漏出去。
export const YAHOO_INTERVAL = { '1d': '1d', '1w': '1wk', '1M': '1mo' };
export const BINANCE_INTERVAL = { '1d': '1d', '1w': '1w', '1M': '1M' };
// Binance 没有 range 概念，只有 limit（上限 1000）。'max' 档靠 limit 拉满。
export const BINANCE_MAX_LIMIT = 1000;

// 派生的“每根 candle 覆盖多久”，用于判断最后一根是否已收盘（TTL 计算）
export const INTERVAL_MS = {
  '1d': 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
  '1M': 31 * 24 * 60 * 60 * 1000,
};

export function isValidInterval(v) {
  return INTERVALS.includes(v);
}

export function isValidRange(interval, range) {
  return (RANGES_BY_INTERVAL[interval] || []).includes(range);
}

export function createCandleAdapters(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || config.requestTimeoutMs;
  let dispatcher = null;

  // ── CoinGecko 熔断/退避 ──
  // 免费套餐很容易 429。撞上限流后继续硬打只会把窗口越撞越长，
  // 所以：连续失败达阀值就熔断一段时间，期间直接抛错（不发出网请求），
  // 让 service 走「旧缓存 + stale」降级；窗口结束后半开重试，成功即复位。
  const breaker = {
    consecutiveFailures: 0,
    openUntil: 0,
    lastError: null,
  };
  const BREAKER_THRESHOLD = opts.coinGeckoBreakerThreshold ?? 3;
  const BREAKER_OPEN_MS = opts.coinGeckoBreakerOpenMs ?? 5 * 60 * 1000;

  function breakerOpen() {
    return Date.now() < breaker.openUntil;
  }
  // 只有「限流 / 上游临时故障」才计入熔断；「这个币 CoinGecko 不认识」
  // 属于确定性结果，重试再多次也没用，不该把熔断器打开拖累其他币种。
  function breakerFail(err) {
    const msg = err?.message || String(err);
    const transient = err?.status === 429
      || /限流|429|Too Many Requests|fetch failed|timeout|abort/i.test(msg);
    if (!transient) return;
    breaker.consecutiveFailures += 1;
    breaker.lastError = msg;
    if (breaker.consecutiveFailures >= BREAKER_THRESHOLD) {
      breaker.openUntil = Date.now() + BREAKER_OPEN_MS;
    }
  }
  function breakerSucceed() {
    breaker.consecutiveFailures = 0;
    breaker.openUntil = 0;
    breaker.lastError = null;
  }

  // CoinGecko 专用取数：带熔断保护
  async function coinGeckoTry(label, fn) {
    if (breakerOpen()) {
      const waitS = Math.ceil((breaker.openUntil - Date.now()) / 1000);
      throw new Error(`CoinGecko 已熔断（${label}），约 ${waitS}s 后重试`);
    }
    try {
      const out = await fn();
      breakerSucceed();
      return out;
    } catch (err) {
      breakerFail(err);
      throw err;
    }
  }

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
    if (!resp.ok) {
      const err = new Error(`HTTP ${resp.status} from ${hostOf(url)}`);
      err.status = resp.status;   // 429 需要被熔断器识别
      throw err;
    }
    return resp.json();
  }

  // ── Yahoo Finance Chart ──
  // 一次请求同时拿 OHLC 与时间戳；indicators.quote[0] 的四个数组按下标对齐。
  // 上游对停牌/无成交的日子会在数组里塞 null，这些整根丢弃（不能补 0）。
  async function fetchYahooCandles(symbol, { interval, range }) {
    const yInterval = YAHOO_INTERVAL[interval] || '1d';
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}`
      + `?interval=${encodeURIComponent(yInterval)}&range=${encodeURIComponent(range)}`;
    const data = await fetchJson(url);
    const result = data?.chart?.result?.[0];
    if (!result) throw new Error(`Yahoo 无图表数据：${symbol}`);

    const ts = result.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const { open: opens, high: highs, low: lows, close: closes, volume: volumes } = q;

    const candles = [];
    for (let i = 0; i < ts.length; i += 1) {
      const t = ts[i];
      const o = numOrNull(opens?.[i]);
      const h = numOrNull(highs?.[i]);
      const l = numOrNull(lows?.[i]);
      const c = numOrNull(closes?.[i]);
      // 四价缺一不可 —— 缺了就整根丢弃，绝不用 close 顶替
      if (!Number.isFinite(t) || o == null || h == null || l == null || c == null) continue;
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      candles.push({
        open_time_ms: Math.trunc(t) * 1000,
        open: o, high: h, low: l, close: c,
        volume: numOrNull(volumes?.[i]),
      });
    }
    candles.sort((a, b) => a.open_time_ms - b.open_time_ms);
    return {
      candles,
      currency: result?.meta?.currency || null,
      source_name: 'yahoo',
    };
  }

  // ── Binance Spot Klines ──
  // 原生返回 OHLCV：[/** openTime, open, high, low, close, volume, closeTime */]
  // Binance 的周线/月线以周一/月初开盘，时间戳天然是 UTC，直接可用。
  async function fetchBinanceCandles(base, { interval, range }) {
    const pair = binancePair(base);
    const limit = binanceLimit(interval, range);
    const bInterval = BINANCE_INTERVAL[interval] || '1d';
    const url = `${BINANCE_BASE}/klines?symbol=${encodeURIComponent(pair)}`
      + `&interval=${encodeURIComponent(bInterval)}&limit=${limit}`;
    const data = await fetchJson(url);
    if (!Array.isArray(data) || !data.length) throw new Error(`Binance K 线为空：${pair}`);
    const candles = [];
    for (const row of data) {
      const t = Number(row?.[0]);
      const o = numOrNull(row?.[1]);
      const h = numOrNull(row?.[2]);
      const l = numOrNull(row?.[3]);
      const c = numOrNull(row?.[4]);
      const v = numOrNull(row?.[5]);
      if (!Number.isFinite(t) || o == null || h == null || l == null || c == null) continue;
      if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      candles.push({ open_time_ms: Math.trunc(t), open: o, high: h, low: l, close: c, volume: v });
    }
    candles.sort((a, b) => a.open_time_ms - b.open_time_ms);
    return { candles, currency: 'USDT', source_name: 'binance' };
  }

  // ── CoinGecko OHLC（回退源，如 HYPE）──
  // /coins/{id}/ohlc 返回 [[ts, open, high, low, close]]，不含成交量 —— volume 置 null，
  // 不编 0。粒度由 days 档位决定：1 → 30 分钟，7/14/30 → 4 小时，>30 → 4 天。
  // 免费套餐的历史深度有限：数据有多少给多少，用 limited_history 如实标注，
  // 由 service 转成响应里的受限提示 —— 而不是当成错误让整个请求失败。
  async function fetchCoinGeckoCandles(symbol, { interval }) {
    return coinGeckoTry(`ohlc:${symbol}`, async () => {
      const coinId = await resolveCoinGeckoId(symbol);
      const days = coinGeckoDays(interval);
      const url = `${COINGECKO_BASE}/coins/${encodeURIComponent(coinId)}/ohlc`
        + `?vs_currency=usd&days=${days}`;
      const data = await fetchJson(url);
      if (!Array.isArray(data) || !data.length) throw new Error(`CoinGecko OHLC 为空：${symbol}`);
      const candles = [];
      for (const row of data) {
        const t = Number(row?.[0]);
        const o = numOrNull(row?.[1]);
        const h = numOrNull(row?.[2]);
        const l = numOrNull(row?.[3]);
        const c = numOrNull(row?.[4]);
        if (!Number.isFinite(t) || o == null || h == null || l == null || c == null) continue;
        if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
        candles.push({ open_time_ms: Math.trunc(t), open: o, high: h, low: l, close: c, volume: null });
      }
      candles.sort((a, b) => a.open_time_ms - b.open_time_ms);
      return { candles, currency: 'USD', source_name: 'coingecko', limited_history: true };
    });
  }

  // symbol → CoinGecko coin id。复用与行情适配器同一套识别思路：
  // 先查市值榜（整批缓存），命中不了再按 symbol 精确查一次。
  async function resolveCoinGeckoId(symbol) {
    const base = String(symbol).replace(/USDT$/, '').toUpperCase();
    let data;
    try {
      data = await fetchJson(
        `${COINGECKO_BASE}/coins/markets?vs_currency=usd&symbols=${encodeURIComponent(base.toLowerCase())}`
        + '&order=market_cap_desc&per_page=1&page=1&sparkline=false'
      );
    } catch (err) {
      // 限流/网络错误必须原样上抛：否则会被当成「币种不存在」，
      // 既掩盖了真实原因，也让外层的熔断器统计不到限流。
      if (err?.status === 429) throw new Error(`CoinGecko 限流：${base}`);
      throw err;
    }
    if (Array.isArray(data) && data.length && data[0]?.id) return data[0].id;
    throw new Error(`CoinGecko 未识别该币种：${base}`);
  }

  // 主入口：按分类路由到对应上游，返回标准化结果。
  // 调用方（service）负责缓存与降级；这里只做一次上游尝试，失败即抛。
  async function fetchCandles(category, normalizedSymbol, { interval, range }) {
    if (category === 'crypto') {
      try {
        return await fetchBinanceCandles(normalizedSymbol, { interval, range });
      } catch (err) {
        // HYPE 等不在 Binance Spot 的币种整体回退 CoinGecko。
        // 若上游给了具体错误，保留在 message 里便于排查。
        const fallback = await fetchCoinGeckoCandles(normalizedSymbol, { interval });
        if (!fallback.candles.length) throw err;
        return fallback;
      }
    }
    return fetchYahooCandles(normalizedSymbol, { interval, range });
  }

  // breakerState 供测试与运维观察（不为观测引入额外接口）
  function breakerState() {
    return {
      open: breakerOpen(),
      consecutiveFailures: breaker.consecutiveFailures,
      openUntil: breaker.openUntil || null,
      lastError: breaker.lastError,
    };
  }

  return { fetchCandles, fetchYahooCandles, fetchBinanceCandles, fetchCoinGeckoCandles, breakerState };
}

// Binance 交易对：基础码 + USDT。已带 USDT/其他稳定币后缀的原样保留。
function binancePair(symbol) {
  const s = String(symbol).toUpperCase();
  if (/(USDT|USDC|BUSD|FDUSD|TUSD)$/.test(s)) return s;
  return `${s}USDT`;
}

// Binance limit 上限 1000；按范围换算需要的根数，留一点余量。
function binanceLimit(interval, range) {
  // 每个 range 覆盖的天数。'max' 取 Binance 能给的极限（它没有 max 档，
  // 只能靠 limit 要尽可能多；月线上限 1000 根 ≈ 83 年，实际受上市时间限制）。
  const days = { '6mo': 190, '1y': 366, '2y': 731, '3y': 1100, '5y': 1830, '10y': 3700, max: 3650 }[range] ?? 200;
  const per = { '1d': 1, '1w': 7, '1M': 31 }[interval] ?? 1;
  const need = Math.ceil(days / per) + 2;
  return Math.max(1, Math.min(1000, need));
}

// CoinGecko 的 days 档位决定粒度：1/7/14/30/90/180/365/max
function coinGeckoDays(interval) {
  if (interval === '1d') return 90;    // 4 小时粒度，约 3 个月
  if (interval === '1w') return 365;
  return 'max';
}

// 注意：不能直接用 Number(v) —— Number(null) 和 Number('') 都是 0，
// 会把「上游没给这个字段」悄悄变成真实的 0。必须先排除 null/undefined/空串。
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}
