/** Conservative, local selection of material worth explaining. Source text stays intact. */
export const READING_FILTER_VERSION = 1;

export function isReadingPreface(title) {
  return /^(?:前言|序言|作者序|自序|译者序|译序|再版序|新版序|推荐序(?:[一二三四五六七八九十\d]+)?|preface|foreword)(?:$|[\s:：·（(—-])/i.test(String(title || '').trim());
}

const cleanLine = value => String(value || '').replace(/^\s*(?:#{1,6}\s*|>\s*)/, '').trim();
const compact = value => cleanLine(value).replace(/[\s《》〈〉]/g, '').toLowerCase();
const genericTitle = /^(?:第\s*[零〇一二三四五六七八九十百千万\d]+\s*部分|section\s+\d+)$/i;
const substantiveTitle = /^(?:第\s*[零〇一二三四五六七八九十百千万\d]+\s*章|chapter\s+\S+|导言|导论|绪论|引言|案例(?:学习|分析)?)(?:$|\s|[：:])/i;
const labels = {
  preface: '前言／序言', 'title-page': '书名／署名页', copyright: '版权／出版信息',
  contents: '目录', dedication: '献词', acknowledgements: '致谢',
  'publisher-note': '出版后记', promotion: '推广／下载广告', divider: '纯标题页',
  'author-info': '作者简介',
};

function bodyLines(chapter) {
  const lines = chapter.text.split('\n').map(cleanLine).filter(Boolean);
  if (/^\s*#{1,6}\s/.test(chapter.text) && compact(lines[0]) === compact(chapter.title)) lines.shift();
  return lines;
}

// A contact address alone is not an advert. Require the recognisable distribution
// footer plus its request to follow/add/download, so cases and author contacts stay.
function isDistributionFooter(text) {
  return /^(?:本书|本电子书|电子书|本文|本资料).{0,40}(?:整理|制作|校对)/.test(cleanLine(text))
    && /(?:免费电子书|电子书下载|更多.{0,8}电子书|下载网站)/.test(text)
    && /(?:请加|加小编|关注|微信|公众号|网址|https?:\/\/)/i.test(text);
}

function exclusionReason(chapter, bookTitle) {
  const title = cleanLine(chapter.title);
  const lines = bodyLines(chapter);
  const body = lines.join('\n');
  const first = lines[0] || '';
  const heading = genericTitle.test(title) ? first : title;
  if (isReadingPreface(title) || (genericTitle.test(title) && isReadingPreface(first))) return 'preface';
  if (!body) return 'divider';
  if (/^(?:致谢|鸣谢|acknowledg(?:e)?ments?)(?:$|[：:（(])/i.test(heading)) return 'acknowledgements';
  if (/^(?:出版后记|出版说明|出版者的话|出版方的话|publisher['’]?s?\s+(?:note|afterword))$/i.test(heading)) return 'publisher-note';
  if (/^(?:作者简介|译者简介|关于作者|about\s+the\s+author)$/i.test(heading) && body.length < 6000) return 'author-info';
  if (/^(?:献词|献辞|dedication)$/i.test(heading)
    || (body.length < 1200 && /^(?:本书)?(?:谨献给|献给|敬献|献于)|^to my\s|^for my\s/i.test(first))) return 'dedication';

  const fields = lines.filter(line => /^(?:书名|作者|译者|书号|版权|出版社|出版人|出版时间|版次|印次|印刷|ISBN|CIP|定价|开本|字数|著作权|copyright|published by|translated by)\s*[:：©\d]/i.test(line));
  const copyrightHeading = /^(?:版权(?:信息|声明|页)?|出版信息|copyright(?:\s+page)?)$/i.test(heading) || /^(?:版权信息|版权页|copyright)$/i.test(first);
  if (!substantiveTitle.test(title) && body.length < 7000 && (fields.length >= 3 && fields.length >= lines.length * .5
    || copyrightHeading && (fields.length >= 2 || /版权所有|保留所有权利|all rights reserved/i.test(body)))) return 'copyright';

  const tocHeading = /^(?:目录|目\s+录|总目录|contents|table of contents)$/i.test(heading) || /^(?:目录|目\s+录|contents|table of contents)$/i.test(first);
  if (tocHeading && lines.length >= 4 && lines.filter(line => line.length <= 90).length >= lines.length * .9
    && lines.filter(line => /[。；;！!]/.test(line)).length <= 2) return 'contents';

  const credits = line => /^(?:作者|译者|编者|著者)\s*[:：]|(?:著|译|编著|编译|主编|绘|编)\s*$|^(?:by|translated by|edited by)\s/i.test(line);
  if (body.length < 600 && lines.length <= 8 && !/[。！？!?]/.test(body) && (compact(title) === compact(bookTitle) || lines.some(line => compact(line) === compact(bookTitle)))
    && lines.every(line => compact(line) === compact(bookTitle) || credits(line))) return 'title-page';

  const distribution = /如果你不知道读什么书|小编微信号|电子书下载网站|关注.{0,60}(?:书单|得到电子书|免费电子书)/.test(body);
  const contact = /微信公众号名称|小编微信号|(?:网址|https?:\/\/|www\.)/i.test(body);
  const explanatory = lines.some(line => /^(?:案例|例如|研究|实验|本章|作者认为|我们分析)/.test(line)
    || (line.length > 260 && !isDistributionFooter(line)));
  if (!substantiveTitle.test(title) && body.length < 6000 && distribution && contact && !explanatory) return 'promotion';
  return '';
}

function promotionalRanges(chapter) {
  const ranges = [];
  for (const match of chapter.text.matchAll(/[^\n][\s\S]*?(?=\n[ \t]*\n|$)/g)) {
    // Quoted examples in a substantive chapter are evidence, not a footer.
    if (/^\s*>/.test(match[0]) || !isDistributionFooter(match[0])) continue;
    let end = match.index + match[0].length;
    while (end < chapter.text.length && /\s/.test(chapter.text[end])) end++;
    ranges.push({ startChar: match.index, endChar: end, reason: 'promotion', label: labels.promotion });
  }
  return ranges;
}

export function selectReadingChapters(chapters, bookTitle) {
  const selected = [], excludedChapters = [], excludedPassages = [];
  for (const chapter of chapters) {
    const reason = exclusionReason(chapter, bookTitle);
    if (reason) {
      excludedChapters.push({ id: chapter.id, title: chapter.title, chars: chapter.text.length, reason, label: labels[reason] });
      continue;
    }
    const removed = promotionalRanges(chapter);
    const readingRanges = [];
    let cursor = 0;
    for (const range of removed) {
      if (chapter.text.slice(cursor, range.startChar).trim()) readingRanges.push({ startChar: cursor, endChar: range.startChar });
      excludedPassages.push({ chapterId: chapter.id, title: chapter.title, ...range, chars: range.endChar - range.startChar });
      cursor = range.endChar;
    }
    if (chapter.text.slice(cursor).trim()) readingRanges.push({ startChar: cursor, endChar: chapter.text.length });
    if (readingRanges.length) selected.push({ ...chapter, readingRanges });
    else excludedChapters.push({ id: chapter.id, title: chapter.title, chars: chapter.text.length, reason: 'promotion', label: labels.promotion });
  }
  return { chapters: selected, excludedChapters, excludedPassages };
}
