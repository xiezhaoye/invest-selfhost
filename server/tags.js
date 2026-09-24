// 标签：资产的**视图**归属（多对多），与 category（市场事实）正交。
//
// 设计要点（2026-09-23 与用户确认）：
//   - 标签是视图，不是属性副本：同一资产挂多个标签，只有一条 watchlist_assets 行，
//     改名字/删资产在所有标签下同时生效。
//   - 每个标签有**独立排序**，存在 watchlist_tag_order；不动其他标签，也不动
//     watchlist_assets.sort_order（后者仍是「分类页」的排序）。
//   - 新资产一律**追加到末尾**；一旦手动拖过就锁定手动序，不再自动重排。
//   - 删除标签 = 直接删，关系清掉，资产保留。
//   - 内置「标星」标签（is_star=1）不可删除、不可改名，保证前端「标星」入口永远存在。
import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { ValidationError } from './normalize.js';

export const STAR_TAG_ID = 'tag-star';
const MAX_NAME = 20;

function now() {
  return new Date().toISOString();
}

function getVersion(db) {
  const row = db.prepare("SELECT value FROM watchlist_meta WHERE key = 'config_version'").get();
  return Number(row?.value || 0);
}

function bumpVersion(db) {
  db.prepare("UPDATE watchlist_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'config_version'").run();
  return getVersion(db);
}

export function cleanTagName(name) {
  const s = String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME);
  if (!s) throw new ValidationError('标签名不能为空');
  return s;
}

