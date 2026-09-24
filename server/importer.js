// 旧 MyInfo watchlist_assets → Invest 的导出与导入。
// 原则（交接.md §4）：保留每行 ID、原始代码、名称、显示开关与分类内相对顺序；
// 新增 is_starred 一律 false；可重复执行且不重复造数据；目标库有非迁移数据时
// 报告冲突并中止，不覆盖；空旧库是合法状态，不自动播种。
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, withTransaction } from './db.js';
import { validateAndNormalize } from './normalize.js';
import { listAssets, getVersion } from './assets.js';

const OLD_CATEGORIES = ['us', 'hk', 'a_share', 'crypto', 'index'];
const IMPORT_HASH_KEY = 'import_source_hash';

// 从旧库只读导出（旧 schema：id/category/symbol/name/show_changes/sort_order）
export function exportOldDb(oldDbPath) {
  const old = openOldReadOnly(oldDbPath);
  try {
    const rows = old.prepare(
      'SELECT id, category, symbol, name, show_changes, sort_order FROM watchlist_assets ORDER BY sort_order ASC, id ASC'
    ).all();
    return rows.map(r => ({
      id: String(r.id),
      category: String(r.category),
      symbol: String(r.symbol),
      name: String(r.name ?? ''),
      show_changes: r.show_changes === 0 ? false : true,
      sort_order: Number(r.sort_order ?? 0),
    }));
  } finally {
    old.close();
  }
}

function openOldReadOnly(oldDbPath) {
  // 旧库可能是 WAL 活跃库；导出前应已用 sqlite3 .backup 做过一致性备份，
  // 这里只读打开导出的备份文件，绝不写回。
  return new DatabaseSync(oldDbPath, { readOnly: true, open: true });
}

