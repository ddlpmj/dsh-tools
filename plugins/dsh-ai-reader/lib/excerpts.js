/** One Markdown notebook, independent of the article save directory. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const DEFAULT_READER_DATA_DIR = path.join(os.homedir(), 'Documents', 'DSH工具数据', 'AI阅读助手');
export const EXCERPT_FILE_NAME = '摘抄笔记.md';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const START = '<!-- dsh-ai-reader:excerpt ';
const END = '<!-- /dsh-ai-reader:excerpt -->';
const queues = new Map();
const own = value => value && typeof value === 'object' && !Array.isArray(value);

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
function bad(message) { throw failure(400, 'BAD_REQUEST', message); }
function escapeMarkdown(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[\\`*_{}\[\]()#+!|~]/g, '\\$&');
}
function escapeQuote(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function unescapeQuote(value) {
  return value.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
function oneLine(value, max, label, fallback = '') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') bad(`${label}必须是文字`);
  if (value.length > max) bad(`${label}不能超过 ${max} 字符`);
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}
function validate(input) {
  if (!own(input)) bad('摘抄请求必须是对象');
  if (typeof input.text !== 'string' || !input.text.trim()) bad('请先选择要摘抄的文字');
  const text = input.text.replace(/\r\n?/g, '\n').trim();
  if (text.length > 20000) bad('每次摘抄不能超过 20000 字符');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) bad('摘抄内容包含不支持的控制字符');
  if (!Array.isArray(input.tags) || !input.tags.length) bad('请至少选择一个标签');
  if (input.tags.length > 8) bad('每条摘抄最多选择 8 个标签');
  const tags = [];
  for (const raw of input.tags) {
    if (typeof raw !== 'string' || /[\u0000-\u001f\u007f]/.test(raw)) bad('标签必须是不含换行的文字');
    const tag = raw.normalize('NFC').trim().replace(/ {2,}/g, ' ');
    if (!tag || tag.length > 32) bad('每个标签需要 1～32 个字符');
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (typeof input.requestId !== 'string' || !input.requestId.trim()
      || input.requestId.length > 128 || /[\u0000-\u001f\u007f]/.test(input.requestId)) {
    bad('requestId 需要 1～128 个字符，用于避免重复保存');
  }
  if (input.article !== undefined && !own(input.article)) bad('文章来源格式不正确');
  const source = input.article || {};
  const article = {
    title: oneLine(source.title, 500, '文章标题', '未命名文章'),
    url: oneLine(source.url, 4096, '来源链接'),
    site: oneLine(source.site, 200, '来源站点'),
  };
  if (article.url) {
    let url;
    try { url = new URL(article.url); } catch { bad('来源链接格式不正确'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) bad('来源链接仅支持不含登录信息的 HTTP／HTTPS 地址');
    article.url = url.href;
  }
  return { text, tags, article, requestId: input.requestId.trim() };
}

/** Markers are whole lines; quoted or inline copies in human notes are not records. */
function entriesFrom(text) {
  const entries = [];
  // A damaged record without its end marker must not consume the next record.
  const pattern = /^<!-- dsh-ai-reader:excerpt (\{[^\r\n]*\}) -->\r?\n((?:(?!^<!-- dsh-ai-reader:excerpt )[\s\S])*?)^<!-- \/dsh-ai-reader:excerpt -->[ \t]*(?:\r?\n|$)/gm;
  for (const match of text.matchAll(pattern)) {
    let meta;
    try { meta = JSON.parse(match[1]); } catch { continue; }
    if (!own(meta) || meta.v !== 1 || typeof meta.id !== 'string' || typeof meta.requestId !== 'string'
        || typeof meta.createdAt !== 'string' || !Array.isArray(meta.tags) || !own(meta.article)
        || typeof meta.fingerprint !== 'string') continue;
    const quote = match[2].match(/(?:^|\n)((?:>[^\n]*(?:\n|$))+)/);
    if (!quote) continue;
    const quoteText = unescapeQuote(quote[1].split('\n').filter(line => line.startsWith('>'))
      .map(line => line.replace(/^> ?/, '')).join('\n')).trim();
    try {
      const checked = validate({ text: quoteText, tags: meta.tags, article: meta.article, requestId: meta.requestId });
      entries.push({ id: meta.id, createdAt: meta.createdAt, ...checked, fingerprint: meta.fingerprint,
        start: match.index, end: match.index + match[0].length });
    } catch { /* Preserve hand-edited/unrecognized text on disk; do not treat it as a valid record. */ }
  }
  return entries;
}
function publicEntry(entry) {
  const { fingerprint, start, end, ...publicValue } = entry;
  return publicValue;
}
function notebook(filePath, text, entries, includeContent) {
  const newest = [...entries].reverse();
  return {
    fileName: EXCERPT_FILE_NAME, path: filePath,
    tags: [...new Set(newest.flatMap(entry => entry.tags))], count: entries.length,
    ...(includeContent ? { text, entries: newest.map(publicEntry) } : {}),
  };
}
function serial(filePath, operation) {
  const running = (queues.get(filePath) || Promise.resolve()).then(operation);
  const settled = running.catch(() => {});
  queues.set(filePath, settled);
  void settled.then(() => { if (queues.get(filePath) === settled) queues.delete(filePath); });
  return running;
}
async function readNotebook(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw failure(409, 'EXCERPT_FAILED', '摘抄笔记路径不是普通文件');
    if (stat.size > MAX_BYTES) throw failure(413, 'TOO_LARGE', '摘抄笔记已超过 16 MB，请先整理笔记文件');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_BYTES) throw failure(413, 'TOO_LARGE', '摘抄笔记已超过 16 MB，请先整理笔记文件');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw failure(409, 'EXCERPT_FAILED', '摘抄笔记不是有效的 UTF-8 文本，未修改原文件'); }
    return { text, entries: entriesFrom(text), bytes, stat };
  } catch (error) {
    if (error?.code === 'ENOENT') return { text: '', entries: [] };
    if (error?.code === 'ELOOP') throw failure(409, 'EXCERPT_FAILED', '摘抄笔记不能是符号链接，请改为普通 Markdown 文件');
    if (error?.status) throw error;
    throw failure(500, 'EXCERPT_FAILED', '读取摘抄笔记失败，请检查文件是否可读');
  } finally { await handle?.close().catch(() => {}); }
}
function render(entry) {
  const metadata = JSON.stringify({ v: 1, ...entry, text: undefined })
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium', hour12: false })
    .format(new Date(entry.createdAt));
  const title = escapeMarkdown(entry.article.title);
  const source = entry.article.url ? `[${title}](<${entry.article.url}>)` : title;
  return `${START}${metadata} -->\n## ${title}\n\n时间：${time}（北京时间）\n\n` +
    `标签：${entry.tags.map(tag => `「${escapeMarkdown(tag)}」`).join('、')}\n\n` +
    `来源：${source}${entry.article.site ? ` · ${escapeMarkdown(entry.article.site)}` : ''}\n\n` +
    `${entry.text.split('\n').map(line => '> ' + escapeQuote(line)).join('\n')}\n\n${END}\n`;
}

