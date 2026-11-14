import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const API_PREFIX = '/api/v1/wx';
const MAX_RESPONSE = 3 * 1024 * 1024;

export class WechatProviderError extends Error {
  constructor(code, message, status = 503) { super(message); this.code = code; this.status = status; }
}

export function validateWechatArticle(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new WechatProviderError('BAD_ARTICLE', '请输入公众号文章链接。', 400); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'mp.weixin.qq.com' || url.port || url.username || url.password ||
      !(/^\/s\/[A-Za-z0-9_-]+\/?$/.test(url.pathname) || url.pathname === '/s' && url.searchParams.has('__biz') && url.searchParams.has('mid'))) {
    throw new WechatProviderError('BAD_ARTICLE', '仅支持 mp.weixin.qq.com 的公众号文章链接。', 400);
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key)) url.searchParams.delete(key);
  return url.href;
}

const providerErrorCode = (message, status, code) => status === 429 || Number(code) === 200013 || /频率限制|请求频繁|访问频繁|200013/.test(message) ? 'PROVIDER_RATE_LIMIT' : /扫码|授权|登录|cookie|token/i.test(message) ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR';
function unwrap(body, redact = value => value) {
  if (body && body.code === 0 && body.data != null) return body.data;
  const detail = body?.detail && typeof body.detail === 'object' ? body.detail : body;
  const message = String(detail?.message || '公众号服务响应异常。').slice(0, 200);
  throw new WechatProviderError(providerErrorCode(message, 200, detail?.code), redact(message));
}

