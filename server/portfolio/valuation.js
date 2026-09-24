// 估值：把配置 + 持仓报价 + 汇率组装成总额与分组汇总。
//
// 最重要的一条规则：**缺失行情或缺失汇率时 value 必须是 null**，
// 不能用 0 或示例价冒充。用 0 会静默把总额算小，用户看不出少算了什么；
// null + unpriced_reason 才能让页面明确说「这是已估值部分」。
import { toBaseCurrency, BASE_CURRENCY } from './fx.js';
import { listChannels, listAssetTypes, listHoldings, getPreferences } from './config.js';

function round2(n) { return Math.round(n * 100) / 100; }

// 一个持仓 → 估值行。缺任何一环都返回 valued=false + 原因。
export function valueHolding(holding, quote, rates) {
  const base = {
    ...holding,
    price: null, price_currency: null,
    value: null, valued: false, unpriced_reason: null,
    chg_pct: null, week_pct: null, month_pct: null,
  };
  if (!quote || quote.status !== 'ok' || !Number.isFinite(quote.price) || quote.price <= 0) {
    return { ...base, unpriced_reason: 'missing_quote' };
  }
  const cur = quote.price_currency || null;
  if (!cur) {
    // 有价格但不知道币种 → 无法折算，同样不可估值（不猜 USD）
    return { ...base, price: quote.price, unpriced_reason: 'missing_fx' };
  }
  const gross = quote.price * holding.quantity;
  const inUsd = toBaseCurrency(gross, cur, rates);
  if (inUsd === null) {
    // 保留原币单价与币种，让用户看得出「是汇率缺了」而不是「没行情」
    return {
      ...base,
      price: quote.price, price_currency: cur,
      chg_pct: quote.chg_pct ?? null,
      week_pct: quote.week_pct ?? null,
      month_pct: quote.month_pct ?? null,
      unpriced_reason: 'missing_fx',
    };
  }
  return {
    ...base,
    price: quote.price,
    price_currency: cur,
    value: inUsd,
    valued: true,
    unpriced_reason: null,
    chg_pct: quote.chg_pct ?? null,
    week_pct: quote.week_pct ?? null,
    month_pct: quote.month_pct ?? null,
  };
}

// 按市值加权算组合当日涨跌。**分母只含「已估值且有 chg_pct」的仓位**，
// 一个可参与项都没有时返回 null（前端显示 —，而不是 0.00%）。
export function weightedChange(rows) {
  let sumW = 0, sum = 0;
  for (const r of rows) {
    if (!r.valued || !Number.isFinite(r.value) || !Number.isFinite(r.chg_pct)) continue;
    sumW += r.value;
    sum += r.value * r.chg_pct;
  }
  if (sumW <= 0) return null;
  return sum / sumW;
}

// 同一标的多渠道合并的键。合并口径必须带 quote_category：
// 不同分类下同名代码是不同的东西（A股 000001 与港股 00001 无关）。
function mergeKey(r) { return `${r.quote_category}|${r.normalized_symbol}`; }

// 按类型汇总：跨渠道合并同一标的（数量与市值相加）
export function groupByType(rows, assetTypes, total) {
  const byType = new Map();
  for (const t of assetTypes) {
    byType.set(t.id, { id: t.id, name: t.name, color: t.color, value: 0, unpriced_count: 0, _merged: new Map() });
  }
  const unassigned = [];
  for (const r of rows) {
    const g = byType.get(r.asset_type_id);
    if (!g) { unassigned.push(r); continue; }
    if (!r.valued) { g.unpriced_count++; continue; }
    const k = mergeKey(r);
    const prev = g._merged.get(k);
    if (prev) {
      // 跨渠道合并：数量与市值相加，并记下都来自哪些渠道
      // （否则 UI 无法说明「这一行是 3 个渠道加起来的」）
      prev.quantity += r.quantity;
      prev.value += r.value;
      if (!prev.channels.includes(r.channel_id)) prev.channels.push(r.channel_id);
      if (!prev.channel_names.includes(r.channel_name)) prev.channel_names.push(r.channel_name);
    } else {
      g._merged.set(k, {
        quote_category: r.quote_category,
        normalized_symbol: r.normalized_symbol,
        symbol: r.symbol,
        quantity: r.quantity,
        value: r.value,
        chg_pct: r.chg_pct,
        channels: [r.channel_id],
        channel_names: [r.channel_name],
      });
    }
  }
  const out = [];
  for (const g of byType.values()) {
    const items = [...g._merged.values()];
    if (items.length === 0 && g.unpriced_count === 0) continue;
    // ⚠️ 组合计必须由**合并后的 items** 求和，不能用 g.value。
    // 跨渠道合并时金额记在 _merged 里，g.value 始终是 0 —— 曾因此让组头显示 $0
    // 而组内明细却有金额。
    const groupValue = items.reduce((s, it) => s + it.value, 0);
    out.push({
      id: g.id, name: g.name, color: g.color,
      value: round2(groupValue),
      share: total > 0 ? groupValue / total : 0,
      unpriced_count: g.unpriced_count,
      items: items.sort((a, b) => b.value - a.value),
    });
  }
  return { groups: out.sort((a, b) => b.value - a.value), unassigned };
}

