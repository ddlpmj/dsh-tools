/**
 * Bloomberg 的服务端 Next 数据适配器。
 * 只读页面已经返回的 JSON，不执行脚本，也不请求其它内容来源。
 * 与通用 HTML 提取分开，避免站点数据结构影响其它网页。
 */

const ARTICLE_PATH = /^\/(?:news\/(?:articles|features|newsletters)|opinion\/articles)\/\d{4}-\d{2}-\d{2}\/[^/]+\/?$/i;
const MAX_JSON_CHARS = 5 * 1024 * 1024;
const MAX_DEPTH = 48;
const MAX_NODES = 24000;

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/gi, (whole, entity) => {
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };
      const key = entity.toLowerCase();
      if (key[0] !== '#') return named[key] || whole;
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t\u00a0]+/g, ' ').trim()
    : '';
}

export function isBloombergArticleUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
      && (host === 'bloomberg.com' || host.endsWith('.bloomberg.com')) && ARTICLE_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function publicImageUrl(value, baseUrl) {
  if (typeof value !== 'string' || value.length > 8192) return '';
  try {
    const url = new URL(value, baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || !host.includes('.') || host.includes(':') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return '';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b, c] = host.split('.').map(Number);
      if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0))
        || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
        || (a === 203 && b === 0 && c === 113)) return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

