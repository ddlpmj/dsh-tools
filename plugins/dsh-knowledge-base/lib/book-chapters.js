/**
 * Book-only local extraction and bounded chapter sections. No disk or model calls.
 * Offsets use JavaScript UTF-16 string indices into the normalized `text` returned here.
 * Concatenating every chapter.text reproduces that text exactly; no summaries replace it.
 */
import path from 'node:path';
import { extractDocument } from './extract.js';
import { KbError } from './kb.js';

export const BOOK_MAX_EXTRACT_CHARS = 5000000;
export const BOOK_MAX_CHAPTER_CHARS = 30000;
const TRUNCATE_SUFFIX = '\n\n…（内容过长，已截断）';

const MAJOR_CHAPTER = /^(?:第\s*[零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰\d０-９]+\s*(?:章|回|卷|部(?:分)?|篇)|(?:卷|章|回)\s*[零〇一二三四五六七八九十百千万两\d０-９]+|(?:chapter|part|book)\s+(?:\d+|[ivxlcdm]+|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand))*)(?=\b|\s|[.:：\-—]))/i;
const MINOR_SECTION = /^第\s*[零〇一二三四五六七八九十百千万两\d０-９]+\s*节/;
const FRONT_OR_BACK = /^(?:前言|序言|作者序|自序|译者序|译序|再版序|新版序|序章|序|引言|导言|导论|绪论|后记|跋|致谢|附录(?:[一二三四五六七八九十A-Z\d]*)?|参考文献|脚注|尾注|目录|preface|foreword|prologue|introduction|epilogue|afterword|acknowledg(?:e)?ments|appendix(?:\s+[A-Z\divx]+)?|references|notes|contents)(?:$|[\s：:、·.\-—])/i;

function safeBoundary(text, index) {
  let boundary = Math.min(text.length, Math.max(0, index));
  if (boundary > 0 && boundary < text.length) {
    const before = text.charCodeAt(boundary - 1);
    const after = text.charCodeAt(boundary);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) boundary -= 1;
  }
  return boundary;
}

