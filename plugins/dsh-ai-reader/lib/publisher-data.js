/** Read article data returned in a publisher's HTML. No script evaluation or network calls. */

const MAX_SOURCE_CHARS = 5 * 1024 * 1024;
const MAX_GRAPH_NODES = 4096;
const MAX_GRAPH_DEPTH = 24;
const ARTICLE_TYPES = new Set(['article', 'newsarticle', 'reportagenewsarticle']);

function articleUrl(value, base) {
  try {
    const url = value instanceof URL ? new URL(value.href) : new URL(value, base);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port
      || !['businessinsider.com', 'www.businessinsider.com'].includes(host)) return null;
    // Normal BI article URLs end in year-month; category, author, login and home pages do not.
    if (!/^\/(?=[^/]*[a-z])[a-z0-9][a-z0-9-]*-20\d{2}-(?:0?[1-9]|1[0-2])\/?$/i.test(url.pathname)) return null;
    return url;
  } catch { return null; }
}

function sameArticle(value, target) {
  const url = articleUrl(value, target);
  return Boolean(url && url.pathname.replace(/\/+$/, '') === target.pathname.replace(/\/+$/, ''));
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip|lsquo|rsquo|ldquo|rdquo);/gi, (whole, entity) => {
    const key = entity.toLowerCase();
    if (key[0] !== '#') return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' })[key] || whole;
    const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

function cleanText(value) {
  return typeof value === 'string' ? decodeEntities(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim() : '';
}

function attributes(source) {
  const out = Object.create(null);
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = pattern.exec(source))) out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  return out;
}

function canonicalMatches(source, target) {
  // Ignore links written inside scripts/comments rather than present in the HTML document.
  const markup = source.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  for (const match of markup.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    if (String(attrs.rel || '').toLowerCase().split(/\s+/).includes('canonical')
      && attrs.href && !sameArticle(decodeEntities(attrs.href), target)) return false;
  }
  return true;
}

function jsonLdObjects(source) {
  const objects = [];
  const opening = /<!--[\s\S]*?-->|<script\b([^>]*)>/gi;
  let match;
  let scripts = 0;
  while ((match = opening.exec(source))) {
    if (match[0].startsWith('<!--')) continue;
    const end = /<\/script\s*>/gi;
    end.lastIndex = opening.lastIndex;
    const closing = end.exec(source);
    if (!closing) break;
    const bodyStart = opening.lastIndex;
    opening.lastIndex = end.lastIndex;
    const attrs = attributes(match[1] || '');
    if (String(attrs.type || '').split(';')[0].trim().toLowerCase() !== 'application/ld+json') continue;
    if (++scripts > 64) break;
    try { objects.push(JSON.parse(source.slice(bodyStart, closing.index))); } catch { /* Invalid JSON is not executable code. */ }
  }
  return objects;
}

function graphObjects(roots) {
  const result = [];
  const pending = roots.map(value => ({ value, depth: 0 }));
  let visited = 0;
  while (pending.length && visited++ < MAX_GRAPH_NODES) {
    const { value, depth } = pending.shift();
    if (!value || typeof value !== 'object' || depth > MAX_GRAPH_DEPTH) continue;
    if (Array.isArray(value)) {
      const capacity = Math.max(0, MAX_GRAPH_NODES - visited - pending.length);
      for (const child of value.slice(0, capacity)) pending.push({ value: child, depth: depth + 1 });
      continue;
    }
    result.push(value);
    if (value['@graph']) pending.push({ value: value['@graph'], depth: depth + 1 });
    if (value.mainEntity && typeof value.mainEntity === 'object') pending.push({ value: value.mainEntity, depth: depth + 1 });
  }
  return result;
}

