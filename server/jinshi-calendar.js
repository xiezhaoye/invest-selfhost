// 金十财经日历：服务端以 MCP Streamable HTTP 调用，Bearer Token 永不进入浏览器。
const MCP_URL = 'https://mcp.jin10.com/mcp';
const PROTOCOL_VERSION = '2025-11-25';

function parseMcpBody(text) {
  const lines = text.trim().split(/\r?\n/);
  const payload = lines.filter(line => line.startsWith('data:')).at(-1)?.slice(5).trim() || text.trim();
  return payload ? JSON.parse(payload) : null;
}

async function mcpPost(token, payload, initialized, timeoutMs) {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(initialized ? { 'mcp-protocol-version': PROTOCOL_VERSION } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`金十 MCP 请求失败（HTTP ${response.status}）`);
  return parseMcpBody(text);
}

async function runCalendar(token, timeoutMs) {
  if (!token) throw new Error('尚未配置金十 Key，请在服务设置中设置 JIN10_MCP_TOKEN');
  const init = await mcpPost(token, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'invest', version: '1.0.0' } },
  }, false, timeoutMs);
  if (init?.error) throw new Error(init.error.message || '金十 MCP 初始化失败');
  await mcpPost(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, true, timeoutMs);
  const response = await mcpPost(token, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_calendar', arguments: {} },
  }, true, timeoutMs);
  if (response?.error) throw new Error(response.error.message || '金十 MCP 请求失败');
  const result = response?.result || {};
  if (result.isError) throw new Error(result?.structuredContent?.message || '金十财经日历暂不可用');
  const events = result?.structuredContent?.data;
  if (!Array.isArray(events)) throw new Error('金十日历返回格式不正确');
  return events;
}

/**
 * 以短 TTL 缓存本周日历；接口本身只提供本周数据，缓存能避免切换页面重复计数。
 */
export function createJinshiCalendarService({ token, cacheMs = 5 * 60 * 1000, timeoutMs = 30_000 } = {}) {
  let cache = null;
  let fetchedAt = 0;
  let pending = null;

  async function getCalendar({ force = false } = {}) {
    const now = Date.now();
    if (!force && cache && now - fetchedAt < cacheMs) {
      return { events: cache, cached: true, fetched_at: new Date(fetchedAt).toISOString() };
    }
    if (!pending) {
      pending = runCalendar(token, timeoutMs)
        .then(events => {
          cache = events;
          fetchedAt = Date.now();
          return events;
        })
        .finally(() => { pending = null; });
    }
    const events = await pending;
    return { events, cached: false, fetched_at: new Date(fetchedAt).toISOString() };
  }

  return { getCalendar };
}
