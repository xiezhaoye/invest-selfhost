// 代码校验与规范化。用户原始输入（symbol）与识别码（normalized_symbol）分开保存，
// 规范化只用于行情源调用和同分类查重，绝不改写用户输入。
export const CATEGORIES = ['us', 'hk', 'a_share', 'crypto', 'index'];

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.code = 'VALIDATION_ERROR';
  }
}

const PATTERNS = {
  us: { re: /^[A-Z.]{1,6}$/, hint: '美股代码为 1–6 位字母（可含点），如 AAPL、BRK.B' },
  hk: { re: /^\d{1,5}$/, hint: '港股编号为 1–5 位数字，可带前导零，如 0700、02015' },
  a_share: { re: /^\d{6}$/, hint: 'A股需要 6 位数字代码，如 600519、000001' },
  crypto: { re: /^[A-Z0-9]{2,10}$/, hint: '币种代码 2–10 位字母数字，如 BTC、SOL、BTCUSDT' },
  index: { re: /^[A-Z^.=0-9]{1,10}$/, hint: '行情代码如 ^TNX、.IXIC、GC=F、JPY=X' },
};

// 输入 {category, symbol}（原始大小写均可）→ {symbol（大写化）, normalized_symbol}
// 校验失败抛 ValidationError。
export function validateAndNormalize(category, symbol) {
  if (!CATEGORIES.includes(category)) {
    throw new ValidationError(`不支持的资产类型：${category}`);
  }
  const raw = String(symbol ?? '').trim().toUpperCase();
  if (!raw) throw new ValidationError('请输入代码');
  const p = PATTERNS[category];
  if (!p.re.test(raw)) throw new ValidationError(p.hint);

  let normalized = raw;
  if (category === 'hk') {
    // 02015 → 2015.HK；0700 → 0700.HK（去前导零后补足 4 位）
    normalized = `${raw.replace(/^0+/, '').padStart(4, '0')}.HK`;
  } else if (category === 'a_share') {
    // 6/9 开头为上交所，其余深交所
    normalized = `${raw}.${/^[69]/.test(raw) ? 'SS' : 'SZ'}`;
  } else if (category === 'crypto') {
    // BTC 与 BTCUSDT 视为同一基础币种
    normalized = raw.length > 4 && raw.endsWith('USDT') ? raw.slice(0, -4) : raw;
  } else if (category === 'index') {
    // TradingView 写法 .IXIC → Yahoo 写法 ^IXIC
    if (/^\.[A-Z0-9]+$/.test(raw)) normalized = `^${raw.slice(1)}`;
  }
  return { symbol: raw, normalized_symbol: normalized };
}
