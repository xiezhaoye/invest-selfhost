// 旧 MyInfo 投资估值（investment_*）→ Invest portfolio_* 的只读导出与事务化导入。
//
// 迁移原则（交接.md「数据迁移与切换」）：
//   1. 只读打开**快照**（先对活跃库做 .backup），绝不写回。
//   2. 导出记录 SHA-256 与逐表行数，作为后续对账与幂等重放的依据。
//   3. 目标非空且来源不同 → 中止，不覆盖。
//   4. **旧资产类型不能用来猜行情市场**：已知类型（crypto→crypto、stock→us）才自动映射；
//      任何无法确定的旧类型都列入报告并中止，等人工确认后再导入。绝不默认猜成美股。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, withTransaction } from '../db.js';
import { validateAndNormalize } from '../normalize.js';
import { clearConfig, getVersion } from './config.js';

const IMPORT_HASH_KEY = 'portfolio_import_source_hash';
const IMPORT_SUMMARY_KEY = 'portfolio_import_summary';

// 旧「资产类型 id」→ Invest 的 quote_category。
//   这是**保守白名单**：只有明确已知的映射才自动转换。
//   stock → us 是 MyInfo 的历史约定（该类型下均为美股代码）。
const LEGACY_TYPE_TO_CATEGORY = {
  crypto: 'crypto',
  stock: 'us',
};

function openOldReadOnly(p) {
  return new DatabaseSync(p, { readOnly: true, open: true });
}

