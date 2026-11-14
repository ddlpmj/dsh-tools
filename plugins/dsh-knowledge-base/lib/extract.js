/**
 * dsh-knowledge-base —— 多格式文档正文抽取引擎（lib/extract.js）
 *
 * 契约：CONTRACT.md 第 5 节。纯函数模块：ESM、零 npm 依赖、只 import `node:` 内置模块，
 * 不碰磁盘、不调 LLM、不认识知识库目录；任何异常都被捕获，`extractDocument` 永不 reject。
 *
 * 提供：
 *   - extractDocument(buffer, { filename, mime, maxChars }) → { text,title,format,warnings,meta,unsupported?,error? }
 *   - detectFormat(buffer, filename, mime)
 *   - SUPPORTED_EXTENSIONS
 *   - isSupportedFile(filename)
 *
 * 自写解析器一览：
 *   - ZIP：EOCD 扫描 + central directory + local header + `node:zlib.inflateRawSync`（method 0 直读）
 *   - PDF：对象表正则扫描（不依赖 xref）+ FlateDecode/ASCIIHexDecode/ASCII85Decode +
 *          页面树 + 字体 ToUnicode CMap（bfchar/bfrange）+ 内容流文本算子（BT/ET/Tm/Td/TJ/Tj/'/"）
 *   - DOCX/PPTX/XLSX/ODT/ODS/ODP/EPUB：复用自写 ZIP + 自写容错 XML 解析器
 *   - HTML：自写容错 tokenizer/建树/去噪/正文块提取（移植自 AI阅读助手/index.js，去掉阅读 blocks 结构）
 *   - RTF：分组/控制字/`\uN`/`\'hh` 解析 + 重试编码
 *   - 文本类：BOM/UTF-8/GB18030/Latin1 逐级探测
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

// ===========================================================================
// 常量
// ===========================================================================

/** 支持的扩展名（小写、带点；client 上传提示用） */
export const SUPPORTED_EXTENSIONS = Object.freeze([
  '.pdf',
  '.docx', '.pptx', '.xlsx', '.docm', '.pptm', '.xlsm',
  '.odt', '.ods', '.odp', '.odg', '.ott', '.ots', '.otp',
  '.epub',
  '.rtf',
  '.html', '.htm', '.xhtml', '.xht', '.shtml',
  '.md', '.markdown', '.mdown', '.mkd', '.mdx',
  '.txt', '.text', '.log', '.out', '.err', '.nfo',
  '.csv', '.tsv', '.tab',
  '.json', '.jsonl', '.ndjson', '.geojson',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.env',
  '.xml', '.svg', '.plist', '.rss', '.atom',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.pyw', '.rb', '.php', '.java', '.kt', '.kts', '.scala', '.groovy',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.m', '.mm',
  '.cs', '.go', '.rs', '.swift', '.dart', '.lua', '.pl', '.r', '.jl',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.diff', '.patch',
  '.css', '.scss', '.sass', '.less', '.styl',
  '.tex', '.bib', '.rst', '.adoc', '.asciidoc', '.org',
]);

/** 默认正文长度上限（字符） */
const DEFAULT_MAX_CHARS = 400000;
/** 小于该字符数视为抽取失败 */
const MIN_TEXT_CHARS = 20;
/** 截断后追加的提示（契约要求原文） */
const TRUNCATE_SUFFIX = '\n\n…（内容过长，已截断）';
/** 标题长度上限 */
const MAX_TITLE_CHARS = 300;
/** PDF 中“文本过少”阈值：低于它且页数 > 0 → 提示可能是扫描件 */
const PDF_SCANNED_MIN_CHARS = 100;
/** MAX_BLOCKS 与 HTML 阅读块上限（避免超长页面把内存/时间打爆） */
const MAX_HTML_BLOCKS = 6000;
/** 每种格式自身的解析上限（超出部分直接截断并 warning，最终还会按 maxChars 截断） */
const MAX_SHEET_ROWS = 8000;
const MAX_SHEET_COLS = 120;
const MAX_EPUB_CHAPTERS = 60;
const MAX_PDF_PAGES = 2000;
const MAX_PDF_OBJECTS = 200000;
const MAX_ZIP_ENTRIES = 100000;

/** 图片魔数（不支持自动 OCR，给明确提示） */
const IMAGE_SIGNATURES = [
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'bmp', bytes: [0x42, 0x4d] },
  { name: 'tiff-le', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { name: 'tiff-be', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { name: 'ico', bytes: [0x00, 0x00, 0x01, 0x00] },
  { name: 'heic', bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63] },
];

/** Office 97-2003 OLE 复合文档魔数 */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** 扩展名 → 格式。注意顺序：先查“已知不支持”的旧格式再查普通映射。 */
const EXTENSION_FORMATS = Object.freeze({
  '.pdf': 'pdf',
  '.docx': 'docx', '.docm': 'docx', '.dotx': 'docx', '.dotm': 'docx',
  '.pptx': 'pptx', '.pptm': 'pptx', '.potx': 'pptx', '.ppsx': 'pptx',
  '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.xltx': 'xlsx', '.xlsb': 'xlsx',
  '.odt': 'odt', '.ott': 'odt', '.fodt': 'odt',
  '.ods': 'ods', '.ots': 'ods', '.fods': 'ods',
  '.odp': 'odp', '.otp': 'odp', '.fodp': 'odp',
  '.odg': 'odg', '.otg': 'odg',
  '.epub': 'epub',
  '.rtf': 'rtf',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html', '.xht': 'html', '.shtml': 'html',
  '.md': 'markdown', '.markdown': 'markdown', '.mdown': 'markdown', '.mkd': 'markdown',
  '.mdx': 'markdown', '.rst': 'markdown', '.adoc': 'markdown', '.asciidoc': 'markdown',
  '.org': 'markdown',
  '.txt': 'text', '.text': 'text', '.log': 'text', '.out': 'text', '.err': 'text',
  '.nfo': 'text', '.me': 'text', '.readme': 'text', '.ini': 'text', '.cfg': 'text',
  '.conf': 'text', '.properties': 'text', '.env': 'text', '.toml': 'text',
  '.xml': 'text', '.plist': 'text', '.rss': 'text', '.atom': 'text', '.svg': 'text',
  '.yaml': 'text', '.yml': 'text',
  '.csv': 'csv', '.tsv': 'csv', '.tab': 'csv',
  '.json': 'json', '.jsonl': 'text', '.ndjson': 'text', '.geojson': 'json',
  '.js': 'text', '.mjs': 'text', '.cjs': 'text', '.jsx': 'text',
  '.ts': 'text', '.tsx': 'text', '.vue': 'text', '.svelte': 'text',
  '.py': 'text', '.pyw': 'text', '.rb': 'text', '.php': 'text',
  '.java': 'text', '.kt': 'text', '.kts': 'text', '.scala': 'text', '.groovy': 'text',
  '.c': 'text', '.h': 'text', '.cc': 'text', '.cpp': 'text', '.cxx': 'text',
  '.hpp': 'text', '.hh': 'text', '.m': 'text', '.mm': 'text',
  '.cs': 'text', '.go': 'text', '.rs': 'text', '.swift': 'text', '.dart': 'text',
  '.lua': 'text', '.pl': 'text', '.r': 'text', '.jl': 'text',
  '.sh': 'text', '.bash': 'text', '.zsh': 'text', '.fish': 'text',
  '.ps1': 'text', '.bat': 'text', '.cmd': 'text',
  '.sql': 'text', '.graphql': 'text', '.gql': 'text', '.proto': 'text',
  '.diff': 'text', '.patch': 'text',
  '.css': 'text', '.scss': 'text', '.sass': 'text', '.less': 'text', '.styl': 'text',
  '.tex': 'text', '.bib': 'text',
  // 明确不支持（保留信息，给旧格式精确提示）
  '.doc': 'ole', '.dot': 'ole', '.xls': 'ole', '.xlt': 'ole', '.ppt': 'ole',
  '.pps': 'ole', '.pot': 'ole', '.vsd': 'ole', '.mdb': 'ole', '.msg': 'ole',
  '.psd': 'image', '.ai': 'image', '.eps': 'image',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image',
  '.webp': 'image', '.bmp': 'image', '.tif': 'image', '.tiff': 'image',
  '.ico': 'image', '.heic': 'image', '.heif': 'image', '.avif': 'image',
  '.zip': 'zip', '.rar': 'unknown', '.7z': 'unknown', '.gz': 'unknown',
  '.tar': 'unknown', '.tgz': 'unknown', '.bz2': 'unknown', '.xz': 'unknown',
});

/** mime → 格式（扩展名缺失/错误时的回退） */
const MIME_FORMATS = Object.freeze({
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.presentation': 'odp',
  'application/epub+zip': 'epub',
  'application/rtf': 'rtf',
  'text/rtf': 'rtf',
  'text/html': 'html',
  'application/xhtml+xml': 'html',
  'text/markdown': 'markdown',
  'text/x-markdown': 'markdown',
  'text/plain': 'text',
  'text/csv': 'csv',
  'text/tab-separated-values': 'csv',
  'application/json': 'json',
  'text/json': 'json',
  'application/xml': 'text',
  'text/xml': 'text',
  'text/yaml': 'text',
  'application/yaml': 'text',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'image/bmp': 'image',
  'image/svg+xml': 'text',
  'application/msword': 'ole',
  'application/vnd.ms-excel': 'ole',
  'application/vnd.ms-powerpoint': 'ole',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
});

/** 错误提示文案（尽量与契约一致） */
const MESSAGES = Object.freeze({
  image: '图片暂不支持自动解析：可粘贴图片中的文字，或在文件里附一段说明后再上传。',
  oldOffice: '暂不支持 Office 97-2003 旧格式，请另存为 .docx/.xlsx/.pptx 后重试。',
  zip64: '暂不支持 ZIP64/加密 ZIP 压缩包，请先解压或另存为较新格式后重试。',
  zipEncrypted: '暂不支持加密 ZIP 压缩包，请先解压或另存为较新格式后重试。',
  notZipDocument: '该 ZIP 压缩包不是可识别的文档格式（未找到 OOXML/ODF/EPUB 结构），请先解压后上传其中的文件。',
  encryptedPdf: 'PDF 已加密（含 /Encrypt），暂不支持解析；请先解除密码保护后重试。',
  binary: '文件内容看起来是二进制数据，无法按文本读取。',
  unknown: '无法识别的文件格式，暂不支持自动解析；支持 PDF、Word、PPT、Excel、EPUB、RTF、网页、Markdown、CSV、JSON 与纯文本。',
  empty: '文件为空（0 字节），没有可提取的文本。',
});

// ===========================================================================
// 极通用小工具（函数声明形式，便于任意顺序调用）
// ===========================================================================

/** 安全的整数读取 */
function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const floored = Math.floor(number);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/** 是否以给定字节序列开头（Buffer/Uint8Array） */
function startsWithBytes(buffer, bytes, offset = 0) {
  if (!buffer || buffer.length < offset + bytes.length) return false;
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[offset + index] !== bytes[index]) return false;
  }
  return true;
}

/** 把任意输出归一化成 Buffer；不可识别时返回 null */
function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

/** 取小写扩展名（带点）；隐藏文件（.env）整体作为扩展名 */
function extensionOf(filename) {
  if (typeof filename !== 'string' || !filename.trim()) return '';
  const raw = filename.trim().toLowerCase();
  const slash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  const base = raw.slice(slash + 1);
  if (!base) return '';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  if (dot === 0) return base.length > 1 ? base : '';
  return base.slice(dot);
}

/** 折叠所有空白为单个空格并去首尾 */
function collapseWhitespace(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

/** 标题清洗：解码实体（外部调用前已解码）、折叠空白、去 Markdown 前缀、限长 */
function cleanTitle(value, maxLength = MAX_TITLE_CHARS) {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
  text = text.replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim();
  text = text.replace(/^["'“”‘’《「『]+|["'“”‘’》」』]+$/g, '').trim();
  if (text.length > maxLength) text = text.slice(0, maxLength).trim();
  return text;
}

/** 块内文本归一化：保留换行语义，折叠行内连续空白，去掉空行 */
function normalizeBlockText(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  return raw
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')
    .trim();
}

/** 去掉除 \n \t 之外的控制字符与 BOM/零宽字符 */
function stripControlChars(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\u0000/g, '')
    .replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/[\ufeff\u200b]/g, '')
    .replace(/\u2028|\u2029/g, '\n');
}

/** Markdown 表格单元格转义 */
function escapeTableCell(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\t/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 生成 Markdown 表格（首行作为表头；空行调用方先过滤） */
function renderMarkdownTable(rows) {
  const cleanRows = [];
  let columnCount = 0;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const cells = row.map((cell) => escapeTableCell(cell));
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;
    if (cells.every((cell) => cell === '')) continue;
    if (cells.length > columnCount) columnCount = cells.length;
    cleanRows.push(cells);
  }
  if (cleanRows.length === 0 || columnCount === 0) return '';
  const lines = [];
  cleanRows.forEach((cells, index) => {
    const padded = cells.slice();
    while (padded.length < columnCount) padded.push('');
    lines.push(`| ${padded.join(' | ')} |`);
    if (index === 0) {
      const separators = new Array(columnCount).fill('---');
      lines.push(`| ${separators.join(' | ')} |`);
    }
  });
  return lines.join('\n');
}

/**
 * 最终正文归一化：
 * - 统一换行、去控制字符、行尾空白；
 * - 制表符保留；3+ 连续空行折叠为 2；
 * - 去首尾空白；超长截断并追加契约要求的提示；warnings 记录。
 * @returns {{text:string, truncated:boolean, originalChars:number}}
 */
function normalizeOutputText(input, maxChars, warnings, appendNotice = true) {
  const limit = clampInt(maxChars, DEFAULT_MAX_CHARS, 100, 5000000);
  let text = typeof input === 'string' ? input : '';
  text = stripControlChars(text).replace(/\r\n?/g, '\n');
  text = text.replace(/\u00a0/g, ' ');
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  const originalChars = text.length;
  let truncated = false;
  if (text.length > limit) {
    text = text.slice(0, limit).replace(/[ \t]+$/g, '').replace(/\n+$/g, '');
    if (appendNotice) text += TRUNCATE_SUFFIX;
    truncated = true;
    if (Array.isArray(warnings)) {
      warnings.push(`正文超出长度上限（${limit} 字符），已截断`);
    }
  }
  return { text, truncated, originalChars };
}

// ===========================================================================
// 结果对象工厂
// ===========================================================================

/** 失败/Upsupported 统一返回（永不抛异常） */
function failResult({ format, error, warnings, meta, unsupported = false }) {
  return {
    text: '',
    title: '',
    format: format || 'unknown',
    warnings: Array.isArray(warnings) ? warnings.filter((item) => typeof item === 'string' && item) : [],
    meta: meta && typeof meta === 'object' ? meta : {},
    unsupported: Boolean(unsupported),
    error: error || '未能从文件中提取出有效文本。',
  };
}

/** unsupported 结果 */
function unsupportedResult(format, error, warnings, meta) {
  return failResult({ format, error, warnings, meta, unsupported: true });
}

/**
 * 成功抽取后的收尾：长度归一化/截断、<20 字判失败、组装结果。
 */
function finalizeResult({ format, text, title, warnings, meta, maxChars, bytes }) {
  const rawWarnings = Array.isArray(warnings) ? warnings.filter((item) => typeof item === 'string' && item) : [];
  const warningList = [...new Set(rawWarnings)];
  const normalized = normalizeOutputText(text, maxChars, warningList);
  const finalText = normalized.text;
  const baseMeta = Object.assign(
    {
      bytes: typeof bytes === 'number' ? bytes : 0,
      chars: finalText.length,
      originalChars: normalized.originalChars,
    },
    meta && typeof meta === 'object' ? meta : {},
  );
  baseMeta.chars = finalText.length;
  baseMeta.originalChars = normalized.originalChars;
  if (!finalText || finalText.length < MIN_TEXT_CHARS) {
    const detail = finalText
      ? `抽取到的正文过短（${finalText.length} 字符，少于 ${MIN_TEXT_CHARS} 字符），无法作为有效内容。`
      : '未能从文件中提取出有效正文。';
    return {
      text: '',
      title: cleanTitle(title),
      format: format || 'unknown',
      warnings: warningList,
      meta: baseMeta,
      unsupported: false,
      error: detail,
    };
  }
  return {
    text: finalText,
    title: cleanTitle(title),
    format: format || 'unknown',
    warnings: warningList,
    meta: baseMeta,
    unsupported: false,
  };
}

// ===========================================================================
// 编码探测：BOM → UTF-8(fatal) → GB18030(fatal) → Latin1；二进制判定
// ===========================================================================

/** 用给定编码做“严格”解码；失败返回 null */
function tryDecodeStrict(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 用给定编码做宽松解码；失败返回 null */
function tryDecodeLoose(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** 文本是否“像文本”：控制字符占比极低 */
function looksTextual(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const sample = text.slice(0, 6000);
  let suspicious = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32) suspicious += 1;
    else if (code >= 0x7f && code <= 0x9f) suspicious += 1;
    else if (code === 0xfffd) suspicious += 1;
  }
  return suspicious / sample.length < 0.03;
}

/** 无 BOM 的 UTF-16 探测（ASCII 文档零字节有规律分布） */
function detectUtf16NoBom(buffer) {
  if (!buffer || buffer.length < 8 || buffer.length % 2 !== 0) return '';
  const sampleLength = Math.min(buffer.length, 8192);
  const pairs = Math.floor(sampleLength / 2);
  if (pairs < 4) return '';
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index + 1 < sampleLength; index += 2) {
    if (buffer[index] === 0) evenZeros += 1;
    if (buffer[index + 1] === 0) oddZeros += 1;
  }
  if (oddZeros >= pairs * 0.3 && oddZeros > evenZeros * 5) return 'utf-16le';
  if (evenZeros >= pairs * 0.3 && evenZeros > oddZeros * 5) return 'utf-16be';
  return '';
}

/** 二进制判定：NUL/控制字节占比 */
function looksLikeBinary(buffer) {
  if (!buffer || buffer.length === 0) return false;
  const sampleLength = Math.min(buffer.length, 8192);
  let zeros = 0;
  let controls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index];
    if (byte === 0) zeros += 1;
    else if (byte < 9 || (byte > 13 && byte < 32)) controls += 1;
  }
  if (zeros > 0) return true;
  if (controls / sampleLength > 0.05) return true;
  return false;
}

/**
 * 通用文本字节解码。返回 { text, encoding, binary }；binary=true 表示不可当文本处理。
 */
function decodeTextBuffer(buffer) {
  if (!buffer || buffer.length === 0) return { text: '', encoding: '', binary: false };
  if (startsWithBytes(buffer, [0xef, 0xbb, 0xbf])) {
    const text = tryDecodeLoose(buffer.subarray(3), 'utf-8') ?? '';
    return { text: stripControlChars(text), encoding: 'utf-8', binary: false };
  }
  if (startsWithBytes(buffer, [0xff, 0xfe])) {
    const text = tryDecodeLoose(buffer.subarray(2), 'utf-16le') ?? '';
    return { text: stripControlChars(text), encoding: 'utf-16le', binary: false };
  }
  if (startsWithBytes(buffer, [0xfe, 0xff])) {
    const text = tryDecodeLoose(buffer.subarray(2), 'utf-16be') ?? '';
    return { text: stripControlChars(text), encoding: 'utf-16be', binary: false };
  }
  const utf16 = detectUtf16NoBom(buffer);
  if (utf16) {
    const strict = tryDecodeStrict(buffer, utf16);
    if (strict !== null && looksTextual(strict)) {
      return { text: stripControlChars(strict), encoding: utf16, binary: false };
    }
  }
  if (looksLikeBinary(buffer)) return { text: '', encoding: '', binary: true };
  const utf8 = tryDecodeStrict(buffer, 'utf-8');
  if (utf8 !== null) return { text: stripControlChars(utf8), encoding: 'utf-8', binary: false };
  const gb = tryDecodeStrict(buffer, 'gb18030');
  if (gb !== null && looksTextual(gb)) {
    return { text: stripControlChars(gb), encoding: 'gb18030', binary: false };
  }
  const latin = tryDecodeLoose(buffer, 'latin1') ?? '';
  if (!looksTextual(latin)) return { text: '', encoding: '', binary: true };
  return { text: stripControlChars(latin), encoding: 'latin1', binary: false };
}