// 按渠道汇总：**只合并同一渠道内**的相同标的，不跨渠道混算
export function groupByChannel(rows, channels, total) {
  const byCh = new Map();
  for (const c of channels) {
    byCh.set(c.id, { id: c.id, name: c.name, color: c.color, value: 0, unpriced_count: 0 });
  }
  for (const r of rows) {
    const g = byCh.get(r.channel_id);
    if (!g) continue;
    if (!r.valued) { g.unpriced_count++; continue; }
    g.value += r.value;
  }
  return [...byCh.values()]
    .filter(g => g.value > 0 || g.unpriced_count > 0)
    .map(g => ({
      id: g.id, name: g.name, color: g.color,
      value: round2(g.value),
      share: total > 0 ? g.value / total : 0,
      unpriced_count: g.unpriced_count,
    }))
    .sort((a, b) => b.value - a.value);
}

// 完整估值。quotes 是 portfolio_quotes 的快照（Map 或数组都接受）。
export function buildValuation(db, { quotes, fx }) {
  const prefs = getPreferences(db);
  const channels = listChannels(db);
  const assetTypes = listAssetTypes(db);
  const holdings = listHoldings(db);

  const qmap = quotes instanceof Map ? quotes : new Map(
    (quotes || []).map(q => [`${q.quote_category}|${q.normalized_symbol}`, q])
  );
  const rates = fx?.rates || { USD: 1, USDT: 1 };

  const chNames = new Map(channels.map(c => [c.id, c.name]));
  const tyNames = new Map(assetTypes.map(t => [t.id, t.name]));

  const positions = holdings.map(h => {
    const q = qmap.get(`${h.quote_category}|${h.normalized_symbol}`);
    const v = valueHolding(h, q, rates);
    return {
      id: v.id,
      channel_id: v.channel_id,
      channel_name: chNames.get(v.channel_id) || v.channel_id,
      asset_type_id: v.asset_type_id,
      asset_type_name: tyNames.get(v.asset_type_id) || v.asset_type_id,
      symbol: v.symbol,
      quote_category: v.quote_category,
      normalized_symbol: v.normalized_symbol,
      quantity: v.quantity,
      price: v.price,
      price_currency: v.price_currency,
      value: v.value === null ? null : round2(v.value),
      chg_pct: v.chg_pct,
      week_pct: v.week_pct,
      month_pct: v.month_pct,
      valued: v.valued,
      unpriced_reason: v.unpriced_reason,
    };
  });

  const valuedRows = positions.filter(p => p.valued);
  const total = valuedRows.reduce((s, p) => s + p.value, 0);
  const unpricedCount = positions.length - valuedRows.length;
  const chg = weightedChange(positions);

  const rate = prefs.usd_cny_rate;
  const toDisplay = (usd) => {
    if (usd === null) return null;
    if (prefs.display_currency === 'CNY') {
      return Number.isFinite(rate) && rate > 0 ? round2(usd * rate) : null;
    }
    return round2(usd);
  };

  const { groups: byType } = groupByType(positions, assetTypes, total);
  const byChannel = groupByChannel(positions, channels, total);

  // 只列出实际用到的币种，便于前端解释「这行为什么不可估值」
  const usedCurrencies = [...new Set(positions.map(p => p.price_currency).filter(Boolean))];

  return {
    currency: BASE_CURRENCY,
    display_currency: prefs.display_currency,
    usd_cny_rate: rate,
    total: round2(total),
    total_display: toDisplay(total),
    chg_pct: chg === null ? null : round2(chg),
    valued_count: valuedRows.length,
    unpriced_count: unpricedCount,
    position_count: positions.length,
    positions: positions.map(p => ({ ...p, value_display: toDisplay(p.value) })),
    by_type: byType,
    by_channel: byChannel,
    fx,
    fx_rates_used: usedCurrencies,
    // 有持仓但汇率缺了对应币种时，明确告诉前端是哪几种
    missing_fx_currencies: [...new Set(
      positions.filter(p => p.unpriced_reason === 'missing_fx' && p.price_currency)
        .map(p => p.price_currency)
    )],
  };
}
