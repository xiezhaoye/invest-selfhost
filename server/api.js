// v1 API 路由与处理。实现依据 docs/api-contract.md。
import { config, authEnabled } from './config.js';
import { createAuth, sameSecret } from './auth.js';
import * as assets from './assets.js';
import * as tags from './tags.js';
import { validateAndNormalize, ValidationError } from './normalize.js';
import { schemaVersion } from './db.js';
import { isValidInterval, isValidRange, DEFAULT_RANGE } from './quotes/candles.js';
import { inputSymbolFor } from './quotes/search.js';
import * as pconfig from './portfolio/config.js';
import { buildValuation } from './portfolio/valuation.js';

const BODY_LIMIT = 1024 * 1024;
// 持仓 K 线允许的行情分类（与 normalize.js 的枚举一致）
const CATEGORIES_FOR_CANDLES = ['us', 'hk', 'a_share', 'crypto', 'index'];

export function createApi({ db, refreshService, adapters, auth, candleService, searchAdapter,
  fxService, portfolioQuotes, jinshiCalendar }) {
  const authService = auth || createAuth({ db });
  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  function sendError(res, status, code, message, details) {
    send(res, status, { ok: false, error: { code, message, ...(details ? { details } : {}) } });
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > BODY_LIMIT) {
          reject(Object.assign(new Error('请求体过大'), { code: 'VALIDATION_ERROR' }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('JSON 解析失败'), { code: 'VALIDATION_ERROR' })); }
      });
      req.on('error', reject);
    });
  }

  function bearerOf(req) {
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : '';
  }

  function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || '';
  }

  // 两种凭据都接受：
  //   session —— 人在浏览器里登录后拿到的会话令牌（读、写都可以）
  //   service —— 其他服务使用的固定令牌（读、写都可以，但不是人手输入的）
  function authenticate(req) {
    const token = bearerOf(req);
    if (!token) return null;
    if (config.apiToken && sameSecret(token, config.apiToken)) {
      return { kind: 'service', username: 'service', token };
    }
    const session = authService.verify(token);
    if (session) return { kind: 'session', username: session.username, token, expires_at: session.expires_at };
    return null;
  }

  // v1 接口（除 health 与 auth/*）都要过这里。读也拦——自选数据本身就是私有内容。
  function requireAuth(req, res) {
    if (!authEnabled()) {
      sendError(res, 503, 'UNAUTHORIZED', '服务未配置任何凭据，v1 接口不可用（设置 INVEST_AUTH_USER/INVEST_AUTH_PASS 或 INVEST_API_TOKEN）');
      return false;
    }
    const who = authenticate(req);
    if (!who) {
      sendError(res, 401, 'UNAUTHORIZED', '需要登录（或带上服务令牌）');
      return false;
    }
    req.auth = who;
    return true;
  }

  // If-Match 头或 body.expected_version；返回 null（未带，按最后写入胜出）或整数
  function expectedVersion(req, body) {
    const im = req.headers['if-match'];
    if (im) {
      const n = Number(String(im).replace(/"/g, '').trim());
      return Number.isInteger(n) && n >= 0 ? n : null;
    }
    if (body && Number.isInteger(body.expected_version) && body.expected_version >= 0) {
      return body.expected_version;
    }
    return null;
  }

  function checkVersion(req, res, body) {
    const exp = expectedVersion(req, body);
    if (exp == null) return true;
    const cur = assets.getVersion(db);
    if (exp !== cur) {
      sendError(res, 409, 'VERSION_CONFLICT', '配置已被其他客户端修改，请刷新后重试', { current_version: cur });
      return false;
    }
    return true;
  }

  // 汇率快照 → API 形状（rates 方向：1 单位该币种 = 多少 USD）
  function fxToJson(fx) {
    return {
      base: 'USD',
      as_of: fx.as_of ?? null,
      source: fx.source ?? null,
      stale: !!fx.stale,
      error: fx.error ?? null,
      rates: fx.rates || {},
    };
  }

  function quoteRowsToJson() {
    const rows = db.prepare(`
      SELECT q.* FROM watchlist_quotes q
      JOIN watchlist_assets a ON a.id = q.asset_id
      ORDER BY CASE a.category
        WHEN 'us' THEN 0 WHEN 'hk' THEN 1 WHEN 'a_share' THEN 2 WHEN 'crypto' THEN 3 ELSE 4 END,
        a.sort_order ASC, a.id ASC
    `).all();
    return rows.map(r => ({
      asset_id: r.asset_id,
      price: r.price ?? null,
      price_currency: r.price_currency ?? null,
      chg_pct: r.chg_pct ?? null,
      week_pct: r.week_pct ?? null,
      month_pct: r.month_pct ?? null,
      market_cap: r.market_cap ?? null,
      market_cap_currency: r.market_cap_currency ?? null,
      source_name: r.source_name ?? null,
      status: r.status,
      error_message: r.error_message ?? null,
      updated_at: r.updated_at ?? null,
      last_success_at: r.last_success_at ?? null,
      // 盘前/盘后（仅美股有；港股等为 null）
      pre_price: r.pre_price ?? null,
      pre_chg_pct: r.pre_chg_pct ?? null,
      pre_session: r.pre_session ?? null,
    }));
  }

  async function handle(req, res, url) {
    const { pathname } = url;
    const method = req.method;

    // ── 健康检查（无认证） ──
    if (method === 'GET' && pathname === '/api/health') {
      try {
        const n = db.prepare('SELECT COUNT(*) AS n FROM watchlist_assets').get().n;
        send(res, 200, { ok: true, db: true, schema_version: schemaVersion(db), uptime_s: Math.floor(process.uptime()), assets: n });
      } catch (e) {
        send(res, 503, { ok: false, db: false, error: e.message });
      }
      return true;
    }

    // ── 登录 / 会话（无认证：这就是拿凭据的地方） ──
    if (method === 'POST' && pathname === '/api/v1/auth/login') {
      const body = await readJson(req);
      const r = authService.login({
        username: body.username,
        password: body.password,
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
      });
      if (r.ok) {
        send(res, 200, { ok: true, token: r.token, username: r.username, expires_at: r.expires_at });
      } else if (r.code === 'TOO_MANY_ATTEMPTS') {
        sendError(res, 429, r.code, r.message);
      } else {
        sendError(res, 401, r.code, r.message);
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/auth/session') {
      // 不用 requireAuth：这里的意思就是回答「现在的凭据还好不好用」，
      // 所以没凭据时也返回 200 + authenticated:false，而不是 401。
      const who = authenticate(req);
      send(res, 200, {
        ok: true,
        authenticated: !!who,
        username: who?.username || null,
        kind: who?.kind || null,
        expires_at: who?.expires_at || null,
        login_enabled: authService.isConfigured(),
      });
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/auth/logout') {
      // 这里不能用 requireAuth：登出时凭据可能刚好已经失效，
      // 那种情况也该回 200（幂等），而不是抛 401 让前端反复弹闸门。
      const who = authenticate(req);
      const removed = who?.kind === 'session' ? authService.logout(bearerOf(req)) : false;
      send(res, 200, { ok: true, revoked: removed });
      return true;
    }

    // 金十 MCP 仅支持本周财经日历；日历服务在服务端缓存，浏览器永远拿不到 MCP token。
    if (method === 'GET' && pathname === '/api/v1/calendar') {
      if (!requireAuth(req, res)) return true;
      try {
        const result = await jinshiCalendar.getCalendar({ force: url.searchParams.get('force') === '1' });
        send(res, 200, { ok: true, ...result });
      } catch (e) {
        sendError(res, 502, 'JINSHI_CALENDAR_UNAVAILABLE', e.message || '金十财经日历暂不可用');
      }
      return true;
    }

    // ── 资产读取 ──
    // tags 与 assets 一起返回：新增/编辑弹窗的标签多选需要清单，
    // 单独再拉一次会让「标签清单」和「资产清单」有各自的 version，容易打架。
    if (method === 'GET' && pathname === '/api/v1/watchlist/assets') {
      if (!requireAuth(req, res)) return true;
      send(res, 200, {
        ok: true,
        version: assets.getVersion(db),
        assets: assets.listAssets(db),
        tags: tags.listTags(db),
        tag_order: tags.tagOrderMap(db),
      });
      return true;
    }

    // ── 代码模糊搜索（新增/编辑时的输入提示） ──
    // 只读的辅助能力：失败一律返回空结果，不阻塞新增流程。
    if (method === 'GET' && pathname === '/api/v1/watchlist/search') {
      if (!requireAuth(req, res)) return true;
      const q = url.searchParams.get('q') || '';
      if (!q.trim()) {
        send(res, 200, { ok: true, query: q, results: [] });
        return true;
      }
      if (!searchAdapter) {
        send(res, 200, { ok: true, query: q, results: [] });
        return true;
      }
      try {
        const items = await searchAdapter.search(q, { limit: 8 });
        send(res, 200, {
          ok: true,
          query: q,
          results: items.map(it => ({
            symbol: it.symbol,
            input_symbol: inputSymbolFor(it),   // 回填输入框用的写法（港股去前导零）
            name: it.name,
            category: it.category,
            exchange: it.exchange,
          })),
        });
      } catch {
        // 搜索是辅助功能：上游挂了也不该让用户没法新增
        send(res, 200, { ok: true, query: q, results: [], degraded: true });
      }
      return true;
    }

    // ── 写前识别（不落库） ──
    if (method === 'POST' && pathname === '/api/v1/watchlist/lookup') {
      if (!requireAuth(req, res)) return true;
      const body = await readJson(req);
      try {
        const { normalized_symbol } = validateAndNormalize(body.category, body.symbol);
        const q = await adapters.fetchWatchlistQuote(body.category, normalized_symbol);
        send(res, 200, {
          ok: true,
          name: q.name || String(body.symbol).trim().toUpperCase(),
          normalized_symbol,
          source_name: q.source_name || null,
        });
      } catch (e) {
        if (e instanceof ValidationError) {
          sendError(res, 400, 'VALIDATION_ERROR', e.message);
        } else {
          sendError(res, 422, 'SYMBOL_LOOKUP_FAILED', e.message || '无法识别该代码');
        }
      }
      return true;
    }

    // ── 新增 ──
    if (method === 'POST' && pathname === '/api/v1/watchlist/assets') {
      if (!requireAuth(req, res)) return true;
      const body = await readJson(req);
      if (!checkVersion(req, res, body)) return true;
      let normalized;
      try {
        normalized = validateAndNormalize(body.category, body.symbol);
      } catch (e) {
        sendError(res, 400, 'VALIDATION_ERROR', e.message);
        return true;
      }
      if (body.verify === true) {
        try {
          await adapters.fetchWatchlistQuote(body.category, normalized.normalized_symbol);
        } catch (e) {
          sendError(res, 422, 'SYMBOL_LOOKUP_FAILED', `无法识别该代码：${e.message || '行情源无此资产'}`);
          return true;
        }
      }
      try {
        const { asset, version } = assets.createAsset(db, {
          category: body.category,
          symbol: body.symbol,
          name: body.name,
          show_changes: body.show_changes !== false,
          is_starred: body.is_starred === true,
          tag_ids: Array.isArray(body.tag_ids) ? body.tag_ids : undefined,
        });
        send(res, 201, { ok: true, version, asset });
      } catch (e) {
        if (e.code === 'DUPLICATE_ASSET') sendError(res, 409, e.code, e.message);
        else if (e instanceof ValidationError || e.code === 'VALIDATION_ERROR') sendError(res, 400, 'VALIDATION_ERROR', e.message);
        else sendError(res, 500, 'INTERNAL', e.message);
      }
      return true;
    }

    // ── 编辑（name / show_changes / is_starred） ──
    {
      const m = pathname.match(/^\/api\/v1\/watchlist\/assets\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (method === 'PATCH') {
          if (!requireAuth(req, res)) return true;
          const body = await readJson(req);
          if (!checkVersion(req, res, body)) return true;
          try {
            const { asset, version } = assets.updateAsset(db, id, body);
            send(res, 200, { ok: true, version, asset });
          } catch (e) {
            if (e.code === 'NOT_FOUND') sendError(res, 404, e.code, e.message);
            else if (e.code === 'VALIDATION_ERROR') sendError(res, 400, e.code, e.message);
            else sendError(res, 500, 'INTERNAL', e.message);
          }
          return true;
        }
        if (method === 'DELETE') {
          if (!requireAuth(req, res)) return true;
          try {
            const { version } = assets.deleteAsset(db, id);
            send(res, 200, { ok: true, version });
          } catch (e) {
            if (e.code === 'NOT_FOUND') sendError(res, 404, e.code, e.message);
            else sendError(res, 500, 'INTERNAL', e.message);
          }
          return true;
        }
      }
    }

    // ── 分类内排序 ──
    {
      const m = pathname.match(/^\/api\/v1\/watchlist\/categories\/([^/]+)\/order$/);
      if (m && method === 'PUT') {
        if (!requireAuth(req, res)) return true;
        const category = decodeURIComponent(m[1]);
        const body = await readJson(req);
        if (!checkVersion(req, res, body)) return true;
        try {
          const { version } = assets.reorderCategory(db, category, body.ids);
          send(res, 200, { ok: true, version });
        } catch (e) {
          if (e.code === 'VALIDATION_ERROR') sendError(res, 400, e.code, e.message);
          else sendError(res, 500, 'INTERNAL', e.message);
        }
        return true;
      }
    }

    // ── 标签：CRUD + 标签内独立排序 ──
    //
    // 与「分类内排序」的关键区别：标签跨市场（一个标签下可以同时有美股和 A 股），
    // 所以 order 的 ids 是该**标签**的全集，而不是某个 category 的全集。
    // 前端在标星/自定义标签页拖动时走这里，不会再因为跨市场而 400。
    if (pathname === '/api/v1/watchlist/tags') {
      if (method === 'GET') {
        if (!requireAuth(req, res)) return true;
        send(res, 200, { ok: true, version: assets.getVersion(db), tags: tags.listTags(db) });
        return true;
      }
      if (method === 'POST') {
        if (!requireAuth(req, res)) return true;
        const body = await readJson(req);
        if (!checkVersion(req, res, body)) return true;
        try {
          const { tag, version, existed } = tags.createTag(db, { name: body.name });
          send(res, existed ? 200 : 201, { ok: true, version, tag, existed });
        } catch (e) {
          if (e instanceof ValidationError || e.code === 'VALIDATION_ERROR') {
            sendError(res, 400, 'VALIDATION_ERROR', e.message);
          } else sendError(res, 500, 'INTERNAL', e.message);
        }
        return true;
      }
    }

    {
      const m = pathname.match(/^\/api\/v1\/watchlist\/tags\/([^/]+)$/);
      if (m) {
        const tagId = decodeURIComponent(m[1]);
        if (method === 'PATCH') {
          if (!requireAuth(req, res)) return true;
          const body = await readJson(req);
          if (!checkVersion(req, res, body)) return true;
          try {
            const { tag, version } = tags.renameTag(db, tagId, body.name);
            send(res, 200, { ok: true, version, tag });
          } catch (e) {
            if (e.code === 'NOT_FOUND') sendError(res, 404, e.code, e.message);
            else if (e instanceof ValidationError || e.code === 'VALIDATION_ERROR') {
              sendError(res, 400, 'VALIDATION_ERROR', e.message);
            } else sendError(res, 500, 'INTERNAL', e.message);
          }
          return true;
        }
        if (method === 'DELETE') {
          if (!requireAuth(req, res)) return true;
          try {
            const { version } = tags.deleteTag(db, tagId);
            send(res, 200, { ok: true, version });
          } catch (e) {
            if (e.code === 'NOT_FOUND') sendError(res, 404, e.code, e.message);
            else if (e instanceof ValidationError || e.code === 'VALIDATION_ERROR') {
              sendError(res, 400, 'VALIDATION_ERROR', e.message);
            } else sendError(res, 500, 'INTERNAL', e.message);
          }
          return true;
        }
      }
    }

    // 标签自身的排列顺序（侧边栏顺序），ids = 全部自定义标签的一个排列。
    if (pathname === '/api/v1/watchlist/tags/order' && method === 'PUT') {
      if (!requireAuth(req, res)) return true;
      const body = await readJson(req);
      if (!checkVersion(req, res, body)) return true;
      try {
        const { version } = tags.reorderTags(db, body.ids);
        send(res, 200, { ok: true, version });
      } catch (e) {
        if (e instanceof ValidationError || e.code === 'VALIDATION_ERROR') {
          sendError(res, 400, 'VALIDATION_ERROR', e.message);
        } else sendError(res, 500, 'INTERNAL', e.message);
      }
      return true;
    }

    // 标签内资产排序（跨市场，只影响这一个标签）。
    {
      const m = pathname.match(/^\/api\/v1\/watchlist\/tags\/([^/]+)\/order$/);
      if (m && method === 'PUT') {
        if (!requireAuth(req, res)) return true;
        const tagId = decodeURIComponent(m[1]);
        const body = await readJson(req);
        if (!checkVersion(req, res, body)) return true;
        try {
          const { version } = tags.reorderTag(db, tagId, body.ids);
          send(res, 200, { ok: true, version });
        } catch (e) {
          if (e.code === 'NOT_FOUND') sendError(res, 404, e.code, e.message);
          else if (e instanceof ValidationError || e.code === 'VALIDATION_ERROR') {
            sendError(res, 400, 'VALIDATION_ERROR', e.message);
          } else sendError(res, 500, 'INTERNAL', e.message);
        }
        return true;
      }
    }

    // ── 资产详情 K 线（按需拉取 + 本地缓存；与 10 分钟报价刷新完全分开） ──
    {
      const m = pathname.match(/^\/api\/v1\/watchlist\/assets\/([^/]+)\/candles$/);
      if (m && method === 'GET') {
        if (!requireAuth(req, res)) return true;
        const id = decodeURIComponent(m[1]);
        const asset = assets.getAsset(db, id);
        if (!asset) {
          sendError(res, 404, 'NOT_FOUND', '资产不存在');
          return true;
        }
        // 参数白名单校验：不合法的组合直接 400，绝不把任意参数透传给上游
        const interval = url.searchParams.get('interval') || '1d';
        if (!isValidInterval(interval)) {
          sendError(res, 400, 'VALIDATION_ERROR', `interval 必须是 ${['1d', '1w', '1M'].join(' | ')} 之一`);
          return true;
        }
        const range = url.searchParams.get('range') || DEFAULT_RANGE[interval];
        if (!isValidRange(interval, range)) {
          sendError(res, 400, 'VALIDATION_ERROR', `range 与 interval 不匹配：${interval} 只支持 ${DEFAULT_RANGE[interval]}`);
          return true;
        }
        if (!candleService) {
          sendError(res, 503, 'INTERNAL', 'K 线服务未启用');
          return true;
        }
        try {
          const payload = await candleService.getCandles({ asset, interval, range });
          send(res, 200, payload);
        } catch (e) {
          // 上游失败且本地无缓存：给可理解的错误，不伪造价格
          sendError(res, 502, 'UPSTREAM_FAILED', `K 线数据暂时不可用：${e.message || '行情源无响应'}`);
        }
        return true;
      }
    }

    // ── 持仓配置（唯一真相源在 Invest；MyInfo 只做代理展示） ──
    if (method === 'GET' && pathname === '/api/v1/portfolio/config') {
      if (!requireAuth(req, res)) return true;
      send(res, 200, { ok: true, ...pconfig.getConfig(db) });
      return true;
    }

    if (method === 'PUT' && pathname === '/api/v1/portfolio/config') {
      if (!requireAuth(req, res)) return true;
      let body;
      try { body = await readJson(req); }
      catch (e) { return sendError(res, 400, e.code || 'VALIDATION_ERROR', e.message), true; }
      try {
        const { version } = pconfig.replaceConfig(db, body, expectedVersion(req, body));
        send(res, 200, { ok: true, version });
      } catch (e) {
        if (e.code === 'VERSION_CONFLICT') {
          sendError(res, 409, e.code, e.message, { current_version: e.current_version });
        } else if (e.code === 'VALIDATION_ERROR') {
          sendError(res, 400, e.code, e.message);
        } else {
          sendError(res, 500, 'INTERNAL', e.message);
        }
      }
      return true;
    }

    // ── 持仓报价（与自选报价缓存隔离；同一标的只发一次上游请求） ──
    // ── 持仓标的 K 线 ──
    // 持仓没有 watchlist_assets 行，但 K 线服务只依赖 {id, category, normalized_symbol}。
    // 复用同一张 candle_cache 表与同一套适配器，用 owner='pf' 与自选（owner='watch'）
    // 分开键空间 —— 不会把持仓写进自选，两边缓存也不会互相覆盖。
    {
      const m = pathname.match(/^\/api\/v1\/portfolio\/candles$/);
      if (m && method === 'GET') {
        if (!requireAuth(req, res)) return true;
        if (!candleService) { sendError(res, 503, 'INTERNAL', 'K 线服务未启用'); return true; }
        const category = url.searchParams.get('quote_category') || '';
        const symbol = url.searchParams.get('normalized_symbol') || '';
        if (!CATEGORIES_FOR_CANDLES.includes(category)) {
          sendError(res, 400, 'VALIDATION_ERROR', `quote_category 必须是 ${CATEGORIES_FOR_CANDLES.join(' | ')} 之一`);
          return true;
        }
        if (!symbol) { sendError(res, 400, 'VALIDATION_ERROR', '缺少 normalized_symbol'); return true; }
        const interval = url.searchParams.get('interval') || '1d';
        if (!isValidInterval(interval)) {
          sendError(res, 400, 'VALIDATION_ERROR', `interval 必须是 ${['1d', '1w', '1M'].join(' | ')} 之一`);
          return true;
        }
        const range = url.searchParams.get('range') || DEFAULT_RANGE[interval];
        if (!isValidRange(interval, range)) {
          sendError(res, 400, 'VALIDATION_ERROR', `range 与 interval 不匹配：${interval} 只支持 ${DEFAULT_RANGE[interval]}`);
          return true;
        }
        try {
          const asset = {
            id: `pf:${category}:${symbol}`,
            owner: 'pf',            // 走持仓键空间，不与自选 K 线互相覆盖
            category,
            normalized_symbol: symbol,
          };
          const payload = await candleService.getCandles({ asset, interval, range });
          send(res, 200, payload);
        } catch (e) {
          sendError(res, 502, 'UPSTREAM_FAILED', `K 线数据暂时不可用：${e.message || '行情源无响应'}`);
        }
        return true;
      }
    }

    if (method === 'GET' && pathname === '/api/v1/portfolio/quotes') {
      if (!requireAuth(req, res)) return true;
      if (!portfolioQuotes) { sendError(res, 503, 'INTERNAL', '持仓报价服务未启用'); return true; }
      const force = url.searchParams.get('force') === '1';
      try {
        const r = await portfolioQuotes.refresh(force);
        // 汇率与报价一起返回：前端要能解释「为什么某行不可估值」
        const fx = fxService ? await fxService.getRates(force) : null;
        send(res, 200, {
          ok: true, force, from_cache: r.from_cache,
          quotes: r.quotes, fx: fx ? fxToJson(fx) : null,
          refreshed_at: r.refreshed_at,
        });
      } catch (e) {
        sendError(res, 502, 'UPSTREAM_FAILED', `持仓报价暂时不可用：${e.message || '行情源无响应'}`);
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/v1/portfolio/valuation') {
      if (!requireAuth(req, res)) return true;
      if (!portfolioQuotes) { sendError(res, 503, 'INTERNAL', '持仓估值服务未启用'); return true; }
      const force = url.searchParams.get('force') === '1';
      try {
        // 冷启动时汇率和报价都可能需要访问上游；两者互不依赖，立即并行开始。
        const fxPromise = fxService ? fxService.getRates(false) : Promise.resolve(null);
        // 过期时**先返回旧快照、后台再刷新**（stale-while-revalidate）。
        //
        // 之前这里在缓存过期时会 await refresh()，于是「打开资产页」要同步等
        // 上游把 5 个标的拉完 —— 实测 3.6s（force=1 更是 6.0s），
        // 而自选页只要 1.8ms（它只读快照，上游由后台定时任务负责）。
        // 这就是用户感觉「自选秒开、资产页要转几秒」的原因。
        //
        // 现在：能读到快照就立刻返回（哪怕已过期），刷新丢到后台；
        // 只有「连一行快照都没有」（首次部署 / 新增标的后第一次打开）才同步等，
        // 因为那时没有可展示的数据，早返回只会给一个空页。
        const hasSnapshot = portfolioQuotes.hasSnapshot();
        let r, refreshing;
        if (force) {
          r = await portfolioQuotes.refresh(true);
          refreshing = false;
        } else if (hasSnapshot && !portfolioQuotes.isFresh()) {
          portfolioQuotes.refreshInBackground();      // 不阻塞
          r = portfolioQuotes.snapshot();
          refreshing = true;
        } else if (hasSnapshot) {
          r = portfolioQuotes.snapshot();             // 新鲜：直接读
          refreshing = false;
        } else {
          r = await portfolioQuotes.refresh(false);   // 无快照：只能等
          refreshing = false;
        }
        const fx = await fxPromise;
        const payload = buildValuation(db, { quotes: r.quotes, fx: fx ? fxToJson(fx) : null });
        const quotes = r.quotes;
        const okCount = quotes.filter(q => q.status === 'ok').length;
        const priceSource = quotes.length === 0 ? 'empty' : (okCount === quotes.length ? 'live' : 'partial');
        send(res, 200, {
          ok: true,
          ...payload,
          prices_updated_at: r.updated_at ?? r.refreshed_at ?? null,
          price_source: priceSource,
          stale: !!refreshing,          // 后台正在补拉，前端可提示「更新中」
        });
      } catch (e) {
        sendError(res, 502, 'UPSTREAM_FAILED', `持仓估值暂时不可用：${e.message || '行情源无响应'}`);
      }
      return true;
    }

    if (method === 'POST' && pathname === '/api/v1/portfolio/refresh') {
      if (!requireAuth(req, res)) return true;
      if (!portfolioQuotes) { sendError(res, 503, 'INTERNAL', '持仓报价服务未启用'); return true; }
      const force = url.searchParams.get('force') === '1';
      // 不阻塞请求：先把「已受理」返回给客户端，刷新在后台跑
      portfolioQuotes.refresh(true).catch(err => console.error('[portfolio refresh] failed:', err));
      send(res, 202, { ok: true, accepted: true, force });
      return true;
    }

    // ── 行情读取 ──
    if (method === 'GET' && pathname === '/api/v1/watchlist/quotes') {
      if (!requireAuth(req, res)) return true;
      send(res, 200, {
        ok: true,
        version: assets.getVersion(db),
        quotes: quoteRowsToJson(),
        refresh: refreshService.getInfo(),
      });
      return true;
    }

    // ── 手动刷新（合并去重；?force=1 跳过 30s 窗口，仍合并运行中任务） ──
    if (method === 'POST' && pathname === '/api/v1/watchlist/refresh') {
      if (!requireAuth(req, res)) return true;
      const force = url.searchParams.get('force') === '1';
      const r = refreshService.requestRefresh('manual', force);
      send(res, r.status, { ok: true, merged: r.merged, refresh: { running: r.job.status === 'running', last: r.job, next_at: refreshService.getInfo().next_at } });
      return true;
    }

    return false;
  }

  return { handle, send, sendError };
}