/** 从 HTML 头 8KB 嗅探 charset（ASCII 标签名，latin1 读取即可） */
function charsetFromHtmlMeta(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const head = buffer.subarray(0, 8192).toString('latin1');
  const patterns = [
    /<meta[^>]+charset\s*=\s*["']?\s*([\w.:+-]+)/i,
    /<meta[^>]+http-equiv\s*=\s*["']?\s*content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([\w.:+-]+)/i,
    /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w.:+-]+)["'][^>]*http-equiv\s*=\s*["']?content-type/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(head);
    if (match && match[1]) return normalizeCharsetLabel(match[1]);
  }
  return '';
}

/** charset 名称归一化（gb2312/gbk → gb18030） */
function normalizeCharsetLabel(label) {
  if (typeof label !== 'string') return '';
  const value = label.trim().toLowerCase().replace(/^["']|["']$/g, '');
  if (!value) return '';
  if (value === 'utf8' || value === 'unicode-1-1-utf-8' || value === 'unicode11utf8') return 'utf-8';
  if (['gb2312', 'gbk', 'x-gbk', 'cp936', 'gb_2312-80', 'gb18030'].includes(value)) return 'gb18030';
  if (value === 'big5' || value === 'big5-hkscs' || value === 'cp950') return 'big5';
  if (value === 'shift_jis' || value === 'sjis' || value === 'cp932') return 'shift_jis';
  return value;
}

/** 从 Content-Type 提取 charset */
function charsetFromContentType(contentType) {
  if (typeof contentType !== 'string' || !contentType) return '';
  const match = /charset\s*=\s*["']?\s*([\w.:+-]+)/i.exec(contentType);
  return match ? normalizeCharsetLabel(match[1]) : '';
}

/**
 * HTML/XML 字节解码：BOM → 声明 charset（mime → meta）→ UTF-8 → GB18030。
 * 声明优先（浏览器行为）；解码出现大量替换符时回退 UTF-8。
 */
function decodeHtmlBuffer(buffer, mime) {
  if (!buffer || buffer.length === 0) return { text: '', encoding: '' };
  let bytes = buffer;
  let bomEncoding = '';
  if (startsWithBytes(bytes, [0xef, 0xbb, 0xbf])) {
    bomEncoding = 'utf-8';
    bytes = bytes.subarray(3);
  } else if (startsWithBytes(bytes, [0xff, 0xfe])) {
    bomEncoding = 'utf-16le';
    bytes = bytes.subarray(2);
  } else if (startsWithBytes(bytes, [0xfe, 0xff])) {
    bomEncoding = 'utf-16be';
    bytes = bytes.subarray(2);
  }
  if (bomEncoding) {
    const text = tryDecodeLoose(bytes, bomEncoding) ?? '';
    return { text: stripControlChars(text), encoding: bomEncoding };
  }
  const declared = charsetFromContentType(mime) || charsetFromHtmlMeta(bytes);
  if (declared) {
    const text = tryDecodeLoose(bytes, declared);
    if (text !== null) {
      const replacementRate = (text.match(/\ufffd/g) || []).length / Math.max(1, text.length);
      if (replacementRate <= 0.01) return { text: stripControlChars(text), encoding: declared };
    }
  }
  const strictUtf8 = tryDecodeStrict(bytes, 'utf-8');
  if (strictUtf8 !== null) return { text: stripControlChars(strictUtf8), encoding: 'utf-8' };
  const strictGb = tryDecodeStrict(bytes, 'gb18030');
  if (strictGb !== null) return { text: stripControlChars(strictGb), encoding: 'gb18030' };
  const loose = tryDecodeLoose(bytes, 'utf-8') ?? bytes.toString('latin1');
  return { text: stripControlChars(loose), encoding: 'utf-8' };
}

// ===========================================================================
// 自写 ZIP 解析（EOCD + central directory + local header）
// ===========================================================================

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CEN_SIG = 0x02014b50;
const ZIP_LOC_SIG = 0x04034b50;
const ZIP_CEN_SIG_BUFFER = Buffer.from([0x50, 0x4b, 0x01, 0x02]);

/** ZIP 解析错误（带稳定 code：INVALID/ZIP64/ENCRYPTED/METHOD/INFLATE/MISSING） */
class ZipError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ZipError';
    this.code = code;
  }
}

/**
 * 解析 ZIP 的 central directory。不做任何解压，只记录每个条目的元信息。
 * @returns {{buffer:Buffer, entries:Map<string, object>, names:string[]}}
 */
function readZip(input) {
  const buffer = toBuffer(input);
  if (!buffer || buffer.length < 22) {
    throw new ZipError('INVALID', '不是有效的 ZIP 文件（长度不足）');
  }
  const length = buffer.length;
  let eocd = -1;
  const scanStart = Math.max(0, length - 22 - 65535);
  for (let position = length - 22; position >= scanStart; position -= 1) {
    if (buffer.readUInt32LE(position) === ZIP_EOCD_SIG) {
      eocd = position;
      break;
    }
  }
  if (eocd === -1) throw new ZipError('INVALID', '不是有效的 ZIP 文件（找不到 EOCD）');
  const declaredCount = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (declaredCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('ZIP64', '不支持 ZIP64 格式');
  }
  const entries = new Map();
  const names = [];
  let cursor = cdOffset;
  let guard = 0;
  while (entries.size < declaredCount && guard < MAX_ZIP_ENTRIES) {
    guard += 1;
    const position = buffer.indexOf(ZIP_CEN_SIG_BUFFER, cursor);
    if (position === -1 || position + 46 > length) break;
    const flags = buffer.readUInt16LE(position + 8);
    const method = buffer.readUInt16LE(position + 10);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const uncompressedSize = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const localOffset = buffer.readUInt32LE(position + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('ZIP64', '不支持 ZIP64 格式');
    }
    if (flags & 0x1) throw new ZipError('ENCRYPTED', '不支持加密 ZIP 条目');
    const nameStart = position + 46;
    const nameEnd = Math.min(length, nameStart + nameLength);
    const nameBuffer = buffer.subarray(nameStart, nameEnd);
    let name = tryDecodeStrict(nameBuffer, 'utf-8') ?? nameBuffer.toString('latin1');
    name = name.replace(/\\/g, '/');
    const entry = {
      name,
      flags,
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    };
    if (!entries.has(name)) {
      entries.set(name, entry);
      names.push(name);
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  if (entries.size === 0) throw new ZipError('INVALID', 'ZIP 压缩包为空或目录损坏');
  return { buffer, entries, names };
}

/** 解压单个 ZIP 条目，返回 Buffer；条目不存在返回 null */
function readZipEntryData(archive, name) {
  if (!archive || !archive.entries) return null;
  const normalized = String(name || '').replace(/\\/g, '/');
  const entry = archive.entries.get(normalized);
  if (!entry) return null;
  const buffer = archive.buffer;
  const length = buffer.length;
  const position = entry.localOffset;
  if (position + 30 > length || buffer.readUInt32LE(position) !== ZIP_LOC_SIG) {
    throw new ZipError('INVALID', `ZIP 条目「${normalized}」本地文件头损坏`);
  }
  const nameLength = buffer.readUInt16LE(position + 26);
  const extraLength = buffer.readUInt16LE(position + 28);
  const dataStart = position + 30 + nameLength + extraLength;
  if (dataStart + entry.compressedSize > length) {
    throw new ZipError('INVALID', `ZIP 条目「${normalized}」数据越界`);
  }
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) {
    if (raw.length === 0) return Buffer.alloc(0);
    try {
      return inflateRawSync(raw);
    } catch {
      try {
        return inflateSync(raw);
      } catch {
        throw new ZipError('INFLATE', `ZIP 条目「${normalized}」解压失败（Deflate 数据损坏）`);
      }
    }
  }
  throw new ZipError('METHOD', `ZIP 条目「${normalized}」使用了不支持的压缩方式（method=${entry.method}）`);
}

/** 读取 ZIP 内文本文件（UTF-8/BOM 探测）；不存在返回 null */
function readZipText(archive, name) {
  const data = readZipEntryData(archive, name);
  if (!data) return null;
  const decoded = decodeTextBuffer(data);
  if (decoded.binary) {
    // XML/文本内容极少二进制；宽松回退 latin1 前先按 UTF-8 宽松解码
    const loose = tryDecodeLoose(data, 'utf-8');
    return loose === null ? data.toString('latin1') : loose;
  }
  return decoded.text;
}

/** 按前缀/正则筛选 ZIP 条目名 */
function zipEntryNames(archive, matcher) {
  if (!archive || !Array.isArray(archive.names)) return [];
  if (matcher instanceof RegExp) return archive.names.filter((name) => matcher.test(name));
  if (typeof matcher === 'string') return archive.names.filter((name) => name.startsWith(matcher));
  return archive.names.slice();
}

// ===========================================================================
// 格式识别
// ===========================================================================

/** 扩展名 → 格式（未知返回 '') */
function formatFromExtension(filename) {
  const extension = extensionOf(filename);
  if (!extension) return '';
  return EXTENSION_FORMATS[extension] || '';
}

/** mime → 格式（未知返回 '') */
function formatFromMime(mime) {
  if (typeof mime !== 'string' || !mime) return '';
  let base = mime.split(';')[0].trim().toLowerCase();
  if (!base) return '';
  return MIME_FORMATS[base] || '';
}

/** 魔数识别：返回 {format, imageType?, note?} 或 null */
function formatFromMagic(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const head = buffer.subarray(0, Math.min(buffer.length, 4096));
  // PDF 允许前若干字节有垃圾（部分生成器会加 BOM/空白）
  const pdfIndex = buffer.subarray(0, 1024).indexOf(Buffer.from('%PDF-', 'latin1'));
  if (pdfIndex >= 0) return { format: 'pdf' };
  if (startsWithBytes(head, [0x50, 0x4b, 0x03, 0x04]) || startsWithBytes(head, [0x50, 0x4b, 0x05, 0x06]) || startsWithBytes(head, [0x50, 0x4b, 0x07, 0x08])) {
    return { format: 'zip' };
  }
  if (startsWithBytes(head, OLE_MAGIC)) return { format: 'ole' };
  // RTF：可带 BOM/空白
  const rtfText = head.toString('latin1').replace(/^\uFEFF/, '').trimStart();
  if (/^\{\\rtf/i.test(rtfText)) return { format: 'rtf' };
  for (const signature of IMAGE_SIGNATURES) {
    if (startsWithBytes(head, signature.bytes)) return { format: 'image', imageType: signature.name };
  }
  if (startsWithBytes(head, [0x52, 0x49, 0x46, 0x46]) && head.length >= 12 && head.subarray(8, 12).toString('latin1') === 'WEBP') {
    return { format: 'image', imageType: 'webp' };
  }
  if (startsWithBytes(head, [0x89, 0x50, 0x4e, 0x47])) return { format: 'image', imageType: 'png' };
  // HTML / XML（XHTML）
  const textHead = stripBom(head.toString('latin1')).trimStart();
  const lower = textHead.slice(0, 2048).toLowerCase();
  if (lower.startsWith('<!doctype html') || lower.startsWith('<html')) return { format: 'html' };
  if (lower.startsWith('<?xml')) {
    const htmlIndex = lower.indexOf('<html');
    if (htmlIndex >= 0 && htmlIndex < 2048) return { format: 'html' };
    return { format: 'text' };
  }
  if (lower.startsWith('<head') || lower.startsWith('<body') || lower.startsWith('<meta')) return { format: 'html' };
  return null;
}

/** 去 UTF-8 BOM（字符串级） */
function stripBom(value) {
  return typeof value === 'string' && value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/** 判断 ZIP 容器属于哪种文档 */
function inspectZipKind(buffer) {
  let archive;
  try {
    archive = readZip(buffer);
  } catch (error) {
    return { kind: 'zip', archive: null, error };
  }
  const names = archive.names || [];
  const has = (name) => archive.entries.has(name);
  const contentTypes = has('[Content_Types].xml') ? readZipText(archive, '[Content_Types].xml') || '' : '';
  if (has('word/document.xml') || /wordprocessingml\.document/i.test(contentTypes)) {
    return { kind: 'docx', archive };
  }
  if (has('ppt/presentation.xml') || /presentationml\.presentation/i.test(contentTypes)) {
    return { kind: 'pptx', archive };
  }
  if (has('xl/workbook.xml') || /spreadsheetml\.sheet/i.test(contentTypes)) {
    return { kind: 'xlsx', archive };
  }
  let mime = '';
  if (has('mimetype')) {
    try {
      mime = (readZipText(archive, 'mimetype') || '').trim().toLowerCase();
    } catch {
      mime = '';
    }
  }
  if (mime === 'application/epub+zip' || has('META-INF/container.xml') || names.some((name) => name.toLowerCase().endsWith('.opf'))) {
    return { kind: 'epub', archive };
  }
  if (mime.includes('opendocument')) {
    if (mime.includes('spreadsheet')) return { kind: 'ods', archive, mime };
    if (mime.includes('presentation')) return { kind: 'odp', archive, mime };
    if (mime.includes('graphics')) return { kind: 'odg', archive, mime };
    return { kind: 'odt', archive, mime };
  }
  if (has('content.xml') && has('META-INF/manifest.xml')) {
    // 有些 ODF 省略 mimetype 条目；从 content.xml 开头的 office:body 推断
    let head = '';
    try {
      const data = readZipEntryData(archive, 'content.xml');
      if (data) head = data.subarray(0, 4096).toString('latin1');
    } catch {
      head = '';
    }
    if (/office:spreadsheet/i.test(head)) return { kind: 'ods', archive, mime: 'application/vnd.oasis.opendocument.spreadsheet' };
    if (/office:presentation/i.test(head)) return { kind: 'odp', archive, mime: 'application/vnd.oasis.opendocument.presentation' };
    if (/office:drawing/i.test(head)) return { kind: 'odg', archive, mime: 'application/vnd.oasis.opendocument.graphics' };
    return { kind: 'odt', archive, mime: 'application/vnd.oasis.opendocument.text' };
  }
  return { kind: 'zip', archive };
}

/**
 * 内部详细识别：返回 { format, zip?, zipError?, imageType?, officeKind? }
 */
function detectFormatDetailed(buffer, filename, mime) {
  try {
    const extensionFormat = formatFromExtension(filename);
    const mimeFormat = formatFromMime(mime);
    const magic = formatFromMagic(buffer);
    if (magic && magic.format === 'zip') {
      const zipInfo = inspectZipKind(buffer);
      if (zipInfo.kind && zipInfo.kind !== 'zip') {
        return { format: zipInfo.kind, zip: zipInfo.archive };
      }
      if (zipInfo.error) {
        const guessed = extensionFormat && extensionFormat !== 'zip' ? extensionFormat : mimeFormat;
        return { format: guessed || 'zip', zip: null, zipError: zipInfo.error };
      }
      return { format: 'zip', zip: zipInfo.archive };
    }
    if (magic && magic.format === 'ole') {
      const officeKind =
        extensionFormat === 'ole'
          ? extensionOf(filename).replace('.', '')
          : mimeFormat === 'ole'
            ? 'office'
            : 'office';
      return { format: 'ole', officeKind, extension: extensionOf(filename) };
    }
    if (magic) return magic;
    if (extensionFormat) return { format: extensionFormat, extension: extensionOf(filename) };
    if (mimeFormat) return { format: mimeFormat };
    return { format: 'unknown' };
  } catch {
    return { format: 'unknown' };
  }
}

/**
 * 根据扩展名/mime/魔数判断格式（稳定公开 API；永不抛异常）。
 * @returns {'pdf'|'docx'|'pptx'|'xlsx'|'odt'|'ods'|'odp'|'epub'|'rtf'|'html'|'markdown'|'text'|'csv'|'json'|'zip'|'image'|'unknown'}
 */
export function detectFormat(buffer, filename, mime) {
  const documented = new Set([
    'pdf', 'docx', 'pptx', 'xlsx', 'odt', 'ods', 'odp', 'epub', 'rtf', 'html',
    'markdown', 'text', 'csv', 'json', 'zip', 'image', 'unknown',
  ]);
  try {
    const normalized = toBuffer(buffer);
    if (!normalized || normalized.length === 0) {
      const guessed = formatFromExtension(filename) || formatFromMime(mime);
      return documented.has(guessed) ? guessed : 'unknown';
    }
    const detail = detectFormatDetailed(normalized, filename, mime);
    const format = detail && detail.format ? detail.format : 'unknown';
    if (documented.has(format)) return format;
    if (format === 'odg') return 'odt';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 快速判断（client/UX 提示用；不保证解析成功） */
export function isSupportedFile(filename) {
  const extension = extensionOf(filename);
  return Boolean(extension) && SUPPORTED_EXTENSIONS.includes(extension);
}

// ===========================================================================
// 容错 HTML 解析器（移植自 AI 阅读助手，去掉 block 细节）
// ===========================================================================

/** 无内容、不能挂子节点的空元素标签 */
const VOID_TAGS = new Set([
  'area', 'base', 'basefont', 'br', 'col', 'embed', 'frame', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** raw-text 元素：内容整段跳过（内部可能含伪标签） */
const RAW_TEXT_TAGS = new Set(['script', 'style', 'textarea', 'noscript', 'xmp', 'plaintext']);

/** 去噪时整棵删除的标签子树 */
const NOISE_TAGS = new Set([
  'script', 'style', 'noscript', 'svg', 'iframe', 'form', 'nav', 'footer', 'header',
  'aside', 'template', 'canvas', 'object', 'head',
]);

/** class/id 噪声词（按分隔符分词匹配，避免误删 download 里的 ad） */
const NOISE_CLASS_RE =
  /(?:^|[\s_-])(?:nav|navbar|navigation|menu|footer|header|comment|comments|related|recommend|share|sharing|social|advert|advertisement|ads?|banner|breadcrumb|subscribe|subscription|toolbar|cookie|popup|modal|sidebar|rank|ranking|tag-list|tags-list|author-card|authorcard|byline-extra)(?:[\s_-]|$)/;

/** 块级容器标签 */
const BLOCK_TAGS = new Set([
  'address', 'article', 'body', 'center', 'dd', 'details', 'dialog', 'dir', 'div', 'dl',
  'dt', 'fieldset', 'figcaption', 'figure', 'hgroup', 'main', 'menu', 'output', 'p',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
]);

/** 标题层级映射（h4-h6 归为 3） */
const HEADING_LEVEL_BY_TAG = Object.freeze({
  h1: 1, h2: 2, h3: 3, h4: 3, h5: 3, h6: 3,
});

/** 未闭合标签自动闭合规则（真实网页普遍省略 </p> </li> </td>） */
const AUTO_CLOSE_ON_OPEN = Object.freeze({
  li: ['li'],
  p: ['p'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  option: ['option'],
  optgroup: ['optgroup', 'option'],
});

/** 这些父节点里的 code 视为行内代码 */
const INLINE_CODE_PARENT_TAGS = new Set([
  'p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'figcaption', 'dt', 'dd',
]);

/** 常用命名实体表（数字实体在 decodeEntities 单独处理） */
const NAMED_ENTITIES = Object.freeze({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  middot: '·', bull: '•', times: '×', divide: '÷', deg: '°', plusmn: '±',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hArr: '⇔', rArr: '⇒',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sum: '∑', prod: '∏',
  radic: '√', int: '∫', part: '∂', nabla: '∇', isin: '∈', notin: '∉',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  omicron: 'ο', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Pi: 'Π',
  ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwj: '\u200d', zwnj: '\u200c',
  shy: '\u00ad', iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾',
  sup1: '¹', sup2: '²', sup3: '³', micro: 'µ', not: '¬', macr: '¯', acute: '´',
  cedil: '¸', uml: '¨', ordf: 'ª', ordm: 'º', sbquo: '‚', bdquo: '„',
});

/** 大小写不敏感的命名实体索引 */
const NAMED_ENTITIES_CI = (() => {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(NAMED_ENTITIES)) {
    const lower = key.toLowerCase();
    if (out[lower] === undefined) out[lower] = value;
  }
  return out;
})();

/** 解码 HTML/XML 实体（不认识的实体原样保留） */
function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return typeof input === 'string' ? input : '';
  return input.replace(/&(#(?:[xX][0-9a-fA-F]+|\d+)|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      if (code >= 0xd800 && code <= 0xdfff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    const ci = NAMED_ENTITIES_CI[body.toLowerCase()];
    return ci !== undefined ? ci : match;
  });
}

/** 块文本是否有阅读价值（去掉空白/标点/符号后为空或长度 < 2） */
function isMeaninglessText(text) {
  if (typeof text !== 'string' || text.length < 2) return true;
  const visible = text.replace(/[\s\p{P}\p{S}]+/gu, '');
  return visible.length === 0;
}

/** 标题比较键：忽略空白/标点/大小写 */
function normalizeTitleKey(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 在元素自身与浅层后代里找第一个行内 font-size（微信正文式 h1 降级用） */
function firstInlineFontSize(element) {
  const queue = [{ node: element, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 80) {
    const entry = queue.shift();
    visited += 1;
    const node = entry.node;
    if (!node || node.type !== 'element') continue;
    const style = String((node.attrs || {}).style || '');
    const match = /font-size\s*:\s*([\d.]+)\s*px/i.exec(style);
    if (match) {
      const size = Number(match[1]);
      if (Number.isFinite(size) && size > 0) return size;
    }
    if (entry.depth >= 4) continue;
    for (const child of node.children || []) {
      if (child && child.type === 'element') queue.push({ node: child, depth: entry.depth + 1 });
    }
  }
  return null;
}

/** 扫描开标签（属性名小写；失败返回 null） */
function parseOpenTag(html, start, preserveTagCase = false) {
  const length = html.length;
  let cursor = start + 1;
  const nameStart = cursor;
  while (cursor < length && /[A-Za-z0-9:-]/.test(html[cursor])) cursor += 1;
  if (cursor === nameStart) return null;
  const rawTag = html.slice(nameStart, cursor);
  const tag = preserveTagCase ? rawTag : rawTag.toLowerCase();
  const attrs = Object.create(null);
  let selfClosing = false;
  while (cursor < length) {
    while (cursor < length && /\s/.test(html[cursor])) cursor += 1;
    if (cursor >= length) return null;
    const char = html[cursor];
    if (char === '>') return { tag, attrs, selfClosing, end: cursor + 1 };
    if (char === '/') {
      if (html[cursor + 1] === '>') return { tag, attrs, selfClosing: true, end: cursor + 2 };
      cursor += 1;
      continue;
    }
    const attrStart = cursor;
    while (cursor < length && !/[\s=>/]/.test(html[cursor])) cursor += 1;
    const attrName = html.slice(attrStart, cursor).toLowerCase();
    while (cursor < length && /\s/.test(html[cursor])) cursor += 1;
    let attrValue = '';
    if (html[cursor] === '=') {
      cursor += 1;
      while (cursor < length && /\s/.test(html[cursor])) cursor += 1;
      const quote = html[cursor];
      if (quote === '"' || quote === "'") {
        cursor += 1;
        const endQuote = html.indexOf(quote, cursor);
        if (endQuote === -1) return null;
        attrValue = html.slice(cursor, endQuote);
        cursor = endQuote + 1;
      } else {
        const valueStart = cursor;
        while (cursor < length && !/[\s>]/.test(html[cursor])) cursor += 1;
        attrValue = html.slice(valueStart, cursor);
      }
    }
    if (attrName) attrs[attrName] = attrValue;
    else cursor += 1;
  }
  return null;
}

/** 容错 tokenizer：text/open/close 三类 token */
function tokenizeHtml(html) {
  const tokens = [];
  const length = html.length;
  let cursor = 0;
  while (cursor < length) {
    const lt = html.indexOf('<', cursor);
    if (lt === -1) {
      tokens.push({ type: 'text', text: html.slice(cursor) });
      break;
    }
    if (lt > cursor) tokens.push({ type: 'text', text: html.slice(cursor, lt) });
    const next = html.charAt(lt + 1);
    if (next === '!') {
      if (html.startsWith('<!--', lt)) {
        const endComment = html.indexOf('-->', lt + 4);
        cursor = endComment === -1 ? length : endComment + 3;
      } else {
        const endDecl = html.indexOf('>', lt + 2);
        cursor = endDecl === -1 ? length : endDecl + 1;
      }
      continue;
    }
    if (next === '?') {
      const endPi = html.indexOf('>', lt + 2);
      cursor = endPi === -1 ? length : endPi + 1;
      continue;
    }
    if (next === '/') {
      const endClose = html.indexOf('>', lt + 2);
      if (endClose === -1) {
        tokens.push({ type: 'text', text: html.slice(lt) });
        break;
      }
      const rawName = html.slice(lt + 2, endClose).trim().split(/[\s/]+/)[0].toLowerCase();
      if (/^[a-z][a-z0-9:-]*$/.test(rawName)) tokens.push({ type: 'close', tag: rawName });
      cursor = endClose + 1;
      continue;
    }
    if (next && /[A-Za-z]/.test(next)) {
      const parsed = parseOpenTag(html, lt);
      if (parsed) {
        cursor = parsed.end;
        if (RAW_TEXT_TAGS.has(parsed.tag)) {
          if (!parsed.selfClosing) {
            const closeRe = new RegExp(`</${parsed.tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`, 'i');
            const rest = html.slice(cursor);
            const match = closeRe.exec(rest);
            cursor = match ? cursor + match.index + match[0].length : length;
          }
          continue;
        }
        tokens.push({ type: 'open', tag: parsed.tag, attrs: parsed.attrs, selfClosing: parsed.selfClosing });
        continue;
      }
      tokens.push({ type: 'text', text: '<' });
      cursor = lt + 1;
      continue;
    }
    tokens.push({ type: 'text', text: '<' });
    cursor = lt + 1;
  }
  return tokens;
}

/** 由 token 建容错节点树 */
function buildHtmlTree(tokens) {
  const root = { type: 'element', tag: '#root', attrs: Object.create(null), children: [] };
  const stack = [root];
  for (const token of tokens) {
    if (token.type === 'text') {
      if (token.text) stack[stack.length - 1].children.push({ type: 'text', text: token.text });
      continue;
    }
    if (token.type === 'open') {
      const autoCloseTags = AUTO_CLOSE_ON_OPEN[token.tag];
      if (autoCloseTags) {
        while (stack.length > 1 && autoCloseTags.includes(stack[stack.length - 1].tag)) stack.pop();
      }
      const node = { type: 'element', tag: token.tag, attrs: token.attrs, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!token.selfClosing && !VOID_TAGS.has(token.tag)) stack.push(node);
      continue;
    }
    for (let depth = stack.length - 1; depth > 0; depth -= 1) {
      if (stack[depth].tag === token.tag) {
        stack.length = depth;
        break;
      }
    }
  }
  return root;
}

/** 把 HTML 文本解析为节点树 */
function parseHtmlDocument(html) {
  return buildHtmlTree(tokenizeHtml(typeof html === 'string' ? html : ''));
}

/** 读属性（统一小写 key） */
function getAttr(element, attrName) {
  if (!element || element.type !== 'element' || !element.attrs) return '';
  const value = element.attrs[attrName];
  return typeof value === 'string' ? value : '';
}

/** 按文档顺序遍历元素 */
function walkElements(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || node.type !== 'element') continue;
    visit(node);
    const children = node.children || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child && child.type === 'element') stack.push(child);
    }
  }
}

/** 按条件查找第一个元素（文档顺序） */
function findFirstElement(root, predicate) {
  let found = null;
  walkElements(root, (element) => {
    if (!found && predicate(element)) found = element;
  });
  return found;
}

/** 按条件查找所有元素 */
function findElements(root, predicate) {
  const result = [];
  walkElements(root, (element) => {
    if (predicate(element)) result.push(element);
  });
  return result;
}

/** 元素文本内容（含子孙，实体已解码） */
function textContent(node) {
  if (!node) return '';
  if (node.type === 'text') return decodeEntities(node.text);
  let out = '';
  for (const child of node.children || []) out += textContent(child);
  return out;
}

/** 统计子树可读文字量（选正文根用） */
function textLengthOf(node) {
  if (!node) return 0;
  if (node.type === 'text') return collapseWhitespace(decodeEntities(node.text)).length;
  let total = 0;
  for (const child of node.children || []) total += textLengthOf(child);
  return total;
}

/** class/id 是否命中噪声词 */
function matchesNoiseClass(raw) {
  if (typeof raw !== 'string' || !raw) return false;
  const normalized = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return NOISE_CLASS_RE.test(normalized);
}

/** 元素是否整棵删除 */
function isNoiseElement(element) {
  if (!element || element.type !== 'element') return false;
  if (NOISE_TAGS.has(element.tag)) return true;
  const attrs = element.attrs || {};
  if (attrs['aria-hidden'] === 'true') return true;
  if ('hidden' in attrs) return true;
  const style = (attrs.style || '').toLowerCase();
  if (/display\s*:\s*none/.test(style)) return true;
  if (element.tag === 'body' || element.tag === 'html' || element.tag === '#root') return false;
  return matchesNoiseClass(attrs.class || '') || matchesNoiseClass(attrs.id || '');
}

/** 递归去噪（原地修剪） */
function denoiseTree(node) {
  if (!node || node.type !== 'element') return node;
  const kept = [];
  for (const child of node.children || []) {
    if (child.type === 'text') {
      kept.push(child);
      continue;
    }
    if (child.type !== 'element') continue;
    if (isNoiseElement(child)) continue;
    denoiseTree(child);
    kept.push(child);
  }
  node.children = kept;
  return node;
}

/** Book chapters can use header/footer/nav for content; retain those rather than article heuristics. */
function cleanBookHtmlTree(node) {
  if (!node || node.type !== 'element') return node;
  node.children = (node.children || []).filter((child) => child.type === 'text'
    || child.type === 'element' && !['script', 'style', 'noscript', 'svg', 'iframe'].includes(child.tag));
  for (const child of node.children) if (child.type === 'element') cleanBookHtmlTree(child);
  return node;
}

/** 是否包含任意元素节点 */
function hasAnyElement(node) {
  if (!node || node.type !== 'element') return false;
  for (const child of node.children || []) {
    if (child.type === 'element') return true;
    if (hasAnyElement(child)) return true;
  }
  return false;
}

/** 收集行内文字（br → 换行；可跳过列表） */
function collectInlineText(element, options) {
  const opts = options || {};
  let out = '';
  for (const child of element.children || []) {
    if (child.type === 'text') {
      out += decodeEntities(child.text);
      continue;
    }
    if (child.type !== 'element') continue;
    const tag = child.tag;
    if (tag === 'br') {
      out += '\n';
      continue;
    }
    if (tag === 'img' || tag === 'hr') continue;
    if (opts.skipLists && (tag === 'ul' || tag === 'ol')) continue;
    if (opts.skipListItems && tag === 'li') continue;
    if (tag === 'pre') {
      out += collectRawText(child);
      continue;
    }
    out += collectInlineText(child, opts);
  }
  return out;
}

/** 收集保留空白的原始文本（pre/code 用） */
function collectRawText(element) {
  let out = '';
  for (const child of element.children || []) {
    if (child.type === 'text') {
      out += decodeEntities(child.text);
      continue;
    }
    if (child.type !== 'element') continue;
    if (child.tag === 'br') {
      out += '\n';
      continue;
    }
    if (child.tag === 'img' || child.tag === 'hr') continue;
    const isBlock =
      BLOCK_TAGS.has(child.tag) ||
      Boolean(HEADING_LEVEL_BY_TAG[child.tag]) ||
      child.tag === 'pre' || child.tag === 'ul' || child.tag === 'ol' ||
      child.tag === 'li' || child.tag === 'blockquote';
    out += isBlock ? `\n${collectRawText(child)}\n` : collectRawText(child);
  }
  return out;
}

/** 收集块内富文本（blockquote 用） */
function collectRichText(element) {
  let out = '';
  for (const child of element.children || []) {
    if (child.type === 'text') {
      out += decodeEntities(child.text);
      continue;
    }
    if (child.type !== 'element') continue;
    if (child.tag === 'br') {
      out += '\n';
      continue;
    }
    if (child.tag === 'img' || child.tag === 'hr') continue;
    const isBlock =
      BLOCK_TAGS.has(child.tag) ||
      Boolean(HEADING_LEVEL_BY_TAG[child.tag]) ||
      child.tag === 'pre' || child.tag === 'ul' || child.tag === 'ol' ||
      child.tag === 'li' || child.tag === 'blockquote';
    out += isBlock ? `\n${collectRichText(child)}\n` : collectRichText(child);
  }
  return out;
}

/** HTML 表格 → Markdown 表格（td/th 以 | 拼接） */
function htmlTableToMarkdown(tableElement) {
  const rows = [];
  const collectRows = (node, depth) => {
    if (!node || depth > 6) return;
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      if (child.tag === 'tr') {
        const cells = [];
        for (const cellNode of child.children || []) {
          if (!cellNode || cellNode.type !== 'element') continue;
          if (cellNode.tag === 'td' || cellNode.tag === 'th') {
            const text = normalizeBlockText(collectInlineText(cellNode));
            cells.push(text.replace(/\n+/g, ' '));
          }
        }
        if (cells.some((cell) => cell)) rows.push(cells);
      } else {
        collectRows(child, depth + 1);
      }
    }
  };
  collectRows(tableElement, 0);
  return renderMarkdownTable(rows);
}

/** 在已去噪节点树上收集阅读块 */
function collectBlocks(rootElement, options) {
  const maxChars = Math.max(1000, Number(options.maxArticleChars) || DEFAULT_MAX_CHARS);
  const maxBlocks = options.bookMode ? 100000 : MAX_HTML_BLOCKS;
  const titleKey = normalizeTitleKey(options.articleTitle || '');
  const blocks = [];
  const state = { chars: 0, textChars: 0, truncated: false, stopped: false };
  let pending = '';

  function pushBlock(block) {
    if (state.stopped) return;
    if (blocks.length >= maxBlocks) {
      state.truncated = true;
      state.stopped = true;
      return;
    }
    if (block.kind === 'divider') {
      blocks.push(block);
      return;
    }
    let text = typeof block.text === 'string' ? block.text : '';
    if (isMeaninglessText(text)) return;
    const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;
    if (last && last.kind === block.kind && typeof last.text === 'string' && last.text === text) return;
    const remaining = maxChars - state.chars;
    if (remaining <= 0) {
      state.truncated = true;
      state.stopped = true;
      return;
    }
    if (text.length > remaining) {
      text = text.slice(0, remaining).replace(/\s+$/, '');
      state.truncated = true;
      state.stopped = true;
      if (!text) return;
    }
    const separator = blocks.length > 0 ? 2 : 0;
    state.chars += text.length + separator;
    state.textChars += text.length;
    blocks.push(Object.assign({}, block, { text }));
  }

  function flushParagraph() {
    const raw = pending;
    pending = '';
    if (state.stopped) return;
    const text = normalizeBlockText(raw);
    if (!text) return;
    pushBlock({ kind: 'paragraph', text });
  }

  function emitHeading(element, level) {
    const text = normalizeBlockText(collectInlineText(element)).replace(/\n+/g, ' ');
    if (!text) return;
    if (level === 1 && titleKey && normalizeTitleKey(text) === titleKey) return;
    if (text.length > 100) {
      pushBlock({ kind: 'paragraph', text });
      return;
    }
    const fontSize = firstInlineFontSize(element);
    if (fontSize !== null && fontSize <= 16.5 && text.length >= 24) {
      pushBlock({ kind: 'paragraph', text });
      return;
    }
    pushBlock({ kind: 'heading', level: Math.min(level, 3), text });
  }

  function emitListItem(element, listStack) {
    const ordered = listStack.length > 0 ? listStack[listStack.length - 1] : false;
    const text = normalizeBlockText(collectInlineText(element, { skipLists: true, skipListItems: true })).replace(/\n+/g, ' ');
    if (text) pushBlock({ kind: 'list-item', ordered: Boolean(ordered), text });
    for (const child of element.children || []) {
      if (child.type === 'element' && (child.tag === 'ul' || child.tag === 'ol')) walk(child, listStack);
    }
  }

  function emitQuote(element) {
    const text = normalizeBlockText(collectRichText(element));
    if (text) pushBlock({ kind: 'quote', text });
  }

  function emitCode(element) {
    let raw = collectRawText(element).replace(/\r\n?/g, '\n');
    raw = raw.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
    if (!raw.trim()) return;
    pushBlock({ kind: 'code', text: raw });
  }

  function walk(node, listStack) {
    if (state.stopped) return;
    for (const child of node.children || []) {
      if (state.stopped) return;
      if (child.type === 'text') {
        pending += decodeEntities(child.text);
        continue;
      }
      if (child.type !== 'element') continue;
      const tag = child.tag;
      if (tag === 'br') {
        pending += '\n';
        continue;
      }
      if (tag === 'hr') {
        flushParagraph();
        pushBlock({ kind: 'divider' });
        continue;
      }
      if (tag === 'img') {
        // HTML 正文里图片只做忽略（图片本身不支持 OCR，也没有必要进纯文本）
        flushParagraph();
        continue;
      }
      const headingLevel = HEADING_LEVEL_BY_TAG[tag];
      if (headingLevel) {
        flushParagraph();
        emitHeading(child, headingLevel);
        continue;
      }
      if (tag === 'pre') {
        flushParagraph();
        emitCode(child);
        continue;
      }
      if (tag === 'code') {
        if (INLINE_CODE_PARENT_TAGS.has(node.tag)) {
          pending += collectInlineText(child);
          continue;
        }
        flushParagraph();
        emitCode(child);
        continue;
      }
      if (tag === 'blockquote') {
        flushParagraph();
        emitQuote(child);
        continue;
      }
      if (tag === 'li') {
        flushParagraph();
        emitListItem(child, listStack);
        continue;
      }
      if (tag === 'ul' || tag === 'ol') {
        flushParagraph();
        walk(child, listStack.concat(tag === 'ol'));
        flushParagraph();
        continue;
      }
      if (tag === 'table') {
        flushParagraph();
        const tableText = htmlTableToMarkdown(child);
        if (tableText) pushBlock({ kind: 'paragraph', text: tableText });
        continue;
      }
      if (BLOCK_TAGS.has(tag)) {
        flushParagraph();
        walk(child, listStack);
        flushParagraph();
        continue;
      }
      walk(child, listStack);
    }
  }

  walk(rootElement, []);
  flushParagraph();
  return { blocks, truncated: state.truncated, textChars: state.textChars };
}

/** 选正文根：最大 article（≥400 字）→ main → body */
function selectContentRoot(cleanedRoot, bodyElement) {
  let bestArticle = null;
  let bestArticleLength = 0;
  for (const element of findElements(cleanedRoot, (node) => node.tag === 'article')) {
    const length = textLengthOf(element);
    if (length > bestArticleLength) {
      bestArticle = element;
      bestArticleLength = length;
    }
  }
  if (bestArticle && bestArticleLength >= 400) return { element: bestArticle, kind: 'article' };
  let bestMain = null;
  let bestMainLength = 0;
  for (const element of findElements(
    cleanedRoot,
    (node) => node.tag === 'main' || (getAttr(node, 'role') || '').toLowerCase() === 'main',
  )) {
    const length = textLengthOf(element);
    if (length > bestMainLength) {
      bestMain = element;
      bestMainLength = length;
    }
  }
  if (bestMain && bestMainLength >= 400) return { element: bestMain, kind: 'main' };
  return { element: bodyElement || cleanedRoot, kind: bodyElement ? 'body' : 'root' };
}

/** 读取文档级元信息：og:title / title / og:site_name / author */
function readDocumentMeta(documentRoot) {
  let ogTitle = '';
  let docTitle = '';
  let siteName = '';
  let byline = '';
  walkElements(documentRoot, (element) => {
    if (element.tag === 'title' && !docTitle) {
      docTitle = cleanTitle(textContent(element));
      return;
    }
    if (element.tag !== 'meta') return;
    const key = (getAttr(element, 'property') || getAttr(element, 'name') || '').trim().toLowerCase();
    if (!key) return;
    const content = collapseWhitespace(decodeEntities(getAttr(element, 'content')));
    if (!content) return;
    if (key === 'og:title' && !ogTitle) ogTitle = content;
    else if (key === 'og:site_name' && !siteName) siteName = content;
    else if ((key === 'author' || key === 'article:author' || key === 'byline') && !byline) byline = content;
  });
  return {
    title: ogTitle || docTitle || '',
    site: siteName,
    byline: byline ? byline.slice(0, 200) : '',
  };
}

/** 纯文本响应按空行拆段，包装成 <p> 复用块收集器 */
function collectPlainTextBlocks(plainText, options) {
  const text = typeof plainText === 'string' ? plainText.replace(/\r\n?/g, '\n') : '';
  const paragraphs = text.split(/\n{2,}/).filter((item) => item.trim());
  const root = {
    type: 'element',
    tag: '#root',
    attrs: Object.create(null),
    children: paragraphs.map((paragraph) => ({
      type: 'element',
      tag: 'p',
      attrs: Object.create(null),
      children: [{ type: 'text', text: paragraph }],
    })),
  };
  return collectBlocks(root, Object.assign({}, options, { articleTitle: '' }));
}

/** 统计块正文总长（divider 不计） */
function countBlockTextChars(blocks) {
  let total = 0;
  for (const block of blocks) {
    if (!block || block.kind === 'divider') continue;
    if (typeof block.text === 'string') total += block.text.length;
  }
  return total;
}

/** 裁掉正文开头混入的站点导航碎片（保守规则） */
function trimLeadingBoilerplate(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 6) return blocks;
  const scanLimit = Math.min(blocks.length - 1, 30);
  let contentIndex = -1;
  for (let index = 0; index < scanLimit; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    const text = normalizeBlockText(block.text || '');
    if (block.kind === 'heading' && (block.level || 3) <= 2 && text.length >= 2) {
      contentIndex = index;
      break;
    }
    if (block.kind === 'paragraph' && text.length >= 40) {
      contentIndex = index;
      break;
    }
  }
  if (contentIndex < 3) return blocks;
  let shortBlocks = 0;
  for (let index = 0; index < contentIndex; index += 1) {
    const block = blocks[index];
    if (!block) continue;
    if (block.kind === 'heading') return blocks;
    if (block.kind !== 'paragraph' && block.kind !== 'list-item' && block.kind !== 'quote') continue;
    if (normalizeBlockText(block.text || '').length >= 40) return blocks;
    shortBlocks += 1;
  }
  if (shortBlocks < 3) return blocks;
  if (blocks.length - contentIndex < 3) return blocks;
  return blocks.slice(contentIndex);
}

/** 去掉开头的作者卡/来源卡 */
function stripLeadingBylineCard(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 3) return blocks;
  const first = blocks[0];
  if (!first || first.kind !== 'paragraph') return blocks;
  const text = normalizeBlockText(first.text || '');
  if (!text || text.length > 80) return blocks;
  const firstLine = text.split('\n')[0].trim();
  if (!/^(原创|转载|作者|来源|文\s*[/·|]|本文为)/.test(firstLine)) return blocks;
  const hasContentAfter = blocks.slice(1, 6).some((block) => {
    if (!block || block.kind === 'divider') return false;
    return normalizeBlockText(block.text || '').length >= 20;
  });
  if (!hasContentAfter) return blocks;
  return blocks.slice(1);
}

/** 标题与正文首个 h1 归并（<title> 常带 “ - 站点” 后缀） */
function refineTitleWithHeading(title, blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return { title, blocks };
  const first = blocks[0];
  if (!first || first.kind !== 'heading' || (first.level || 3) > 2) return { title, blocks };
  const headingText = normalizeBlockText(first.text || '');
  if (!headingText) return { title, blocks };
  const rawTitle = typeof title === 'string' ? collapseWhitespace(title) : '';
  if (!rawTitle) return { title: headingText, blocks: blocks.slice(1) };
  if (rawTitle === headingText) return { title: headingText, blocks: blocks.slice(1) };
  const normalizedTitle = rawTitle.toLowerCase();
  const normalizedHeading = headingText.toLowerCase();
  if (!normalizedTitle.startsWith(normalizedHeading)) return { title, blocks };
  const suffix = rawTitle.slice(headingText.length);
  if (!/^\s*[-_|·—–]\s*\S.{0,24}$/.test(suffix)) return { title, blocks };
  return { title: headingText, blocks: blocks.slice(1) };
}

/** 把阅读块渲染为 Markdown/纯文本混合正文 */
function renderBlocksToText(blocks) {
  const parts = [];
  let previousKind = '';
  for (const block of blocks) {
    if (!block || block.kind === 'divider') continue;
    const text = typeof block.text === 'string' ? block.text.trim() : '';
    if (!text) continue;
    let rendered = text;
    if (block.kind === 'heading') {
      rendered = `${(block.level || 2) <= 2 ? '## ' : '### '}${text.replace(/\n+/g, ' ')}`;
    } else if (block.kind === 'list-item') {
      rendered = `${block.ordered ? '1. ' : '- '}${text.replace(/\n+/g, ' ')}`;
    } else if (block.kind === 'quote') {
      rendered = text.split('\n').map((line) => `> ${line}`).join('\n');
    } else if (block.kind === 'code') {
      rendered = '```\n' + text.replace(/\n{3,}/g, '\n\n') + '\n```';
    }
    const separator = block.kind === 'list-item' && previousKind === 'list-item' ? '\n' : '\n\n';
    if (parts.length > 0) parts.push(separator);
    parts.push(rendered);
    previousKind = block.kind;
  }
  return parts.join('');
}

/**
 * HTML → { title, blocks }（容错解析 + 去噪 + 正文根 + 块收集）。
 */
function htmlToDocument(html, maxChars, options = {}) {
  const source = typeof html === 'string' ? html : '';
  const documentRoot = parseHtmlDocument(source);
  const meta = readDocumentMeta(documentRoot);
  const cleanedRoot = options.bookMode ? cleanBookHtmlTree(documentRoot) : denoiseTree(documentRoot);
  const bodyElement = findFirstElement(cleanedRoot, (element) => element.tag === 'body');
  let title = meta.title;
  if (!title) {
    const firstHeading = findFirstElement(cleanedRoot, (element) => element.tag === 'h1');
    if (firstHeading) title = cleanTitle(textContent(firstHeading));
  }
  let blocks = [];
  let truncated = false;
  let rootKind = 'body';
  if (!bodyElement && !hasAnyElement(cleanedRoot)) {
    const collected = collectPlainTextBlocks(source, { maxArticleChars: maxChars });
    blocks = collected.blocks;
    truncated = collected.truncated;
    rootKind = 'text';
  } else {
    const selection = options.bookMode
      ? { element: bodyElement || cleanedRoot, kind: 'book-body' }
      : selectContentRoot(cleanedRoot, bodyElement);
    rootKind = selection.kind;
    const collected = collectBlocks(selection.element, {
      maxArticleChars: maxChars,
      articleTitle: title,
      bookMode: options.bookMode,
    });
    blocks = collected.blocks;
    truncated = collected.truncated;
  }
  if (!options.bookMode) {
    blocks = trimLeadingBoilerplate(blocks);
    blocks = stripLeadingBylineCard(blocks);
  }
  const refined = refineTitleWithHeading(title, blocks);
  return {
    title: cleanTitle(refined.title),
    blocks: refined.blocks,
    truncated,
    textChars: countBlockTextChars(refined.blocks),
    rootKind,
    site: meta.site,
    byline: meta.byline,
  };
}

/** HTML 抽取 */
function extractHtml(buffer, options) {
  const decoded = decodeHtmlBuffer(buffer, options.mime);
  const warnings = [];
  if (!decoded.text || !decoded.text.trim()) {
    return failResult({ format: 'html', error: 'HTML 文件内容为空，没有可提取的文本。', warnings });
  }
  if (decoded.encoding && !/^utf-?8$/i.test(decoded.encoding)) {
    warnings.push(`HTML 按 ${decoded.encoding} 编码解码`);
  }
  const document = htmlToDocument(decoded.text, options.maxChars, options);
  let text = renderBlocksToText(document.blocks);
  if (!text.trim()) {
    const fallback = decodeEntities(
      decoded.text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' '),
    );
    text = collapseWhitespace(fallback);
    if (text) warnings.push('HTML 结构异常，已退化为去标签纯文本');
  }
  if (document.truncated) warnings.push(`正文超出长度上限（${options.maxChars} 字符），已截断`);
  if (document.textChars > 0 && document.textChars < 400) warnings.push('正文内容较短，可能不是完整文章');
  const encoding = decoded.encoding;
  return finalizeResult({
    format: 'html',
    text,
    title: document.title,
    warnings,
    meta: {
      encoding,
      paragraphs: document.blocks.length,
      truncated: document.truncated,
      root: document.rootKind,
      site: document.site || '',
    },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// 纯文本 / Markdown / CSV / JSON / 源码
// ===========================================================================

/** 文本标题：Markdown 首个标题 → 首个非空行 */
function deriveTextTitle(text, format) {
  if (typeof text !== 'string' || !text) return '';
  if (format === 'markdown') {
    const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+)$/m.exec(text);
    if (heading) {
      const candidate = cleanTitle(heading[1].replace(/[ \t]+#+[ \t]*$/, ''));
      if (candidate) return candidate;
    }
  }
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const key of ['title', 'name', 'topic', 'subject', 'documentTitle', 'heading']) {
          const value = parsed[key];
          if (typeof value === 'string' && value.trim()) return cleanTitle(value, 160);
        }
        return '';
      }
    } catch {
      /* 非合法 JSON：继续按首行兜底 */
    }
  }
  const firstLine = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => collapseWhitespace(line))
    .find((line) => line.length > 0 && !/^[\s{}\[\],]+$/.test(line));
  return firstLine ? cleanTitle(firstLine, 160) : '';
}

/** 文本类格式抽取 */
function extractPlainText(buffer, format, options) {
  const decoded = decodeTextBuffer(buffer);
  if (decoded.binary) {
    return unsupportedResult(format, MESSAGES.binary, ['检测到大量不可打印字节，可能不是文本文件']);
  }
  const warnings = [];
  if (decoded.encoding === 'gb18030' || decoded.encoding === 'latin1' || /^utf-16/i.test(decoded.encoding)) {
    warnings.push(`按 ${decoded.encoding} 编码解码`);
  }
  let text = decoded.text;
  if (format === 'json') {
    try {
      const parsed = JSON.parse(text);
      text = JSON.stringify(parsed, null, 2);
    } catch {
      warnings.push('JSON 解析失败，已保留原始文本');
    }
  }
  const title = deriveTextTitle(text, format);
  const lines = text ? text.replace(/\r\n?/g, '\n').split('\n').length : 0;
  return finalizeResult({
    format,
    text,
    title,
    warnings,
    meta: { encoding: decoded.encoding, lines },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// RTF 抽取（分组 / 控制字 / \uN / \'hh / 重试编码）
// ===========================================================================

/** RTF 中整组跳过（输出无关）的目的地 */
const RTF_SKIP_DESTINATIONS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'objdata', 'object',
  'header', 'headerl', 'headerr', 'headerf',
  'footer', 'footerl', 'footerr', 'footerf',
  'footnote', 'annotation', 'atnid', 'atnauthor', 'atndate', 'comment',
  'listtable', 'listoverridetable', 'revtbl', 'generator', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'filetbl',
  'rsidtbl', 'fldinst', 'datafield', 'panose', 'fname', 'fontemb', 'fontfile',
  'blipuid', 'shppict', 'nonshppict', 'mmathPr', 'wgrffmtfilter', 'factoidname',
  'listpicture', 'field', 'xe', 'tc', 'txe', 'bkmkstart', 'bkmkend', 'upr',
  'template', 'private', 'mhtmltag', 'pgptbl', 'pn', 'pnseclvl', 'listtext',
]);

/** 把已抽出的字节解码成文本（UTF-8 → GB18030 → Latin1） */
function decodeRtfBytes(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0) return { text: '', encoding: '' };
  const utf8 = tryDecodeStrict(buffer, 'utf-8');
  if (utf8 !== null) return { text: stripControlChars(utf8), encoding: 'utf-8' };
  const gb = tryDecodeStrict(buffer, 'gb18030');
  if (gb !== null && looksTextual(gb)) return { text: stripControlChars(gb), encoding: 'gb18030' };
  const utf8Loose = tryDecodeLoose(buffer, 'utf-8') ?? buffer.toString('latin1');
  return { text: stripControlChars(utf8Loose), encoding: 'utf-8' };
}

/** 解析 RTF 标题（\info 组里的 \title） */
function parseRtfTitle(raw) {
  const match = /\\info\b[\s\S]{0,4000}?\\title\b\s*/.exec(raw);
  if (!match) return '';
  const start = match.index + match[0].length;
  let depth = 0;
  let end = start;
  for (; end < raw.length; end += 1) {
    const char = raw[end];
    if (char === '{') depth += 1;
    else if (char === '}') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  const titleBytes = [];
  const chunk = raw.slice(start, end);
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];
    if (char === '\\') {
      const next = chunk[index + 1];
      if (next === "'") {
        const value = parseInt(chunk.slice(index + 2, index + 4), 16);
        if (Number.isFinite(value)) titleBytes.push(value);
        index += 3;
      } else if (next === '\\' || next === '{' || next === '}') {
        titleBytes.push(next.charCodeAt(0));
        index += 1;
      } else if (next === 'u') {
        const unicodeMatch = /^u(-?\d+)\s?/.exec(chunk.slice(index + 1));
        if (unicodeMatch) {
          let code = Number(unicodeMatch[1]);
          if (Number.isFinite(code)) {
            if (code < 0) code += 65536;
            for (const byte of Buffer.from(String.fromCharCode(code), 'utf8')) titleBytes.push(byte);
          }
          index += unicodeMatch[0].length;
        } else {
          index += 1;
        }
      } else {
        const wordMatch = /^[a-zA-Z]+-?\d*\s?/.exec(chunk.slice(index + 1));
        if (wordMatch) index += wordMatch[0].length;
        else index += 1;
      }
    } else if (char !== '{' && char !== '}' && char !== '\r' && char !== '\n') {
      const code = char.charCodeAt(0);
      if (code < 0x80) titleBytes.push(code);
      else for (const byte of Buffer.from(char, 'utf8')) titleBytes.push(byte);
    }
  }
  return cleanTitle(decodeRtfBytes(titleBytes).text);
}

