// 迁移链路测试：合成旧库 → 导出 → 导入 → 对账 → 幂等 → 冲突中止 → 空库合法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportOldDb, importAssets } from '../server/importer.js';
import { openDb } from '../server/db.js';
import { listAssets, getVersion } from '../server/assets.js';

function tmp(p) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'invest-mig-')), p);
}

function makeOldDb(dbPath, rows) {
  if (fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE watchlist_assets (
      id TEXT PRIMARY KEY, category TEXT NOT NULL, symbol TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', show_changes INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
  `);
  const ins = db.prepare('INSERT INTO watchlist_assets VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.id, r.category, r.symbol, r.name, r.show_changes ? 1 : 0, r.sort_order);
  db.close();
}

const SAMPLE = [
  { id: 'macro-us10y', category: 'index', symbol: '^TNX', name: '美债10年期收益率', show_changes: false, sort_order: 0 },
  { id: 'us-aapl', category: 'us', symbol: 'AAPL', name: '苹果', show_changes: true, sort_order: 1 },
  { id: 'macro-gold', category: 'index', symbol: 'GC=F', name: '黄金', show_changes: true, sort_order: 2 },
  { id: 'hk-0700', category: 'hk', symbol: '0700', name: '腾讯控股', show_changes: true, sort_order: 3 },
  { id: 'us-nvda', category: 'us', symbol: 'NVDA', name: '', show_changes: true, sort_order: 4 },
  { id: 'crypto-btc', category: 'crypto', symbol: 'BTC', name: '比特币', show_changes: true, sort_order: 5 },
  { id: 'a-600519', category: 'a_share', symbol: '600519', name: '贵州茅台', show_changes: true, sort_order: 6 },
  { id: 'hk-02015', category: 'hk', symbol: '02015', name: '理想汽车', show_changes: true, sort_order: 7 },
  { id: 'a-000001', category: 'a_share', symbol: '000001', name: '平安银行', show_changes: false, sort_order: 8 },
];

test('导出：按 sort_order,id 顺序、字段完整', () => {
  const old = tmp('old.sqlite');
  makeOldDb(old, SAMPLE);
  const rows = exportOldDb(old);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows.map(r => r.id), SAMPLE.map(r => r.id));
  assert.equal(rows[0].show_changes, false);
  assert.equal(rows[3].symbol, '0700');
});

test('导入：全量对账通过，幂等重放，字段与顺序保持', () => {
  const old = tmp('old.sqlite');
  makeOldDb(old, SAMPLE);
  const rows = exportOldDb(old);
  const invest = tmp('invest.sqlite');
  openDb(invest).close(); // 建库 + 迁移

  const r1 = importAssets(invest, rows);
  assert.equal(r1.ok, true, JSON.stringify(r1.checks));
  assert.equal(r1.imported, 9);
  assert.deepEqual(r1.per_category, { us: 2, hk: 2, a_share: 2, crypto: 1, index: 2 });
  assert.equal(r1.version_after, 1);

  // 逐项核对
  const db = openDb(invest);
  const assets = listAssets(db);
  const byId = new Map(assets.map(a => [a.id, a]));
  assert.equal(byId.get('hk-02015').symbol, '02015', '原始代码保留');
  assert.equal(byId.get('hk-02015').normalized_symbol, '2015.HK');
  assert.equal(byId.get('a-600519').normalized_symbol, '600519.SS');
  assert.equal(byId.get('a-000001').normalized_symbol, '000001.SZ');
  assert.equal(byId.get('us-nvda').name, '');
  assert.equal(byId.get('macro-us10y').show_changes, false);
  assert.equal(byId.get('us-aapl').is_starred, false, '导入后标星一律 false');
  // 分类内相对顺序：us 全局顺序 aapl(1) nvda(4) → aapl, nvda
  assert.deepEqual(assets.filter(a => a.category === 'us').map(a => a.id), ['us-aapl', 'us-nvda']);
  assert.deepEqual(assets.filter(a => a.category === 'index').map(a => a.id), ['macro-us10y', 'macro-gold']);
  assert.deepEqual(assets.filter(a => a.category === 'hk').map(a => a.id), ['hk-0700', 'hk-02015']);
  db.close();

  // 幂等：同源重放 → no-op
  const r2 = importAssets(invest, rows);
  assert.equal(r2.ok, true);
  assert.equal(r2.skipped, true);
  assert.equal(r2.imported, 0);
  const db2 = openDb(invest);
  assert.equal(listAssets(db2).length, 9, '重放不重复造数据');
  assert.equal(getVersion(db2), 1, '重放不推进版本');
  db2.close();
});

test('目标库已有非迁移数据 → 冲突中止，不覆盖', () => {
  const old = tmp('old.sqlite');
  makeOldDb(old, SAMPLE.slice(0, 2));
  const rows = exportOldDb(old);
  const invest = tmp('invest.sqlite');
  const db = openDb(invest);
  // 预置一条非迁移数据
  const ts = new Date().toISOString();
  db.prepare(`INSERT INTO watchlist_assets
    (id, category, symbol, normalized_symbol, name, show_changes, is_starred, sort_order, created_at, updated_at)
    VALUES ('pre-existing', 'us', 'MSFT', 'MSFT', '微软', 1, 0, 0, ?, ?)`).run(ts, ts);
  db.close();

  const r = importAssets(invest, rows);
  assert.equal(r.ok, false);
  assert.equal(r.imported, 0);
  assert.ok(r.checks.some(c => c.level === 'error' && c.message.includes('非迁移数据')));
  const db2 = openDb(invest);
  assert.equal(listAssets(db2).length, 1, '目标库未被改动');
  db2.close();
});

test('源数据含非法分类 / 同分类规范化重复 → 校验失败不写入', () => {
  const invest = tmp('invest.sqlite');
  openDb(invest).close();
  const bad = [
    ...SAMPLE.slice(0, 2),
    { id: 'bad-cat', category: 'jp', symbol: '7203', name: '', show_changes: true, sort_order: 9 },
  ];
  const r = importAssets(invest, bad);
  assert.equal(r.ok, false);
  assert.equal(r.imported, 0);
  const db = openDb(invest);
  assert.equal(listAssets(db).length, 0, '校验失败时零写入');
  db.close();

  const invest2 = tmp('invest2.sqlite');
  openDb(invest2).close();
  const dup = [
    { id: 'c1', category: 'crypto', symbol: 'BTC', name: '', show_changes: true, sort_order: 0 },
    { id: 'c2', category: 'crypto', symbol: 'BTCUSDT', name: '', show_changes: true, sort_order: 1 },
  ];
  const r2 = importAssets(invest2, dup);
  assert.equal(r2.ok, false);
  assert.ok(r2.checks.some(c => c.message.includes('同分类重复')));
});

test('空旧库：合法状态，no-op 且绝不播种', () => {
  const invest = tmp('invest.sqlite');
  openDb(invest).close();
  const r = importAssets(invest, []);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  const db = openDb(invest);
  assert.equal(listAssets(db).length, 0);
  db.close();
});
