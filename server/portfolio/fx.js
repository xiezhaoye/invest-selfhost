// 外汇换算：把各币种报价折算成估值基准币种 USD。
//
// 约定（契约 docs/api-contract.md「估值语义」）：
//   - base 恒为 USD。
//   - **USD 与 USDT 按 1:1**，不查汇率（稳定币按面值处理，这是用户确认的口径）。
//   - **HKD / CNY 必须查真实汇率**，拿不到就让该行不可估值 —— 绝不假设 1:1。
//     真实数据里存在港币持仓，若按 1:1 折算会把总额虚高约 7.8 倍。
//   - rates 的方向统一为「1 单位该币种 = 多少 USD」，避免乘除方向搞反。
//
// 汇率本身也走缓存：汇率变动慢，没必要每次估值都打上游。
import { config } from '../config.js';

export const BASE_CURRENCY = 'USD';
// 按面值 1:1 处理的币种。USDT 之外若将来接入 USDC 等稳定币，加到这里。
const PEGGED_TO_USD = new Set(['USD', 'USDT']);

// 需要查汇率的币种 → Yahoo 的货币对代码。
//
// ⚠️ Yahoo 用的是 `XXX=X` 形式（如 HKD=X），**不是** `USDHKD`。
// 实测 `USDHKD` / `USDCNY` 返回 404 "No data found, symbol may be delisted"，
// 曾因此让 HKD/CNY 汇率永远拿不到、港股/A股持仓全部不可估值。
// 响应里的 regularMarketPrice 是「1 USD = x 该币种」，取倒数才是「1 单位该币种 = 多少 USD」。
const FX_PAIRS = {
  HKD: 'HKD=X',
  CNY: 'CNY=X',
};

