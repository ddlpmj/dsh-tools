/**
 * lib/http.js —— 宿主 HTTP API（CONTRACT §6）。
 *
 * 结构：
 *  - matchRoute(method, pathname) 纯函数：路径 → 路由名 + 参数，可单独测试；
 *  - createRouter({ runtime, prefix }) 返回 { handle(req,res) }，plugin.handleRoute 委托给它。
 *
 * 所有异常在 handle 里兜底成 JSON：{ ok:false, error:{ code, message, hint? } }。
 * 响应与日志里不出现 token / 密钥 / 完整请求头。
 */

const DEFAULT_PREFIX = '/dsh-deep-search';
const BODY_LIMIT_BYTES = 1024 * 1024;

/** 业务错误 → HTTP 状态码。 */
export const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PLUGIN_DISABLED: 403,
  LLM_UNAVAILABLE: 503,
  SEARCH_UNAVAILABLE: 503,
  ENGINE_UNAVAILABLE: 503,
  TIMEOUT: 504,
  INTERNAL: 500,
};

/** 创建带 code / hint / status 的错误。 */
export function httpError(code, message, hint = '') {
  const error = new Error(typeof message === 'string' ? message : String(message || code));
  error.code = code;
  if (hint) error.hint = hint;
  if (STATUS_BY_CODE[code]) error.status = STATUS_BY_CODE[code];
  return error;
}

/** 把敏感信息从任意文本里抹掉（token、Bearer、query 里的 key）。 */
export function redactSecrets(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***')
    .replace(/(x-dsh-auth-token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***')
    .replace(/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1***')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/\bas_sk_[A-Za-z0-9_-]{8,}/g, 'as_sk_***')
    .replace(/([?&](?:token|access_token|auth_token|api_key|apikey|key|signature|sig|x-amz-signature|x-goog-signature|x-oss-signature)=)[^&\s#]+/gi, '$1***');
  return text;
}

/** 错误对象 → 安全短消息。 */
export function errorMessage(error, max = 600) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return redactSecrets(error).slice(0, max);
  const name = error.name && error.name !== 'Error' ? String(error.name) : '';
  const message = error.message ? String(error.message) : String(error);
  const text = name && !message.includes(name) ? `${name}: ${message}` : message;
  return redactSecrets(text).slice(0, max);
}

function isAbortError(error) {
  return Boolean(error && (error.name === 'AbortError' || error.code === 'ABORT_ERR' || error.code === 'TIMEOUT'));
}

/** 错误 → 对外 code / status。 */
export function classifyError(error) {
  if (error && typeof error.code === 'string' && STATUS_BY_CODE[error.code]) {
    return { code: error.code, status: STATUS_BY_CODE[error.code] };
  }
  if (isAbortError(error)) return { code: 'TIMEOUT', status: STATUS_BY_CODE.TIMEOUT };
  return { code: 'INTERNAL', status: STATUS_BY_CODE.INTERNAL };
}

/** 统一 JSON 响应。 */
export function sendJson(res, status, payload) {
  if (!res || res.writableEnded || res.headersSent) return;
  let body;
  try {
    body = JSON.stringify(payload);
  } catch (error) {
    body = JSON.stringify({ ok: false, error: { code: 'INTERNAL', message: errorMessage(error) } });
  }
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  };
  try {
    if (typeof res.writeHead === 'function') res.writeHead(status, headers);
    else if (typeof res.setHeader === 'function') {
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      res.statusCode = status;
    }
    res.end(body);
  } catch {
    /* 连接已断开：忽略 */
  }
}

/** 去掉路由前缀，规整成以 / 开头的路径。 */
export function normalizeRoutePath(rawPath, prefix = DEFAULT_PREFIX) {
  let pathname = typeof rawPath === 'string' && rawPath ? rawPath : '/';
  const hashIndex = pathname.indexOf('#');
  if (hashIndex >= 0) pathname = pathname.slice(0, hashIndex);
  const queryIndex = pathname.indexOf('?');
  if (queryIndex >= 0) pathname = pathname.slice(0, queryIndex);
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* 保留原样 */
  }
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  const normalizedPrefix = prefix.startsWith('/') ? prefix : `/${prefix}`;
  if (pathname === normalizedPrefix) pathname = '/';
  else if (pathname.startsWith(`${normalizedPrefix}/`)) pathname = pathname.slice(normalizedPrefix.length);
  pathname = pathname.replace(/\/+$/, '');
  return pathname || '/';
}

const ROUTE_TABLE = [
  { name: 'health', method: 'GET', pattern: /^\/health$/ },
  { name: 'directSearch', method: 'POST', pattern: /^\/search$/ },
  { name: 'anySearchDomains', method: 'GET', pattern: /^\/anysearch\/domains$/ },
  { name: 'anySearchCapabilities', method: 'GET', pattern: /^\/anysearch\/capabilities$/ },
  { name: 'topicsList', method: 'GET', pattern: /^\/topics$/ },
  { name: 'topicsCreate', method: 'POST', pattern: /^\/topics$/ },
  { name: 'topicAsk', method: 'POST', pattern: /^\/topics\/([^/]+)\/ask$/ },
  { name: 'topicRefresh', method: 'POST', pattern: /^\/topics\/([^/]+)\/refresh$/ },
  { name: 'topicExport', method: 'POST', pattern: /^\/topics\/([^/]+)\/export$/ },
  { name: 'topicKb', method: 'POST', pattern: /^\/topics\/([^/]+)\/kb$/ },
  { name: 'topicGet', method: 'GET', pattern: /^\/topics\/([^/]+)$/ },
  { name: 'topicDelete', method: 'DELETE', pattern: /^\/topics\/([^/]+)$/ },
  { name: 'jobGet', method: 'GET', pattern: /^\/jobs\/([^/]+)$/ },
  { name: 'jobCancel', method: 'POST', pattern: /^\/jobs\/([^/]+)\/cancel$/ },
  { name: 'settingsGet', method: 'GET', pattern: /^\/settings$/ },
  { name: 'settingsPut', method: 'PUT', pattern: /^\/settings$/ },
];

/**
 * 纯路由匹配。
 * @returns {{ name:string, params: Record<string,string> } | null}
 */
export function matchRoute(method, pathname) {
  const verb = String(method || 'GET').toUpperCase();
  const path = normalizeRoutePath(pathname);
  for (const route of ROUTE_TABLE) {
    if (route.method !== verb) continue;
    const match = route.pattern.exec(path);
    if (!match) continue;
    const params = {};
    if (match[1]) params.id = match[1];
    return { name: route.name, params };
  }
  return null;
}

/** 读取 JSON body，限制 1MB，坏 JSON 转 BAD_REQUEST。 */
export async function readJsonBody(req, limit = BODY_LIMIT_BYTES) {
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw httpError('BAD_REQUEST', `请求体超过 ${Math.round(limit / 1024)}KB 上限`, '请只提交必要的 JSON 字段。');
    }
    chunks.push(buffer);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw httpError('BAD_REQUEST', '请求体不是合法 JSON', '检查 Content-Type 与 JSON 语法。');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError('BAD_REQUEST', '请求体必须是 JSON 对象');
  }
  return parsed;
}

