import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { BEATING_HOME, BEATING_ACCOUNT, isBeatingPublisher, isBeatingContentUrl, collectBeatingPublisher } from './beating-publisher.js';

const DAY = 86400000;
// Project policy: a provider's rate limit cools that provider, not independent public feeds.
const RATE_LIMIT_BACKOFF_MS = 30 * 60000;
const MAX_FEED_BYTES = 4 * 1024 * 1024;
const MAX_ARTICLE_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 5000;
const locks = new Map();
const sha = value => createHash('sha256').update(String(value)).digest('hex');
export class WechatError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new WechatError(code, message, status); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
// IDs identify an account; a generation identifies this particular subscription to it.
// Legacy subscriptions have no generation, so createdAt remains part of the identity.
const sameSubscription = (current, snapshot) => current && snapshot && current.id === snapshot.id
  && current.createdAt === snapshot.createdAt && (current.generation || '') === (snapshot.generation || '');

export function canonicalArticleUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return ''; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hostname.toLowerCase().replace(/\.$/, '') !== 'mp.weixin.qq.com' || !/^\/s(?:\/[^/]+)?\/?$/.test(u.pathname)) return '';
  if (u.pathname.replace(/\/+$/, '') === '/s' && !(u.searchParams.get('__biz') && u.searchParams.get('mid'))) return '';
  u.protocol = 'https:'; u.hostname = 'mp.weixin.qq.com'; u.port = ''; u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key) || ['scene', 'subscene', 'from', 'isappinstalled', 'clicktime', 'enterid'].includes(key.toLowerCase())) u.searchParams.delete(key);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  u.searchParams.sort();
  return u.href;
}

