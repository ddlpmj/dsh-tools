/**
 * dsh-knowledge-base —— 知识库存储层（lib/kb.js）
 *
 * 职责（对应 CONTRACT.md 第 3 节）：
 * - 知识库根目录初始化 / 模板（purpose.md、log.md、.wiki-schema.md、index.md、graph.json、.kb-state.json）；
 * - frontmatter 序列化 + 解析（只支持契约规定的 YAML 子集：标量 JSON 字符串、`- "..."` 块列表）；
 * - slug 生成、页面路径防穿越、原子写；
 * - 素材（source）登记 / 去重 / 更新；页面（source/entity/topic/synthesis）写入、合并、级联删除；
 * - 扫描磁盘重建 state（.kb-state.json 损坏或丢失时从 wiki/** 反推，含最小 source 记录）；
 * - index.md / graph.json / log.md 自动维护；
 * - 搜索评分、健康检查、tree/overview 数据组装。
 *
 * 设计取舍：
 * - 纯 Node 内置模块，零 npm/Harness 依赖；
 * - 所有写操作串行化（`_withLock`），避免多个请求交错写 state 导致丢失；
 * - state 是缓存，磁盘是真相：每次加载都会重新扫描 wiki/** 做一次对账（页面以磁盘为准，
 *   source 记录以 state 为准，缺失的用素材页 frontmatter 反推出最小记录）；
 * - 页面正文不写一级标题（title 由 frontmatter/UI 负责），写入前统一清理；
 * - 追加到已有页面时用 `<!-- kb-source:<id> -->` 标记来源区块，重新编译同一素材时先移除旧区块再追加，
 *   避免「重新编译 → 内容重复堆叠」。
 */

import { constants as fsConstants, promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { PassageIndex, contentHash, evidencePath, searchTokens } from './retrieval.js';
import { contentIdentity } from './conversations.js';
import { sourceForWikiPage, sourceVersionGroups } from './library-view.js';

// ---------------------------------------------------------------------------
// 常量 / 模板
// ---------------------------------------------------------------------------

/** 页面类型 → wiki 子目录（契约 3.1） */
export const PAGE_TYPE_DIRS = Object.freeze({
  source: 'sources',
  entity: 'entities',
  topic: 'topics',
  synthesis: 'synthesis',
});

/** wiki 子目录 → 页面类型 */
export const DIR_PAGE_TYPES = Object.freeze({
  sources: 'source',
  entities: 'entity',
  topics: 'topic',
  synthesis: 'synthesis',
});

/** 置信度枚举（契约 3.2） */
export const CONFIDENCE_LEVELS = Object.freeze(['EXTRACTED', 'INFERRED', 'AMBIGUOUS', 'UNVERIFIED']);

/** 实体分类是组织元信息，不表示模型对事实的置信度。 */
export const DEFAULT_KB_ROOT = path.join(os.homedir(), 'Documents', 'DSH工具数据', '知识库');

export const ENTITY_CATEGORIES = Object.freeze(['company', 'technology', 'task', 'product', 'person', 'organization', 'concept', 'metric', 'document', 'other']);

function normalizeEntityCategory(value) {
  return typeof value === 'string' && ENTITY_CATEGORIES.includes(value.trim()) ? value.trim() : '';
}

function acceptsEntityRole(page, role) {
  return page?.type === 'entity' && (!page.entityCategory || page.entityCategory === 'other' || page.entityCategory === role);
}

function normalizePassageRelations(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (item?.relation !== 'CEO' || typeof item.source !== 'string' || typeof item.target !== 'string'
      || !item.source || !item.target || item.source === item.target) return [];
    const sourceCreatedAt = normalizeIsoDate(item.sourceCreatedAt);
    const targetCreatedAt = normalizeIsoDate(item.targetCreatedAt);
    return sourceCreatedAt && targetCreatedAt
      ? [{ relation: 'CEO', source: item.source, target: item.target, sourceCreatedAt, targetCreatedAt }]
      : [];
  });
}

/** 状态文件名 */
const STATE_FILE = '.kb-state.json';

/** 回收站（附录 A） */
const TRASH_DIR = '.trash';
const TRASH_INDEX_FILE = '.trash/index.json';
const TRASH_MAX_ITEMS = 100;
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 批量上限（附录 A.1） */
const PAGE_BATCH_LIMIT = 100;
const SOURCE_BATCH_LIMIT = 50;

/** Virtual, read-only pages are supplied live by the reading assistant. */
const EXCERPT_PREFIX = 'reader-excerpts/';
const EXCERPT_PATH = /^reader-excerpts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;
const EXCERPT_WARNING = '摘抄笔记暂时无法读取，请稍后重试';
const ORIGINAL_PATH = /^source-text\/(src_(?:[a-f0-9]{10}|[a-f0-9]{24}))\.md$/;
const CONVERSATION_TEXT_PATH = /^raw\/conversations\/[a-f0-9]{64}\.md$/;
const CHAPTER_PATH = /^book-chapters\/[a-z0-9_-]{1,120}\.md$/i;

function originalPage({ path: pagePath, title, text, type = 'original', ...metadata }) {
  return { path: pagePath, title, type, markdown: text, originalText: text, readOnly: true,
    aliases: [], tags: [], confidence: '', sources: [], sourceRefs: [], links: [], backlinks: [],
    frontmatter: { title, type, readOnly: true }, ...metadata };
}

function isExcerptNamespace(value) {
  const raw = String(value ?? '').replace(/\\/g, '/').trim();
  const normalized = path.posix.normalize(raw);
  return [raw, normalized].some(text => text === 'reader-excerpts' || text.startsWith(EXCERPT_PREFIX));
}

function rejectExcerptMutation(value) {
  if (isExcerptNamespace(value)) throw new KbError('BAD_REQUEST', '摘抄为只读联动内容，请在阅读助手的摘抄笔记中管理');
}

/** 手工编辑正文长度上限（附录 A.2） */
const PAGE_MARKDOWN_MAX = 200000;
const PAGE_MARKDOWN_MIN = 20;

/** 素材状态枚举（契约 3.3） */
const SOURCE_STATUSES = Object.freeze(['queued', 'parsing', 'compiling', 'ready', 'failed']);

/** 日志模板 */
const LOG_TEMPLATE = '# 操作日志\n\n> 由 DSH 知识库插件自动追加，记录导入 / 编译 / 删除等操作。\n\n';

/** purpose.md 模板（初始化写入，不覆盖已有文件） */
const PURPOSE_TEMPLATE =
  '# 研究方向（Purpose）\n\n' +
  '> 在这里写下你的研究方向、长期关注的问题或目标。编译出的 Wiki 会更贴合你的需要；\n' +
  '> 你可以随时修改，插件不会覆盖你写的内容。\n';

/** .wiki-schema.md（方法论说明 + 页面规范，初始化写入，不覆盖） */
const WIKI_SCHEMA = `# Wiki Schema（知识库页面规范）

> 本文件由 DSH 知识库插件在初始化时写入，说明「llm-wiki」方法论的落盘规则。插件不会覆盖它。

## 方法论：知识编译一次、持续维护

- **原始素材不可变**：上传/抓取的原文保存在 \`raw/\` 下，插件不会改写原文；
- **LLM 把素材编译成互相链接的 Wiki 页面**：素材摘要页 + 实体页 + 主题页（必要时综合页）；
- **每次编译都更新索引、图谱与日志**：\`index.md\`、\`graph.json\`、\`log.md\` 由插件自动生成，请勿手改；
- **人工编辑优先**：你可以直接在 Obsidian / 编辑器里修改 \`wiki/**\` 页面，重新编译时插件会合并而不是覆盖。

## 目录结构

\`\`\`
<root>/
  purpose.md          研究方向（用户可编辑）
  index.md            总索引（自动生成）
  log.md              操作日志（追加）
  .wiki-schema.md     本文件
  .kb-state.json      状态缓存（可由磁盘重建）
  graph.json          知识图谱（自动生成）
  raw/documents/      上传文件原件（不可变）
  raw/articles/       链接原文（提取后的 Markdown 文本）
  raw/notes/          粘贴文本
  raw/extracted/      归一化纯文本（供搜索 / 重编译）
  wiki/sources/       素材摘要页（type: source）
  wiki/entities/      实体页（人物 / 概念 / 工具 / 组织…）
  wiki/topics/        主题页
  wiki/synthesis/     综合分析页
\`\`\`

## frontmatter 规范

每页 Markdown 以 YAML frontmatter 开头（只支持这个子集）：

\`\`\`markdown
---
title: "知识图谱"
type: "entity"
aliases:
  - "Knowledge Graph"
tags:
  - "知识管理"
confidence: "EXTRACTED"
sources:
  - "src_ab12cd34ef"
created: "2026-10-31T15:00:00.000Z"
updated: "2026-10-31T15:00:00.000Z"
---
\`\`\`

- 标量与 JSON 字符串等价，数组用 \`- "..."\` 块列表；
- 正文不要重复一级标题（title 由 frontmatter 与界面展示）；
- 正文至少 20 个字符，使用 \`[[页面标题]]\` 或 \`[[页面标题|显示文本]]\` 建立双向链接。

## 页面类型

| type | 目录 | 说明 |
|---|---|---|
| source | wiki/sources/ | 素材摘要页：摘要 + 3~8 条要点 + 来源信息 |
| entity | wiki/entities/ | 实体页：人物、概念、工具、组织、方法等 |
| topic | wiki/topics/ | 主题页：跨素材的主题综述 |
| synthesis | wiki/synthesis/ | 综合分析页（可选） |

## 置信度

| 值 | 含义 |
|---|---|
| EXTRACTED | 原文明确给出 |
| INFERRED | 由上下文合理推断 |
| AMBIGUOUS | 原文表述模糊 / 存在歧义 |
| UNVERIFIED | 暂未能验证 |

## 编译流程（两步式）

1. **分析**：读取素材全文（超长时先分块产出笔记 JSON），提取标题、摘要、实体、主题、关键论断；
2. **生成**：结合现有页面目录，产出严格的 JSON（素材页正文 + 新建/追加页面），由 Host 校验后落盘；
3. **落盘**：写入页面、合并已有页面、更新 state / index / graph / log。

## 双向链接与图谱

- \`[[链接]]\` 的目标是页面 title 或 alias，渲染时由 Host 解析成页面路径；
- \`graph.json\` 的 \`link\` 边来自正文 \`[[...]]\`，\`derived\` 边表示同一素材编译出的素材页 ↔ 实体/主题页；
- 未解析的链接会出现在健康检查的 \`broken-link\` 里。
`;

/** 空 state 模板 */
function emptyState() {
  const now = new Date().toISOString();
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    purpose: '',
    sources: {},
    pages: {},
    stats: { sources: 0, pages: 0, entities: 0, topics: 0, syntheses: 0, chars: 0 },
  };
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/** 当前 ISO 时间 */
function nowIso() {
  return new Date().toISOString();
}

/** 本地时间 `YYYY-MM-DD HH:mm`（log.md 用） */
function formatDateTime(date) {
  const value = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

/** 本地日期 `YYYY-MM-DD`（追加区块标题用） */
function formatDate(date) {
  const value = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** 统一成正斜杠相对路径 */
function toPosixPath(value) {
  return String(value).split(path.sep).join('/');
}

/** 去重数组（保持首次出现顺序） */
function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** 把任意值规整成字符串数组 */
export function normalizeStringArray(value) {
  if (Array.isArray(value)) return uniqueStrings(value.map((item) => (item === null || item === undefined ? '' : String(item))));
  if (typeof value === 'string' && value.trim()) return uniqueStrings([value]);
  return [];
}

/** 标题/别名匹配用的归一化 key */
export function titleKey(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Compare full names without erasing version numbers, symbols, or qualifiers. */
export function pageIdentityKey(value) {
  const name = String(value ?? '').normalize('NFC').replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
  return titleKey(name)
    .replace(/(?<=\p{Script=Han}) +| +(?=\p{Script=Han})/gu, '');
}

export function comparablePageIdentity(a, b) {
  if (!a.type || !b.type || a.type === 'source' || b.type === 'source') return false;
  if (a.type === 'synthesis' || b.type === 'synthesis') return a.type === b.type;
  if (a.type !== 'entity' || b.type !== 'entity') return true;
  const left = normalizeEntityCategory(a.entityCategory);
  const right = normalizeEntityCategory(b.entityCategory);
  return !left || !right || left === 'other' || right === 'other' || left === right
    || (['technology', 'concept'].includes(left) && ['technology', 'concept'].includes(right));
}

/** Prefer a unique canonical title, then a unique existing alias. A proposed alias is only a hint. */
export function findPageIdentity(catalog, candidate) {
  const key = pageIdentityKey(candidate.title);
  if (!key) return null;
  const names = catalog.filter(page => page.type !== 'source');
  const exact = names.filter(page => pageIdentityKey(page.title) === key);
  if (exact.length) {
    const page = exact.length === 1 ? exact[0] : null;
    // A generated category can be wrong. Keep the canonical page's classification on exact names.
    return page && (page.type === candidate.type || comparablePageIdentity(page, candidate)) ? page : null;
  }
  const aliases = names.filter(page => (page.aliases || []).some(alias => pageIdentityKey(alias) === key));
  return aliases.length === 1 && comparablePageIdentity(aliases[0], candidate) ? aliases[0] : null;
}

/** 归一化页面类型（支持单复数、大小写） */
export function normalizeType(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return '';
  const map = {
    source: 'source',
    sources: 'source',
    entity: 'entity',
    entities: 'entity',
    topic: 'topic',
    topics: 'topic',
    synthesis: 'synthesis',
    syntheses: 'synthesis',
  };
  return map[text] || '';
}

/** 归一化置信度 */
export function normalizeConfidence(value, fallback = 'UNVERIFIED') {
  const text = String(value ?? '').trim().toUpperCase();
  if (CONFIDENCE_LEVELS.includes(text)) return text;
  return CONFIDENCE_LEVELS.includes(fallback) ? fallback : 'UNVERIFIED';
}

/** 解析 ISO 日期字符串；非法返回空串 */
function normalizeIsoDate(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return '';
  try {
    return new Date(time).toISOString();
  } catch {
    return '';
  }
}

/** 异常信息短文案 */
function errorMessageOf(error) {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === 'string' ? error : '未知错误';
}

/** 业务错误（带契约错误码） */
export class KbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KbError';
    this.code = code || 'INTERNAL';
  }
}

/** 契约错误码 → 建议 HTTP 状态 */
export function kbErrorStatus(code) {
  const map = {
    BAD_REQUEST: 400,
    NOT_FOUND: 404,
    TOO_LARGE: 413,
    UNSUPPORTED: 415,
    EXTRACT_FAILED: 422,
    FETCH_FAILED: 502,
    BLOCKED_URL: 403,
    INVALID_URL: 400,
    NO_MODEL: 503,
    LLM_FAILED: 502,
    NO_KB: 409,
    CONFLICT: 409,
    TIMEOUT: 504,
    INTERNAL: 500,
  };
  return map[code] || 500;
}

// ---------------------------------------------------------------------------
// 哈希 / slug / 路径安全
// ---------------------------------------------------------------------------

/**
 * sha256 十六进制。
 * @param {Buffer|Uint8Array|string} input
 * @returns {string}
 */
export function sha256Hex(input) {
  const buffer = Buffer.isBuffer(input)
    ? input
    : input instanceof Uint8Array
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(String(input ?? ''), 'utf8');
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * URL 规范化（去 fragment、去 utm_*，保留其余 query）——用于 URL 来源的去重哈希。
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeUrlForHash(rawUrl) {
  const input = String(rawUrl ?? '').trim();
  if (!input) return '';
  try {
    const url = new URL(input);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return input;
  }
}

/**
 * 素材来源 URL 的归一化（用于跨入口去重）：去 hash、去 `utm_*` 参数、去路径尾斜杠。
 * 微信文章额外移除分享场景参数并排序 query，保留识别文章的内容参数。
 * @param {string} rawUrl 原始 URL。
 * @returns {string} 归一化 URL；非法输入返回空串或原值。
 */
export function normalizeSourceUrl(rawUrl) {
  const normalized = normalizeUrlForHash(rawUrl);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    if (url.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/[^/]+)?$/.test(url.pathname)) {
      for (const key of [...url.searchParams.keys()]) {
        if (['scene', 'subscene', 'from', 'isappinstalled', 'clicktime', 'enterid'].includes(key.toLowerCase())) url.searchParams.delete(key);
      }
      url.searchParams.sort();
    }
    return url.href;
  } catch {
    return normalized;
  }
}

/**
 * slug 生成（契约 3.1）：小写、保留 CJK/字母/数字、空白与标点转 `-`、折叠、去首尾、最长 60。
 * @param {string} input
 * @param {number} [maxLength]
 * @returns {string}
 */
export function slugify(input, maxLength = 60) {
  let text = String(input ?? '').normalize('NFKC').toLowerCase().trim();
  text = text.replace(/[^\p{L}\p{N}]+/gu, '-');
  text = text.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const chars = Array.from(text);
  if (chars.length > maxLength) {
    text = chars.slice(0, maxLength).join('').replace(/-+$/g, '');
  }
  return text || 'page';
}

/**
 * 知识库相对路径 → 绝对路径，并做目录穿越校验（契约 9）。
 * @param {string} rootDir 知识库根目录
 * @param {string} relPath 相对路径
 * @returns {string} 绝对路径
 * @throws {KbError} BAD_REQUEST
 */
export function resolveInside(rootDir, relPath) {
  const root = path.resolve(String(rootDir || '.'));
  const text = String(relPath ?? '').replace(/\\/g, '/').trim();
  if (!text) throw new KbError('BAD_REQUEST', '路径不能为空');
  if (text.includes('\u0000')) throw new KbError('BAD_REQUEST', '路径包含非法字符');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) throw new KbError('BAD_REQUEST', '必须使用知识库内的相对路径');
  const segments = text.split('/');
  if (segments.some((segment) => segment === '..')) throw new KbError('BAD_REQUEST', '路径越界：不允许包含 ..');
  const abs = path.resolve(root, text);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new KbError('BAD_REQUEST', '路径越界：解析结果不在知识库目录内');
  }
  return abs;
}

/** Open a plain file under the physical raw directory. The caller owns the handle. */
export async function openRawFile(rootDir, relPath) {
  const rel = String(relPath ?? '').replace(/\\/g, '/').trim();
  if (!rel.startsWith('raw/')) throw new KbError('BAD_REQUEST', '只能读取 raw/ 目录下的原件');
  // Validate lexical paths even when the library does not exist yet.
  resolveInside(rootDir, rel);
  let handle;
  try {
    const root = await fsp.realpath(rootDir);
    const abs = resolveInside(root, rel);
    if (!abs.startsWith(path.join(root, 'raw') + path.sep)) {
      throw new KbError('BAD_REQUEST', '只能读取 raw/ 目录下的原件');
    }
    if (await fsp.realpath(abs) !== abs) throw new KbError('BAD_REQUEST', '原件路径不能包含符号链接');
    handle = await fsp.open(abs, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const [stat, entry, current] = await Promise.all([handle.stat(), fsp.lstat(abs), fsp.realpath(abs)]);
    if (current !== abs || entry.isSymbolicLink() || stat.dev !== entry.dev || stat.ino !== entry.ino) {
      throw new KbError('BAD_REQUEST', '原件路径已变化，请重试');
    }
    if (!stat.isFile()) throw new KbError('NOT_FOUND', '原件不是普通文件');
    return { abs, handle, stat };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof KbError) throw error;
    if (error?.code === 'ELOOP') throw new KbError('BAD_REQUEST', '原件路径不能包含符号链接');
    throw new KbError('NOT_FOUND', '原件不存在或无法读取');
  }
}