export function createFxService({
  fetchImpl,
  // 汇率缓存：默认 6 小时。汇率变动极慢（实测见 config.js 的注释），
  // 频繁刷新只会白打上游；过期时走的又是 SWR，用户不会因此等待。
  cacheMs = 6 * 60 * 60 * 1000,
  timeoutMs = config.requestTimeoutMs,
  now = () => Date.now(),
  // 可注入：不依赖真实网络即可测「拿不到汇率」的分支
  fetchRateImpl = null,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  let cache = null;              // { rates, as_of, source, error, fetchedAt }
  let inflight = null;

  // 查单个货币对：返回「1 单位该币种 = 多少 USD」
  async function fetchRate(currency) {
    if (fetchRateImpl) return fetchRateImpl(currency);
    const pair = FX_PAIRS[currency];
    if (!pair) return null;
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(pair)}?interval=1d&range=5d`;
    const { ProxyAgent } = config.proxyUrl ? await import('undici') : { ProxyAgent: null };
    const dispatcher = ProxyAgent ? new ProxyAgent(config.proxyUrl) : undefined;
    const resp = await doFetch(url, {
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from Yahoo FX`);
    const data = await resp.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const rate = Number(meta?.regularMarketPrice);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error(`${pair} 汇率无效`);
    // HKD=X 的 regularMarketPrice = 1 USD 换多少 HKD → 取倒数才是「1 HKD = 多少 USD」
    return 1 / rate;
  }

  // 拉取全部需要的汇率。任一币种失败不影响其它币种，但会记录在 error 里。
  async function refresh() {
    const rates = {};
    for (const cur of PEGGED_TO_USD) rates[cur] = 1;   // USD / USDT 面值
    const failed = [];
    // HKD/CNY 是彼此独立的上游请求；冷启动时并行获取，避免等待时间相加。
    await Promise.all(Object.keys(FX_PAIRS).map(async cur => {
      try {
        const r = await fetchRate(cur);
        if (r === null) { failed.push(cur); return; }
        rates[cur] = r;
      } catch (e) {
        failed.push(`${cur}(${e.message})`);
      }
    }));
    // 本次没拿到的币种，**沿用上一次成功的汇率**。
    // 否则上游抖动一次就会把 HKD/CNY 抹掉，导致所有港股/A股持仓瞬间变成
    // 「暂不可估值」、总额大跌 —— 而实际只是汇率源抖了一下。
    // 注意：这不同于「编造数据」——它用的是上次真实取到的值，且会在 error 里如实说明。
    const prev = cache?.rates || {};
    for (const cur of Object.keys(FX_PAIRS)) {
      if (rates[cur] === undefined && prev[cur] !== undefined) rates[cur] = prev[cur];
    }
    const error = failed.length ? `汇率获取失败：${failed.join(', ')}` : null;
    cache = {
      rates,
      as_of: new Date(now()).toISOString(),
      source: failed.length ? 'partial' : 'yahoo',
      error,
      fetchedAt: now(),
    };
    return cache;
  }

  // 取汇率快照。force=1 跳过缓存。拿不到时返回已有的 rates（可能只有 USD/USDT）
  // 并带 error —— 估值侧据此把对应币种的仓位标为不可估值。
  // 取汇率快照。与持仓报价一样采用 stale-while-revalidate：
  // 有旧值就立刻返回、后台补拉；只有**完全没有值**时才同步等上游。
  //
  // 背景：冷启动时查 HKD/CNY 要 2.3s（两次上游），这是「资产页要转几秒」的
  // 第二个原因（第一个是持仓报价，已修）。汇率变动很慢，用旧值完全可接受，
  // 而且响应里会带 stale 标记，前端能如实提示。
  async function getRates(force = false) {
    if (!force && cache && (now() - cache.fetchedAt) < cacheMs) {
      return { ...cache, stale: false, from_cache: true, refreshing: false };
    }
    if (inflight) {
      // 已有任务在跑：有旧值就先给旧的，没有则等这次
      if (cache) return { ...cache, stale: true, from_cache: true, refreshing: true };
      return inflight;
    }
    if (!force && cache) {
      // 有过期旧值：先返回，后台刷新（不阻塞）
      refreshInBackground();
      return { ...cache, stale: true, from_cache: true, refreshing: true };
    }
    // 连旧值都没有（首次部署）：只能同步等
    const r = await startRefresh();
    return { ...r, stale: false, from_cache: false, refreshing: false };
  }

  function startRefresh() {
    inflight = refresh()
      .catch(e => {
        // 到这里说明连「逐币种失败」都没兜住（异常在 refresh 之外）。
        // 仍然遵守老规矩：绝不编造汇率；拿不到的币种就是没有，
        // 估值侧会把对应持仓标为不可估值。
        cache = {
          rates: { USD: 1, USDT: 1, ...(cache?.rates?.HKD ? { HKD: cache.rates.HKD } : {}),
                   ...(cache?.rates?.CNY ? { CNY: cache.rates.CNY } : {}) },
          as_of: new Date(now()).toISOString(),
          source: 'error',
          error: e.message || '汇率服务不可用',
          fetchedAt: now(),
        };
        return cache;
      })
      .finally(() => { inflight = null; });
    return inflight;
  }

  function refreshInBackground() {
    if (inflight) return inflight;
    Promise.resolve().then(() => {
      if (inflight) return inflight;
      return startRefresh();
    }).catch(e => console.error('[fx] background refresh failed:', e?.message || e));
    return null;
  }

  // 单个币种 → USD 汇率；拿不到返回 null（调用方据此判 value=null）
  async function rateFor(currency, force = false) {
    const cur = String(currency ?? '').trim().toUpperCase();
    if (!cur) return null;
    if (PEGGED_TO_USD.has(cur)) return 1;
    const snap = await getRates(force);
    const r = snap.rates?.[cur];
    return Number.isFinite(r) && r > 0 ? r : null;
  }

  function peek() { return cache; }

  return { getRates, rateFor, peek, refresh, refreshInBackground,
    BASE_CURRENCY, PEGGED_TO_USD: new Set(PEGGED_TO_USD), hasCache: () => !!cache };
}

// 纯函数，便于单测：金额 × 汇率 → USD；任一步不可得返回 null。
export function toBaseCurrency(amount, currency, rates) {
  const cur = String(currency ?? '').trim().toUpperCase();
  if (!Number.isFinite(amount)) return null;
  if (PEGGED_TO_USD.has(cur)) return amount;
  const r = rates?.[cur];
  if (!Number.isFinite(r) || r <= 0) return null;
  return amount * r;
}
