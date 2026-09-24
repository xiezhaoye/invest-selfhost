// 资产配置的领域操作：CRUD / 分类内排序 / 标星 / 配置版本。
// sort_order 语义：分类内 0..n-1；跨分类展示顺序由分类固定序决定。
import { randomUUID } from 'node:crypto';
import { withTransaction } from './db.js';
import { CATEGORIES, validateAndNormalize, ValidationError } from './normalize.js';
import { setAssetTags, setStarred, tagsOfAsset, tagMapForAssets, compactTagOrder, listTags, STAR_TAG_ID } from './tags.js';

const CATEGORY_RANK = Object.fromEntries(CATEGORIES.map((c, i) => [c, i]));

function now() {
  return new Date().toISOString();
}

export function getVersion(db) {
  const row = db.prepare("SELECT value FROM watchlist_meta WHERE key = 'config_version'").get();
  return Number(row?.value || 0);
}

function bumpVersion(db) {
  db.prepare("UPDATE watchlist_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'config_version'").run();
  return getVersion(db);
}

function rowToAsset(r, tagIds) {
  return {
    id: r.id,
    category: r.category,
    symbol: r.symbol,
    normalized_symbol: r.normalized_symbol,
    name: r.name || '',
    show_changes: !!r.show_changes,
    is_starred: !!r.is_starred,
    tag_ids: tagIds || [],
    tags: (tagIds || []).map(id => tagById.get(id)).filter(Boolean),
    sort_order: r.sort_order,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// 由 listAssets 填充，避免 N+1 查询；单条路径下为空 Map 即退化为按 id 查。
let tagById = new Map();

function loadTagIndex(db) {
  tagById = new Map(listTags(db).map(t => [t.id, t]));
}

export function listAssets(db) {
  const rows = db.prepare(`
    SELECT * FROM watchlist_assets
    ORDER BY CASE category
      WHEN 'us' THEN 0 WHEN 'hk' THEN 1 WHEN 'a_share' THEN 2 WHEN 'crypto' THEN 3 ELSE 4 END,
      sort_order ASC, id ASC
  `).all();
  loadTagIndex(db);
  const map = tagMapForAssets(db);
  return rows.map(r => rowToAsset(r, map.get(r.id) || []));
}

export function getAsset(db, id) {
  const r = db.prepare('SELECT * FROM watchlist_assets WHERE id = ?').get(id);
  if (!r) return null;
  loadTagIndex(db);
  return rowToAsset(r, tagsOfAsset(db, id).map(t => t.id));
}

export function findByNormalized(db, category, normalizedSymbol) {
  const r = db.prepare('SELECT * FROM watchlist_assets WHERE category = ? AND normalized_symbol = ?')
    .get(category, normalizedSymbol);
  return r ? rowToAsset(r) : null;
}

export function createAsset(db, { category, symbol, name, show_changes = true, is_starred = false, tag_ids }) {
  const { symbol: sym, normalized_symbol } = validateAndNormalize(category, symbol);
  const cleanName = String(name ?? '').trim().slice(0, 40);
  const dup = findByNormalized(db, category, normalized_symbol);
  if (dup) {
    const e = new Error(`该分类下已存在相同代码（${dup.symbol}）`);
    e.code = 'DUPLICATE_ASSET';
    throw e;
  }
  const id = `a-${randomUUID()}`;
  const ts = now();
  let asset;
  withTransaction(db, () => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM watchlist_assets WHERE category = ?')
      .get(category).m;
    db.prepare(`
      INSERT INTO watchlist_assets
        (id, category, symbol, normalized_symbol, name, show_changes, is_starred, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, category, sym, normalized_symbol, cleanName, show_changes ? 1 : 0, is_starred ? 1 : 0,
      Number(max) + 1, ts, ts);
    bumpVersion(db);
  });
  // 标签在事务外挂，复用 setAssetTags 的「追加到末尾」语义；
  // 内置标星标签走 setStarred，保证 is_starred 列与标签关系不打架。
  if (Array.isArray(tag_ids) && tag_ids.length) {
    const nonStar = tag_ids.filter(t => t !== STAR_TAG_ID);
    if (nonStar.length) setAssetTags(db, id, nonStar);
    if (tag_ids.includes(STAR_TAG_ID) && !is_starred) setStarred(db, id, true);
  }
  return { asset: getAsset(db, id), version: getVersion(db) };
}

// 允许改 name / show_changes / is_starred / tag_ids；代码与分类不可变。
export function updateAsset(db, id, patch) {
  const existing = getAsset(db, id);
  if (!existing) {
    const e = new Error('资产不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const fields = {};
  if (patch.name !== undefined) fields.name = String(patch.name ?? '').trim().slice(0, 40);
  if (patch.show_changes !== undefined) fields.show_changes = patch.show_changes ? 1 : 0;

  const hasStar = patch.is_starred !== undefined;
  const hasTags = patch.tag_ids !== undefined;
  if (Object.keys(fields).length === 0 && !hasStar && !hasTags) {
    return { asset: existing, version: getVersion(db) };
  }

  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
    withTransaction(db, () => {
      db.prepare(`UPDATE watchlist_assets SET ${sets}, updated_at = ? WHERE id = ?`)
        .run(...Object.values(fields), now(), id);
      bumpVersion(db);
    });
  }
  // 标星是标签的一种（内置标签），必须走同一条路径，
  // 否则 is_starred 列与 watchlist_asset_tags 会各说各话。
  if (hasStar) setStarred(db, id, !!patch.is_starred);
  if (hasTags) {
    // tag_ids 是**全量替换**语义（与 PUT config 的「草稿即全量」一致）。
    // 其中的内置标星标签同步 is_starred 列，避免两个真相源各说各话。
    const wantsStar = patch.tag_ids.includes(STAR_TAG_ID);
    const nonStar = patch.tag_ids.filter(t => t !== STAR_TAG_ID);
    setAssetTags(db, id, nonStar);
    const isStar = getAsset(db, id).is_starred;
    if (wantsStar !== isStar) setStarred(db, id, wantsStar);
  }
  return { asset: getAsset(db, id), version: getVersion(db) };
}

export function deleteAsset(db, id) {
  const existing = getAsset(db, id);
  if (!existing) {
    const e = new Error('资产不存在');
    e.code = 'NOT_FOUND';
    throw e;
  }
  withTransaction(db, () => {
    // 先记下它挂了哪些标签 —— 删除后关系行就没了，届时就不知道要压缩哪几个标签的序。
    const affectedTags = db.prepare('SELECT tag_id FROM watchlist_asset_tags WHERE asset_id = ?')
      .all(id).map(r => r.tag_id);
    // 行情快照由外键 ON DELETE CASCADE 清理
    db.prepare('DELETE FROM watchlist_assets WHERE id = ?').run(id);
    // 压缩分类内排序，保持 0..n-1 连续
    const rest = db.prepare(
      'SELECT id FROM watchlist_assets WHERE category = ? ORDER BY sort_order ASC, id ASC'
    ).all(existing.category);
    const upd = db.prepare('UPDATE watchlist_assets SET sort_order = ? WHERE id = ?');
    rest.forEach((r, i) => upd.run(i, r.id));
    // 标签内排序同样要压缩：删除会把 watchlist_tag_order 的行级联清掉，
    // 留下的空洞必须填平，否则 label 内会残留 0,1,3,4 这种序列。
    for (const t of affectedTags) compactTagOrder(db, t);
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

// ids 必须恰好是该分类全部资产 ID 的一个排列；事务内重排为 0..n-1。
export function reorderCategory(db, category, ids) {
  if (!CATEGORIES.includes(category)) throw new ValidationError(`不支持的资产类型：${category}`);
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
    throw new ValidationError('ids 必须是字符串数组');
  }
  const current = db.prepare(
    'SELECT id FROM watchlist_assets WHERE category = ? ORDER BY sort_order ASC, id ASC'
  ).all(category).map(r => r.id);
  const wanted = new Set(ids);
  if (wanted.size !== ids.length) throw new ValidationError('ids 存在重复');
  if (current.length !== ids.length || !current.every(id => wanted.has(id))) {
    throw new ValidationError('ids 必须与该分类现有资产完全一致（不多不少）');
  }
  withTransaction(db, () => {
    const upd = db.prepare('UPDATE watchlist_assets SET sort_order = ?, updated_at = ? WHERE id = ?');
    ids.forEach((id, i) => upd.run(i, now(), id));
    bumpVersion(db);
  });
  return { version: getVersion(db) };
}

export { CATEGORY_RANK };
