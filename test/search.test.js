// 代码模糊搜索适配器测试：mock fetch，不触网。
// 覆盖：中文名/拼音/英文代码三类查询、市场映射、美股债券过滤、结果裁剪、
// 关键词缓存、上游失败时的行为，以及 normalized/input 代码的换算。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchAdapter, normalizeSearchSymbol, inputSymbolFor } from '../server/quotes/search.js';

// 东方财富 suggest 响应的最小化构造器
function emResponse(rows) {
  return { QuotationCodeTable: { Data: rows } };
}
function row(Code, Name, Classify, SecurityTypeName = '', extra = {}) {
  return { Code, Name, Classify, SecurityTypeName, ...extra };
}

function mockFetch(payload, calls = []) {
  const fn = async (url) => {
    calls.push(String(url));
    if (payload instanceof Error) throw payload;
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

test('搜索：中文名命中 A股（比亚迪 → 002594）', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([
    row('002594', '比亚迪', 'AStock', '深A'),
    row('00285', '比亚迪电子', 'HK', '港股'),
  ])) });
  const r = await a.search('比亚迪');
  assert.equal(r.length, 2);
  assert.equal(r[0].symbol, '002594');
  assert.equal(r[0].name, '比亚迪');
  assert.equal(r[0].category, 'a_share');
  assert.equal(r[0].exchange, '深A');
  assert.equal(r[1].category, 'hk');
});

test('搜索：英文代码命中（apple → AAPL）', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([
    row('AAPL', '苹果', 'UsStock', '美股', { SecurityType: '20' }),
  ])) });
  const r = await a.search('apple');
  assert.equal(r.length, 1);
  assert.equal(r[0].symbol, 'AAPL');
  assert.equal(r[0].category, 'us');
});

test('搜索：拼音首字母命中（BYD → 比亚迪）', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([
    row('002594', '比亚迪', 'AStock', '深A', { PinYin: 'BYD' }),
    row('BYD', '博伊德赌场', 'UsStock', '美股', { SecurityType: '20' }),
  ])) });
  const r = await a.search('BYD');
  assert.equal(r.length, 2);
  assert.equal(r[0].name, '比亚迪');
  assert.equal(r[1].name, '博伊德赌场');
});

test('搜索：美股里的债券/票据被过滤（只留 SecurityType=20）', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([
    row('AAPL', '苹果', 'UsStock', '美股', { SecurityType: '20' }),
    row('AAPL22', 'Apple Inc Notes 2022', 'UsStock', '美股', { SecurityType: '7' }),
    row('AAPL24', 'Apple Inc Notes 2024', 'UsStock', '美股', { SecurityType: '7' }),
  ])) });
  const r = await a.search('apple');
  assert.equal(r.length, 1, '只应留下普通股');
  assert.equal(r[0].symbol, 'AAPL');
});

test('搜索：不管理的市场类型（基金/债券/期货）被过滤', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([
    row('002594', '比亚迪', 'AStock', '深A'),
    row('000001', '某某基金', 'Fund', '基金'),
    row('019547', '某某国债', 'Bond', '债券'),
    row('CL00Y', '原油', 'Futures', '期货'),
  ])) });
  const r = await a.search('比亚迪');
  assert.equal(r.length, 1);
  assert.equal(r[0].symbol, '002594');
});

test('搜索：limit 生效，且同市场同代码去重', async () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(`00000${i}`, `测试${i}`, 'AStock', '深A'));
  rows.push(row('000000', '重复项', 'AStock', '深A'));   // 与首个重复
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse(rows)) });
  const r = await a.search('测试', { limit: 5 });
  assert.equal(r.length, 5);
  const keys = r.map(x => `${x.category}:${x.symbol}`);
  assert.equal(new Set(keys).size, keys.length, '不应有重复项');
});

test('搜索：关键词缓存——同一词第二次不再打上游', async () => {
  const calls = [];
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([
    row('002594', '比亚迪', 'AStock', '深A'),
  ]), calls) });
  await a.search('比亚迪');
  const after1 = calls.length;
  await a.search('比亚迪');
  assert.equal(calls.length, after1, '第二次应命中缓存');
  // 大小写不敏感：BYD 与 byd 视为同一个关键词
  await a.search('BYD');
  const after2 = calls.length;
  await a.search('byd');
  assert.equal(calls.length, after2, '大小写不同应共享缓存');
});

test('搜索：空查询直接返回空，不打上游', async () => {
  const calls = [];
  const a = createSearchAdapter({ fetchImpl: mockFetch(emResponse([]), calls) });
  assert.deepEqual(await a.search(''), []);
  assert.deepEqual(await a.search('   '), []);
  assert.equal(calls.length, 0);
});

test('搜索：上游非 2xx 抛错（由 API 层降级为空结果）', async () => {
  const a = createSearchAdapter({ fetchImpl: async () => new Response('nope', { status: 503 }) });
  await assert.rejects(() => a.search('apple'), /HTTP 503/);
});

test('搜索：上游网络异常原样抛出', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch(new Error('fetch failed')) });
  await assert.rejects(() => a.search('apple'), /fetch failed/);
});

test('搜索：响应结构异常时返回空数组而不是崩', async () => {
  const a = createSearchAdapter({ fetchImpl: mockFetch({ unexpected: true }) });
  assert.deepEqual(await a.search('apple'), []);
});

// ── 代码换算 ──

test('normalizeSearchSymbol：与项目 normalize 规则对齐', () => {
  // 港股补足 4 位 + .HK
  assert.equal(normalizeSearchSymbol('hk', '700'), '0700.HK');
  assert.equal(normalizeSearchSymbol('hk', '00700'), '0700.HK');
  assert.equal(normalizeSearchSymbol('hk', '1211'), '1211.HK');
  // A股：与 server/normalize.js 同规则（6/9 开头 .SS，其余 .SZ）
  assert.equal(normalizeSearchSymbol('a_share', '002594'), '002594.SZ');
  assert.equal(normalizeSearchSymbol('a_share', '600519'), '600519.SS');
  // 美股大写
  assert.equal(normalizeSearchSymbol('us', 'aapl'), 'AAPL');
  // 指数补 ^
  assert.equal(normalizeSearchSymbol('index', 'IXIC'), '^IXIC');
  assert.equal(normalizeSearchSymbol('index', '^TNX'), '^TNX');
});

test('inputSymbolFor：回填输入框的写法（港股去前导零）', () => {
  assert.equal(inputSymbolFor({ category: 'hk', symbol: '00700' }), '700');
  assert.equal(inputSymbolFor({ category: 'hk', symbol: '01211' }), '1211');
  assert.equal(inputSymbolFor({ category: 'a_share', symbol: '002594' }), '002594');
  assert.equal(inputSymbolFor({ category: 'us', symbol: 'AAPL' }), 'AAPL');
  assert.equal(inputSymbolFor(null), '');
});
