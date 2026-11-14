/**
 * lib/search.js —— 检索适配（CONTRACT §5.1）。
 *
 * 按 config.searchProviderMode 自动探测 / 指定：
 *   account：DeepSeek Search API + ctx.get('deepseekAccount').resolveToken(...)（本部署默认可用）
 *   web：    ctx.get('web').search({query, maxResults})（需要 agent 会话 / provider key）
 *   api：    config.searchApiKey 或 DEEPSEEK_API_KEY 直连同一接口（Bearer）
 *   anysearch：用独立的 AnySearch API key 直连其搜索接口（Bearer）
 *
 * 失败一律结构化返回，不把异常抛给路由；响应 / 日志不输出 token。
 */

import {
  asArray,
  canonicalUrl,
  clampNumber,
  clampText,
  hostOf,
  iso,
  uniqueBy,
} from './model.js';
import { SEARCH_MODES } from './config.js';
import { errorMessage, httpError, redactSecrets } from './http.js';

const TOKEN_TTL_MS = 60 * 1000;
const PROBE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const ANYSEARCH_ENDPOINT = 'https://api.anysearch.com/v1/search';
const ANYSEARCH_MAX_RESULTS = 10;
const ANYSEARCH_HTTP_ERRORS = {
  400: '未接受检索词、能力或参数，请检查该能力的参数说明',
  401: 'API key 无效',
  402: '检索额度不足',
  403: 'API key 已过期或没有访问权限',
  429: '检索频率受限，请稍后重试',
};
const AUTO_MODES = SEARCH_MODES.filter((mode) => mode !== 'auto');
const USER_AGENT = 'deepseek-harness/0.0.1';
const MODE_LABELS = {
  account: 'DeepSeek 账号检索',
  web: '宿主 web 检索',
  api: 'API Key 检索',
  anysearch: 'AnySearch',
};

/** 让错误对象在模板字符串里也可读（pipeline 等调用方会直接 String(error)）。 */
function readableError(raw) {
  const detail = raw && typeof raw === 'object' ? raw : { message: String(raw || '检索失败') };
  if (typeof detail.message !== 'string' || !detail.message) detail.message = '检索失败';
  if (typeof detail.toString !== 'function' || detail.toString === Object.prototype.toString) {
    Object.defineProperty(detail, 'toString', {
      value: () => `${detail.message}${detail.hint ? `（${detail.hint}）` : ''}`,
      enumerable: false,
    });
  }
  return detail;
}

function nowMs() {
  return Date.now();
}

/** 给 fetch 加超时 + 外部 abort。 */
function linkedSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    },
  };
}

function normalizeSource(item, index, direct) {
  if (typeof item === 'string') {
    item = { url: item };
  }
  if (!item || typeof item !== 'object') return null;
  const rawUrl = item.url || item.link || item.href || '';
  const canonical = canonicalUrl(rawUrl);
  if (!canonical) return null;
  const url = direct ? rawUrl.trim() : canonical;
  if (direct) {
    const parsed = new URL(canonical);
    if (parsed.username || parsed.password || redactSecrets(url) !== url) return null;
  }
  const clean = (value, limit, fallback) => clampText(
    direct && typeof value === 'string' ? redactSecrets(value) : value,
    limit,
    fallback,
  );
  const title = clean(item.title || item.name || item.headline, 300, url);
  const summary = clean(item.summary || item.snippet || item.description || item.content || '', direct ? 8000 : 1200);
  const snippet = clean(item.snippet || item.description || '', direct ? 8000 : 500);
  const publisher = clean(item.publisher || item.site_name || item.siteName || item.site || '', 120, hostOf(url));
  return {
    url,
    title,
    publisher,
    summary,
    snippet,
    publishedAt: iso(item.date || item.publishedAt || item.published_at || item.published || ''),
    author: clean(item.author || item.byline || '', 120),
    authority: clampNumber(item.authority, 0, 5, 0),
    rank: clampNumber(item.rerank_score ?? item.rerankScore ?? item.rank ?? item.score, 0, 1000, index + 1),
    ...(direct ? { position: index } : {}),
  };
}

/** 结果归一、去重、限量。 */
function normalizeResults(rawList, maxResults, direct) {
  const list = asArray(rawList);
  const normalized = [];
  for (let index = 0; index < list.length; index += 1) {
    const source = normalizeSource(list[index], index, direct);
    if (source) normalized.push(source);
  }
  const unique = direct ? normalized : uniqueBy(normalized, (source) => source.url);
  return unique.slice(0, maxResults);
}

