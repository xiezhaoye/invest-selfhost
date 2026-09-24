// 标签体系（schema v8）：标签是**视图**，与 category（市场事实）正交。
// 重点覆盖用户明确确认过的行为：
//   - 标签跨市场：一个标签下可以同时有美股和 A 股
//   - 每个标签独立排序，互不影响
//   - 新资产追加到标签末尾
//   - 删除标签只清关系，资产保留
//   - 标星是内置标签，与 is_starred 列双向一致（MyInfo 消费者读后者）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb, schemaVersion, LATEST_SCHEMA_VERSION } from '../server/db.js';
import * as assets from '../server/assets.js';
import * as tags from '../server/tags.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invest-tags-'));
  return openDb(path.join(dir, 'invest.sqlite'));
}

function fixture(db) {
  const a = assets.createAsset(db, { category: 'us', symbol: 'AAPL', name: '苹果' }).asset;
  const b = assets.createAsset(db, { category: 'a_share', symbol: '002594', name: '比亚迪' }).asset;
  const c = assets.createAsset(db, { category: 'crypto', symbol: 'BTC', name: '比特币' }).asset;
  return { a, b, c };
}

test('schema v8：标签三表建立，内置标星标签存在且唯一', () => {
  const db = tmpDb();
  assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION());
  const star = db.prepare('SELECT * FROM watchlist_tags WHERE is_star = 1').all();
  assert.equal(star.length, 1);
  assert.equal(star[0].id, tags.STAR_TAG_ID);
  // 唯一索引保证不可能出现第二个内置标星标签
  assert.throws(
    () => db.prepare("INSERT INTO watchlist_tags (id,name,is_star,sort_order,created_at,updated_at) VALUES ('x','x',1,9,'t','t')").run(),
    /UNIQUE|constraint/i
  );
  db.close();
});

test('标签跨市场：一个标签下可同时有美股与 A 股', () => {
  const db = tmpDb();
  const { a, b } = fixture(db);
  const ev = tags.createTag(db, { name: '电动车' }).tag;
  tags.setAssetTags(db, a.id, [ev.id]);
  tags.setAssetTags(db, b.id, [ev.id]);
  const ids = tags.assetIdsInTag(db, ev.id);
  assert.deepEqual(ids, [a.id, b.id], '美股与 A 股在同一标签下共存');
  db.close();
});

test('重名标签幂等返回已有标签，不复制', () => {
  const db = tmpDb();
  const first = tags.createTag(db, { name: '新能源' });
  assert.equal(first.existed, false);
  const again = tags.createTag(db, { name: '新能源' });
  assert.equal(again.existed, true);
  assert.equal(again.tag.id, first.tag.id);
  // 大小写也不该分裂出第二个
  const upper = tags.createTag(db, { name: '新能源' });
  assert.equal(upper.tag.id, first.tag.id);
  assert.equal(tags.listTags(db).filter(t => !t.is_star).length, 1);
  db.close();
});

test('新标签追加到末尾；取消勾选后压缩排序为 0..n-1', () => {
  const db = tmpDb();
  const { a, b, c } = fixture(db);
  const ev = tags.createTag(db, { name: '电动车' }).tag;
  tags.setAssetTags(db, a.id, [ev.id]);
  tags.setAssetTags(db, b.id, [ev.id]);
  tags.setAssetTags(db, c.id, [ev.id]);
  assert.deepEqual(tags.assetIdsInTag(db, ev.id), [a.id, b.id, c.id], '按加入先后追加到末尾');

  // 抽掉中间那个，后面的必须补位，不能留空洞
  tags.setAssetTags(db, b.id, []);
  assert.deepEqual(tags.assetIdsInTag(db, ev.id), [a.id, c.id]);
  const orders = db.prepare('SELECT sort_order FROM watchlist_tag_order WHERE tag_id = ? ORDER BY sort_order')
    .all(ev.id).map(r => r.sort_order);
  assert.deepEqual(orders, [0, 1], '排序必须连续，不能有空洞');
  db.close();
});

