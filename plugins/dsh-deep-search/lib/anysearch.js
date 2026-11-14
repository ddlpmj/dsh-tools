import { httpError } from './http.js';

const API_BASE = 'https://api.anysearch.com/v1/';
const CATALOG_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 8000;
const MAX_CACHE_ENTRIES = 64;
const MAX_PARAM_BYTES = 16_000;
const MAX_PARAM_DEPTH = 6;
const MAX_COLLECTION_SIZE = 100;
const DOMAIN_ID = /^[a-z][a-z0-9_]{0,47}$/;
const PARAM_KEY = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const GENERAL_TAG = 'general.general';
const CHINESE_FUNDAMENTAL_TYPES = new Set(['income', 'balance', 'cashflow', 'indicator', 'holder']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cleanDescription(value) {
  return typeof value === 'string' ? value.trim().slice(0, 2400) : '';
}

function catalogParams(tag, raw) {
  if (!isPlainObject(raw)) return [];
  return Object.entries(raw)
    .filter(([key, field]) => PARAM_KEY.test(key) && !RESERVED_KEYS.has(key) && isPlainObject(field))
    .map(([key, field]) => {
      const description = cleanDescription(field.description);
      const conditionalFundamental = tag === 'finance.fundamental' && (key === 'cn_code' || key === 'symbol');
      return {
        key,
        description,
        required: field.required === true && !conditionalFundamental && !/^optional\b/i.test(description),
        order: Number.isFinite(field.sort_order) ? field.sort_order : 0,
      };
    })
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

function paramValue(value, depth = 0) {
  if (depth > MAX_PARAM_DEPTH) throw httpError('BAD_REQUEST', 'AnySearch 参数嵌套过深');
  if (value === null || typeof value === 'boolean' || Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > MAX_PARAM_BYTES) throw httpError('BAD_REQUEST', 'AnySearch 参数内容过长');
    return value;
  }
  if (Array.isArray(value) && value.length <= MAX_COLLECTION_SIZE) {
    return value.map((item) => paramValue(item, depth + 1));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length <= MAX_COLLECTION_SIZE && entries.every(([key]) => !RESERVED_KEYS.has(key))) {
      return Object.fromEntries(entries.map(([key, item]) => [key, paramValue(item, depth + 1)]));
    }
  }
  throw httpError('BAD_REQUEST', 'AnySearch 参数必须是有效的 JSON 值');
}

function normalizeParams(tag, raw, fields) {
  if (raw !== undefined && !isPlainObject(raw)) throw httpError('BAD_REQUEST', 'AnySearch 参数必须是 JSON 对象');
  const supplied = Object.entries(raw ?? {});
  const allowed = new Set(fields.map(({ key }) => key));
  if (supplied.length > allowed.size || supplied.some(([key]) => !allowed.has(key))) {
    throw httpError('BAD_REQUEST', 'AnySearch 参数含有当前检索类型未声明的字段');
  }
  const nonempty = supplied.filter(([, value]) => value !== null && !(typeof value === 'string' && !value.trim()));
  const params = Object.fromEntries(nonempty.map(([key, value]) => [key, paramValue(value)]));
  if (Buffer.byteLength(JSON.stringify(params)) > MAX_PARAM_BYTES) {
    throw httpError('BAD_REQUEST', 'AnySearch 参数内容过长');
  }
  const missing = fields.filter(({ key, required }) => required && !Object.hasOwn(params, key)).map(({ key }) => key);
  if (tag === 'finance.fundamental' && CHINESE_FUNDAMENTAL_TYPES.has(params.type) && !Object.hasOwn(params, 'cn_code')) {
    missing.push('cn_code');
  }
  if (missing.length) throw httpError('BAD_REQUEST', `请填写 AnySearch 参数 ${missing.join('、')}`);
  return params;
}

export function createAnySearchCatalog({ fetchImpl } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch;
  const cache = new Map();
  const inFlight = new Map();

  async function request(path, query) {
    const url = new URL(path, API_BASE);
    if (query) url.search = new URLSearchParams(query).toString();
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      const response = await doFetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      if (!response.ok) {
        // Keep upstream error bodies out of client responses and logs.
        void response.body?.cancel().catch(() => {});
        throw httpError('SEARCH_UNAVAILABLE', `AnySearch 能力目录暂不可用（HTTP ${response.status}）`);
      }
      const payload = await response.json();
      if (payload?.code !== 0 || !Array.isArray(payload.data?.domains)) {
        throw httpError('SEARCH_UNAVAILABLE', 'AnySearch 未返回有效的能力目录');
      }
      return payload.data.domains;
    } catch (error) {
      if (signal.aborted) throw httpError('TIMEOUT', 'AnySearch 能力目录请求超时');
      if (error?.code === 'SEARCH_UNAVAILABLE') throw error;
      throw httpError('SEARCH_UNAVAILABLE', 'AnySearch 能力目录请求失败');
    }
  }

  async function loadCached(key, load) {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = load().then((value) => {
      cache.delete(key);
      if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { value, expiresAt: Date.now() + CATALOG_TTL_MS });
      return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }

  async function domains() {
    return loadCached('domains', async () => (await request('domains'))
      .filter((item) => typeof item?.domain === 'string' && DOMAIN_ID.test(item.domain))
      .map((item) => ({ id: item.domain, description: cleanDescription(item.description) })));
  }

  async function capabilities(domain) {
    if (typeof domain !== 'string' || !DOMAIN_ID.test(domain)) throw httpError('BAD_REQUEST', 'AnySearch 检索领域无效');
    return loadCached(`domain:${domain}`, async () => {
      const result = (await request('sub-domains', { domain })).find((item) => item?.domain === domain);
      if (!Array.isArray(result?.sub_domains)) return [];
      const prefix = `${domain}.`;
      return result.sub_domains.filter((item) => (
        typeof item?.sub_domain === 'string'
        && item.sub_domain.startsWith(prefix)
        && DOMAIN_ID.test(item.sub_domain.slice(prefix.length))
      )).map((item) => ({
        tag: item.sub_domain,
        description: cleanDescription(item.description),
        params: catalogParams(item.sub_domain, item.params),
      }));
    });
  }

  async function validate(selection) {
    if (selection == null) return undefined;
    if (!isPlainObject(selection)) throw httpError('BAD_REQUEST', 'AnySearch 检索选项必须是 JSON 对象');
    const { mode, tag, params } = selection;
    if (mode === 'auto' && tag === undefined && params === undefined) return undefined;
    if (mode !== undefined && mode !== 'manual') throw httpError('BAD_REQUEST', 'AnySearch 检索模式无效');
    const [domain, capability, extra] = typeof tag === 'string' ? tag.split('.') : [];
    if (!domain || !capability || extra !== undefined || !DOMAIN_ID.test(domain) || !DOMAIN_ID.test(capability)) {
      throw httpError('BAD_REQUEST', '请选择有效的 AnySearch 检索类型');
    }
    if (tag === GENERAL_TAG) return { tag, params: normalizeParams(tag, params, []) };
    const definition = (await capabilities(domain)).find((item) => item.tag === tag);
    if (!definition) throw httpError('BAD_REQUEST', 'AnySearch 能力目录中没有所选检索类型');
    return { tag, params: normalizeParams(tag, params, definition.params) };
  }

  return { domains, capabilities, validate };
}