async function readRawText(root, rel) {
  const { handle } = await openRawFile(root, rel);
  try { return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}

/**
 * 原子写：先写 `<file>.tmp.<rand>`，再 rename 覆盖目标（契约硬约束）。
 * @param {string} absPath 绝对路径
 * @param {string|Buffer} data 内容
 */
export async function writeFileAtomic(absPath, data) {
  const dir = path.dirname(absPath);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = `${absPath}.tmp.${process.pid.toString(36)}${randomBytes(5).toString('hex')}`;
  try {
    if (Buffer.isBuffer(data)) await fsp.writeFile(tmp, data);
    else await fsp.writeFile(tmp, String(data), 'utf8');
    await fsp.rename(tmp, absPath);
  } catch (error) {
    try {
      await fsp.unlink(tmp);
    } catch {
      /* 临时文件可能已被 rename/清理 */
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// frontmatter：只支持契约规定的 YAML 子集
// ---------------------------------------------------------------------------

/** 解析 frontmatter 里的标量 */
function parseScalarValue(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.replace(/^"+|"+$/g, '');
    }
  }
  if (text.startsWith("'")) {
    return text.replace(/^'+|'+$/g, '').replace(/''/g, "'");
  }
  if (text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) {
    const num = Number(text);
    if (Number.isFinite(num)) return num;
  }
  return text;
}

/**
 * 解析页面 Markdown 的 frontmatter。
 * @param {string} text 文件全文
 * @returns {{frontmatter: Record<string, unknown>, body: string}}
 */
export function parseFrontmatter(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  if (!source.startsWith('---')) return { frontmatter: {}, body: source.trim() };
  const firstLineEnd = source.indexOf('\n');
  if (firstLineEnd === -1) return { frontmatter: {}, body: source.trim() };
  const lines = source.slice(firstLineEnd + 1).split('\n');
  let end = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { frontmatter: {}, body: source.trim() };
  const frontmatter = {};
  let currentKey = '';
  for (const rawLine of lines.slice(0, end)) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const listMatch = /^\s*-\s+(.*)$/.exec(line);
    if (listMatch && currentKey) {
      if (!Array.isArray(frontmatter[currentKey])) frontmatter[currentKey] = [];
      frontmatter[currentKey].push(parseScalarValue(listMatch[1]));
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kvMatch) continue;
    currentKey = kvMatch[1];
    const rawValue = kvMatch[2].trim();
    if (!rawValue) {
      frontmatter[currentKey] = [];
      continue;
    }
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      try {
        const parsed = JSON.parse(rawValue);
        frontmatter[currentKey] = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        frontmatter[currentKey] = [rawValue.slice(1, -1).trim()].filter(Boolean);
      }
      continue;
    }
    frontmatter[currentKey] = parseScalarValue(rawValue);
  }
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return { frontmatter, body };
}

/**
 * 序列化 frontmatter（标量用 JSON.stringify，数组用块列表）。
 * @param {Record<string, unknown>} frontmatter
 * @returns {string}
 */