test('每个标签独立排序：拖 A 标签不影响 B 标签', () => {
  const db = tmpDb();
  const { a, b, c } = fixture(db);
  const t1 = tags.createTag(db, { name: '电动车' }).tag;
  const t2 = tags.createTag(db, { name: '新能源' }).tag;
  for (const t of [t1, t2]) {
    for (const x of [a, b, c]) tags.setAssetTags(db, x.id, tags.tagsOfAsset(db, x.id).map(y => y.id).concat(t.id));
  }
  assert.deepEqual(tags.assetIdsInTag(db, t1.id), [a.id, b.id, c.id]);
  assert.deepEqual(tags.assetIdsInTag(db, t2.id), [a.id, b.id, c.id]);

  // 只倒转 t1
  tags.reorderTag(db, t1.id, [c.id, b.id, a.id]);
  assert.deepEqual(tags.assetIdsInTag(db, t1.id), [c.id, b.id, a.id]);
  assert.deepEqual(tags.assetIdsInTag(db, t2.id), [a.id, b.id, c.id], 't2 完全不受影响');
  db.close();
});

test('reorderTag：ids 必须恰好是该标签全集，跨市场不算错', () => {
  const db = tmpDb();
  const { a, b } = fixture(db);   // a=us, b=a_share
  const ev = tags.createTag(db, { name: '电动车' }).tag;
  tags.setAssetTags(db, a.id, [ev.id]);
  tags.setAssetTags(db, b.id, [ev.id]);
  // 跨市场排列是合法的（这正是旧 reorderCategory 会 400 的场景）
  assert.doesNotThrow(() => tags.reorderTag(db, ev.id, [b.id, a.id]));
  // 少了 / 多了 / 重复都要拒绝
  assert.throws(() => tags.reorderTag(db, ev.id, [a.id]), /完全一致/);
  assert.throws(() => tags.reorderTag(db, ev.id, [a.id, b.id, 'nope']), /完全一致/);
  assert.throws(() => tags.reorderTag(db, ev.id, [a.id, a.id]), /重复/);
  db.close();
});

test('删除标签：关系清掉、资产保留，不碰其他标签', () => {
  const db = tmpDb();
  const { a, b } = fixture(db);
  const t1 = tags.createTag(db, { name: '电动车' }).tag;
  const t2 = tags.createTag(db, { name: '新能源' }).tag;
  tags.setAssetTags(db, a.id, [t1.id, t2.id]);
  tags.setAssetTags(db, b.id, [t1.id]);

  tags.deleteTag(db, t1.id);
  assert.equal(tags.getTag(db, t1.id), null);
  // 资产还在
  assert.ok(assets.getAsset(db, a.id));
  assert.ok(assets.getAsset(db, b.id));
  // a 还挂着 t2，b 一个标签都没有了
  assert.deepEqual(tags.tagsOfAsset(db, a.id).map(t => t.id), [t2.id]);
  assert.deepEqual(tags.tagsOfAsset(db, b.id), []);
  // 级联把 tag_order 也清了
  assert.equal(db.prepare('SELECT COUNT(*) n FROM watchlist_tag_order WHERE tag_id = ?').get(t1.id).n, 0);
  db.close();
});

test('删除资产：它的标签关系与各标签排序位一并清理并压缩', () => {
  const db = tmpDb();
  const { a, b, c } = fixture(db);
  const ev = tags.createTag(db, { name: '电动车' }).tag;
  for (const x of [a, b, c]) tags.setAssetTags(db, x.id, [ev.id]);
  assert.deepEqual(tags.assetIdsInTag(db, ev.id), [a.id, b.id, c.id]);

  assets.deleteAsset(db, b.id);
  assert.deepEqual(tags.assetIdsInTag(db, ev.id), [a.id, c.id], '中间被删后必须补位');
  const orders = db.prepare('SELECT sort_order FROM watchlist_tag_order WHERE tag_id = ? ORDER BY sort_order')
    .all(ev.id).map(r => r.sort_order);
  assert.deepEqual(orders, [0, 1]);
  db.close();
});

test('内置标星标签：不可删、不可改名，且 is_starred 列与关系始终一致', () => {
  const db = tmpDb();
  const { a } = fixture(db);
  assert.throws(() => tags.deleteTag(db, tags.STAR_TAG_ID), /不可删除/);
  assert.throws(() => tags.renameTag(db, tags.STAR_TAG_ID, '我的星'), /不可改名/);

  // 标星 → 列与标签关系同时成立
  assets.updateAsset(db, a.id, { is_starred: true });
  assert.equal(assets.getAsset(db, a.id).is_starred, true);
  assert.ok(tags.tagsOfAsset(db, a.id).some(t => t.id === tags.STAR_TAG_ID));

  // 取消标星 → 两边同时撤销
  assets.updateAsset(db, a.id, { is_starred: false });
  assert.equal(assets.getAsset(db, a.id).is_starred, false);
  assert.ok(!tags.tagsOfAsset(db, a.id).some(t => t.id === tags.STAR_TAG_ID));
  db.close();
});