function normalizedOrigin(raw) { try { return new URL(raw).origin; } catch { return ''; } }
function loopback(host) { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host.toLowerCase()); }
function blockedIp(address) {
  const value = address.toLowerCase().split('%')[0];
  if (isIP(value) === 4) {
    const a = value.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 || (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) || (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127);
  }
  if (isIP(value) === 6) return !/^[23]/.test(value) || value.startsWith('2001:db8:');
  return true;
}
function feedUrl(raw, allowedOrigins) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { fail('BAD_FEED_URL', '请输入有效的单个公众号 RSS 地址。'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.href.length > 4096 || u.hash) fail('BAD_FEED_URL', 'RSS 地址仅支持不含账号密码和片段的 HTTP(S) 链接。');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (loopback(host)) {
    if (!allowedOrigins.has(u.origin)) fail('BLOCKED_FEED_URL', '该本地 RSS 服务尚未配置为可信来源。');
  } else if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (isIP(host.replace(/^\[|\]$/g, '')) && blockedIp(host.replace(/^\[|\]$/g, '')))) fail('BLOCKED_FEED_URL', '不能采集内网或本机的未授权地址。');
  return u;
}
export function feedAccountId(raw) {
  let u;
  try { u = new URL(raw); } catch { return ''; }
  const match = u.pathname.match(/^\/(?:api\/rss|rss|feed|feeds)\/([A-Za-z0-9_-]+?)(?:\.(?:xml|rss|atom|json))?\/?$/i);
  if (!match || /^(?:all|fresh|latest|list|articles)$/i.test(match[1])) return '';
  return match[1];
}
function accountIdentity(value) {
  const raw = String(value || '').trim();
  if (/^MP_WXS_/i.test(raw)) return raw.slice(7);
  try { const decoded = Buffer.from(raw, 'base64').toString('utf8'); if (/^\d+$/.test(decoded)) return decoded; } catch { /* A non-base64 provider ID is valid. */ }
  return raw;
}
function articleOwner(url) {
  try { return accountIdentity(new URL(url).searchParams.get('__biz')); } catch { return ''; }
}
function boundedText(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
const decodeXml = text => String(text || '').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, entity => {
  const named = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
  if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
  const n = entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
});
function xmlTree(text) {
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) fail('BAD_FEED', 'RSS 不能包含文档类型或外部实体。');
  const root = { name: '', children: [], text: '', attrs: {} }, stack = [root]; let count = 0;
  const tokens = text.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (++count > 100000) fail('BAD_FEED', 'RSS 结构过大。');
    if (token.startsWith('<!--') || token.startsWith('<?')) continue;
    if (token.startsWith('<![CDATA[')) { stack.at(-1).text += token.slice(9, -3); continue; }
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const name = token.match(/^<\s*([^\s/>]+)/)?.[1]?.toLowerCase();
      if (!name || token.startsWith('<!')) continue;
      const attrs = {};
      for (const m of token.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1].toLowerCase()] = decodeXml(m[2] ?? m[3]);
      const node = { name, children: [], text: '', attrs }; stack.at(-1).children.push(node);
      if (!/\/\s*>$/.test(token)) { stack.push(node); if (stack.length > 100) fail('BAD_FEED', 'RSS 嵌套过深。'); }
    } else stack.at(-1).text += decodeXml(token);
  }
  return root;
}
function allNodes(root, names, output = []) { if (names.includes(root.name)) output.push(root); for (const ch of root.children || []) allNodes(ch, names, output); return output; }
function nodeText(node) { return (node?.text || '') + (node?.children || []).map(nodeText).join(''); }
function child(node, names) { return node.children.find(ch => names.includes(ch.name)); }
function cleanLabel(text) { return decodeXml(text).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
export function parseWechatFeed(text, contentType = '') {
  if (/^\s*[\[{]/.test(text) || /application\/(?:feed\+)?json/i.test(contentType)) {
    let data; try { data = JSON.parse(text); } catch { fail('BAD_FEED', 'RSS 服务没有返回有效 JSON。'); }
    if (!Array.isArray(data.items)) fail('BAD_FEED', 'RSS 服务没有返回文章列表。');
    return data.items.slice(0, MAX_ITEMS).map(item => ({ title: cleanLabel(item.title || ''), url: item.url || item.external_url || '', published: item.date_published || item.date_modified || '', owner: item._account_id || item._wechat?.accountId || '', html: typeof item.content_html === 'string' ? item.content_html : '' }));
  }
  const tree = xmlTree(text);
  if (!allNodes(tree, ['rss', 'feed', 'rdf:rdf']).length) fail('BAD_FEED', 'RSS 服务返回了登录页或其他内容，请检查授权。');
  return allNodes(tree, ['item', 'entry']).slice(0, MAX_ITEMS).map(item => {
    const links = item.children.filter(ch => ch.name === 'link');
    const link = links.find(ch => !ch.attrs.rel || ch.attrs.rel === 'alternate') || links[0];
    const owner = child(item, ['accountid', 'account_id', 'mp_id', 'wechat:accountid', 'wechat:account_id']);
    // RSS descriptions are often only summaries. Only the explicit full-content field is cached.
    const content = child(item, ['content:encoded']) || item.children.find(ch => ch.name === 'content' && ['html', 'text/html'].includes(ch.attrs.type));
    return { title: cleanLabel(nodeText(child(item, ['title']))), url: link?.attrs.href || nodeText(link).trim(), published: nodeText(child(item, ['pubdate', 'published', 'updated', 'dc:date'])).trim(), owner: nodeText(owner).trim(), html: nodeText(content) };
  });
}

async function atomicJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
  try { await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
function serialized(file, fn) {
  const previous = locks.get(file) || Promise.resolve();
  const current = previous.catch(() => {}).then(fn); locks.set(file, current);
  current.finally(() => { if (locks.get(file) === current) locks.delete(file); }).catch(() => {});
  return current;
}

export function createWechatMonitor(options) {
  const file = path.join(options.libraryDir, '数据', '公众号订阅.json');
  const contentDir = path.join(options.libraryDir, '数据', '公众号正文');
  const allowedOrigins = new Set((options.allowedFeedOrigins || []).filter(raw => { try { const u = new URL(raw); return loopback(u.hostname) && !u.username && !u.password; } catch { return false; } }).map(normalizedOrigin));
  const rateLimitOrigins = (options.rateLimitOrigins || []).map(normalizedOrigin).filter(Boolean);
  const retryOrigin = state => state.retryOrigin || rateLimitOrigins[0] || '';
  const cooling = (state, sub) => Date.parse(state.retryAt || '') > Date.now()
    && (!retryOrigin(state) || normalizedOrigin(sub.feedUrl) === retryOrigin(state));
  let disposed = false, timer = null, pendingRun = null, nextRun = null, scheduleGeneration = 0;
  const controllers = new Set();
  const empty = () => ({ version: 1, enabled: true, intervalMinutes: 120, subscriptions: [], articles: [], seen: {}, pendingLibrary: [], lastRun: null, retryAt: '' });
  async function read() {
    try { const state = JSON.parse(await fs.readFile(file, 'utf8')); if (state.version !== 1 || !Array.isArray(state.subscriptions) || !Array.isArray(state.articles) || !plain(state.seen)) throw Error('bad shape'); return state; }
    catch (e) { if (e.code === 'ENOENT') return empty(); throw new WechatError('STATE_ERROR', '公众号订阅数据无法读取，请保留原文件并检查。', 500); }
  }
  const mutate = fn => serialized(file, async () => { if (disposed) fail('DISPOSED', '订阅服务正在重载，请稍后重试。', 503); const state = await read(); const result = await fn(state); await atomicJson(file, state); return result; });
  const publicSubscription = (sub, state) => ({ ...sub, sourceKind: isBeatingPublisher(sub.feedUrl, sub.accountId) ? 'publisher' : 'rss', articleCount: state.articles.filter(a => a.accountId === sub.id || a.accountIds?.includes(sub.id)).length, status: sub.feedUrl ? (sub.lastError ? 'error' : sub.initialized ? 'watching' : 'pending') : 'needs-configuration' });
  async function status() {
    const state = await read();
    return { ok: true, enabled: state.enabled, intervalMinutes: state.intervalMinutes, running: !!pendingRun, lastRun: state.lastRun, nextRun, retryAt: state.retryAt || null, retryOrigin: state.retryAt ? retryOrigin(state) || null : null,
      subscriptions: state.subscriptions.map(sub => publicSubscription(sub, state)), counts: { subscriptions: state.subscriptions.length, active: state.subscriptions.filter(s => s.enabled && s.feedUrl).length, articles: state.articles.length, unread: state.articles.filter(a => !a.read).length } };
  }
  async function reschedule() {
    const generation = ++scheduleGeneration;
    if (timer) clearTimeout(timer); timer = null; nextRun = null;
    if (disposed) return;
    const state = await read();
    if (disposed || generation !== scheduleGeneration || !state.enabled || !state.subscriptions.some(s => s.enabled && s.feedUrl)) return;
    const now = Date.now();
    const retryAt = Date.parse(state.retryAt || '') || 0;
    const delay = Math.max(state.intervalMinutes * 60000, retryAt - now);
    nextRun = new Date(now + delay).toISOString();
    timer = setTimeout(() => { timer = null; nextRun = null; void check().catch(() => {}); }, delay); timer.unref?.();
  }
  async function addSubscription(input = {}, expectedSubscription = null, initialSeed = false) {
    const seedUrl = input.seedUrl ? canonicalArticleUrl(input.seedUrl) : '';
    if (input.seedUrl && !seedUrl) fail('BAD_ARTICLE_URL', '请使用微信公众号文章链接。');
    const parsed = input.feedUrl ? feedUrl(input.feedUrl, allowedOrigins) : null;
    if (!parsed && !seedUrl) fail('BAD_SUBSCRIPTION', '请提供公众号文章链接或单账号 RSS 地址。');
    const derived = parsed ? feedAccountId(parsed.href) : '';
    const accountId = boundedText(input.accountId || derived, 160);
    if (parsed?.href === BEATING_HOME && accountId !== BEATING_ACCOUNT) fail('ACCOUNT_MISMATCH', '动察官网同步仅用于已核对的动察 Beating 账号。');
    if (parsed && /\/(?:all|fresh|latest)(?:[/.?]|$)/i.test(parsed.pathname)) fail('MIXED_FEED', '请添加单个公众号订阅源，不能使用全部账号合集。');
    if (parsed && !accountId) fail('ACCOUNT_REQUIRED', '该 RSS 地址无法识别账号，请提供明确的公众号账号标识。');
    if (derived && accountIdentity(accountId) !== accountIdentity(derived)) fail('ACCOUNT_MISMATCH', '订阅源与指定公众号账号不一致。');
    const result = await mutate(state => {
      // Background seed resolution may finish after a deletion, pause or replacement.
      // Check inside the same write queue as deletion, rather than just before awaiting it.
      if (expectedSubscription) {
        const intent = state.subscriptions.find(sub => sameSubscription(sub, expectedSubscription));
        if (!intent || intent.enabled === false || intent.feedUrl) return { skipped: true };
      }
      const deleted = Array.isArray(state.deletedSubscriptions) ? state.deletedSubscriptions : [];
      const deletedMatches = deleted.filter(sub => (seedUrl && sub.seedUrls?.includes(seedUrl))
        || (accountId && sub.accountId && accountIdentity(sub.accountId) === accountIdentity(accountId))
        || (parsed && sub.feedUrl === parsed.href) || (input.id && sub.id === input.id));
      // Configured startup seeds are defaults, not permission to restore a removed account.
      if (initialSeed && deletedMatches.length) return { skipped: true };
      const rememberedSeeds = [...new Set(deletedMatches.flatMap(sub => sub.seedUrls || []))];
      if (!initialSeed && !expectedSubscription && deletedMatches.length) {
        state.deletedSubscriptions = deleted.filter(sub => !deletedMatches.includes(sub));
      }
      const seedMatches = sub => seedUrl && (sub.seedUrl === seedUrl || (sub.seedUrls || []).includes(seedUrl));
      // Prefer the already resolved account, even if a second pending seed appears
      // earlier in the list or its local ID was supplied by an import operation.
      const sameAccount = accountId && state.subscriptions.find(sub => sub.accountId && accountIdentity(sub.accountId) === accountIdentity(accountId));
      const existing = sameAccount || state.subscriptions.find(sub => (input.id && sub.id === input.id) || (parsed && sub.feedUrl === parsed.href) || seedMatches(sub));
      if (existing) {
        const wasPending = !existing.feedUrl;
        const duplicates = state.subscriptions.filter(sub => sub !== existing && ((input.id && sub.id === input.id) || seedMatches(sub) || (parsed && sub.feedUrl === parsed.href) || (accountId && sub.accountId && accountIdentity(sub.accountId) === accountIdentity(accountId))));
        const aliases = [...(existing.seedUrls || []), existing.seedUrl, seedUrl, ...rememberedSeeds];
        for (const duplicate of duplicates) aliases.push(duplicate.seedUrl, ...(duplicate.seedUrls || []));
        existing.seedUrls = [...new Set(aliases.filter(Boolean))];
        if (!existing.seedUrl) existing.seedUrl = seedUrl || rememberedSeeds[0] || '';
        if (parsed && !existing.feedUrl) {
          if (['from-now', 'recent', 'history'].includes(input.mode)) existing.mode = input.mode;
          existing.feedUrl = parsed.href; existing.accountId = accountId; existing.initialized = false; existing.lastError = '';
        }
        if (input.name && wasPending) existing.name = boundedText(input.name, 160);
        if (duplicates.length) {
          const removed = new Set(duplicates.map(sub => sub.id));
          state.subscriptions = state.subscriptions.filter(sub => !removed.has(sub.id));
          for (const article of state.articles) {
            if (removed.has(article.accountId)) { article.accountId = existing.id; article.accountName = existing.name; }
            if (article.accountIds?.some(id => removed.has(id))) article.accountIds = [...new Set(article.accountIds.map(id => removed.has(id) ? existing.id : id))];
          }
        }
        return { subscription: clone(existing), existed: true, merged: duplicates.length };
      }
      const sub = { id: 'wxsub_' + sha(accountId || parsed?.href || seedUrl).slice(0, 18), accountId, name: boundedText(input.name, 160) || accountId || '待授权公众号', feedUrl: parsed?.href || '', seedUrl: seedUrl || rememberedSeeds[0] || '', seedUrls: [...new Set([seedUrl, ...rememberedSeeds].filter(Boolean))], mode: ['recent', 'history'].includes(input.mode) ? input.mode : 'from-now', enabled: true, initialized: false,
        createdAt: new Date().toISOString(), generation: randomBytes(12).toString('hex'), lastCheckedAt: '', lastSuccessAt: '', lastError: '', lastAdded: 0 };
      if (state.subscriptions.length >= 200) fail('LIMIT', '最多订阅 200 个公众号。');
      state.subscriptions.push(sub); return { subscription: clone(sub), existed: false };
    });
    await reschedule(); return { ok: true, ...result };
  }
  async function removeSubscription(id) {
    if (typeof id !== 'string' || !/^wxsub_[0-9a-f]{18}$/.test(id)) fail('BAD_REQUEST', '请选择有效的公众号订阅。');
    const result = await mutate(state => {
      const index = state.subscriptions.findIndex(sub => sub.id === id);
      if (index < 0) return { deleted: id, alreadyDeleted: true };
      // Collected articles, cache files, seen IDs and pending library deliveries stay intact.
      const [removed] = state.subscriptions.splice(index, 1);
      const deleted = Array.isArray(state.deletedSubscriptions) ? state.deletedSubscriptions : [];
      const prior = deleted.find(sub => sub.id === id);
      state.deletedSubscriptions = [...deleted.filter(sub => sub.id !== id), {
        id, accountId: removed.accountId, feedUrl: removed.feedUrl,
        seedUrls: [...new Set([removed.seedUrl, ...(removed.seedUrls || []), ...(prior?.seedUrls || [])].filter(Boolean))],
      }];
      return { deleted: id };
    });
    await reschedule();
    return { ok: true, ...result };
  }
  async function patchSubscription(id, change = {}) {
    const nextFeed = change.feedUrl === undefined ? null : feedUrl(change.feedUrl, allowedOrigins);
    if (change.mode !== undefined && !['from-now', 'recent', 'history'].includes(change.mode)) fail('BAD_MODE', '首次收录范围应为 from-now、recent 或 history。');
    const result = await mutate(state => { const sub = state.subscriptions.find(s => s.id === id); if (!sub) fail('NOT_FOUND', '找不到该公众号订阅。', 404);
      if (nextFeed) {
        if (nextFeed.href === BEATING_HOME && sub.accountId !== BEATING_ACCOUNT) fail('ACCOUNT_MISMATCH', '动察官网同步仅用于已核对的动察 Beating 账号。');
        const derived = feedAccountId(nextFeed.href);
        if (derived && /^MP_WXS_/i.test(derived) && accountIdentity(derived) !== accountIdentity(sub.accountId)) fail('ACCOUNT_MISMATCH', '订阅源与指定公众号账号不一致。');
        if (sub.feedUrl !== nextFeed.href) {
          sub.previousFeedUrl = sub.feedUrl; sub.feedUrl = nextFeed.href;
            sub.sourceChangedAt = new Date().toISOString(); sub.initialized = false; sub.lastError = ''; sub.lastErrorCode = ''; sub.lastWarning = ''; sub.lastSkipped = 0;
        }
      }
      if (change.mode !== undefined) {
        if (sub.initialized && change.mode !== sub.mode) fail('ALREADY_INITIALIZED', '该账号已完成首次检查，收录范围不能重新建立。');
        sub.mode = change.mode;
      }
      if (typeof change.enabled === 'boolean') sub.enabled = change.enabled;
      if (typeof change.name === 'string' && change.name.trim()) sub.name = boundedText(change.name, 160);
      return { subscription: clone(sub) }; });
    await reschedule(); return { ok: true, ...result };
  }
  async function configure(change = {}) {
    await mutate(state => { if (typeof change.enabled === 'boolean') state.enabled = change.enabled;
      if (change.intervalMinutes !== undefined) { const n = Number(change.intervalMinutes); if (!Number.isInteger(n) || n < 15 || n > 1440) fail('BAD_INTERVAL', '检查间隔应为 15 至 1440 分钟。'); state.intervalMinutes = n; } });
    await reschedule(); return status();
  }
  async function articles(query = {}) {
    const state = await read(); const account = String(query.accountId || ''); const q = String(query.q || '').trim().toLowerCase();
    const result = state.articles.filter(a => (!account || a.accountId === account || a.accountIds?.includes(account)) && (!(query.unread === true || query.unread === 'true' || query.unread === '1') || !a.read) && (!q || `${a.title} ${a.accountName}`.toLowerCase().includes(q))).sort((a, b) => String(b.publishedAt || b.firstSeenAt).localeCompare(String(a.publishedAt || a.firstSeenAt)));
    const limit = Math.min(500, Math.max(1, parseInt(query.limit || '100', 10) || 100));
    return { ok: true, items: result.slice(0, limit), total: result.length };
  }
  async function markRead(input = {}) { return mutate(state => { const item = state.articles.find(a => a.id === input.id); if (!item) fail('NOT_FOUND', '找不到该文章。', 404); if (typeof input.read !== 'boolean') fail('BAD_REQUEST', 'read 必须为布尔值。'); item.read = input.read; return { ok: true, item: clone(item) }; }); }
  const contentFile = id => path.join(contentDir, sha(id) + '.json');
  async function cacheContent(article, row, sub) {
    const html = typeof row.html === 'string' ? row.html.trim() : '';
    if (!html || Buffer.byteLength(html, 'utf8') > MAX_ARTICLE_BYTES || loopback(new URL(sub.feedUrl).hostname)) return false;
    const publisher = row.contentSource === 'publisher' && isBeatingPublisher(sub.feedUrl, sub.accountId) && isBeatingContentUrl(row.contentUrl);
    await atomicJson(contentFile(article.id), { version: 1, id: article.id, url: article.url,
      content: { kind: publisher ? 'publisher' : 'rss', html, feedUrl: sub.feedUrl, publishedAt: row.publishedAt, accountName: sub.name,
        ...(publisher ? { contentUrl: row.contentUrl, sourceLabel: '官网同步正文', publishedAtSource: 'publisher' } : {}) } });
    return true;
  }
  async function articleContent(query = {}) {
    const state = await read();
    const article = state.articles.find(item => item.id === String(query.id || ''));
    if (!article) fail('NOT_FOUND', '找不到该文章。', 404);
    let cached;
    try {
      const filename = contentFile(article.id), stat = await fs.stat(filename);
      // JSON escaping can expand a valid HTML body; the decoded UTF-8 limit remains authoritative.
      if (stat.size > MAX_ARTICLE_BYTES * 6 + 16384) throw Error('oversized cache');
      cached = JSON.parse(await fs.readFile(filename, 'utf8'));
      if (cached.version !== 1 || cached.id !== article.id || cached.url !== article.url || !['rss', 'publisher'].includes(cached.content?.kind) || typeof cached.content.html !== 'string' || !cached.content.html.trim() || Buffer.byteLength(cached.content.html, 'utf8') > MAX_ARTICLE_BYTES) throw Error('invalid cache');
      const source = feedUrl(cached.content.feedUrl, allowedOrigins);
      if (loopback(source.hostname)) throw Error('not a public RSS cache');
      if (cached.content.kind === 'publisher' && (source.href !== BEATING_HOME || !isBeatingContentUrl(cached.content.contentUrl) || article.providerAccountId !== BEATING_ACCOUNT || article.contentSource !== 'publisher')) throw Error('invalid publisher cache');
    } catch { fail('NO_CACHED_CONTENT', '该文章暂时没有可用的缓存正文，请打开原文。', 404); }
    return { ok: true, article: clone(article), content: cached.content };
  }

  async function requestDocument(raw, assertCurrent) {
    const controller = new AbortController(); controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), options.fetchTimeoutMs || 20000); timeout.unref?.();
    const aborted = new Promise((_, reject) => { controller.signal.addEventListener('abort', () => reject(new WechatError('FEED_TIMEOUT', 'RSS 请求超时或服务正在重载。', 504)), { once: true }); });
    try {
      return await Promise.race([(async () => {
        let target = feedUrl(raw, allowedOrigins); const initiallyLocal = loopback(target.hostname);
        for (let redirect = 0; redirect <= 5; redirect++) {
          if (assertCurrent) await assertCurrent();
          if (controller.signal.aborted) throw new WechatError('FEED_TIMEOUT', 'RSS 请求已取消。', 504);
          target = feedUrl(target.href, allowedOrigins);
          if (loopback(target.hostname) && !initiallyLocal) fail('BLOCKED_FEED_URL', '外部 RSS 不能跳转到本机服务。');
          const host = target.hostname.replace(/^\[|\]$/g, '');
          const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([lookup(host, { all: true, verbatim: true }), aborted]);
          if (!addresses.length || (!loopback(target.hostname) && addresses.some(a => blockedIp(a.address)))) fail('BLOCKED_FEED_URL', 'RSS 域名解析到了内网或保留地址。');
          const pinned = addresses[0];
          if (assertCurrent) await assertCurrent();
          const response = await new Promise((resolve, reject) => {
            const transport = target.protocol === 'https:' ? https : http;
            const req = transport.request(target, { method: 'GET', signal: controller.signal, headers: { 'user-agent': 'DSH-Wechat-Monitor/0.1', accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/xml, text/xml, application/json' }, lookup: (_name, opts, cb) => opts.all ? cb(null, [pinned]) : cb(null, pinned.address, pinned.family) }, res => {
              if (res.statusCode >= 300 && res.statusCode < 400) { res.resume(); resolve({ redirect: res.headers.location }); return; }
              if (res.statusCode !== 200) {
                res.resume();
                const publisher = target.href === BEATING_HOME || isBeatingContentUrl(target.href);
                reject(new WechatError(publisher ? (res.statusCode === 429 ? 'SOURCE_RATE_LIMIT' : 'PUBLISHER_HTTP') : res.statusCode === 401 || res.statusCode === 403 ? 'AUTH_REQUIRED' : 'FEED_HTTP', publisher ? `动察官网返回 HTTP ${res.statusCode}，本次未收录。` : res.statusCode === 401 || res.statusCode === 403 ? '公众号源需要重新扫码授权。' : `RSS 服务返回 HTTP ${res.statusCode}。`, 502)); return;
              }
              let bytes = 0; const chunks = [];
              res.on('data', chunk => { bytes += chunk.length; if (bytes > MAX_FEED_BYTES) req.destroy(new WechatError('FEED_TOO_LARGE', 'RSS 内容超过 4 MB 上限。', 413)); else chunks.push(chunk); });
              res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] || '' })); res.on('error', reject);
            }); req.on('error', reject); req.end();
          });
          if (response.redirect) { if (redirect === 5) fail('FEED_REDIRECT', 'RSS 跳转次数过多。'); target = new URL(response.redirect, target); continue; }
          return { ...response, url: target.href };
        }
        fail('FEED_REDIRECT', 'RSS 跳转无效。');
      })(), aborted]);
    } catch (error) { if (error instanceof WechatError) throw error; throw new WechatError('FEED_NETWORK', '无法连接公众号 RSS 服务，请检查连接与授权。', 502); }
    finally { clearTimeout(timeout); controllers.delete(controller); }
  }
  async function requestFeed(raw, assertCurrent) {
    const response = await requestDocument(raw, assertCurrent);
    return parseWechatFeed(response.text, response.type);
  }
  async function performCheck(input = {}) {
    const start = new Date().toISOString(); let added = 0, checked = 0, skipped = 0; const errors = [], newItems = [];
    const state = await read();
    let retryAt = '';
    const rateLimitError = until => ({ code: 'RATE_LIMIT', message: '采集来源限制访问频率，请在冷却结束后再检查。', retryAt: until });
    let selectedIds = null;
    if (input.subscriptionIds !== undefined) {
      if (input.subscriptionId || !Array.isArray(input.subscriptionIds) || !input.subscriptionIds.length || input.subscriptionIds.some(id => typeof id !== 'string' || !id)) fail('BAD_REQUEST', 'subscriptionIds 应为指定订阅 ID 的非空数组。');
      selectedIds = new Set(input.subscriptionIds);
      if ([...selectedIds].some(id => !state.subscriptions.some(sub => sub.id === id))) fail('NOT_FOUND', '找不到指定的公众号订阅。', 404);
    }
    const subscriptions = state.subscriptions.filter(s => s.enabled && s.feedUrl && (!input.subscriptionId || s.id === input.subscriptionId) && (!selectedIds || selectedIds.has(s.id)));
    if (input.subscriptionId && !state.subscriptions.some(s => s.id === input.subscriptionId)) fail('NOT_FOUND', '找不到该公众号订阅。', 404);
    if (subscriptions.length && subscriptions.every(sub => cooling(state, sub))) {
      return { ok: true, blocked: true, startedAt: start, finishedAt: new Date().toISOString(), added: 0, checked: 0, skipped: subscriptions.length, errors: [rateLimitError(state.retryAt)], retryAt: state.retryAt };
    }
    for (const candidate of subscriptions) {
      if (disposed) break;
      // A user may pause a later account while an earlier one is still refreshing.
      // Read the live allowlist immediately before the next upstream operation.
      const live = await read();
      const snapshot = live.subscriptions.find(sub => sub.id === candidate.id);
      if (!sameSubscription(snapshot, candidate) || !snapshot.enabled || !snapshot.feedUrl) continue;
      if (cooling(live, snapshot)) { retryAt = live.retryAt; skipped++; continue; }
      checked++;
      try {
        if (options.beforeFetch) await options.beforeFetch(clone(snapshot));
        if (disposed) break;
        const current = (await read()).subscriptions.find(sub => sub.id === snapshot.id);
        if (!sameSubscription(current, snapshot) || !current.enabled || current.feedUrl !== snapshot.feedUrl) continue;
        const assertCurrent = async () => {
          const sub = (await read()).subscriptions.find(item => item.id === snapshot.id);
          if (disposed || !sameSubscription(sub, snapshot) || !sub.enabled || sub.feedUrl !== snapshot.feedUrl) fail('SUBSCRIPTION_CHANGED', '公众号订阅已删除、暂停或变更。', 409);
        };
        const publisher = isBeatingPublisher(snapshot.feedUrl, snapshot.accountId);
        const collected = publisher ? await collectBeatingPublisher(async target => {
          const response = await requestDocument(target, assertCurrent);
          if (response.url !== target) fail('PUBLISHER_REDIRECT', '动察官网跳转到了未核对的页面，本次未收录。', 502);
          return response.text;
        }) : { rows: await requestFeed(snapshot.feedUrl, assertCurrent), skipped: 0, warning: '' };
        const rows = collected.rows;
        if (!rows.length) fail('EMPTY_FEED', '订阅源未返回文章，本次不建立基线。', 502);
        const accepted = rows.map(row => {
          const url = canonicalArticleUrl(row.url); if (!url || !row.title) return null;
          const declaredOwner = accountIdentity(row.owner), urlOwner = articleOwner(url);
          const expected = accountIdentity(snapshot.accountId);
          const single = feedAccountId(snapshot.feedUrl);
          if ((declaredOwner && declaredOwner !== expected) || (urlOwner && urlOwner !== expected) || (!declaredOwner && !urlOwner && (!single || accountIdentity(single) !== expected))) return null;
          const date = Date.parse(row.published || '');
          return { title: boundedText(row.title, 500), url, publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : '', html: row.html,
            ...(publisher ? { contentSource: 'publisher', sourceLabel: '官网同步正文', contentUrl: row.contentUrl, publishedAtSource: 'publisher' } : {}) };
        }).filter(Boolean);
        if (!accepted.length) fail('ACCOUNT_MISMATCH', '订阅源没有可确认属于指定公众号的有效文章。', 502);
        const committed = await mutate(async latest => {
          const sub = latest.subscriptions.find(s => s.id === snapshot.id);
          if (!sameSubscription(sub, snapshot) || !sub.enabled || sub.feedUrl !== snapshot.feedUrl) return [];
          const fresh = []; const first = !sub.initialized;
          for (const row of accepted) {
            const id = 'wx_' + sha(row.url).slice(0, 32);
            const already = Object.hasOwn(latest.seen, id);
            latest.seen[id] ||= { firstSeenAt: new Date().toISOString(), url: row.url };
            const current = latest.articles.find(a => a.id === id);
            if (current) {
              current.accountIds = [...new Set([...(current.accountIds || [current.accountId]), sub.id])];
              if (current.title !== row.title) current.title = row.title;
              if (publisher) Object.assign(current, { contentSource: 'publisher', sourceLabel: '官网同步正文', contentUrl: row.contentUrl, publishedAtSource: 'publisher' });
              if (await cacheContent(current, row, sub)) current.hasContent = true;
              continue;
            }
            if ((already && !(first && sub.mode === 'history')) || (first && sub.mode === 'from-now' && (!row.publishedAt || Date.parse(row.publishedAt) <= Date.parse(sub.createdAt)))) continue;
            if (!row.publishedAt || Date.parse(row.publishedAt) > Date.now() + 5 * 60000 || (!(first && sub.mode === 'history') && Date.parse(row.publishedAt) < Date.now() - 7 * DAY)) continue;
            const article = { id, title: row.title, url: row.url, publishedAt: row.publishedAt, firstSeenAt: latest.seen[id].firstSeenAt, accountId: sub.id, accountIds: [sub.id], providerAccountId: sub.accountId, accountName: sub.name, read: false,
              ...(publisher ? { contentSource: 'publisher', sourceLabel: '官网同步正文', contentUrl: row.contentUrl, publishedAtSource: 'publisher' } : {}),
              ...(first && sub.mode === 'recent' ? { collectionReason: 'initial-backfill' } : first && sub.mode === 'history' ? { collectionReason: 'history-backfill' } : {}) };
            if (await cacheContent(article, row, sub)) article.hasContent = true;
            latest.articles.push(article); fresh.push(clone(article));
            if (options.onArticles) { latest.pendingLibrary ||= []; latest.pendingLibrary.push(clone(article)); }
          }
          sub.initialized = true; sub.lastCheckedAt = new Date().toISOString(); sub.lastSuccessAt = sub.lastCheckedAt; sub.lastError = ''; sub.lastErrorCode = ''; sub.lastAdded = fresh.length;
          sub.latestPublishedAt = accepted.map(row => row.publishedAt).filter(date => date && Date.parse(date) <= Date.now() + 5 * 60000).sort().at(-1) || '';
          const coverageWarning = sub.latestPublishedAt && Date.parse(sub.latestPublishedAt) < Date.now() - 7 * DAY
            ? '当前信源最新文章日期为' + new Date(sub.latestPublishedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }) + '，近7天暂无可收录内容。' : '';
          const historyWarning = first && sub.mode === 'history' && fresh.length
            ? '本次按原日期收录' + fresh.length + '篇历史文章，不代表近期更新。' : '';
          sub.lastSkipped = collected.skipped; sub.lastWarning = [collected.warning, coverageWarning, historyWarning].filter(Boolean).join(' ');
          return fresh;
        });
        added += committed.length; newItems.push(...committed);
      } catch (error) {
        if (disposed) break;
        if (error.code === 'SUBSCRIPTION_CHANGED') continue;
        const message = String(error?.message || error).slice(0, 500); const limited = ['PROVIDER_RATE_LIMIT', 'SOURCE_RATE_LIMIT'].includes(error.code);
        const entry = { subscriptionId: snapshot.id, message, code: error.code || 'FEED_ERROR' };
        const recorded = await mutate(latest => {
          const sub = latest.subscriptions.find(s => s.id === snapshot.id);
          const current = sameSubscription(sub, snapshot) && sub.enabled && sub.feedUrl === snapshot.feedUrl;
          if (current) { sub.lastCheckedAt = new Date().toISOString(); sub.lastError = message; sub.lastErrorCode = entry.code; sub.lastAdded = 0; }
          // A limit observed on an in-flight request still applies to this origin after
          // its subscription is removed. Keep it separate from per-subscription errors.
          if (limited) {
            latest.retryAt = new Date(Math.max(Date.parse(latest.retryAt || '') || 0, Date.now() + RATE_LIMIT_BACKOFF_MS)).toISOString();
            latest.retryOrigin = normalizedOrigin(snapshot.feedUrl);
            retryAt = latest.retryAt; entry.retryAt = retryAt;
          }
          return Boolean(current);
        });
        if (recorded) errors.push(entry);
      }
    }
    if (disposed) return { ok: false, added, checked, errors };
    if (options.onArticles) {
      const pending = (await read()).pendingLibrary || [];
      if (pending.length) {
        await options.onArticles(clone(pending));
        const ids = new Set(pending.map(item => item.id));
        await mutate(latest => { latest.pendingLibrary = (latest.pendingLibrary || []).filter(item => !ids.has(item.id)); });
      }
    }
    const run = { startedAt: start, finishedAt: new Date().toISOString(), added, checked, skipped, errors, retryAt: retryAt || null };
    await mutate(latest => {
      if (!(Date.parse(latest.retryAt || '') > Date.now())) { latest.retryAt = ''; latest.retryOrigin = ''; }
      run.retryAt = latest.retryAt || null; latest.lastRun = run;
    });
    return { ok: true, ...run };
  }
  function check(input = {}) {
    if (disposed) return Promise.reject(new WechatError('DISPOSED', '订阅服务正在重载。', 503));
    if (pendingRun) return pendingRun;
    if (timer) clearTimeout(timer); timer = null; nextRun = null;
    pendingRun = performCheck(input).finally(() => { pendingRun = null; return reschedule(); });
    return pendingRun;
  }
  async function dispose() { disposed = true; scheduleGeneration++; if (timer) clearTimeout(timer); timer = null; nextRun = null; for (const c of controllers) c.abort(); if (pendingRun) await pendingRun.catch(() => {}); }
  void reschedule().catch(() => {});
  return { status, addSubscription, removeSubscription, patchSubscription, configure, articles, articleContent, markRead, check, dispose };
}
