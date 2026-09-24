// Invest 服务入口：静态页（同源）+ v1 API。
// 启动：INVEST_PORT=8787 INVEST_AUTH_USER=... INVEST_AUTH_PASS=... node server/index.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config, describeConfig } from './config.js';
import { openDb } from './db.js';
import { createApi } from './api.js';
import { createAuth } from './auth.js';
import { createQuoteAdapters } from './quotes/adapters.js';
import { createRefreshService } from './quotes/service.js';
import { createCandleAdapters } from './quotes/candles.js';
import { createCandleService } from './quotes/candle-service.js';
import { createSearchAdapter } from './quotes/search.js';
import { createFxService } from './portfolio/fx.js';
import { createPortfolioQuoteService } from './portfolio/quote-service.js';
import { createJinshiCalendarService } from './jinshi-calendar.js';
import { seedDemoData } from './demo-data.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export function createServer(opts = {}) {
  const ownsDb = !opts.db;
  const db = opts.db || openDb(config.dbPath);
  if (ownsDb && config.seedDemoData && seedDemoData(db)) {
    console.log('[invest] 已写入开源版演示数据；已有用户数据不会被覆盖。');
  }
  const adapters = opts.adapters || createQuoteAdapters(opts.adapterOpts || {});
  const refreshService = opts.refreshService || createRefreshService({
    db,
    adapters,
    intervalMs: opts.intervalMs ?? config.refreshIntervalMs,
    concurrency: opts.concurrency ?? config.quoteConcurrency,
    manualConcurrency: opts.manualConcurrency ?? config.manualQuoteConcurrency,
  });
  const auth = opts.auth || createAuth({ db });
  // K 线适配器与服务：单独一套，不挂到 10 分钟刷新任务上。
  const candleAdapters = opts.candleAdapters || createCandleAdapters(opts.candleAdapterOpts || {});
  const candleService = opts.candleService || createCandleService({ db, candleAdapters });
  const searchAdapter = opts.searchAdapter || createSearchAdapter(opts.searchAdapterOpts || {});
  // 持仓与估值：报价缓存与自选完全分开，但共用同一套适配器实例。
  const fxService = opts.fxService || createFxService({
    cacheMs: opts.fxCacheMs ?? config.fxCacheMs,
    ...(opts.fxOpts || {}),
  });
  const portfolioQuotes = opts.portfolioQuotes || createPortfolioQuoteService({
    db,
    adapters,
    cacheMs: opts.portfolioQuoteCacheMs ?? config.portfolioQuoteCacheMs,
    manualConcurrency: opts.manualConcurrency ?? config.manualQuoteConcurrency,
  });
  const jinshiCalendar = opts.jinshiCalendar || createJinshiCalendarService({
    token: opts.jinshiToken || config.jinshiToken,
    cacheMs: opts.jinshiCalendarCacheMs || config.jinshiCalendarCacheMs,
  });
  const api = createApi({
    db, refreshService, adapters, auth, candleService, searchAdapter,
    fxService, portfolioQuotes, jinshiCalendar,
  });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end();
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        const handled = await api.handle(req, res, url);
        if (!handled) api.sendError(res, 404, 'NOT_FOUND', '未知 API 端点');
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
        return;
      }
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' }).end('{"ok":false}');
    } catch (e) {
      console.error('[server]', req.method, req.url, e);
      if (!res.headersSent) {
        api.sendError(res, 500, 'INTERNAL', e.message || '服务内部错误');
      } else {
        res.end();
      }
    }
  });

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = path.normalize(path.join(config.staticDir, rel));
    // 防路径穿越：解析后必须仍在静态目录内
    if (!filePath.startsWith(path.resolve(config.staticDir) + path.sep) && filePath !== path.resolve(config.staticDir)) {
      res.writeHead(403).end();
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) {
        // SPA 兜底：未知路径回 index.html
        const index = path.join(config.staticDir, 'index.html');
        fs.readFile(index, (e2, buf) => {
          if (e2) { res.writeHead(404).end('Not Found'); return; }
          res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' }).end(buf);
        });
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      fs.readFile(filePath, (e, buf) => {
        if (e) { res.writeHead(500).end(); return; }
        res.writeHead(200, {
          'content-type': MIME[ext] || 'application/octet-stream',
          // index.html 不缓存，保证发版即生效；静态资源可短缓存
          'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        }).end(buf);
      });
    });
  }

  return {
    server, db, refreshService, adapters, api, auth, candleAdapters, candleService, searchAdapter,
    fxService, portfolioQuotes,
  };
}

// 直接运行时启动服务
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const { server, refreshService, auth } = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`[invest] listening on http://${config.host}:${config.port}`);
    console.log('[invest] config:', describeConfig());
  });
  refreshService.start();
  // 过期会话定期清理；进程内单实例，一小时一次足够
  auth.purgeExpired();
  const purgeTimer = setInterval(() => auth.purgeExpired(), 60 * 60 * 1000);
  purgeTimer.unref();
  const shutdown = () => {
    clearInterval(purgeTimer);
    refreshService.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