/** rootDir is a trusted, fixed plugin path; HTTP input cannot change it. */
export function createExcerptStore({ rootDir }) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) throw new TypeError('Excerpt rootDir must be absolute');
  const filePath = path.join(path.resolve(rootDir), EXCERPT_FILE_NAME);
  return {
    read() {
      return serial(filePath, async () => {
        const { text, entries } = await readNotebook(filePath);
        return { ok: true, note: notebook(filePath, text, entries, true) };
      });
    },
    remove(id) {
      return serial(filePath, async () => {
        if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
          bad('请选择要删除的摘抄');
        }
        const current = await readNotebook(filePath);
        const matches = current.entries.filter(entry => entry.id === id);
        if (matches.length > 1) throw failure(409, 'EXCERPT_CONFLICT', '这条摘抄的标识重复，请先整理笔记文件');
        if (!matches.length) return { ok: true, deleted: id, alreadyDeleted: true,
          note: notebook(filePath, current.text, current.entries, true) };
        const target = matches[0];
        // Slice the original text: keep other excerpts and manual content exactly as written.
        const text = current.text.slice(0, target.start) + current.text.slice(target.end);
        const temporary = path.join(path.dirname(filePath), `.dsh-excerpts-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
          await handle.writeFile(text, 'utf8');
          await handle.chmod(current.stat.mode & 0o777);
          await handle.sync();
          await handle.close();
          handle = null;
          // Refuse to overwrite a notebook edited or replaced while preparing the deletion.
          const latest = await readNotebook(filePath);
          if (!latest.bytes?.equals(current.bytes) || latest.stat.ino !== current.stat.ino || latest.stat.dev !== current.stat.dev) {
            throw failure(409, 'EXCERPT_CONFLICT', '摘抄笔记已在其他地方修改，请刷新后重试删除');
          }
          await fs.rename(temporary, filePath);
        } catch (error) {
          if (error?.status) throw error;
          throw failure(500, 'EXCERPT_FAILED', '删除摘抄失败，请检查笔记文件是否可写');
        } finally {
          await handle?.close().catch(() => {});
          await fs.unlink(temporary).catch(() => {});
        }
        return { ok: true, deleted: id, note: notebook(filePath, text, entriesFrom(text), true) };
      });
    },
    add(input) {
      return serial(filePath, async () => {
        const value = validate(input);
        const fingerprint = createHash('sha256').update(JSON.stringify(value)).digest('hex');
        const current = await readNotebook(filePath);
        const previous = current.entries.find(entry => entry.requestId === value.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw failure(409, 'EXCERPT_CONFLICT', '这次保存标识已用于另一条摘抄，请重新添加');
          return { ok: true, duplicate: true, note: notebook(filePath, current.text, current.entries, false), entry: publicEntry(previous) };
        }
        if (current.entries.length >= MAX_ENTRIES) throw failure(413, 'TOO_LARGE', '摘抄笔记已达到 5000 条，请先整理笔记文件');
        const entry = { id: randomUUID(), createdAt: new Date().toISOString(), ...value, fingerprint };
        const prefix = current.text ? (current.text.endsWith('\n\n') ? '' : current.text.endsWith('\n') ? '\n' : '\n\n')
          : '# 摘抄笔记\n\n';
        const addition = Buffer.from(prefix + render(entry), 'utf8');
        let handle;
        try {
          await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
          handle = await fs.open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW || 0), 0o600);
          const stat = await handle.stat();
          if (!stat.isFile()) throw failure(409, 'EXCERPT_FAILED', '摘抄笔记路径不是普通文件');
          if (stat.size + addition.length > MAX_BYTES) throw failure(413, 'TOO_LARGE', '添加后摘抄笔记将超过 16 MB，请先整理笔记文件');
          await handle.writeFile(addition);
          await handle.sync();
        } catch (error) {
          if (error?.code === 'ELOOP') throw failure(409, 'EXCERPT_FAILED', '摘抄笔记不能是符号链接，请改为普通 Markdown 文件');
          if (error?.status) throw error;
          throw failure(500, 'EXCERPT_FAILED', '保存摘抄失败，请检查笔记文件是否可写');
        } finally { await handle?.close().catch(() => {}); }
        return { ok: true, duplicate: false,
          note: notebook(filePath, '', [...current.entries, entry], false), entry: publicEntry(entry) };
      });
    },
  };
}