export function serializeFrontmatter(frontmatter) {
  const lines = ['---'];
  const writePair = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      lines.push(`${key}:`);
      for (const item of value) {
        if (item === undefined || item === null) continue;
        lines.push(`  - ${JSON.stringify(String(item))}`);
      }
      return;
    }
    if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(JSON.stringify(value))}`);
      return;
    }
    lines.push(`${key}: ${JSON.stringify(String(value))}`);
  };
  const canonical = ['title', 'type', 'aliases', 'tags', 'confidence', 'sources', 'created', 'updated'];
  for (const key of canonical) {
    if (key in frontmatter) writePair(key, frontmatter[key]);
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (canonical.includes(key)) continue;
    writePair(key, value);
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * 页面 Markdown 全文（frontmatter + 空行 + 正文 + 结尾换行）。
 * @param {Record<string, unknown>} frontmatter
 * @param {string} body
 * @returns {string}
 */
export function serializePageContent(frontmatter, body) {
  const text = String(body ?? '').trim();
  return `${serializeFrontmatter(frontmatter)}\n\n${text}\n`;
}

/**
 * 抽取正文里的 `[[链接]]` 目标（去重、忽略 `|显示文本`）。
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractLinkTargets(markdown) {
  const targets = [];
  const seen = new Set();
  const re = /\[\[([^[\]]+?)\]\]/g;
  const text = String(markdown ?? '');
  let match;
  while ((match = re.exec(text))) {
    const raw = match[1].split('|')[0].trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(raw);
  }
  return targets;
}

/**
 * 落盘前收敛正文里的 `[[链接]]`（CONTRACT §6.4 验收口径）：
 * - 能解析（title/alias 命中解析表）→ 规范化为 `[[规范标题]]` / `[[规范标题#小节]]` / `[[规范标题|显示文字]]`；
 * - 解析不到 → 降级为纯文本（有 `|显示文字` 时用显示文字），并把说明加入 warnings（去重，最多 20 条）。
 * 保证 graph/state 的 links 只包含已解析目标，health-check 只报告真正断链。
 * @param {string} markdown 正文
 * @param {(title:string)=>string|null} resolve 标题 → 规范标题
 * @param {string[]} [warnings] 收集告警的数组
 * @param {Set<string>} [warnedTargets] 已告警目标（跨多次调用去重）
 * @returns {string}
 */
export function convergeMarkdownLinks(markdown, resolve, warnings, warnedTargets) {
  const text = String(markdown ?? '');
  if (!text || typeof resolve !== 'function') return text;
  const warningList = Array.isArray(warnings) ? warnings : null;
  const seen = warnedTargets instanceof Set ? warnedTargets : new Set();
  return text.replace(/\[\[([^[\]]+?)\]\]/g, (match, inner) => {
    const raw = String(inner);
    const pipeIndex = raw.indexOf('|');
    const targetPart = pipeIndex === -1 ? raw : raw.slice(0, pipeIndex);
    const display = pipeIndex === -1 ? '' : raw.slice(pipeIndex + 1).trim();
    const targetRaw = targetPart.trim();
    if (!targetRaw) return display || '';
    // `[[target#section]]` 提取 target（标题本身可能含 #，先整体解析再按 # 拆分）
    const hashIndex = targetRaw.indexOf('#');
    const targetBase = hashIndex > 0 ? targetRaw.slice(0, hashIndex).trim() : targetRaw;
    let canonical = resolve(targetRaw);
    if (!canonical && hashIndex > 0) canonical = resolve(targetBase);
    if (canonical) {
      // 规范化为 `[[规范标题]]` / `[[规范标题|显示文字]]`（小节锚点按验收口径不保留）
      return display ? `[[${canonical}|${display}]]` : `[[${canonical}]]`;
    }
    const plain = display || targetBase || targetRaw;
    const warnTarget = targetBase || targetRaw;
    if (warningList && !seen.has(warnTarget)) {
      seen.add(warnTarget);
      if (warningList.length < 20) warningList.push(`链接「${warnTarget}」未解析，已降级为纯文本`);
    }
    return plain;
  });
}

/**
 * Markdown → 单行纯文本摘要（用于 index.md 的一行描述）。
 * @param {string} markdown
 * @param {number} [maxLength]
 * @returns {string}
 */
export function plainTextExcerpt(markdown, maxLength = 120) {
  let text = String(markdown ?? '');
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/\[\[([^[\]]+?)\]\]/g, (_match, inner) => String(inner).split('|')[0]);
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '');
  text = text.replace(/[*_~`>#|]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const sentenceMatch = /^[\s\S]{0,600}?[。！？!?；;]/.exec(text);
  const sentence = (sentenceMatch ? sentenceMatch[0] : text).trim();
  if (sentence.length <= maxLength) return sentence;
  return `${sentence.slice(0, maxLength)}…`;
}

/** CJK 正则（含扩展 A 与兼容区） */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * 搜索词切分：先按空白/标点切，再对较长中文片段补 2-gram。
 * 目的：/ask 的自然语言问题（「知识图谱是什么？」）也能命中页面，而不是整句做子串匹配。
 * @param {string} query
 * @returns {string[]}
 */
export function tokenizeSearchQuery(query) {
  const text = String(query ?? '')
    .toLowerCase()
    .trim();
  if (!text) return [];
  const segments = text
    .split(/[\s,，。;；、:：!?！？"'“”‘’()（）\[\]【】{}<>《》/\\|+=~`@#$%^&*_\-]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const tokens = [];
  const push = (token) => {
    const value = String(token || '').trim();
    if (!value) return;
    if (tokens.includes(value)) return;
    if (tokens.length >= 12) return;
    tokens.push(value);
  };
  for (const segment of segments) {
    push(segment);
    const chars = Array.from(segment);
    // 中文长句（>4 字）补 2-gram，提升自然语言问句的召回
    if (CJK_RE.test(segment) && chars.length > 4) {
      for (let index = 0; index < chars.length - 1; index += 1) push(chars[index] + chars[index + 1]);
    }
  }
  if (tokens.length === 0) push(text);
  return tokens.slice(0, 12);
}

// ---------------------------------------------------------------------------
// KnowledgeBase
// ---------------------------------------------------------------------------

/**
 * 知识库存储对象：一个 rootDir 对应一个实例。
 */
export class KnowledgeBase {
  /**
   * @param {string} rootDir 知识库根目录（绝对路径或可解析路径）
   * @param {{externalPages?:()=>Promise<object[]>}} [options] 仅用于读取与搜索的动态外部页面。
   */
  constructor(rootDir, options = {}) {
    this.root = path.resolve(String(rootDir || DEFAULT_KB_ROOT));
    /** @type {any|null} */
    this._state = null;
    this._loading = null;
    this._lock = Promise.resolve();
    this._graphCache = null;
    this._externalPages = typeof options?.externalPages === 'function' ? options.externalPages : null;
    this._chapterPages = typeof options?.chapterPages === 'function' ? options.chapterPages : null;
    this._passageIndex = new PassageIndex();
    this._fileTextCache = new Map();
    this._retrievalBuilding = null;
  }

  /** External pages never become state, catalog, graph, or compilation inputs. */
  async _readExternalPages() {
    if (!this._externalPages) return [];
    try {
      const pages = await this._externalPages();
      if (!Array.isArray(pages)) throw new Error('Invalid external page collection');
      return pages.filter(page => page && typeof page === 'object' && EXCERPT_PATH.test(page.path));
    } catch {
      throw new KbError('INTERNAL', EXCERPT_WARNING);
    }
  }

  // -- 基础状态 ------------------------------------------------------------

  /** 是否已初始化（根目录存在且带任一标记文件/目录） */
  async isInitialized() {
    try {
      const stat = await fsp.stat(this.root);
      if (!stat.isDirectory()) return false;
    } catch {
      return false;
    }
    for (const marker of [STATE_FILE, 'purpose.md', 'log.md', 'wiki']) {
      try {
        await fsp.access(path.join(this.root, marker));
        return true;
      } catch {
        /* 继续看下一个标记 */
      }
    }
    return false;
  }

  /** 串行化写操作 */
  _withLock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 读取 state（懒加载；state 丢失/损坏时从磁盘重建） */
  async ensureState() {
    if (this._state) return this._state;
    if (!this._loading) {
      this._loading = this._readStateFromDisk().then(
        (state) => {
          this._state = state;
          this._loading = null;
          return state;
        },
        (error) => {
          this._loading = null;
          throw error;
        },
      );
    }
    return this._loading;
  }

  /** 当前 state（必须先 ensureState） */
  getState() {
    return this._state || emptyState();
  }

  /** 初始化目录与模板（不覆盖已有文件；须在锁内调用） */
  async _initUnlocked() {
    const existed = await this.isInitialized();
    const dirs = [
      '',
      'raw/documents',
      'raw/articles',
      'raw/notes',
      'raw/extracted',
      'wiki/sources',
      'wiki/entities',
      'wiki/topics',
      'wiki/synthesis',
    ];
    for (const dir of dirs) {
      await fsp.mkdir(path.join(this.root, dir), { recursive: true });
    }
    await this._writeIfMissing('purpose.md', PURPOSE_TEMPLATE);
    await this._writeIfMissing('.wiki-schema.md', WIKI_SCHEMA);
    await this._writeIfMissing('log.md', LOG_TEMPLATE);
    // 重新读取 state（保证初始化后的对账基于最新磁盘）
    this._state = null;
    this._graphCache = null;
    this._loading = null;
    const state = await this.ensureState();
    this._recomputeStats(state);
    await this._saveStateUnlocked();
    await this._rebuildIndexUnlocked();
    await this._rebuildGraphUnlocked();
    if (!existed) await this._appendLogUnlocked('init', `初始化知识库：${this.root}`);
    return { rootDir: this.root, created: !existed };
  }

  /** 初始化目录与模板（不覆盖已有文件） */
  async init() {
    return this._withLock(() => this._initUnlocked());
  }

  /** 重新与磁盘对账（用户可能在外部编辑/增删文件） */
  async refresh() {
    await this.ensureState();
    return this._withLock(async () => {
      const state = this._state;
      await this._reconcileWithDisk(state);
      this._graphCache = null;
      this._recomputeStats(state);
      return state;
    });
  }

  // -- state 读写 / 对账 ---------------------------------------------------

  async _readStateFromDisk() {
    const initialized = await this.isInitialized();
    if (!initialized) return emptyState();
    let raw = null;
    let corrupt = false;
    try {
      const text = await fsp.readFile(path.join(this.root, STATE_FILE), 'utf8');
      raw = JSON.parse(text);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        raw = null;
        corrupt = true;
      }
    } catch {
      raw = null;
      corrupt = true;
    }
    const state = this._normalizeState(raw);
    await this._reconcileWithDisk(state);
    const migrated = await this._ensureSourceIndexes(state);
    if (migrated) {
      try {
        this._state = state;
        await this._saveStateUnlocked();
      } catch (error) {
        console.warn(`[dsh-kb] 素材索引迁移失败（不影响读取）：${error && error.message ? error.message : error}`);
      }
    }
    if (corrupt) {
      // state 丢失/损坏：把重建结果落盘（best effort，失败不阻塞读接口）
      try {
        this._state = state;
        this._recomputeStats(state);
        await this._saveStateUnlocked();
      } catch (error) {
        console.warn(`[dsh-kb] 重建 .kb-state.json 失败：${error && error.message ? error.message : error}`);
      }
    }
    return state;
  }

  _normalizeState(raw) {
    const state = emptyState();
    if (!raw || typeof raw !== 'object') return state;
    if (typeof raw.createdAt === 'string' && normalizeIsoDate(raw.createdAt)) state.createdAt = normalizeIsoDate(raw.createdAt);
    if (typeof raw.updatedAt === 'string' && normalizeIsoDate(raw.updatedAt)) state.updatedAt = normalizeIsoDate(raw.updatedAt);
    state.purpose = typeof raw.purpose === 'string' ? raw.purpose : '';
    if (raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)) {
      for (const [id, value] of Object.entries(raw.sources)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        state.sources[String(id)] = this._normalizeSourceRecord(String(id), value);
      }
    }
    if (raw.pages && typeof raw.pages === 'object' && !Array.isArray(raw.pages)) {
      for (const [rel, value] of Object.entries(raw.pages)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        state.pages[String(rel)] = this._normalizePageEntry(String(rel), value);
      }
    }
    if (raw.stats && typeof raw.stats === 'object') state.stats = { ...state.stats, ...raw.stats };
    return state;
  }

  _normalizeSourceRecord(id, value) {
    const kind = ['file', 'url', 'note', 'conversation'].includes(value.kind) ? value.kind : 'file';
    const status = SOURCE_STATUSES.includes(value.status) ? value.status : 'queued';
    return {
      id,
      kind,
      name: typeof value.name === 'string' ? value.name : '',
      ...(value.passage && typeof value.passage === 'object' ? { passage: {
        title: typeof value.passage.title === 'string' ? value.passage.title : '',
        url: typeof value.passage.url === 'string' ? value.passage.url : '',
        translated: value.passage.translated === true,
      }, relations: normalizePassageRelations(value.relations) } : {}),
      conversation: value.kind === 'conversation' && value.conversation && typeof value.conversation === 'object' ? value.conversation : undefined,
      ext: typeof value.ext === 'string' ? value.ext : '',
      mime: typeof value.mime === 'string' ? value.mime : '',
      sha256: typeof value.sha256 === 'string' ? value.sha256 : '',
      textHash: typeof value.textHash === 'string' ? value.textHash : '',
      bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
      chars: Number.isFinite(value.chars) ? value.chars : 0,
      title: typeof value.title === 'string' ? value.title : '',
      url: typeof value.url === 'string' ? value.url : '',
      rawPath: typeof value.rawPath === 'string' ? value.rawPath : '',
      extractedPath: typeof value.extractedPath === 'string' ? value.extractedPath : '',
      status,
      error: typeof value.error === 'string' ? value.error : null,
      warnings: normalizeStringArray(value.warnings),
      model: typeof value.model === 'string' ? value.model : '',
      createdAt: normalizeIsoDate(value.createdAt) || nowIso(),
      compiledAt: normalizeIsoDate(value.compiledAt) || null,
      pages: normalizeStringArray(value.pages),
      summary: typeof value.summary === 'string' ? value.summary : '',
      tags: normalizeStringArray(value.tags),
    };
  }

  _normalizePageEntry(rel, value) {
    const type = normalizeType(value.type) || this._pageTypeFromPath(rel) || 'entity';
    return {
      path: rel,
      type,
      title: this._cleanTitle(value.title) || path.basename(rel, '.md'),
      alias: typeof value.alias === 'string' && value.alias ? value.alias : path.basename(rel, '.md'),
      aliases: normalizeStringArray(value.aliases),
      tags: normalizeStringArray(value.tags),
      confidence: normalizeConfidence(value.confidence, 'UNVERIFIED'),
      sources: normalizeStringArray(value.sources),
      createdAt: normalizeIsoDate(value.createdAt) || nowIso(),
      updatedAt: normalizeIsoDate(value.updatedAt) || nowIso(),
      userEditedAt: normalizeIsoDate(value.userEditedAt) || '',
      links: normalizeStringArray(value.links),
    };
  }

  /** 用磁盘 wiki/** 重建 state.pages，并补全/校正 sources */
  async _reconcileWithDisk(state) {
    const { pages, bodyChars } = await this._scanPagesFromDisk();
    state.pages = pages;
    // 素材页 frontmatter 里引用、但 state 缺失的 source → 反推最小记录
    for (const page of Object.values(pages)) {
      for (const sourceId of page.sources) {
        if (!state.sources[sourceId]) {
          state.sources[sourceId] = this._minimalSourceRecord(sourceId, page, bodyChars[page.path] || 0);
        }
      }
    }
    // 反向校正 source.pages（素材页在前，其余页面按路径排序）
    for (const [sourceId, source] of Object.entries(state.sources)) {
      const referencing = Object.values(pages).filter((page) => page.sources.includes(sourceId));
      const sourcePages = referencing.filter((page) => page.type === 'source').map((page) => page.path);
      const others = referencing.filter((page) => page.type !== 'source').map((page) => page.path).sort();
      source.pages = [...sourcePages, ...others];
      if (source.pages.length > 0 && source.status !== 'failed') source.status = 'ready';
      if (source.chars <= 0 && bodyChars[sourcePages[0]]) source.chars = bodyChars[sourcePages[0]];
    }
    const purposeInfo = await this._readPurposeInfo();
    // 文件存在 → 以文件为准（用户可能刚清空）；文件被删 → 保留 state 里的内容避免丢输入
    if (purposeInfo.exists) state.purpose = purposeInfo.text;
    this._recomputeStats(state);
  }

  /**
   * 补齐 / 迁移素材索引（v0.4.0，加载 state 时执行一次）：
   * 1. 历史素材没有文本哈希时按磁盘内容回填 textHash（跨入口去重用）；
   * 2. 非文件类（url / note）素材的 raw 与 extracted 内容完全相同时合并为单份
   *    （extractedPath 指向 rawPath 并删除重复的 extracted 文件）。
   * @param {any} state 当前 state。
   * @returns {Promise<boolean>} 是否发生变更（需要回写 state）。
   */
  async _ensureSourceIndexes(state) {
    let changed = false;
    for (const source of Object.values(state.sources)) {
      if (!source || typeof source !== 'object') continue;
      if (!source.textHash) {
        const text = await this._readSourceTextFromDisk(source);
        if (text) {
          source.textHash = sha256Hex(text);
          changed = true;
        }
      }
      if (source.kind === 'file' || !source.rawPath || !source.extractedPath) continue;
      if (source.extractedPath === source.rawPath) continue;
      try {
        const rawAbs = resolveInside(this.root, source.rawPath);
        const extractedAbs = resolveInside(this.root, source.extractedPath);
        const [rawStat, extractedStat] = await Promise.all([fsp.stat(rawAbs), fsp.stat(extractedAbs)]);
        if (!rawStat.isFile() || !extractedStat.isFile() || rawStat.size !== extractedStat.size) continue;
        const [rawBuffer, extractedBuffer] = await Promise.all([fsp.readFile(rawAbs), fsp.readFile(extractedAbs)]);
        if (!rawBuffer.equals(extractedBuffer)) continue;
        await fsp.unlink(extractedAbs);
        source.extractedPath = source.rawPath;
        changed = true;
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          console.warn(`[dsh-kb] 合并重复文本文件失败：${error && error.message ? error.message : error}`);
        }
      }
    }
    return changed;
  }

  _minimalSourceRecord(sourceId, page, bodyChars) {
    return {
      id: sourceId,
      kind: 'unknown',
      name: page.title,
      ext: '',
      mime: '',
      sha256: '',
      textHash: '',
      bytes: 0,
      chars: bodyChars || 0,
      title: page.title,
      url: '',
      rawPath: '',
      extractedPath: '',
      status: 'ready',
      error: null,
      warnings: ['状态文件缺失，已从素材页重建该素材记录'],
      model: '',
      createdAt: page.createdAt,
      compiledAt: page.updatedAt,
      pages: [page.path],
      summary: '',
      tags: page.tags,
    };
  }

  _pageTypeFromPath(rel) {
    const segments = String(rel).split('/');
    if (segments[0] !== 'wiki') return '';
    for (let i = 1; i < segments.length - 1; i += 1) {
      const type = DIR_PAGE_TYPES[segments[i]];
      if (type) return type;
    }
    return '';
  }

  async _scanPagesFromDisk() {
    const pages = {};
    const bodyChars = {};
    const files = await this._walkMarkdownFiles(path.join(this.root, 'wiki'));
    for (const abs of files) {
      const rel = toPosixPath(path.relative(this.root, abs));
      const parsed = await this._parsePageFile(abs, rel);
      if (!parsed) continue;
      pages[rel] = parsed.entry;
      bodyChars[rel] = parsed.bodyChars;
    }
    return { pages, bodyChars };
  }

  async _walkMarkdownFiles(dir, depth = 0) {
    const out = [];
    if (depth > 4) return out;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this._walkMarkdownFiles(abs, depth + 1)));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(abs);
      }
    }
    return out;
  }

  async _parsePageFile(abs, rel) {
    let text = '';
    try {
      text = await fsp.readFile(abs, 'utf8');
    } catch {
      return null;
    }
    let stat = null;
    try {
      stat = await fsp.stat(abs);
    } catch {
      stat = null;
    }
    const parsed = this._parsePageText(text, rel, stat);
    return parsed;
  }

  _parsePageText(text, rel, stat) {
    const { frontmatter, body } = parseFrontmatter(text);
    // Former paths still open the merged page, but do not enter the catalogue.
    if (typeof frontmatter.redirectTo === 'string' && frontmatter.redirectTo.trim()) return null;
    const type = this._pageTypeFromPath(rel) || normalizeType(frontmatter.type);
    if (!type) return null;
    const title =
      this._cleanTitle(frontmatter.title) ||
      this._titleFromBody(body) ||
      this._cleanTitle(path.basename(rel, '.md')) ||
      '未命名页面';
    const createdAt =
      normalizeIsoDate(frontmatter.created) ||
      (stat ? normalizeIsoDate(stat.birthtime && stat.birthtime.toISOString()) : '') ||
      nowIso();
    const updatedAt =
      normalizeIsoDate(frontmatter.updated) ||
      (stat ? normalizeIsoDate(stat.mtime && stat.mtime.toISOString()) : '') ||
      nowIso();
    const entry = {
      path: rel,
      type,
      title,
      alias: path.basename(rel, '.md'),
      aliases: normalizeStringArray(frontmatter.aliases),
      tags: normalizeStringArray(frontmatter.tags),
      confidence: normalizeConfidence(frontmatter.confidence, type === 'source' ? 'EXTRACTED' : 'UNVERIFIED'),
      sources: normalizeStringArray(frontmatter.sources),
      topicParent: type === 'topic' && typeof frontmatter.topicParent === 'string' ? frontmatter.topicParent.trim() : '',
      entityCategory: type === 'entity' ? normalizeEntityCategory(frontmatter.entityCategory) : '',
      taxonomyEditedAt: normalizeIsoDate(frontmatter.taxonomyEditedAt) || '',
      createdAt,
      updatedAt,
      userEditedAt: normalizeIsoDate(frontmatter.userEditedAt) || '',
      links: extractLinkTargets(body),
    };
    return { entry, bodyChars: body.trim().length, body };
  }

  _titleFromBody(body) {
    const match = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(String(body || ''));
    return match ? this._cleanTitle(match[1]) : '';
  }

  /** 统计 + 时间戳 */
  _recomputeStats(state) {
    const pages = Object.values(state.pages || {});
    const count = (type) => pages.filter((page) => page.type === type).length;
    let chars = 0;
    for (const source of Object.values(state.sources || {})) {
      if (Number.isFinite(source.chars) && source.chars > 0) chars += source.chars;
    }
    state.stats = {
      sources: Object.keys(state.sources || {}).length,
      pages: pages.length,
      entities: count('entity'),
      topics: count('topic'),
      syntheses: count('synthesis'),
      chars,
    };
    state.updatedAt = nowIso();
    return state.stats;
  }

  async _saveStateUnlocked() {
    const state = this._state;
    if (!state) return;
    this._recomputeStats(state);
    await writeFileAtomic(path.join(this.root, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
  }

  // -- 磁盘模板 -----------------------------------------------------------

  async _writeIfMissing(rel, content) {
    const abs = resolveInside(this.root, rel);
    try {
      await fsp.access(abs);
      return false;
    } catch {
      await writeFileAtomic(abs, content);
      return true;
    }
  }

  /** purpose.md 是否存在 + 解析出的正文 */
  async _readPurposeInfo() {
    try {
      const text = await fsp.readFile(path.join(this.root, 'purpose.md'), 'utf8');
      return { exists: true, text: this._purposeFromMarkdown(text) };
    } catch {
      return { exists: false, text: '' };
    }
  }

  async _readPurposeText() {
    const info = await this._readPurposeInfo();
    return info.text;
  }

  _purposeFromMarkdown(text) {
    const { body } = parseFrontmatter(String(text || ''));
    const out = [];
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('# ')) continue;
      // 初始模板里的提示文字不算用户填写的研究方向
      if (/^>\s*在这里写下你的研究方向/.test(line)) continue;
      if (/^>\s*你可以随时修改/.test(line)) continue;
      if (line === '---') break;
      out.push(rawLine.replace(/\s+$/, ''));
    }
    return out.join('\n').replace(/^\s+|\s+$/g, '');
  }

  // -- 页面 Markdown 读取 --------------------------------------------------

  _resolvePagePath(relPath) {
    const text = String(relPath ?? '').replace(/\\/g, '/').trim();
    if (!text) throw new KbError('BAD_REQUEST', '缺少页面路径');
    if (text.includes('\u0000')) throw new KbError('BAD_REQUEST', '页面路径包含非法字符');
    if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) throw new KbError('BAD_REQUEST', '页面路径必须是知识库相对路径');
    const normalized = path.posix.normalize(text);
    if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
      throw new KbError('BAD_REQUEST', '页面路径越界');
    }
    if (!normalized.startsWith('wiki/') || !normalized.toLowerCase().endsWith('.md')) {
      throw new KbError('BAD_REQUEST', '只能读取 wiki 目录下的 Markdown 页面');
    }
    const abs = resolveInside(this.root, normalized);
    return { rel: normalized, abs };
  }

  async _readPageBody(rel) {
    const abs = resolveInside(this.root, rel);
    const text = await fsp.readFile(abs, 'utf8');
    return parseFrontmatter(text).body;
  }

  async _readPageBodySafe(rel) {
    try {
      return await this._readPageBody(rel);
    } catch {
      return '';
    }
  }

  _titleIndex() {
    const index = new Map();
    const pages = Object.values(this._state ? this._state.pages : {});
    for (const page of pages) {
      const key = titleKey(page.title);
      if (key && !index.has(key)) index.set(key, page.path);
    }
    for (const page of pages) {
      for (const key of page.aliases.map(titleKey).filter(Boolean)) {
        if (!index.has(key)) index.set(key, page.path);
      }
    }
    return index;
  }

  _resolveTitle(index, title) {
    const key = titleKey(title);
    if (!key) return null;
    return index.get(key) || null;
  }

  // -- 来源 / 页面查询（供 index.js 组装读接口） --------------------------

  async getSource(sourceId) {
    await this.ensureState();
    const id = String(sourceId ?? '').trim();
    return this._state.sources[id] || null;
  }

  async findSourceByHash(sha256) {
    await this.ensureState();
    const hash = String(sha256 ?? '').trim();
    if (!hash) return null;
    for (const source of Object.values(this._state.sources)) {
      if (source.sha256 === hash) return source;
    }
    return null;
  }

  /**
   * 按归一化正文哈希查找素材（v0.4.0：跨入口去重，URL / 文本 / 文件抽取结果相同即视为同一份）。
   * @param {string} textHash 正文哈希。
   * @returns {Promise<any|null>} 命中的 source。
   */
  async findSourceByTextHash(textHash) {
    await this.ensureState();
    const hash = String(textHash ?? '').trim();
    if (!hash) return null;
    for (const source of Object.values(this._state.sources)) {
      if (!source.passage && source.textHash === hash) return source;
    }
    return null;
  }

  /**
   * 按归一化来源 URL 查找素材（v0.4.0：同一 URL 即使正文变化也不新建重复素材）。
   * @param {string} url 原始 / 已归一化 URL。
   * @returns {Promise<any|null>} 命中的 source。
   */
  async findSourceByUrl(url) {
    await this.ensureState();
    const target = normalizeSourceUrl(url);
    if (!target) return null;
    for (const source of Object.values(this._state.sources)) {
      if (!source.url) continue;
      if (normalizeSourceUrl(source.url) === target) return source;
    }
    return null;
  }

  /**
   * 从磁盘读取某个素材的正文（优先 extracted，其次 raw）。
   * @param {any} source source 记录。
   * @returns {Promise<string>}
   */
  async _readSourceTextFromDisk(source) {
    for (const rel of [source && source.extractedPath, source && source.rawPath]) {
      if (!rel) continue;
      try {
        return await readRawText(this.root, rel);
      } catch {
        /* 尝试下一个候选 */
      }
    }
    return '';
  }

  /** 读取素材归一化纯文本（优先 raw/extracted/<id>.txt，其次 raw/articles|notes/*.md） */
  async readSourceText(sourceId) {
    await this.ensureState();
    const source = this._state.sources[sourceId];
    if (!source) return '';
    return this._readSourceTextFromDisk(source);
  }

  /** Directory used for compilation. Scope previews stay in the current library. */
  async catalog() {
    await this.ensureState();
    return Promise.all(Object.values(this._state.pages).map(async (page) => ({
      title: page.title,
      type: page.type,
      aliases: page.aliases,
      path: page.path,
      ...(page.type !== 'source' ? { scope: plainTextExcerpt(await this._readPageBodySafe(page.path), 360) } : {}),
      topicParent: this._publicTopicParent(page),
      entityCategory: page.type === 'entity' ? page.entityCategory || 'other' : '',
      entityCategoryAssigned: page.type === 'entity' && Boolean(page.entityCategory),
      taxonomyEditedAt: page.taxonomyEditedAt || '',
    })));
  }

  /** GET /page 数据 */
  async getPage(relPath) {
    const evidence = /^(.*?)#evidence=(\d+)-(\d+)-([a-f0-9]{64})$/.exec(String(relPath));
    if (evidence) {
      const page = await this.getPage(evidence[1]);
      const text = page.originalText ?? page.excerptText ?? page.markdown;
      const start = Number(evidence[2]), end = Number(evidence[3]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > text.length || end - start > 10000) throw new KbError('BAD_REQUEST', '引用位置不合法');
      if (contentHash(text) !== evidence[4]) throw new KbError('CONFLICT', '原文已更新，旧引用位置已失效，请重新检索');
      return { ...page, path: relPath, type: 'evidence', readOnly: true, parentPath: page.path,
        markdown: text.slice(start, end), originalText: text.slice(start, end),
        startLine: 1 + (text.slice(0, start).match(/\n/g) || []).length,
        endLine: 1 + (text.slice(0, end).match(/\n/g) || []).length, sourceKind: page.type };
    }
    if (String(relPath).startsWith('source-text/')) {
      const match = ORIGINAL_PATH.exec(String(relPath));
      if (!match) throw new KbError('BAD_REQUEST', '原文路径格式不正确');
      await this.ensureState();
      const source = this._state.sources[match[1]];
      if (!source) throw new KbError('NOT_FOUND', '素材不存在，可能已删除');
      const text = await this._sourceSearchText(source);
      if (!text) throw new KbError('NOT_FOUND', '素材正文不可读取');
      return originalPage({ path: relPath, title: source.title || source.name, text,
        sourceId: source.id, sourceUrl: source.url || source.passage?.url || '', sourceRefs: [this._sourceRef(source.id)], tags: source.tags || [] });
    }
    if (String(relPath).startsWith('book-chapters/')) {
      if (!CHAPTER_PATH.test(String(relPath)) || !this._chapterPages) throw new KbError('NOT_FOUND', '本书中不存在该章节');
      const page = (await this._chapterPages()).find(item => item.path === relPath);
      if (!page) throw new KbError('NOT_FOUND', '本书中不存在该章节');
      return originalPage({ ...page, text: page.text, type: 'chapter' });
    }
    if (isExcerptNamespace(relPath)) {
      if (typeof relPath !== 'string' || !EXCERPT_PATH.test(relPath)) {
        throw new KbError('BAD_REQUEST', '摘抄页面路径格式不正确');
      }
      const pages = await this._readExternalPages();
      const page = pages.find(item => item.path === relPath);
      if (!page) throw new KbError('NOT_FOUND', '摘抄不存在，可能已在阅读助手中删除');
      return { ...page, readOnly: true };
    }
    await this.ensureState();
    let { rel, abs } = this._resolvePagePath(relPath);
    const visited = new Set();
    let text, frontmatter, body;
    for (;;) {
      if (visited.has(rel) || visited.size >= 8) throw new KbError('CONFLICT', '页面合并路径存在循环或层级过多');
      visited.add(rel);
      try {
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        throw new KbError('NOT_FOUND', `页面不存在：${rel}`);
      }
      ({ frontmatter, body } = parseFrontmatter(text));
      if (typeof frontmatter.redirectTo !== 'string' || !frontmatter.redirectTo.trim()) break;
      ({ rel, abs } = this._resolvePagePath(frontmatter.redirectTo));
    }
    let entry = this._state.pages[rel];
    if (!entry) {
      const parsed = this._parsePageText(text, rel, null);
      if (!parsed) {
        throw new KbError('NOT_FOUND', `不是知识库页面：${rel}`);
      }
      entry = parsed.entry;
      this._state.pages[rel] = entry;
    }
    const index = this._titleIndex();
    const links = extractLinkTargets(body).map((title) => ({
      title,
      path: this._resolveTitle(index, title),
    }));
    const backlinks = [];
    for (const page of Object.values(this._state.pages)) {
      if (page.path === rel) continue;
      const pointsHere = page.links.some((title) => this._resolveTitle(index, title) === rel);
      if (pointsHere) backlinks.push({ path: page.path, title: page.title });
    }
    backlinks.sort((a, b) => a.title.localeCompare(b.title, 'zh'));
    const sourceRefs = entry.sources.map((id) => this._sourceRef(id));
    const conversationSource = entry.type === 'source' && entry.sources.length === 1 && this._state.sources[entry.sources[0]];
    const conversation = !entry.userEditedAt && conversationSource?.kind === 'conversation' ? await this._readConversation(conversationSource) : null;
    const publicFrontmatter = {
      ...frontmatter,
      title: entry.title,
      type: entry.type,
      aliases: entry.aliases,
      tags: entry.tags,
      confidence: entry.confidence,
      sources: entry.sources,
      created: entry.createdAt,
      updated: entry.updatedAt,
      userEditedAt: entry.userEditedAt || null,
      topicParent: this._publicTopicParent(entry),
      entityCategory: entry.type === 'entity' ? entry.entityCategory || 'other' : '',
      entityCategoryAssigned: entry.type === 'entity' && Boolean(entry.entityCategory),
      taxonomyEditedAt: entry.taxonomyEditedAt || '',
    };
    return {
      path: rel,
      type: entry.type,
      title: entry.title,
      markdown: body,
      frontmatter: publicFrontmatter,
      aliases: entry.aliases,
      tags: entry.tags,
      confidence: entry.confidence,
      topicParent: this._publicTopicParent(entry),
      entityCategory: entry.type === 'entity' ? entry.entityCategory || 'other' : '',
      entityCategoryAssigned: entry.type === 'entity' && Boolean(entry.entityCategory),
      taxonomyEditedAt: entry.taxonomyEditedAt || '',
      sources: entry.sources,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      userEditedAt: entry.userEditedAt || null,
      backlinks,
      links,
      sourceRefs,
      ...(conversation ? { conversation: { ...conversation, savedAt: conversationSource.createdAt } } : {}),
    };
  }

  /** 素材引用（GET /page 的 sourceRefs 单项；契约澄清第 1 条） */
  _sourceRef(sourceId) {
    const source = this._state.sources[sourceId];
    if (!source) {
      return { id: sourceId, title: '', kind: 'unknown', name: '', status: 'missing', url: '', pagePath: null };
    }
    return {
      id: source.id,
      title: source.title,
      kind: source.kind,
      name: source.name,
      status: source.status,
      url: source.url || source.passage?.url || '',
      pagePath: this.sourcePagePath(source),
      ...(source.passage ? { passage: source.passage } : {}),
    };
  }

  /** 素材摘要页路径（没有则 null） */
  sourcePagePath(source) {
    if (!source) return null;
    const pages = this._state ? this._state.pages : {};
    for (const rel of normalizeStringArray(source.pages)) {
      if (pages[rel] && pages[rel].type === 'source') return rel;
    }
    for (const page of Object.values(pages)) {
      if (page.type === 'source' && page.sources.includes(source.id)) return page.path;
    }
    return null;
  }

  // -- tree / overview / meta ---------------------------------------------

  /** Return a safe parent for read paths, including externally edited Markdown. */
  _publicTopicParent(page) {
    if (!page || page.type !== 'topic' || !page.topicParent) return '';
    const pages = this._state ? this._state.pages : {};
    const seen = new Set([page.path]);
    let current = page.topicParent;
    while (current) {
      if (seen.has(current) || !pages[current] || pages[current].type !== 'topic') return '';
      seen.add(current);
      current = pages[current].topicParent || '';
    }
    return page.topicParent;
  }

  _validateTopicParent(rel, value) {
    if (typeof value !== 'string') throw new KbError('BAD_REQUEST', 'topicParent 必须是主题页面路径或空字符串');
    if (!value.trim()) return '';
    const { rel: parent } = this._resolvePagePath(value.trim());
    const pages = this._state.pages;
    if (!pages[parent] || pages[parent].type !== 'topic') throw new KbError('BAD_REQUEST', '上位主题不存在或不是主题页');
    const seen = new Set([rel]);
    let current = parent;
    while (current) {
      if (seen.has(current)) throw new KbError('CONFLICT', '主题层级不能形成循环');
      seen.add(current);
      const entry = pages[current];
      if (!entry || entry.type !== 'topic') throw new KbError('BAD_REQUEST', '上位主题层级包含不存在的主题');
      current = entry.topicParent || '';
    }
    return parent;
  }

  /** Promote direct children when a parent is deleted; preserve their Markdown. */
  async _detachMissingTopicParentsUnlocked() {
    for (const page of Object.values(this._state.pages)) {
      if (page.type !== 'topic' || !page.topicParent) continue;
      const parent = this._state.pages[page.topicParent];
      if (!parent || parent.type !== 'topic') await this._rewritePageFrontmatterUnlocked(page.path, { topicParent: '' });
    }
  }

  /** Create a user-maintained topic container without inventing source evidence. */
  async createTopic(input) {
    await this.ensureState();
    const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return this._withLock(async () => {
      if (!(await this.isInitialized())) throw new KbError('NOT_FOUND', '知识库尚未初始化');
      if (typeof payload.title !== 'string' || !payload.title.trim() || payload.title.trim().length > 200) {
        throw new KbError('BAD_REQUEST', '主题标题需为 1~200 字');
      }
      const title = this._cleanTitle(payload.title);
      if (!title) throw new KbError('BAD_REQUEST', '主题标题不能为空');
      if (this._findExistingPage('topic', title, [])) throw new KbError('CONFLICT', '已有同名主题，请选择已有主题');
      const slug = await this._uniqueSlugUnlocked('topics', title);
      const rel = `wiki/topics/${slug}.md`;
      const parent = this._validateTopicParent(rel, payload.parentPath === undefined ? '' : payload.parentPath);
      const timestamp = nowIso();
      await this._writePageFileUnlocked(rel, {
        title, type: 'topic', topicParent: parent, aliases: [], tags: [], sources: [],
        confidence: 'UNVERIFIED', created: timestamp, userEditedAt: timestamp, taxonomyEditedAt: timestamp,
      }, '这是用于组织相关子主题和资料的主题页。可以编辑正文，补充研究范围、关键问题与阅读说明。');
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      await this._appendLogUnlocked('manage', `新建主题《${title}》（${rel}）`);
      await this._saveStateUnlocked();
      return { page: await this.getPage(rel), created: true };
    });
  }

  async meta() {
    await this.ensureState();
    return {
      initialized: await this.isInitialized(),
      rootDir: this.root,
      counts: this.counts(),
      trashCount: await this.trashCount(),
    };
  }

  counts() {
    const pages = Object.values(this._state ? this._state.pages : {});
    const count = (type) => pages.filter((page) => page.type === type).length;
    return {
      sources: Object.keys(this._state ? this._state.sources : {}).length,
      entities: count('entity'),
      topics: count('topic'),
      syntheses: count('synthesis'),
      pages: pages.length,
    };
  }

  stats() {
    const stats = this._state ? this._state.stats : emptyState().stats;
    return { ...stats };
  }

  async getPurpose() {
    await this.ensureState();
    return this._state.purpose || '';
  }

  async overview() {
    await this.ensureState();
    const state = this._state;
    const pages = Object.values(state.pages).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const sources = Object.values(state.sources).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const graph = await this.getGraph();
    return {
      initialized: await this.isInitialized(),
      rootDir: this.root,
      purpose: state.purpose || '',
      stats: this.stats(),
      recentPages: pages.slice(0, 8).map((page) => ({
        path: page.path,
        title: page.title,
        type: page.type,
        updatedAt: page.updatedAt,
        confidence: page.confidence,
        tags: page.tags,
      })),
      recentSources: sources.slice(0, 8).map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        ...(source.kind === 'conversation' ? { conversation: { messageCount: source.conversation?.messageCount || 0, scope: source.conversation?.scope || '', models: source.conversation?.models || [] } } : {}),
        status: source.status,
        createdAt: source.createdAt,
        pages: normalizeStringArray(source.pages),
      })),
      graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      trashCount: await this.trashCount(),
    };
  }

  async tree(options = {}) {
    await this.ensureState();
    const state = this._state;
    const editions = options.library ? await this._sourceVersions() : new Map();
    const groupDefs = [
      ['source', '素材'],
      ['entity', '实体'],
      ['topic', '主题'],
      ['synthesis', '综合'],
    ];
    const groups = groupDefs.map(([type, label]) => ({
      type,
      label,
      items: Object.values(state.pages)
        .filter((page) => page.type === type)
        .sort((a, b) => a.title.localeCompare(b.title, 'zh'))
        .map((page) => ({
          path: page.path,
          title: page.title,
          tags: page.tags,
          confidence: page.confidence,
          updatedAt: page.updatedAt,
          sources: page.sources,
          aliases: page.aliases,
          topicParent: this._publicTopicParent(page),
          entityCategory: page.type === 'entity' ? page.entityCategory || 'other' : '',
          entityCategoryAssigned: page.type === 'entity' && Boolean(page.entityCategory),
          taxonomyEditedAt: page.taxonomyEditedAt || '',
          ...(page.type === 'entity' && sourceForWikiPage(page, state.sources) ? { materialDocument: true } : {}),
        })),
    }));
    const sources = Object.values(state.sources)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((source) => ({
        id: source.id,
        title: source.title,
        kind: source.kind,
        ...(source.kind === 'conversation' ? { conversation: { messageCount: source.conversation?.messageCount || 0, scope: source.conversation?.scope || '', models: source.conversation?.models || [] } } : {}),
        status: source.status,
        name: source.name,
        chars: source.chars,
        createdAt: source.createdAt,
        pages: normalizeStringArray(source.pages),
        url: source.url || '',
        ...(source.passage ? { passage: source.passage } : {}),
        textHash: source.textHash || '',
        pagePath: this.sourcePagePath(source),
        ...(editions.has(source.id) ? { versionCount: editions.get(source.id).length } : {}),
        error: source.error || null,
      }));
    return { initialized: await this.isInitialized(), groups, sources };
  }

  // -- 图谱 ---------------------------------------------------------------

  _liveCeoRelation(relation) {
    const { source, target, sourceCreatedAt, targetCreatedAt } = relation;
    const person = this._state.pages[source];
    const company = this._state.pages[target];
    return acceptsEntityRole(person, 'person') && person.createdAt === sourceCreatedAt
      && acceptsEntityRole(company, 'company') && company.createdAt === targetCreatedAt;
  }

  hasLiveCeoRelation(source) {
    return Boolean(source?.relations?.length && this.sourcePagePath(source)
      && source.relations.some(relation => this._liveCeoRelation(relation)));
  }

  _buildGraph() {
    const state = this._state;
    const pages = Object.values(state.pages);
    const index = this._titleIndex();
    const nodeMap = new Map();
    for (const page of pages) {
      const sources = normalizeStringArray(page.sources);
      nodeMap.set(page.path, {
        id: page.path,
        title: page.title,
        type: page.type,
        path: page.path,
        tags: page.tags.slice(0, 8),
        aliases: normalizeStringArray(page.aliases),
        topicParent: this._publicTopicParent(page),
        entityCategory: page.type === 'entity' ? page.entityCategory || 'other' : '',
        entityCategoryAssigned: page.type === 'entity' && Boolean(page.entityCategory),
        taxonomyEditedAt: page.taxonomyEditedAt || '',
        confidence: page.confidence,
        ...(page.type === 'entity' && sourceForWikiPage(page, state.sources) ? { materialDocument: true } : {}),
        sources,
        // 保留缺失的引用供健康检查定位，但不把它们算作可溯源素材。
        sourceCount: sources.filter((sourceId) => Object.hasOwn(state.sources, sourceId) && Boolean(state.sources[sourceId])).length,
        updatedAt: page.updatedAt || '',
        degree: 0,
      });
    }
    const edges = [];
    const edgeSeen = new Set();
    const neighbors = new Map();
    const addEdge = (source, target, relation, metadata = {}) => {
      if (!source || !target || source === target) return;
      if (!nodeMap.has(source) || !nodeMap.has(target)) return;
      const key = `${relation}\u0000${source}\u0000${target}`;
      if (edgeSeen.has(key)) return;
      edgeSeen.add(key);
      edges.push({ source, target, relation, ...metadata });
      for (const [a, b] of [
        [source, target],
        [target, source],
      ]) {
        if (!neighbors.has(a)) neighbors.set(a, new Set());
        neighbors.get(a).add(b);
      }
    };
    // link 边：正文 [[...]] 解析成功
    for (const page of pages) {
      for (const title of page.links) {
        const target = this._resolveTitle(index, title);
        if (target) addEdge(page.path, target, 'link');
      }
    }
    // derived 边：同一 sourceId 的素材页 ↔ 实体/主题/综合页
    const sourcePages = pages.filter((page) => page.type === 'source');
    for (const sourcePage of sourcePages) {
      const sourceId = sourcePage.sources[0];
      if (!sourceId) continue;
      for (const other of pages) {
        if (other.path === sourcePage.path || other.type === 'source') continue;
        if (other.sources.includes(sourceId)) addEdge(sourcePage.path, other.path, 'derived', { sourceId });
      }
    }
    // Topic membership is explicit organization, kept separate from content references.
    for (const page of pages) {
      const parent = this._publicTopicParent(page);
      if (parent) addEdge(parent, page.path, 'topic');
    }
    const relations = new Map();
    for (const evidence of Object.values(state.sources)) {
      if (!evidence.relations?.length) continue;
      for (const relation of evidence.relations) {
        if (!this._liveCeoRelation(relation)) continue;
        const { source, target } = relation;
        const key = `${source}\u0000${target}`;
        if (!relations.has(key)) relations.set(key, { source, target, sourceIds: new Set() });
        relations.get(key).sourceIds.add(evidence.id);
      }
    }
    for (const { source, target, sourceIds } of relations.values()) {
      const ids = [...sourceIds];
      addEdge(source, target, 'CEO', { sourceIds: ids, sourceRefs: ids.map(id => this._sourceRef(id)) });
    }
    for (const [nodePath, set] of neighbors) {
      const node = nodeMap.get(nodePath);
      if (node) node.degree = set.size;
    }
    return { version: 1, generatedAt: nowIso(), nodes: [...nodeMap.values()], edges };
  }

  /** 读取图谱（懒构建 + 缓存） */
  async getGraph() {
    await this.ensureState();
    if (this._graphCache) return this._graphCache;
    const graph = this._buildGraph();
    this._graphCache = graph;
    try {
      await writeFileAtomic(path.join(this.root, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
    } catch (error) {
      console.warn(`[dsh-kb] 写入 graph.json 失败：${error && error.message ? error.message : error}`);
    }
    return graph;
  }

  async _rebuildGraphUnlocked() {
    const graph = this._buildGraph();
    this._graphCache = graph;
    await writeFileAtomic(path.join(this.root, 'graph.json'), `${JSON.stringify(graph, null, 2)}\n`);
    return graph;
  }

  // -- index.md / log.md ---------------------------------------------------

  async _rebuildIndexUnlocked() {
    const state = this._state;
    const totalSources = Object.keys(state.sources).length;
    const totalPages = Object.values(state.pages).length;
    const lines = [
      '# 知识库索引',
      '',
      `> 由 DSH 知识库插件自动维护 · 最后更新 ${nowIso()} · 素材 ${totalSources} / 页面 ${totalPages}`,
      '',
      '## 研究方向',
      '',
    ];
    const purpose = state.purpose || (await this._readPurposeText());
    lines.push(purpose ? this._firstParagraph(purpose, 200) : '（在面板里补充你的研究方向）', '');
    const groupDefs = [
      ['source', '素材'],
      ['entity', '实体'],
      ['topic', '主题'],
      ['synthesis', '综合'],
    ];
    for (const [type, label] of groupDefs) {
      const pages = Object.values(state.pages)
        .filter((page) => page.type === type)
        .sort((a, b) => a.title.localeCompare(b.title, 'zh'));
      lines.push(`## ${label}（${pages.length}）`, '');
      if (pages.length === 0) {
        lines.push('（暂无）', '');
        continue;
      }
      for (const page of pages) {
        let description = '';
        if (type === 'source') {
          const sourceId = page.sources[0];
          const source = sourceId ? state.sources[sourceId] : null;
          if (source && source.summary) {
            description = ` — ${plainTextExcerpt(source.summary, 80)}（\`${source.id}\`）`;
          } else if (sourceId) {
            description = `（\`${sourceId}\`）`;
          }
        } else {
          const body = await this._readPageBodySafe(page.path);
          const excerpt = plainTextExcerpt(body, 80);
          if (excerpt) description = ` — ${excerpt}`;
        }
        lines.push(`- [[${page.title}]](${page.path})${description}`);
      }
      lines.push('');
    }
    await writeFileAtomic(path.join(this.root, 'index.md'), `${lines.join('\n').replace(/\n+$/, '')}\n`);
  }

  _firstParagraph(text, maxLength) {
    const first = String(text || '')
      .split(/\n\s*\n/)[0]
      .replace(/\s+/g, ' ')
      .trim();
    if (!first) return '';
    if (first.length <= maxLength) return first;
    return `${first.slice(0, maxLength)}…`;
  }

  async _appendLogUnlocked(kind, message) {
    const abs = path.join(this.root, 'log.md');
    let content = LOG_TEMPLATE;
    try {
      const existing = await fsp.readFile(abs, 'utf8');
      if (existing.trim()) content = existing;
    } catch {
      /* 日志不存在：从模板开始 */
    }
    const line = `- ${formatDateTime(new Date())} [${kind}] ${String(message ?? '').replace(/\s+/g, ' ').trim()}`;
    const next = `${content.replace(/\s+$/, '')}\n${line}\n`;
    await writeFileAtomic(abs, next);
  }

  /** 公开追加日志 */
  async appendLog(kind, message) {
    await this.ensureState();
    return this._withLock(async () => {
      await this._appendLogUnlocked(kind, message);
      return { ok: true };
    });
  }

  // -- 搜索 ---------------------------------------------------------------

  /** Stat cache avoids rereading/re-tokenizing unchanged files. Never indexes binary raw files. */
  async _cachedSearchText(rel, markdown = false) {
    const original = markdown ? null : await openRawFile(this.root, rel);
    try {
      let real, stat;
      if (original) {
        ({ abs: real, stat } = original);
      } else {
        const abs = resolveInside(this.root, rel);
        const realRoot = await fsp.realpath(this.root);
        real = await fsp.realpath(abs);
        if (!real.startsWith(realRoot + path.sep)) throw new KbError('BAD_REQUEST', '检索文件路径越界');
        stat = await fsp.stat(real);
        if (!stat.isFile()) throw new KbError('NOT_FOUND', '正文文件不存在');
      }
      const stamp = `${real}:${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${markdown}`;
      const cached = this._fileTextCache.get(rel);
      if (cached?.stamp === stamp) return cached.text;
      const body = original ? await original.handle.readFile('utf8') : await fsp.readFile(real, 'utf8');
      const text = markdown ? parseFrontmatter(body).body : body;
      this._fileTextCache.set(rel, { stamp, text });
      return text;
    } finally {
      await original?.handle.close();
    }
  }

  async _sourceSearchText(source) {
    const candidates = [source.extractedPath, ...(source.kind !== 'file' ? [source.rawPath] : [])];
    for (const rel of new Set(candidates.filter(Boolean))) {
      const conversation = source.kind === 'conversation' && CONVERSATION_TEXT_PATH.test(rel);
      if (!conversation && !/^raw\/(extracted|notes|articles)\//.test(rel)) continue;
      try {
        const text = await this._cachedSearchText(rel);
        if (text.trim()) return text;
      } catch { /* try a text-only fallback */ }
    }
    return '';
  }

  async _sourceVersions() {
    const sources = Object.values(this._state.sources)
      .filter(source => (source.kind === 'url' || source.kind === 'note') && source.chars <= 40000 && normalizeSourceUrl(source.url))
      .sort((a, b) => a.id.localeCompare(b.id));
    const rows = [];
    for (const source of sources) rows.push({ source, text: await this._sourceSearchText(source) });
    return sourceVersionGroups(rows);
  }

  /** Original, summary and notes share a reading surface while retaining their own identities. */
  async sourceDetails(id) {
    await this.ensureState();
    const { sources, pages } = this._state;
    const source = sources[id];
    if (!source) throw new KbError('NOT_FOUND', '素材不存在');
    const summaryPath = source.kind === 'conversation' ? null : this.sourcePagePath(source);
    const summary = summaryPath ? await this.getPage(summaryPath).then(page => ({
      path: page.path, markdown: page.markdown, links: page.links,
    })).catch(() => null) : null;
    const related = source.pages.map(rel => pages[rel]).filter(page => page && page.type !== 'source').map(page => ({
      path: page.path, title: page.title, type: page.type, materialDocument: Boolean(sourceForWikiPage(page, sources)),
    }));
    const versions = (await this._sourceVersions()).get(id) || [];
    const url = normalizeSourceUrl(source.url);
    let excerpts = [], excerptWarning = false;
    if (url) {
      try {
        excerpts = (await this._readExternalPages())
          .filter(page => normalizeSourceUrl(page.sourceUrl || page.article?.url) === url)
          .map(page => ({ path: page.path, text: page.excerptText || '', tags: page.tags || [] }));
      } catch { excerptWarning = true; }
    }
    return { summary, summaryPath, related, excerpts, excerptWarning,
      versions: versions.map(item => ({ id: item.id, title: item.title, kind: item.kind, url: item.url })) };
  }

  async getRetrievalIndex() {
    if (this._retrievalBuilding) return this._retrievalBuilding;
    this._retrievalBuilding = (async () => {
      await this.ensureState();
      const documents = [], warnings = [], activeFiles = new Set();
      // Process in bounded batches to avoid exhausting file descriptors on large libraries.
      const pages = Object.values(this._state.pages);
      for (let i = 0; i < pages.length; i += 16) {
        await Promise.all(pages.slice(i, i + 16).map(async page => {
          try {
            activeFiles.add(page.path);
            const text = await this._cachedSearchText(page.path, true);
            documents.push({ ...page, text, kind: 'wiki' });
          } catch { warnings.push(`知识页暂无法读取：${page.title}`); }
        }));
      }
      if (this._chapterPages) {
        // The provider is owned by BookLibrary; a book never obtains main/excerpt pages.
        for (const page of await this._chapterPages({ forSearch: true })) {
          if (CHAPTER_PATH.test(page.path) && typeof page.text === 'string') documents.push({ ...page, type: 'chapter', kind: 'original', readOnly: true });
        }
      } else {
        for (const source of Object.values(this._state.sources)) {
          [source.extractedPath, source.rawPath].filter(Boolean).forEach(rel => activeFiles.add(rel));
          const text = await this._sourceSearchText(source);
          if (text) documents.push({ path: `source-text/${source.id}.md`, title: source.title || source.name,
            type: 'original', kind: 'original', text, sourceId: source.id, sourceUrl: source.url || source.passage?.url || '',
            tags: source.tags || [], aliases: [], readOnly: true });
          else warnings.push(`素材原文暂无法读取：${source.title || source.name}`);
        }
      }
      try {
        for (const page of await this._readExternalPages()) documents.push({ ...page, text: page.excerptText || page.markdown, kind: 'excerpt' });
      } catch { warnings.push(EXCERPT_WARNING); }
      for (const rel of this._fileTextCache.keys()) if (!activeFiles.has(rel)) this._fileTextCache.delete(rel);
      const stats = this._passageIndex.sync(documents);
      return { index: this._passageIndex, warnings, stats };
    })();
    try { return await this._retrievalBuilding; } finally { this._retrievalBuilding = null; }
  }

  /**
   * 本地 BM25：原文、Wiki 与只读摘抄；按文档合并结果，保留最佳段落入口。
   * @param {string} query
   * @param {{limit?:number,offset?:number,library?:boolean}} [options]
   * @returns {Promise<{total:number, results:Array<object>}>}
   */
  async search(query, options = {}) {
    const raw = typeof query === 'string' ? query.trim() : '';
    if (!raw) throw new KbError('BAD_REQUEST', '搜索词不能为空');
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 100) : 20;
    const { index, warnings } = await this.getRetrievalIndex();
    const library = options.library === true && !this._chapterPages;
    const editions = library ? await this._sourceVersions() : new Map();
    const byUrl = new Map();
    const state = this._state;
    if (library) {
      for (const source of Object.values(state.sources)) {
        const url = normalizeSourceUrl(source.url);
        if (url) byUrl.set(url, source);
      }
    }
    const sourceHits = new Map();
    const hits = index.search(raw, { limit: index.chunks.size, precise: true });
    const seen = new Set();
    const results = [];
    const terms = searchTokens(raw);
    for (const chunk of hits) {
      if (seen.has(chunk.path)) continue;
      seen.add(chunk.path);
      const item = { path: chunk.path, evidencePath: evidencePath(chunk), title: chunk.title, type: chunk.type,
        snippet: this._makeSnippet(chunk.text, terms, 160, raw), score: chunk.score, tags: (chunk.tags || []).slice(0, 8),
        startLine: chunk.startLine, endLine: chunk.endLine, kind: chunk.kind,
        ...(chunk.readOnly ? { readOnly: true } : {}), ...(chunk.article ? { article: chunk.article } : {}),
        ...(chunk.sourceUrl ? { sourceUrl: chunk.sourceUrl } : {}),
      };
      if (!library) {
        results.push(item);
        continue;
      }
      const owner = chunk.kind === 'original' ? state.sources[chunk.sourceId]
        : chunk.kind === 'excerpt' ? byUrl.get(normalizeSourceUrl(chunk.sourceUrl || chunk.article?.url))
        : sourceForWikiPage(state.pages[chunk.path], state.sources);
      if (!owner) {
        results.push(item);
        continue;
      }
      const versions = editions.get(owner.id) || [owner];
      const key = versions[0].id;
      const existing = sourceHits.get(key);
      if (existing) {
        existing.matchCount++;
        if (existing.sourceId !== owner.id && titleKey(owner.title) === titleKey(raw)) {
          Object.assign(existing, item, { title: owner.title, type: 'source', sourceId: owner.id, matchType: item.type });
        }
        continue;
      }
      const group = { ...item, key, title: owner.title || owner.name, type: 'source', sourceId: owner.id,
        matchType: item.type, matchCount: 1, versionCount: versions.length };
      sourceHits.set(key, group);
      results.push(group);
    }
    const offset = library && Number.isSafeInteger(options.offset) ? Math.max(0, options.offset) : 0;
    const end = offset + limit;
    return { total: results.length, results: results.slice(offset, end),
      ...(library ? { nextOffset: end < results.length ? end : null } : {}), ...(warnings.length ? { warnings } : {}) };
  }

  _makeSnippet(body, terms, maxLength, query) {
    const text = String(body || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    const lower = text.toLowerCase();
    const phrase = query.toLowerCase().replace(/\s+/g, ' ');
    let hitIndex = lower.indexOf(phrase);
    let hitLength = phrase.length;
    if (hitIndex === -1) {
      for (const term of terms) {
        const index = lower.indexOf(term);
        if (index !== -1 && (hitIndex === -1 || index < hitIndex)) {
          hitIndex = index;
          hitLength = Math.max(term.length, 1);
        }
      }
    }
    if (hitIndex === -1) {
      return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
    }
    const start = Math.max(0, hitIndex - Math.floor((maxLength - Math.min(hitLength, maxLength)) / 2));
    const end = Math.min(text.length, start + maxLength);
    const snippet = text.slice(start, end).trim();
    return `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`;
  }

  // -- 健康检查 -----------------------------------------------------------

  /**
   * 健康检查（契约 4.1 / 澄清 5）：severity 只能是 error|warning|info。
   * broken-link/empty-page/duplicate-title = warning；missing-source = error；orphan-page = info。
   * @returns {Promise<{issues:Array<object>, summary:{pages:number,links:number,issues:number}}>}
   */
  async healthCheck() {
    await this.ensureState();
    const state = this._state;
    await this._reconcileWithDisk(state);
    this._graphCache = null;
    const pages = Object.values(state.pages);
    const index = this._titleIndex();
    const graph = this._buildGraph();
    const degree = new Map(graph.nodes.map((node) => [node.id, node.degree]));
    const issues = [];
    const titleOwners = new Map();
    let linkTotal = 0;
    for (const page of pages) {
      const body = await this._readPageBodySafe(page.path);
      const links = extractLinkTargets(body);
      linkTotal += links.length;
      for (const title of links) {
        if (!this._resolveTitle(index, title)) {
          issues.push({
            type: 'broken-link',
            severity: 'warning',
            page: page.path,
            detail: `无法解析的链接：[[${title}]]（目标页面尚未创建）`,
          });
        }
      }
      if (body.trim().length < 20) {
        issues.push({
          type: 'empty-page',
          severity: 'warning',
          page: page.path,
          detail: `页面正文少于 20 个字符（当前 ${body.trim().length}）`,
        });
      }
      for (const sourceId of page.sources) {
        if (!state.sources[sourceId]) {
          issues.push({
            type: 'missing-source',
            severity: 'error',
            page: page.path,
            detail: `页面引用的素材不存在：${sourceId}`,
          });
        }
      }
      const names = uniqueStrings([page.title, ...page.aliases]);
      for (const name of names) {
        const key = titleKey(name);
        if (!key) continue;
        const owner = titleOwners.get(key);
        if (owner && owner !== page.path) {
          issues.push({
            type: 'duplicate-title',
            severity: 'warning',
            page: page.path,
            detail: `标题或别名「${name}」与 ${owner} 重复`,
          });
        } else if (!owner) {
          titleOwners.set(key, page.path);
        }
      }
      const pageDegree = degree.get(page.path) || 0;
      if (pageDegree === 0 && pages.length > 1) {
        issues.push({
          type: 'orphan-page',
          severity: 'info',
          page: page.path,
          detail: '该页面没有任何入链或出链',
        });
      }
    }
    return {
      issues,
      summary: { pages: pages.length, links: linkTotal, issues: issues.length },
    };
  }

  // -- 素材登记 / 更新 ----------------------------------------------------

  /**
   * 登记素材（写锁内按 sha256、文本哈希或来源 URL 去重）。
   * v0.4.0：非文件类素材只存一份文本（extractedPath = rawPath）；url 对所有类型都保留
   * （用于按来源 URL 去重）。
   * @param {{kind:string, name?:string, ext?:string, mime?:string, sha256:string, textHash?:string,
   *          bytes?:number, chars?:number, title?:string, url?:string, text?:string, buffer?:Buffer,
   *          warnings?:string[], passage?:{title:string,url:string,translated:boolean}}} record
   * @returns {Promise<{source:object, existed:boolean}>}
   */
  async registerSource(record) {
    await this.ensureState();
    return this._withLock(async () => {
      const state = this._state;
      const sha256 = String((record && record.sha256) || '').trim();
      if (!sha256) throw new KbError('INTERNAL', '缺少素材哈希');
      const text = typeof (record && record.text) === 'string' ? record.text : '';
      const textHash = typeof (record && record.textHash) === 'string' && record.textHash
        ? String(record.textHash)
        : text
          ? sha256Hex(text)
          : '';
      const existing = Object.values(state.sources).find((item) => item.sha256 === sha256);
      if (existing) return { source: { ...existing }, existed: true };
      // A passage is keyed by its own fingerprint. The same words can appear in
      // several articles or in a whole article without sharing the same provenance.
      if (textHash && !record.passage) {
        const duplicateText = Object.values(state.sources).find((item) => !item.passage && item.textHash === textHash);
        if (duplicateText) return { source: { ...duplicateText }, existed: true };
      }
      // The route-level URL check can race another import. Recheck source identity
      // under the same write lock that creates the record, even when edited text differs.
      const sourceUrl = normalizeSourceUrl(record && record.url);
      if (sourceUrl) {
        const duplicateUrl = Object.values(state.sources).find((item) => item.url && normalizeSourceUrl(item.url) === sourceUrl);
        if (duplicateUrl) return {
          source: { ...duplicateUrl }, existed: true, matchedBy: 'url',
          contentChanged: duplicateUrl.textHash !== textHash,
        };
      }
      const kind = ['file', 'url', 'note'].includes(record.kind) ? record.kind : 'file';
      const title = this._cleanTitle(record.title) || this._cleanName(record.name) || '未命名素材';
      const name = this._cleanName(record.name) || title;
      const ext = kind === 'file' ? this._sanitizeExt(record.ext || path.extname(name)) : '';
      const slug = slugify(name || title);
      const hash8 = sha256.slice(0, 8);
      const sourceId = `src_${sha256.slice(0, 10)}`;
      const rawDir = kind === 'file' ? 'raw/documents' : kind === 'url' ? 'raw/articles' : 'raw/notes';
      const rawExt = kind === 'file' ? ext || '.bin' : '.md';
      const rawPath = `${rawDir}/${slug}-${hash8}${rawExt}`;
      // v0.4.0：非文件类素材的 raw 就是归一化文本，只存一份（extractedPath 指向同一路径）。
      const extractedPath = kind === 'file' ? `raw/extracted/${sourceId}.txt` : rawPath;
      if (kind === 'file') {
        const buffer = record.buffer;
        if (!buffer || !buffer.length) throw new KbError('BAD_REQUEST', '文件内容为空');
        await writeFileAtomic(resolveInside(this.root, rawPath), buffer);
        await writeFileAtomic(resolveInside(this.root, extractedPath), text);
      } else {
        await writeFileAtomic(resolveInside(this.root, rawPath), text);
      }
      const source = {
        id: sourceId,
        kind,
        name,
        ext,
        mime: typeof record.mime === 'string' ? record.mime : '',
        sha256,
        textHash,
        bytes: Number.isFinite(record.bytes) ? record.bytes : Buffer.byteLength(text, 'utf8'),
        chars: Number.isFinite(record.chars) ? record.chars : text.length,
        title,
        url: typeof record.url === 'string' ? record.url : '',
        ...(record.passage ? { passage: record.passage } : {}),
        rawPath,
        extractedPath,
        status: 'queued',
        error: null,
        warnings: normalizeStringArray(record.warnings),
        model: '',
        createdAt: nowIso(),
        compiledAt: null,
        pages: [],
        summary: '',
        tags: [],
      };
      state.sources[sourceId] = source;
      this._recomputeStats(state);
      await this._saveStateUnlocked();
      return { source: { ...source }, existed: false };
    });
  }

  /** Save a complete immutable conversation snapshot through the KB's sole writer. */
  _conversationPath(source) {
    return source?.kind === 'conversation' && /^[a-f0-9]{64}$/.test(source.sha256 || '') ? `raw/conversations/${source.sha256}.json` : '';
  }

  async _readConversation(source) {
    const rel = this._conversationPath(source);
    if (!rel) return null;
    try {
      const data = JSON.parse(await readRawText(this.root, rel));
      if (data.version !== 2 || !Array.isArray(data.messages) || data.messages.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.id !== 'string' || typeof m.text !== 'string')) return null;
      const identity = sha256Hex(JSON.stringify({ sessionId: data.sessionId, messages: contentIdentity(data.messages) }));
      return identity === source.sha256 ? data : null;
    } catch { return null; }
  }

  /** Enrich an existing snapshot only after verifying its exact original messages. */
  async enrichConversation(sourceId, record) {
    await this.ensureState();
    return this._withLock(async () => {
      const source = this._state.sources[sourceId];
      if (!source || source.kind !== 'conversation' || source.sha256 !== record.fingerprint || !record.transcript) return false;
      if (await this._readConversation(source)) return true;
      const raw = await this._readSourceTextFromDisk(source);
      if (sha256Hex(raw) !== source.textHash) return false;
      const original = structuredClone(source.conversation);
      const transcript = { ...record.transcript, scope: original.scope, revision: original.revision };
      const rel = this._conversationPath(source);
      try {
        await writeFileAtomic(resolveInside(this.root, rel), JSON.stringify(transcript));
        source.conversation = { ...original, models: record.conversation.models, formatVersion: 2 };
        await this._saveStateUnlocked();
        return true;
      } catch (error) {
        source.conversation = original;
        await fsp.rm(resolveInside(this.root, rel), { force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async saveConversation(record) {
    await this.ensureState();
    return this._withLock(async () => {
      const state = this._state;
      const existing = Object.values(state.sources).find(source => source.kind === 'conversation' && source.sha256 === record.fingerprint);
      if (existing) return { source: { ...existing }, existed: true, pagePath: this.sourcePagePath(existing) };
      const id = `src_${record.fingerprint.slice(0, 24)}`;
      const rawPath = `raw/conversations/${record.fingerprint}.md`;
      const transcriptPath = `raw/conversations/${record.fingerprint}.json`;
      const timestamp = nowIso();
      const before = structuredClone(state);
      try {
      await writeFileAtomic(resolveInside(this.root, rawPath), record.markdown);
      if (record.transcript) await writeFileAtomic(resolveInside(this.root, transcriptPath), JSON.stringify(record.transcript));
      const source = {
        id, kind: 'conversation', name: record.title, title: record.title,
        ext: '.md', mime: 'text/markdown', sha256: record.fingerprint, textHash: sha256Hex(record.markdown),
        bytes: Buffer.byteLength(record.markdown), chars: record.markdown.length,
        url: '', rawPath, extractedPath: rawPath, status: 'ready', error: null,
        warnings: [], model: '', createdAt: timestamp, compiledAt: null, pages: [],
        summary: `DSH 对话 · ${record.conversation.messageCount} 条消息`, tags: ['AI 对话'],
        conversation: record.conversation,
      };
      state.sources[id] = source;
      const page = await this._writeSourcePageUnlocked(id, { title: record.title, markdown: record.markdown, tags: ['AI 对话'] });
      // Verbatim capture does not certify the correctness of the AI's answers.
      await this._rewritePageFrontmatterUnlocked(page.path, { confidence: 'UNVERIFIED' });
      source.pages = [page.path];
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      this._recomputeStats(state);
      await this._saveStateUnlocked();
      try { await this._appendLogUnlocked('conversation', `保存对话《${record.title}》（${record.conversation.messageCount} 条消息）`); }
      catch { /* The durable record is already committed; log failure must not report a failed save. */ }
      return { source: { ...source }, existed: false, pagePath: page.path };
      } catch (error) {
        const createdPages = Object.values(this._state.pages).filter(page => !before.pages[page.path] && page.sources.includes(id));
        this._state = before;
        await Promise.allSettled([fsp.rm(resolveInside(this.root, rawPath), { force: true }), fsp.rm(resolveInside(this.root, transcriptPath), { force: true }), ...createdPages.map(page => fsp.rm(resolveInside(this.root, page.path), { force: true }))]);
        try { await this._rebuildIndexUnlocked(); await this._rebuildGraphUnlocked(); } catch {}
        throw error;
      }
    });
  }

  /**
   * 更新素材记录字段（status/error/model/summary/tags…）。
   * @param {string} sourceId
   * @param {object} patch
   */
  async updateSource(sourceId, patch) {
    await this.ensureState();
    return this._withLock(async () => {
      const state = this._state;
      const id = String(sourceId ?? '').trim();
      const source = state.sources[id];
      if (!source) throw new KbError('NOT_FOUND', `素材不存在：${id}`);
      const next = patch && typeof patch === 'object' ? patch : {};
      const scalarFields = ['kind', 'name', 'ext', 'mime', 'sha256', 'bytes', 'chars', 'title', 'url', 'rawPath', 'extractedPath', 'error', 'model', 'compiledAt', 'summary'];
      for (const key of scalarFields) {
        if (next[key] !== undefined) source[key] = next[key];
      }
      if (next.status !== undefined) {
        const status = String(next.status);
        if (!SOURCE_STATUSES.includes(status)) throw new KbError('BAD_REQUEST', `素材状态不合法：${status}`);
        source.status = status;
      }
      if (next.warnings !== undefined) source.warnings = normalizeStringArray(next.warnings);
      if (next.tags !== undefined) source.tags = normalizeStringArray(next.tags);
      if (next.pages !== undefined) source.pages = normalizeStringArray(next.pages);
      if (next.error === undefined && source.error === undefined) source.error = null;
      this._recomputeStats(state);
      await this._saveStateUnlocked();
      return { ...source };
    });
  }

  /** 某素材关联的全部页面（素材页在前） */
  _pagesForSource(sourceId) {
    const referencing = Object.values(this._state.pages).filter((page) => page.sources.includes(sourceId));
    const sourcePages = referencing.filter((page) => page.type === 'source').map((page) => page.path);
    const others = referencing
      .filter((page) => page.type !== 'source')
      .map((page) => page.path)
      .sort();
    return [...sourcePages, ...others];
  }

  // -- 素材页 / 内容页写入 ------------------------------------------------

  _cleanTitle(value) {
    const text = String(value ?? '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 200);
  }

  _cleanName(value) {
    const text = String(value ?? '')
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim();
    return text.slice(0, 200);
  }

  _cleanSummary(value) {
    const text = String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 400);
  }

  _sanitizeExt(value) {
    const text = String(value ?? '').trim().toLowerCase();
    if (!text) return '';
    return /^\.[a-z0-9]{1,10}$/.test(text) ? text : '';
  }

  _cleanBody(body, title) {
    let text = String(body ?? '').replace(/\r\n?/g, '\n').trim();
    if (!text) return '';
    const lines = text.split('\n');
    // 去掉正文开头的一级标题（title 由 frontmatter 负责，契约 3.2）
    while (lines.length > 0) {
      const first = lines[0].trim();
      if (!first) {
        lines.shift();
        continue;
      }
      if (/^#\s+\S/.test(first)) {
        lines.shift();
        continue;
      }
      break;
    }
    text = lines.join('\n').replace(/^\s+|\s+$/g, '');
    text = text.replace(/\n{3,}/g, '\n\n');
    void title;
    return text;
  }

  /** 保证 slug 在目录内唯一 */
  async _uniqueSlugUnlocked(dirType, title) {
    const base = slugify(title) || 'page';
    let candidate = base;
    let suffix = 2;
    for (;;) {
      const rel = `wiki/${dirType}/${candidate}.md`;
      const occupied = Boolean(this._state.pages[rel]);
      if (!occupied) {
        try {
          await fsp.access(resolveInside(this.root, rel));
        } catch {
          return candidate;
        }
      }
      candidate = `${base}-${suffix}`;
      suffix += 1;
      if (suffix > 500) return `${base}-${Date.now().toString(36)}`;
    }
  }

  /**
   * 写页面文件 + 更新 state.pages。
   * @param {string} rel 相对路径
   * @param {object} frontmatterInput
   * @param {string} body
   */
  async _writePageFileUnlocked(rel, frontmatterInput, body) {
    const abs = resolveInside(this.root, rel);
    const existing = this._state.pages[rel];
    const frontmatter = {
      title: this._cleanTitle(frontmatterInput.title) || (existing && existing.title) || '未命名页面',
      type: normalizeType(frontmatterInput.type) || (existing && existing.type) || this._pageTypeFromPath(rel) || 'entity',
      aliases: normalizeStringArray(frontmatterInput.aliases),
      tags: normalizeStringArray(frontmatterInput.tags),
      confidence: normalizeConfidence(frontmatterInput.confidence, existing ? existing.confidence : 'EXTRACTED'),
      sources: normalizeStringArray(frontmatterInput.sources),
      created:
        normalizeIsoDate(frontmatterInput.created) ||
        (existing && existing.createdAt) ||
        nowIso(),
      updated: normalizeIsoDate(frontmatterInput.updated) || nowIso(),
    };
    const topicParent = Object.hasOwn(frontmatterInput, 'topicParent') ? frontmatterInput.topicParent : existing?.topicParent;
    const category = Object.hasOwn(frontmatterInput, 'entityCategory') ? normalizeEntityCategory(frontmatterInput.entityCategory) : existing?.entityCategory;
    const taxonomyEditedAt = Object.hasOwn(frontmatterInput, 'taxonomyEditedAt') ? normalizeIsoDate(frontmatterInput.taxonomyEditedAt) : existing?.taxonomyEditedAt;
    if (frontmatter.type === 'topic') frontmatter.topicParent = typeof topicParent === 'string' ? topicParent : '';
    if (frontmatter.type === 'entity' && category) frontmatter.entityCategory = category;
    if (taxonomyEditedAt) frontmatter.taxonomyEditedAt = taxonomyEditedAt;
    // 手工编辑时间戳持久化到 frontmatter（state 丢失后重建仍可保留）
    const userEditedAt =
      normalizeIsoDate(frontmatterInput.userEditedAt) || (existing && existing.userEditedAt) || '';
    if (userEditedAt) frontmatter.userEditedAt = userEditedAt;
    const cleanBody = this._cleanBody(body, frontmatter.title);
    await writeFileAtomic(abs, serializePageContent(frontmatter, cleanBody));
    const parsed = await this._parsePageFile(abs, rel);
    if (parsed) this._state.pages[rel] = parsed.entry;
    this._graphCache = null;
    return { path: rel, frontmatter, body: cleanBody };
  }

  /** 找同类页面里标题/别名命中的已有页面 */
  _findExistingPage(type, title, aliases) {
    const candidates = new Set([titleKey(title), ...(aliases || []).map(titleKey)].filter(Boolean));
    if (candidates.size === 0) return null;
    for (const page of Object.values(this._state.pages)) {
      if (page.type !== type) continue;
      const names = [page.title, ...page.aliases].map(titleKey).filter(Boolean);
      if (names.some((name) => candidates.has(name))) return page.path;
    }
    return null;
  }

  /** 移除正文中同一素材追加的旧区块（重新编译时避免重复堆叠） */
  _removeSectionByMarker(body, sourceId) {
    const text = String(body || '');
    const starts = [...text.matchAll(/^.*<!-- kb-source:([^\s>]+) -->.*$/gm)];
    const ranges = [];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      if (start[1] !== sourceId) continue;
      const nextStart = starts[index + 1]?.index ?? text.length;
      const endMarker = `<!-- kb-source-end:${sourceId} -->`;
      const endIndex = text.indexOf(endMarker, start.index + start[0].length);
      // 旧版本没有结束标记：边界是下一份素材，而不是正文中的任意小标题。
      const end = endIndex !== -1 && endIndex < nextStart ? endIndex + endMarker.length : nextStart;
      ranges.push([start.index, end]);
    }
    let result = text;
    for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + result.slice(end);
    return result.trim();
  }

  /** 追加区块到已有内容页（合并 aliases/tags/sources，保留原正文） */
  async _appendSectionUnlocked(rel, { sourceId, header, markdown, aliases, tags }) {
    const abs = resolveInside(this.root, rel);
    const text = await fsp.readFile(abs, 'utf8');
    const { frontmatter, body } = parseFrontmatter(text);
    const entry = this._state.pages[rel];
    let nextBody = body;
    if (markdown) {
      const markers = [...body.matchAll(/^.*<!-- kb-source:([^\s>]+) -->.*$/gm)];
      const firstMarker = markers[0];
      const migrateFirstSource = sourceId && entry?.sources[0] === sourceId && !entry.userEditedAt;
      const legacyPrefix = migrateFirstSource && (firstMarker ? body.slice(0, firstMarker.index).trim() : body.trim());
      const hasLegacySection = markers.some((marker, index) => {
        const end = body.indexOf(`<!-- kb-source-end:${marker[1]} -->`, marker.index + marker[0].length);
        return end === -1 || end >= (markers[index + 1]?.index ?? body.length);
      });
      // Keep a recoverable copy before replacing any legacy section with incomplete boundaries.
      if (hasLegacySection || legacyPrefix) {
        const backupRel = `.recompile-backups/${sha256Hex(`${rel}\n${text}`)}.md`;
        if (await this._writeIfMissing(backupRel, text)) {
          await this._appendLogUnlocked('migrate', `重编译前保留旧版本：${rel} → ${backupRel}`);
        }
      }
      // An unmarked prefix can belong to the first source of an old generated page.
      const migratedBody = migrateFirstSource ? body.slice(firstMarker?.index ?? body.length) : body;
      const retained = sourceId ? this._removeSectionByMarker(migratedBody, sourceId) : migratedBody;
      const block = `${header}\n\n${markdown.trim()}${sourceId ? `\n\n<!-- kb-source-end:${sourceId} -->` : ''}`;
      nextBody = [retained.trim(), block].filter(Boolean).join('\n\n');
    }
    const mergedAliases = uniqueStrings([
      ...((entry && entry.aliases) || normalizeStringArray(frontmatter.aliases)),
      ...(aliases || []),
    ]);
    const mergedTags = uniqueStrings([
      ...((entry && entry.tags) || normalizeStringArray(frontmatter.tags)),
      ...(tags || []),
    ]);
    const mergedSources = uniqueStrings([
      ...((entry && entry.sources) || normalizeStringArray(frontmatter.sources)),
      ...(sourceId ? [sourceId] : []),
    ]);
    await this._writePageFileUnlocked(
      rel,
      {
        title: (entry && entry.title) || this._cleanTitle(frontmatter.title) || '未命名页面',
        type: (entry && entry.type) || normalizeType(frontmatter.type) || 'entity',
        aliases: mergedAliases,
        tags: mergedTags,
        confidence: entry ? entry.confidence : normalizeConfidence(frontmatter.confidence, 'INFERRED'),
        sources: mergedSources,
        created: (entry && entry.createdAt) || normalizeIsoDate(frontmatter.created) || nowIso(),
      },
      nextBody,
    );
    return { path: rel };
  }

  /** Write a new content page after identity and links have been resolved under the write lock. */
  async _createContentPageUnlocked(input) {
    const { type, title, markdown, sourceId } = input;
    if (markdown.length < 20) throw new KbError('BAD_REQUEST', `页面正文过短：${title}`);
    const dirType = PAGE_TYPE_DIRS[type];
    const slug = await this._uniqueSlugUnlocked(dirType, title);
    const rel = `wiki/${dirType}/${slug}.md`;
    const timestamp = nowIso();
    await this._writePageFileUnlocked(
      rel,
      {
        title,
        type,
        aliases: input.aliases,
        tags: input.tags,
        confidence: normalizeConfidence(input.confidence, 'INFERRED'),
        entityCategory: type === 'entity' ? normalizeEntityCategory(input.entityCategory) : '',
        sources: [sourceId],
        created: timestamp,
        updated: timestamp,
      },
      `<!-- kb-source:${sourceId} -->\n\n${markdown}\n\n<!-- kb-source-end:${sourceId} -->`,
    );
    return rel;
  }

  /** 写素材摘要页（同一 sourceId 只保留一页，重新编译时覆盖正文） */
  async _writeSourcePageUnlocked(sourceId, { title, markdown, tags, preserveEdits = false }) {
    const existing = Object.values(this._state.pages).find(
      (page) => page.type === 'source' && page.sources.includes(sourceId),
    );
    if (preserveEdits && existing?.userEditedAt) {
      return { path: existing.path, title: existing.title, created: false, preserved: true };
    }
    const createdAt = (existing && existing.createdAt) || nowIso();
    let rel = existing ? existing.path : '';
    let created = false;
    if (!rel) {
      const slug = await this._uniqueSlugUnlocked('sources', title);
      rel = `wiki/sources/${slug}.md`;
      created = true;
    }
    await this._writePageFileUnlocked(
      rel,
      {
        title,
        type: 'source',
        aliases: existing ? existing.aliases : [],
        tags: tags && tags.length ? tags : existing ? existing.tags : [],
        confidence: 'EXTRACTED',
        sources: [sourceId],
        created: createdAt,
        updated: nowIso(),
      },
      markdown,
    );
    return { path: rel, title, created, preserved: false };
  }

  /**
   * 构建本次编译的链接解析表：现有页面 title+aliases + 本次新页面 title+aliases + 素材页标题
   * → 规范标题（标题归一：去首尾空白、大小写不敏感、折叠内部空白）。
   * @param {Array<{title:string,aliases?:string[]}>} preparedPages 本次将要写入的新页面
   * @param {string} sourceTitle 本次素材页标题
   * @returns {(title:string)=>string|null}
   */
  _buildCompileLinkResolver(preparedPages, sourceTitle) {
    const map = new Map();
    const add = (name, canonical) => {
      const key = titleKey(name);
      if (!key || map.has(key)) return;
      map.set(key, canonical);
    };
    const current = Object.values(this._state.pages);
    for (const page of current) add(page.title, page.title);
    add(sourceTitle, sourceTitle);
    for (const page of preparedPages) add(page.title, page.title);
    for (const page of [...current, ...preparedPages]) {
      for (const alias of page.aliases || []) add(alias, page.title);
    }
    return (value) => {
      const key = titleKey(value);
      if (!key) return null;
      return map.get(key) || null;
    };
  }

  /**
   * 最终 state 的链接解析表（后置扫描用）：全部页面的 title+aliases（大小写/空白归一）→ 规范标题。
   * @returns {(title:string)=>string|null}
   */
  _buildFinalLinkResolver() {
    return this._buildCompileLinkResolver([], '');
  }

  /**
   * 后置统一扫描（契约 §6.4 验收要求）：一次编译的页面全部写盘后，
   * 读取本次写盘涉及页面的**最终正文**，用最终 state 的解析表再收敛一遍 `[[链接]]`；
   * 有变化则重写页面（同时刷新 state.pages.links），保证正文与 graph/health-check 一致。
   * 幂等：已收敛的内容不会再次变化，也不会重复产生 warning（warnedTargets 跨扫描去重）。
   * @param {Iterable<string>} paths 涉及页面（相对路径）
   * @param {string[]} warnings 告警收集数组
   * @param {Set<string>} warnedTargets 已告警目标
   * @returns {Promise<number>} 被改写的页面数
   */
  async _postConvergePagesUnlocked(paths, warnings, warnedTargets) {
    await this._detachMissingTopicParentsUnlocked();
    const resolveLink = this._buildFinalLinkResolver();
    let changed = 0;
    const seen = new Set();
    for (const rel of paths) {
      if (typeof rel !== 'string' || !rel || seen.has(rel)) continue;
      seen.add(rel);
      let text = '';
      try {
        text = await fsp.readFile(resolveInside(this.root, rel), 'utf8');
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(text);
      const converged = convergeMarkdownLinks(body, resolveLink, warnings, warnedTargets);
      if (converged === body) continue;
      const entry = this._state.pages[rel];
      await this._writePageFileUnlocked(
        rel,
        {
          title: (entry && entry.title) || this._cleanTitle(frontmatter.title) || '未命名页面',
          type: (entry && entry.type) || normalizeType(frontmatter.type) || this._pageTypeFromPath(rel) || 'entity',
          aliases: (entry && entry.aliases) || normalizeStringArray(frontmatter.aliases),
          tags: (entry && entry.tags) || normalizeStringArray(frontmatter.tags),
          confidence: (entry && entry.confidence) || normalizeConfidence(frontmatter.confidence, 'UNVERIFIED'),
          sources: (entry && entry.sources) || normalizeStringArray(frontmatter.sources),
          created: (entry && entry.createdAt) || normalizeIsoDate(frontmatter.created) || nowIso(),
        },
        converged,
      );
      changed += 1;
    }
    return changed;
  }

  _resolveRelationEntity(catalog, name, category) {
    const key = pageIdentityKey(name);
    const matching = catalog.filter(page => acceptsEntityRole(page, category));
    const exact = matching.filter(page => pageIdentityKey(page.title) === key);
    const candidates = exact.length ? exact : matching.filter(page => page.aliases.some(alias => pageIdentityKey(alias) === key));
    if (candidates.length > 1) return null;
    if (candidates.length) return { name, category, page: candidates[0] };

    const nameTaken = title => catalog.some(page => page.type !== 'source'
      && [page.title, ...page.aliases].some(alias => pageIdentityKey(alias) === pageIdentityKey(title)));
    if (!nameTaken(name)) return { name, title: name, category };

    const qualified = `${name}（${category === 'person' ? '人物' : '公司'}）`;
    const named = matching.filter(page => pageIdentityKey(page.title) === pageIdentityKey(qualified));
    if (named.length === 1) return { name, category, page: named[0] };
    return nameTaken(qualified) ? null : { name, title: qualified, category };
  }

  _preparePassageRelations(source, raw, catalog, collect, warnings) {
    if (!source.passage || !Array.isArray(raw)) return [];
    const relations = [];
    for (const relation of raw) {
      if (relation?.relation !== 'CEO' || typeof relation.person !== 'string' || typeof relation.company !== 'string') continue;
      const personName = this._cleanTitle(relation.person);
      const companyName = this._cleanTitle(relation.company);
      if (!personName || !companyName || pageIdentityKey(personName) === pageIdentityKey(companyName)) continue;
      const person = this._resolveRelationEntity(catalog, personName, 'person');
      const company = this._resolveRelationEntity(catalog, companyName, 'company');
      if (!person || !company || person.page && person.page === company.page) {
        warnings.push(`实体名称有歧义，已在素材页保留原文：${personName}、${companyName}`);
        continue;
      }
      for (const endpoint of [person, company]) {
        const title = endpoint.page?.title || endpoint.title;
        endpoint.key = endpoint.page?.path || `new:${pageIdentityKey(title)}`;
        // A preexisting hand-written page is independent of the excerpt's lifecycle.
        if (endpoint.page && (!endpoint.page.sources.length || endpoint.page.sources.includes(source.id))) continue;
        const markdown = `据该选段，${personName} 担任 ${companyName} 的 CEO。\n\n任职关系及出处见知识图谱。`;
        collect({ entityCategory: endpoint.category, confidence: 'EXTRACTED' }, title, 'entity', markdown, endpoint.page);
      }
      relations.push({ person, company });
    }
    return relations;
  }

  /**
   * 落盘一次编译结果（契约 6.6）：
   * 素材页 + 新建/追加内容页 → 更新 state/index/graph/log。
   * @param {string} sourceId
   * @param {object} result compileSource 的返回值
   * @returns {Promise<{pages:Array<{path:string,title:string,type:string}>, created:number, updated:number, warnings:string[]}>}
   */
  async applyCompiledSource(sourceId, result) {
    await this.ensureState();
    return this._withLock(async () => {
      const state = this._state;
      const id = String(sourceId ?? '').trim();
      const source = state.sources[id];
      if (!source) throw new KbError('NOT_FOUND', `素材不存在：${id}`);
      const warnings = [];
      const warnedTargets = new Set();
      const today = formatDate(new Date());
      const payload = result && typeof result === 'object' ? result : {};
      const sourcePageInput = payload.sourcePage && typeof payload.sourcePage === 'object' ? payload.sourcePage : {};
      const sourceTitle = this._cleanTitle(sourcePageInput.title) || source.title || source.name || '未命名素材';
      let sourceMarkdown =
        this._cleanBody(String(sourcePageInput.markdown || ''), sourceTitle) ||
        `**${sourceTitle}**\n\n（该素材暂未生成摘要，可稍后重新编译。）`;
      const sourceSummary = this._cleanSummary(sourcePageInput.summary) || source.summary || '';
      const sourceTags = normalizeStringArray(sourcePageInput.tags);

      // Decide identities again under the lock, then combine all fragments for a destination.
      const catalog = Object.values(state.pages);
      const groups = new Map();
      const collect = (item, title, type, markdown, target) => {
        const key = target?.path || `new:${pageIdentityKey(title)}`;
        const entityCategory = normalizeEntityCategory(item.entityCategory);
        const aliases = normalizeStringArray([title, ...normalizeStringArray(item.aliases)]);
        const tags = normalizeStringArray(item.tags);
        const existing = groups.get(key);
        if (existing) {
          if (existing.type !== type && !comparablePageIdentity(existing, { type, entityCategory })) {
            warnings.push(`忽略指代有歧义的同名页面：${title}`);
            return;
          }
          existing.parts.add(markdown);
          existing.aliases = uniqueStrings([...existing.aliases, ...aliases]);
          existing.tags = uniqueStrings([...existing.tags, ...tags]);
          return;
        }
        groups.set(key, {
          key,
          path: target?.path || '',
          title: target?.title || title,
          type: target?.type || type,
          aliases,
          tags,
          parts: new Set([markdown]),
          confidence: normalizeConfidence(item.confidence, 'INFERRED'),
          entityCategory,
          topicParentPath: typeof item.topicParentPath === 'string' ? item.topicParentPath : '',
          topicParentTitle: typeof item.topicParentTitle === 'string' ? this._cleanTitle(item.topicParentTitle) : '',
        });
      };
      const rawPages = Array.isArray(payload.pages) ? payload.pages : [];
      for (const item of rawPages) {
        try {
          const type = normalizeType(item && item.type);
          if (!type || type === 'source') {
            warnings.push(`忽略非法页面类型：${item && item.type}`);
            continue;
          }
          const title = this._cleanTitle(item.title);
          if (!title) {
            warnings.push('忽略缺少标题的页面');
            continue;
          }
          const markdown = this._cleanBody(String(item.markdown || ''), title);
          if (markdown.length < 20) {
            warnings.push(`忽略正文过短的页面《${title}》`);
            continue;
          }
          const target = findPageIdentity(catalog, { title, type, entityCategory: item.entityCategory });
          const key = pageIdentityKey(title);
          if (!target && catalog.some(page => page.type !== 'source'
            && [page.title, ...page.aliases].some(name => pageIdentityKey(name) === key))) {
            warnings.push(`名称有歧义，保留素材摘要中的信息：${title}`);
            continue;
          }
          collect({ ...item, topicParentPath: item.topicParentPath ?? item.topicParent }, title, type, markdown, target);
        } catch (error) {
          warnings.push(`页面《${(item && item.title) || '?'}》预处理失败：${errorMessageOf(error)}`);
        }
      }

      for (const item of Array.isArray(payload.updates) ? payload.updates : []) {
        try {
          if (!item || typeof item.path !== 'string' || !item.path.trim()) continue;
          const { rel } = this._resolvePagePath(item.path);
          const target = state.pages[rel];
          if (!target || (item.targetTitle && pageIdentityKey(item.targetTitle) !== pageIdentityKey(target.title))
            || (item.targetType && item.targetType !== target.type)) {
            warnings.push(`已有页在编译期间发生变化，保留素材摘要中的信息：${item.path}`);
            continue;
          }
          if (target.type === 'source') continue;
          const markdown = this._cleanBody(String(item.markdown || ''), target.title);
          const sourceOnly = item.targetTitle && item.markdown === '';
          if (!sourceOnly && markdown.length < 20) {
            warnings.push(`忽略过短的追加内容：${item.path}`);
            continue;
          }
          collect(item, target.title, target.type, markdown, target);
        } catch (error) {
          warnings.push(`追加更新预处理失败：${errorMessageOf(error)}`);
        }
      }
      const relations = this._preparePassageRelations(source, payload.relations, catalog, collect, warnings);
      if (source.passage && payload.relations?.length && !relations.length) {
        sourceMarkdown += '\n\n## 图谱关系\n\n实体名称有歧义，已保留选段供核对。';
      }
      const preparedPages = [...groups.values()];
      const owners = new Map();
      const reserveName = (name, owner) => {
        const key = pageIdentityKey(name);
        if (!owners.has(key)) owners.set(key, new Set());
        owners.get(key).add(owner);
      };
      for (const page of catalog) {
        reserveName(page.title, page.path);
        for (const alias of page.aliases) reserveName(alias, page.path);
      }
      reserveName(sourceTitle, `source:${id}`);
      for (const page of preparedPages) {
        reserveName(page.title, page.key);
        for (const alias of page.aliases) reserveName(alias, page.key);
      }
      for (const page of preparedPages) {
        page.aliases = page.aliases.filter(alias => titleKey(alias) !== titleKey(page.title)
          && owners.get(pageIdentityKey(alias)).size === 1);
      }
      // Reused pages participate in link resolution, including their verified alternate names.
      const resolveLink = this._buildCompileLinkResolver(preparedPages, sourceTitle);
      sourceMarkdown = convergeMarkdownLinks(sourceMarkdown, resolveLink, warnings, warnedTargets);

      // 本次实际写盘页面集合（防御：不依赖返回值/upsert 分支，写一个记一个）
      const writtenPaths = new Set();

      // ---- 3) 素材摘要页 ----
      const sourcePage = await this._writeSourcePageUnlocked(id, {
        title: sourceTitle,
        markdown: sourceMarkdown,
        tags: sourceTags,
        preserveEdits: source.passage && payload.preserveSourcePage === true,
      });
      writtenPaths.add(sourcePage.path);
      const applied = [{ path: sourcePage.path, title: sourcePage.title, type: 'source' }];
      let createdCount = sourcePage.created ? 1 : 0;
      let updatedCount = sourcePage.created || sourcePage.preserved ? 0 : 1;

      // Write one source block per destination, including when several aliases matched it.
      const taxonomyCandidates = [];
      const writtenPages = new Map();
      for (const page of preparedPages) {
        try {
          const fragments = [...page.parts].filter(Boolean)
            .map(part => convergeMarkdownLinks(part, resolveLink, warnings, warnedTargets));
          const markdown = [...new Set(fragments)].join('\n\n');
          let rel = page.path;
          if (rel) {
            await this._appendSectionUnlocked(rel, {
              sourceId: id,
              header: `## 来自《${sourceTitle}》（${today}） <!-- kb-source:${id} -->`,
              markdown,
              aliases: page.aliases,
              tags: page.tags,
            });
            updatedCount += 1;
          } else {
            rel = await this._createContentPageUnlocked({ ...page, markdown, sourceId: id });
            createdCount += 1;
          }
          writtenPaths.add(rel);
          writtenPages.set(page.key, state.pages[rel]);
          applied.push({ path: rel, title: page.title, type: page.type });
          taxonomyCandidates.push({ ...page, path: rel });
        } catch (error) {
          warnings.push(`页面《${page.title}》写入失败：${errorMessageOf(error)}`);
        }
      }

      // Resolve parent suggestions after all candidate topics exist. Human choices are sticky.
      for (const candidate of taxonomyCandidates) {
        const entry = state.pages[candidate.path];
        if (!entry || entry.taxonomyEditedAt) continue;
        const patch = {};
        if (entry.type === 'entity' && !entry.entityCategory && candidate.entityCategory) patch.entityCategory = candidate.entityCategory;
        if (entry.type === 'topic' && !entry.topicParent && (candidate.topicParentPath || candidate.topicParentTitle)) {
          try {
            const parent = candidate.topicParentPath || this._findExistingPage('topic', candidate.topicParentTitle, []);
            if (!parent) throw new KbError('BAD_REQUEST', '上位主题不存在');
            patch.topicParent = this._validateTopicParent(entry.path, parent);
          } catch (error) {
            warnings.push(`主题《${entry.title}》的层级建议已忽略：${errorMessageOf(error)}`);
          }
        }
        if (Object.keys(patch).length) await this._rewritePageFrontmatterUnlocked(entry.path, patch);
      }

      // ---- 6) 后置统一扫描（全局兜底）：页面全部写盘后，扫描 state.pages 里的**全部页面** ----
      // 先用「本次实际写盘页面 ∪ 本源归属页面」做精确集合，再追加全库扫描：
      // 这样 updates / existingPath 追加、历史遗留、旧版本落盘等任何来源的未解析 [[链接]]
      // 都会被降级（O(页数)，几百页无压力），并顺带治理旧数据。
      // 走到固定点（最多 2 轮）：解析表随 state 变化，第二轮只在确有变化时才会产生写入。
      const touchedPaths = new Set(writtenPaths);
      for (const entry of applied) {
        if (entry && entry.path) touchedPaths.add(entry.path);
      }
      for (const rel of this._pagesForSource(id)) touchedPaths.add(rel);
      for (const rel of Object.keys(state.pages)) touchedPaths.add(rel);
      for (let pass = 0; pass < 2; pass += 1) {
        const changed = await this._postConvergePagesUnlocked(touchedPaths, warnings, warnedTargets);
        if (changed === 0) break;
      }

      // ---- 7) 素材记录 + 索引/图谱/日志 ----
      source.title = sourcePage.title;
      if (!sourcePage.preserved) {
        source.summary = sourceSummary;
        if (sourceTags.length) source.tags = sourceTags;
      }
      source.status = 'ready';
      source.error = null;
      source.model = typeof payload.model === 'string' && payload.model ? payload.model : source.model || '';
      source.compiledAt = nowIso();
      source.warnings = uniqueStrings([...normalizeStringArray(source.warnings), ...warnings]).slice(0, 50);
      source.pages = this._pagesForSource(id);
      if (source.passage) {
        source.relations = relations.flatMap(({ person, company }) => {
          const from = writtenPages.get(person.key) || person.page;
          const to = writtenPages.get(company.key) || company.page;
          if (!from || !to || from.path === to.path) return [];
          return [{
            relation: 'CEO', source: from.path, target: to.path,
            sourceCreatedAt: from.createdAt, targetCreatedAt: to.createdAt,
          }];
        });
      }
      this._recomputeStats(state);
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      await this._appendLogUnlocked(
        'ingest',
        `《${sourceTitle}》 → 新增 ${createdCount} 页 / 更新 ${updatedCount} 页（${id}）`,
      );
      await this._saveStateUnlocked();
      return { pages: applied, created: createdCount, updated: updatedCount, warnings };
    });
  }

  // -- 级联删除 -----------------------------------------------------------

  /**
   * 删除素材：raw 文件、素材页；其它页移除该 source 引用，引用为空的页面删除。
   * @param {string} sourceId
   */
  /**
   * 删除素材的级联主体（须在锁内调用；不做重建/收敛/日志，供单删与批删复用）。
   * @param {string} sourceId
   * @returns {Promise<{id:string,title:string,removedPages:string[],updatedPages:string[]}>}
   */
  async _deleteSourceCascadeUnlocked(sourceId) {
    const state = this._state;
    const id = String(sourceId ?? '').trim();
    const source = state.sources[id];
    if (!source) throw new KbError('NOT_FOUND', `素材不存在：${id}`);
    const title = source.title || source.name || id;
    const removedPages = [];
    const updatedPages = [];
    for (const page of Object.values(state.pages)) {
      if (!page.sources.includes(id)) continue;
      if (page.type === 'source') {
        await this._removeFileSafe(page.path);
        delete state.pages[page.path];
        removedPages.push(page.path);
        continue;
      }
      const remaining = page.sources.filter((item) => item !== id);
      if (remaining.length === 0) {
        await this._removeFileSafe(page.path);
        delete state.pages[page.path];
        removedPages.push(page.path);
      } else {
        const isRelationEntity = source.relations?.some(relation =>
          (relation.source === page.path && relation.sourceCreatedAt === page.createdAt)
          || (relation.target === page.path && relation.targetCreatedAt === page.createdAt));
        const body = isRelationEntity ? await this._readPageBody(page.path) : undefined;
        const retained = body === undefined ? undefined : this._removeSectionByMarker(body, id);
        await this._rewritePageFrontmatterUnlocked(page.path, { sources: remaining }, retained);
        updatedPages.push(page.path);
      }
    }
    for (const rel of [source.rawPath, source.extractedPath, this._conversationPath(source)]) {
      if (!rel) continue;
      try {
        await this._removeFileSafe(rel);
      } catch (error) {
        console.warn(`[dsh-kb] 删除素材文件失败：${rel} ${error && error.message ? error.message : error}`);
      }
    }
    delete state.sources[id];
    return { id, title, removedPages, updatedPages };
  }

  /** 删除单个素材（级联、永久；保留给既有 DELETE /source 使用） */
  async deleteSource(sourceId) {
    await this.ensureState();
    return this._withLock(async () => {
      const result = await this._deleteSourceCascadeUnlocked(sourceId);
      // 级联删除/改写页面后，其它页面里指向「已删除页面」的 [[链接]] 会变成断链；
      // 用最终 state 的解析表对剩余全部页面做一次链接收敛，保证 health-check 不出现新的 broken-link。
      const convergeWarnings = [];
      try {
        await this._postConvergePagesUnlocked(Object.keys(this._state.pages), convergeWarnings, new Set());
      } catch (error) {
        console.warn(`[dsh-kb] 删除后的链接收敛失败：${errorMessageOf(error)}`);
      }
      this._recomputeStats(this._state);
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      const convergeNote = convergeWarnings.length > 0 ? `；链接收敛 ${convergeWarnings.length} 条（断链已降级为纯文本）` : '';
      await this._appendLogUnlocked(
        'delete',
        `删除素材《${result.title}》（${result.id}）→ 移除 ${result.removedPages.length} 页 / 更新 ${result.updatedPages.length} 页${convergeNote}`,
      );
      await this._saveStateUnlocked();
      return { deleted: true, removedPages: result.removedPages, updatedPages: result.updatedPages };
    });
  }

  /**
   * 批量删除素材（附录 A.5：1~50 个，一次收敛 + 一次重建）。
   * @param {string[]} idsInput
   * @returns {Promise<{deleted:Array<object>, skipped:Array<object>, converged:number, warnings:string[]}>}
   */
  async deleteSources(idsInput) {
    await this.ensureState();
    if (!Array.isArray(idsInput)) throw new KbError('BAD_REQUEST', 'ids 必须是数组');
    if (idsInput.length < 1 || idsInput.length > SOURCE_BATCH_LIMIT) {
      throw new KbError('BAD_REQUEST', `一次删除素材 1~${SOURCE_BATCH_LIMIT} 个`);
    }
    return this._withLock(async () => {
      const state = this._state;
      const deleted = [];
      const skipped = [];
      const seen = new Set();
      for (const rawId of idsInput) {
        const id = String(rawId ?? '').trim();
        if (!id) {
          skipped.push({ id: '', reason: 'invalid-id' });
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        if (!state.sources[id]) {
          skipped.push({ id, reason: 'not-found' });
          continue;
        }
        const result = await this._deleteSourceCascadeUnlocked(id);
        deleted.push({
          id: result.id,
          title: result.title,
          removedPages: result.removedPages.length,
          updatedPages: result.updatedPages.length,
        });
      }
      const warnings = [];
      if (deleted.length > 0) {
        await this._postConvergePagesUnlocked(Object.keys(state.pages), warnings, new Set());
        this._recomputeStats(state);
        await this._rebuildIndexUnlocked();
        await this._rebuildGraphUnlocked();
        const removed = deleted.reduce((sum, item) => sum + item.removedPages, 0);
        const updated = deleted.reduce((sum, item) => sum + item.updatedPages, 0);
        const convergeNote = warnings.length > 0 ? `；链接收敛 ${warnings.length} 条` : '';
        await this._appendLogUnlocked(
          'manage',
          `批量删除素材 ${deleted.length} 个（跳过 ${skipped.length} 个）→ 移除 ${removed} 页 / 更新 ${updated} 页${convergeNote}`,
        );
        await this._saveStateUnlocked();
      }
      return { deleted, skipped, converged: warnings.length, warnings };
    });
  }

  async _removeFileSafe(rel) {
    const abs = resolveInside(this.root, rel);
    try {
      await fsp.unlink(abs);
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      throw error;
    }
  }

  /** 只改 frontmatter 并保留正文 */
  async _rewritePageFrontmatterUnlocked(rel, patch, markdown) {
    const abs = resolveInside(this.root, rel);
    const text = await fsp.readFile(abs, 'utf8');
    const { frontmatter, body } = parseFrontmatter(text);
    const entry = this._state.pages[rel];
    const next = { ...frontmatter, ...(patch || {}) };
    await this._writePageFileUnlocked(
      rel,
      {
        title: (entry && entry.title) || this._cleanTitle(next.title) || '未命名页面',
        type: (entry && entry.type) || normalizeType(next.type) || 'entity',
        aliases: normalizeStringArray(next.aliases),
        tags: normalizeStringArray(next.tags),
        confidence: normalizeConfidence(next.confidence, entry ? entry.confidence : 'UNVERIFIED'),
        topicParent: typeof next.topicParent === 'string' ? next.topicParent : entry?.topicParent || '',
        entityCategory: normalizeEntityCategory(next.entityCategory) || entry?.entityCategory || '',
        taxonomyEditedAt: normalizeIsoDate(next.taxonomyEditedAt) || entry?.taxonomyEditedAt || '',
        sources: normalizeStringArray(next.sources),
        created: (entry && entry.createdAt) || normalizeIsoDate(next.created) || nowIso(),
      },
      markdown ?? body,
    );
  }

  // -- 内容管理：页面编辑 / 删除 / 回收站 / 清空（CONTRACT 附录 A） ----------

  /** 回收站索引文件绝对路径 */
  _trashIndexAbs() {
    return path.join(this.root, TRASH_INDEX_FILE);
  }

  /** 读取回收站索引（容错：损坏则视为空） */
  async _readTrashIndexUnlocked() {
    try {
      const text = await fsp.readFile(this._trashIndexAbs(), 'utf8');
      const data = JSON.parse(text);
      if (!Array.isArray(data)) return [];
      return data.filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id);
    } catch {
      return [];
    }
  }

  /** 写入回收站索引（原子写） */
  async _writeTrashIndexUnlocked(items) {
    const list = Array.isArray(items) ? items : [];
    await fsp.mkdir(path.join(this.root, TRASH_DIR), { recursive: true });
    await writeFileAtomic(this._trashIndexAbs(), `${JSON.stringify(list, null, 2)}\n`);
  }

  /** 回收站条目文件绝对路径（文件名白名单校验，防穿越） */
  _trashFileAbs(item) {
    const fileName = item && typeof item.fileName === 'string' ? item.fileName : '';
    if (!/^t_[A-Za-z0-9_]{1,80}\.md$/.test(fileName)) {
      throw new KbError('INTERNAL', `回收站文件名校验失败：${fileName || '（空）'}`);
    }
    return resolveInside(this.root, `${TRASH_DIR}/${fileName}`);
  }

  /** 按 30 天 / 100 条上限清理回收站（超限条目连文件一并清除） */
  async _pruneTrashIndexUnlocked(items) {
    const now = Date.now();
    const alive = [];
    const dropped = [];
    for (const item of Array.isArray(items) ? items : []) {
      const time = Date.parse(item && item.deletedAt ? item.deletedAt : '');
      if (!item || !item.id || !Number.isFinite(time) || now - time > TRASH_TTL_MS) {
        dropped.push(item);
        continue;
      }
      alive.push(item);
    }
    for (const item of alive.slice(TRASH_MAX_ITEMS)) dropped.push(item);
    for (const item of dropped) {
      if (!item || typeof item.fileName !== 'string') continue;
      try {
        await this._removeFileSafe(`${TRASH_DIR}/${item.fileName}`);
      } catch {
        /* 文件可能已不存在 */
      }
    }
    return alive.slice(0, TRASH_MAX_ITEMS);
  }

  /** 把页面移入回收站（须在锁内；不重建、不收敛） */
  async _trashPageUnlocked(rel) {
    const state = this._state;
    const page = state.pages[rel];
    if (!page) throw new KbError('NOT_FOUND', `页面不存在：${rel}`);
    const abs = resolveInside(this.root, rel);
    const text = await fsp.readFile(abs, 'utf8');
    const trashId = `t_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const fileName = `${trashId}.md`;
    await fsp.mkdir(path.join(this.root, TRASH_DIR), { recursive: true });
    await writeFileAtomic(resolveInside(this.root, `${TRASH_DIR}/${fileName}`), text);
    const index = await this._readTrashIndexUnlocked();
    const item = {
      id: trashId,
      path: rel,
      title: page.title,
      type: page.type,
      aliases: page.aliases.slice(),
      tags: page.tags.slice(),
      confidence: page.confidence,
      sources: page.sources.slice(),
      deletedAt: nowIso(),
      fileName,
    };
    index.unshift(item);
    await this._writeTrashIndexUnlocked(await this._pruneTrashIndexUnlocked(index));
    await this._removeFileSafe(rel);
    delete state.pages[rel];
    for (const sourceId of item.sources) {
      const source = state.sources[sourceId];
      if (source) source.pages = this._pagesForSource(sourceId);
    }
    return item;
  }

  /** 回收站列表（A.6：新→旧） */
  async listTrash() {
    await this.ensureState();
    const index = await this._readTrashIndexUnlocked();
    const items = index.map((item) => ({
      id: item.id,
      title: item.title || '',
      path: item.path || '',
      type: item.type || '',
      deletedAt: item.deletedAt || '',
      sourceCount: Array.isArray(item.sources) ? item.sources.length : 0,
    }));
    return { total: items.length, items };
  }

  /** 回收站条数（meta / overview 用） */
  async trashCount() {
    return (await this._readTrashIndexUnlocked()).length;
  }

  /** 校验并读取一个已存在页面（state 缺失时从磁盘补登记） */
  async _requirePageUnlocked(relPath) {
    const { rel, abs } = this._resolvePagePath(relPath);
    if (!this._state.pages[rel]) {
      let text = '';
      try {
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        throw new KbError('NOT_FOUND', `页面不存在：${rel}`);
      }
      const parsed = this._parsePageText(text, rel, null);
      if (!parsed) throw new KbError('NOT_FOUND', `不是知识库页面：${rel}`);
      this._state.pages[rel] = parsed.entry;
    }
    return rel;
  }

  /** 校验 aliases/tags 数组（≤30 项、每项 1~100 字） */
  _validateNameArray(list, label) {
    if (!Array.isArray(list)) throw new KbError('BAD_REQUEST', `${label} 必须是数组`);
    if (list.length > 30) throw new KbError('BAD_REQUEST', `${label} 最多 30 项`);
    for (const item of list) {
      if (typeof item !== 'string') throw new KbError('BAD_REQUEST', `${label} 每项必须是字符串`);
      const value = item.trim();
      if (value.length < 1 || value.length > 100) {
        throw new KbError('BAD_REQUEST', `${label} 每项需为 1~100 字`);
      }
    }
  }

  /** 链接解析表（把当前页面替换为编辑后的标题/别名，用于本页正文收敛） */
  _buildResolverWithOverride(currentPage, overrides) {
    const map = new Map();
    const add = (name, canonical) => {
      const key = titleKey(name);
      if (!key || map.has(key)) return;
      map.set(key, canonical);
    };
    for (const page of Object.values(this._state.pages)) {
      if (page.path === currentPage.path) continue;
      add(page.title, page.title);
      for (const alias of page.aliases) add(alias, page.title);
    }
    add(overrides.title, overrides.title);
    for (const alias of overrides.aliases || []) add(alias, overrides.title);
    return (value) => {
      const key = titleKey(value);
      if (!key) return null;
      return map.get(key) || null;
    };
  }

  /** 全库重写指向旧标题/旧别名的 [[链接]]（保留 |显示文字，丢弃 #锚点；返回改写条数） */
  async _rewriteReferencesUnlocked(editedRel, oldNames, newTitle) {
    const oldKeys = new Map();
    for (const name of oldNames || []) {
      const key = titleKey(name);
      if (key) oldKeys.set(key, name);
    }
    if (oldKeys.size === 0) return 0;
    let rewritten = 0;
    for (const page of Object.values(this._state.pages)) {
      if (page.path === editedRel) continue;
      const abs = resolveInside(this.root, page.path);
      let text = '';
      try {
        text = await fsp.readFile(abs, 'utf8');
      } catch {
        continue;
      }
      const { frontmatter, body } = parseFrontmatter(text);
      if (!body.includes('[[')) continue;
      let changed = 0;
      const nextBody = body.replace(/\[\[([^[\]]+?)\]\]/g, (match, inner) => {
        const raw = String(inner);
        const pipeIndex = raw.indexOf('|');
        const targetPart = pipeIndex === -1 ? raw : raw.slice(0, pipeIndex);
        const display = pipeIndex === -1 ? '' : raw.slice(pipeIndex + 1).trim();
        const target = targetPart.trim();
        if (!target) return match;
        const hashIndex = target.indexOf('#');
        const base = hashIndex > 0 ? target.slice(0, hashIndex).trim() : target;
        if (!oldKeys.has(titleKey(target)) && !oldKeys.has(titleKey(base))) return match;
        changed += 1;
        return display ? `[[${newTitle}|${display}]]` : `[[${newTitle}]]`;
      });
      if (changed === 0) continue;
      const entry = this._state.pages[page.path];
      await this._writePageFileUnlocked(
        page.path,
        {
          title: (entry && entry.title) || this._cleanTitle(frontmatter.title) || '未命名页面',
          type:
            (entry && entry.type) ||
            normalizeType(frontmatter.type) ||
            this._pageTypeFromPath(page.path) ||
            'entity',
          aliases: (entry && entry.aliases) || normalizeStringArray(frontmatter.aliases),
          tags: (entry && entry.tags) || normalizeStringArray(frontmatter.tags),
          confidence: (entry && entry.confidence) || normalizeConfidence(frontmatter.confidence, 'UNVERIFIED'),
          sources: (entry && entry.sources) || normalizeStringArray(frontmatter.sources),
          created: (entry && entry.createdAt) || normalizeIsoDate(frontmatter.created) || nowIso(),
          userEditedAt: (entry && entry.userEditedAt) || normalizeIsoDate(frontmatter.userEditedAt) || '',
        },
        nextBody,
      );
      rewritten += changed;
    }
    return rewritten;
  }

  /**
   * 编辑页面（A.2）：标题/别名/标签/置信度/正文；标题或别名变更时全库重写引用。
   * @param {{path:string,title?:string,aliases?:string[],tags?:string[],confidence?:string,markdown?:string}} input
   */
  async updatePage(input) {
    const payload = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    rejectExcerptMutation(payload.path);
    await this.ensureState();
    return this._withLock(async () => {
      if (!(await this.isInitialized())) throw new KbError('NOT_FOUND', '知识库尚未初始化');
      const editableKeys = ['title', 'aliases', 'tags', 'confidence', 'markdown', 'topicParent', 'entityCategory'];
      if (!editableKeys.some((key) => payload[key] !== undefined)) {
        throw new KbError('BAD_REQUEST', '没有需要修改的字段');
      }
      const state = this._state;
      const rel = await this._requirePageUnlocked(payload.path);
      const current = state.pages[rel];
      const warnings = [];
      const warnedTargets = new Set();
      let text = '';
      try {
        text = await fsp.readFile(resolveInside(this.root, rel), 'utf8');
      } catch {
        throw new KbError('NOT_FOUND', `页面不存在：${rel}`);
      }
      const parsed = parseFrontmatter(text);

      let nextTopicParent = current.topicParent || '';
      if (payload.topicParent !== undefined) {
        if (current.type !== 'topic') throw new KbError('BAD_REQUEST', '只有主题页可以设置上位主题');
        nextTopicParent = this._validateTopicParent(rel, payload.topicParent);
      }
      let nextEntityCategory = current.entityCategory || '';
      if (payload.entityCategory !== undefined) {
        if (current.type !== 'entity') throw new KbError('BAD_REQUEST', '只有实体页可以设置实体分类');
        nextEntityCategory = normalizeEntityCategory(payload.entityCategory);
        if (!nextEntityCategory) throw new KbError('BAD_REQUEST', `实体分类需为 ${ENTITY_CATEGORIES.join('/')}`);
      }
      const taxonomyEditedAt = payload.topicParent !== undefined || payload.entityCategory !== undefined ? nowIso() : current.taxonomyEditedAt || '';

      // ---- 校验 ----
      let nextTitle = current.title;
      if (payload.title !== undefined) {
        if (typeof payload.title !== 'string') throw new KbError('BAD_REQUEST', 'title 必须是字符串');
        const rawTitle = payload.title.trim();
        if (rawTitle.length < 1 || rawTitle.length > 200) throw new KbError('BAD_REQUEST', '标题需为 1~200 字');
        nextTitle = this._cleanTitle(rawTitle);
        if (!nextTitle) throw new KbError('BAD_REQUEST', '标题需为 1~200 字');
      }
      let nextAliases = current.aliases.slice();
      if (payload.aliases !== undefined) {
        this._validateNameArray(payload.aliases, 'aliases');
        nextAliases = normalizeStringArray(payload.aliases);
      }
      let nextTags = current.tags.slice();
      if (payload.tags !== undefined) {
        this._validateNameArray(payload.tags, 'tags');
        nextTags = normalizeStringArray(payload.tags);
      }
      let nextConfidence = current.confidence;
      if (payload.confidence !== undefined) {
        const value = String(payload.confidence).trim().toUpperCase();
        if (!CONFIDENCE_LEVELS.includes(value)) {
          throw new KbError('BAD_REQUEST', `confidence 不合法：${payload.confidence}`);
        }
        nextConfidence = value;
      }
      let nextBody = parsed.body;
      if (payload.markdown !== undefined) {
        if (typeof payload.markdown !== 'string') throw new KbError('BAD_REQUEST', 'markdown 必须是字符串');
        nextBody = this._cleanBody(payload.markdown, nextTitle);
        if (nextBody.length < PAGE_MARKDOWN_MIN) {
          throw new KbError('BAD_REQUEST', `正文至少 ${PAGE_MARKDOWN_MIN} 字`);
        }
        if (nextBody.length > PAGE_MARKDOWN_MAX) {
          throw new KbError('BAD_REQUEST', `正文最多 ${PAGE_MARKDOWN_MAX} 字`);
        }
      }

      // ---- 标题/别名变更：全库重写引用（保留 |显示，丢弃 #锚点） ----
      const titleChanged = titleKey(current.title) !== titleKey(nextTitle);
      const removedAliases = current.aliases.filter(
        (alias) => !nextAliases.some((next) => titleKey(next) === titleKey(alias)),
      );
      const oldNames = uniqueStrings([...(titleChanged ? [current.title] : []), ...removedAliases]).filter(
        (name) => titleKey(name) !== titleKey(nextTitle),
      );
      const rewrittenLinks = await this._rewriteReferencesUnlocked(rel, oldNames, nextTitle);

      // ---- 本页正文链接收敛（解析表使用编辑后的标题/别名） ----
      const resolver = this._buildResolverWithOverride(current, { title: nextTitle, aliases: nextAliases });
      nextBody = convergeMarkdownLinks(nextBody, resolver, warnings, warnedTargets);

      // ---- 写入（state 记录 userEditedAt，并持久化到 frontmatter） ----
      const userEditedAt = nowIso();
      await this._writePageFileUnlocked(
        rel,
        {
          title: nextTitle,
          type: current.type,
          aliases: nextAliases,
          tags: nextTags,
          confidence: nextConfidence,
          topicParent: nextTopicParent,
          entityCategory: nextEntityCategory,
          taxonomyEditedAt,
          sources: current.sources,
          created: current.createdAt,
          userEditedAt,
        },
        nextBody,
      );
      if (current.type === 'source') warnings.push('重新编译该素材会覆盖素材摘要页的手动编辑');

      // ---- 重建 ----
      this._recomputeStats(state);
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      await this._appendLogUnlocked(
        'manage',
        `编辑页面《${nextTitle}》（${rel}）→ 改写引用 ${rewrittenLinks} 条${
          warnings.length ? ` / 链接降级 ${warnings.length} 条` : ''
        }`,
      );
      await this._saveStateUnlocked();
      const updatedEntry = state.pages[rel] || {};
      return {
        page: {
          path: rel,
          title: nextTitle,
          type: current.type,
          aliases: nextAliases,
          tags: nextTags,
          confidence: nextConfidence,
          topicParent: nextTopicParent,
          entityCategory: current.type === 'entity' ? nextEntityCategory || 'other' : '',
          entityCategoryAssigned: current.type === 'entity' && Boolean(nextEntityCategory),
          taxonomyEditedAt,
          markdown: nextBody,
          updatedAt: updatedEntry.updatedAt || nowIso(),
          userEditedAt,
        },
        rewrittenLinks,
        warnings,
      };
    });
  }

  /**
   * 删除单个页面 → 回收站（A.3）；source 摘要页禁止按页删除。
   * @param {string} relPath
   */
  async deletePage(relPath) {
    rejectExcerptMutation(relPath);
    await this.ensureState();
    return this._withLock(async () => {
      if (!(await this.isInitialized())) throw new KbError('NOT_FOUND', '知识库尚未初始化');
      const rel = await this._requirePageUnlocked(relPath);
      const page = this._state.pages[rel];
      if (page.type === 'source') {
        throw new KbError('CONFLICT', '素材摘要页请通过删除素材操作');
      }
      const trashed = await this._trashPageUnlocked(rel);
      const warnings = [];
      await this._postConvergePagesUnlocked(Object.keys(this._state.pages), warnings, new Set());
      this._recomputeStats(this._state);
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      const convergeNote = warnings.length > 0 ? `；链接收敛 ${warnings.length} 条` : '';
      await this._appendLogUnlocked(
        'manage',
        `删除页面《${page.title}》（${rel}）→ 回收站 ${trashed.id}${convergeNote}`,
      );
      await this._saveStateUnlocked();
      return {
        trashed: { id: trashed.id, title: page.title, path: rel, type: page.type },
        converged: warnings.length,
        warnings,
      };
    });
  }

  /**
   * 批量删除页面 → 回收站（A.4：1~100；source 页/不存在进 skipped；一次收敛+重建）。
   * @param {string[]} pathsInput
   */
  async deletePages(pathsInput) {
    if (Array.isArray(pathsInput)) pathsInput.forEach(rejectExcerptMutation);
    await this.ensureState();
    if (!Array.isArray(pathsInput)) throw new KbError('BAD_REQUEST', 'paths 必须是数组');
    if (pathsInput.length < 1 || pathsInput.length > PAGE_BATCH_LIMIT) {
      throw new KbError('BAD_REQUEST', `一次删除页面 1~${PAGE_BATCH_LIMIT} 个`);
    }
    return this._withLock(async () => {
      if (!(await this.isInitialized())) throw new KbError('NOT_FOUND', '知识库尚未初始化');
      const state = this._state;
      const deleted = [];
      const skipped = [];
      const seen = new Set();
      for (const rawPath of pathsInput) {
        let rel = '';
        try {
          const resolved = this._resolvePagePath(rawPath);
          rel = resolved.rel;
        } catch {
          skipped.push({ path: typeof rawPath === 'string' ? rawPath : '', reason: 'invalid-path' });
          continue;
        }
        if (seen.has(rel)) continue;
        seen.add(rel);
        try {
          await this._requirePageUnlocked(rel);
        } catch {
          skipped.push({ path: rel, reason: 'not-found' });
          continue;
        }
        const page = state.pages[rel];
        if (page.type === 'source') {
          skipped.push({ path: rel, reason: 'source-page' });
          continue;
        }
        const trashed = await this._trashPageUnlocked(rel);
        deleted.push({ path: rel, title: page.title, trashId: trashed.id });
      }
      const warnings = [];
      if (deleted.length > 0) {
        await this._postConvergePagesUnlocked(Object.keys(state.pages), warnings, new Set());
        this._recomputeStats(state);
        await this._rebuildIndexUnlocked();
        await this._rebuildGraphUnlocked();
        const convergeNote = warnings.length > 0 ? `；链接收敛 ${warnings.length} 条` : '';
        await this._appendLogUnlocked(
          'manage',
          `批量删除页面 ${deleted.length} 个（跳过 ${skipped.length} 个）→ 回收站${convergeNote}`,
        );
        await this._saveStateUnlocked();
      }
      return { deleted, skipped, converged: warnings.length };
    });
  }

  /** 从回收站恢复页面（A.6） */
  async restoreTrash(trashId) {
    await this.ensureState();
    return this._withLock(async () => {
      if (!(await this.isInitialized())) throw new KbError('NOT_FOUND', '知识库尚未初始化');
      const state = this._state;
      const id = String(trashId ?? '').trim();
      if (!id) throw new KbError('BAD_REQUEST', '缺少回收站条目 id');
      const index = await this._readTrashIndexUnlocked();
      const position = index.findIndex((item) => item.id === id);
      if (position === -1) throw new KbError('NOT_FOUND', `回收站条目不存在：${id}`);
      const item = index[position];
      let text = '';
      try {
        text = await fsp.readFile(this._trashFileAbs(item), 'utf8');
      } catch {
        index.splice(position, 1);
        await this._writeTrashIndexUnlocked(index);
        throw new KbError('NOT_FOUND', `回收站文件缺失：${id}`);
      }
      const { frontmatter, body } = parseFrontmatter(text);
      const title =
        this._cleanTitle(frontmatter.title) || this._cleanTitle(item.title) || '已恢复页面';
      const type =
        normalizeType(item.type) ||
        normalizeType(frontmatter.type) ||
        this._pageTypeFromPath(item.path) ||
        'entity';
      const dirType = PAGE_TYPE_DIRS[type] || 'entities';
      const occupied = async (rel) => {
        if (state.pages[rel]) return true;
        try {
          await fsp.access(resolveInside(this.root, rel));
          return true;
        } catch {
          return false;
        }
      };
      let targetRel =
        typeof item.path === 'string' && /^wiki\/[^/]+\/.+\.md$/.test(item.path) ? item.path : '';
      if (!targetRel || (await occupied(targetRel))) {
        const baseSlug = slugify(title) || 'page';
        let candidate = `${baseSlug}-restored`;
        let suffix = 2;
        targetRel = `wiki/${dirType}/${candidate}.md`;
        while (await occupied(targetRel)) {
          targetRel = `wiki/${dirType}/${candidate}-${suffix}.md`;
          suffix += 1;
          if (suffix > 500) {
            targetRel = `wiki/${dirType}/${baseSlug}-restored-${Date.now().toString(36)}.md`;
            break;
          }
        }
      }
      const fmAliases = normalizeStringArray(frontmatter.aliases);
      const fmTags = normalizeStringArray(frontmatter.tags);
      const fmSources = normalizeStringArray(frontmatter.sources);
      const restoredSources = fmSources.length ? fmSources : normalizeStringArray(item.sources);
      // A deleted passage cannot be restored as evidence just because one of its
      // entity pages spent time in the trash.
      const missingSources = type === 'entity' ? restoredSources.filter(sourceId => !Object.hasOwn(state.sources, sourceId)) : [];
      const restoredBody = missingSources.reduce((markdown, sourceId) => this._removeSectionByMarker(markdown, sourceId), body);
      const warnings = [];
      await this._writePageFileUnlocked(
        targetRel,
        {
          title,
          type,
          aliases: fmAliases.length ? fmAliases : item.aliases || [],
          tags: fmTags.length ? fmTags : item.tags || [],
          confidence: normalizeConfidence(frontmatter.confidence, item.confidence || 'UNVERIFIED'),
          sources: restoredSources.filter(sourceId => !missingSources.includes(sourceId)),
          topicParent: type === 'topic' && typeof frontmatter.topicParent === 'string' && this._state.pages[frontmatter.topicParent]?.type === 'topic' && frontmatter.topicParent !== targetRel ? this._publicTopicParent({ path: targetRel, type, topicParent: frontmatter.topicParent }) : '',
          entityCategory: type === 'entity' ? normalizeEntityCategory(frontmatter.entityCategory) : '',
          taxonomyEditedAt: normalizeIsoDate(frontmatter.taxonomyEditedAt) || '',
          created: normalizeIsoDate(frontmatter.created) || nowIso(),
          userEditedAt: normalizeIsoDate(frontmatter.userEditedAt) || '',
        },
        restoredBody,
      );
      if (type === 'entity' && targetRel !== item.path) {
        const restored = state.pages[targetRel];
        for (const evidence of Object.values(state.sources)) {
          for (const relation of evidence.relations || []) {
            if (relation.source === item.path && relation.sourceCreatedAt === restored.createdAt) relation.source = targetRel;
            if (relation.target === item.path && relation.targetCreatedAt === restored.createdAt) relation.target = targetRel;
          }
        }
      }
      index.splice(position, 1);
      await this._writeTrashIndexUnlocked(index);
      try {
        await this._removeFileSafe(`${TRASH_DIR}/${item.fileName}`);
      } catch {
        /* 忽略 */
      }
      await this._postConvergePagesUnlocked(Object.keys(state.pages), warnings, new Set());
      this._recomputeStats(state);
      await this._rebuildIndexUnlocked();
      await this._rebuildGraphUnlocked();
      await this._appendLogUnlocked('manage', `从回收站恢复页面《${title}》→ ${targetRel}`);
      await this._saveStateUnlocked();
      return { page: { path: targetRel, title, type }, restoredTo: targetRel, warnings };
    });
  }

  /** 清空回收站（有 id 清单条，无 id 清全部；A.6） */
  async purgeTrash(trashId) {
    await this.ensureState();
    return this._withLock(async () => {
      const index = await this._readTrashIndexUnlocked();
      const id = trashId === undefined || trashId === null ? '' : String(trashId).trim();
      if (id) {
        const position = index.findIndex((item) => item.id === id);
        if (position === -1) throw new KbError('NOT_FOUND', `回收站条目不存在：${id}`);
        const [item] = index.splice(position, 1);
        try {
          await this._removeFileSafe(`${TRASH_DIR}/${item.fileName}`);
        } catch {
          /* 忽略 */
        }
        await this._writeTrashIndexUnlocked(index);
        await this._appendLogUnlocked('manage', `彻底删除回收站条目《${item.title || item.id}》（${id}）`);
        await this._saveStateUnlocked();
        return { purged: 1 };
      }
      for (const item of index) {
        try {
          await this._removeFileSafe(`${TRASH_DIR}/${item.fileName}`);
        } catch {
          /* 忽略 */
        }
      }
      await this._writeTrashIndexUnlocked([]);
      await this._appendLogUnlocked('manage', `清空回收站（${index.length} 条）`);
      await this._saveStateUnlocked();
      return { purged: index.length };
    });
  }

  // v0.2.2 起移除「清空知识库」功能（resetKb / _countFilesUnder）：用户明确要求去掉该危险操作。
  // 如需重置，请用户手动备份/清理知识库目录后重新初始化（POST /init）。

  // -- purpose ------------------------------------------------------------

  /**
   * 更新研究方向（写 purpose.md 并重建 index）。
   * @param {string} text
   */
  async setPurpose(text) {
    await this.ensureState();
    return this._withLock(async () => {
      const value = String(text ?? '').trim();
      if (value.length > 4000) throw new KbError('BAD_REQUEST', '研究方向最多 4000 字');
      const content = value
        ? `# 研究方向（Purpose）\n\n${value}\n\n---\n\n> 本文件由你维护，DSH 知识库插件不会覆盖你写的内容。\n`
        : PURPOSE_TEMPLATE;
      await writeFileAtomic(path.join(this.root, 'purpose.md'), content);
      this._state.purpose = value;
      this._recomputeStats(this._state);
      await this._rebuildIndexUnlocked();
      await this._appendLogUnlocked('purpose', value ? `更新研究方向（${value.length} 字）` : '清空研究方向');
      await this._saveStateUnlocked();
      return { purpose: value };
    });
  }
}

export { formatDate as kbFormatDate, formatDateTime as kbFormatDateTime };
