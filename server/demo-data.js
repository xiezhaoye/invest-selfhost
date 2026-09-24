// 开源版首次启动的演示数据。
// 只在「行情和资产配置都完全为空」时写入，绝不覆盖已有用户数据。
import { withTransaction } from './db.js';

const DEMO_ASSETS = [
  { id: 'demo-aapl', category: 'us', symbol: 'AAPL', normalized: 'AAPL', name: 'Apple（示例）', starred: 1, sort: 0 },
  { id: 'demo-nvda', category: 'us', symbol: 'NVDA', normalized: 'NVDA', name: 'NVIDIA（示例）', starred: 1, sort: 1 },
  { id: 'demo-btc', category: 'crypto', symbol: 'BTC', normalized: 'BTC', name: '比特币（示例）', starred: 0, sort: 0 },
  { id: 'demo-pab', category: 'a_share', symbol: '000001', normalized: '000001', name: '平安银行（示例）', starred: 0, sort: 0 },
];

const DEMO_QUOTES = [
  ['demo-aapl', 210, 'USD', 0.72, 1.86, 3.14, 3.1e12, 'USD'],
  ['demo-nvda', 125, 'USD', -0.48, 2.63, 5.92, 3.0e12, 'USD'],
  ['demo-btc', 100000, 'USDT', 1.12, 4.2, 8.56, 2.0e12, 'USD'],
  ['demo-pab', 11.2, 'CNY', 0.35, -0.8, 1.46, 2.2e11, 'CNY'],
];

function isPristine(db) {
  const tables = ['watchlist_assets', 'portfolio_channels', 'portfolio_asset_types', 'portfolio_holdings'];
  return tables.every(table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n === 0);
}

export function seedDemoData(db) {
  if (!isPristine(db)) return false;
  const now = new Date().toISOString();

  withTransaction(db, () => {
    const insertAsset = db.prepare(`
      INSERT INTO watchlist_assets
        (id, category, symbol, normalized_symbol, name, show_changes, is_starred, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `);
    for (const asset of DEMO_ASSETS) {
      insertAsset.run(asset.id, asset.category, asset.symbol, asset.normalized, asset.name,
        asset.starred, asset.sort, now, now);
    }

    const insertQuote = db.prepare(`
      INSERT INTO watchlist_quotes
        (asset_id, price, price_currency, chg_pct, week_pct, month_pct, market_cap, market_cap_currency,
         source_name, status, updated_at, last_success_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo', 'ok', ?, ?)
    `);
    for (const quote of DEMO_QUOTES) insertQuote.run(...quote, now, now);

    db.prepare(`
      INSERT INTO watchlist_asset_tags (asset_id, tag_id, created_at)
      VALUES (?, 'tag-star', ?)
    `).run('demo-aapl', now);
    db.prepare(`
      INSERT INTO watchlist_asset_tags (asset_id, tag_id, created_at)
      VALUES (?, 'tag-star', ?)
    `).run('demo-nvda', now);
    db.prepare(`
      INSERT INTO watchlist_tag_order (tag_id, asset_id, sort_order)
      VALUES ('tag-star', ?, ?)
    `).run('demo-aapl', 0);
    db.prepare(`
      INSERT INTO watchlist_tag_order (tag_id, asset_id, sort_order)
      VALUES ('tag-star', ?, ?)
    `).run('demo-nvda', 1);
    db.prepare("UPDATE watchlist_meta SET value = '1' WHERE key = 'config_version'").run();

    const insertChannel = db.prepare(`
      INSERT INTO portfolio_channels (id, name, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertChannel.run('demo-account', '示例账户', '#2f6bde', 0, now, now);
    const insertType = db.prepare(`
      INSERT INTO portfolio_asset_types (id, name, color, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertType.run('demo-stock', '股票', '#2f6bde', 0, now, now);
    insertType.run('demo-crypto', '加密资产', '#8a53d8', 1, now, now);
    const insertHolding = db.prepare(`
      INSERT INTO portfolio_holdings
        (id, channel_id, asset_type_id, symbol, quote_category, normalized_symbol, quantity, sort_order, created_at, updated_at)
      VALUES (?, 'demo-account', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertHolding.run('demo-holding-aapl', 'demo-stock', 'AAPL', 'us', 'AAPL', 12, 0, now, now);
    insertHolding.run('demo-holding-btc', 'demo-crypto', 'BTC', 'crypto', 'BTC', 0.03, 1, now, now);
    const insertPortfolioQuote = db.prepare(`
      INSERT INTO portfolio_quotes
        (quote_category, normalized_symbol, price, price_currency, chg_pct, week_pct, month_pct,
         source_name, status, updated_at, last_success_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'demo', 'ok', ?, ?)
    `);
    insertPortfolioQuote.run('us', 'AAPL', 210, 'USD', 0.72, 1.86, 3.14, now, now);
    insertPortfolioQuote.run('crypto', 'BTC', 100000, 'USDT', 1.12, 4.2, 8.56, now, now);
    const preference = db.prepare(`
      INSERT INTO portfolio_preferences (key, value, updated_at) VALUES (?, ?, ?)
    `);
    preference.run('display_currency', 'USD', now);
    preference.run('usd_cny_rate', '7.15', now);
    db.prepare("UPDATE portfolio_meta SET value = '1' WHERE key = 'config_version'").run();
  });
  return true;
}
