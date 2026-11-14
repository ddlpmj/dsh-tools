/**
 * lib/fetchpage.js —— HTTP 抓取 + HTML 正文抽取（CONTRACT §5.2）。
 *
 * 主路径是自己用 globalThis.fetch 抓：
 *  - 仅 http/https，拒绝 localhost 与私网字面量；
 *  - 20s 超时、≤2MB、≤5 跳重定向、Chrome UA；
 *  - 按 content-type charset 解码（utf-8 / gbk / gb18030 兜底）；
 *  - HTML → 正文：去 script/style/nav/footer/header/aside，优先 article/main，
 *    块级标签换行，解码实体，压缩空白。
 * ctx.get('web').fetch 作为第一优先尝试（8s 内），失败自动降级到自抓。
 */

import { errorMessage, httpError, redactSecrets } from './http.js';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 20 * 1000;
const WEB_FETCH_TIMEOUT_MS = 8 * 1000;
const DEFAULT_MAX_CHARS = 6000;

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  bull: '•',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  times: '×',
  divide: '÷',
  plusmn: '±',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  sect: '§',
  para: '¶',
  dagger: '†',
  permil: '‰',
  prime: '′',
  Prime: '″',
  larr: '←',
  rarr: '→',
  uarr: '↑',
  darr: '↓',
  harr: '↔',
  rArr: '⇒',
  hArr: '⇔',
  forall: '∀',
  exist: '∃',
  empty: '∅',
  isin: '∈',
  notin: '∉',
  sub: '⊂',
  sup: '⊃',
  and: '∧',
  or: '∨',
  cap: '∩',
  cup: '∪',
  int: '∫',
  sum: '∑',
  infin: '∞',
  asymp: '≈',
  ne: '≠',
  le: '≤',
  ge: '≥',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ε',
  lambda: 'λ',
  mu: 'μ',
  pi: 'π',
  sigma: 'σ',
  tau: 'τ',
  phi: 'φ',
  omega: 'ω',
  Omega: 'Ω',
  nbsp2: ' ',
};

/** 解码 HTML 实体（命名 + 十进制 + 十六进制）。 */
export function decodeEntities(text) {
  if (typeof text !== 'string' || !text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);?/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    const lower = body.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, lower)) return NAMED_ENTITIES[lower];
    return match;
  });
}

