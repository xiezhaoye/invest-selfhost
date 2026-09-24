// API 集成测试：真实 HTTP 服务 + 临时 SQLite + mock 行情适配器。
// 覆盖：健康检查、鉴权（服务令牌 / 登录会话 / 限流）、CRUD、规范化、查重、
// 版本冲突、排序、刷新（含合并去重、失败隔离、快照保留）、重启持久化。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.INVEST_API_TOKEN = 'test-token';
process.env.INVEST_AUTH_USER = 'tester@example.com';
process.env.INVEST_AUTH_PASS = 'test-pass';

const { createServer } = await import('../server/index.js');
const { openDb } = await import('../server/db.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'invest-test-'));
}

// 可编程 mock 适配器：按 normalized_symbol 决定成功/失败
function fakeAdapters() {
  const quotes = new Map([
    ['AAPL', { price: 268.12, price_currency: 'USD', chg_pct: 0.82, week_pct: 3.15, month_pct: -1.24, market_cap: 4.02e12, market_cap_currency: 'USD', source_name: 'yahoo', name: 'Apple Inc.' }],
    ['2015.HK', { price: 88.9, price_currency: 'HKD', chg_pct: 1.1, week_pct: 2.2, month_pct: null, market_cap: null, market_cap_currency: null, source_name: 'yahoo', name: 'Li Auto' }],
    ['BTC', { price: 98432, price_currency: 'USDT', chg_pct: 1.42, week_pct: 5.68, month_pct: 12.9, market_cap: 1.95e12, market_cap_currency: 'USD', source_name: 'binance', name: null }],
    ['^TNX', { price: 4.128, price_currency: '%', chg_pct: null, week_pct: null, month_pct: null, market_cap: null, market_cap_currency: null, source_name: 'yahoo', name: null }],
  ]);
  const fail = new Set();
  return {
    quotes, fail,
    async fetchWatchlistQuote(category, normalized) {
      if (fail.has(normalized)) throw new Error('行情源暂时不可用（模拟）');
      const q = quotes.get(normalized);
      if (!q) throw new Error(`无法识别该代码：${normalized}`);
      return { ...q };
    },
  };
}

function makeEnv() {
  const dir = tmpDir();
  const adapters = fakeAdapters();
  const jinshiCalendar = {
    async getCalendar() {
      return { events: [{ pub_time: '2026-09-24 09:30:00', star: 3, title: '美国核心 PCE 物价指数', previous: '2.8%', consensus: '2.7%', actual: null }], cached: false, fetched_at: '2026-09-24T01:30:00.000Z' };
    },
  };
  const { server, db, refreshService } = createServer({
    db: openDb(path.join(dir, 'invest.sqlite')),
    adapters,
    jinshiCalendar,
    intervalMs: 60 * 60 * 1000,   // 测试中不触发定时
    concurrency: 4,
  });
  return { dir, server, db, refreshService, adapters, base: null };
}

function openTmpDb(dir) {
  return openDb(path.join(dir, 'invest.sqlite'));
}

async function listen(env) {
  await new Promise(r => env.server.listen(0, '127.0.0.1', r));
  env.base = `http://127.0.0.1:${env.server.address().port}`;
}