function rowToTag(r) {
  return {
    id: r.id,
    name: r.name,
    is_star: !!r.is_star,
    sort_order: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listTags(db) {
  // 内置标星标签恒排第一，其余按用户定义的标签顺序。
  return db.prepare(
    'SELECT * FROM watchlist_tags ORDER BY is_star DESC, sort_order ASC, id ASC'
  ).all().map(rowToTag);
}

export function getTag(db, id) {
  const r = db.prepare('SELECT * FROM watchlist_tags WHERE id = ?').get(id);
  return r ? rowToTag(r) : null;
}

// 大小写不敏感查重：SQLite 的 UNIQUE 索引默认区分大小写，
// 但用户眼里「电动车」和「电动车 」是同一个，英文标签更不该因大小写分裂成两个。
function findByNameCI(db, name) {
  const r = db.prepare('SELECT * FROM watchlist_tags WHERE name = ? COLLATE NOCASE').get(name);
  return r ? rowToTag(r) : null;
}

// 新增标签。重名直接返回已有标签（幂等），这样「新增资产时就地建标签」
// 重复点两次不会报错，也不会造出两个同名标签。
export function createTag(db, { name }) {
  const clean = cleanTagName(name);
  const existing = findByNameCI(db, clean);
  if (existing) return { tag: existing, version: getVersion(db), existed: true };

  const id = `t-${randomUUID()}`;
  const ts = now();
  let tag;
  withTransaction(db, () => {
    // 标签自身在侧边栏的排列顺序：排在内置标星之后。
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM watchlist_tags WHERE is_star = 0').get().m;
    db.prepare(`
      INSERT INTO watchlist_tags (id, name, is_star, sort_order, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, ?)
    `).run(id, clean, Number(max) + 1, ts, ts);
    bumpVersion(db);
    tag = getTag(db, id);
  });
  return { tag, version: getVersion(db), existed: false };
}

export function renameTag(db, id, name) {
  const tag = getTag(db, id);
  if (!tag) {
    const e = new Error('标签不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (tag.is_star) throw new ValidationError('内置「标星」标签不可改名');
  const clean = cleanTagName(name);
  const dup = findByNameCI(db, clean);
  if (dup && dup.id !== id) throw new ValidationError(`已存在同名标签：${clean}`);

  withTransaction(db, () => {
    db.prepare('UPDATE watchlist_tags SET name = ?, updated_at = ? WHERE id = ?').run(clean, now(), id);
    bumpVersion(db);
  });
  return { tag: getTag(db, id), version: getVersion(db) };
}

// 删除标签：关系与排序由外键 ON DELETE CASCADE 清理，**资产本身保留**。
export function deleteTag(db, id) {
  const tag = getTag(db, id);
  if (!tag) {
    const e = new Error('标签不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (tag.is_star) throw new ValidationError('内置「标星」标签不可删除');
  withTransaction(db, () => {
    db.prepare('DELETE FROM watchlist_tags WHERE id = ?').run(id);
    const rest = db.prepare(
      'SELECT id FROM watchlist_tags WHERE is_star = 0 ORDER BY sort_order ASC, id ASC'
    ).all();
    const upd = db.prepare('UPDATE watchlist_tags SET sort_order = ? WHERE id = ?');
    rest.forEach((r, i) => upd.run(i + 1, r.id));
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

// 标签自身的排列顺序（侧边栏顺序）。ids 必须恰好是全部**非内置**标签的一个排列。
export function reorderTags(db, ids) {
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
    throw new ValidationError('ids 必须是字符串数组');
  }
  const current = db.prepare(
    'SELECT id FROM watchlist_tags WHERE is_star = 0 ORDER BY sort_order ASC, id ASC'
  ).all().map(r => r.id);
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) throw new ValidationError('ids 存在重复');
  if (current.length !== ids.length || !current.every(id => wanted.has(id))) {
    throw new ValidationError('ids 必须与现有自定义标签完全一致（不多不少）');
  }
  withTransaction(db, () => {
    const upd = db.prepare('UPDATE watchlist_tags SET sort_order = ?, updated_at = ? WHERE id = ?');
    ids.forEach((id, i) => upd.run(i + 1, now(), id));
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

// ── 资产 ↔ 标签 ──────────────────────────────────────────────

export function tagsOfAsset(db, assetId) {
  return db.prepare(`
    SELECT t.* FROM watchlist_tags t
    JOIN watchlist_asset_tags x ON x.tag_id = t.id
    WHERE x.asset_id = ?
    ORDER BY t.is_star DESC, t.sort_order ASC, t.id ASC
  `).all(assetId).map(rowToTag);
}

// 全量查出「asset_id → tag_id[]」，供列表接口一次填充，避免 N+1。
export function tagMapForAssets(db) {
  const rows = db.prepare('SELECT asset_id, tag_id FROM watchlist_asset_tags').all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.asset_id)) map.set(r.asset_id, []);
    map.get(r.asset_id).push(r.tag_id);
  }
  return map;
}

// 全量查出「tag_id → asset_id[]」，按各标签自己的顺序。
// 前端要靠它渲染标签页的顺序 —— 这个顺序存在 watchlist_tag_order，
// 无法从资产的 tag_ids 反推（tag_ids 只有成员关系，没有次序）。
export function tagOrderMap(db) {
  const rows = db.prepare(`
    SELECT o.tag_id, o.asset_id FROM watchlist_tag_order o
    JOIN watchlist_asset_tags x ON x.asset_id = o.asset_id AND x.tag_id = o.tag_id
    ORDER BY o.tag_id ASC, o.sort_order ASC, o.asset_id ASC
  `).all();
  const map = {};
  for (const r of rows) {
    if (!map[r.tag_id]) map[r.tag_id] = [];
    map[r.tag_id].push(r.asset_id);
  }
  return map;
}

// 挂标签/取消挂标签。新增时**追加到该标签末尾**；取消时压缩该标签的排序为 0..n-1。
export function setAssetTags(db, assetId, tagIds) {
  if (!Array.isArray(tagIds) || tagIds.some(i => typeof i !== 'string')) {
    throw new ValidationError('tag_ids 必须是字符串数组');
  }
  const wanted = [...new Set(tagIds)];
  for (const tid of wanted) {
    if (!getTag(db, tid)) throw new ValidationError(`标签不存在：${tid}`);
  }
  const current = db.prepare('SELECT tag_id FROM watchlist_asset_tags WHERE asset_id = ?')
    .all(assetId).map(r => r.tag_id);
  const currentSet = new Set(current);
  const wantedSet = new Set(wanted);

  const toAdd = wanted.filter(t => !currentSet.has(t));
  const toRemove = current.filter(t => !wantedSet.has(t));
  if (toAdd.length === 0 && toRemove.length === 0) return { version: getVersion(db) };

  withTransaction(db, () => {
    const ins = db.prepare(
      'INSERT INTO watchlist_asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)'
    );
    const del = db.prepare('DELETE FROM watchlist_asset_tags WHERE asset_id = ? AND tag_id = ?');
    const nextOrder = db.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM watchlist_tag_order WHERE tag_id = ?'
    );
    const putOrder = db.prepare(
      'INSERT INTO watchlist_tag_order (tag_id, asset_id, sort_order) VALUES (?, ?, ?)'
    );
    const delOrder = db.prepare('DELETE FROM watchlist_tag_order WHERE tag_id = ? AND asset_id = ?');

    for (const t of toAdd) {
      ins.run(assetId, t, now());
      putOrder.run(t, assetId, Number(nextOrder.get(t).n));   // 追加到末尾
    }
    for (const t of toRemove) {
      del.run(assetId, t);
      delOrder.run(t, assetId);
      compactTagOrder(db, t);
    }
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

// 把某个标签的排序压成 0..n-1 连续序列，并清掉指向已删除资产/关系的孤儿行。
export function compactTagOrder(db, tagId) {
  const rows = db.prepare(`
    SELECT o.asset_id FROM watchlist_tag_order o
    JOIN watchlist_asset_tags x ON x.asset_id = o.asset_id AND x.tag_id = o.tag_id
    WHERE o.tag_id = ?
    ORDER BY o.sort_order ASC, o.asset_id ASC
  `).all(tagId);
  const keep = new Set(rows.map(r => r.asset_id));
  const orphans = db.prepare('SELECT asset_id FROM watchlist_tag_order WHERE tag_id = ?')
    .all(tagId).map(r => r.asset_id).filter(a => !keep.has(a));
  const del = db.prepare('DELETE FROM watchlist_tag_order WHERE tag_id = ? AND asset_id = ?');
  for (const a of orphans) del.run(tagId, a);
  const upd = db.prepare('UPDATE watchlist_tag_order SET sort_order = ? WHERE tag_id = ? AND asset_id = ?');
  rows.forEach((r, i) => upd.run(i, tagId, r.asset_id));
}

// 标签内资产 id 序列（用于前端拖拽与接口校验）。
export function assetIdsInTag(db, tagId) {
  return db.prepare(`
    SELECT o.asset_id FROM watchlist_tag_order o
    JOIN watchlist_asset_tags x ON x.asset_id = o.asset_id AND x.tag_id = o.tag_id
    WHERE o.tag_id = ?
    ORDER BY o.sort_order ASC, o.asset_id ASC
  `).all(tagId).map(r => r.asset_id);
}

// 标签内独立排序。ids 必须恰好是该标签下全部资产的一个排列。
// 与 reorderCategory 的关键区别：**跨市场**，且只影响这一个标签。
export function reorderTag(db, tagId, ids) {
  const tag = getTag(db, tagId);
  if (!tag) {
    const e = new Error('标签不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
    throw new ValidationError('ids 必须是字符串数组');
  }
  const current = assetIdsInTag(db, tagId);
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) throw new ValidationError('ids 存在重复');
  if (current.length !== ids.length || !current.every(id => wanted.has(id))) {
    throw new ValidationError('ids 必须与该标签下现有资产完全一致（不多不少）');
  }
  withTransaction(db, () => {
    const upd = db.prepare(
      'UPDATE watchlist_tag_order SET sort_order = ? WHERE tag_id = ? AND asset_id = ?'
    );
    ids.forEach((id, i) => upd.run(i, tagId, id));
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

// 把 is_starred 这个历史布尔列与内置标星标签的双向同步收在一处。
// 仍然写 is_starred 是为了 MyInfo 消费者（它读该字段）不被中断。
export function setStarred(db, assetId, starred) {
  withTransaction(db, () => {
    db.prepare('UPDATE watchlist_assets SET is_starred = ?, updated_at = ? WHERE id = ?')
      .run(starred ? 1 : 0, now(), assetId);
    const has = db.prepare(
      'SELECT 1 AS x FROM watchlist_asset_tags WHERE asset_id = ? AND tag_id = ?'
    ).get(assetId, STAR_TAG_ID);
    if (starred && !has) {
      db.prepare('INSERT INTO watchlist_asset_tags (asset_id, tag_id, created_at) VALUES (?, ?, ?)')
        .run(assetId, STAR_TAG_ID, now());
      const n = db.prepare(
        'SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM watchlist_tag_order WHERE tag_id = ?'
      ).get(STAR_TAG_ID).n;
      db.prepare('INSERT INTO watchlist_tag_order (tag_id, asset_id, sort_order) VALUES (?, ?, ?)')
        .run(STAR_TAG_ID, assetId, Number(n));
    } else if (!starred && has) {
      db.prepare('DELETE FROM watchlist_asset_tags WHERE asset_id = ? AND tag_id = ?')
        .run(assetId, STAR_TAG_ID);
      db.prepare('DELETE FROM watchlist_tag_order WHERE tag_id = ? AND asset_id = ?')
        .run(STAR_TAG_ID, assetId);
      compactTagOrder(db, STAR_TAG_ID);
    }
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

export { bumpVersion as bumpConfigVersion };