/** 私网 / 本机地址判定（字面量，不做 DNS 解析）。 */
export function isBlockedHost(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '::') return true;
  if (host.includes(':') && (host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd'))) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  if ([a, b, Number(ipv4[3]), Number(ipv4[4])].some((part) => part > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/** 校验 URL：仅 http/https + 非私网。返回 URL 对象或抛 BAD_REQUEST。 */
export function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw httpError('BAD_REQUEST', `无效 URL：${redactSecrets(String(raw || '')).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw httpError('BAD_REQUEST', `不支持的协议：${url.protocol}`);
  }
  if (isBlockedHost(url.hostname)) {
    throw httpError('BAD_REQUEST', `拒绝访问本机 / 私网地址：${url.hostname}`);
  }
  return url;
}

/** 从 HTML 里抽出标题。 */
export function extractTitle(html) {
  if (typeof html !== 'string') return '';
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return '';
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim().slice(0, 300);
}

function pickContainer(html) {
  const body = html;
  for (const tag of ['article', 'main']) {
    const open = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(body);
    if (!open) continue;
    const start = open.index;
    const close = body.toLowerCase().lastIndexOf(`</${tag}>`);
    if (close > start) {
      const segment = body.slice(start, close + tag.length + 3);
      if (plainTextLength(segment) >= 200) return segment;
    }
  }
  const bodyOpen = /<body(\s[^>]*)?>/i.exec(body);
  if (bodyOpen) {
    const bodyClose = body.toLowerCase().lastIndexOf('</body>');
    if (bodyClose > bodyOpen.index) return body.slice(bodyOpen.index, bodyClose + 7);
  }
  return body;
}

function stripBlocks(html) {
  let text = html;
  // 注释
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  // 非正文容器整体删掉
  for (const tag of ['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'form', 'button', 'select', 'textarea']) {
    text = text.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
    text = text.replace(new RegExp(`<${tag}(\\s[^>]*)?/>`, 'gi'), ' ');
  }
  for (const tag of ['nav', 'footer', 'header', 'aside']) {
    text = text.replace(new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi'), ' ');
  }
  return text;
}

function plainTextLength(html) {
  return stripBlocks(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/** HTML → 纯文本正文。 */
export function extractTextFromHtml(html) {
  if (typeof html !== 'string') return { title: '', text: '' };
  const title = extractTitle(html);
  if (!html.trim()) return { title, text: '' };
  let text = pickContainer(html);
  text = stripBlocks(text);
  // 块级标签换行
  text = text.replace(
    /<\/?(?:p|div|section|article|main|header|footer|aside|nav|h[1-6]|li|ul|ol|dl|dt|dd|blockquote|pre|code|table|thead|tbody|tfoot|tr|td|th|figure|figcaption|br|hr|address|details|summary|fieldset|legend)(\s[^>]*)?\/?>/gi,
    '\n',
  );
  // 其余标签去掉
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  text = text
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ ]{2,}/g, ' ').trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

/** 按 charset 解码字节；支持 utf-8 / gbk / gb18030 兜底。 */
export function decodeBody(buffer, contentType = '') {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const match = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType || '');
  let label = (match ? match[1] : 'utf-8').toLowerCase();
  if (label === 'gb2312' || label === 'gbk') label = 'gb18030';
  const decode = (encoding) => {
    try {
      return new TextDecoder(encoding, { fatal: false }).decode(bytes);
    } catch {
      return '';
    }
  };
  let text = decode(label);
  if (!text && label !== 'utf-8') text = decode('utf-8');
  if (!text) text = bytes.toString('utf8');
  // 没给 charset 且 UTF-8 出现大量替换符时，用 gb18030 再试一次
  if (!match) {
    const replacements = (text.match(/\ufffd/g) || []).length;
    if (replacements > 0 && replacements / Math.max(1, text.length) > 0.01) {
      const fallback = decode('gb18030');
      if (fallback && !fallback.includes('\ufffd')) text = fallback;
    }
  }
  return text;
}

function looksLikeHtml(text, contentType = '') {
  if (/html|xml/i.test(contentType || '')) return true;
  return /<(?:!doctype|html|head|body|article|main|div|p)\b/i.test(String(text || '').slice(0, 2000));
}

function truncateText(text, maxChars) {
  const max = Math.max(1, Math.round(Number(maxChars) || DEFAULT_MAX_CHARS));
  const value = String(text || '').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

async function readLimited(response) {
  const contentLength = Number(response.headers?.get?.('content-length') || 0);
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = Buffer.from(value);
        const remain = MAX_BYTES - size;
        if (remain <= 0) break;
        chunks.push(chunk.subarray(0, remain));
        size += Math.min(chunk.length, remain);
        if (size >= MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          break;
        }
      }
    } finally {
      try {
        reader.releaseLock?.();
      } catch {
        /* ignore */
      }
    }
    return Buffer.concat(chunks);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (contentLength > MAX_BYTES) return buffer.subarray(0, MAX_BYTES);
  return buffer.length > MAX_BYTES ? buffer.subarray(0, MAX_BYTES) : buffer;
}

function coerceWebResult(result, url) {
  if (!result) return null;
  if (typeof result === 'string') return { text: result, status: 200, finalUrl: url, contentType: 'text/html' };
  if (typeof result !== 'object') return null;
  const text =
    (typeof result.text === 'string' && result.text) ||
    (typeof result.content === 'string' && result.content) ||
    (typeof result.body === 'string' && result.body) ||
    (typeof result.html === 'string' && result.html) ||
    '';
  if (!text.trim()) return null;
  const status = Number(result.status || result.statusCode || 200) || 200;
  return {
    text,
    status,
    finalUrl: result.finalUrl || result.url || url,
    contentType: result.contentType || result.content_type || '',
    title: typeof result.title === 'string' ? result.title : '',
    ok: result.ok !== false && status >= 200 && status < 400,
  };
}

/**
 * @param {{ctx:object, config:object, logger:object, fetchImpl?:Function}} options
 */
export function createFetcher({ ctx, config, logger = console, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (...args) => globalThis.fetch(...args);

  function logWarn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(`[fetch] ${redactSecrets(message)}`);
    } catch {
      /* ignore */
    }
  }

  function maxCharsOf(value) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.min(30000, Math.round(n));
    return config.fetchMaxChars || DEFAULT_MAX_CHARS;
  }

  function finalize({ url, finalUrl, status, html, plainText, contentType, maxChars }) {
    let title = '';
    let text = '';
    if (typeof html === 'string' && html) {
      const extracted = extractTextFromHtml(html);
      title = extracted.title;
      text = extracted.text;
    } else {
      text = String(plainText || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    const clipped = truncateText(text, maxChars);
    if (!clipped) {
      return { ok: false, url, finalUrl: finalUrl || url, status: status || 0, title, text: '', chars: 0, error: '页面正文为空（可能需要登录或被反爬）' };
    }
    return { ok: true, url, finalUrl: finalUrl || url, status: status || 200, title, text: clipped, chars: clipped.length, error: '' };
  }

  async function tryWebFetch(url, maxChars) {
    let web;
    try {
      web = typeof ctx?.get === 'function' ? ctx.get('web') : undefined;
    } catch {
      return null;
    }
    if (!web || typeof web.fetch !== 'function') return null;
    let timer;
    try {
      const result = await Promise.race([
        web.fetch({ url }),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), WEB_FETCH_TIMEOUT_MS);
          if (typeof timer.unref === 'function') timer.unref();
        }),
      ]);
      if (!result) return null;
      const coerced = coerceWebResult(result, url);
      if (!coerced) return null;
      if (coerced.status >= 400) {
        logWarn(`ctx.web.fetch 返回 HTTP ${coerced.status}，改用自带抓取：${url}`);
        return null;
      }
      if (looksLikeHtml(coerced.text, coerced.contentType)) {
        return finalize({ url, finalUrl: coerced.finalUrl, status: coerced.status, html: coerced.text, contentType: coerced.contentType, maxChars });
      }
      return finalize({ url, finalUrl: coerced.finalUrl, status: coerced.status, plainText: coerced.text, maxChars });
    } catch (error) {
      logWarn(`ctx.web.fetch 不可用（${errorMessage(error, 160)}），改用自带抓取`);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function selfFetch(rawUrl, { signal, maxChars }) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
    }

    let url = assertPublicUrl(rawUrl).href;
    let finalUrl = url;
    let status = 0;
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const response = await doFetch(url, {
          method: 'GET',
          redirect: 'manual',
          headers: {
            'user-agent': CHROME_UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
          signal: controller.signal,
        });
        status = Number(response.status) || 0;
        const location = response.headers?.get?.('location');
        if ([301, 302, 303, 307, 308].includes(status) && location) {
          if (hop === MAX_REDIRECTS) throw httpError('BAD_REQUEST', `重定向超过 ${MAX_REDIRECTS} 跳`);
          const next = new URL(location, url).href;
          url = assertPublicUrl(next).href;
          finalUrl = url;
          continue;
        }
        if (status >= 400) {
          return { ok: false, url: rawUrl, finalUrl: url, status, title: '', text: '', chars: 0, error: `HTTP ${status}` };
        }
        const contentType = response.headers?.get?.('content-type') || '';
        if (/^(image|audio|video|application\/pdf|application\/octet-stream)/i.test(contentType)) {
          return { ok: false, url: rawUrl, finalUrl: url, status, title: '', text: '', chars: 0, error: `不支持的 content-type：${contentType}` };
        }
        const buffer = await readLimited(response);
        const decoded = decodeBody(buffer, contentType);
        if (looksLikeHtml(decoded, contentType)) {
          return finalize({ url: rawUrl, finalUrl: url, status, html: decoded, contentType, maxChars });
        }
        return finalize({ url: rawUrl, finalUrl: url, status, plainText: decoded, maxChars });
      }
      return { ok: false, url: rawUrl, finalUrl, status, title: '', text: '', chars: 0, error: `重定向超过 ${MAX_REDIRECTS} 跳` };
    } catch (error) {
      const message = timedOut
        ? '抓取超时（20s）'
        : error && error.code === 'BAD_REQUEST'
          ? error.message
          : signal && signal.aborted
            ? '抓取被取消'
            : `抓取失败：${errorMessage(error, 240)}`;
      return { ok: false, url: rawUrl, finalUrl: finalUrl || rawUrl, status: status || 0, title: '', text: '', chars: 0, error: redactSecrets(message) };
    } finally {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 抓一页并抽正文；永不 throw。
   * @returns {Promise<{ok:boolean,url:string,finalUrl:string,status:number,title:string,text:string,chars:number,error:string}>}
   */
  async function fetchPage(rawUrl, { signal, maxChars } = {}) {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    const result = {
      ok: false,
      url,
      finalUrl: url,
      status: 0,
      title: '',
      text: '',
      chars: 0,
      error: '',
    };
    if (!url) {
      result.error = 'URL 为空';
      return result;
    }
    try {
      assertPublicUrl(url);
    } catch (error) {
      result.error = errorMessage(error, 300);
      return result;
    }
    const limit = maxCharsOf(maxChars);
    try {
      const viaWeb = await tryWebFetch(url, limit);
      if (viaWeb) return viaWeb;
      return await selfFetch(url, { signal, maxChars: limit });
    } catch (error) {
      result.error = redactSecrets(errorMessage(error, 300));
      return result;
    }
  }

  return { fetchPage };
}