/** RTF 抽取 */
function extractRtf(buffer, options) {
  const raw = buffer.toString('latin1');
  const warnings = [];
  let title = parseRtfTitle(raw);
  const bytes = [];
  const groups = [];
  let state = { skip: false, uc: 1 };
  let ucSkipRemaining = 0;
  let index = 0;
  let paragraphCount = 0;

  function pushUtf8(text) {
    const encoded = Buffer.from(text, 'utf8');
    for (const byte of encoded) bytes.push(byte);
  }

  function pushCodePoint(code) {
    try {
      pushUtf8(String.fromCodePoint(code));
    } catch {
      /* 忽略非法码点 */
    }
  }

  while (index < raw.length) {
    const char = raw[index];
    if (char === '{') {
      groups.push({ skip: state.skip, uc: state.uc });
      index += 1;
      continue;
    }
    if (char === '}') {
      const previous = groups.pop();
      if (previous) state = previous;
      index += 1;
      continue;
    }
    if (char === '\\') {
      const next = raw[index + 1];
      if (next === undefined) break;
      if (next === '\\' || next === '{' || next === '}') {
        if (!state.skip) bytes.push(next.charCodeAt(0));
        index += 2;
        continue;
      }
      if (next === "'") {
        const value = parseInt(raw.slice(index + 2, index + 4), 16);
        index += 4;
        if (state.skip) continue;
        if (ucSkipRemaining > 0) {
          ucSkipRemaining -= 1;
          continue;
        }
        if (Number.isFinite(value)) bytes.push(value);
        continue;
      }
      if (next === '*') {
        state.skip = true;
        index += 2;
        continue;
      }
      if (next === '~') {
        if (!state.skip) bytes.push(0x20);
        index += 2;
        continue;
      }
      if (next === '-') {
        index += 2;
        continue;
      }
      if (next === '_') {
        if (!state.skip) bytes.push(0x2d);
        index += 2;
        continue;
      }
      if (next === '|' || next === ':' || next === ';' || next === '!') {
        index += 2;
        continue;
      }
      if (next === '\r' || next === '\n') {
        index += 2;
        continue;
      }
      if (/[a-zA-Z]/.test(next)) {
        let end = index + 1;
        while (end < raw.length && /[a-zA-Z]/.test(raw[end])) end += 1;
        const word = raw.slice(index + 1, end).toLowerCase();
        let param = '';
        if (raw[end] === '-' || /[0-9]/.test(raw[end] || '')) {
          const paramStart = end;
          if (raw[end] === '-') end += 1;
          while (/[0-9]/.test(raw[end] || '')) end += 1;
          param = raw.slice(paramStart, end);
        }
        if (raw[end] === ' ') end += 1;
        index = end;
        // ---- 控制字处理 ----
        if (RTF_SKIP_DESTINATIONS.has(word)) {
          state.skip = true;
          continue;
        }
        if (state.skip) continue;
        const numeric = param !== '' ? Number(param) : NaN;
        switch (word) {
          case 'uc':
            state.uc = Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 1;
            break;
          case 'u': {
            let code = Number.isFinite(numeric) ? Math.floor(numeric) : 0;
            if (code < 0) code += 65536;
            pushCodePoint(code);
            ucSkipRemaining = state.uc;
            break;
          }
          case 'par':
          case 'line':
          case 'sect':
          case 'row':
            bytes.push(0x0a);
            if (word === 'par') paragraphCount += 1;
            break;
          case 'page':
            bytes.push(0x0a);
            break;
          case 'tab':
          case 'cell':
            bytes.push(0x09);
            break;
          case 'emdash':
            pushUtf8('—');
            break;
          case 'endash':
            pushUtf8('–');
            break;
          case 'bullet':
            pushUtf8('•');
            break;
          case 'lquote':
            pushUtf8('‘');
            break;
          case 'rquote':
            pushUtf8('’');
            break;
          case 'ldblquote':
            pushUtf8('“');
            break;
          case 'rdblquote':
            pushUtf8('”');
            break;
          case 'emspace':
          case 'enspace':
          case 'qmspace':
            bytes.push(0x20);
            break;
          case 'bin':
            if (Number.isFinite(numeric) && numeric > 0) index += numeric;
            break;
          default:
            break;
        }
        continue;
      }
      index += 2;
      continue;
    }
    if (char === '\r' || char === '\n') {
      index += 1;
      continue;
    }
    if (state.skip) {
      index += 1;
      continue;
    }
    if (ucSkipRemaining > 0) {
      ucSkipRemaining -= 1;
      index += 1;
      continue;
    }
    const code = raw.charCodeAt(index);
    if (code < 0x80) bytes.push(code);
    else for (const byte of Buffer.from(raw[index], 'utf8')) bytes.push(byte);
    index += 1;
  }

  const decoded = decodeRtfBytes(bytes);
  if (decoded.encoding && decoded.encoding !== 'utf-8') warnings.push(`RTF 按 ${decoded.encoding} 编码解码`);
  if (!title) {
    const firstLine = decoded.text
      .split('\n')
      .map((line) => collapseWhitespace(line))
      .find((line) => line.length > 0);
    if (firstLine) title = cleanTitle(firstLine, 160);
  }
  return finalizeResult({
    format: 'rtf',
    text: decoded.text,
    title,
    warnings,
    meta: { encoding: decoded.encoding, paragraphs: paragraphCount },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// 容错 XML 解析器（DOCX/PPTX/XLSX/ODF/EPUB 共用；tag 统一小写）
// ===========================================================================

/** 解析 XML 文本为节点树（复用 HTML 的开标签解析器，属性名小写） */
function parseXml(xml) {
  const source = stripBom(typeof xml === 'string' ? xml : '');
  const root = { type: 'element', tag: '#root', attrs: Object.create(null), children: [] };
  const stack = [root];
  const length = source.length;
  let cursor = 0;

  function appendText(text) {
    if (!text) return;
    const decoded = decodeEntities(text);
    if (decoded) stack[stack.length - 1].children.push({ type: 'text', text: decoded });
  }

  while (cursor < length) {
    const lt = source.indexOf('<', cursor);
    if (lt === -1) {
      appendText(source.slice(cursor));
      break;
    }
    if (lt > cursor) appendText(source.slice(cursor, lt));
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      cursor = end === -1 ? length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      const text = source.slice(lt + 9, end === -1 ? length : end);
      if (text) stack[stack.length - 1].children.push({ type: 'text', text });
      cursor = end === -1 ? length : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      cursor = end === -1 ? length : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt + 2);
      if (end === -1) break;
      cursor = end + 1;
      continue;
    }
    if (source[lt + 1] === '/') {
      const end = source.indexOf('>', lt + 2);
      if (end === -1) break;
      const tag = source.slice(lt + 2, end).trim().split(/\s+/)[0];
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].tag === tag) {
          stack.length = depth;
          break;
        }
      }
      cursor = end + 1;
      continue;
    }
    const parsed = parseOpenTag(source, lt, true);
    if (!parsed) {
      appendText('<');
      cursor = lt + 1;
      continue;
    }
    const node = { type: 'element', tag: parsed.tag, attrs: parsed.attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!parsed.selfClosing) stack.push(node);
    cursor = parsed.end;
  }
  return root;
}