test('通过 tag_ids 勾选内置标星，会同步 is_starred 列（MyInfo 消费者读它）', () => {
  const db = tmpDb();
  const { a } = fixture(db);
  assets.updateAsset(db, a.id, { tag_ids: [tags.STAR_TAG_ID] });
  assert.equal(assets.getAsset(db, a.id).is_starred, true, '列必须同步，否则 MyInfo 看不到');
  assets.updateAsset(db, a.id, { tag_ids: [] });
  assert.equal(assets.getAsset(db, a.id).is_starred, false);
  db.close();
});

test('createAsset 带 tag_ids：一次建好资产与标签', () => {
  const db = tmpDb();
  const ev = tags.createTag(db, { name: '电动车' }).tag;
  const { asset } = assets.createAsset(db, {
    category: 'a_share', symbol: '002594', name: '比亚迪', tag_ids: [ev.id],
  });
  assert.deepEqual(asset.tag_ids, [ev.id]);
  assert.deepEqual(asset.tags.map(t => t.name), ['电动车']);
  db.close();
});

test('listAssets 带出 tag_ids，且不产生 N+1 查询', () => {
  const db = tmpDb();
  const { a, b } = fixture(db);
  const ev = tags.createTag(db, { name: '电动车' }).tag;
  tags.setAssetTags(db, a.id, [ev.id]);
  const list = assets.listAssets(db);
  const byId = new Map(list.map(x => [x.id, x]));
  assert.deepEqual(byId.get(a.id).tag_ids, [ev.id]);
  assert.deepEqual(byId.get(b.id).tag_ids, []);
  db.close();
});

test('tag_ids 全量替换语义：不在列表里的标签被摘掉', () => {
  const db = tmpDb();
  const { a } = fixture(db);
  const t1 = tags.createTag(db, { name: '电动车' }).tag;
  const t2 = tags.createTag(db, { name: '新能源' }).tag;
  assets.updateAsset(db, a.id, { tag_ids: [t1.id, t2.id] });
  assert.deepEqual(assets.getAsset(db, a.id).tag_ids.sort(), [t1.id, t2.id].sort());
  assets.updateAsset(db, a.id, { tag_ids: [t2.id] });
  assert.deepEqual(assets.getAsset(db, a.id).tag_ids, [t2.id]);
  db.close();
});

test('自定义标签的侧边栏顺序可独立调整，内置标星恒排第一', () => {
  const db = tmpDb();
  const t1 = tags.createTag(db, { name: '电动车' }).tag;
  const t2 = tags.createTag(db, { name: '新能源' }).tag;
  assert.deepEqual(tags.listTags(db).map(t => t.name), ['标星', '电动车', '新能源']);
  tags.reorderTags(db, [t2.id, t1.id]);
  assert.deepEqual(tags.listTags(db).map(t => t.name), ['标星', '新能源', '电动车']);
  // 内置标星不能出现在 ids 里
  assert.throws(() => tags.reorderTags(db, [t1.id, tags.STAR_TAG_ID]), /完全一致/);
  db.close();
});

test('标签名：空名拒绝，超长截断，首尾空白清理', () => {
  const db = tmpDb();
  assert.throws(() => tags.createTag(db, { name: '   ' }), /不能为空/);
  const t = tags.createTag(db, { name: '  电动车  ' }).tag;
  assert.equal(t.name, '电动车');
  const long = tags.createTag(db, { name: 'x'.repeat(50) }).tag;
  assert.equal(long.name.length, 20);
  db.close();
});