export function parseWechatAccountMetadata(html) {
  const decode = value => String(value || '').replace(/\\x([\da-f]{2})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\\u([\da-f]{4})/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity => {
      const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' };
      const n = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return named[entity.toLowerCase()] || (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');
    }).replace(/<[^>]*>/g, '').trim();
  // Streaming prefixes must not turn an unfinished string into an account identity.
  const bizMatch = html.match(/\b(?:var\s+)?biz\s*=\s*(?:"((?:\\[^\r\n]|[^"\\\r\n])*)"|'((?:\\[^\r\n]|[^'\\\r\n])*)')/);
  const nameMatch = html.match(/\bnickname\s*=\s*(?:htmlDecode\()?\s*(?:"((?:\\[^\r\n]|[^"\\\r\n])*)"|'((?:\\[^\r\n]|[^'\\\r\n])*)')/);
  const biz = decode(bizMatch?.[1] ?? bizMatch?.[2]);
  // The article byline identifies its publisher; later scripts can name related accounts.
  const name = decode(html.match(/id=['"]js_name['"][^>]*>([\s\S]*?)<\/[^>]+>/)?.[1]
    || html.match(/id=['"]js_wx_follow_nickname['"][^>]*>([\s\S]*?)<\/[^>]+>/)?.[1]
    || (nameMatch?.[1] ?? nameMatch?.[2]));
  const numeric = Buffer.from(biz, 'base64').toString('utf8');
  return biz && name && /^\d+$/.test(numeric) ? { biz, name } : null;
}

/** Article bodies can be large; only scan a bounded prefix for complete account metadata. */
async function readPublicAccountMetadata(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let size = 0;
  try {
    while (size < MAX_RESPONSE) {
      const { value, done } = await reader.read();
      if (done) return parseWechatAccountMetadata(text + decoder.decode());
      const prefix = value.subarray(0, MAX_RESPONSE - size);
      size += prefix.byteLength;
      text += decoder.decode(prefix, { stream: true });
      const metadata = parseWechatAccountMetadata(text);
      if (metadata) return metadata;
    }
    return null;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function limitedBody(response, max = MAX_RESPONSE) {
  if (Number(response.headers.get('content-length')) > max) throw new WechatProviderError('TOO_LARGE', '公众号服务响应过大。');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.byteLength;
    if (size > max) { await response.body.cancel?.().catch(() => {}); throw new WechatProviderError('TOO_LARGE', '公众号服务响应过大。'); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Credentials remain on the host. The UI receives status and a same-origin QR image only. */
export function createWechatProvider({ privateFile, fetchImpl = fetch } = {}) {
  let config = null;
  let token = '';
  let loginPromise = null;
  let qrPromise = null;
  let resolveQueue = Promise.resolve();
  let authRejected = false;
  let lastAuth = null;
  let authStatusPromise = null;
  let refreshCount = 0;
  let launching = null;
  let lastLaunch = 0;
  let lastRefreshStartedAt = 0;
  const secrets = new Set();
  const redact = value => { let message = String(value); for (const secret of secrets) if (secret) message = message.split(secret).join('[已隐藏]'); return message; };
  const resolving = new Map();

  async function settings() {
    if (config) return config;
    if (!privateFile) throw new WechatProviderError('PROVIDER_NOT_CONFIGURED', '公众号服务尚未配置。');
    let raw;
    try { raw = JSON.parse(await fs.readFile(privateFile, 'utf8')); } catch { throw new WechatProviderError('PROVIDER_NOT_CONFIGURED', '公众号服务尚未配置。'); }
    let base;
    try { base = new URL(raw.baseUrl); } catch { throw new WechatProviderError('PROVIDER_NOT_CONFIGURED', '公众号服务地址不正确。'); }
    // This deployment uses a private loopback bridge; credentials never follow redirects.
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) {
      throw new WechatProviderError('PROVIDER_NOT_CONFIGURED', '公众号服务必须使用配置的本机地址。');
    }
    config = { baseUrl: base.origin, username: String(raw.username || ''), password: String(raw.password || ''), apiPrefix: API_PREFIX,
      seedAccounts: Array.isArray(raw.seedAccounts) ? raw.seedAccounts : [], runtime: raw.runtime,
      publicFeeds: raw.publicFeeds && typeof raw.publicFeeds === 'object' && !Array.isArray(raw.publicFeeds) ? raw.publicFeeds : {},
      minimumRefreshIntervalMs: typeof raw.minimumRefreshIntervalMs === 'number' ? Math.min(60000, Math.max(0, raw.minimumRefreshIntervalMs)) : 0 };
    if (!config.username || !config.password) throw new WechatProviderError('PROVIDER_NOT_CONFIGURED', '公众号服务登录配置缺失。');
    token = typeof raw.accessToken === 'string' ? raw.accessToken : '';
    secrets.add(config.password); secrets.add(token);
    return config;
  }

  // A host-owned deployment descriptor may start this private bridge on demand.
  // No command or credential can be supplied by an HTTP request.
  async function ensureRunning(cfg) {
    if (launching) return launching;
    const runtime = cfg.runtime;
    if (!runtime || !['python', 'script', 'cwd', 'logFile'].every(key => typeof runtime[key] === 'string' && path.isAbsolute(runtime[key]))) return false;
    if (Date.now() - lastLaunch < 60000) {
      try {
        const response = await fetchImpl(cfg.baseUrl + '/openapi.json', { signal: AbortSignal.timeout(2000), redirect: 'error' });
        await response.body?.cancel().catch(() => {});
        return response.ok;
      } catch { return false; }
    }
    lastLaunch = Date.now();
    launching = (async () => {
      let log;
      try {
        await fs.access(runtime.python); await fs.access(runtime.script);
        log = await fs.open(runtime.logFile, 'a', 0o600);
        const child = spawn(runtime.python, ['-u', runtime.script], { cwd: runtime.cwd, detached: true,
          env: { HOME: os.homedir(), PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai' }, stdio: ['ignore', log.fd, log.fd] });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref();
        await log.close(); log = null;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          try {
            const response = await fetchImpl(cfg.baseUrl + '/openapi.json', { signal: AbortSignal.timeout(2000), redirect: 'error' });
            await response.body?.cancel().catch(() => {});
            if (response.ok) return true;
          } catch { /* Allow the local service time to start. */ }
          await new Promise(resolve => setTimeout(resolve, 400));
        }
      } catch { /* Surface a connection error, without process logs or credentials. */ }
      finally { await log?.close().catch(() => {}); }
      return false;
    })();
    try { return await launching; } finally { launching = null; }
  }

  async function request(route, { method = 'GET', body, raw = false, timeoutMs = 20000, auth = true, retry = true } = {}) {
    const cfg = await settings();
    if (auth && !token) await login();
    const headers = {};
    if (auth) headers.authorization = 'Bearer ' + token;
    if (body != null) headers['content-type'] = body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : 'application/json';
    let response;
    try {
      response = await fetchImpl(cfg.baseUrl + route, { method, headers, body: body == null ? undefined : body instanceof URLSearchParams ? body.toString() : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      if (retry && await ensureRunning(cfg)) return request(route, { method, body, raw, timeoutMs, auth, retry: false });
      throw new WechatProviderError('PROVIDER_UNREACHABLE', '暂时无法连接公众号服务，请稍后重试。');
    }
    if (response.status === 401 && auth && retry) {
      token = '';
      await login();
      return request(route, { method, body, raw, timeoutMs, auth, retry: false });
    }
    const buffer = await limitedBody(response);
    if (raw) {
      if (!response.ok || !/^image\/(png|jpeg)/i.test(response.headers.get('content-type') || '')) throw new WechatProviderError('QR_NOT_READY', '授权二维码尚未就绪，请稍后刷新。');
      return { buffer, mime: response.headers.get('content-type').split(';')[0] };
    }
    let data;
    try { data = JSON.parse(buffer.toString('utf8')); } catch { throw new WechatProviderError('PROVIDER_ERROR', '公众号服务返回了无法识别的内容。'); }
    if (!response.ok) {
      const message = String(data?.detail?.message || data?.message || '公众号服务请求失败。');
      throw new WechatProviderError(providerErrorCode(message, response.status, data?.detail?.code ?? data?.code), redact(message));
    }
    return unwrap(data, redact);
  }

  async function login() {
    if (loginPromise) return loginPromise;
    loginPromise = (async () => {
      const cfg = await settings();
      const data = await request(API_PREFIX + '/auth/login', { method: 'POST', body: new URLSearchParams({ username: cfg.username, password: cfg.password }), auth: false });
      if (typeof data.access_token !== 'string' || !data.access_token) throw new WechatProviderError('PROVIDER_LOGIN_FAILED', '公众号服务登录失败。');
      token = data.access_token;
      secrets.add(token);
    })();
    try { await loginPromise; } finally { loginPromise = null; }
  }

  async function readAuthStatus() {
    if (!authRejected && lastAuth?.authorized && (refreshCount || Date.now() - lastAuth.checkedAt < 15000)) return { authorized: true, requiresAuth: false, qrReady: lastAuth.qrReady };
    const data = await request(API_PREFIX + '/auth/qr/status', { timeoutMs: 6000 });
    let authorized = data.login_status === true;
    if (authorized) authRejected = false;
    // WeRSS keeps _haslogin in memory, but persists credentials across a service restart.
    // Only return the boolean; /sys/info also contains credentials and must never reach the UI.
    if (!authorized && !authRejected) {
      try {
        const info = (await request(API_PREFIX + '/sys/info', { timeoutMs: 6000 })).wx?.info;
        if (typeof info?.token === 'string') secrets.add(info.token);
        if (typeof info?.cookie === 'string') secrets.add(info.cookie);
        const timestamp = Number(info?.expiry?.expiry_timestamp);
        const until = timestamp > 0 ? timestamp * (timestamp < 1e12 ? 1000 : 1) : Date.parse(info?.expiry?.expiry_time || '');
        authorized = !!(info?.token && info?.cookie && Number.isFinite(until) && until > Date.now());
      } catch { /* No persisted authorization: let the user scan a QR code. */ }
    }
    lastAuth = { authorized, checkedAt: Date.now(), qrReady: data.qr_code === true };
    return { authorized, requiresAuth: !authorized, qrReady: data.qr_code === true };
  }

  async function authStatus() {
    if (authStatusPromise) return authStatusPromise;
    const pending = readAuthStatus();
    authStatusPromise = pending;
    try { return await pending; }
    finally { if (authStatusPromise === pending) authStatusPromise = null; }
  }

  async function status() {
    try {
      const cfg = await settings();
      const state = await authStatus();
      return { configured: true, reachable: true, baseUrl: cfg.baseUrl, ...state };
    } catch (error) {
      return { configured: error.code !== 'PROVIDER_NOT_CONFIGURED', reachable: false, authorized: false, requiresAuth: true, error: error.message, code: error.code || 'PROVIDER_ERROR' };
    }
  }

  async function authCode() {
    if (qrPromise) return qrPromise;
    qrPromise = (async () => {
      const state = await authStatus();
      if (state.authorized) return state;
      await request(API_PREFIX + '/auth/qr/code', { timeoutMs: 65000 });
      return { authorized: false, requiresAuth: true, qrImage: '/dsh-ai-intel/wechat/provider/qr-image', message: '请用有公众号后台权限的微信扫码授权。' };
    })();
    try { return await qrPromise; } finally { qrPromise = null; }
  }

  async function resolveOne(value) {
    const url = validateWechatArticle(value);
    const state = await authStatus();
    if (!state.authorized) throw new WechatProviderError('AUTH_REQUIRED', '请先扫码授权公众号服务，再添加指定账号。');
    const cfg = await settings();
    const known = cfg.seedAccounts.find(account => account.url === url && account.biz && account.name);
    let publicMeta = known ? { biz: known.biz, name: known.name } : null;
    try {
      let target = url;
      const signal = AbortSignal.timeout(60000);
      for (let hop = 0; !publicMeta && hop < 4; hop++) {
        const response = await fetchImpl(target, { redirect: 'manual', signal, headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140 Safari/537.36' } });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
          await response.body?.cancel().catch(() => {});
          target = validateWechatArticle(new URL(response.headers.get('location'), target).href); continue;
        }
        if (response.ok) publicMeta = await readPublicAccountMetadata(response);
        else await response.body?.cancel().catch(() => {});
        break;
      }
    } catch { /* A normal browser fetch is the fallback, never a verification-page bypass. */ }
    const info = publicMeta || await request(API_PREFIX + '/mps/by_article?url=' + encodeURIComponent(url), { method: 'POST', timeoutMs: 65000 });
    const meta = info.mp_info || info;
    const biz = String(meta.biz || meta.mp_id || '');
    const name = String(meta.name || meta.nickname || meta.mp_name || '').trim().slice(0, 100);
    let numeric = '';
    try { numeric = Buffer.from(biz, 'base64').toString('utf8'); } catch { /* Invalid metadata must not create a subscription. */ }
    if (info.fetch_error || !name || !/^\d+$/.test(numeric)) throw new WechatProviderError('ACCOUNT_NOT_RESOLVED', '未能从文章识别公众号，请重试或换一篇该账号的文章。');
    const id = 'MP_WXS_' + numeric;
    const publicFeed = cfg.publicFeeds[id];
    if (typeof publicFeed === 'string') return { id, name, feedUrl: publicFeed, seedUrl: url };
    const account = await request(API_PREFIX + '/mps', { method: 'POST', body: { mp_name: name, mp_id: biz, avatar: '', mp_intro: '' }, timeoutMs: 20000 });
    if (account.id !== id) throw new WechatProviderError('ACCOUNT_NOT_RESOLVED', '公众号服务返回的账号身份不一致。');
    return { id, name, feedUrl: cfg.baseUrl + '/feed/' + id + '.xml', seedUrl: url };
  }

  function resolve(value) {
    const url = validateWechatArticle(value);
    if (resolving.has(url)) return resolving.get(url);
    const pending = resolveQueue.catch(() => {}).then(() => resolveOne(url));
    resolveQueue = pending;
    resolving.set(url, pending);
    const clear = () => { if (resolving.get(url) === pending) resolving.delete(url); };
    pending.then(clear, clear);
    return pending;
  }

  async function refresh(accountId) {
    if (!/^MP_WXS_\d+$/.test(String(accountId || ''))) throw new WechatProviderError('BAD_ACCOUNT', '公众号身份不正确。', 400);
    const state = await authStatus();
    if (!state.authorized) throw new WechatProviderError('AUTH_REQUIRED', '公众号授权已过期，请重新扫码。');
    const cfg = await settings();
    const wait = cfg.minimumRefreshIntervalMs - (Date.now() - lastRefreshStartedAt);
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    lastRefreshStartedAt = Date.now();
    refreshCount++;
    try { return await request(API_PREFIX + '/mps/update/' + accountId + '?start_page=0&end_page=1', { timeoutMs: 90000 }); }
    catch (error) {
      if (/频繁更新/.test(error.message)) return { throttled: true };
      if (error.code === 'AUTH_REQUIRED') authRejected = true;
      throw error;
    } finally { refreshCount--; }
  }

  return { status, authCode, authStatus, resolve, refresh, async qrImage() { return request('/static/wx_qrcode.png', { raw: true, auth: false, timeoutMs: 6000 }); } };
}