// 表存在性检查：旧库可能没有某些表（例如从未启动过的新库）
function tableExists(db, name) {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

// ── 导出（只读） ────────────────────────────────────────────────────────
export function exportOldPortfolio(oldDbPath) {
  const old = openOldReadOnly(oldDbPath);
  try {
    const tables = {};
    for (const t of ['investment_channels', 'investment_asset_types',
      'investment_holdings', 'investment_preferences']) {
      tables[t] = tableExists(old, t);
    }

    const channels = tables.investment_channels
      ? old.prepare('SELECT id, name, color, sort_order FROM investment_channels ORDER BY sort_order ASC, id ASC').all()
        .map(r => ({ id: String(r.id), name: String(r.name ?? ''), color: String(r.color ?? ''), sort_order: Number(r.sort_order ?? 0) }))
      : [];

    const asset_types = tables.investment_asset_types
      ? old.prepare('SELECT id, name, color, sort_order FROM investment_asset_types ORDER BY sort_order ASC, id ASC').all()
        .map(r => ({ id: String(r.id), name: String(r.name ?? ''), color: String(r.color ?? ''), sort_order: Number(r.sort_order ?? 0) }))
      : [];

    const holdings = tables.investment_holdings
      ? old.prepare('SELECT id, channel_id, asset_symbol, asset_type_id, quantity FROM investment_holdings ORDER BY id ASC').all()
        .map(r => ({
          id: String(r.id),
          channel_id: String(r.channel_id ?? ''),
          symbol: String(r.asset_symbol ?? '').toUpperCase(),
          asset_type_id: String(r.asset_type_id ?? ''),
          quantity: Number(r.quantity),
        }))
      : [];

    const preferences = tables.investment_preferences
      ? old.prepare('SELECT key, value FROM investment_preferences').all()
        .map(r => ({ key: String(r.key), value: String(r.value ?? '') }))
      : [];

    return { channels, asset_types, holdings, preferences, tables };
  } finally {
    old.close();
  }
}

// 导出内容的规范哈希：排序后逐字段拼接，保证同内容同哈希（幂等重放判据）
export function portfolioSourceHash(payload) {
  const parts = [];
  for (const c of [...payload.channels].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(['c', c.id, c.name, c.color, c.sort_order].join('\t'));
  }
  for (const t of [...payload.asset_types].sort((a, b) => a.id.localeCompare(b.id))) {
    parts.push(['t', t.id, t.name, t.color, t.sort_order].join('\t'));
  }
  for (const h of [...payload.holdings].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    parts.push(['h', h.id, h.channel_id, h.symbol, h.asset_type_id, h.quantity].join('\t'));
  }
  for (const p of [...payload.preferences].sort((a, b) => a.key.localeCompare(b.key))) {
    parts.push(['p', p.key, p.value].join('\t'));
  }
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

// 把旧持仓映射成 Invest 持仓。**无法确定分类的旧类型返回 unmapped**，由调用方中止。
export function mapLegacyHoldings(payload) {
  const unmapped = new Map();   // asset_type_id → 该类型下的持仓数
  const mapped = [];
  const typeIds = new Set(payload.asset_types.map(t => t.id));

  for (const h of payload.holdings) {
    const cat = LEGACY_TYPE_TO_CATEGORY[h.asset_type_id];
    if (!cat) {
      unmapped.set(h.asset_type_id, (unmapped.get(h.asset_type_id) || 0) + 1);
      continue;
    }
    let norm;
    try {
      norm = validateAndNormalize(cat, h.symbol);
    } catch (e) {
      mapped.push({ ...h, quote_category: null, normalized_symbol: null, error: e.message });
      continue;
    }
    mapped.push({
      ...h,
      quote_category: cat,
      normalized_symbol: norm.normalized_symbol,
      symbol: norm.symbol,
      error: null,
    });
  }

  const orphanTypes = [...unmapped.entries()].map(([id, n]) => ({
    asset_type_id: id,
    // 报告里带上名字与样例，人工确认时不用再去翻库
    name: payload.asset_types.find(t => t.id === id)?.name ?? id,
    holding_count: n,
  }));

  const badSymbols = mapped.filter(m => m.error);
  // 引用了不存在的渠道或类型（旧库可能有孤儿行）
  const chIds = new Set(payload.channels.map(c => c.id));
  const orphans = mapped.filter(m => !chIds.has(m.channel_id) || !typeIds.has(m.asset_type_id))
    .map(m => ({ id: m.id, channel_id: m.channel_id, asset_type_id: m.asset_type_id }));

  return { mapped, unmapped: orphanTypes, badSymbols, orphanRefs: orphans };
}

// ── 导入（事务化、幂等、可中止） ────────────────────────────────────────
export function importPortfolio(dbPath, payload, opts = {}) {
  const db = openDb(dbPath);
  const report = {
    ok: false,
    dry_run: !!opts.dryRun,
    source_hash: portfolioSourceHash(payload),
    counts: {
      channels: payload.channels.length,
      asset_types: payload.asset_types.length,
      holdings: payload.holdings.length,
      preferences: payload.preferences.length,
    },
    imported: { channels: 0, asset_types: 0, holdings: 0 },
    unmapped_types: [],
    bad_symbols: [],
    orphan_refs: [],
    checks: [],
    version_after: null,
    idempotent_skip: false,
  };

  try {
    const mapped = mapLegacyHoldings(payload);
    report.unmapped_types = mapped.unmapped;
    report.bad_symbols = mapped.badSymbols.map(b => ({ id: b.id, symbol: b.symbol, error: b.error }));
    report.orphan_refs = mapped.orphanRefs;

    // 1) 无法确定的旧资产类型 → **中止**，等人工映射，绝不猜成美股
    if (mapped.unmapped.length > 0) {
      report.checks.push({
        level: 'error',
        message: `有 ${mapped.unmapped.length} 个资产类型无法确定行情分类，已中止等待人工映射：`
          + mapped.unmapped.map(u => `${u.name}(${u.asset_type_id})×${u.holding_count}`).join('、')
          + '。请在报告里补充映射后重跑，不要默认按美股导入。',
      });
      return report;
    }
    if (mapped.badSymbols.length > 0) {
      report.checks.push({
        level: 'error',
        message: `${mapped.badSymbols.length} 条持仓的代码无法规范化：`
          + mapped.badSymbols.map(b => `${b.symbol}(${b.error})`).join('、'),
      });
      return report;
    }
    if (mapped.orphanRefs.length > 0) {
      report.checks.push({
        level: 'error',
        message: `${mapped.orphanRefs.length} 条持仓引用了不存在的渠道或类型，无法安全导入`,
      });
      return report;
    }

    // 2) 目标非空检查：已有数据且来源不同 → 中止
    const existingHash = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(IMPORT_HASH_KEY)?.value ?? null;
    const curVersion = getVersion(db);
    const targetHasData = db.prepare('SELECT COUNT(*) AS n FROM portfolio_channels').get().n > 0
      || db.prepare('SELECT COUNT(*) AS n FROM portfolio_holdings').get().n > 0;

    if (existingHash && existingHash === report.source_hash) {
      report.checks.push({ level: 'info', message: '来源哈希与已导入记录一致，幂等跳过（不重复写入）' });
      report.idempotent_skip = true;
      report.ok = true;
      report.version_after = curVersion;
      return report;
    }
    if (targetHasData && !opts.force) {
      report.checks.push({
        level: 'error',
        message: 'Invest 的 portfolio_* 已有数据，且来源与本次不同。已中止，不覆盖现有配置。'
          + '确认要覆盖请显式加 --force（并先备份库）。',
      });
      return report;
    }

    // 3) 组装 Invest 配置形状
    const config = {
      channels: payload.channels.map(c => ({ id: c.id, name: c.name, color: c.color })),
      asset_types: payload.asset_types.map(t => ({ id: t.id, name: t.name, color: t.color })),
      holdings: mapped.mapped.map(h => ({
        id: `h-${h.id}`,                     // 保留旧 id 便于对账，加前缀避免与生成 id 撞
        channel_id: h.channel_id,
        asset_type_id: h.asset_type_id,
        symbol: h.symbol,
        quote_category: h.quote_category,
        normalized_symbol: h.normalized_symbol,
        quantity: h.quantity,
      })),
      display_currency: 'USD',
      usd_cny_rate: null,
    };
    // 偏好：只迁移已知键，未知键忽略（不把垃圾写进新库）
    const prefMap = Object.fromEntries(payload.preferences.map(p => [p.key, p.value]));
    if (prefMap.currency === 'CNY' || prefMap.currency === 'USD') config.display_currency = prefMap.currency;
    const rate = Number(prefMap.usd_cny_rate);
    if (Number.isFinite(rate) && rate > 0) config.usd_cny_rate = rate;

    if (opts.dryRun) {
      report.checks.push({ level: 'info', message: 'dry-run：校验通过，未写入' });
      report.ok = true;
      return report;
    }

    // 4) 事务内写入。任一步失败整体回滚。
    // ⚠️ 这里直接写 SQL，**不能**调用 clearConfig()/replaceConfig()：
    // 它们内部各自 BEGIN，嵌套事务会报 "cannot start a transaction within a transaction"。
    withTransaction(db, () => {
      db.prepare('DELETE FROM portfolio_holdings').run();
      db.prepare('DELETE FROM portfolio_asset_types').run();
      db.prepare('DELETE FROM portfolio_channels').run();
      db.prepare('DELETE FROM portfolio_preferences').run();
      const ts = new Date().toISOString();
      const insCh = db.prepare(`INSERT INTO portfolio_channels (id, name, color, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)`);
      config.channels.forEach((c, i) => insCh.run(c.id, c.name, c.color, i, ts, ts));
      const insTy = db.prepare(`INSERT INTO portfolio_asset_types (id, name, color, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)`);
      config.asset_types.forEach((t, i) => insTy.run(t.id, t.name, t.color, i, ts, ts));
      const insHd = db.prepare(`INSERT INTO portfolio_holdings
        (id, channel_id, asset_type_id, symbol, quote_category, normalized_symbol, quantity, sort_order, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`);
      config.holdings.forEach((h, i) => insHd.run(
        h.id, h.channel_id, h.asset_type_id, h.symbol, h.quote_category,
        h.normalized_symbol, h.quantity, i, ts, ts));
      const upPref = db.prepare(`INSERT INTO portfolio_preferences (key, value, updated_at) VALUES (?,?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
      upPref.run('display_currency', config.display_currency, ts);
      if (config.usd_cny_rate !== null) upPref.run('usd_cny_rate', String(config.usd_cny_rate), ts);

      // 记录来源摘要（幂等重放的判据）+ 版本推进
      const upMeta = db.prepare(`INSERT INTO portfolio_meta (key, value) VALUES (?,?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
      upMeta.run(IMPORT_HASH_KEY, report.source_hash);
      upMeta.run(IMPORT_SUMMARY_KEY, JSON.stringify({
        imported_at: ts,
        counts: report.counts,
        source_hash: report.source_hash,
      }));
      upMeta.run('config_version', String(getVersion(db) + 1));
    });

    report.imported = {
      channels: config.channels.length,
      asset_types: config.asset_types.length,
      holdings: config.holdings.length,
    };
    report.version_after = getVersion(db);
    report.checks.push({ level: 'info', message: `已导入 ${config.channels.length} 渠道 / ${config.asset_types.length} 类型 / ${config.holdings.length} 持仓` });
    report.ok = true;
    return report;
  } finally {
    db.close();
  }
}

// ── 逐字段对账：源 payload vs Invest 库内现状 ───────────────────────────
export function reconcilePortfolio(dbPath, payload) {
  const db = openDb(dbPath);
  const checks = [];
  try {
    const chIn = db.prepare('SELECT id, name, color, sort_order FROM portfolio_channels ORDER BY id').all();
    const tyIn = db.prepare('SELECT id, name, color, sort_order FROM portfolio_asset_types ORDER BY id').all();
    const hdIn = db.prepare('SELECT * FROM portfolio_holdings ORDER BY id').all();
    const prefs = Object.fromEntries(
      db.prepare('SELECT key, value FROM portfolio_preferences').all().map(r => [r.key, r.value]));

    const srcCh = [...payload.channels].sort((a, b) => a.id.localeCompare(b.id));
    const srcTy = [...payload.asset_types].sort((a, b) => a.id.localeCompare(b.id));

    // ID 集合一致
    const chIds = (a) => a.map(x => x.id).join(',');
    checks.push({
      level: chIds(srcCh) === chIds(chIn) ? 'ok' : 'error',
      message: `渠道 ID 集合：源 ${srcCh.length} / 库内 ${chIn.length}`
        + (chIds(srcCh) === chIds(chIn) ? ' 一致' : ` 不一致\n  源：${chIds(srcCh)}\n  库：${chIds(chIn)}`),
    });
    checks.push({
      level: chIds(srcTy) === chIds(tyIn) ? 'ok' : 'error',
      message: `资产类型 ID 集合：源 ${srcTy.length} / 库内 ${tyIn.length}`
        + (chIds(srcTy) === chIds(tyIn) ? ' 一致' : ' 不一致'),
    });

    // 逐字段比对渠道/类型（名称、颜色、顺序）
    for (const s of srcCh) {
      const t = chIn.find(x => x.id === s.id);
      if (!t) continue;
      if (t.name !== s.name || t.color !== s.color || Number(t.sort_order) !== Number(s.sort_order)) {
        checks.push({ level: 'error', message: `渠道 ${s.id} 字段不一致：源 ${JSON.stringify(s)} vs 库 ${JSON.stringify(t)}` });
      }
    }
    for (const s of srcTy) {
      const t = tyIn.find(x => x.id === s.id);
      if (!t) continue;
      if (t.name !== s.name || t.color !== s.color || Number(t.sort_order) !== Number(s.sort_order)) {
        checks.push({ level: 'error', message: `类型 ${s.id} 字段不一致：源 ${JSON.stringify(s)} vs 库 ${JSON.stringify(t)}` });
      }
    }

    // 持仓数量与 ID 集合
    const srcHd = [...payload.holdings].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    checks.push({
      level: srcHd.length === hdIn.length ? 'ok' : 'error',
      message: `持仓条数：源 ${srcHd.length} / 库内 ${hdIn.length}`
        + (srcHd.length === hdIn.length ? ' 一致' : ' 不一致'),
    });
    const normId = (s) => String(s).replace(/^h-/, '');
    const srcIdSet = srcHd.map(h => normId(h.id)).sort().join(',');
    const inIdSet = hdIn.map(h => normId(h.id)).sort().join(',');
    checks.push({
      level: srcIdSet === inIdSet ? 'ok' : 'error',
      message: srcIdSet === inIdSet ? '持仓 ID 集合一致' : '持仓 ID 集合不一致',
    });

    // 逐条比对数量与代码
    let qtyMismatch = 0;
    for (const s of srcHd) {
      const t = hdIn.find(x => normId(x.id) === normId(s.id));
      if (!t) continue;
      if (Number(t.quantity) !== Number(s.quantity) || String(t.symbol) !== String(s.symbol).toUpperCase()) {
        qtyMismatch++;
        checks.push({ level: 'error', message: `持仓 ${s.id} 不一致：源 数量${s.quantity}/${s.symbol} vs 库 数量${t.quantity}/${t.symbol}` });
      }
    }
    if (qtyMismatch === 0 && srcHd.length) checks.push({ level: 'ok', message: '逐条持仓的数量与代码一致' });

    // 偏好一致性
    const srcPref = Object.fromEntries(payload.preferences.map(p => [p.key, p.value]));
    const srcCur = srcPref.currency === 'CNY' ? 'CNY' : 'USD';
    checks.push({
      level: (prefs.display_currency || 'USD') === srcCur ? 'ok' : 'error',
      message: `显示币种：源 ${srcCur} / 库 ${prefs.display_currency || 'USD'}`,
    });
    if (srcPref.usd_cny_rate !== undefined) {
      const ok = Math.abs(Number(prefs.usd_cny_rate) - Number(srcPref.usd_cny_rate)) < 1e-9;
      checks.push({
        level: ok ? 'ok' : 'error',
        message: `USD/CNY 汇率：源 ${srcPref.usd_cny_rate} / 库 ${prefs.usd_cny_rate}${ok ? ' 一致' : ' 不一致'}`,
      });
    }

    return {
      ok: !checks.some(c => c.level === 'error'),
      checks,
      counts: {
        source: { channels: srcCh.length, asset_types: srcTy.length, holdings: srcHd.length },
        target: { channels: chIn.length, asset_types: tyIn.length, holdings: hdIn.length },
      },
      version_after: getVersion(db),
    };
  } finally {
    db.close();
  }
}