test('改名：重名拒绝、空白清理、超长截断，且不影响标签下的资产', () => {
  const db = tmpDb();
  const { a, b } = fixture(db);
  const t1 = tags.createTag(db, { name: '电动车' }).tag;
  const t2 = tags.createTag(db, { name: '新能源' }).tag;
  tags.setAssetTags(db, a.id, [t1.id]);
  tags.setAssetTags(db, b.id, [t1.id]);

  // 与另一个标签重名 → 400（否则会出现两个同名标签，用户无法区分）
  assert.throws(() => tags.renameTag(db, t1.id, '新能源'), /已存在同名标签/);
  // 与自己同名（只改大小写/空白）是允许的
  assert.equal(tags.renameTag(db, t1.id, '电动车 ').tag.name, '电动车');
  // 空白清理 + 超长截断
  assert.equal(tags.renameTag(db, t1.id, '  电动 车  ').tag.name, '电动 车');
  assert.equal(tags.renameTag(db, t1.id, 'x'.repeat(50)).tag.name.length, 20);
  // 空名拒绝
  assert.throws(() => tags.renameTag(db, t1.id, '   '), /不能为空/);
  // 改名后资产仍挂在它下面（改名不该动成员关系）
  assert.equal(tags.assetIdsInTag(db, t1.id).length, 2);
  assert.deepEqual(tags.tagsOfAsset(db, a.id).map(t => t.id), [t1.id]);
  // 另一个标签没被牵连
  assert.equal(tags.getTag(db, t2.id).name, '新能源');
  db.close();
});

test('改名不存在的标签 → NOT_FOUND', () => {
  const db = tmpDb();
  assert.throws(() => tags.renameTag(db, 't-nope', 'x'), /不存在/);
  db.close();
});

test('标签自身顺序：拖动后持久化，且不影响标签内资产顺序', () => {
  const db = tmpDb();
  const { a, b } = fixture(db);
  const t1 = tags.createTag(db, { name: '电动车' }).tag;
  const t2 = tags.createTag(db, { name: '新能源' }).tag;
  const t3 = tags.createTag(db, { name: '待观察' }).tag;
  for (const x of [a, b]) {
    for (const t of [t1, t2, t3]) tags.setAssetTags(db, x.id, tags.tagsOfAsset(db, x.id).map(y => y.id).concat(t.id));
  }
  const innerBefore = tags.assetIdsInTag(db, t1.id);

  // 把 t3 拖到最前
  tags.reorderTags(db, [t3.id, t1.id, t2.id]);
  assert.deepEqual(tags.listTags(db).map(t => t.name), ['标星', '待观察', '电动车', '新能源']);

  // 关键：标签**之间**的顺序变了，标签**内部**资产的顺序不受影响
  assert.deepEqual(tags.assetIdsInTag(db, t1.id), innerBefore);
  db.close();
});

test('标签自身顺序：重排后仍是 0..n-1 连续，且内置标星恒为 0', () => {
  const db = tmpDb();
  const t1 = tags.createTag(db, { name: 'A' }).tag;
  const t2 = tags.createTag(db, { name: 'B' }).tag;
  const t3 = tags.createTag(db, { name: 'C' }).tag;
  tags.reorderTags(db, [t3.id, t1.id, t2.id]);
  const rows = db.prepare('SELECT id, sort_order FROM watchlist_tags ORDER BY sort_order').all();
  assert.equal(rows[0].id, tags.STAR_TAG_ID, '内置标星恒排第一');
  assert.deepEqual(rows.map(r => r.sort_order), [0, 1, 2, 3], '排序必须连续');
  assert.deepEqual(rows.slice(1).map(r => r.id), [t3.id, t1.id, t2.id]);
  db.close();
});

test('删除中间标签后，标签自身顺序也补位（不留空洞）', () => {
  const db = tmpDb();
  const t1 = tags.createTag(db, { name: 'A' }).tag;
  const t2 = tags.createTag(db, { name: 'B' }).tag;
  const t3 = tags.createTag(db, { name: 'C' }).tag;
  tags.deleteTag(db, t2.id);
  const rows = db.prepare('SELECT id, sort_order, is_star FROM watchlist_tags ORDER BY sort_order').all();
  assert.deepEqual(rows.map(r => r.sort_order), [0, 1, 2]);
  assert.deepEqual(rows.filter(r => !r.is_star).map(r => r.id), [t1.id, t3.id]);
  db.close();
});

test('改名后 listTags 的顺序不变（改名不该移动标签）', () => {
  const db = tmpDb();
  const t1 = tags.createTag(db, { name: 'A' }).tag;
  const t2 = tags.createTag(db, { name: 'B' }).tag;
  const before = tags.listTags(db).map(t => t.id);
  tags.renameTag(db, t1.id, 'Z').tag;
  assert.deepEqual(tags.listTags(db).map(t => t.id), before, '改名前后顺序一致');
  assert.deepEqual(tags.listTags(db).map(t => t.name), ['标星', 'Z', 'B']);
  db.close();
});