export function sourceHash(rows) {
  const canonical = rows.map(r => [r.id, r.category, r.symbol, r.name, r.show_changes ? 1 : 0, r.sort_order].join('\t')).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

// 导入到 Invest 库。返回对账报告（不抛业务异常；冲突/错误体现在 report.ok=false）。
export function importAssets(dbPath, rows, opts = {}) {
  const db = openDb(dbPath);
  const report = {
    ok: false,
    source_rows: rows.length,
    imported: 0,
    skipped: false,
    per_category: {},
    checks: [],
    version_after: null,
  };
  try {
    for (const c of OLD_CATEGORIES) report.per_category[c] = 0;

    // 1. 空源库：合法状态，直接成功返回（绝不播种）
    if (rows.length === 0) {
      report.checks.push({ level: 'info', message: '源库为空，无可导入数据（合法状态）' });
      report.ok = true;
      report.skipped = true;
      return report;
    }

    // 2. 源数据预校验：分类合法、ID 唯一、代码可规范化
    const seenIds = new Set();
    const seenNorm = new Map();
    const normalizedRows = [];
    for (const r of rows) {
      if (!OLD_CATEGORIES.includes(r.category)) {
        report.checks.push({ level: 'error', message: `行 ${r.id}：非法分类 ${r.category}` });
        continue;
      }
      if (seenIds.has(r.id)) {
        report.checks.push({ level: 'error', message: `行 ${r.id}：ID 重复` });
        continue;
      }
      seenIds.add(r.id);
      let norm;
      try {
        norm = validateAndNormalize(r.category, r.symbol);
      } catch (e) {
        report.checks.push({ level: 'error', message: `行 ${r.id}（${r.symbol}）：${e.message}` });
        continue;
      }
      const dupKey = `${r.category}|${norm.normalized_symbol}`;
      if (seenNorm.has(dupKey)) {
        report.checks.push({
          level: 'error',
          message: `行 ${r.id}（${r.symbol}）与行 ${seenNorm.get(dupKey)} 规范化后同为 ${norm.normalized_symbol}，同分类重复`,
        });
        continue;
      }
      seenNorm.set(dupKey, r.id);
      normalizedRows.push({ ...r, ...norm });
    }
    if (report.checks.some(c => c.level === 'error')) {
      report.checks.push({ level: 'error', message: '源数据校验失败，未执行任何写入' });
      return report;
    }

    // 3. 幂等：同源重复导入 → no-op 成功
    const hash = sourceHash(rows);
    const existingHash = db.prepare('SELECT value FROM watchlist_meta WHERE key = ?').get(IMPORT_HASH_KEY)?.value;
    if (existingHash === hash) {
      report.checks.push({ level: 'info', message: '该源数据已导入过，本次为空操作（幂等）' });
      report.ok = true;
      report.skipped = true;
      report.imported = 0;
      report.version_after = getVersion(db);
      return report;
    }

    // 4. 目标库冲突检查：已有任何资产（且不是同源重放）→ 中止
    const existingAssets = listAssets(db);
    if (existingAssets.length > 0) {
      report.checks.push({
        level: 'error',
        message: `目标库已有 ${existingAssets.length} 条非迁移数据（如 ${existingAssets[0].symbol}），按约定中止导入，不覆盖`,
      });
      return report;
    }

    // 5. 事务化导入：分类内相对顺序 = 源全局顺序在各分类内的出现顺序
    withTransaction(db, () => {
      const catSeq = {};
      const ins = db.prepare(`
        INSERT INTO watchlist_assets
          (id, category, symbol, normalized_symbol, name, show_changes, is_starred, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `);
      const ts = new Date().toISOString();
      for (const r of normalizedRows) {
        const order = catSeq[r.category] ?? 0;
        catSeq[r.category] = order + 1;
        ins.run(r.id, r.category, r.symbol, r.normalized_symbol, r.name, r.show_changes ? 1 : 0, order, ts, ts);
      }
      db.prepare('INSERT OR REPLACE INTO watchlist_meta(key, value) VALUES (?, ?)').run(IMPORT_HASH_KEY, hash);
      // 导入也是一次配置写入，推进版本
      db.prepare("UPDATE watchlist_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'config_version'").run();
    });
    report.imported = normalizedRows.length;

    // 6. 对账：总数 / 每类数量 / ID 集合 / 逐行字段
    const after = listAssets(db);
    let pass = true;
    if (after.length !== normalizedRows.length) {
      pass = false;
      report.checks.push({ level: 'error', message: `总数不符：源 ${normalizedRows.length}，目标 ${after.length}` });
    }
    const byId = new Map(after.map(a => [a.id, a]));
    const srcIds = new Set(normalizedRows.map(r => r.id));
    const dstIds = new Set(after.map(a => a.id));
    for (const id of srcIds) {
      if (!dstIds.has(id)) { pass = false; report.checks.push({ level: 'error', message: `ID ${id} 未导入` }); }
    }
    for (const id of dstIds) {
      if (!srcIds.has(id)) { pass = false; report.checks.push({ level: 'error', message: `目标库出现源外 ID ${id}` }); }
    }
    for (const r of normalizedRows) {
      const a = byId.get(r.id);
      if (!a) continue;
      const mismatches = [];
      if (a.category !== r.category) mismatches.push('category');
      if (a.symbol !== r.symbol) mismatches.push('symbol');
      if (a.name !== r.name) mismatches.push('name');
      if (a.show_changes !== r.show_changes) mismatches.push('show_changes');
      if (a.is_starred !== false) mismatches.push('is_starred');
      if (mismatches.length) {
        pass = false;
        report.checks.push({ level: 'error', message: `行 ${r.id}：字段不符 ${mismatches.join(',')}` });
      }
    }
    // 分类内相对顺序核对
    for (const c of OLD_CATEGORIES) {
      const srcOrder = normalizedRows.filter(r => r.category === c).map(r => r.id);
      const dstOrder = after.filter(a => a.category === c).map(a => a.id);
      if (JSON.stringify(srcOrder) !== JSON.stringify(dstOrder)) {
        pass = false;
        report.checks.push({ level: 'error', message: `分类 ${c} 内顺序不符` });
      }
      report.per_category[c] = dstOrder.length;
    }
    report.version_after = getVersion(db);
    report.ok = pass;
    if (pass) report.checks.push({ level: 'info', message: '对账通过：总数 / ID 集合 / 逐行字段 / 分类内顺序一致' });
    return report;
  } finally {
    db.close();
  }
}
