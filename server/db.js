// SQLite 打开与版本化迁移。schema_migrations 记录已应用版本；迁移全部幂等可重放。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  {
    version: 1,
    up: `
      CREATE TABLE watchlist_assets (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('us','hk','a_share','crypto','index')),
        symbol TEXT NOT NULL,
        normalized_symbol TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        show_changes INTEGER NOT NULL DEFAULT 1,
        is_starred INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_assets_cat_norm ON watchlist_assets(category, normalized_symbol);
      CREATE INDEX idx_assets_cat_order ON watchlist_assets(category, sort_order, id);

      CREATE TABLE watchlist_quotes (
        asset_id TEXT PRIMARY KEY REFERENCES watchlist_assets(id) ON DELETE CASCADE,
        price REAL,
        price_currency TEXT,
        chg_pct REAL,
        week_pct REAL,
        month_pct REAL,
        market_cap REAL,
        market_cap_currency TEXT,
        source_name TEXT,
        status TEXT NOT NULL DEFAULT 'unavailable'
          CHECK (status IN ('ok','partial','unavailable','refreshing')),
        error_message TEXT,
        updated_at TEXT,
        last_success_at TEXT
      );

      CREATE TABLE watchlist_refresh_jobs (
        id TEXT PRIMARY KEY,
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('scheduled','manual')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
        ok_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT
      );

      CREATE TABLE watchlist_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO watchlist_meta(key, value) VALUES ('config_version', '0');
    `,
  },
  {
    // 2026-09-20：鉴权从「单一写令牌」改成「用户名/密码登录 + 可选服务令牌」。
    // 会话令牌只存 sha256 —— 库被读走也不等于能登录。
    version: 2,
    up: `
      CREATE TABLE auth_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX idx_auth_sessions_expires ON auth_sessions(expires_at);
    `,
  },
  {
    // 2026-09-21：资产详情 K 线按需缓存。与 watchlist_quotes（10 分钟最新快照）分开：
    // 这里存的是 OHLCV 历史，只在用户打开详情/切换周期时按资产拉取，不做批量预热。
    // 主键天然幂等 —— 增量 upsert 靠 ON CONFLICT(asset_id, interval, open_time_ms)。
    // ON DELETE CASCADE：删资产即清其 K 线（PRAGMA foreign_keys=ON 已开）。
    version: 3,
    up: `
      CREATE TABLE watchlist_candles (
        asset_id TEXT NOT NULL REFERENCES watchlist_assets(id) ON DELETE CASCADE,
        interval TEXT NOT NULL CHECK (interval IN ('1d','1w','1M')),
        open_time_ms INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL,
        source_name TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, interval, open_time_ms)
      );
      CREATE INDEX idx_candles_lookup
        ON watchlist_candles(asset_id, interval, open_time_ms DESC);
    `,
  },
  {
    // 2026-09-21：前端支持联动缩放（最多看 150 根），于是同一个 interval 会有多个
    // range 档位（如 1d 的 6mo / 1y / 2y）。此前缓存只按 (asset_id, interval) 判定，
    // 请求 1y 时会把 6mo 的数据当成命中直接返回 —— 必须记录「这批数据覆盖到哪个 range」，
    // 否则放大后永远拿不到更长历史。
    version: 4,
    up: `
      ALTER TABLE watchlist_candles ADD COLUMN range TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    // 2026-09-21：美股盘前/盘后价。只有美股有（港股 hasPrePostMarketData=false），
    // 所以三列都可空；缺失一律 NULL，不写 0。
    //   pre_price    扩展时段最新价
    //   pre_chg_pct  相对「上一日收盘」的涨跌幅（用户指定的基准）
    //   pre_session  'pre' | 'post'，用于前端标注是盘前还是盘后
    version: 5,
    up: `
      ALTER TABLE watchlist_quotes ADD COLUMN pre_price REAL;
      ALTER TABLE watchlist_quotes ADD COLUMN pre_chg_pct REAL;
      ALTER TABLE watchlist_quotes ADD COLUMN pre_session TEXT;
    `,
  },
  {
    // 2026-09-22：持仓与投资估值从 MyInfo 迁入，Invest 成为唯一真相源。
    //
    // 与自选是**两套独立能力**：持仓表、持仓报价缓存、配置版本全部与 watchlist_* 分开，
    // 只共用底层行情适配器。持仓不会自动进 watchlist_assets，自选也不会被当成持仓。
    //
    // portfolio_quotes 的主键是 (quote_category, normalized_symbol) 而不是 holding_id ——
    // 同一标的在多个渠道持有只缓存一份、只发一次上游请求，这是去重的落点。
    //
    // 所有价格/FX 列都可为 NULL：取不到就是 NULL，绝不写 0（0 会被当成真实价格计入总额）。
    version: 6,
    up: `
      CREATE TABLE portfolio_channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE portfolio_asset_types (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE portfolio_holdings (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL REFERENCES portfolio_channels(id) ON DELETE CASCADE,
        asset_type_id TEXT NOT NULL REFERENCES portfolio_asset_types(id) ON DELETE CASCADE,
        symbol TEXT NOT NULL,
        quote_category TEXT NOT NULL
          CHECK (quote_category IN ('us','hk','a_share','crypto','index')),
        normalized_symbol TEXT NOT NULL,
        quantity REAL NOT NULL CHECK (quantity > 0),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_holdings_channel ON portfolio_holdings(channel_id);
      CREATE INDEX idx_holdings_type ON portfolio_holdings(asset_type_id);
      CREATE INDEX idx_holdings_quote_key
        ON portfolio_holdings(quote_category, normalized_symbol);

      CREATE TABLE portfolio_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE portfolio_quotes (
        quote_category TEXT NOT NULL,
        normalized_symbol TEXT NOT NULL,
        price REAL,
        price_currency TEXT,
        chg_pct REAL,
        week_pct REAL,
        month_pct REAL,
        source_name TEXT,
        status TEXT NOT NULL DEFAULT 'unavailable'
          CHECK (status IN ('ok','unavailable')),
        error_message TEXT,
        updated_at TEXT,
        last_success_at TEXT,
        PRIMARY KEY (quote_category, normalized_symbol)
      );

      CREATE TABLE portfolio_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO portfolio_meta(key, value) VALUES ('config_version', '0');

      CREATE TABLE portfolio_refresh_jobs (
        id TEXT PRIMARY KEY,
        trigger_source TEXT NOT NULL CHECK (trigger_source IN ('scheduled','manual')),
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running'
          CHECK (status IN ('running','ok','partial','failed')),
        ok_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT
      );
    `,
  },
  {
    // 2026-09-22：让 K 线缓存也能服务「持仓」标的。
    //
    // 原表 watchlist_candles.asset_id 对 watchlist_assets(id) 有外键，
    // 而持仓没有 watchlist_assets 行，插不进去（实测 FOREIGN KEY constraint failed）。
    // 又不该为了看图把持仓写进自选 —— 那会污染自选列表。
    //
    // 做法：重建表，用 `owner` + `owner_key` 表示归属：
    //   owner='watch' + owner_key=<watchlist asset id>  → 自选，仍受外键约束级联删除
    //   owner='pf'    + owner_key=<category>:<symbol>   → 持仓，无外键（持仓删除时由代码清理）
    // 外键放在 watch_asset_id 这一列上（仅 owner='watch' 时非空），
    // 这样「删自选资产级联清 K 线」的既有行为完全保留。
    // 现有数据全部迁成 owner='watch'。
    version: 7,
    up: `
      CREATE TABLE candle_cache (
        owner TEXT NOT NULL CHECK (owner IN ('watch','pf')),
        owner_key TEXT NOT NULL,
        interval TEXT NOT NULL CHECK (interval IN ('1d','1w','1M')),
        open_time_ms INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL,
        source_name TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        range TEXT NOT NULL DEFAULT '',
        watch_asset_id TEXT REFERENCES watchlist_assets(id) ON DELETE CASCADE,
        PRIMARY KEY (owner, owner_key, interval, open_time_ms)
      );
      CREATE INDEX idx_candle_cache_lookup
        ON candle_cache(owner, owner_key, interval, open_time_ms DESC);
      CREATE INDEX idx_candle_cache_watch
        ON candle_cache(watch_asset_id);

      INSERT INTO candle_cache
        (owner, owner_key, interval, open_time_ms, open, high, low, close, volume,
         source_name, fetched_at, range, watch_asset_id)
      SELECT 'watch', asset_id, interval, open_time_ms, open, high, low, close, volume,
             source_name, fetched_at, range, asset_id
      FROM watchlist_candles;

      DROP TABLE watchlist_candles;
    `,
  },
  {
    // 2026-09-23：标签体系。
    //
    // 背景：category 同时承担了两件事 ——「取数/规范化规则」和「侧边栏页签」。
    // 前者是系统事实（6 位数字才能是 A 股），后者是用户视角。用户要的是
    // 「市场单选前置 + 标签多选后置」，且标签能跨市场（电动车 = 美股理想 + A 股比亚迪），
    // 每个标签还要有独立排序 —— 单一 sort_order 列表达不了。
    //
    // 做法：新增三张表，category 原样保留（MyInfo 消费者依赖它，且它仍是
    // 校验与数据源路由的依据），标签是**纯视图**（多对多引用，不复制资产）。
    //
    //   watchlist_tags       标签实体。is_star=1 的那条是内置「标星」标签。
    //   watchlist_asset_tags 资产↔标签多对多。删除标签只清关系，资产保留。
    //   watchlist_tag_order  标签内独立排序。与 watchlist_assets.sort_order 无关。
    //
    // 迁移：把现有 is_starred=1 的资产挂到内置标星标签下，并按其当前
    // 全局顺序（分类序 → 分类内 sort_order）初始化标星标签的排序，
    // 保证升级后标星页的默认顺序与升级前肉眼一致。
    version: 8,
    up: `
      CREATE TABLE watchlist_tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_star INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_tags_name ON watchlist_tags(name);
      CREATE UNIQUE INDEX idx_tags_single_star ON watchlist_tags(is_star) WHERE is_star = 1;

      CREATE TABLE watchlist_asset_tags (
        asset_id TEXT NOT NULL REFERENCES watchlist_assets(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES watchlist_tags(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (asset_id, tag_id)
      );
      CREATE INDEX idx_asset_tags_tag ON watchlist_asset_tags(tag_id);

      CREATE TABLE watchlist_tag_order (
        tag_id TEXT NOT NULL REFERENCES watchlist_tags(id) ON DELETE CASCADE,
        asset_id TEXT NOT NULL REFERENCES watchlist_assets(id) ON DELETE CASCADE,
        sort_order INTEGER NOT NULL,
        PRIMARY KEY (tag_id, asset_id)
      );
      CREATE INDEX idx_tag_order_lookup ON watchlist_tag_order(tag_id, sort_order);

      INSERT INTO watchlist_tags (id, name, is_star, sort_order, created_at, updated_at)
      VALUES ('tag-star', '标星', 1, 0, datetime('now'), datetime('now'));

      INSERT INTO watchlist_asset_tags (asset_id, tag_id, created_at)
      SELECT id, 'tag-star', datetime('now') FROM watchlist_assets WHERE is_starred = 1;

      INSERT INTO watchlist_tag_order (tag_id, asset_id, sort_order)
      SELECT 'tag-star', id,
             ROW_NUMBER() OVER (
               ORDER BY CASE category
                 WHEN 'us' THEN 0 WHEN 'hk' THEN 1 WHEN 'a_share' THEN 2
                 WHEN 'crypto' THEN 3 ELSE 4 END,
                 sort_order ASC, id ASC
             ) - 1
      FROM watchlist_assets WHERE is_starred = 1;
    `,
  },
];

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => Number(r.version))
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        m.version, new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

// 当前代码支持的最新 schema 版本。测试用它断言「升到最新」，
// 免得每加一次 migration 都要去改散落各处的硬编码数字。
export function LATEST_SCHEMA_VERSION() {
  return MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);
}

export function schemaVersion(db) {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return Number(row?.v || 0);
}

// 手动事务包装：node:sqlite 没有 better-sqlite3 的 db.transaction()
export function withTransaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}
