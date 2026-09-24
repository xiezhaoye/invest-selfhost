// 持仓配置：渠道 / 资产类型 / 持仓 / 偏好的读写与校验。
//
// 核心约束（契约 docs/api-contract.md「PUT /api/v1/portfolio/config」）：
//   1. **先整体校验、再单事务删改**。任何一条不合法都要整体失败，
//      绝不允许留下半套渠道/类型/持仓 —— 否则用户会看到「渠道没了但持仓还在」这种破状态。
//   2. `expected_version` 不匹配返回 VERSION_CONFLICT，不静默覆盖别人的修改。
//   3. 资产类型（asset_type）是用户自己的组合分类，**不能拿它猜行情市场**：
//      quote_category 必须由客户端显式给出，服务端只校验它与 symbol 是否自洽。
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../db.js';
import { validateAndNormalize, CATEGORIES, ValidationError } from '../normalize.js';

export const MAX_HOLDINGS = 100;
export const MAX_CHANNELS = 50;
export const MAX_ASSET_TYPES = 50;
export const DEFAULT_DISPLAY_CURRENCY = 'USD';
export const DEFAULT_USD_CNY_RATE = 7.15;

// 缺 ID 时按名称派生一个稳定 ID（与 MyInfo 旧行为一致，便于迁移时无 ID 的行也能落库）。
// 同时兼容中文名称（真实数据里有「富途us」这种渠道 ID）。
export function slugify(name) {
  const s = String(name ?? '').trim();
  if (!s) return '';
  return s
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function nowIso() { return new Date().toISOString(); }

function asFinitePositive(v) {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function getVersion(db) {
  const r = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get('config_version');
  const n = Number(r?.value);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function setVersion(db, v) {
  db.prepare(`
    INSERT INTO portfolio_meta(key, value) VALUES ('config_version', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(v));
}

export function getPreference(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM portfolio_preferences WHERE key = ?').get(key);
  return r ? r.value : fallback;
}

export function getPreferences(db) {
  const rows = db.prepare('SELECT key, value FROM portfolio_preferences').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  const display = out.display_currency === 'CNY' ? 'CNY' : DEFAULT_DISPLAY_CURRENCY;
  const rate = Number(out.usd_cny_rate);
  return {
    display_currency: display,
    // 非有限数或 ≤ 0 的汇率视为未设置，回退默认值（与 MyInfo 旧语义一致）
    usd_cny_rate: Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_CNY_RATE,
  };
}

// ── 读取 ────────────────────────────────────────────────────────────────
export function listChannels(db) {
  return db.prepare('SELECT * FROM portfolio_channels ORDER BY sort_order ASC, id ASC').all()
    .map(r => ({ id: r.id, name: r.name, color: r.color ?? '', sort_order: r.sort_order }));
}

export function listAssetTypes(db) {
  return db.prepare('SELECT * FROM portfolio_asset_types ORDER BY sort_order ASC, id ASC').all()
    .map(r => ({ id: r.id, name: r.name, color: r.color ?? '', sort_order: r.sort_order }));
}

export function listHoldings(db) {
  return db.prepare('SELECT * FROM portfolio_holdings ORDER BY sort_order ASC, id ASC').all()
    .map(r => ({
      id: r.id,
      channel_id: r.channel_id,
      asset_type_id: r.asset_type_id,
      symbol: r.symbol,
      quote_category: r.quote_category,
      normalized_symbol: r.normalized_symbol,
      quantity: r.quantity,
      sort_order: r.sort_order,
    }));
}

export function getConfig(db) {
  const prefs = getPreferences(db);
  return {
    version: getVersion(db),
    base_currency: 'USD',
    display_currency: prefs.display_currency,
    usd_cny_rate: prefs.usd_cny_rate,
    channels: listChannels(db),
    asset_types: listAssetTypes(db),
    holdings: listHoldings(db),
  };
}

// 配置是否存在（用于区分「空配置」与「没配过」）。空配置是合法状态，页面显示空状态。
export function hasAnyConfig(db) {
  const c = db.prepare('SELECT COUNT(*) AS n FROM portfolio_channels').get().n;
  const t = db.prepare('SELECT COUNT(*) AS n FROM portfolio_asset_types').get().n;
  return c > 0 || t > 0;
}

// ── 校验 ────────────────────────────────────────────────────────────────
// 返回规范化后的 { channels, asset_types, holdings, display_currency, usd_cny_rate }；
// 任何不合法都抛 ValidationError（带中文提示，直接给前端用）。
export function validateConfig(body) {
  if (!body || typeof body !== 'object') throw new ValidationError('请求体必须是对象');

  const rawChannels = body.channels ?? [];
  const rawTypes = body.asset_types ?? [];
  const rawHoldings = body.holdings ?? [];
  if (!Array.isArray(rawChannels)) throw new ValidationError('channels 必须是数组');
  if (!Array.isArray(rawTypes)) throw new ValidationError('asset_types 必须是数组');
  if (!Array.isArray(rawHoldings)) throw new ValidationError('holdings 必须是数组');

  if (rawTypes.length === 0) throw new ValidationError('至少保留一个资产类型');
  if (rawChannels.length > MAX_CHANNELS) throw new ValidationError(`渠道最多 ${MAX_CHANNELS} 个`);
  if (rawTypes.length > MAX_ASSET_TYPES) throw new ValidationError(`资产类型最多 ${MAX_ASSET_TYPES} 个`);
  if (rawHoldings.length > MAX_HOLDINGS) throw new ValidationError(`持仓最多 ${MAX_HOLDINGS} 条`);

  const channels = [];
  const chIds = new Set();
  const chNames = new Set();
  for (const [i, c] of rawChannels.entries()) {
    const name = String(c?.name ?? '').trim();
    if (!name) throw new ValidationError(`第 ${i + 1} 个渠道缺少名称`);
    const id = String(c?.id ?? '').trim() || slugify(name);
    if (!id) throw new ValidationError(`渠道「${name}」无法生成有效 ID`);
    if (chIds.has(id)) throw new ValidationError(`渠道 ID 重复：${id}`);
    // 名称重复会让用户在配置界面里分不清两行，直接拒绝
    if (chNames.has(name)) throw new ValidationError(`渠道名称重复：${name}`);
    chIds.add(id);
    chNames.add(name);
    channels.push({ id, name, color: String(c?.color ?? ''), sort_order: i });
  }

  const asset_types = [];
  const tyIds = new Set();
  const tyNames = new Set();
  for (const [i, t] of rawTypes.entries()) {
    const name = String(t?.name ?? '').trim();
    if (!name) throw new ValidationError(`第 ${i + 1} 个资产类型缺少名称`);
    const id = String(t?.id ?? '').trim() || slugify(name);
    if (!id) throw new ValidationError(`资产类型「${name}」无法生成有效 ID`);
    if (tyIds.has(id)) throw new ValidationError(`资产类型 ID 重复：${id}`);
    if (tyNames.has(name)) throw new ValidationError(`资产类型名称重复：${name}`);
    tyIds.add(id);
    tyNames.add(name);
    asset_types.push({ id, name, color: String(t?.color ?? ''), sort_order: i });
  }

  const holdings = [];
  const seenHoldingIds = new Set();
  for (const [i, h] of rawHoldings.entries()) {
    const channel_id = String(h?.channel_id ?? '').trim();
    const asset_type_id = String(h?.asset_type_id ?? '').trim();
    if (!channel_id) throw new ValidationError(`第 ${i + 1} 条持仓缺少渠道`);
    if (!asset_type_id) throw new ValidationError(`第 ${i + 1} 条持仓缺少资产类型`);
    // 引用必须在本次提交里存在，否则外键会失败、或者指向一个已被删掉的实体
    if (!chIds.has(channel_id)) throw new ValidationError(`持仓引用了不存在的渠道：${channel_id}`);
    if (!tyIds.has(asset_type_id)) throw new ValidationError(`持仓引用了不存在的资产类型：${asset_type_id}`);

    const quote_category = String(h?.quote_category ?? '').trim();
    if (!CATEGORIES.includes(quote_category)) {
      throw new ValidationError(`持仓「${h?.symbol ?? ''}」的行情分类不合法：${quote_category || '(空)'}`);
    }
    // 复用既有的代码校验与规范化；抛出的 ValidationError 直接透出
    const { symbol, normalized_symbol } = validateAndNormalize(quote_category, h?.symbol);

    const quantity = asFinitePositive(h?.quantity);
    if (quantity === null) {
      throw new ValidationError(`持仓「${symbol}」的数量必须是大于 0 的有限数`);
    }

    const id = String(h?.id ?? '').trim() || `h-${randomUUID()}`;
    if (seenHoldingIds.has(id)) throw new ValidationError(`持仓 ID 重复：${id}`);
    seenHoldingIds.add(id);

    holdings.push({
      id, channel_id, asset_type_id, symbol, quote_category, normalized_symbol,
      quantity, sort_order: i,
    });
  }

  // display_currency 只接受 USD / CNY，其余按默认处理（不报错，避免旧客户端写入脏值后卡死）
  const display_currency = String(body.display_currency ?? '').trim().toUpperCase() === 'CNY'
    ? 'CNY' : DEFAULT_DISPLAY_CURRENCY;

  // 汇率非法时保留原值而不是写入脏值：与 MyInfo 旧语义一致（非法忽略）
  const rawRate = Number(body.usd_cny_rate);
  const usd_cny_rate = Number.isFinite(rawRate) && rawRate > 0 ? rawRate : null;

  return { channels, asset_types, holdings, display_currency, usd_cny_rate };
}

// ── 写入（全量原子替换） ─────────────────────────────────────────────────
export class VersionConflictError extends Error {
  constructor(current) {
    super('配置已被其他客户端修改，请刷新后重试');
    this.code = 'VERSION_CONFLICT';
    this.current_version = current;
  }
}

// expectedVersion 为 null 表示不校验（最后写入胜出）。
export function replaceConfig(db, body, expectedVersion = null) {
  const cfg = validateConfig(body);           // 先校验：抛错时一行都没写
  return withTransaction(db, () => {
    const current = getVersion(db);
    if (expectedVersion != null && expectedVersion !== current) {
      throw new VersionConflictError(current);
    }
    const ts = nowIso();

    // 删除顺序：先子表后父表（外键 ON DELETE CASCADE，但显式删更清楚）
    db.prepare('DELETE FROM portfolio_holdings').run();
    db.prepare('DELETE FROM portfolio_asset_types').run();
    db.prepare('DELETE FROM portfolio_channels').run();

    const insCh = db.prepare(`
      INSERT INTO portfolio_channels (id, name, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const c of cfg.channels) insCh.run(c.id, c.name, c.color, c.sort_order, ts, ts);

    const insTy = db.prepare(`
      INSERT INTO portfolio_asset_types (id, name, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const t of cfg.asset_types) insTy.run(t.id, t.name, t.color, t.sort_order, ts, ts);

    const insHd = db.prepare(`
      INSERT INTO portfolio_holdings
        (id, channel_id, asset_type_id, symbol, quote_category, normalized_symbol,
         quantity, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const h of cfg.holdings) {
      insHd.run(h.id, h.channel_id, h.asset_type_id, h.symbol, h.quote_category,
        h.normalized_symbol, h.quantity, h.sort_order, ts, ts);
    }

    const upPref = db.prepare(`
      INSERT INTO portfolio_preferences (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    upPref.run('display_currency', cfg.display_currency, ts);
    if (cfg.usd_cny_rate !== null) upPref.run('usd_cny_rate', String(cfg.usd_cny_rate), ts);

    // 持仓 K 线没有外键（见 migration v7：owner='pf' 的行不挂 watchlist_assets），
    // 所以换配置后要主动清掉「已不再持有」的标的缓存，否则会无限累积。
    prunePortfolioCandles(db);

    const next = current + 1;
    setVersion(db, next);
    return { version: next };
  });
}

// 删掉不再有任何持仓引用的 owner='pf' K 线缓存。
// 自选那半（owner='watch'）由外键级联负责，这里不碰。
export function prunePortfolioCandles(db) {
  const keep = db.prepare(`
    SELECT DISTINCT quote_category || ':' || normalized_symbol AS k FROM portfolio_holdings
  `).all().map(r => r.k);
  if (keep.length === 0) {
    db.prepare("DELETE FROM candle_cache WHERE owner = 'pf'").run();
    return;
  }
  const placeholders = keep.map(() => '?').join(',');
  db.prepare(`
    DELETE FROM candle_cache
    WHERE owner = 'pf' AND owner_key NOT IN (${placeholders})
  `).run(...keep);
}

// 单独更新偏好（币种切换走这条，不需要把整份配置回传）
export function setPreference(db, key, value) {
  db.prepare(`
    INSERT INTO portfolio_preferences (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, String(value), nowIso());
}

// 清空持仓与配置（迁移工具重置用；不动报价缓存）
export function clearConfig(db) {
  return withTransaction(db, () => {
    db.prepare('DELETE FROM portfolio_holdings').run();
    db.prepare('DELETE FROM portfolio_asset_types').run();
    db.prepare('DELETE FROM portfolio_channels').run();
    db.prepare('DELETE FROM portfolio_preferences').run();
    setVersion(db, 0);
  });
}

// 需要报价的唯一标的集合（按 quote_category + normalized_symbol 去重）。
// 这是「同一标的在多渠道只发一次上游请求」的依据。
export function uniqueQuoteTargets(db) {
  const rows = db.prepare(`
    SELECT DISTINCT quote_category, normalized_symbol
    FROM portfolio_holdings
    ORDER BY quote_category ASC, normalized_symbol ASC
  `).all();
  return rows.map(r => ({ quote_category: r.quote_category, normalized_symbol: r.normalized_symbol }));
}