/** 读取 XML 属性 */
function xmlGetAttr(node, name) {
  if (!node || node.type !== 'element' || !node.attrs) return '';
  const value = node.attrs[name];
  return typeof value === 'string' ? value : '';
}

/** 直接子元素（可按 tag 过滤） */
function xmlChildren(node, tag) {
  if (!node || !Array.isArray(node.children)) return [];
  const wanted = tag ? String(tag).toLowerCase() : '';
  return node.children.filter(
    (child) => child && child.type === 'element' && (!wanted || String(child.tag).toLowerCase() === wanted),
  );
}

/** 递归查找第一个指定 tag 的元素 */
function xmlFind(node, tag) {
  if (!node || node.type !== 'element') return null;
  const wanted = String(tag).toLowerCase();
  if (String(node.tag).toLowerCase() === wanted) return node;
  for (const child of node.children || []) {
    if (!child || child.type !== 'element') continue;
    const found = xmlFind(child, tag);
    if (found) return found;
  }
  return null;
}

/** 递归查找所有指定 tag 的元素（文档顺序） */
function xmlFindAll(node, tag) {
  const result = [];
  const wanted = String(tag).toLowerCase();
  const visit = (current) => {
    if (!current || current.type !== 'element') return;
    if (String(current.tag).toLowerCase() === wanted) result.push(current);
    for (const child of current.children || []) {
      if (child && child.type === 'element') visit(child);
    }
  };
  visit(node);
  return result;
}

/** 元素内全部文本（含子孙，实体已解码） */
function xmlText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  let out = '';
  for (const child of node.children || []) out += xmlText(child);
  return out;
}

/** 取第一个直接子元素 */
function xmlFirstChild(node, tag) {
  const children = xmlChildren(node, tag);
  return children.length > 0 ? children[0] : null;
}

