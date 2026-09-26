// 演示数据：每条示例的 normalized_symbol 必须与规范化规则一致，否则行情源取不到价格。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { seedDemoData } from '../server/demo-data.js';
import { validateAndNormalize } from '../server/normalize.js';

test('演示自选的 normalized_symbol 与规范化规则一致', () => {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'invest-demo-')), 'a.sqlite'));
  assert.equal(seedDemoData(db), true);
  for (const a of db.prepare('SELECT category, symbol, normalized_symbol FROM watchlist_assets').all()) {
    assert.equal(a.normalized_symbol, validateAndNormalize(a.category, a.symbol).normalized_symbol, a.symbol);
  }
});

test('迁移 v9：修正旧库里写错的平安银行示例代码', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'invest-demo-')), 'b.sqlite');
  const db = openDb(file);
  seedDemoData(db);
  // 模拟首版种子写入的错误值，并回退到 v8
  db.prepare("UPDATE watchlist_assets SET normalized_symbol = '000001' WHERE id = 'demo-pab'").run();
  db.prepare('DELETE FROM schema_migrations WHERE version >= 9').run();
  db.close();
  const reopened = openDb(file);
  const row = reopened.prepare("SELECT normalized_symbol FROM watchlist_assets WHERE id = 'demo-pab'").get();
  assert.equal(row.normalized_symbol, '000001.SZ');
});
