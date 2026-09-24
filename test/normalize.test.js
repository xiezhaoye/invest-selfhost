// 代码校验与规范化测试（对应 docs/api-contract.md 的规范化表）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAndNormalize, ValidationError } from '../server/normalize.js';

test('美股：原样大写化', () => {
  assert.deepEqual(validateAndNormalize('us', 'aapl'), { symbol: 'AAPL', normalized_symbol: 'AAPL' });
  assert.deepEqual(validateAndNormalize('us', 'BRK.B'), { symbol: 'BRK.B', normalized_symbol: 'BRK.B' });
});

test('港股：去前导零补 4 位 + .HK', () => {
  assert.equal(validateAndNormalize('hk', '02015').normalized_symbol, '2015.HK');
  assert.equal(validateAndNormalize('hk', '0700').normalized_symbol, '0700.HK');
  assert.equal(validateAndNormalize('hk', '9988').normalized_symbol, '9988.HK');
  assert.equal(validateAndNormalize('hk', '700').normalized_symbol, '0700.HK');
  // 用户原始输入保留前导零
  assert.equal(validateAndNormalize('hk', '02015').symbol, '02015');
});

test('A股：6/9 开头上交所，其余深交所', () => {
  assert.equal(validateAndNormalize('a_share', '600519').normalized_symbol, '600519.SS');
  assert.equal(validateAndNormalize('a_share', '000001').normalized_symbol, '000001.SZ');
  assert.equal(validateAndNormalize('a_share', '300750').normalized_symbol, '300750.SZ');
  assert.equal(validateAndNormalize('a_share', '900901').normalized_symbol, '900901.SS');
});

test('指数：.IXIC → ^IXIC；其余原样', () => {
  assert.equal(validateAndNormalize('index', '.IXIC').normalized_symbol, '^IXIC');
  assert.equal(validateAndNormalize('index', '^TNX').normalized_symbol, '^TNX');
  assert.equal(validateAndNormalize('index', 'GC=F').normalized_symbol, 'GC=F');
  assert.equal(validateAndNormalize('index', 'JPY=X').normalized_symbol, 'JPY=X');
});

test('加密货币：BTC 与 BTCUSDT 规范化为同一基础码', () => {
  assert.equal(validateAndNormalize('crypto', 'BTC').normalized_symbol, 'BTC');
  assert.equal(validateAndNormalize('crypto', 'BTCUSDT').normalized_symbol, 'BTC');
  assert.equal(validateAndNormalize('crypto', 'sol').normalized_symbol, 'SOL');
  assert.equal(validateAndNormalize('crypto', 'HYPE').normalized_symbol, 'HYPE');
});

test('非法输入全部拒绝', () => {
  assert.throws(() => validateAndNormalize('us', 'TOOLONGCODE'), ValidationError);
  assert.throws(() => validateAndNormalize('hk', '070000'), ValidationError);  // 6 位
  assert.throws(() => validateAndNormalize('hk', '07A'), ValidationError);
  assert.throws(() => validateAndNormalize('a_share', '60051'), ValidationError);
  assert.throws(() => validateAndNormalize('a_share', '60051A'), ValidationError);
  assert.throws(() => validateAndNormalize('crypto', 'B'), ValidationError);
  assert.throws(() => validateAndNormalize('index', ''), ValidationError);
  assert.throws(() => validateAndNormalize('jp', '7203'), ValidationError);    // 不支持的分类
  assert.throws(() => validateAndNormalize('us', ''), ValidationError);
});