function requireRuntimeMethod(runtime, name) {
  if (!runtime || typeof runtime[name] !== 'function') {
    throw httpError('INTERNAL', `运行时缺少方法 ${name}`);
  }
  return runtime[name].bind(runtime);
}

function requireId(params) {
  const id = params && params.id ? String(params.id) : '';
  if (!id) throw httpError('BAD_REQUEST', '缺少 id');
  return id;
}

const HANDLERS = {
  async health({ runtime }) {
    const data = await requireRuntimeMethod(runtime, 'health')();
    return { ok: true, ...(data && typeof data === 'object' ? data : {}) };
  },

  async directSearch({ runtime, body, req, res }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    req?.once?.('aborted', abort);
    res?.once?.('close', abort);
    if (req?.aborted || res?.destroyed) abort();
    try {
      return await requireRuntimeMethod(runtime, 'directSearch')({
        query: body.query,
        searchProviderMode: body.searchProviderMode,
        anySearch: body.anySearch,
        signal: controller.signal,
      });
    } finally {
      req?.off?.('aborted', abort);
      res?.off?.('close', abort);
    }
  },

  async anySearchDomains({ runtime }) {
    const domains = await requireRuntimeMethod(runtime, 'anySearchDomains')();
    return { ok: true, domains };
  },

  async anySearchCapabilities({ runtime, query }) {
    const capabilities = await requireRuntimeMethod(runtime, 'anySearchCapabilities')(query.get('domain'));
    return { ok: true, capabilities };
  },

  async topicsList({ runtime, query }) {
    const listTopics = requireRuntimeMethod(runtime, 'listTopics');
    const q = (query.get('q') || '').trim();
    const limitRaw = Number(query.get('limit'));
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.round(limitRaw))) : 100;
    const topics = await listTopics({ q, limit });
    return { ok: true, topics: Array.isArray(topics) ? topics : [], count: Array.isArray(topics) ? topics.length : 0 };
  },

  async topicsCreate({ runtime, body }) {
    const startTopic = requireRuntimeMethod(runtime, 'startTopic');
    const result = await startTopic({
      query: body.query,
      angle: body.angle,
      depth: body.depth,
      searchProviderMode: body.searchProviderMode,
      anySearch: body.anySearch,
    });
    return { ok: true, ...result };
  },

  async topicGet({ runtime, params }) {
    const id = requireId(params);
    const topic = await requireRuntimeMethod(runtime, 'getTopic')(id);
    if (!topic) throw httpError('NOT_FOUND', `档案不存在：${id}`);
    let job = null;
    try {
      if (typeof runtime.findJobForTopic === 'function') job = await runtime.findJobForTopic(id);
    } catch {
      job = null;
    }
    return { ok: true, topic, job };
  },

  async topicDelete({ runtime, params }) {
    const id = requireId(params);
    const deleted = await requireRuntimeMethod(runtime, 'deleteTopic')(id);
    if (!deleted) throw httpError('NOT_FOUND', `档案不存在：${id}`);
    return { ok: true, deleted: true, id };
  },

  async topicAsk({ runtime, params, body }) {
    const topicId = requireId(params);
    const result = await requireRuntimeMethod(runtime, 'ask')({ topicId, question: body.question });
    return { ok: true, ...result };
  },

  async topicRefresh({ runtime, params }) {
    const topicId = requireId(params);
    const result = await requireRuntimeMethod(runtime, 'refreshTopic')({ topicId });
    return { ok: true, ...result };
  },

  async topicKb({ runtime, params, body }) {
    const topicId = requireId(params);
    const result = await requireRuntimeMethod(runtime, 'recordKnowledgeBase')(topicId, body || {});
    return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
  },

  async topicExport({ runtime, params, body }) {
    const topicId = requireId(params);
    const result = await requireRuntimeMethod(runtime, 'exportTopic')({ topicId, format: body.format });
    return { ok: true, ...result };
  },

  async jobGet({ runtime, params }) {
    const id = requireId(params);
    const job = await requireRuntimeMethod(runtime, 'getJob')(id);
    if (!job) throw httpError('NOT_FOUND', `任务不存在：${id}`);
    return { ok: true, job };
  },

  async jobCancel({ runtime, params }) {
    const id = requireId(params);
    const result = await requireRuntimeMethod(runtime, 'cancelJob')(id);
    if (!result || result.ok !== true) {
      const code = result && result.code === 'CONFLICT' ? 'CONFLICT' : 'NOT_FOUND';
      throw httpError(code, (result && result.message) || `任务不存在或已结束：${id}`);
    }
    return { ok: true, canceled: true, id };
  },

  async settingsGet({ runtime }) {
    const settings = await requireRuntimeMethod(runtime, 'getSettings')();
    return { ok: true, settings };
  },

  async settingsPut({ runtime, body }) {
    const settings = await requireRuntimeMethod(runtime, 'updateSettings')(body);
    return { ok: true, settings };
  },
};