function cleanHeading(value) {
  return String(value || '').replace(/\s+#+\s*$/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function headingCandidates(text) {
  const candidates = [];
  let inFence = false;
  const lines = text.matchAll(/[^\n]+|\n/g);
  for (const line of lines) {
    if (line[0] === '\n') continue;
    const raw = line[0];
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence || raw.length > 240) continue;
    const md = /^\s{0,3}(#{1,6})\s+(.+?)\s*$/.exec(raw);
    const content = cleanHeading(md ? md[2] : raw);
    if (!content || content.length > 120 || /(?:\.{3,}|…{2,}|·{3,}|\t)\s*\d*\s*$/.test(content)) continue;
    const major = MAJOR_CHAPTER.test(content);
    const minor = MINOR_SECTION.test(content);
    const special = FRONT_OR_BACK.test(content);
    if (major || minor || special || md) candidates.push({ startChar: line.index, title: content, major, minor, special, level: md ? md[1].length : null });
  }
  return candidates;
}

function detectSections(text) {
  const candidates = headingCandidates(text);
  const major = candidates.filter((entry) => entry.major);
  let selected;
  let mode;
  if (major.length) {
    selected = candidates.filter((entry) => entry.major || entry.special);
    mode = 'chapters';
  } else {
    const levels = new Map();
    for (const entry of candidates) if (entry.level !== null) levels.set(entry.level, (levels.get(entry.level) || 0) + 1);
    // A single document title should not hide a repeated level of section headings.
    const repeated = [...levels.keys()].filter((level) => levels.get(level) >= 2).sort((a, b) => a - b);
    const level = repeated.length ? repeated[0] : [...levels.keys()].sort((a, b) => a - b)[0];
    selected = candidates.filter((entry) => entry.special || entry.minor || entry.level === level);
    mode = selected.length ? 'sections' : 'parts';
  }
  if (!selected.length) return { mode: 'parts', sections: [{ title: '', startChar: 0, endChar: text.length, syntheticTitle: true }] };
  const sections = [];
  if (selected[0].startChar > 0) sections.push({ title: '开篇内容（未标章节）', startChar: 0, endChar: selected[0].startChar, syntheticTitle: true });
  for (let index = 0; index < selected.length; index += 1) {
    const entry = selected[index];
    sections.push({ title: entry.title, startChar: entry.startChar, endChar: selected[index + 1]?.startChar ?? text.length, syntheticTitle: false });
  }
  return { mode, sections };
}

function normalizeProvidedSections(text, sections) {
  if (!Array.isArray(sections) || !sections.length) return null;
  const result = [];
  let cursor = 0;
  for (const entry of sections) {
    if (!entry || !Number.isInteger(entry.startChar) || !Number.isInteger(entry.endChar)) return null;
    const start = Math.min(text.length, entry.startChar);
    const end = Math.min(text.length, entry.endChar);
    if (start >= text.length) break;
    if (start !== cursor || end <= start || safeBoundary(text, start) !== start || safeBoundary(text, end) !== end) return null;
    result.push({ title: cleanHeading(entry.title), startChar: start, endChar: end, syntheticTitle: Boolean(entry.syntheticTitle) });
    cursor = end;
  }
  return cursor === text.length ? result : null;
}

function splitRange(text, startChar, endChar, limit) {
  const result = [];
  let cursor = startChar;
  while (cursor < endChar) {
    let end = Math.min(endChar, cursor + limit);
    if (end < endChar) {
      const minimum = cursor + Math.floor(limit * 0.5);
      const paragraph = text.lastIndexOf('\n\n', end - 2);
      const line = text.lastIndexOf('\n', end - 1);
      if (paragraph >= minimum) end = paragraph + 2;
      else if (line >= minimum) end = line + 1;
      end = safeBoundary(text, end);
    }
    if (end <= cursor) end = safeBoundary(text, Math.min(endChar, cursor + limit));
    if (end <= cursor) throw new KbError('EXTRACT_FAILED', '无法安全分割书籍字符边界');
    result.push({ startChar: cursor, endChar: end });
    cursor = end;
  }
  return result;
}

/** Public deterministic splitter, also useful for validating coverage without parsing a file. */
export function splitBookText(value, options = {}) {
  const text = String(value || '');
  const configured = Number(options.maxChapterChars);
  const limit = Number.isFinite(configured) ? Math.max(100, Math.min(BOOK_MAX_CHAPTER_CHARS, Math.floor(configured))) : BOOK_MAX_CHAPTER_CHARS;
  if (!text.length) return { chapters: [], chapterMode: 'parts' };
  const provided = normalizeProvidedSections(text, options.sections);
  const detected = provided ? { sections: provided, mode: 'spine' } : detectSections(text);
  const chapters = [];
  for (const section of detected.sections) {
    const pieces = splitRange(text, section.startChar, section.endChar, limit);
    for (let index = 0; index < pieces.length; index += 1) {
      const part = pieces[index];
      const number = chapters.length + 1;
      let title = section.title || `第 ${number} 部分`;
      if (section.title && pieces.length > 1) title += `（第 ${index + 1}/${pieces.length} 部分）`;
      chapters.push({
        id: `chapter-${String(number).padStart(4, '0')}`,
        title,
        text: text.slice(part.startChar, part.endChar),
        startChar: part.startChar,
        endChar: part.endChar,
        syntheticTitle: !section.title || section.syntheticTitle,
        isPart: pieces.length > 1 || !section.title || section.syntheticTitle,
      });
    }
  }
  return { chapters, chapterMode: detected.mode };
}

/** Extract readable book text locally. Unsupported/scanned files fail rather than becoming fake notes. */
export async function extractBook(buffer, options = {}) {
  const requested = Number(options.maxChars);
  const maxChars = Number.isFinite(requested) ? Math.max(100, Math.min(BOOK_MAX_EXTRACT_CHARS, Math.floor(requested))) : BOOK_MAX_EXTRACT_CHARS;
  const name = typeof options.name === 'string' ? options.name : '';
  const result = await extractDocument(buffer, { filename: name, mime: options.mime || '', maxChars, bookMode: true });
  if (result.error || result.unsupported || !result.text) throw new KbError(result.unsupported ? 'UNSUPPORTED' : 'EXTRACT_FAILED', result.error || '书籍没有可提取的文字');
  const warnings = Array.isArray(result.warnings) ? result.warnings.slice() : [];
  const meta = result.meta || {};
  let text = result.text;
  const lengthTruncated = Number(meta.originalChars) > maxChars;
  if (lengthTruncated && text.endsWith(TRUNCATE_SUFFIX)) text = text.slice(0, -TRUNCATE_SUFFIX.length);
  // The generic extractor can cut a surrogate pair before appending its notice.
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  const end = safeBoundary(text, Math.min(maxChars, text.length));
  if (end < text.length) text = text.slice(0, end);
  const formatIncomplete = Boolean(meta.contentIncomplete || meta.truncated)
    || warnings.some((warning) => !(lengthTruncated && /^正文超出长度上限/.test(warning))
      && /截断|未抽取|内容.{0,12}缺失|(?:章节|页).{0,20}跳过|跳过.{0,20}(?:章节|脚注|尾注)/.test(warning));
  const truncated = lengthTruncated || formatIncomplete || result.text.length - (lengthTruncated ? TRUNCATE_SUFFIX.length : 0) > text.length;
  if (truncated && !warnings.some((warning) => /截断|未抽取/.test(warning))) warnings.push('书籍仅抽取了部分可读文字；原件仍完整保存，请核对提示');
  const { chapters, chapterMode } = splitBookText(text, { sections: meta.bookSections });
  if (!chapters.length) throw new KbError('EXTRACT_FAILED', '书籍没有可提取的章节文字');
  const fallbackTitle = name ? path.basename(name, path.extname(name)) : '未命名书籍';
  const extractedTitle = String(result.title || '').trim();
  return {
    title: (extractedTitle && !/^(?:前言|序言|目录|preface|foreword|contents)$/i.test(extractedTitle) ? extractedTitle : fallbackTitle).slice(0, 200),
    text,
    chapters,
    warnings,
    truncated,
    originalChars: Math.max(text.length, Number(meta.originalChars) || text.length),
    originalCharsKnown: !formatIncomplete,
    extractedChars: text.length,
    format: result.format,
    chapterMode,
    coverageComplete: !truncated && !warnings.some((warning) => /乱码|扫描|内容.{0,12}缺失/.test(warning)),
  };
}