function nextData(source) {
  // 跳过注释，防止注释中的示例 script 被当成实际数据。最多读取一个匹配的脚本。
  const html = source.replace(/<!--[\s\S]*?-->/g, '');
  const opening = /<script\b([^>]*)>/gi;
  let match;
  while ((match = opening.exec(html))) {
    const attrs = match[1];
    const end = /<\/script\s*>/gi;
    end.lastIndex = opening.lastIndex;
    const closing = end.exec(html);
    if (!/(?:^|\s)id\s*=\s*(?:"__NEXT_DATA__"|'__NEXT_DATA__'|__NEXT_DATA__(?=\s|$))/i.test(attrs)) {
      if (!closing) return null;
      opening.lastIndex = end.lastIndex;
      continue;
    }
    if (!closing || closing.index - opening.lastIndex > MAX_JSON_CHARS) return null;
    try {
      const parsed = JSON.parse(html.slice(opening.lastIndex, closing.index));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function challengePage(source) {
  const title = cleanText((/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source) || [])[1]);
  if (/\b(?:are you a robot|access denied|just a moment|attention required|verify (?:you are|you're) human)\b/i.test(title)) return true;
  // 不扫描脚本数据，订阅文章中的相关报道可能正常提及 robot/captcha。
  const visible = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<[^>]*>/g, ' ');
  return /we(?:'|’)?ve detected unusual activity/i.test(visible)
    || /(?:verify|confirm) (?:that )?you(?:'re| are) (?:not a robot|human)/i.test(visible);
}

/**
 * 非目标 URL 返回 null；目标页始终返回状态，不把缺数据或拦截页当成文章。
 * blocks 与阅读器共用现有契约；链接和 entity 保留其显示文字。
 */
export function extractBloombergArticle(html, url, options = {}) {
  if (!isBloombergArticleUrl(url)) return null;
  const source = typeof html === 'string' ? html : '';
  const empty = { target: true, status: 'missing', title: '', byline: '', blocks: [], truncated: false, warnings: [] };
  if (source.length > MAX_JSON_CHARS * 2) return { ...empty, reason: '页面超过 Bloomberg 解析大小上限' };
  const json = nextData(source);
  const story = json?.props?.pageProps?.story;
  const content = story?.body?.content;
  if (!Array.isArray(content) && challengePage(source)) return { ...empty, status: 'challenge', reason: 'Bloomberg 返回了访问验证页面，请先在浏览器中完成验证后导入正文' };
  if (!story || typeof story !== 'object' || !Array.isArray(content)) {
    return { ...empty, reason: 'Bloomberg 页面未返回可解析的文章正文，可能需要登录、订阅或在浏览器中打开' };
  }

  const maxChars = Number.isFinite(options.maxArticleChars) ? Math.max(1, Math.floor(options.maxArticleChars)) : 200000;
  const maxBlocks = Number.isFinite(options.maxBlocks) ? Math.max(1, Math.floor(options.maxBlocks)) : 4000;
  const blocks = [];
  const seenImages = new Set();
  let nodes = 0;
  let usedChars = 0;
  let truncated = false;
  let stopped = false;
  let hasUnknown = false;

  function visit(depth) {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) {
      truncated = true;
      stopped = true;
      return false;
    }
    return !stopped;
  }

  function textOf(node, depth = 0, skipLists = false) {
    if (!visit(depth)) return '';
    if (typeof node === 'string') return node;
    if (!node || typeof node !== 'object') return '';
    if (Array.isArray(node)) {
      const parts = [];
      for (const child of node) {
        if (stopped) break;
        parts.push(textOf(child, depth + 1, skipLists));
      }
      return parts.join('');
    }
    if (typeof node.value === 'string') return node.value;
    if (typeof node.text === 'string') return node.text;
    if (skipLists && node.type === 'list') return '';
    if (node.type === 'lineBreak' || node.type === 'break' || node.type === 'br') return '\n';
    if (node.type === 'footnoteRef') return `\n${textOf(node.data?.footnoteContent, depth + 1, skipLists)}\n`;
    if (Array.isArray(node.content)) {
      const parts = [];
      for (const child of node.content) {
        if (stopped) break;
        const text = textOf(child, depth + 1, skipLists);
        parts.push(text);
        if (child && /^(?:paragraph|listItem|heading|blockquote)$/.test(child.type || '')) parts.push('\n');
      }
      return parts.join('');
    }
    return '';
  }

  function add(block) {
    if (stopped) return;
    if (blocks.length >= maxBlocks) { truncated = true; stopped = true; return; }
    let clipped = false;
    if (block.kind !== 'image' && block.kind !== 'divider') {
      let text = cleanText(block.text);
      if (!text) return;
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === block.kind && previous.text === text) return;
      const separator = usedChars > 0 ? 2 : 0;
      const remaining = maxChars - usedChars - separator;
      if (remaining <= 0) { truncated = true; stopped = true; return; }
      if (text.length > remaining) { text = text.slice(0, remaining).trimEnd(); truncated = true; clipped = true; }
      usedChars += separator + text.length;
      block = { ...block, text };
    }
    blocks.push(block);
    if (clipped) stopped = true;
  }

  function image(node, depth) {
    const data = node.data || {};
    const media = data.photo || data.image || data.chart || node.photo || {};
    const fallback = media.fallback;
    const raw = media.src || media.url || (typeof fallback === 'string' ? fallback : fallback?.src || fallback?.url);
    let src = publicImageUrl(raw, url);
    if (src && typeof options.validateImageUrl === 'function') {
      try { src = options.validateImageUrl(src) || ''; } catch { src = ''; }
    }
    const caption = cleanText(textOf(media.caption || data.caption || '', depth + 1));
    const credit = cleanText(textOf(media.credit || data.credit || '', depth + 1));
    if (src && !seenImages.has(src)) {
      seenImages.add(src);
      add({ kind: 'image', src, alt: cleanText(media.alt || caption).slice(0, 500) });
    }
    if (caption || credit) add({ kind: 'paragraph', text: [caption, credit].filter(Boolean).join(' · ') });
  }

  function walk(items, depth = 0, ordered = false) {
    if (!Array.isArray(items) || !visit(depth)) return;
    let pending = '';
    const flush = () => { if (pending) add({ kind: 'paragraph', text: pending }); pending = ''; };
    for (const node of items) {
      if (stopped) break;
      if (!visit(depth)) break;
      if (typeof node === 'string') { pending += node; continue; }
      if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
      const type = typeof node.type === 'string' ? node.type : '';
      if (['ad', 'advertisement', 'inline-newsletter', 'inline-recirc', 'newsletter', 'recirculation'].includes(type)) continue;
      if (['text', 'link', 'entity', 'strong', 'emphasis', 'span', 'lineBreak', 'break', 'br'].includes(type)) {
        pending += textOf(node, depth + 1);
        continue;
      }
      flush();
      if (type === 'paragraph') add({ kind: 'paragraph', text: textOf(node, depth + 1) });
      else if (type === 'heading') {
        const rawLevel = Number(node.level || node.data?.level || node.attributes?.level || 2);
        add({ kind: 'heading', level: Number.isFinite(rawLevel) ? Math.min(3, Math.max(1, Math.floor(rawLevel))) : 2, text: textOf(node, depth + 1) });
      } else if (type === 'list') {
        const listType = node.subType || node.data?.type || node.attributes?.type || '';
        const isOrdered = node.ordered === true || node.data?.ordered === true || node.attributes?.ordered === true || /^(?:ordered|numbered|ol)$/i.test(listType);
        walk(node.content, depth + 1, isOrdered);
      } else if (type === 'listItem' || type === 'list-item') {
        add({ kind: 'list-item', ordered, text: textOf(node, depth + 1, true) });
        if (Array.isArray(node.content)) walk(node.content.filter((child) => child?.type === 'list'), depth + 1, ordered);
      }
      else if (type === 'blockquote' || type === 'quote') add({ kind: 'quote', text: textOf(node, depth + 1) });
      else if (type === 'hr' || type === 'horizontalRule') add({ kind: 'divider' });
      else if (type === 'media' || type === 'image' || type === 'figure') image(node, depth);
      else if (type === 'footnoteRef') walk(node.data?.footnoteContent, depth + 1);
      else if (type === 'div' || type === 'section' || type === 'body') walk(node.content, depth + 1, ordered);
      else {
        // 未知组件只读其明确的正文子节点，不遍历 data 中的导航、推荐或 HTML 脚本。
        if (type === 'tabularData') hasUnknown = true;
        else if (Array.isArray(node.content)) walk(node.content, depth + 1, ordered);
        else if (type !== 'embed') hasUnknown = true;
      }
    }
    flush();
  }

  // 元数据采用独立小预算，不能因正文耗尽遍历预算而丢失标题或作者。
  function metaText(value) {
    if (typeof value === 'string') return cleanText(value).slice(0, 1000);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return cleanText(value.text || value.value || value.name || '').slice(0, 1000);
  }
  const title = metaText(story.title) || metaText(story.headline);
  let byline = metaText(story.byline);
  if (!byline && Array.isArray(story.authors)) {
    byline = story.authors.slice(0, 20).map((author) => metaText(author?.name) || metaText(author?.author?.name)
      || metaText(author) || cleanText([author?.firstName, author?.lastName].filter((s) => typeof s === 'string').join(' '))).filter(Boolean).join(', ').slice(0, 200);
  }
  if (!byline) byline = metaText(story.author).slice(0, 200);
  walk(content);
  const textBlocks = blocks.filter((block) => typeof block.text === 'string' && block.kind !== 'heading');
  if (!textBlocks.length) return { ...empty, title, byline, reason: 'Bloomberg 页面没有返回可阅读的正文段落' };
  const declaredPartial = story.truncated === true || story.isTruncated === true || story.body.truncated === true || story.body.isTruncated === true;
  const warnings = [];
  if (declaredPartial) warnings.push('Bloomberg 返回的正文标记为不完整，当前仅展示已返回的内容');
  if (truncated) warnings.push('Bloomberg 正文超过阅读解析上限，已保留可解析的部分');
  if (hasUnknown) warnings.push('部分 Bloomberg 嵌入内容无法转换为阅读文本');
  return { target: true, status: declaredPartial ? 'partial' : 'article', title, byline, blocks, truncated, warnings };
}