async function api(env, method, p, body, headers = {}) {
  const resp = await fetch(env.base + p, {
    method,
    headers: { 'content-type': 'application/json', ...authHeader(env, headers), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await resp.json(); } catch { /* 204 等无体 */ }
  return { status: resp.status, json, headers: resp.headers };
}

function authHeader(env, headers) {
  return headers.authorization ? {} : { authorization: 'Bearer test-token' };
}

test('API 全链路', async (t) => {
  const env = makeEnv();
  await listen(env);
  t.after(() => {
    try { env.refreshService.stop(); } catch { /* already stopped */ }
    try { env.server.close(); } catch { /* already closed */ }
    try { env.db.close(); } catch { /* 重启子测试可能已关闭 */ }
  });

  await t.test('健康检查免鉴权，v1 读接口要凭据', async () => {
    const h = await api(env, 'GET', '/api/health');
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.assets, 0);

    // 不带凭据的读：401（自选数据本身是私有内容，读也拦）
    const anon = await fetch(env.base + '/api/v1/watchlist/assets');
    assert.equal(anon.status, 401);
    assert.equal((await anon.json()).error.code, 'UNAUTHORIZED');

    // 带服务令牌的读：200
    const l = await api(env, 'GET', '/api/v1/watchlist/assets');
    assert.equal(l.status, 200);
    assert.equal(l.json.version, 0);
    assert.deepEqual(l.json.assets, []);

    const calendar = await api(env, 'GET', '/api/v1/calendar');
    assert.equal(calendar.status, 200);
    assert.equal(calendar.json.events[0].title, '美国核心 PCE 物价指数');
  });

  await t.test('登录：错误凭据 401，正确凭据签发会话，会话可读', async () => {
    const bad = await api(env, 'POST', '/api/v1/auth/login', { username: 'tester@example.com', password: 'nope' }, { authorization: 'x' });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'BAD_CREDENTIALS');

    const badUser = await api(env, 'POST', '/api/v1/auth/login', { username: 'other@example.com', password: 'test-pass' }, { authorization: 'x' });
    assert.equal(badUser.status, 401);

    const ok = await api(env, 'POST', '/api/v1/auth/login', { username: 'tester@example.com', password: 'test-pass' }, { authorization: 'x' });
    assert.equal(ok.status, 200);
    assert.match(ok.json.token, /^[0-9a-f]{64}$/);
    assert.equal(ok.json.username, 'tester@example.com');
    assert.ok(Date.parse(ok.json.expires_at) > Date.now());

    // 用会话令牌读（不带服务令牌）
    const withSession = await fetch(env.base + '/api/v1/watchlist/assets', {
      headers: { authorization: `Bearer ${ok.json.token}` },
    });
    assert.equal(withSession.status, 200);

    // session 接口要能区分「谁进来了」
    const s1 = await fetch(env.base + '/api/v1/auth/session', { headers: { authorization: `Bearer ${ok.json.token}` } });
    assert.equal((await s1.json()).kind, 'session');
    const s2 = await fetch(env.base + '/api/v1/auth/session');
    assert.equal((await s2.json()).authenticated, false);

    // 登出后立刻失效
    const out = await api(env, 'POST', '/api/v1/auth/logout', undefined, { authorization: `Bearer ${ok.json.token}` });
    assert.equal(out.status, 200);
    assert.equal(out.json.revoked, true);
    const after = await fetch(env.base + '/api/v1/watchlist/assets', { headers: { authorization: `Bearer ${ok.json.token}` } });
    assert.equal(after.status, 401);
  });

  await t.test('无凭据写入被拒', async () => {
    const r = await fetch(env.base + '/api/v1/watchlist/assets', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'us', symbol: 'AAPL' }),
    });
    assert.equal(r.status, 401);
    const j = await r.json();
    assert.equal(j.error.code, 'UNAUTHORIZED');
  });

  await t.test('新增 + verify 识别失败拒绝创建', async () => {
    const bad = await api(env, 'POST', '/api/v1/watchlist/assets', { category: 'us', symbol: 'ZZZZZ', verify: true });
    assert.equal(bad.status, 422);
    assert.equal(bad.json.error.code, 'SYMBOL_LOOKUP_FAILED');

    const ok = await api(env, 'POST', '/api/v1/watchlist/assets', { category: 'us', symbol: 'aapl', name: '苹果', verify: true });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.asset.symbol, 'AAPL');
    assert.equal(ok.json.asset.normalized_symbol, 'AAPL');
    assert.equal(ok.json.asset.show_changes, true);
    assert.equal(ok.json.version, 1);
  });

  await t.test('同分类规范化代码查重（BTC vs BTCUSDT）', async () => {
    const r1 = await api(env, 'POST', '/api/v1/watchlist/assets', { category: 'crypto', symbol: 'BTC' });
    assert.equal(r1.status, 201);
    const r2 = await api(env, 'POST', '/api/v1/watchlist/assets', { category: 'crypto', symbol: 'BTCUSDT' });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error.code, 'DUPLICATE_ASSET');
  });

  await t.test('港股前导零规范化且保留原始输入', async () => {
    const r = await api(env, 'POST', '/api/v1/watchlist/assets', { category: 'hk', symbol: '02015', name: '理想汽车' });
    assert.equal(r.status, 201);
    assert.equal(r.json.asset.symbol, '02015');
    assert.equal(r.json.asset.normalized_symbol, '2015.HK');
    // 指数类资产（只有价格，无涨跌/市值）也建一个，供失败隔离与 partial 场景使用
    const r2 = await api(env, 'POST', '/api/v1/watchlist/assets', { category: 'index', symbol: '^TNX', name: '美债10年期收益率', show_changes: false });
    assert.equal(r2.status, 201);
  });

  await t.test('lookup 返回识别名称', async () => {
    const r = await api(env, 'POST', '/api/v1/watchlist/lookup', { category: 'us', symbol: 'AAPL' });
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'Apple Inc.');
  });

  let aaplId;

  await t.test('编辑：name/show_changes/is_starred；代码不可变', async () => {
    const l = await api(env, 'GET', '/api/v1/watchlist/assets');
    aaplId = l.json.assets.find(a => a.symbol === 'AAPL').id;
    const p = await api(env, 'PATCH', `/api/v1/watchlist/assets/${aaplId}`, { name: '苹果公司', is_starred: true, show_changes: false });
    assert.equal(p.status, 200);
    assert.equal(p.json.asset.name, '苹果公司');
    assert.equal(p.json.asset.is_starred, true);
    assert.equal(p.json.asset.show_changes, false);
    // symbol/category 字段被忽略（不报错也不改）
    const p2 = await api(env, 'PATCH', `/api/v1/watchlist/assets/${aaplId}`, { symbol: 'MSFT' });
    assert.equal(p2.json.asset.symbol, 'AAPL');
    const nf = await api(env, 'PATCH', '/api/v1/watchlist/assets/no-such-id', { name: 'x' });
    assert.equal(nf.status, 404);
  });

  await t.test('版本冲突：If-Match 过期返回 409', async () => {
    const r = await api(env, 'PATCH', `/api/v1/watchlist/assets/${aaplId}`, { name: '会被拒绝' }, { 'if-match': '1' });
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'VERSION_CONFLICT');
    assert.equal(typeof r.json.error.details.current_version, 'number');
    // 正确版本可通过
    const cur = (await api(env, 'GET', '/api/v1/watchlist/assets')).json.version;
    const r2 = await api(env, 'PATCH', `/api/v1/watchlist/assets/${aaplId}`, { name: '苹果公司' }, { 'if-match': String(cur) });
    assert.equal(r2.status, 200);
  });

  await t.test('分类内排序：集合不完整 400，正确排列 200', async () => {
    const r1 = await api(env, 'PUT', '/api/v1/watchlist/categories/us/order', { ids: ['not-exist'] });
    assert.equal(r1.status, 400);
    const l = await api(env, 'GET', '/api/v1/watchlist/assets');
    const usIds = l.json.assets.filter(a => a.category === 'us').map(a => a.id);
    const shuffled = [...usIds].reverse();
    const r2 = await api(env, 'PUT', '/api/v1/watchlist/categories/us/order', { ids: shuffled });
    assert.equal(r2.status, 200);
    const l2 = await api(env, 'GET', '/api/v1/watchlist/assets');
    const usNow = l2.json.assets.filter(a => a.category === 'us').map(a => a.id);
    assert.deepEqual(usNow, shuffled);
  });

  await t.test('手动刷新：202 + 快照落库 + 30s 内合并去重', async () => {
    const r = await api(env, 'POST', '/api/v1/watchlist/refresh');
    assert.equal(r.status, 202);
    assert.equal(r.json.ok, true);
    // 立即再次触发 → 合并
    const r2 = await api(env, 'POST', '/api/v1/watchlist/refresh');
    assert.equal(r2.status, 200);
    assert.equal(r2.json.merged, true);
    // 等任务完成
    await waitFor(async () => {
      const q = await api(env, 'GET', '/api/v1/watchlist/quotes');
      return q.json.refresh.last && q.json.refresh.last.status !== 'running';
    }, 5000);
    const q = await api(env, 'GET', '/api/v1/watchlist/quotes');
    const byId = Object.fromEntries(q.json.quotes.map(x => [x.asset_id, x]));
    const aapl = byId[aaplId];
    assert.equal(aapl.price, 268.12);
    assert.equal(aapl.price_currency, 'USD');
    assert.equal(aapl.status, 'ok');
    assert.equal(aapl.source_name, 'yahoo');
    assert.ok(aapl.last_success_at);
  });

  await t.test('单项失败隔离：其他资产行情不受影响，保留上次成功值', async () => {
    const l = await api(env, 'GET', '/api/v1/watchlist/assets');
    const btc = l.json.assets.find(a => a.symbol === 'BTC');
    const tnx = l.json.assets.find(a => a.symbol === '^TNX');
    assert.ok(tnx, '指数资产应存在');
    env.adapters.fail.add('BTC');
    env.adapters.fail.add('2015.HK');
    // 定时被禁用，直接跑一个 scheduled 任务
    env.refreshService.requestRefresh('scheduled');
    await waitFor(async () => {
      const q = await api(env, 'GET', '/api/v1/watchlist/quotes');
      return q.json.refresh.last && q.json.refresh.last.status !== 'running' && q.json.refresh.last.ok_count > 0;
    }, 5000);
    const q = await api(env, 'GET', '/api/v1/watchlist/quotes');
    const byId = Object.fromEntries(q.json.quotes.map(x => [x.asset_id, x]));
    assert.equal(byId[btc.id].status, 'unavailable');
    assert.equal(byId[btc.id].error_message, '行情源暂时不可用（模拟）');
    assert.equal(byId[btc.id].price, 98432, '失败时保留上次成功价格');
    assert.equal(byId[aaplId].status, 'ok');
    assert.equal(q.json.refresh.last.status, 'partial');
    assert.equal(q.json.refresh.last.failed_count, 2);
    // 恢复后下次刷新回到 ok
    env.adapters.fail.clear();
  });

  await t.test('删除资产同时清掉行情快照', async () => {
    const l = await api(env, 'GET', '/api/v1/watchlist/assets');
    const btc = l.json.assets.find(a => a.symbol === 'BTC');
    const d = await api(env, 'DELETE', `/api/v1/watchlist/assets/${btc.id}`);
    assert.equal(d.status, 200);
    const q = await api(env, 'GET', '/api/v1/watchlist/quotes');
    assert.ok(!q.json.quotes.some(x => x.asset_id === btc.id));
    const l2 = await api(env, 'GET', '/api/v1/watchlist/assets');
    assert.ok(!l2.json.assets.some(a => a.id === btc.id));
  });

  await t.test('登录限流：连续错密码后连正确密码也拒（放最后跑，会封掉本机 IP 15 分钟）', async () => {
    for (let i = 1; i <= 8; i += 1) {
      const r = await api(env, 'POST', '/api/v1/auth/login', { username: 'tester@example.com', password: `wrong-${i}` }, { authorization: 'x' });
      assert.equal(r.status, 401, `第 ${i} 次错密码应是 401`);
    }
    const blocked = await api(env, 'POST', '/api/v1/auth/login', { username: 'tester@example.com', password: 'wrong-9' }, { authorization: 'x' });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error.code, 'TOO_MANY_ATTEMPTS');
    // 封禁期内正确密码也进不来——否则限流没有意义
    const stillBlocked = await api(env, 'POST', '/api/v1/auth/login', { username: 'tester@example.com', password: 'test-pass' }, { authorization: 'x' });
    assert.equal(stillBlocked.status, 429);
    // 但服务令牌不受影响（MyInfo 的服务间调用不能被人的登录失败连坐）
    const svc = await api(env, 'GET', '/api/v1/watchlist/assets');
    assert.equal(svc.status, 200);
  });

  await t.test('重启持久化：关闭后重开同一库，数据仍在', async () => {
    const before = (await api(env, 'GET', '/api/v1/watchlist/assets')).json;
    env.refreshService.stop();
    await new Promise(r => env.server.close(r));
    env.db.close();

    const db2 = openTmpDb(env.dir);
    const { server: s2, refreshService: rs2 } = createServer({ db: db2, adapters: fakeAdapters(), intervalMs: 3600e3 });
    await new Promise(r => s2.listen(0, '127.0.0.1', r));
    const base2 = `http://127.0.0.1:${s2.address().port}`;
    const after = await (await fetch(base2 + '/api/v1/watchlist/assets', {
      headers: { authorization: 'Bearer test-token' },
    })).json();
    assert.equal(after.assets.length, before.assets.length);
    assert.deepEqual(after.assets.map(a => a.id), before.assets.map(a => a.id));
    assert.equal(after.version, before.version, '配置版本也持久化');
    rs2.stop();
    await new Promise(r => s2.close(r));
    db2.close();
  });
});

async function waitFor(fn, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('waitFor 超时');
}
