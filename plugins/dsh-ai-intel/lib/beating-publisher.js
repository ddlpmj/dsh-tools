// Fixed, verified publisher fallback. No login, background WeChat API, or arbitrary URL crawling.
export const BEATING_ACCOUNT = 'MP_WXS_3921736177';
export const BEATING_HOME = 'https://www.beating.news/';
const BIZ = 'MzkyMTczNjE3Nw==';
const problem = (code, message) => Object.assign(new Error(message), { code, status: 502 });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

export function isBeatingPublisher(raw, accountId) {
  try { return new URL(raw).href === BEATING_HOME && accountId === BEATING_ACCOUNT; } catch { return false; }
}

export function isBeatingContentUrl(raw) {
  try { const u = new URL(raw); return u.origin === 'https://www.beating.news' && /^\/news\/\d+$/.test(u.pathname) && !u.search && !u.hash && !u.username && !u.password; } catch { return false; }
}

function nuxtTable(html) {
  const raw = String(html).match(/<script\b(?=[^>]*\bid=["']__NUXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i)?.[1];
  let table;
  try { table = JSON.parse(raw); } catch { throw problem('PUBLISHER_FORMAT', '动察官网没有返回可识别的文章数据，本次未建立基线。'); }
  if (!Array.isArray(table) || table.length > 50000) throw problem('PUBLISHER_FORMAT', '动察官网数据结构已变化，请检查采集器。');
  const get = reference => Number.isInteger(reference) && reference >= 0 && reference < table.length ? table[reference] : undefined;
  function author(node) {
    const list = get(node.author);
    return Array.isArray(list) && list.some(ref => { const row = get(ref); return plain(row) && get(row.id) === 312 && /^动察\s*Beating$/.test(get(row.name) || ''); });
  }
  return { table, get, author };
}

export function parseBeatingList(html) {
  const { table, get, author } = nuxtTable(html), rows = new Map();
  for (const node of table) {
    if (!plain(node) || !author(node)) continue;
    const id = get(node.id), title = get(node.title), time = get(node.time), h5 = get(node.h5);
    if (!Number.isSafeInteger(id) || id <= 0 || typeof title !== 'string' || !title.trim() || typeof time !== 'number' || !Number.isFinite(time)) continue;
    // The homepage also embeds unrelated flash news and event records. Never treat them as articles.
    if (h5 !== `https://m.theblockbeats.info/news/${id}`) continue;
    const date = new Date(time * 1000); if (!Number.isFinite(date.getTime())) continue;
    rows.set(id, { id, title: title.trim(), publishedAt: date.toISOString(), contentUrl: BEATING_HOME + 'news/' + id });
  }
  if (!rows.size) throw problem('PUBLISHER_FORMAT', '动察官网没有返回已核对作者的文章列表，本次未建立基线。');
  return [...rows.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 30);
}

function originalLink(html) {
  // The publisher appends one source blockquote after the article. Inline references,
  // quoted excerpts and the page's unrelated flash state cannot establish identity.
  const footers = [...html.matchAll(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi)];
  const footer = footers.at(-1);
  if (!footer || html.slice(footer.index + footer[0].length).replace(/<\/(?:div|section|article|body|html)>/gi, '').trim()) return '';
  if (!/^原文(?:链接)?$/.test(footer[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ''))) return '';
  const found = new Set();
  for (const m of footer[1].matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, '').trim();
    if (!/^原文(?:链接)?$/.test(label)) continue;
    try {
      const u = new URL(m[1].replace(/&amp;/g, '&'));
      if (u.protocol !== 'https:' || u.hostname !== 'mp.weixin.qq.com' || u.port || u.username || u.password || !/^\/s(?:\/[A-Za-z0-9_-]+)?\/?$/.test(u.pathname)) continue;
      if (u.pathname.replace(/\/$/, '') === '/s' && !(u.searchParams.get('__biz') === BIZ && /^\d+$/.test(u.searchParams.get('mid') || '') && /^\d+$/.test(u.searchParams.get('idx') || ''))) continue;
      if (u.searchParams.has('__biz') && u.searchParams.get('__biz') !== BIZ) continue;
      u.hash = ''; found.add(u.href);
    } catch { /* An invalid source link cannot establish article identity. */ }
  }
  return found.size === 1 ? [...found][0] : '';
}

export function parseBeatingArticle(html, candidate) {
  const { table, get, author } = nuxtTable(html);
  const node = table.find(row => plain(row) && get(row.id) === candidate.id && typeof get(row.content) === 'string' && typeof get(row.summary) === 'string' && author(row));
  if (!node) throw problem('PUBLISHER_FORMAT', '动察官网文章身份或作者已变化，本次未收录。');
  const title = get(node.title), body = get(node.content), date = get(node.time);
  if (title !== candidate.title || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(date)) throw problem('PUBLISHER_FORMAT', '动察官网文章标题或发布时间无法核对。');
  const publishedAt = new Date(date.replace(' ', 'T') + ':00+08:00').toISOString();
  if (Math.abs(Date.parse(candidate.publishedAt) - Date.parse(publishedAt)) >= 60000) throw problem('PUBLISHER_FORMAT', '动察官网列表与正文发布时间不一致。');
  if (Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024 || body.replace(/<[^>]*>/g, '').replace(/\s+/g, '').length < 300) throw problem('PUBLISHER_BODY', '动察官网正文过短或超过 2 MiB 上限。');
  const url = originalLink(body);
  if (!url) return null;
  return { title, url, published: candidate.publishedAt, owner: BEATING_ACCOUNT, html: body,
    contentSource: 'publisher', sourceLabel: '官网同步正文', contentUrl: candidate.contentUrl, publishedAtSource: 'publisher' };
}

export async function collectBeatingPublisher(fetchHtml, now = Date.now()) {
  const candidates = parseBeatingList(await fetchHtml(BEATING_HOME));
  const recent = candidates.filter(row => Date.parse(row.publishedAt) >= now - 7 * 86400000 && Date.parse(row.publishedAt) <= now + 300000);
  const rows = []; let skipped = 0;
  for (const candidate of recent) {
    const article = parseBeatingArticle(await fetchHtml(candidate.contentUrl), candidate);
    if (article) rows.push(article); else skipped++;
  }
  if (!rows.length) throw problem('PUBLISHER_NO_MAPPED_ARTICLES', recent.length ? '动察官网近期稿件尚无可核对的公众号原文链接，本次公众号更新状态未确认。' : '动察官网当前列表未提供近 7 天可核对的稿件，本次公众号更新状态未确认。');
  return { rows, skipped, warning: skipped ? `${skipped} 篇官网近期文章缺少可核对的公众号原文链接，已跳过；官网同步不能保证覆盖全部公众号更新。` : '仅同步官网提供明确公众号原文链接的稿件，不能保证覆盖全部公众号更新。' };
}
