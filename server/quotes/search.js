// 代码模糊搜索：新增/编辑资产时给输入框做提示。
//
// 为什么不用 Yahoo：实测 Yahoo finance/search 对中文查询返回空
// （q=比亚迪 / q=腾讯 都是 0 条），而用户明确要求「输入 BYD 提示比亚迪」。
// 东方财富的 suggest 接口同时支持中文名、拼音首字母与英文代码，实测覆盖：
//   BYD    → 002594 比亚迪 / BYD 博伊德赌场 / 00285 比亚迪电子
//   比亚迪 → 002594 / 00285 / 01211
//   apple  → AAPL 苹果
//   腾讯   → 00700 腾讯控股
//
// 该接口是公开的、无需鉴权的第三方端点，所以：
//   - 只在用户输入时按需调用（不是批量预热），并对同一关键词做短时记忆避免连打；
//   - 失败/超时一律降级为「空结果」，绝不阻塞新增流程（搜索只是辅助，不是必需）；
//   - 返回的字段经过白名单裁剪，不把上游原始对象透给浏览器。
import { config } from '../config.js';

const EASTMONEY_SEARCH = 'https://searchapi.eastmoney.com/api/suggest/get';
// 公开 token（前端网页用的同一枚，非私人凭据）。缺失时接口会拒绝，所以写死在这里。
const EASTMONEY_TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';

// 东方财富的 Classify → 本项目的 category
const CLASSIFY_TO_CATEGORY = {
  AStock: 'a_share',
  HK: 'hk',
  UsStock: 'us',
  Index: 'index',
  // 其余（基金/债券/期货/外汇等）本项目不管理，直接过滤掉
};

// 关键词缓存：同一词 5 分钟内不重复打上游（输入框会边打字边查）
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 200;

export function createSearchAdapter(opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || config.requestTimeoutMs;
  let dispatcher = null;
  const cache = new Map();          // q → {at, items}

  async function getDispatcher() {
    if (dispatcher) return dispatcher;
    if (!config.proxyUrl) return undefined;
    const { ProxyAgent } = await import('undici');
    dispatcher = new ProxyAgent(config.proxyUrl);
    return dispatcher;
  }

  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
    return hit.items;
  }
  function cacheSet(key, items) {
    if (cache.size >= CACHE_MAX) {
      // 简单淘汰：删掉最早插入的一条
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    cache.set(key, { at: Date.now(), items });
  }

  // 主入口：返回 [{ symbol, name, category, exchange, normalized_symbol }]
  // normalized_symbol 直接按本项目规则给出，避免前端再猜一遍
  async function search(query, { limit = 8 } = {}) {
    const q = String(query || '').trim();
    if (q.length < 1) return [];
    const key = q.toLowerCase();
    const cached = cacheGet(key);
    if (cached) return cached.slice(0, limit);

    const url = `${EASTMONEY_SEARCH}?input=${encodeURIComponent(q)}`
      + `&type=14&token=${EASTMONEY_TOKEN}&count=${Math.min(20, Math.max(limit * 2, 10))}`;
    const d = await getDispatcher();
    const resp = await fetchImpl(url, {
      dispatcher: d,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from searchapi.eastmoney.com`);
    const data = await resp.json();

    const items = [];
    const seen = new Set();
    for (const r of (data?.QuotationCodeTable?.Data || [])) {
      const category = CLASSIFY_TO_CATEGORY[r?.Classify];
      if (!category) continue;                       // 基金/债券/期货等不纳入
      // 美股里会混进「Apple Inc Notes 2022」这类债券/票据（SecurityType=7 / TypeUS=6），
      // 它们不可交易也不是用户想加的标的。只保留普通股/ETF（SecurityType=20）。
      if (category === 'us' && String(r?.SecurityType || '') !== '20') continue;
      const symbol = String(r?.Code || '').trim();
      const name = String(r?.Name || '').trim();
      if (!symbol || !name) continue;
      // 过滤掉同一市场同一代码的重复项
      const dedupe = `${category}:${symbol}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      items.push({
        symbol,
        name,
        category,
        exchange: String(r?.SecurityTypeName || '').trim() || null,
        normalized_symbol: normalizeSearchSymbol(category, symbol),
      });
      if (items.length >= limit) break;
    }
    cacheSet(key, items);
    return items;
  }

  return { search, _cacheSize: () => cache.size };
}

// 把搜索结果里的代码转成本项目 normalize 之后的形态。
// 注意：这里只是「提示用的展示值」，真正落库仍走 assets.createAsset → validateAndNormalize，
// 由它做最终校验；两处规则必须一致，否则用户点选后会报错。
export function normalizeSearchSymbol(category, symbol) {
  const s = String(symbol || '').trim().toUpperCase();
  if (category === 'hk') {
    const digits = s.replace(/\D/g, '');
    return digits ? `${digits.padStart(4, '0').slice(-4)}.HK` : s;
  }
  // A股：与 server/normalize.js 保持一致 —— 6/9 开头是上交所(.SS)，其余深交所(.SZ)。
  // 两处必须同规则，否则用户「点选后保存」拿到的代码与提示里显示的不是同一个。
  if (category === 'a_share') return `${s}.${/^[69]/.test(s) ? 'SS' : 'SZ'}`;
  if (category === 'index') return s.startsWith('^') ? s : `^${s}`;
  return s;
}

// 搜索结果是「原始代码」，而本项目 A股/港股要存原始数字（由 normalize 补后缀）。
// 这里给出「适合回填到输入框」的写法，与 validateAndNormalize 的输入要求对齐。
export function inputSymbolFor(item) {
  if (!item) return '';
  if (item.category === 'hk') {
    const digits = String(item.symbol).replace(/\D/g, '');
    return digits.replace(/^0+/, '') || digits;       // 用户习惯输 700 / 2015，不带前导零
  }
  return String(item.symbol);
}