function normalizeAnySearchRecords(rawList, count, direct) {
  const records = [];
  for (const [index, item] of rawList.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (canonicalUrl(item.url || item.link || item.href || '')) continue;
    const { title, name, headline, url, link, href, ...fields } = item;
    const data = fields.data;
    const hasData = data != null && (typeof data !== 'object' || Object.keys(data).length);
    const body = direct && hasData ? data : (fields.content || data || fields.summary || fields.snippet || fields.description || fields);
    if (body == null || (typeof body === 'object' && !Object.keys(body).length)) continue;
    const content = redactSecrets(typeof body === 'string' ? body : JSON.stringify(body, null, 2)).trim().slice(0, direct ? 8000 : 3000);
    if (!content) continue;
    records.push({
      title: clampText(redactSecrets(title || name || headline || ''), 300),
      content,
      ...(direct ? { position: index } : {}),
    });
    if (records.length >= count) break;
  }
  return records;
}

/**
 * @param {{ctx:object, config:object, logger:object, fetchImpl?:Function}} options
 */
export function createSearchService({ ctx, config, logger = console, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => globalThis.fetch(...args);
  let tokenCache = { token: '', at: 0 };
  const probeCache = new Map();

  const logWarn = (message) => {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(`[search] ${redactSecrets(message)}`);
    } catch {
      /* ignore */
    }
  };

  function endpoint() {
    return `${(config.searchApiBaseURL || 'https://api.deepseek.com/v1/tools').replace(/\/+$/, '')}/search`;
  }

  function apiKey() {
    if (config.searchApiKey) return config.searchApiKey;
    const envName = config.searchApiKeyEnv || 'DEEPSEEK_API_KEY';
    const fromEnv = process.env[envName];
    return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : '';
  }

  function getService(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  async function accountToken(force = false) {
    const fresh = tokenCache.token && nowMs() - tokenCache.at < TOKEN_TTL_MS;
    if (fresh && !force) return tokenCache.token;
    const account = getService('deepseekAccount');
    if (!account || typeof account.resolveToken !== 'function') return '';
    try {
      const token = await account.resolveToken(endpoint());
      if (typeof token === 'string' && token.trim()) {
        tokenCache = { token: token.trim(), at: nowMs() };
        return tokenCache.token;
      }
    } catch (error) {
      logWarn(`账号 token 解析失败：${errorMessage(error, 200)}`);
    }
    tokenCache = { token: '', at: 0 };
    return '';
  }

  function webService() {
    const web = getService('web');
    return web && typeof web.search === 'function' ? web : null;
  }

  function unavailableModesMessage(modesTried) {
    const parts = [];
    if (modesTried.includes('account')) parts.push('account：在 DSH 桌面端登录后重试（或换 searchProviderMode=api）');
    if (modesTried.includes('web')) parts.push('web：路由上下文没有可用的 web 检索 provider（需要 agent 会话 / API key）');
    if (modesTried.includes('api')) parts.push('api：配置 searchApiKey，或设置环境变量 DEEPSEEK_API_KEY');
    if (modesTried.includes('anysearch') && !config.anySearchApiKey) {
      parts.push('AnySearch：配置 anySearchApiKey，或设置环境变量 ANYSEARCH_API_KEY');
    }
    return parts.join('；');
  }

  async function requestApi(mode, query, count, signal) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    };
    let token = '';
    if (mode === 'account') {
      token = await accountToken();
      if (!token) {
        throw httpError(
          'SEARCH_UNAVAILABLE',
          '无法取得 DeepSeek 账号检索 token',
          '请在 DSH 桌面端登录；或把 searchProviderMode 设为 api 并在配置 / DEEPSEEK_API_KEY 里提供 key。',
        );
      }
      headers['x-dsh-auth-token'] = token;
    } else {
      token = apiKey();
      if (!token) {
        throw httpError(
          'SEARCH_UNAVAILABLE',
          '未配置检索 API key',
          '在插件配置里设置 searchApiKey，或设置环境变量 DEEPSEEK_API_KEY。',
        );
      }
      headers.authorization = `Bearer ${token}`;
    }

    const link = linkedSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      link.signal.throwIfAborted();
      const response = await doFetch(endpoint(), {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, count, need_content: false }),
        signal: link.signal,
      });
      if (response.status >= 400) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401 || response.status === 403) {
          if (mode === 'account') tokenCache = { token: '', at: 0 };
          const hint = mode === 'account' ? 'token 可能已过期，重试一次；仍失败请重新登录 DSH。' : '检查 searchApiKey / DEEPSEEK_API_KEY 是否有效。';
          throw httpError('SEARCH_UNAVAILABLE', `检索接口拒绝凭证（HTTP ${response.status}）`, hint);
        }
        if (response.status === 429) {
          throw httpError('SEARCH_UNAVAILABLE', '检索接口频率受限（HTTP 429）', '稍后重试。');
        }
        throw httpError('SEARCH_UNAVAILABLE', `检索接口返回 HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (!payload || !Array.isArray(payload.results)) {
        throw httpError('SEARCH_UNAVAILABLE', '检索接口响应缺少 results 数组');
      }
      return payload.results;
    } catch (error) {
      signal?.throwIfAborted();
      if (link.didTimeout()) throw httpError('TIMEOUT', '检索请求超时（30s）');
      if (error?.code === 'SEARCH_UNAVAILABLE') throw error;
      throw httpError('SEARCH_UNAVAILABLE', '检索请求失败或响应无法读取');
    } finally {
      link.cleanup();
    }
  }

  async function requestWeb(query, count, signal, direct) {
    const web = webService();
    if (!web) throw httpError('SEARCH_UNAVAILABLE', '宿主 web 检索服务不可用', '改用 searchProviderMode=account。');
    const link = linkedSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      link.signal.throwIfAborted();
      const result = await Promise.race([
        web.search({ query, maxResults: count }, link.signal),
        new Promise((resolve, reject) => {
          link.signal.addEventListener('abort', () => reject(link.signal.reason), { once: true });
        }),
      ]);
      link.cleanup();
      if (signal && signal.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
      if (typeof result === 'string') throw httpError('SEARCH_UNAVAILABLE', `宿主 web 检索失败：${redactSecrets(result).slice(0, 240)}`);
      const list = Array.isArray(result) ? result : result && (result.sources || result.results || result.items || result.data);
      if (!Array.isArray(list)) throw httpError('SEARCH_UNAVAILABLE', '宿主 web 检索返回格式无法识别');
      return list;
    } catch (error) {
      link.cleanup();
      signal?.throwIfAborted();
      if (link.didTimeout()) throw httpError('TIMEOUT', '宿主 web 检索超时（30s）');
      if (error && (error.name === 'AbortError' || error.code === 'TIMEOUT')) {
        throw error;
      }
      if (direct) throw httpError('SEARCH_UNAVAILABLE', '宿主 web 检索请求失败');
      if (error && error.code) throw error;
      throw httpError('SEARCH_UNAVAILABLE', `宿主 web 检索失败：${errorMessage(error, 240)}`);
    }
  }

  async function requestAnySearch(query, count, signal, anySearch) {
    if (!config.anySearchApiKey) {
      throw httpError('SEARCH_UNAVAILABLE', 'AnySearch API key 未配置');
    }
    const link = linkedSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(ANYSEARCH_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${config.anySearchApiKey}`,
        },
        // Untagged requests use AnySearch's intent-based routing.
        body: JSON.stringify({
          query,
          max_results: Math.min(count, ANYSEARCH_MAX_RESULTS),
          tag: anySearch?.tag,
          params: anySearch?.params,
        }),
        redirect: 'error',
        signal: link.signal,
      });
      if (!response.ok) {
        // 错误体可能包含凭据，不读取或转发。
        void response.body?.cancel().catch(() => {});
        const message = ANYSEARCH_HTTP_ERRORS[response.status] || '检索请求失败';
        throw httpError('SEARCH_UNAVAILABLE', `AnySearch ${message}（HTTP ${response.status}）`);
      }
      const payload = await response.json();
      if (payload?.code !== 0 || !Array.isArray(payload.data?.results)) {
        throw httpError('SEARCH_UNAVAILABLE', 'AnySearch 未返回有效的检索结果');
      }
      return payload.data.results;
    } catch (error) {
      if (signal?.aborted) throw Object.assign(new Error('AbortError'), { name: 'AbortError' });
      if (link.didTimeout()) throw httpError('TIMEOUT', 'AnySearch 检索请求超时（30s）');
      if (error?.code === 'SEARCH_UNAVAILABLE') throw error;
      throw httpError('SEARCH_UNAVAILABLE', 'AnySearch 请求失败或响应无法读取');
    } finally {
      link.cleanup();
    }
  }

  async function runMode(mode, query, count, signal, anySearch, direct) {
    let rawList;
    if (mode === 'web') rawList = await requestWeb(query, count, signal, direct);
    else if (mode === 'anysearch') rawList = await requestAnySearch(query, count, signal, anySearch);
    else if (mode === 'account' || mode === 'api') rawList = await requestApi(mode, query, count, signal);
    else throw httpError('SEARCH_UNAVAILABLE', `未知检索模式：${mode}`);
    const limit = mode === 'anysearch' ? Math.min(count, ANYSEARCH_MAX_RESULTS) : count;
    const rows = direct ? rawList.slice(0, limit) : rawList;
    const sources = normalizeResults(rows, count, direct);
    if (mode !== 'anysearch') return { sources };
    const records = normalizeAnySearchRecords(rows, count, direct);
    return records.length ? { sources, records } : { sources };
  }

  async function probeUncached(requested) {
    const modes = [];
    if (await accountToken()) modes.push('account');
    if (webService()) modes.push('web');
    if (apiKey()) modes.push('api');
    if (config.anySearchApiKey) modes.push('anysearch');

    let mode = null;
    if (requested === 'auto') mode = modes[0] || null;
    else if (modes.includes(requested)) mode = requested;

    const tried = requested === 'auto' ? AUTO_MODES : [requested];
    return {
      ok: Boolean(mode),
      mode,
      modes,
      error: mode
        ? null
        : readableError({
            code: 'SEARCH_UNAVAILABLE',
            message: requested === 'auto' ? '没有可用的检索路径' : `检索模式 ${requested} 当前不可用`,
            hint: unavailableModesMessage(tried),
          }),
    };
  }

  /** 探测可用检索路径；结果缓存 5 分钟，token 缓存 60 秒。 */
  async function probe({ force = false, searchProviderMode: requested = config.searchProviderMode || 'auto' } = {}) {
    const cached = probeCache.get(requested);
    if (!force && cached && nowMs() - cached.at < PROBE_TTL_MS) return cached.result;
    let result;
    try {
      result = await probeUncached(requested);
    } catch (error) {
      result = {
        ok: false,
        mode: null,
        modes: [],
        error: readableError({
          code: 'SEARCH_UNAVAILABLE',
          message: `检索探测失败：${errorMessage(error, 240)}`,
          hint: unavailableModesMessage(AUTO_MODES),
        }),
      };
    }
    probeCache.set(requested, { result, at: nowMs() });
    return result;
  }

  /**
   * 执行一次检索。
   * @returns {{ok:boolean, mode:string|null, sources:Array, error?:object}}
   */
  async function search(query, { maxResults, signal, anySearch, direct = false, searchProviderMode: requested = config.searchProviderMode || 'auto' } = {}) {
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) {
      return { ok: false, mode: null, sources: [], error: readableError({ code: 'BAD_REQUEST', message: '检索词为空' }) };
    }
    const count = Math.min(50, Math.max(1, Math.round(Number(maxResults) || config.searchMaxResults || 8)));

    let probeResult = null;
    try {
      if (!direct || requested === 'auto') probeResult = await probe({ searchProviderMode: requested });
    } catch (error) {
      return { ok: false, mode: null, sources: [], error: readableError({ code: 'SEARCH_UNAVAILABLE', message: errorMessage(error, 240) }) };
    }

    const candidates = requested === 'auto' ? probeResult.modes.slice() : [requested];
    if (!candidates.length) {
      return {
        ok: false,
        mode: null,
        sources: [],
        error: readableError(probeResult.error || { code: 'SEARCH_UNAVAILABLE', message: '没有可用的检索路径' }),
      };
    }

    const failures = [];
    for (const mode of candidates) {
      try {
        signal?.throwIfAborted();
        const result = await runMode(mode, direct ? query : text, count, signal, anySearch, direct);
        signal?.throwIfAborted();
        if (requested === 'auto' && probeResult.mode !== mode) {
          logWarn(`检索从 ${probeResult.mode || 'unknown'} 降级到 ${mode}`);
        }
        return { ok: true, mode, ...result };
      } catch (error) {
        failures.push({ mode, code: error?.code, hint: error?.hint, message: errorMessage(error, 240) });
        if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
          return {
            ok: false,
            mode,
            sources: [],
            error: readableError({ code: 'TIMEOUT', message: '检索被取消或超时' }),
          };
        }
        logWarn(`${MODE_LABELS[mode] || mode} 检索失败：${errorMessage(error, 240)}`);
      }
    }

    return {
      ok: false,
      mode: null,
      sources: [],
      error: readableError({
        code: direct && failures.every((failure) => failure.code === 'TIMEOUT') ? 'TIMEOUT' : 'SEARCH_UNAVAILABLE',
        message: `检索失败（已尝试 ${failures.map((item) => item.mode).join(' / ')}）：${failures.map((item) => item.message).join('；')}`,
        hint: (direct && requested !== 'auto' && failures[0]?.hint) || unavailableModesMessage(failures.map((item) => item.mode)),
      }),
    };
  }

  function clearCache() {
    tokenCache = { token: '', at: 0 };
    probeCache.clear();
  }

  return { search, probe, clearCache, mode: () => probeCache.get(config.searchProviderMode || 'auto')?.result.mode || null };
}