/** 拼接 ZIP 内相对路径（`..` 归一化；用于 rels/opf/container 解析） */
function resolveZipTarget(baseFile, target) {
  const raw = String(target || '').replace(/\\/g, '/');
  if (!raw) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw.replace(/^[a-z][a-z0-9+.-]*:\/*/i, '');
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');
  const baseParts = String(baseFile || '').split('/').filter(Boolean);
  baseParts.pop();
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join('/');
}

/** 剥离 URL/OPF href 的 fragment 与 query */
function stripHrefSuffix(href) {
  return String(href || '').split('#')[0].split('?')[0];
}

/** 读取 OOXML 的 docProps/core.xml 里的 dc:title */
function readCoreTitle(archive) {
  const core = readZipText(archive, 'docProps/core.xml');
  if (!core) return '';
  const match = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(core);
  if (!match) return '';
  const raw = match[1].replace(/<[^>]+>/g, ' ');
  return cleanTitle(decodeEntities(raw));
}

/** ZIP 系格式失败时的统一返回 */
function zipFailure(format, label, error) {
  const code = error && error.code ? String(error.code) : '';
  const detail = error && error.message ? String(error.message) : '未知错误';
  if (code === 'ZIP64') return unsupportedResult(format, MESSAGES.zip64, [detail]);
  if (code === 'ENCRYPTED') return unsupportedResult(format, MESSAGES.zipEncrypted, [detail]);
  if (code === 'METHOD') {
    return unsupportedResult(format, `该 ${label} 使用了不支持的 ZIP 压缩方式，无法解析。`, [detail]);
  }
  return unsupportedResult(format, `${label} 文件无法解析：${detail}`, [`文件可能损坏，或不是有效的 ${label} 文件`]);
}

/** 读取一组 `Relationship`（OOXML .rels）→ Map<rId, zip 内绝对路径> */
function readOoxmlRels(archive, relsPath, baseFile) {
  const map = new Map();
  let xml = null;
  try {
    xml = readZipText(archive, relsPath);
  } catch {
    xml = null;
  }
  if (!xml) return map;
  const root = parseXml(xml);
  for (const relationship of xmlFindAll(root, 'relationship')) {
    const id = xmlGetAttr(relationship, 'id');
    const target = xmlGetAttr(relationship, 'target');
    const mode = xmlGetAttr(relationship, 'targetmode').toLowerCase();
    if (!id || !target || mode === 'external') continue;
    map.set(id, resolveZipTarget(baseFile, target));
  }
  return map;
}

// ===========================================================================
// DOCX
// ===========================================================================

/** 段落内联内容收集（w:t / w:tab / w:br / 图片计数） */
function collectDocxParagraphText(paragraph, ctx) {
  const parts = [];
  const seenTextContainers = new Set();
  const walk = (node) => {
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      const tag = String(child.tag).toLowerCase();
      switch (tag) {
        case 'w:t':
          parts.push(xmlText(child));
          continue;
        case 'w:tab':
          parts.push('\t');
          continue;
        case 'w:br':
        case 'w:cr':
          parts.push('\n');
          continue;
        case 'w:nobreakhyphen':
          parts.push('-');
          continue;
        case 'w:softhyphen':
          continue;
        case 'w:drawing':
        case 'w:pict':
        case 'w:object':
          ctx.images += 1;
          continue;
        case 'w:deltext':
        case 'w:instrtext':
        case 'w:del':
        case 'w:movefrom':
        case 'w:ppr':
        case 'w:rpr':
          continue;
        default:
          walk(child);
      }
    }
  };
  walk(paragraph);
  return normalizeBlockText(parts.join(''));
}

/** DOCX 段落样式 → 标题级别（1~3），非标题返回 0 */
function docxHeadingLevel(paragraph) {
  const pPr = xmlFirstChild(paragraph, 'w:pPr');
  if (!pPr) return 0;
  const pStyle = xmlFirstChild(pPr, 'w:pStyle');
  if (!pStyle) return 0;
  const style = xmlGetAttr(pStyle, 'w:val').trim();
  if (!style) return 0;
  const lower = style.toLowerCase();
  const match = /^heading\s*([1-9])/.exec(lower) || /^标题\s*([1-9一二三])/.exec(style) || /^heading\s*$/.exec(lower);
  if (!match) {
    if (/^标题/.test(style) || /^title\s*[1-9]?$/i.test(style)) return 2;
    return 0;
  }
  let level = 2;
  const digit = match[1];
  if (digit) {
    if (digit === '一') level = 1;
    else if (digit === '二') level = 2;
    else if (digit === '三') level = 3;
    else level = parseInt(digit, 10) || 1;
  }
  return Math.min(3, Math.max(1, level));
}

/** 段落列表标记：w:numPr / List 系列样式 → '- ' / '1. '，非列表返回 '' */
function docxListMarker(paragraph) {
  const pPr = xmlFirstChild(paragraph, 'w:pPr');
  if (!pPr) return '';
  if (xmlFirstChild(pPr, 'w:numPr')) return '- ';
  const pStyle = xmlFirstChild(pPr, 'w:pStyle');
  const style = pStyle ? xmlGetAttr(pStyle, 'w:val').toLowerCase().replace(/[\s_-]+/g, '') : '';
  if (/^listnumber/.test(style)) return '1. ';
  if (/^listbullet/.test(style) || style === 'listparagraph') return '- ';
  return '';
}

/** DOCX 表格 → Markdown 表格文本；递归收集 w:tr/w:tc */
function renderDocxTable(table, ctx) {
  const rows = [];
  const collectRows = (node) => {
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      const tag = String(child.tag).toLowerCase();
      if (tag === 'w:tr') {
        const cells = [];
        const collectCells = (rowNode) => {
          for (const cellChild of rowNode.children || []) {
            if (!cellChild || cellChild.type !== 'element') continue;
            const cellTag = String(cellChild.tag).toLowerCase();
            if (cellTag === 'w:tc') cells.push(renderDocxCellText(cellChild));
            else if (cellTag === 'w:sdt' || cellTag === 'w:sdtcontent') collectCells(cellChild);
          }
        };
        collectCells(child);
        rows.push(cells);
      } else if (tag === 'w:tbl' || tag === 'w:sdt' || tag === 'w:sdtcontent' || tag === 'w:tblpr' || tag === 'w:tblgrid') {
        if (tag !== 'w:tbl') collectRows(child);
      }
    }
  };
  collectRows(table);
  ctx.tables += 1;
  return renderMarkdownTable(rows);
}

/** 单元格文本：内部段落合并为单行 */
function renderDocxCellText(cell) {
  const paragraphs = [];
  const collect = (node) => {
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      const tag = String(child.tag).toLowerCase();
      if (tag === 'w:p') {
        const text = collectDocxParagraphText(child, { images: 0 });
        if (text) paragraphs.push(text.replace(/\n+/g, ' '));
      } else if (tag === 'w:tbl') {
        const nested = renderDocxTable(child, { tables: 0 });
        if (nested) paragraphs.push(nested.replace(/\n+/g, ' '));
      } else if (tag === 'w:tcpr') {
        continue;
      } else {
        collect(child);
      }
    }
  };
  collect(cell);
  return paragraphs.join(' ').trim();
}

/** DOCX 正文容器遍历（保持段落/表格顺序；兼容 sdt/customXml 包装） */
function walkDocxContainer(node, ctx, depth) {
  if (depth > 12) return;
  for (const child of node.children || []) {
    if (!child || child.type !== 'element') continue;
    const tag = String(child.tag).toLowerCase();
    if (tag === 'w:p') {
      ctx.paragraphs += 1;
      const text = collectDocxParagraphText(child, ctx);
      const headingLevel = docxHeadingLevel(child);
      if (!text) continue;
      if (headingLevel > 0) {
        ctx.headings += 1;
        ctx.blocks.push(`${headingLevel <= 2 ? '## ' : '### '}${text.replace(/\n+/g, ' ')}`);
      } else {
        const marker = docxListMarker(child);
        if (marker) {
          ctx.blocks.push(`${marker}${text.replace(/\n+/g, ' ')}`);
          continue;
        }
        ctx.blocks.push(text);
      }
      continue;
    }
    if (tag === 'w:tbl') {
      const tableText = renderDocxTable(child, ctx);
      if (tableText) ctx.blocks.push(tableText);
      continue;
    }
    if (tag === 'w:sectpr' || tag === 'w:tblpr' || tag === 'w:trpr' || tag === 'w:tcpr') {
      continue;
    }
    walkDocxContainer(child, ctx, depth + 1);
  }
}