/**
 * 创建路由器。
 * @param {{runtime: object, prefix?: string}} options
 */
export function createRouter({ runtime, prefix = DEFAULT_PREFIX } = {}) {
  if (!runtime || typeof runtime !== 'object') throw new Error('createRouter 缺少 runtime');

  async function handle(req, res) {
    let status = 200;
    try {
      const method = String((req && req.method) || 'GET').toUpperCase();
      const rawUrl = (req && req.url) || '/';
      const url = new URL(rawUrl, 'http://localhost');
      const pathname = normalizeRoutePath(url.pathname, prefix);
      const match = matchRoute(method, pathname);
      if (!match) {
        status = 404;
        sendJson(res, status, {
          ok: false,
          error: { code: 'NOT_FOUND', message: `未知路由：${method} ${pathname}`, hint: '可用路由见 CONTRACT §6。' },
        });
        return;
      }
      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readJsonBody(req) : {};
      const payload = await HANDLERS[match.name]({ runtime, params: match.params, query: url.searchParams, body, req, res });
      status = 200;
      sendJson(res, status, payload);
    } catch (error) {
      const { code, status: errorStatus } = classifyError(error);
      status = (error && Number.isFinite(error.status) && error.status) || errorStatus || 500;
      sendJson(res, status, {
        ok: false,
        error: {
          code,
          message: errorMessage(error),
          ...(error && error.hint ? { hint: redactSecrets(String(error.hint)).slice(0, 400) } : {}),
        },
      });
    }
  }

  return { handle, matchRoute, routes: ROUTE_TABLE, prefix };
}