function hasArticleType(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => typeof type === 'string' && ARTICLE_TYPES.has(type.split(/[/#]/).pop().toLowerCase()));
}

function identityFields(article) {
  const values = [];
  for (const value of [article.url, article['@id'], article.mainEntityOfPage]) {
    if (typeof value === 'string' && value.trim()) values.push(value.trim());
    else if (value && typeof value === 'object') {
      for (const field of ['@id', 'url']) if (typeof value[field] === 'string' && value[field].trim()) values.push(value[field].trim());
    }
  }
  return values;
}

function paragraphs(value) {
  let body = value.replace(/\r\n?/g, '\n');
  // Some publishers encode an entire HTML fragment. Decode it once before parsing,
  // while ordinary text such as "x &lt; 3" stays text rather than becoming a tag.
  if (/^\s*&lt;(?:p|div|section|article|h[1-6]|ul|ol|blockquote)\b/i.test(body)) body = decodeEntities(body);
  if (/<\/?[a-z][^>]*>/i.test(body)) {
    body = body.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|noscript|template|iframe|object|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<br\b[^>]*>/gi, '\n')
      .replace(/<\/?(?:p|div|section|article|h[1-6]|li|blockquote|pre|ul|ol)\b[^>]*>/gi, '\n\n')
      .replace(/<\/?[a-z][^>]*>/gi, '');
  }
  return body.split(/\n\s*\n+/).map(part => decodeEntities(part)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[\t \u00a0]+/g, ' ').replace(/ *\n */g, '\n').trim()).filter(Boolean);
}

function bylineOf(article, nodes) {
  const ids = new Map(nodes.filter(node => typeof node['@id'] === 'string').map(node => [node['@id'], node]));
  const authors = Array.isArray(article.author) ? article.author : [article.author];
  const names = [];
  for (const author of authors.slice(0, 20)) {
    let name = '';
    if (typeof author === 'string') name = ids.has(author) ? cleanText(ids.get(author)?.name) : (/^(?:https?:|#)/i.test(author) ? '' : cleanText(author));
    else if (author && typeof author === 'object') name = cleanText(author.name) || cleanText(ids.get(author['@id'])?.name);
    if (name && !names.includes(name)) names.push(name.slice(0, 200));
  }
  return names.join(', ').slice(0, 1000);
}

/**
 * Non-target or missing usable publisher data returns null. Only reads data already
 * present in the response; isAccessibleForFree:false does not imply missing content.
 */
export function extractPublisherArticle(html, url, options = {}) {
  const target = articleUrl(url);
  if (!target || typeof html !== 'string' || html.length > MAX_SOURCE_CHARS || !canonicalMatches(html, target)) return null;
  const nodes = graphObjects(jsonLdObjects(html));
  const candidates = nodes.filter(node => hasArticleType(node['@type']) && typeof node.articleBody === 'string' && node.articleBody.trim())
    .map(article => ({ article, identities: identityFields(article) }))
    .filter(candidate => candidate.identities.every(value => sameArticle(value, target)));
  const identified = candidates.filter(candidate => candidate.identities.length);
  const eligible = identified.length ? identified : candidates;
  // Without article identities, multiple independent articles are ambiguous.
  if (!eligible.length || (!identified.length && eligible.length > 1)) return null;
  const article = eligible.sort((a, b) => b.article.articleBody.length - a.article.articleBody.length)[0].article;
  const textParagraphs = paragraphs(article.articleBody);
  if (!textParagraphs.length) return null;
  const maxChars = Number.isFinite(options.maxArticleChars) ? Math.max(1, Math.min(400000, Math.floor(options.maxArticleChars))) : 120000;
  const maxBlocks = Number.isFinite(options.maxBlocks) ? Math.max(1, Math.min(4000, Math.floor(options.maxBlocks))) : 4000;
  const blocks = [];
  let used = 0;
  let truncated = false;
  for (const paragraph of textParagraphs) {
    if (blocks.length >= maxBlocks) { truncated = true; break; }
    const separator = blocks.length ? 2 : 0;
    const remaining = maxChars - used - separator;
    if (remaining <= 0) { truncated = true; break; }
    let text = paragraph;
    if (text.length > remaining) {
      text = text.slice(0, remaining).trimEnd();
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
      truncated = true;
    }
    if (text) { blocks.push({ kind: 'paragraph', text }); used += separator + text.length; }
    if (truncated) break;
  }
  if (!blocks.length) return null;
  return {
    title: (cleanText(article.headline) || cleanText(article.name)).slice(0, 1000),
    byline: bylineOf(article, nodes),
    blocks,
    truncated,
    warnings: truncated ? ['Business Insider 正文超过阅读解析上限，已保留可解析的部分'] : [],
  };
}