/** DOCX 抽取 */
function extractDocx(buffer, options) {
  let archive;
  try {
    archive = readZip(buffer);
  } catch (error) {
    return zipFailure('docx', 'DOCX', error);
  }
  const documentXml = readZipText(archive, 'word/document.xml');
  if (!documentXml) {
    return unsupportedResult('docx', 'DOCX 缺少 word/document.xml，文件可能损坏或不是有效的 DOCX。', []);
  }
  const root = parseXml(documentXml);
  const body = xmlFind(root, 'w:body') || root;
  const ctx = { blocks: [], paragraphs: 0, tables: 0, headings: 0, images: 0 };
  walkDocxContainer(body, ctx, 0);
  const warnings = [];
  if (ctx.images > 0) warnings.push(`已跳过 ${ctx.images} 张图片（仅提取文字）`);
  try {
    if (readZipText(archive, 'word/comments.xml')) warnings.push('已跳过文档批注（comments.xml 未提取）');
  } catch {
    /* 忽略 */
  }
  try {
    const footnotes = readZipText(archive, 'word/footnotes.xml');
    const endnotes = readZipText(archive, 'word/endnotes.xml');
    if (options.bookMode) {
      for (const [noteText, tag, heading] of [[footnotes, 'w:footnote', '脚注'], [endnotes, 'w:endnote', '尾注']]) {
        if (!noteText) continue;
        const noteBlocks = [];
        for (const note of xmlFindAll(parseXml(noteText), tag)) {
          const id = xmlGetAttr(note, 'w:id');
          if (/^-\d+$/.test(id) || /separator/i.test(xmlGetAttr(note, 'w:type'))) continue;
          const noteCtx = { blocks: [], paragraphs: 0, tables: 0, headings: 0, images: 0 };
          walkDocxContainer(note, noteCtx, 0);
          if (noteCtx.blocks.length) noteBlocks.push(`${id ? `[${id}] ` : ''}${noteCtx.blocks.join('\n\n')}`);
        }
        if (noteBlocks.length) ctx.blocks.push(`## ${heading}\n\n${noteBlocks.join('\n\n')}`);
      }
    } else if (footnotes || endnotes) {
      warnings.push('已跳过脚注/尾注内容');
    }
  } catch {
    /* 忽略 */
  }
  if (ctx.blocks.length === 0) {
    return unsupportedResult('docx', '未能从 DOCX 中提取出有效文本（文件可能损坏或内容为空）。', warnings);
  }
  let title = readCoreTitle(archive);
  if (!title) {
    const firstHeading = ctx.blocks.find((block) => block.startsWith('## ') || block.startsWith('### '));
    if (firstHeading) title = cleanTitle(firstHeading.replace(/^#{2,3}\s+/, ''));
  }
  const text = ctx.blocks.join('\n\n');
  return finalizeResult({
    format: 'docx',
    text,
    title,
    warnings,
    meta: {
      paragraphs: ctx.paragraphs,
      tables: ctx.tables,
      headings: ctx.headings,
      images: ctx.images,
    },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// PPTX
// ===========================================================================

/** 一个形状/文本框里所有 a:p 段落文本（a:t 拼接、a:br 换行） */
function collectPptxParagraphs(container) {
  const paragraphs = [];
  const paragraphText = (paragraph) => {
    const parts = [];
    const walk = (node) => {
      for (const child of node.children || []) {
        if (!child || child.type !== 'element') continue;
        const childTag = String(child.tag).toLowerCase();
        if (childTag === 'a:t') parts.push(xmlText(child));
        else if (childTag === 'a:br') parts.push('\n');
        else if (childTag === 'a:ppr' || childTag === 'a:endpararpr') continue;
        else walk(child);
      }
    };
    walk(paragraph);
    return normalizeBlockText(parts.join(''));
  };
  const visit = (node) => {
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      if (String(child.tag).toLowerCase() === 'a:p') {
        const text = paragraphText(child);
        if (text) paragraphs.push(text);
      } else {
        visit(child);
      }
    }
  };
  visit(container);
  return paragraphs;
}

/** PPTX 单页抽取：title 占位符 → 标题，其余形状段落 → 正文 */
function extractPptxSlide(root, slideIndex, ctx) {
  let title = '';
  const body = [];
  const visit = (node) => {
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      const childTag = String(child.tag).toLowerCase();
      if (childTag === 'p:sp') {
        const placeholder = xmlFind(child, 'p:ph');
        const placeholderType = placeholder ? (xmlGetAttr(placeholder, 'type') || '').toLowerCase() : '';
        const isTitle = placeholderType === 'title' || placeholderType === 'ctrTitle';
        const paragraphs = collectPptxParagraphs(child);
        if (isTitle && !title && paragraphs.length > 0) {
          title = cleanTitle(paragraphs.join(' '));
          const rest = paragraphs.slice(1);
          body.push(...rest);
        } else {
          body.push(...paragraphs);
        }
        continue;
      }
      if (childTag === 'p:graphicframe') {
        body.push(...collectPptxParagraphs(child));
        continue;
      }
      if (childTag === 'p:pic') {
        ctx.images += 1;
        continue;
      }
      visit(child);
    }
  };
  visit(root);
  const heading = title || `第 ${slideIndex + 1} 页`;
  const parts = [`## ${heading}`];
  if (body.length > 0) parts.push(body.join('\n\n'));
  return { title, text: parts.join('\n\n') };
}

/** PPTX 抽取 */
function extractPptx(buffer, options) {
  let archive;
  try {
    archive = readZip(buffer);
  } catch (error) {
    return zipFailure('pptx', 'PPTX', error);
  }
  const presentationXml = readZipText(archive, 'ppt/presentation.xml');
  if (!presentationXml) {
    return unsupportedResult('pptx', 'PPTX 缺少 ppt/presentation.xml，文件可能损坏或不是有效的 PPTX。', []);
  }
  const warnings = [];
  const root = parseXml(presentationXml);
  const rels = readOoxmlRels(archive, 'ppt/_rels/presentation.xml.rels', 'ppt/presentation.xml');
  const slidePaths = [];
  const slideIdList = xmlFind(root, 'p:sldIdLst');
  if (slideIdList) {
    for (const slideId of xmlChildren(slideIdList, 'p:sldId')) {
      const relId = xmlGetAttr(slideId, 'r:id');
      const path = relId ? rels.get(relId) : '';
      if (path) slidePaths.push(path);
    }
  }
  if (slidePaths.length === 0) {
    const fallback = zipEntryNames(archive, /^ppt\/slides\/slide(\d+)\.xml$/)
      .map((name) => ({ name, index: Number(/slide(\d+)\.xml$/.exec(name)[1]) || 0 }))
      .sort((a, b) => a.index - b.index)
      .map((item) => item.name);
    for (const name of fallback) slidePaths.push(name);
    if (slidePaths.length > 0) warnings.push('PPTX 关系表缺失，已按 slideN 文件名顺序读取');
  }
  const ctx = { images: 0 };
  const blocks = [];
  const slideTitles = [];
  const limit = Math.min(slidePaths.length, MAX_PDF_PAGES);
  for (let index = 0; index < limit; index += 1) {
    let slideXml = null;
    try {
      slideXml = readZipText(archive, slidePaths[index]);
    } catch {
      slideXml = null;
    }
    if (!slideXml) continue;
    const slide = extractPptxSlide(parseXml(slideXml), index, ctx);
    blocks.push(slide.text);
    if (slide.title) slideTitles.push(slide.title);
  }
  if (slidePaths.length > limit) warnings.push(`幻灯片数量超过上限（${MAX_PDF_PAGES}），已截断`);
  if (ctx.images > 0) warnings.push(`已跳过 ${ctx.images} 张图片（仅提取文字）`);
  let title = readCoreTitle(archive);
  if (!title) title = slideTitles[0] || '';
  if (blocks.length === 0) {
    return unsupportedResult('pptx', '未能从 PPTX 中提取出有效文本（文件可能损坏或没有幻灯片）。', warnings);
  }
  return finalizeResult({
    format: 'pptx',
    text: blocks.join('\n\n'),
    title,
    warnings,
    meta: { slides: blocks.length, images: ctx.images },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// XLSX
// ===========================================================================

/** A1 引用 → 列下标（0 基） */
function columnIndexFromRef(ref) {
  const match = /^([A-Za-z]+)/.exec(String(ref || ''));
  if (!match) return 0;
  const letters = match[1].toUpperCase();
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** 共享字符串表：<si> 内全部 <t>（富文本 run 拼接，忽略注音 rPh） */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const list = [];
  const root = parseXml(xml);
  for (const si of xmlFindAll(root, 'si')) {
    let text = '';
    const walk = (node) => {
      for (const child of node.children || []) {
        if (!child || child.type !== 'element') continue;
        const childTag = String(child.tag).toLowerCase();
        if (childTag === 'rph') continue;
        if (childTag === 't') text += xmlText(child);
        else walk(child);
      }
    };
    walk(si);
    list.push(text);
  }
  return list;
}

/** 单元格文本归一化 */
function normalizeCellText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/\n+/g, ' ')
    .trim();
}

/** 读取一个 <c> 的值 */
function readXlsxCellValue(cell, sharedStrings, ctx) {
  const type = xmlGetAttr(cell, 't');
  const formula = xmlFirstChild(cell, 'f');
  if (formula) ctx.formulas += 1;
  if (type === 'inlineStr') {
    const inline = xmlFirstChild(cell, 'is');
    return normalizeCellText(inline ? xmlText(inline) : '');
  }
  const valueNode = xmlFirstChild(cell, 'v');
  const raw = valueNode ? xmlText(valueNode) : '';
  if (type === 's') {
    const index = parseInt(raw, 10);
    return normalizeCellText(Number.isFinite(index) ? sharedStrings[index] || '' : '');
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : normalizeCellText(raw);
  if (type === 'e') return normalizeCellText(raw);
  if (type === 'str' || type === 'd') return normalizeCellText(raw);
  return normalizeCellText(raw);
}

/** 工作表数据 → 行数组 */
function parseSheetRows(sheetData, sharedStrings, ctx) {
  const rows = [];
  const rowNodes = xmlChildren(sheetData, 'row');
  const limit = Math.min(rowNodes.length, MAX_SHEET_ROWS);
  if (rowNodes.length > MAX_SHEET_ROWS) ctx.truncatedRows = true;
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const rowNode = rowNodes[rowIndex];
    const cells = [];
    let lastIndex = -1;
    for (const cell of xmlChildren(rowNode, 'c')) {
      const ref = xmlGetAttr(cell, 'r');
      const columnIndex = ref ? columnIndexFromRef(ref) : lastIndex + 1;
      if (columnIndex < 0) continue;
      if (columnIndex >= MAX_SHEET_COLS) {
        ctx.truncatedCols = true;
        continue;
      }
      lastIndex = columnIndex;
      const value = readXlsxCellValue(cell, sharedStrings, ctx);
      if (!value) continue;
      while (cells.length < columnIndex) cells.push('');
      cells[columnIndex] = value;
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.some((value) => value !== '')) rows.push(cells);
  }
  return rows;
}

/** XLSX 抽取 */
function extractXlsx(buffer, options) {
  let archive;
  try {
    archive = readZip(buffer);
  } catch (error) {
    return zipFailure('xlsx', 'XLSX', error);
  }
  let workbookXml = null;
  try {
    workbookXml = readZipText(archive, 'xl/workbook.xml');
  } catch (error) {
    return zipFailure('xlsx', 'XLSX', error);
  }
  if (!workbookXml) {
    return unsupportedResult('xlsx', 'XLSX 缺少 xl/workbook.xml，文件可能损坏或不是有效的 XLSX。', []);
  }
  const warnings = [];
  const workbookRoot = parseXml(workbookXml);
  const rels = readOoxmlRels(archive, 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml');
  const sheets = [];
  for (const sheetNode of xmlFindAll(workbookRoot, 'sheet')) {
    const name = xmlGetAttr(sheetNode, 'name') || `Sheet${sheets.length + 1}`;
    const relId = xmlGetAttr(sheetNode, 'r:id');
    let path = relId ? rels.get(relId) : '';
    if (path && !archive.entries.has(path)) path = '';
    sheets.push({ name, path, relId });
  }
  if (sheets.some((sheet) => !sheet.path)) {
    const worksheetNames = zipEntryNames(archive, /^xl\/worksheets\/sheet\d+\.xml$/)
      .map((name) => ({ name, index: Number(/sheet(\d+)\.xml$/.exec(name)[1]) || 0 }))
      .sort((a, b) => a.index - b.index)
      .map((item) => item.name);
    sheets.forEach((sheet, index) => {
      if (!sheet.path) sheet.path = worksheetNames[index] || '';
    });
    if (worksheetNames.length > 0 && !rels.size) warnings.push('XLSX 关系表缺失，已按 sheetN 文件名顺序读取工作表');
  }
  let sharedStrings = [];
  try {
    sharedStrings = parseSharedStrings(readZipText(archive, 'xl/sharedStrings.xml'));
  } catch {
    sharedStrings = [];
  }
  const ctx = { formulas: 0, truncatedRows: false, truncatedCols: false };
  const blocks = [];
  let usedSheets = 0;
  for (const sheet of sheets) {
    if (!sheet.path) continue;
    let sheetXml = null;
    try {
      sheetXml = readZipText(archive, sheet.path);
    } catch {
      sheetXml = null;
    }
    if (!sheetXml) continue;
    const sheetRoot = parseXml(sheetXml);
    const sheetData = xmlFind(sheetRoot, 'sheetData');
    if (!sheetData) continue;
    const rows = parseSheetRows(sheetData, sharedStrings, ctx);
    if (rows.length === 0) continue;
    const table = renderMarkdownTable(rows);
    if (!table) continue;
    blocks.push(`## 工作表：${sheet.name}\n\n${table}`);
    usedSheets += 1;
  }
  if (ctx.formulas > 0) warnings.push(`已忽略 ${ctx.formulas} 个公式，仅保留缓存值`);
  if (ctx.truncatedRows) warnings.push(`部分工作表行数超过上限（${MAX_SHEET_ROWS} 行），已截断`);
  if (ctx.truncatedCols) warnings.push(`部分列超过上限（${MAX_SHEET_COLS} 列），已忽略`);
  if (blocks.length === 0) {
    return unsupportedResult('xlsx', '未能从 XLSX 中提取出任何单元格文本（文件可能损坏或为空表）。', warnings);
  }
  let title = readCoreTitle(archive);
  if (!title && sheets.length > 0) title = sheets[0].name;
  return finalizeResult({
    format: 'xlsx',
    text: blocks.join('\n\n'),
    title,
    warnings,
    meta: { sheets: usedSheets, sharedStrings: sharedStrings.length },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// ODT / ODS / ODP
// ===========================================================================

/** ODF 内联文本（text:tab / text:s / text:line-break / text:p 换行） */
function odfInlineText(node) {
  let out = '';
  const walk = (current) => {
    for (const child of current.children || []) {
      if (child.type === 'text') {
        out += child.text || '';
        continue;
      }
      if (child.type !== 'element') continue;
      switch (child.tag) {
        case 'text:s': {
          const count = parseInt(xmlGetAttr(child, 'text:c'), 10);
          out += ' '.repeat(Number.isFinite(count) && count > 0 ? Math.min(count, 200) : 1);
          break;
        }
        case 'text:tab':
          out += '\t';
          break;
        case 'text:line-break':
          out += '\n';
          break;
        case 'text:p':
        case 'text:h':
          out += `\n${odfInlineText(child)}\n`;
          break;
        case 'office:annotation':
        case 'text:note':
        case 'draw:image':
        case 'draw:frame':
          break;
        default:
          walk(child);
      }
    }
  };
  walk(node);
  return out;
}

/** ODF 表格 → Markdown 表格 */
function renderOdfTable(tableNode, blocks, ctx) {
  const rows = [];
  const collectRows = (node) => {
    for (const child of node.children || []) {
      if (!child || child.type !== 'element') continue;
      if (child.tag === 'table:table-row') {
        const cells = [];
        for (const cellNode of child.children || []) {
          if (!cellNode || cellNode.type !== 'element') continue;
          if (cellNode.tag === 'table:table-cell' || cellNode.tag === 'table:covered-table-cell') {
            const paragraphs = [];
            const collectParagraphs = (cell) => {
              for (const cellChild of cell.children || []) {
                if (!cellChild || cellChild.type !== 'element') continue;
                if (cellChild.tag === 'text:p' || cellChild.tag === 'text:h') {
                  const text = normalizeBlockText(odfInlineText(cellChild));
                  if (text) paragraphs.push(text.replace(/\n+/g, ' '));
                } else {
                  collectParagraphs(cellChild);
                }
              }
            };
            collectParagraphs(cellNode);
            cells.push(paragraphs.join(' '));
          }
        }
        rows.push(cells);
      } else if (child.tag !== 'table:table-column' && child.tag !== 'table:table-columns') {
        collectRows(child);
      }
    }
  };
  collectRows(tableNode);
  ctx.tables += 1;
  const table = renderMarkdownTable(rows);
  if (table) blocks.push(table);
  return table;
}

/** ODF 正文遍历 */
function walkOdfContainer(node, blocks, ctx, format) {
  for (const child of node.children || []) {
    if (!child || child.type !== 'element') continue;
    const tag = child.tag;
    if (tag === 'text:h') {
      const text = normalizeBlockText(odfInlineText(child));
      if (text) {
        const level = parseInt(xmlGetAttr(child, 'text:outline-level'), 10);
        const safeLevel = Number.isFinite(level) && level > 0 ? Math.min(level, 3) : 1;
        blocks.push(`${safeLevel <= 2 ? '## ' : '### '}${text.replace(/\n+/g, ' ')}`);
        ctx.headings += 1;
      }
      continue;
    }
    if (tag === 'text:p') {
      const text = normalizeBlockText(odfInlineText(child));
      if (text) {
        blocks.push(text);
        ctx.paragraphs += 1;
      }
      continue;
    }
    if (tag === 'table:table') {
      if (format === 'ods') {
        const name = xmlGetAttr(child, 'table:name');
        blocks.push(`## 工作表：${cleanTitle(name || `表${ctx.tables + 1}`) || `表${ctx.tables + 1}`}`);
      }
      renderOdfTable(child, blocks, ctx);
      continue;
    }
    if (
      tag === 'office:annotation' ||
      tag === 'office:forms' ||
      tag === 'text:tracked-changes' ||
      tag === 'office:binary-data' ||
      tag === 'draw:image'
    ) {
      continue;
    }
    if (tag === 'draw:page') {
      if (format === 'odp') {
        ctx.pages += 1;
        blocks.push(`## 第 ${ctx.pages} 页`);
      }
      walkOdfContainer(child, blocks, ctx, format);
      continue;
    }
    walkOdfContainer(child, blocks, ctx, format);
  }
}

/** ODF 标题（meta.xml 的 dc:title） */
function readOdfMetaTitle(metaXml) {
  if (!metaXml) return '';
  const match = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(metaXml);
  if (!match) return '';
  return cleanTitle(decodeEntities(match[1].replace(/<[^>]+>/g, ' ')));
}

/** ODT/ODS/ODP 抽取 */
function extractOdf(buffer, format, options) {
  let archive;
  try {
    archive = readZip(buffer);
  } catch (error) {
    return zipFailure(format, format.toUpperCase(), error);
  }
  const contentXml = readZipText(archive, 'content.xml');
  if (!contentXml) {
    return unsupportedResult(format, `${format.toUpperCase()} 缺少 content.xml，文件可能损坏或不是有效的 OpenDocument 文件。`, []);
  }
  const root = parseXml(contentXml);
  const blocks = [];
  const ctx = { paragraphs: 0, tables: 0, headings: 0, pages: 0 };
  const body = xmlFind(root, 'office:body') || root;
  walkOdfContainer(body, blocks, ctx, format);
  if (blocks.length === 0) {
    return unsupportedResult(format, `未能从 ${format.toUpperCase()} 中提取出有效文本（文件可能损坏或内容为空）。`, []);
  }
  const warnings = [];
  let title = '';
  try {
    title = readOdfMetaTitle(readZipText(archive, 'meta.xml'));
  } catch {
    title = '';
  }
  if (!title) {
    const firstHeading = blocks.find((block) => block.startsWith('## ') || block.startsWith('### '));
    if (firstHeading) title = cleanTitle(firstHeading.replace(/^#{2,3}\s+/, ''));
  }
  if (!title) {
    const firstParagraph = blocks.find((block) => !block.startsWith('#') && !block.startsWith('|'));
    if (firstParagraph) title = cleanTitle(firstParagraph, 160);
  }
  return finalizeResult({
    format,
    text: blocks.join('\n\n'),
    title,
    warnings,
    meta: {
      paragraphs: ctx.paragraphs,
      tables: ctx.tables,
      headings: ctx.headings,
      pages: ctx.pages,
    },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// EPUB
// ===========================================================================

/** Canonicalise EPUB namespace prefixes locally; OOXML/ODF keep their existing XML tags. */
function parseEpubXml(xml) {
  const root = parseXml(xml);
  const namespaces = new Map([
    ['urn:oasis:names:tc:opendocument:xmlns:container', ''],
    ['http://www.idpf.org/2007/opf', ''],
    ['http://purl.org/dc/elements/1.1/', 'dc:'],
  ]);
  function visit(node, inherited) {
    if (!node || node.type !== 'element') return;
    const scope = { ...inherited };
    for (const [name, value] of Object.entries(node.attrs || {})) {
      if (name === 'xmlns') scope[''] = value;
      else if (name.startsWith('xmlns:')) scope[name.slice(6)] = value;
    }
    const separator = node.tag.indexOf(':');
    const prefix = separator < 0 ? '' : node.tag.slice(0, separator).toLowerCase();
    const local = separator < 0 ? node.tag : node.tag.slice(separator + 1);
    const uri = scope[prefix];
    if (uri) node.tag = namespaces.has(uri) ? namespaces.get(uri) + local : '#foreign:' + local;
    // Keep unnamespaced legacy packages readable; declared foreign vocabularies never become OPF items.
    for (const child of node.children || []) visit(child, scope);
  }
  visit(root, {});
  return root;
}

/** EPUB 抽取 */
function extractEpub(buffer, options) {
  let archive;
  try {
    archive = readZip(buffer);
  } catch (error) {
    return zipFailure('epub', 'EPUB', error);
  }
  let opfPath = '';
  try {
    const containerXml = readZipText(archive, 'META-INF/container.xml');
    if (containerXml) {
      const containerRoot = parseEpubXml(containerXml);
      const rootfile = xmlFind(containerRoot, 'rootfile');
      if (rootfile) opfPath = xmlGetAttr(rootfile, 'full-path');
    }
  } catch {
    opfPath = '';
  }
  if (!opfPath) {
    const opfCandidates = zipEntryNames(archive, /\.opf$/i);
    if (opfCandidates.length > 0) opfPath = opfCandidates[0];
  }
  if (!opfPath || !archive.entries.has(opfPath)) {
    return unsupportedResult('epub', 'EPUB 缺少 OPF 包文件（META-INF/container.xml 指向的 .opf 不存在），文件可能损坏。', []);
  }
  const opfXml = readZipText(archive, opfPath);
  if (!opfXml) return unsupportedResult('epub', 'EPUB 的 OPF 包文件无法读取。', []);
  const opfRoot = parseEpubXml(opfXml);
  const warnings = [];
  let bookTitle = '';
  const titleNode = xmlFind(opfRoot, 'dc:title');
  if (titleNode) bookTitle = cleanTitle(xmlText(titleNode));
  const manifest = new Map();
  for (const item of xmlFindAll(opfRoot, 'item')) {
    const id = xmlGetAttr(item, 'id');
    const href = xmlGetAttr(item, 'href');
    if (!id || !href) continue;
    manifest.set(id, {
      id,
      href: stripHrefSuffix(href),
      mediaType: xmlGetAttr(item, 'media-type') || '',
      path: resolveZipTarget(opfPath, stripHrefSuffix(href)),
    });
  }
  const spineNodes = xmlFindAll(opfRoot, 'itemref');
  // EPUB 2 publishers may identify an image-only cover through the OPF guide.
  const guideCovers = new Set(xmlFindAll(xmlFind(opfRoot, 'guide'), 'reference')
    .filter(reference => xmlGetAttr(reference, 'type').trim().toLowerCase() === 'cover')
    .map(reference => resolveZipTarget(opfPath, stripHrefSuffix(xmlGetAttr(reference, 'href')))));
  const chapterPaths = [];
  for (const itemref of spineNodes) {
    const idref = xmlGetAttr(itemref, 'idref');
    const item = manifest.get(idref);
    if (item) chapterPaths.push(item);
  }
  if (chapterPaths.length === 0) {
    for (const item of manifest.values()) {
      if (/\.x?html?$/i.test(item.path)) chapterPaths.push(item);
    }
  }
  if (chapterPaths.length === 0) {
    return unsupportedResult('epub', 'EPUB 章节索引中没有找到可识别的正文文件，请检查 OPF 的 manifest 和 spine。尚未调用模型。', warnings);
  }
  const chapters = [];
  const chapterLimit = options.bookMode ? 10000 : MAX_EPUB_CHAPTERS;
  let bookChars = 0;
  let contentIncomplete = false;
  let truncated = false;
  for (let pathIndex = 0; pathIndex < chapterPaths.length; pathIndex += 1) {
    const item = chapterPaths[pathIndex];
    if (chapters.length >= chapterLimit || options.bookMode && bookChars >= options.maxChars) {
      truncated = true;
      contentIncomplete = true;
      break;
    }
    if (!/html|xhtml|xml/i.test(item.mediaType) && !/\.x?html?$/i.test(item.path)) continue;
    let data = null;
    try {
      data = readZipEntryData(archive, item.path);
    } catch {
      data = null;
    }
    if (!data) {
      warnings.push(`已跳过无法读取的章节：${item.path}`);
      contentIncomplete = true;
      continue;
    }
    const html = decodeHtmlBuffer(data).text;
    if (!html || !html.trim()) continue;
    const document = htmlToDocument(html, options.maxChars, options);
    if (options.bookMode && !document.blocks.length && document.title) {
      const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] || '';
      const bodyText = decodeEntities(body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ''));
      if (/<h[12]\b/i.test(body) && !/<(?:img|image|svg|object|video|canvas|math)\b/i.test(body)
        && normalizeTitleKey(bodyText) === normalizeTitleKey(document.title)) {
        // htmlToDocument folds a lone heading into title. Preserve that structural page;
        // the reading selector can skip it without claiming that readable text was lost.
        document.blocks = [{ kind: 'heading', level: 2, text: document.title }];
      }
    }
    if (options.bookMode && document.truncated) {
      warnings.push(`章节文本超出解析上限，部分内容未抽取：${item.path}`);
      contentIncomplete = true;
    }
    if (!document.blocks || document.blocks.length === 0) {
      if (options.bookMode) {
        const explicitCover = guideCovers.has(item.path)
          || /<meta\b(?=[^>]*\bname\s*=\s*["']calibre:cover["'])(?=[^>]*\bcontent\s*=\s*["']true["'])[^>]*>/i.test(html)
          || /<img\b[^>]*\balt\s*=\s*["'](?:cover(?: image)?|封面)["']/i.test(html);
        const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1];
        const blank = body != null && !/<(?:img|image|svg|object|video|canvas|math)\b/i.test(body)
          && !body.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').replace(/&(?:nbsp|#160|#xa0);/gi, '').trim();
        if (explicitCover) warnings.push(`已略过封面页：${item.path}`);
        else if (blank) warnings.push(`已略过空白页：${item.path}`);
        else { warnings.push(`章节仅含图片或无可读文字，未抽取：${item.path}`); contentIncomplete = true; }
      }
      continue;
    }
    let blocks = document.blocks;
    // 章节标题优先用 xhtml 的 <title>/首个 h1（htmlToDocument 已把与标题重复的 h1 去掉）
    let chapterTitle = cleanTitle(document.title);
    // Publishers sometimes repeat the book title in every XHTML <title>.
    // Use the actual chapter heading so copyright/preface pages retain their identity.
    if (chapterTitle && bookTitle && normalizeTitleKey(chapterTitle) === normalizeTitleKey(bookTitle)) {
      const headingIndex = blocks.findIndex((block) => block.kind === 'heading' && (block.level || 3) <= 2);
      if (headingIndex >= 0) {
        chapterTitle = cleanTitle(normalizeBlockText(blocks[headingIndex].text || ''));
        blocks = blocks.filter((_block, index) => index !== headingIndex);
      }
    }
    if (chapterTitle) {
      blocks = blocks.filter(
        (block) => !(block.kind === 'heading' && cleanTitle(normalizeBlockText(block.text || '')) === chapterTitle),
      );
    } else {
      const headingIndex = blocks.findIndex((block) => block.kind === 'heading' && (block.level || 3) <= 2);
      if (headingIndex >= 0) {
        chapterTitle = cleanTitle(normalizeBlockText(blocks[headingIndex].text || ''));
        blocks = blocks.filter((_block, index) => index !== headingIndex);
      }
    }
    const syntheticTitle = !chapterTitle;
    if (!chapterTitle) chapterTitle = options.bookMode ? `第 ${chapters.length + 1} 部分` : `第 ${chapters.length + 1} 章`;
    const body = renderBlocksToText(blocks);
    if (!body && !chapterTitle) continue;
    chapters.push({ title: chapterTitle, text: body, syntheticTitle });
    bookChars += chapterTitle.length + body.length + 8;
  }
  if (chapters.length === 0) {
    const message = warnings.some(warning => /无法读取的章节/.test(warning))
      ? 'EPUB 正文文件无法读取或没有可读文字，请检查章节路径及文件完整性。尚未调用模型。'
      : 'EPUB 正文页中未提取到可读文字；纯图片页面需先识别文字。尚未调用模型。';
    return unsupportedResult('epub', message, warnings);
  }
  if (truncated) warnings.push(options.bookMode
    ? `书籍抽取达到安全上限（${chapterLimit} 个 spine 条目或 ${options.maxChars} 字符），其余内容未抽取；原件仍保留`
    : `章节数量超过上限（${MAX_EPUB_CHAPTERS} 章），已截断`);
  const blocks = chapters.map((chapter) => {
    const block = `## ${chapter.title}\n\n${chapter.text}`.trim();
    return options.bookMode ? normalizeOutputText(block, options.maxChars, warnings, false).text : block;
  });
  const bookSections = [];
  let bookOffset = 0;
  if (options.bookMode) for (let index = 0; index < blocks.length; index += 1) {
    const endChar = bookOffset + blocks[index].length + (index < blocks.length - 1 ? 2 : 0);
    bookSections.push({ title: chapters[index].title, startChar: bookOffset, endChar, syntheticTitle: chapters[index].syntheticTitle });
    bookOffset = endChar;
  }
  return finalizeResult({
    format: 'epub',
    text: blocks.join('\n\n'),
    title: bookTitle || chapters[0].title,
    warnings,
    meta: {
      chapters: chapters.length, opf: opfPath,
      ...(options.bookMode ? { bookSections, contentIncomplete, truncated: truncated || contentIncomplete } : {}),
    },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// PDF 自写解析器
//   对象表正则扫描（不依赖 xref）→ FlateDecode/ASCIIHexDecode/ASCII85Decode/
//   RunLengthDecode → 页面树 → Font/ToUnicode CMap → 内容流文本算子
// ===========================================================================

const PDF_WHITESPACE_CODES = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);

/** PDF 内容流/字典里的字面量字符串 `( ... )` → 字节（处理转义/八进制） */
function readPdfLiteralString(source, start) {
  const bytes = [];
  let cursor = start + 1;
  let depth = 1;
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (code === 0x5c) {
      const next = source.charCodeAt(cursor + 1);
      if (next === 0x6e) { bytes.push(0x0a); cursor += 2; }
      else if (next === 0x72) { bytes.push(0x0d); cursor += 2; }
      else if (next === 0x74) { bytes.push(0x09); cursor += 2; }
      else if (next === 0x62) { bytes.push(0x08); cursor += 2; }
      else if (next === 0x66) { bytes.push(0x0c); cursor += 2; }
      else if (next === 0x28 || next === 0x29 || next === 0x5c) { bytes.push(next & 0xff); cursor += 2; }
      else if (next === 0x0a) { cursor += 2; }
      else if (next === 0x0d) { cursor += source.charCodeAt(cursor + 2) === 0x0a ? 3 : 2; }
      else if (next >= 0x30 && next <= 0x37) {
        let digits = '';
        let position = cursor + 1;
        while (position < source.length && digits.length < 3) {
          const digit = source.charCodeAt(position);
          if (digit < 0x30 || digit > 0x37) break;
          digits += source[position];
          position += 1;
        }
        bytes.push(parseInt(digits, 8) & 0xff);
        cursor = position;
      } else {
        bytes.push(next & 0xff);
        cursor += 2;
      }
      continue;
    }
    if (code === 0x28) {
      depth += 1;
      bytes.push(0x28);
      cursor += 1;
      continue;
    }
    if (code === 0x29) {
      depth -= 1;
      if (depth === 0) return { bytes: Buffer.from(bytes), end: cursor + 1 };
      bytes.push(0x29);
      cursor += 1;
      continue;
    }
    bytes.push(code & 0xff);
    cursor += 1;
  }
  return { bytes: Buffer.from(bytes), end: cursor };
}

/** PDF 十六进制字符串 `<...>` → 字节 */
function readPdfHexString(source, start) {
  let cursor = start + 1;
  let hex = '';
  while (cursor < source.length && source[cursor] !== '>') {
    const char = source[cursor];
    if (/[0-9A-Fa-f]/.test(char)) hex += char;
    cursor += 1;
  }
  if (hex.length % 2 === 1) hex += '0';
  return { bytes: Buffer.from(hex, 'hex'), end: cursor + 1 };
}

/** PDF 内容流 tokenizer */
function tokenizePdfContent(source) {
  const tokens = [];
  let cursor = 0;
  const length = source.length;
  while (cursor < length) {
    const code = source.charCodeAt(cursor);
    if (PDF_WHITESPACE_CODES.has(code)) {
      cursor += 1;
      continue;
    }
    if (code === 0x25) {
      while (cursor < length && source.charCodeAt(cursor) !== 0x0a && source.charCodeAt(cursor) !== 0x0d) cursor += 1;
      continue;
    }
    if (code === 0x28) {
      const result = readPdfLiteralString(source, cursor);
      tokens.push({ type: 'string', bytes: result.bytes });
      cursor = result.end;
      continue;
    }
    if (code === 0x3c) {
      if (source.charCodeAt(cursor + 1) === 0x3c) {
        tokens.push({ type: 'dictStart' });
        cursor += 2;
        continue;
      }
      const result = readPdfHexString(source, cursor);
      tokens.push({ type: 'string', bytes: result.bytes });
      cursor = result.end;
      continue;
    }
    if (code === 0x3e) {
      if (source.charCodeAt(cursor + 1) === 0x3e) cursor += 2;
      else cursor += 1;
      continue;
    }
    if (code === 0x5b) {
      tokens.push({ type: 'arrayStart' });
      cursor += 1;
      continue;
    }
    if (code === 0x5d) {
      tokens.push({ type: 'arrayEnd' });
      cursor += 1;
      continue;
    }
    if (code === 0x2f) {
      let end = cursor + 1;
      while (end < length) {
        const next = source.charCodeAt(end);
        if (
          PDF_WHITESPACE_CODES.has(next) || next === 0x28 || next === 0x29 || next === 0x3c ||
          next === 0x3e || next === 0x5b || next === 0x5d || next === 0x7b || next === 0x7d ||
          next === 0x2f || next === 0x25
        ) {
          break;
        }
        end += 1;
      }
      tokens.push({ type: 'name', value: source.slice(cursor + 1, end) });
      cursor = end;
      continue;
    }
    if (code === 0x7b || code === 0x7d) {
      cursor += 1;
      continue;
    }
    let end = cursor;
    while (end < length) {
      const next = source.charCodeAt(end);
      if (
        PDF_WHITESPACE_CODES.has(next) || next === 0x28 || next === 0x29 || next === 0x3c ||
        next === 0x3e || next === 0x5b || next === 0x5d || next === 0x7b || next === 0x7d ||
        next === 0x2f || next === 0x25
      ) {
        break;
      }
      end += 1;
    }
    if (end === cursor) {
      cursor += 1;
      continue;
    }
    const word = source.slice(cursor, end);
    cursor = end;
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ type: 'number', value: parseFloat(word) });
    else tokens.push({ type: 'op', value: word });
  }
  return tokens;
}

/** ASCIIHexDecode */
function decodePdfAsciiHex(buffer) {
  const text = buffer.toString('latin1');
  const out = [];
  let high = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '>') break;
    const code = char.charCodeAt(0);
    let digit = -1;
    if (code >= 48 && code <= 57) digit = code - 48;
    else if (code >= 65 && code <= 70) digit = code - 55;
    else if (code >= 97 && code <= 102) digit = code - 87;
    else continue;
    if (high < 0) high = digit;
    else {
      out.push(high * 16 + digit);
      high = -1;
    }
  }
  if (high >= 0) out.push(high * 16);
  return Buffer.from(out);
}

/** ASCII85Decode */
function decodePdfAscii85(buffer) {
  const text = buffer.toString('latin1');
  const out = [];
  let tuple = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '~') break;
    if (char === 'z' && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    const code = char.charCodeAt(0) - 33;
    if (code < 0 || code > 84) continue;
    tuple.push(code);
    if (tuple.length === 5) {
      let value = 0;
      for (const digit of tuple) value = value * 85 + digit;
      out.push((value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255);
      tuple = [];
    }
  }
  if (tuple.length > 0) {
    const count = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let value = 0;
    for (const digit of tuple) value = value * 85 + digit;
    const bytes = [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
    for (let index = 0; index < count - 1; index += 1) out.push(bytes[index]);
  }
  return Buffer.from(out);
}

/** RunLengthDecode */
function decodePdfRunLength(buffer) {
  const out = [];
  let index = 0;
  while (index < buffer.length) {
    const length = buffer[index];
    index += 1;
    if (length === 128) break;
    if (length < 128) {
      for (let offset = 0; offset <= length && index < buffer.length; offset += 1) out.push(buffer[index + offset]);
      index += length + 1;
    } else {
      const count = 257 - length;
      const value = index < buffer.length ? buffer[index] : 0;
      index += 1;
      for (let offset = 0; offset < count; offset += 1) out.push(value);
    }
  }
  return Buffer.from(out);
}

/** 解码 PDF 流（支持 Flate/ASCIIHex/ASCII85/RunLength；其它滤镜返回 null 并 warning） */
function decodePdfStream(object, warnings, label) {
  if (!object || !object.streamBuffer || object.streamBuffer.length === 0) return null;
  const dict = object.dict || '';
  const filters = [];
  const filterMatch = /\/Filter\s*(\[[\s\S]*?\]|\/[A-Za-z0-9]+)/.exec(dict);
  if (filterMatch) {
    const names = filterMatch[1].match(/\/[A-Za-z0-9]+/g) || [];
    for (const raw of names) filters.push(raw.slice(1));
  }
  let output = object.streamBuffer;
  for (const filter of filters) {
    try {
      if (filter === 'FlateDecode' || filter === 'Fl') {
        try {
          output = inflateSync(output);
        } catch {
          output = inflateRawSync(output);
        }
      } else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
        output = decodePdfAsciiHex(output);
      } else if (filter === 'ASCII85Decode' || filter === 'A85') {
        output = decodePdfAscii85(output);
      } else if (filter === 'RunLengthDecode' || filter === 'RL') {
        output = decodePdfRunLength(output);
      } else if (
        filter === 'DCTDecode' || filter === 'JPXDecode' || filter === 'CCITTFaxDecode' ||
        filter === 'JBIG2Decode' || filter === 'LZWDecode'
      ) {
        return null;
      } else {
        warnings.push(`已跳过不支持的 PDF 滤镜：${filter}${label ? `（${label}）` : ''}`);
        return null;
      }
    } catch {
      warnings.push(`PDF 流解码失败${label ? `（${label}）` : ''}`);
      return null;
    }
  }
  return output;
}

/** 在字典文本里取某个 key 的值：inline 字典原样返回；间接引用返回 `ref:num` */
function pdfExtractDictValue(dict, key) {
  if (!dict) return '';
  const marker = '/' + key;
  let searchFrom = 0;
  while (true) {
    const index = dict.indexOf(marker, searchFrom);
    if (index === -1) return '';
    const after = dict[index + marker.length];
    if (after !== undefined && !/[\s<[\]/>]/.test(after) && !/[0-9]/.test(after)) {
      searchFrom = index + marker.length;
      continue;
    }
    let cursor = index + marker.length;
    while (cursor < dict.length && /\s/.test(dict[cursor])) cursor += 1;
    if (dict.startsWith('<<', cursor)) {
      let depth = 0;
      let end = cursor;
      while (end < dict.length) {
        if (dict.startsWith('<<', end)) {
          depth += 1;
          end += 2;
          continue;
        }
        if (dict.startsWith('>>', end)) {
          depth -= 1;
          end += 2;
          if (depth === 0) return dict.slice(cursor, end);
          continue;
        }
        end += 1;
      }
      return dict.slice(cursor);
    }
    const refMatch = /^(\d+)\s+(\d+)\s+R/.exec(dict.slice(cursor));
    if (refMatch) return `ref:${refMatch[1]}`;
    return '';
  }
}

/** 解析 PDF 对象值（inline 字典 / 间接引用）→ 字典文本 */
function pdfResolveDictValue(dict, key, objects) {
  const value = pdfExtractDictValue(dict, key);
  if (!value) return '';
  if (value.startsWith('ref:')) {
    const object = objects.get(parseInt(value.slice(4), 10));
    return object ? object.dict || '' : '';
  }
  return value;
}

/** 扫描对象表（不依赖 xref：容忍损坏的 xref，按 `N G obj` 正则扫描） */
function parsePdfObjects(buffer) {
  const source = buffer.toString('latin1');
  const objects = new Map();
  const objectRe = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  let count = 0;
  while ((match = objectRe.exec(source)) !== null) {
    count += 1;
    if (count > MAX_PDF_OBJECTS) break;
    const number = parseInt(match[1], 10);
    const generation = parseInt(match[2], 10);
    const bodyStart = objectRe.lastIndex;
    const endobjIndex = source.indexOf('endobj', bodyStart);
    const streamIndex = source.indexOf('stream', bodyStart);
    if (streamIndex !== -1 && (endobjIndex === -1 || streamIndex < endobjIndex)) {
      const dict = source.slice(bodyStart, streamIndex);
      let dataStart = streamIndex + 6;
      if (source[dataStart] === '\r' && source[dataStart + 1] === '\n') dataStart += 2;
      else if (source[dataStart] === '\n' || source[dataStart] === '\r') dataStart += 1;
      const endstreamIndex = source.indexOf('endstream', dataStart);
      let dataEnd = endstreamIndex === -1 ? source.length : endstreamIndex;
      const lengthMatch = /\/Length\s+(\d+)\b/.exec(dict);
      if (lengthMatch) {
        const declared = parseInt(lengthMatch[1], 10);
        if (Number.isFinite(declared) && declared > 0 && dataStart + declared <= source.length) {
          const expectedEnd = dataStart + declared;
          if (endstreamIndex === -1 || expectedEnd <= endstreamIndex || expectedEnd - endstreamIndex <= 4) {
            dataEnd = expectedEnd;
          }
        }
      }
      let actualEnd = dataEnd;
      if (source[actualEnd - 1] === '\n') actualEnd -= 1;
      if (source[actualEnd - 1] === '\r') actualEnd -= 1;
      objects.set(number, {
        num: number,
        gen: generation,
        dict,
        hasStream: true,
        streamStart: dataStart,
        streamBuffer: buffer.subarray(dataStart, Math.max(dataStart, actualEnd)),
      });
      objectRe.lastIndex = endstreamIndex === -1 ? source.length : Math.min(source.length, endstreamIndex + 9);
      continue;
    }
    const dictEnd = endobjIndex === -1 ? source.length : endobjIndex;
    if (!objects.has(number)) {
      objects.set(number, {
        num: number,
        gen: generation,
        dict: source.slice(bodyStart, dictEnd),
        hasStream: false,
        streamBuffer: null,
      });
    }
    objectRe.lastIndex = endobjIndex === -1 ? source.length : endobjIndex + 6;
  }
  // 第二遍：修正 /Length 为间接引用的流长度
  for (const object of objects.values()) {
    if (!object.hasStream) continue;
    const indirect = /\/Length\s+(\d+)\s+\d+\s+R/.exec(object.dict || '');
    if (!indirect) continue;
    const lengthObject = objects.get(parseInt(indirect[1], 10));
    if (!lengthObject) continue;
    const value = parseInt((lengthObject.dict || '').trim(), 10);
    if (!Number.isFinite(value) || value <= 0) continue;
    const start = object.streamStart;
    if (start + value > source.length) continue;
    let end = start + value;
    if (source[end - 1] === '\n') end -= 1;
    if (source[end - 1] === '\r') end -= 1;
    if (end >= start) object.streamBuffer = buffer.subarray(start, end);
  }
  const versionMatch = /%PDF-(\d+\.\d+)/.exec(source.slice(0, 1024));
  return { objects, source, version: versionMatch ? versionMatch[1] : '' };
}

/** 展开 /Type /ObjStm 对象流（现代 PDF 常把页面/字体字典压在里面） */
function expandPdfObjectStreams(detail) {
  const objects = detail.objects;
  const objectStreams = [];
  for (const object of objects.values()) {
    if (object.hasStream && /\/Type\s*\/ObjStm\b/.test(object.dict || '')) objectStreams.push(object);
  }
  for (const objectStream of objectStreams) {
    const countMatch = /\/N\s+(\d+)/.exec(objectStream.dict || '');
    const firstMatch = /\/First\s+(\d+)/.exec(objectStream.dict || '');
    if (!countMatch || !firstMatch) continue;
    const count = parseInt(countMatch[1], 10);
    const first = parseInt(firstMatch[1], 10);
    if (!Number.isFinite(count) || !Number.isFinite(first) || count <= 0 || count > 20000) continue;
    const data = decodePdfStream(objectStream, [], '对象流');
    if (!data) continue;
    const text = data.toString('latin1');
    const header = text.slice(0, Math.min(first, text.length));
    const numbers = header.match(/-?\d+/g) || [];
    const pairs = [];
    for (let index = 0; index + 1 < numbers.length && pairs.length < count; index += 2) {
      pairs.push({ num: parseInt(numbers[index], 10), offset: parseInt(numbers[index + 1], 10) });
    }
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index];
      if (!Number.isFinite(pair.num) || !Number.isFinite(pair.offset)) continue;
      if (objects.has(pair.num)) continue;
      const start = first + pair.offset;
      const end = index + 1 < pairs.length ? first + pairs[index + 1].offset : text.length;
      if (start < 0 || start >= text.length) continue;
      objects.set(pair.num, {
        num: pair.num,
        gen: 0,
        dict: text.slice(start, end),
        hasStream: false,
        streamBuffer: null,
      });
    }
  }
}

/** 收集 PDF 页面（页面树 → 兜底按对象号排序；继承 Resources） */
function collectPdfPages(detail) {
  const objects = detail.objects;
  const pages = [];
  const visited = new Set();

  function walk(node, inheritedResources) {
    if (!node || pages.length >= MAX_PDF_PAGES || visited.has(node.num)) return;
    visited.add(node.num);
    const dict = node.dict || '';
    const typeMatch = /\/Type\s*\/([A-Za-z0-9]+)/.exec(dict);
    const type = typeMatch ? typeMatch[1] : '';
    if (type === 'Pages' || /\/Kids\s*\[/.test(dict)) {
      let resources = inheritedResources;
      const ownResources = pdfResolveDictValue(dict, 'Resources', objects);
      if (ownResources) resources = ownResources;
      const kidsMatch = /\/Kids\s*\[([\s\S]*?)\]/.exec(dict);
      if (kidsMatch) {
        const refs = kidsMatch[1].match(/\d+\s+\d+\s+R/g) || [];
        for (const ref of refs) walk(objects.get(parseInt(ref, 10)) || null, resources);
      }
      return;
    }
    if (type === 'Page' || /\/Contents\s*(?:\[|\d+\s+\d+\s+R)/.test(dict)) {
      let resources = inheritedResources;
      const ownResources = pdfResolveDictValue(dict, 'Resources', objects);
      if (ownResources) resources = ownResources;
      pages.push({ obj: node, dict, resources: resources || '' });
    }
  }

  let catalog = null;
  for (const object of objects.values()) {
    if (/\/Type\s*\/Catalog\b/.test(object.dict || '')) {
      catalog = object;
      break;
    }
  }
  if (catalog) {
    const pagesRoot = pdfExtractDictValue(catalog.dict, 'Pages');
    const refMatch = /^ref:(\d+)$/.exec(pagesRoot);
    if (refMatch) walk(objects.get(parseInt(refMatch[1], 10)) || null, '');
  }
  if (pages.length === 0) {
    const sorted = [...objects.values()].sort((a, b) => a.num - b.num);
    for (const object of sorted) {
      if (/\/Type\s*\/Page\b/.test(object.dict || '')) {
        pages.push({ obj: object, dict: object.dict || '', resources: pdfResolveDictValue(object.dict || '', 'Resources', objects) });
      }
      if (pages.length >= MAX_PDF_PAGES) break;
    }
  }
  return pages;
}

/** 页面 /Contents → 内容流对象数组 */
function resolvePdfContents(pageDict, objects) {
  const result = [];
  if (!pageDict) return result;
  const keyIndex = pageDict.indexOf('/Contents');
  if (keyIndex === -1) return result;
  let cursor = keyIndex + 9;
  while (cursor < pageDict.length && /\s/.test(pageDict[cursor])) cursor += 1;
  if (pageDict[cursor] === '[') {
    const end = pageDict.indexOf(']', cursor);
    const inner = end === -1 ? pageDict.slice(cursor) : pageDict.slice(cursor, end);
    const refs = inner.match(/\d+\s+\d+\s+R/g) || [];
    for (const ref of refs) {
      const object = objects.get(parseInt(ref, 10));
      if (object) result.push(object);
    }
    return result;
  }
  const refMatch = /^(\d+)\s+\d+\s+R/.exec(pageDict.slice(cursor));
  if (refMatch) {
    const object = objects.get(parseInt(refMatch[1], 10));
    if (object) result.push(object);
  }
  return result;
}

/** PDF 字节 → 文本（UTF-16 BE BOM / PDFDocEncoding 近似） */
function decodePdfBytesToText(bytes) {
  if (!bytes || bytes.length === 0) return '';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(2));
    } catch {
      return '';
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder('utf-16le', { fatal: false }).decode(bytes.subarray(2));
    } catch {
      return '';
    }
  }
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) out += decodeWinAnsiByte(bytes[index]);
  return out;
}

/** WinAnsi 单字节 → Unicode（0x80~0x9F 使用 cp1252 扩展表） */
const WIN_ANSI_EXTRA = Object.freeze({
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž',
  0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—',
  0x98: '˜', 0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
});

function decodeWinAnsiByte(byte) {
  if (byte === 0x0a) return '\n';
  if (byte === 0x0d) return '';
  if (byte === 0x09) return '\t';
  if (byte === 0x00) return '';
  if (byte < 0x20) return '';
  const extra = WIN_ANSI_EXTRA[byte];
  if (extra !== undefined) return extra;
  if (byte === 0xa0) return ' ';
  return String.fromCharCode(byte);
}

/** 把 UTF-16BE 字节串的最后一个码元加上 delta（bfrange 用） */
function incrementUtf16Be(bytes, delta) {
  if (!bytes || bytes.length < 2 || delta === 0) return bytes;
  const copy = Buffer.from(bytes);
  const last = copy.readUInt16BE(copy.length - 2);
  copy.writeUInt16BE((last + delta) & 0xffff, copy.length - 2);
  return copy;
}

/** 由十六进制 UTF-16BE 字符串解码（ToUnicode 目标串） */
function decodeUtf16Hex(hex) {
  const cleaned = String(hex || '').replace(/\s+/g, '');
  if (!cleaned) return '';
  const padded = cleaned.length % 2 === 1 ? cleaned + '0' : cleaned;
  const bytes = Buffer.from(padded, 'hex');
  if (bytes.length === 0) return '';
  if (bytes.length === 1) return String.fromCharCode(bytes[0]);
  try {
    return new TextDecoder('utf-16be', { fatal: false }).decode(bytes);
  } catch {
    return bytes.toString('latin1');
  }
}

/** 解析 ToUnicode CMap：codespacerange / beginbfchar / beginbfrange */
function parseToUnicodeCMap(source) {
  const map = new Map();
  let bytesPerCode = 0;
  if (typeof source !== 'string' || source.length === 0) return { map, bytesPerCode };
  const codespaceBlock = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(source);
  if (codespaceBlock) {
    const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
    let match;
    while ((match = pairRe.exec(codespaceBlock[1])) !== null) {
      const width = Math.floor(match[1].length / 2);
      if (width === 2) bytesPerCode = 2;
      else if (width === 1 && bytesPerCode === 0) bytesPerCode = 1;
      if (match[1].length >= 4) bytesPerCode = 2;
    }
  }
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  let block;
  while ((block = bfcharRe.exec(source)) !== null) {
    const pairRe = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>/g;
    let match;
    while ((match = pairRe.exec(block[1])) !== null) {
      const key = match[1].replace(/\s+/g, '').toUpperCase();
      const destination = match[2].replace(/\s+/g, '');
      if (!key || !destination) continue;
      map.set(key, decodeUtf16Hex(destination));
      if (map.size > 200000) return { map, bytesPerCode };
    }
  }
  let rangeBlock;
  const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((rangeBlock = rangeRe.exec(source)) !== null) {
    const body = rangeBlock[1];
    const entryRe = /<([0-9A-Fa-f\s]+)>\s*<([0-9A-Fa-f\s]+)>\s*(?:<([0-9A-Fa-f\s]+)>|\[([\s\S]*?)\])/g;
    let entry;
    while ((entry = entryRe.exec(body)) !== null) {
      const lowHex = entry[1].replace(/\s+/g, '');
      const highHex = entry[2].replace(/\s+/g, '');
      const low = parseInt(lowHex, 16);
      const high = parseInt(highHex, 16);
      if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) continue;
      const width = Math.max(2, lowHex.length);
      const count = Math.min(high - low + 1, 65536);
      if (entry[3]) {
        const destination = Buffer.from(entry[3].replace(/\s+/g, ''), 'hex');
        for (let offset = 0; offset < count; offset += 1) {
          const key = (low + offset).toString(16).toUpperCase().padStart(width, '0');
          map.set(key, decodeUtf16Hex(incrementUtf16Be(destination, offset).toString('hex')));
          if (map.size > 200000) break;
        }
      } else if (entry[4]) {
        const destinations = [];
        const destinationRe = /<([0-9A-Fa-f\s]+)>/g;
        let destinationMatch;
        while ((destinationMatch = destinationRe.exec(entry[4])) !== null) {
          destinations.push(destinationMatch[1].replace(/\s+/g, ''));
        }
        for (let offset = 0; offset < count && offset < destinations.length; offset += 1) {
          const key = (low + offset).toString(16).toUpperCase().padStart(width, '0');
          map.set(key, decodeUtf16Hex(destinations[offset]));
        }
      }
    }
  }
  return { map, bytesPerCode };
}

/** 构建字体解码器（ToUnicode → 映射；无 ToUnicode 时 2 字节按 UTF-16BE 兜底/1 字节 WinAnsi） */
function getPdfFontDecoder(fontObject, objects, warnings, cache, state) {
  if (!fontObject) return null;
  if (cache.has(fontObject.num)) return cache.get(fontObject.num);
  const dict = fontObject.dict || '';
  const isType0 = /\/Subtype\s*\/Type0\b/.test(dict);
  const encodingMatch = /\/Encoding\s*\/([A-Za-z0-9._-]+)/.exec(dict);
  const encodingName = encodingMatch ? encodingMatch[1] : '';
  const isIdentity = /^Identity-[HV]$/i.test(encodingName);
  const toUnicodeMatch = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(dict);
  let cmap = { map: new Map(), bytesPerCode: 0 };
  let hasToUnicode = false;
  if (toUnicodeMatch) {
    const cmapObject = objects.get(parseInt(toUnicodeMatch[1], 10));
    if (cmapObject && cmapObject.hasStream) {
      const data = decodePdfStream(cmapObject, warnings, 'ToUnicode CMap');
      if (data && data.length > 0) {
        cmap = parseToUnicodeCMap(data.toString('latin1'));
        hasToUnicode = cmap.map.size > 0;
      }
    }
  }
  let bytesPerCode = isType0 || isIdentity ? 2 : 1;
  if (cmap.bytesPerCode === 2) bytesPerCode = 2;
  else if (cmap.bytesPerCode === 1 && !isType0 && !isIdentity) bytesPerCode = 1;
  if (!hasToUnicode && (isType0 || isIdentity) && state) state.missingToUnicode = true;
  const decoder = {
    decode(bytes) {
      if (!bytes || bytes.length === 0) return '';
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        try {
          return new TextDecoder('utf-16be', { fatal: false }).decode(bytes.subarray(2));
        } catch {
          return '';
        }
      }
      if (bytesPerCode === 2) {
        let result = '';
        for (let index = 0; index + 1 < bytes.length; index += 2) {
          const key = bytes.subarray(index, index + 2).toString('hex').toUpperCase();
          const mapped = cmap.map.get(key);
          if (mapped !== undefined) result += mapped;
          else if (!hasToUnicode) result += decodePdfBytesToText(bytes.subarray(index, index + 2));
        }
        if (bytes.length % 2 === 1) {
          const key = bytes[bytes.length - 1].toString(16).toUpperCase().padStart(2, '0');
          const mapped = cmap.map.get(key);
          if (mapped !== undefined) result += mapped;
        }
        return result;
      }
      let result = '';
      for (let index = 0; index < bytes.length; index += 1) {
        const key = bytes[index].toString(16).toUpperCase().padStart(2, '0');
        const mapped = cmap.map.get(key);
        if (mapped !== undefined) result += mapped;
        else result += decodeWinAnsiByte(bytes[index]);
      }
      return result;
    },
  };
  cache.set(fontObject.num, decoder);
  return decoder;
}

/** PDF 内容流 → 文本（BT/ET/Tm/Td/TD/T*、Tj/TJ、单双引号等文本算子） */
function extractPdfTextContent(content, fonts) {
  if (!content) return '';
  let source = content;
  if (source.indexOf('BI') !== -1 && source.length < 4000000) {
    source = source.replace(/\bBI\b[\s\S]*?\bEI\b/g, ' ');
  }
  const tokens = tokenizePdfContent(source);
  const operands = [];
  const arrayStack = [];
  let out = '';
  let currentFont = null;
  let lastTmY = null;
  let lastTmX = null;

  function lastOperand() {
    return operands.length > 0 ? operands[operands.length - 1] : null;
  }
  function numberAt(index) {
    const operand = operands[index];
    return operand && operand.kind === 'number' && Number.isFinite(operand.value) ? operand.value : null;
  }
  function endWithNewline() {
    if (!out) return;
    if (out.charCodeAt(out.length - 1) !== 0x0a) out += '\n';
  }
  function ensureSpace() {
    if (!out) return;
    const last = out.charCodeAt(out.length - 1);
    if (last !== 0x20 && last !== 0x0a && last !== 0x09) out += ' ';
  }
  function decodeString(bytes) {
    return decodePdfStringBytes(bytes, currentFont);
  }
  function pushValue(value) {
    if (arrayStack.length > 0) arrayStack[arrayStack.length - 1].items.push(value);
    else operands.push(value);
  }

  for (const token of tokens) {
    if (token.type === 'number') {
      pushValue({ kind: 'number', value: token.value });
      continue;
    }
    if (token.type === 'string') {
      pushValue({ kind: 'string', bytes: token.bytes });
      continue;
    }
    if (token.type === 'name') {
      pushValue({ kind: 'name', value: token.value });
      continue;
    }
    if (token.type === 'arrayStart') {
      const array = { kind: 'array', items: [] };
      pushValue(array);
      arrayStack.push(array);
      continue;
    }
    if (token.type === 'arrayEnd') {
      arrayStack.pop();
      continue;
    }
    if (token.type !== 'op') continue;
    const operator = token.value;
    switch (operator) {
      case 'BT':
        endWithNewline();
        lastTmY = null;
        lastTmX = null;
        break;
      case 'ET':
        endWithNewline();
        break;
      case 'Tf': {
        const nameOperand = operands[operands.length - 2];
        if (nameOperand && nameOperand.kind === 'name') currentFont = fonts.get(nameOperand.value) || null;
        break;
      }
      case 'Tj': {
        const operand = lastOperand();
        if (operand && operand.kind === 'string') out += decodeString(operand.bytes);
        break;
      }
      case 'TJ': {
        const operand = lastOperand();
        if (operand && operand.kind === 'array') {
          for (const item of operand.items) {
            if (item.kind === 'number') {
              if (item.value < -100) ensureSpace();
            } else if (item.kind === 'string') {
              out += decodeString(item.bytes);
            }
          }
        }
        break;
      }
      case "'": {
        endWithNewline();
        const operand = lastOperand();
        if (operand && operand.kind === 'string') out += decodeString(operand.bytes);
        break;
      }
      case '"': {
        endWithNewline();
        const operand = lastOperand();
        if (operand && operand.kind === 'string') out += decodeString(operand.bytes);
        break;
      }
      case 'Td':
      case 'TD': {
        const tx = numberAt(operands.length - 2);
        const ty = numberAt(operands.length - 1);
        if (ty !== null && Math.abs(ty) > 0.5) endWithNewline();
        else if (tx !== null && tx > 12) ensureSpace();
        break;
      }
      case 'T*':
        endWithNewline();
        break;
      case 'Tm': {
        const x = numberAt(operands.length - 2);
        const y = numberAt(operands.length - 1);
        if (y !== null) {
          if (lastTmY !== null && Math.abs(y - lastTmY) > 1.5) endWithNewline();
          else if (lastTmX !== null && lastTmY !== null && Math.abs(y - lastTmY) <= 1.5 && x !== null && x - lastTmX > 8) ensureSpace();
          lastTmY = y;
          if (x !== null) lastTmX = x;
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return out;
}

/** 字符串字节 → 文本（优先当前字体解码器；无字体时 WinAnsi/UTF-16 兜底） */
function decodePdfStringBytes(bytes, fontDecoder) {
  if (!bytes || bytes.length === 0) return '';
  if (fontDecoder) return fontDecoder.decode(bytes);
  return decodePdfBytesToText(bytes);
}

/** 抽取单页文本 */
function extractPdfPageText(page, pageIndex, objects, warnings, fontCache, state) {
  const contentObjects = resolvePdfContents(page.dict, objects);
  if (contentObjects.length === 0) return '';
  const resources = page.resources || '';
  const fontPart = resources ? pdfResolveDictValue(resources, 'Font', objects) : '';
  const fontObjects = new Map();
  if (fontPart) {
    const fontRefRe = /\/([A-Za-z0-9._+#-]+)\s+(\d+)\s+\d+\s+R/g;
    let match;
    while ((match = fontRefRe.exec(fontPart)) !== null) {
      const object = objects.get(parseInt(match[2], 10));
      if (object) fontObjects.set(match[1], object);
    }
  }
  const fonts = new Map();
  for (const [name, fontObject] of fontObjects) {
    fonts.set(name, getPdfFontDecoder(fontObject, objects, warnings, fontCache, state));
  }
  const chunks = [];
  for (const contentObject of contentObjects) {
    const data = decodePdfStream(contentObject, warnings, `第 ${pageIndex + 1} 页内容流`);
    if (data && data.length > 0) chunks.push(data.toString('latin1'));
  }
  if (chunks.length === 0) return '';
  return extractPdfTextContent(chunks.join('\n'), fonts);
}

/** PDF 文本后处理：NFKC 兼容字符归一 + 中文断行/字间空格合并（启发式，英文不做破坏性处理） */
function cleanupPdfText(input) {
  if (typeof input !== 'string' || !input) return '';
  let text = input;
  try {
    text = text.normalize('NFKC');
  } catch {
    /* 无 normalize 的运行时保持原文 */
  }
  const cjk = '\\u2e80-\\u2fff\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
  const cjkRe = `[${cjk}]`;
  const ws = ' \\t\\u00a0\\u2000-\\u200a\\u3000';
  const sentenceEnd = '。！？；：…!?;:，、';
  // 1) 去掉 CJK 字符之间、CJK 与中文标点之间的空白
  text = text.replace(new RegExp(`(${cjkRe})[${ws}]+(?=${cjkRe})`, 'g'), '$1');
  // 2) 合并被 PDF 拆碎的中文单字行（前一个字不是句末标点时去掉换行）
  text = text.replace(new RegExp(`(${cjkRe})[${ws}]*\\n[${ws}]*(?=${cjkRe})`, 'g'), (match, previous) => {
    return sentenceEnd.includes(previous) ? match : previous;
  });
  // 3) 中文行与相邻英文/数字行：用空格连接（避免英文单词粘连）
  text = text.replace(new RegExp(`(${cjkRe})[${ws}]*\\n[${ws}]*(?=[A-Za-z0-9])`, 'g'), '$1 ');
  text = text.replace(new RegExp(`([A-Za-z0-9])[${ws}]*\\n[${ws}]*(?=${cjkRe})`, 'g'), '$1 ');
  // 4) 最后去掉中文标点前后的空白（前面步骤可能引入空格）
  text = text.replace(new RegExp(`[${ws}]+([，。！？；：、…》」』】））”’])`, 'g'), '$1');
  text = text.replace(new RegExp(`([（《「『【‘“])[${ws}]+`, 'g'), '$1');
  return text;
}

/** PDF 标题（trailer /Info → /Title；兜底全文正则） */
function extractPdfTitle(detail) {
  const source = detail.source || '';
  const objects = detail.objects;
  const infoRefs = [...source.matchAll(/\/Info\s+(\d+)\s+\d+\s+R/g)];
  if (infoRefs.length > 0) {
    const last = infoRefs[infoRefs.length - 1];
    const object = objects.get(parseInt(last[1], 10));
    if (object) {
      const title = pdfTextStringValue(object.dict || '', 'Title');
      if (title) return cleanTitle(title);
    }
  }
  const titleMatch = /\/Title\s*(\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]+>)/.exec(source);
  if (titleMatch) return cleanTitle(decodePdfTextValue(titleMatch[1]));
  return '';
}

/** 取字典里某个文本字符串值 */
function pdfTextStringValue(dict, key) {
  if (!dict) return '';
  const index = dict.indexOf('/' + key);
  if (index === -1) return '';
  let cursor = index + key.length + 1;
  while (cursor < dict.length && /\s/.test(dict[cursor])) cursor += 1;
  if (dict[cursor] === '(') return decodePdfBytesToText(readPdfLiteralString(dict, cursor).bytes);
  if (dict[cursor] === '<') {
    if (dict[cursor + 1] === '<') return '';
    return decodePdfBytesToText(readPdfHexString(dict, cursor).bytes);
  }
  return '';
}

/** 解码 /Title 的值文本（字面量或十六进制） */
function decodePdfTextValue(valueText) {
  if (typeof valueText !== 'string' || !valueText) return '';
  if (valueText.startsWith('(')) return decodePdfBytesToText(readPdfLiteralString(valueText, 0).bytes);
  if (valueText.startsWith('<')) return decodePdfBytesToText(readPdfHexString(valueText, 0).bytes);
  return '';
}

/** PDF 抽取主流程 */
function extractPdf(input, options) {
  const buffer = toBuffer(input);
  const source = buffer.toString('latin1');
  if (source.slice(0, 1024).indexOf('%PDF-') === -1) {
    return unsupportedResult('pdf', '不是有效的 PDF 文件（缺少 %PDF- 文件头）。', []);
  }
  if (/\/Encrypt\b/.test(source)) {
    return unsupportedResult('pdf', MESSAGES.encryptedPdf, ['检测到 /Encrypt 加密标记']);
  }
  const warnings = [];
  let detail;
  try {
    detail = parsePdfObjects(buffer);
  } catch (error) {
    return failResult({
      format: 'pdf',
      error: `PDF 对象表解析失败：${error instanceof Error ? error.message : String(error)}`,
      warnings,
      unsupported: true,
    });
  }
  try {
    expandPdfObjectStreams(detail);
  } catch {
    warnings.push('PDF 对象流展开失败，部分内容可能缺失');
  }
  const pages = collectPdfPages(detail);
  if (pages.length === 0) {
    return unsupportedResult('pdf', '未能解析 PDF 页面结构（文件可能损坏或使用了不支持的压缩格式）。', warnings);
  }
  const fontCache = new Map();
  const state = { missingToUnicode: false };
  const pageTexts = [];
  let totalChars = 0;
  const pageLimit = Math.min(pages.length, MAX_PDF_PAGES);
  for (let index = 0; index < pageLimit; index += 1) {
    let pageText = '';
    try {
      pageText = extractPdfPageText(pages[index], index, detail.objects, warnings, fontCache, state);
    } catch {
      pageText = '';
      warnings.push(`第 ${index + 1} 页内容流解析失败，已跳过`);
    }
    const trimmed = pageText.trim();
    if (trimmed) {
      pageTexts.push(trimmed);
      totalChars += trimmed.length;
    }
  }
  if (pages.length > pageLimit) warnings.push(`PDF 页数超过上限（${MAX_PDF_PAGES} 页），已截断`);
  if (state.missingToUnicode) warnings.push('部分字体缺少 ToUnicode 映射，提取的文字可能有乱码');
  if (totalChars < MIN_TEXT_CHARS) {
    warnings.push('可能是扫描件/特殊字体编码，提取有限，可改为粘贴正文');
  }
  const cleanedText = cleanupPdfText(pageTexts.join('\n\n'));
  let title = extractPdfTitle(detail);
  if (!title) {
    const firstLine = cleanedText
      .split('\n')
      .map((line) => collapseWhitespace(line))
      .find((line) => line.length >= 2 && line.length <= 120);
    if (firstLine) title = cleanTitle(firstLine, 120);
  }
  return finalizeResult({
    format: 'pdf',
    text: cleanedText,
    title,
    warnings,
    meta: { pages: pageLimit, pdfVersion: detail.version, encrypted: false },
    maxChars: options.maxChars,
    bytes: buffer.length,
  });
}

// ===========================================================================
// 旧 Office / 图片 / 通用 ZIP
// ===========================================================================

/** Office 97-2003 旧格式（OLE 复合文档）：明确 unsupported */
function extractOldOffice(buffer, detail, options) {
  const extension = extensionOf(options.filename || '');
  let kind = 'ole';
  if (extension === '.doc' || extension === '.dot') kind = 'doc';
  else if (extension === '.xls' || extension === '.xlt') kind = 'xls';
  else if (extension === '.ppt' || extension === '.pps' || extension === '.pot') kind = 'ppt';
  return unsupportedResult(kind, MESSAGES.oldOffice, ['检测到 OLE 复合文档（Office 97-2003 旧格式）']);
}

/** 通用 ZIP（非 OOXML/ODF/EPUB）：给解压提示 */
function extractGenericZip(buffer, detail) {
  if (detail && detail.zipError) {
    const code = detail.zipError.code ? String(detail.zipError.code) : '';
    const message = detail.zipError.message ? String(detail.zipError.message) : 'ZIP 结构损坏';
    if (code === 'ZIP64') return unsupportedResult('zip', MESSAGES.zip64, [message]);
    if (code === 'ENCRYPTED') return unsupportedResult('zip', MESSAGES.zipEncrypted, [message]);
    return unsupportedResult('zip', `ZIP 压缩包无法解析：${message}`, ['文件可能损坏']);
  }
  return unsupportedResult('zip', MESSAGES.notZipDocument, ['未在压缩包内找到 [Content_Types].xml / content.xml / META-INF/container.xml 等文档结构']);
}

// ===========================================================================
// 主入口：extractDocument
// ===========================================================================

/**
 * 多格式文档正文抽取（永不 reject）。
 * @param {Buffer|Uint8Array} buffer 原始字节
 * @param {{ filename?:string, mime?:string, maxChars?:number, bookMode?:boolean }} options
 * @returns {Promise<{text:string,title:string,format:string,warnings:string[],meta:object,unsupported?:boolean,error?:string}>}
 */
export async function extractDocument(buffer, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const filename = typeof opts.filename === 'string' ? opts.filename : '';
  const mime = typeof opts.mime === 'string' ? opts.mime : '';
  const maxChars = clampInt(opts.maxChars, DEFAULT_MAX_CHARS, 100, 5000000);
  const context = { filename, mime, maxChars, bookMode: opts.bookMode === true };
  let format = 'unknown';
  try {
    const data = toBuffer(buffer);
    if (!data) {
      return failResult({
        format: 'unknown',
        error: '无法识别的输入数据：需要 Buffer 或 Uint8Array。',
        warnings: ['buffer 参数类型不正确'],
      });
    }
    if (data.length === 0) {
      return failResult({
        format: detectFormat(data, filename, mime),
        error: MESSAGES.empty,
        warnings: ['文件字节数为 0'],
      });
    }
    const detail = detectFormatDetailed(data, filename, mime);
    format = detail && detail.format ? detail.format : 'unknown';
    switch (format) {
      case 'pdf':
        return extractPdf(data, context);
      case 'docx':
        return extractDocx(data, context);
      case 'pptx':
        return extractPptx(data, context);
      case 'xlsx':
        return extractXlsx(data, context);
      case 'odt':
      case 'ods':
      case 'odp':
      case 'odg':
        return extractOdf(data, format, context);
      case 'epub':
        return extractEpub(data, context);
      case 'rtf':
        return extractRtf(data, context);
      case 'html':
        return extractHtml(data, context);
      case 'markdown':
      case 'text':
      case 'csv':
      case 'json':
        return extractPlainText(data, format, context);
      case 'image':
        return unsupportedResult('image', MESSAGES.image, []);
      case 'ole':
        return extractOldOffice(data, detail, context);
      case 'zip':
        return extractGenericZip(data, detail);
      case 'unknown':
      default: {
        const decoded = decodeTextBuffer(data);
        if (!decoded.binary && decoded.text.trim()) {
          const result = extractPlainText(data, 'text', context);
          if (!result.error) {
            result.warnings = [
              `未知文件格式${filename ? `（${filename}）` : ''}，已按纯文本处理`,
              ...result.warnings,
            ];
            result.meta.detectedFormat = format;
          }
          return result;
        }
        return unsupportedResult('unknown', MESSAGES.unknown, ['文件既不是支持的文档格式，也无法按文本解码']);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failResult({
      format,
      error: `文档解析出错：${message}`,
      warnings: ['解析过程中出现未预期异常，已安全降级'],
      unsupported: true,
    });
  }
}
