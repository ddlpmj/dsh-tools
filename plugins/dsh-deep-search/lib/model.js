/**
 * lib/model.js —— 主题档案 v2 的数据模型、id 规则、规范化、派生、校验与证据链。
 *
 * 契约：CONTRACT.md v2 §3 / §6。
 *
 * 设计约束：
 *  - 纯函数、零依赖：不 import 任何 @deepseek-ai/* 或 npm 包；
 *  - 模型输出不可信：apply* / merge* 先规范化，过滤非法 sourceId / evidenceId / claimId，
 *    只由程序分配 id；模型自报的局部 id 只在同一次输出内部用于映射；
 *  - id 在档案内全局唯一：来源 s1、证据 ev1、论断 c1、问题 q1、理解块 u1、实体 e1、
 *    混淆项 cf1、时间线 t1、议题 d1、讨论项 di1、判断 j1、未知 un1、分支 b1、
 *    缺口 g1、反例 cp1、机制 m1、关联 x1、修订 r…；
 *  - 追溯链：正文断言 → evidence（复述 + 原文片段 + 定位 + 读取范围）→ source；
 *  - fact / claim 没有可用证据时降级为 analysis + confidence=low，并写 basis；
 *  - 派生字段（evidenceStatus、question.coverage、judgment 的证据聚合、independentSources、
 *    usedFor、stats、注释编号）一律由程序计算，不信任模型自报。
 */

export const ARCHIVE_VERSION = 2;

export const ARCHIVE_STATUS = ['draft', 'running', 'done', 'partial', 'failed'];
export const TOPIC_KINDS = ['technology', 'company', 'phenomenon', 'event', 'person', 'concept', 'policy'];
export const IDENTITIES = ['fact', 'claim', 'analysis', 'unknown'];
export const CONFIDENCES = ['high', 'medium', 'low'];
export const STANCES = ['support', 'oppose', 'context'];
export const STRENGTHS = ['primary', 'secondary', 'single-source', 'contested'];
export const READ_SCOPES = ['full-text', 'section', 'abstract', 'snippet', 'transcript'];
export const INDEPENDENCE = ['primary', 'independent', 'syndicated', 'unknown'];
export const SOURCE_KINDS = ['primary', 'report', 'data', 'analysis', 'interview', 'social', 'other'];
export const RELIABILITY = ['high', 'medium', 'low'];
export const DEPTHS = ['quick', 'deep'];
export const LANGUAGES = ['zh', 'en'];
export const INPUT_PURPOSES = ['了解全景', '解释原因', '比较', '核查', '决策'];
export const RELATION_KINDS = ['opens', 'deepens', 'contrasts', 'depends', 'closes'];
export const QUESTION_ROLES = ['definition', 'mechanism', 'evidence', 'political-economy', 'uncertainty', 'context', 'custom'];
export const PRIORITIES = ['high', 'medium', 'low'];
export const WORK_STATUS = ['pending', 'researching', 'done', 'partial', 'failed', 'blocked'];
export const QUESTION_STATUS = ['pending', 'researching', 'done', 'partial', 'failed'];
export const QUESTION_COVERAGE = ['answered', 'partial', 'disputed', 'no-evidence'];
export const MODULE_COVERAGE = ['covered', 'partial', 'missing'];
export const EVIDENCE_STATUS = ['supported', 'limited', 'conflicted', 'unsupported'];
export const CONNECTION_KINDS = ['constraint', 'dependency', 'analogy', 'same-root', 'counterweight'];
export const CONNECTION_STATUS = ['verified', 'suggested', 'unverified'];
export const UNDERSTANDING_KINDS = ['definition', 'purpose', 'how-it-works', 'background', 'confusable', 'fact'];
export const DISCUSSION_IDENTITIES = ['company', 'researcher', 'user', 'media', 'official', 'other'];
export const DISCUSSION_CHANNELS = ['原帖', '采访', '论文', '公告', '报道'];
export const DISAGREEMENT_ORIGINS = ['数据口径', '时间差', '利益相关', '定义差异', '样本差异', '证据缺失'];

/** 模块显示名（缺 title 时的兜底）。 */
const UNDERSTANDING_TITLES = {
  definition: '这是什么',
  purpose: '解决什么问题',
  'how-it-works': '怎样运作',
  background: '必要背景',
  confusable: '容易混淆',
  fact: '基础事实',
};

const MAX_ANYSEARCH_RECORDS = 60;

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_name',
  'spm', 'from', 'source', 'share_token', 'share_source', 'wt.mc_id', 'ref', 'referrer',
]);

const PURPOSE_ALIAS = {
  overview: '了解全景',
  全景: '了解全景',
  landscape: '了解全景',
  explain: '解释原因',
  reason: '解释原因',
  compare: '比较',
  comparison: '比较',
  verify: '核查',
  factcheck: '核查',
  decision: '决策',
  decide: '决策',
};

const STATUS_RANK = { unsupported: 0, limited: 1, conflicted: 1, supported: 2 };
const COVERAGE_RANK = { 'no-evidence': 0, partial: 1, disputed: 2, answered: 3 };

/* ------------------------------------------------------------------ */
/* 基础工具（导出供 pipeline / render / plugin 复用）                   */
/* ------------------------------------------------------------------ */

/** 6 位十六进制。 */
function hex6() {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

/** 8 位 base36。 */
function base36() {
  return Math.random().toString(36).slice(2, 10);
}

/** 日期键 YYYYMMDD（本地时区）。 */
export function dateKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return dateKey(new Date());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** 新档案 id：tp-YYYYMMDD-xxxxxx。 */
export function newTopicId(date = new Date()) {
  return `tp-${dateKey(date)}-${hex6()}`;
}

/** 新任务 id：job-YYYYMMDD-xxxxxx。 */
export function newJobId(date = new Date()) {
  return `job-${dateKey(date)}-${hex6()}`;
}

/** 新修订 id：r-xxxxxx。 */
export function newRevisionId() {
  return `r-${base36()}`;
}

/** ISO 字符串（容错）。 */
export function iso(value, fallback = '') {
  if (typeof value === 'string' && value.trim()) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return new Date(time).toISOString();
    return fallback;
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return fallback;
}

/** now 统一成 ISO。 */
function nowIso(now = new Date()) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  return iso(now, new Date().toISOString());
}

/** 字符串裁剪；超出加省略号。 */
export function clampText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return fallback;
  if (!Number.isFinite(max) || max <= 0 || text.length <= max) return text;
  return `${text.slice(0, max).trim()}…`;
}

/** 数字裁剪。 */
export function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 枚举裁剪。 */
export function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/** URL 归一：仅 http/https，去 fragment，去追踪参数，保留其余 query 顺序。 */
export function canonicalUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  url.hash = '';
  const kept = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.push([key, value]);
  }
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  return url.href;
}

/** 域名（去 www）。 */
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 数组化。 */
export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 去重（保留首个；key 为空则跳过）。 */
export function uniqueBy(list, keyOf) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeAnySearchRecords(records) {
  const normalized = [];
  for (const item of asArray(records)) {
    const raw = asObject(item);
    const content = clampText(raw.content, 6000);
    if (!content) continue;
    normalized.push({
      title: clampText(raw.title, 300, 'AnySearch 数据'),
      content,
      query: clampText(raw.query, 500),
      tag: clampText(raw.tag, 120),
      capturedAt: iso(raw.capturedAt),
    });
  }
  return uniqueBy(normalized, ({ tag, title, content }) => JSON.stringify([tag, title, content]))
    .slice(-MAX_ANYSEARCH_RECORDS);
}

/** 无来源链接的结构化结果单独存档，保留检索信息。 */
export function mergeAnySearchRecords(archive, records, { query, tag, capturedAt } = {}) {
  archive.anySearchRecords = normalizeAnySearchRecords([
    ...asArray(archive.anySearchRecords),
    ...asArray(records).map((record) => ({ ...asObject(record), query, tag, capturedAt })),
  ]);
}

/** 文本安全截断。 */
export function truncateChars(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/** 从文本抽取 id 引用（v2 全局 id 形态）。 */
export function extractRefs(text) {
  if (typeof text !== 'string') return { questions: [], claims: [], evidence: [], sources: [] };
  const unique = (list) => [...new Set(list)];
  return {
    questions: unique(text.match(/\bq\d+\b/g) || []),
    claims: unique(text.match(/\bc\d+(?:\.\d+)?\b/g) || []),
    evidence: unique(text.match(/\bev\d+(?:\.\d+)?\b/g) || []),
    sources: unique(text.match(/\bs\d+\b/g) || []),
  };
}

/* ------------------------------------------------------------------ */
/* 内部小工具                                                           */
/* ------------------------------------------------------------------ */

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asObject(value) {
  return isObject(value) ? value : {};
}

function dedupeStrings(values) {
  const out = [];
  for (const value of asArray(values)) {
    const text = String(value == null ? '' : value);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function joinText(parts, sep = '；') {
  const list = asArray(parts).map((part) => (typeof part === 'string' ? part.trim() : '')).filter(Boolean);
  // 拼接说明时先去掉前一截尾部的句读，避免出现「。；」。
  return list
    .map((part, index) => (index < list.length - 1 ? part.replace(/[。；;，,、\s]+$/u, '') : part))
    .join(sep);
}

/** 只保留集合内、去重后的引用 id。 */
function filterBySet(values, idSet) {
  const out = [];
  for (const value of asArray(values)) {
    const id = String(value == null ? '' : value).trim();
    if (id && idSet.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** 证据原文片段 ≤200 字（截断不超限）。 */
function clampQuote(value) {
  const text = clampText(value, 2000);
  if (!text) return '';
  return text.length <= 200 ? text : `${text.slice(0, 199).trim()}…`;
}

/** 根据 locator / 抓取状态推断读取范围；模型没标时保守取 snippet。 */
function inferReadScope(locator, quote, fetched) {
  const text = `${locator || ''} ${quote || ''}`;
  if (/摘要/.test(text)) return 'abstract';
  if (/摘录|第\s*\d+\s*[段节]|节选/.test(text)) return 'section';
  return fetched ? 'section' : 'snippet';
}

function pickPurpose(value, fallback = '') {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const text = value.trim();
  if (INPUT_PURPOSES.includes(text)) return text;
  return PURPOSE_ALIAS[text.toLowerCase()] || fallback;
}

function normalizeGapText(value) {
  if (typeof value === 'string') return clampText(value, 800);
  if (Array.isArray(value)) {
    return clampText(
      value
        .map((item) => (typeof item === 'string' ? item : asObject(item).text || asObject(item).note))
        .filter(Boolean)
        .join('；'),
      800,
    );
  }
  const item = asObject(value);
  return clampText(item.text || item.note, 800);
}

/**
 * id 分配器：扫描档案里所有已用 id，按前缀递增分配。
 * v1 遗留的 c1.1 / ev1.1 形态照样保留，新 id 用 c1 / ev1 形态，互不冲突。
 */
function createIdAllocator(archive) {
  const used = new Set();
  const collect = (list) => {
    for (const item of asArray(list)) {
      if (item && typeof item.id === 'string' && item.id.trim()) used.add(item.id.trim());
    }
  };
  collect(archive.sources);
  collect(archive.evidence);
  collect(archive.claims);
  collect(archive.questions);
  collect(archive.judgments);
  collect(archive.unknowns);
  collect(archive.branches);
  collect(archive.connections);
  collect(archive.revisions);
  for (const question of asArray(archive.questions)) {
    collect(asObject(question).mechanism);
    collect(asObject(question).counterpoints);
    collect(asObject(question).gaps);
  }
  const understanding = asObject(archive.understanding);
  collect(understanding.blocks);
  collect(understanding.entities);
  collect(understanding.confusables);
  collect(understanding.timeline);
  const discussion = asObject(archive.discussion);
  collect(discussion.issues);
  for (const issue of asArray(discussion.issues)) collect(asObject(issue).items);

  const counters = new Map();
  function maxPlain(prefix) {
    const safe = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${safe}(\\d+)$`);
    let max = 0;
    for (const id of used) {
      const match = pattern.exec(id);
      if (match) max = Math.max(max, Number(match[1]));
    }
    return max;
  }

  function next(prefix) {
    if (!counters.has(prefix)) counters.set(prefix, maxPlain(prefix));
    let n = counters.get(prefix);
    let id;
    do {
      n += 1;
      id = `${prefix}${n}`;
    } while (used.has(id));
    counters.set(prefix, n);
    used.add(id);
    return id;
  }

  return { next, used };
}

/** 更新 updatedAt。 */
function touch(archive, now) {
  archive.updatedAt = nowIso(now);
}

/* ------------------------------------------------------------------ */
/* 来源                                                                 */
/* ------------------------------------------------------------------ */

/** 来源记录规范化（id 由调用方给定）。 */
function normalizeSourceRecord(raw, id, now) {
  const item = asObject(raw);
  const url = canonicalUrl(item.url || item.link || item.canonicalUrl || '');
  const canonical = canonicalUrl(item.canonicalUrl || url) || url;
  return {
    id,
    url,
    canonicalUrl: canonical,
    title: clampText(item.title || item.name || item.headline, 300, url),
    publisher: clampText(item.publisher || item.site || item.site_name, 120, hostOf(url)),
    author: clampText(item.author || item.byline, 160),
    publishedAt: iso(item.publishedAt || item.date || item.published_at, ''),
    retrievedAt: iso(item.retrievedAt, nowIso(now)),
    kind: pickEnum(item.kind, SOURCE_KINDS, 'other'),
    reliability: pickEnum(item.reliability, RELIABILITY, 'medium'),
    independence: pickEnum(item.independence, INDEPENDENCE, 'unknown'),
    originGroupId: clampText(item.originGroupId, 120),
    usedFor: [],
    quote: clampText(item.quote, 600),
    excerpt: clampText(item.excerpt, 8000),
    summary: clampText(item.summary, 1200),
    fetch: {
      ok: Boolean(asObject(item.fetch).ok),
      status: clampNumber(asObject(item.fetch).status, 0, 999, 0),
      chars: clampNumber(asObject(item.fetch).chars, 0, 1000000, 0),
      error: clampText(asObject(item.fetch).error, 400),
    },
    authority: clampNumber(item.authority, 0, 5, 0),
    rank: clampNumber(item.rank, 0, 1000, 0),
  };
}

/**
 * 把本轮检索/精读得到的来源并入档案，并返回「模型侧局部 id → 档案全局 id」映射。
 *
 * 关键点：模型看到的 [s3] 只是本轮证据包里的序号，同一序号在下一阶段可能指向别的来源。
 * 因此先按 canonicalUrl 与档案已有来源对齐，再为真正的新来源分配全局 id。
 */
function prepareSources(archive, sources, now, ids) {
  const map = new Map();
  const list = asArray(sources).filter(isObject);
  if (!list.length) return map;

  const byUrl = new Map();
  const byId = new Map();
  for (const source of asArray(archive.sources)) {
    if (!isObject(source)) continue;
    if (source.canonicalUrl) byUrl.set(source.canonicalUrl, source);
    if (source.url) byUrl.set(source.url, source);
    if (source.id) byId.set(source.id, source);
  }

  for (const item of list) {
    const localId = typeof item.id === 'string' ? item.id.trim() : typeof item.sourceId === 'string' ? item.sourceId.trim() : '';
    const url = canonicalUrl(item.url || item.canonicalUrl || '');
    // 有 URL 的来源只按 URL 对齐：模型/检索轮次里的局部 id（s1、s2…）可能和档案全局 id 重名，
    // 若按 id 对齐会把新来源错误地挂到旧来源上。没有 URL 的占位来源才允许按 id 复用。
    const existing = url ? byUrl.get(url) || null : localId && byId.has(localId) ? byId.get(localId) : null;

    let target;
    if (existing) {
      target = existing;
      // 只补齐空字段，不覆盖已经精读/判定过的元数据。
      const patched = normalizeSourceRecord(item, existing.id, now);
      for (const key of ['title', 'publisher', 'author', 'publishedAt', 'summary', 'quote', 'excerpt', 'kind', 'reliability', 'independence', 'originGroupId']) {
        if (!existing[key] && patched[key]) existing[key] = patched[key];
      }
      if ((!existing.fetch || !existing.fetch.ok) && patched.fetch.status) existing.fetch = patched.fetch;
      if (!existing.url && patched.url) {
        existing.url = patched.url;
        existing.canonicalUrl = patched.canonicalUrl;
      }
      if (!existing.usedFor) existing.usedFor = [];
    } else {
      const record = normalizeSourceRecord(item, ids.next('s'), now);
      // 没有合法 URL 的来源无法被注释打开，直接不收录（引用它的 evidence 会被丢弃）。
      if (!record.url) continue;
      target = record;
      archive.sources.push(target);
      byUrl.set(target.canonicalUrl || target.url, target);
      byUrl.set(target.url, target);
      byId.set(target.id, target);
    }

    if (localId) map.set(localId, target.id);
    if (target.id) map.set(target.id, target.id);
  }
  return map;
}

/** 把 evidence 上的 sourceId / sourceIds 解析成档案全局 id。 */
function resolveSourceRefs(raw, ctx) {
  const item = asObject(raw);
  const candidates = dedupeStrings(asArray(item.sourceIds).concat(item.sourceId ? [item.sourceId] : []));
  const out = [];
  for (const candidate of candidates) {
    const mapped = ctx.sourceMap && ctx.sourceMap.get(candidate);
    const id = mapped || (asArray(ctx.archive.sources).some((source) => source.id === candidate) ? candidate : '');
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 空档案                                                               */
/* ------------------------------------------------------------------ */

/** 空档案：六模块齐全，缺内容时保留模块并写覆盖限制。 */
export function emptyArchive({ query = '', angle = '', depth = 'deep', language = 'zh', now = new Date() } = {}) {
  const at = nowIso(now);
  const date = new Date(at);
  const topicDepth = pickEnum(depth, DEPTHS, 'deep');
  return {
    version: ARCHIVE_VERSION,
    id: newTopicId(date),
    createdAt: at,
    updatedAt: at,
    status: 'draft',

    input: {
      query: clampText(query, 500),
      purpose: '',
      angle: clampText(angle, 500),
      scope: '',
      exclusions: '',
      discussionWindow: '',
      cutoffAt: at,
      language: pickEnum(language, LANGUAGES, 'zh'),
      depth: topicDepth,
      sourceConstraints: '',
    },

    topic: {
      title: clampText(query, 120, '未命名主题'),
      kind: 'concept',
      definition: '',
      scope: '',
      exclusions: '',
      whyNow: '',
      cutoffAt: at,
      depth: topicDepth,
      readingMinutes: 0,
    },

    // 01 这是什么
    understanding: {
      status: 'empty',
      summary: '',
      summaryClaimId: '',
      summaryEvidenceIds: [],
      blocks: [],
      entities: [],
      confusables: [],
      timeline: [],
      coverage: { status: 'missing', note: '', limits: '' },
    },

    // 02 大家在讨论什么
    discussion: {
      scope: {
        window: '',
        platforms: [],
        languages: [],
        materialCount: 0,
        speakerCount: 0,
        limits: '',
        checkedAt: '',
      },
      issues: [],
      coverage: { status: 'missing', note: '', limits: '' },
    },

    // 03 值得深入理解什么
    questions: [],
    claims: [],
    evidence: [],

    // 04 目前能确定什么
    judgments: [],
    unknowns: [],

    // 05 接下来值得查什么
    branches: [],

    connections: [],

    // 06 资料来源
    sources: [],
    anySearchRecords: [],

    revisions: [],
    knowledgeBase: [],

    // 扩展字段：CONTRACT §3 未列、但 §4/§5 synthesis 会产出的内容。
    tensions: [],
    readingNote: '',

    stats: {
      searches: 0,
      fetched: 0,
      llmCalls: 0,
      sourceCount: 0,
      independentSourceCount: 0,
      unjudgedSourceCount: 0,
      claimCount: 0,
      evidenceCount: 0,
      annotationCount: 0,
      durationMs: 0,
      tokensIn: 0,
      tokensOut: 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 阶段 1：理解输入                                                     */
/* ------------------------------------------------------------------ */

/** 应用 framing 输出：只写对象/目的/范围/时间窗口，不碰问题与论断。 */
export function applyFrame(archive, frame) {
  if (!archive) return archive;
  const raw = asObject(frame);
  const topic = asObject(raw.topic);

  if (topic.title !== undefined || raw.title !== undefined) {
    archive.topic.title = clampText(topic.title ?? raw.title, 120, archive.topic.title);
  }
  archive.topic.kind = pickEnum(topic.kind ?? raw.kind, TOPIC_KINDS, archive.topic.kind || 'concept');
  archive.topic.definition = clampText(topic.definition ?? raw.definition, 1200, archive.topic.definition);
  archive.topic.scope = clampText(topic.scope ?? raw.scope, 1200, archive.topic.scope);
  archive.topic.exclusions = clampText(topic.exclusions ?? raw.exclusions, 1200, archive.topic.exclusions);
  archive.topic.whyNow = clampText(topic.whyNow ?? raw.whyNow, 800, archive.topic.whyNow);

  const purpose = pickPurpose(raw.purpose, archive.input.purpose);
  archive.input.purpose = purpose;
  archive.input.scope = clampText(raw.scope ?? topic.scope, 1200, archive.input.scope);
  archive.input.exclusions = clampText(raw.exclusions ?? topic.exclusions, 1200, archive.input.exclusions);
  if (raw.angle !== undefined) archive.input.angle = clampText(raw.angle, 500, archive.input.angle);

  const window = clampText(raw.discussionWindow, 120, archive.input.discussionWindow);
  if (window) {
    archive.input.discussionWindow = window;
    if (!archive.discussion.scope.window) archive.discussion.scope.window = window;
  }

  const cutoff = iso(raw.cutoffAt || raw.today, archive.input.cutoffAt || archive.createdAt);
  if (cutoff) {
    archive.input.cutoffAt = cutoff;
    archive.topic.cutoffAt = cutoff;
  }

  touch(archive, new Date());
  return archive;
}

/* ------------------------------------------------------------------ */
/* 证据入库                                                             */
/* ------------------------------------------------------------------ */

/** 把模型输出里的一条 evidence 落成全局 evidence；无正文或无合法来源时返回 null。 */
function ingestEvidence(raw, ctx) {
  const item = asObject(raw);
  const text = clampText(item.text ?? item.statement ?? item.summary, 1200);
  if (!text) return null;
  const sourceIds = resolveSourceRefs(item, ctx);
  if (!sourceIds.length) return null;

  const locator = clampText(item.locator, 160);
  const quote = clampQuote(item.quote);
  const fetched = sourceIds.some((id) => {
    const source = asArray(ctx.archive.sources).find((entry) => entry.id === id);
    return source && source.fetch && source.fetch.ok && source.excerpt;
  });
  const originGroup = sourceIds
    .map((id) => asArray(ctx.archive.sources).find((entry) => entry.id === id))
    .map((source) => asObject(source).originGroupId)
    .find(Boolean);

  const evidence = {
    id: ctx.ids.next('ev'),
    questionId: ctx.questionId || '',
    module: pickEnum(ctx.module, ['understanding', 'discussion', 'question'], 'question'),
    text,
    quote,
    locator,
    readScope: pickEnum(item.readScope, READ_SCOPES, '') || inferReadScope(locator, quote, fetched),
    identity: pickEnum(item.identity, IDENTITIES, 'analysis'),
    stance: pickEnum(item.stance, STANCES, 'support'),
    sourceIds,
    strength: pickEnum(item.strength, STRENGTHS, 'secondary'),
    independentSources: 0,
    originGroupId: clampText(item.originGroupId, 120, '') || originGroup || '',
    retrievedAt: iso(item.retrievedAt, nowIso(ctx.now)),
    note: clampText(item.note, 400),
  };
  ctx.archive.evidence.push(evidence);
  return evidence;
}

/** 模型侧的局部 evidence id → 全局 id。 */
function resolveEvidenceRefs(values, ctx) {
  const out = [];
  for (const value of asArray(values)) {
    const id = String(value == null ? '' : value).trim();
    if (!id) continue;
    const mapped = ctx.evidenceMap && ctx.evidenceMap.get(id);
    const target = mapped || (asArray(ctx.archive.evidence).some((entry) => entry.id === id) ? id : '');
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

/** 模型侧的局部 claim id → 全局 id。 */
function resolveClaimRefs(values, ctx) {
  const out = [];
  for (const value of asArray(values)) {
    const id = String(value == null ? '' : value).trim();
    if (!id) continue;
    const mapped = ctx.claimMap && ctx.claimMap.get(id);
    const target = mapped || (asArray(ctx.archive.claims).some((entry) => entry.id === id) ? id : '');
    if (target && !out.includes(target)) out.push(target);
  }
  return out;
}

/**
 * 新建一条 claim。模型输出不可信，这里统一做：
 *  - id 由程序分配；
 *  - fact / claim 没有证据时立即降级为 analysis + confidence=low（§4.4）；
 *  - 引用只保留档案里已存在的 evidence id。
 */
function pushClaim(raw, ctx) {
  const item = asObject(raw);
  const statement = clampText(item.statement ?? item.text ?? item.claimText, 800);
  if (!statement) return null;

  const evidenceIds = resolveEvidenceRefs(item.evidenceIds, ctx);
  const opposeEvidenceIds = resolveEvidenceRefs(item.opposeEvidenceIds, ctx).filter((id) => !evidenceIds.includes(id));

  let identity = pickEnum(item.identity, IDENTITIES, 'analysis');
  let confidence = pickEnum(item.confidence, CONFIDENCES, 'medium');
  let basis = clampText(item.basis, 800);
  if (evidenceIds.length === 0) {
    // 没有任何可核查证据的论断不应带高置信度。
    confidence = 'low';
    if (identity === 'fact' || identity === 'claim') {
      identity = 'analysis';
      basis = joinText([basis, '现有材料没有提供可核查证据，按分析处理。']);
    }
  }

  const questionIds = [];
  for (const id of asArray(item.questionIds)) {
    const text = String(id);
    if (asArray(ctx.archive.questions).some((question) => question.id === text) && !questionIds.includes(text)) questionIds.push(text);
  }
  if (ctx.questionId && !questionIds.includes(ctx.questionId)) questionIds.push(ctx.questionId);

  const claim = {
    id: ctx.ids.next('c'),
    questionIds,
    module: pickEnum(item.module, ['understanding', 'discussion', 'question'], ctx.module || 'question'),
    statement,
    identity,
    confidence,
    attribution: clampText(item.attribution, 300),
    scope: clampText(item.scope, 600),
    basis,
    conditions: clampText(item.conditions, 600),
    evidenceIds,
    opposeEvidenceIds,
    evidenceStatus: 'unsupported',
    evidenceStatusOverride: '',
    note: clampText(item.note, 600),
    supersededBy: '',
  };
  ctx.archive.claims.push(claim);
  return claim;
}

/** 由证据推导论断的证据状态（§3.3；程序计算，不采用模型自报）。 */
function derivedClaimStatus(archive, claim) {
  const support = [];
  const oppose = [];
  for (const id of asArray(claim.evidenceIds)) {
    const evidence = asArray(archive.evidence).find((entry) => entry.id === id);
    if (!evidence) continue;
    if (evidence.stance === 'oppose') oppose.push(evidence);
    else support.push(evidence);
  }
  for (const id of asArray(claim.opposeEvidenceIds)) {
    const evidence = asArray(archive.evidence).find((entry) => entry.id === id);
    if (evidence && !oppose.some((item) => item.id === id)) oppose.push(evidence);
  }
  if (!support.length && !oppose.length) return 'unsupported';
  if (oppose.length) return 'conflicted';
  if (support.length <= 1) return 'limited';
  if (support.every((evidence) => evidence.strength === 'single-source')) return 'limited';
  return 'supported';
}

/* ------------------------------------------------------------------ */
/* 阶段 2：基础认识                                                     */
/* ------------------------------------------------------------------ */

/** 应用基础认识的 blocks / entities / confusables / timeline / coverage。 */
function applyUnderstandingData(archive, data, ctx, { append = false } = {}) {
  const raw = asObject(data);
  const rawUnderstanding = isObject(raw.understanding) ? raw.understanding : raw;
  const understanding = archive.understanding;
  const claimIds = [];
  const evidenceIds = [];

  if (!append) {
    understanding.blocks = [];
    understanding.entities = [];
    understanding.confusables = [];
    understanding.timeline = [];
  }

  const blockCandidates = asArray(rawUnderstanding.blocks);
  const allBlockEvidence = [];

  for (const rawBlock of blockCandidates) {
    const item = asObject(rawBlock);
    const kind = pickEnum(item.kind, UNDERSTANDING_KINDS, 'fact');
    const title = clampText(item.title, 120, UNDERSTANDING_TITLES[kind] || '基础说明');
    const text = clampText(item.text, 1600);
    const blockEvidence = [];
    let blockAttribution = clampText(item.attribution, 300);
    for (const rawEvidence of asArray(item.evidence)) {
      const evidenceInput = asObject(rawEvidence);
      const evidence = ingestEvidence(rawEvidence, { ...ctx, module: 'understanding', questionId: '' });
      if (!evidence) continue;
      blockEvidence.push(evidence);
      allBlockEvidence.push(evidence);
      if (!blockAttribution) blockAttribution = clampText(evidenceInput.attribution, 300);
      if (typeof evidenceInput.id === 'string' && evidenceInput.id.trim()) {
        ctx.evidenceMap.set(evidenceInput.id.trim(), evidence.id);
      }
    }

    const block = {
      id: ctx.ids.next('u'),
      kind,
      title,
      text,
      claimIds: [],
      evidenceIds: blockEvidence.map((evidence) => evidence.id),
    };

    if (item.claimText || text) {
      const independent = countIndependentSources(
        archive,
        dedupeStrings(blockEvidence.flatMap((evidence) => evidence.sourceIds)),
      );
      const allFact = blockEvidence.length > 0 && blockEvidence.every((evidence) => evidence.identity === 'fact');
      const identity = allFact && independent >= 1 ? 'fact' : blockAttribution ? 'claim' : 'analysis';
      const statement = clampText(item.claimText, 800, '') || text || (blockEvidence[0] ? blockEvidence[0].text : '');
      const claim = pushClaim(
        {
          statement,
          identity,
          confidence: pickEnum(item.confidence, CONFIDENCES, 'medium'),
          attribution: blockAttribution,
          conditions: item.conditions,
          evidenceIds: blockEvidence.map((evidence) => evidence.id),
          questionIds: [],
          module: 'understanding',
        },
        ctx,
      );
      if (claim) {
        block.claimIds.push(claim.id);
        claimIds.push(claim.id);
      }
    }

    evidenceIds.push(...block.evidenceIds);
    understanding.blocks.push(block);
  }

  // summary：一句话解释，配一条 understanding claim 与前 3 条去重证据。
  if (rawUnderstanding.summary !== undefined) {
    const summary = clampText(rawUnderstanding.summary, 240);
    if (summary) {
      understanding.summary = summary;
      const summaryEvidence = uniqueBy(allBlockEvidence, (evidence) => evidence.id).slice(0, 3);
      const independent = countIndependentSources(
        archive,
        dedupeStrings(summaryEvidence.flatMap((evidence) => evidence.sourceIds)),
      );
      const allFact = summaryEvidence.length > 0 && summaryEvidence.every((evidence) => evidence.identity === 'fact');
      const claim = pushClaim(
        {
          statement: summary,
          identity: allFact && independent >= 1 ? 'fact' : 'analysis',
          confidence: pickEnum(rawUnderstanding.confidence, CONFIDENCES, 'medium'),
          evidenceIds: summaryEvidence.map((evidence) => evidence.id),
          questionIds: [],
          module: 'understanding',
        },
        ctx,
      );
      understanding.summaryClaimId = claim ? claim.id : '';
      understanding.summaryEvidenceIds = summaryEvidence.map((evidence) => evidence.id);
      if (claim) claimIds.push(claim.id);
      evidenceIds.push(...understanding.summaryEvidenceIds);
    }
  }

  // 实体
  for (const rawEntity of asArray(rawUnderstanding.entities)) {
    const item = asObject(rawEntity);
    const name = clampText(item.name, 160);
    if (!name) continue;
    const entity = {
      id: ctx.ids.next('e'),
      name,
      type: pickEnum(item.type, ['company', 'person', 'technology', 'event', 'organization', 'concept'], 'concept'),
      role: clampText(item.role, 300),
      claimIds: filterBySet(item.claimIds, new Set(archive.claims.map((claim) => claim.id))),
      sourceIds: resolveSourceRefs(item, ctx),
    };
    understanding.entities.push(entity);
  }

  // 容易混淆
  for (const rawConfusable of asArray(rawUnderstanding.confusables)) {
    const item = asObject(rawConfusable);
    const term = clampText(item.term, 160);
    if (!term) continue;
    understanding.confusables.push({
      id: ctx.ids.next('cf'),
      term,
      confusedWith: clampText(item.confusedWith, 160),
      note: clampText(item.note, 600),
      sourceIds: resolveSourceRefs(item, ctx),
    });
  }

  // 时间线
  for (const rawPoint of asArray(rawUnderstanding.timeline)) {
    const item = asObject(rawPoint);
    const at = clampText(item.at ?? item.date ?? item.when, 60);
    const text = clampText(item.text ?? item.event, 600);
    if (!at && !text) continue;
    understanding.timeline.push({
      id: ctx.ids.next('t'),
      at,
      text,
      sourceIds: resolveSourceRefs(item, ctx),
    });
  }

  // 覆盖说明
  const rawCoverage = asObject(rawUnderstanding.coverage ?? raw.coverage);
  const coverage = understanding.coverage;
  const missing = asArray(rawCoverage.missing).map((text) => clampText(text, 300)).filter(Boolean);
  const status = pickEnum(rawCoverage.status, MODULE_COVERAGE, '');
  if (status) coverage.status = status;
  if (rawCoverage.note !== undefined) coverage.note = clampText(rawCoverage.note, 1000, coverage.note);
  if (rawCoverage.limits !== undefined) coverage.limits = clampText(rawCoverage.limits, 1000, coverage.limits);
  if (missing.length) coverage.limits = joinText([coverage.limits, `缺口：${missing.join('；')}`]);
  if (coverage.status === 'covered' && !understanding.blocks.length) coverage.status = 'missing';
  understanding.status = coverage.status === 'covered'
    ? 'done'
    : understanding.blocks.length || understanding.summary
      ? 'partial'
      : 'empty';

  return { claimIds, evidenceIds };
}

/** 应用基础认识（外部入口）。 */
export function applyBasics(archive, data, { sources = [], now = new Date() } = {}) {
  if (!archive) return { claimIds: [], evidenceIds: [] };
  const ids = createIdAllocator(archive);
  const sourceMap = prepareSources(archive, sources, now, ids);
  const ctx = {
    archive,
    ids,
    sourceMap,
    module: 'understanding',
    questionId: '',
    evidenceMap: new Map(),
    claimMap: new Map(),
    now,
  };
  const result = applyUnderstandingData(archive, data, ctx);
  touch(archive, now);
  recount(archive);
  return result;
}

/* ------------------------------------------------------------------ */
/* 阶段 3：讨论地图                                                     */
/* ------------------------------------------------------------------ */

function normalizeDiscussionSides(rawSides, ctx) {
  return uniqueBy(
    asArray(rawSides)
      .map((rawSide) => {
        const item = asObject(rawSide);
        const position = clampText(item.position ?? item.stance ?? item.text, 800);
        if (!position) return null;
        return {
          position,
          holders: asArray(item.holders)
            .map((holder) => clampText(typeof holder === 'string' ? holder : asObject(holder).name, 160))
            .filter(Boolean),
          evidenceIds: resolveEvidenceRefs(item.evidenceIds, ctx),
        };
      })
      .filter(Boolean),
    (side) => side.position,
  );
}

function normalizeDisagreement(raw) {
  const item = asObject(raw);
  const originRaw = item.origin;
  const origin = pickEnum(originRaw, DISAGREEMENT_ORIGINS, '');
  const note = clampText(item.note, 800) || (typeof originRaw === 'string' && !origin ? clampText(originRaw, 800) : '');
  return { origin, note };
}

function normalizeDiscussionItem(rawItem, ctx) {
  const item = asObject(rawItem);
  const evidenceList = [];
  for (const rawEvidence of asArray(item.evidence)) {
    const evidence = ingestEvidence(rawEvidence, { ...ctx, module: 'discussion', questionId: '' });
    if (!evidence) continue;
    evidenceList.push(evidence);
    if (isObject(rawEvidence) && typeof rawEvidence.id === 'string' && rawEvidence.id.trim()) {
      ctx.evidenceMap.set(rawEvidence.id.trim(), evidence.id);
    }
  }

  const id = ctx.ids.next('di');
  const speaker = clampText(item.speaker, 160);
  const affiliation = clampText(item.affiliation, 160);
  const view = clampText(item.view ?? item.statement ?? item.text, 1200);
  const basis = clampText(item.basis, 800);
  const evidenceIds = evidenceList.map((evidence) => evidence.id);
  const claimIds = [];

  if (view) {
    const claim = pushClaim(
      {
        statement: view,
        identity: 'claim',
        confidence: pickEnum(item.confidence, CONFIDENCES, 'medium'),
        attribution: joinText([speaker, affiliation], '，'),
        basis,
        evidenceIds,
        questionIds: [],
        module: 'discussion',
      },
      ctx,
    );
    if (claim) claimIds.push(claim.id);
  }

  const sourceIds = dedupeStrings([
    ...resolveSourceRefs(item, ctx),
    ...evidenceList.flatMap((evidence) => evidence.sourceIds),
  ]);

  return {
    id,
    speaker,
    affiliation,
    identity: pickEnum(item.identity, DISCUSSION_IDENTITIES, 'other'),
    at: clampText(item.at ?? item.date, 60),
    channel: clampText(item.channel, 80),
    view,
    basis,
    claimIds,
    evidenceIds,
    sourceIds,
  };
}

/** 应用讨论地图数据；append=true 时合并到已有议题（未知 issueId 忽略）。 */
function applyDiscussionData(archive, data, ctx, { append = false } = {}) {
  const raw = asObject(data);
  const rawDiscussion = isObject(raw.discussion) ? raw.discussion : raw;
  const discussion = archive.discussion;
  const issueIds = [];
  const itemIds = [];

  if (!append) discussion.issues = [];

  // 讨论范围
  const rawScope = asObject(rawDiscussion.scope ?? raw.scope);
  if (Object.keys(rawScope).length) {
    const scope = discussion.scope;
    if (rawScope.window !== undefined) scope.window = clampText(rawScope.window, 120, scope.window);
    if (rawScope.platforms !== undefined) {
      scope.platforms = dedupeStrings(asArray(rawScope.platforms).map((entry) => clampText(entry, 80)).filter(Boolean)).slice(0, 12);
    }
    if (rawScope.languages !== undefined) {
      scope.languages = dedupeStrings(asArray(rawScope.languages).map((entry) => clampText(entry, 40)).filter(Boolean)).slice(0, 12);
    }
    scope.materialCount = clampNumber(rawScope.materialCount, 0, 100000, scope.materialCount);
    scope.speakerCount = clampNumber(rawScope.speakerCount, 0, 100000, scope.speakerCount);
    if (rawScope.limits !== undefined) scope.limits = clampText(rawScope.limits, 1000, scope.limits);
    scope.checkedAt = iso(rawScope.checkedAt, nowIso(ctx.now));
  }
  if (!discussion.scope.window && archive.input.discussionWindow) {
    discussion.scope.window = archive.input.discussionWindow;
  }

  for (const rawIssue of asArray(rawDiscussion.issues ?? raw.issues)) {
    const issueItem = asObject(rawIssue);
    // 追问/补查的议题用 issueId 指向已有议题；初轮议题没有 id，由程序分配。
    const requestedId = typeof issueItem.id === 'string' && issueItem.id.trim()
      ? issueItem.id.trim()
      : typeof issueItem.issueId === 'string' && issueItem.issueId.trim()
        ? issueItem.issueId.trim()
        : '';
    let issue = append && requestedId ? findIssue(archive, requestedId) : null;
    if (append && requestedId && !issue) continue; // 未知 issueId：忽略，避免把内容挂错议题
    if (!issue) {
      issue = {
        id: ctx.ids.next('d'),
        question: '',
        summary: '',
        status: 'missing',
        items: [],
        sides: [],
        disagreement: { origin: '', note: '' },
        gaps: '',
      };
      discussion.issues.push(issue);
      issueIds.push(issue.id);
    }

    issue.question = clampText(issueItem.question ?? issueItem.title, 400, issue.question);
    issue.summary = clampText(issueItem.summary, 800, issue.summary);
    for (const rawItem of asArray(issueItem.items)) {
      const item = normalizeDiscussionItem(rawItem, ctx);
      issue.items.push(item);
      itemIds.push(item.id);
    }
    issue.status = pickEnum(issueItem.status, MODULE_COVERAGE, issue.items.length ? 'partial' : 'missing');
    if (issueItem.sides !== undefined) issue.sides = normalizeDiscussionSides(issueItem.sides, ctx);
    issue.disagreement = normalizeDisagreement(issueItem.disagreement);
    issue.gaps = normalizeGapText(issueItem.gaps);
  }

  // 覆盖说明
  const rawCoverage = asObject(rawDiscussion.coverage ?? raw.coverage);
  const coverage = discussion.coverage;
  if (rawCoverage.status !== undefined) coverage.status = pickEnum(rawCoverage.status, MODULE_COVERAGE, coverage.status);
  if (rawCoverage.note !== undefined) coverage.note = clampText(rawCoverage.note, 1000, coverage.note);
  if (rawCoverage.limits !== undefined) coverage.limits = clampText(rawCoverage.limits, 1000, coverage.limits);
  if (coverage.status === 'covered' && !discussion.issues.some((issue) => issue.items.length > 0)) coverage.status = 'missing';
  if (!append && rawCoverage.status === undefined) {
    coverage.status = discussion.issues.some((issue) => issue.items.length > 0) ? 'covered' : 'missing';
  }

  // 补查 / 追问可能直接给带 issueId 的 items；未知 issueId 由 ingestLooseDiscussionItems 忽略。
  const looseItems = asArray(rawDiscussion.items).concat(rawDiscussion === raw ? [] : asArray(raw.items));
  if (looseItems.length) ingestLooseDiscussionItems(archive, looseItems, ctx);

  return { issueIds, itemIds };
}

/** 应用讨论地图（外部入口）。 */
export function applyDiscussion(archive, data, { sources = [], now = new Date() } = {}) {
  if (!archive) return { issueIds: [], itemIds: [] };
  const ids = createIdAllocator(archive);
  const sourceMap = prepareSources(archive, sources, now, ids);
  const ctx = {
    archive,
    ids,
    sourceMap,
    module: 'discussion',
    questionId: '',
    evidenceMap: new Map(),
    claimMap: new Map(),
    now,
  };
  const result = applyDiscussionData(archive, data, ctx);
  touch(archive, now);
  recount(archive);
  return result;
}

/** 把带 issueId 的讨论项追加到已有议题；未知 issueId 忽略。 */
function ingestLooseDiscussionItems(archive, items, ctx) {
  const itemIds = [];
  for (const rawItem of asArray(items)) {
    const item = asObject(rawItem);
    const issueId = typeof item.issueId === 'string' ? item.issueId.trim() : '';
    if (!issueId) continue;
    const issue = findIssue(archive, issueId);
    if (!issue) continue;
    const normalized = normalizeDiscussionItem(item, ctx);
    issue.items.push(normalized);
    itemIds.push(normalized.id);
  }
  return itemIds;
}

/* ------------------------------------------------------------------ */
/* 覆盖检查与补查                                                       */
/* ------------------------------------------------------------------ */

function applyModuleCoverage(archive, moduleKey, rawCoverage) {
  const raw = asObject(rawCoverage);
  if (!Object.keys(raw).length) return;
  const target = asObject(archive[moduleKey]);
  const coverage = asObject(target.coverage);
  const missing = asArray(raw.missing).map((text) => clampText(text, 300)).filter(Boolean);

  let status = pickEnum(raw.status, MODULE_COVERAGE, '');
  if (moduleKey === 'understanding' && status === 'covered' && !asArray(target.blocks).length) status = 'missing';
  if (moduleKey === 'discussion' && status === 'covered' && !asArray(target.issues).some((issue) => asArray(issue.items).length)) status = 'missing';
  if (status) coverage.status = status;
  if (raw.note !== undefined) coverage.note = clampText(raw.note, 1000, coverage.note);
  if (raw.limits !== undefined) coverage.limits = clampText(raw.limits, 1000, coverage.limits);
  if (missing.length) coverage.limits = joinText([coverage.limits, `缺口：${missing.join('；')}`]);
  target.coverage = coverage;

  if (moduleKey === 'understanding') {
    target.status = coverage.status === 'covered'
      ? 'done'
      : asArray(target.blocks).length || target.summary
        ? 'partial'
        : 'empty';
  }
}

/** 应用覆盖检查结果：只改覆盖状态与限制，不改内容。 */
export function applyCoverage(archive, coverage) {
  if (!archive) return archive;
  const raw = asObject(coverage);
  applyModuleCoverage(archive, 'understanding', raw.understanding);
  applyModuleCoverage(archive, 'discussion', raw.discussion);
  touch(archive, new Date());
  return archive;
}

/** 补查：只追加新增块 / 讨论项，不重写已有内容。 */
export function applySupplement(archive, data, { sources = [], module = 'basics', now = new Date() } = {}) {
  if (!archive) return { claimIds: [], evidenceIds: [] };
  const raw = asObject(data);
  const ids = createIdAllocator(archive);
  const sourceMap = prepareSources(archive, sources, now, ids);
  const ctx = {
    archive,
    ids,
    sourceMap,
    module: module === 'discussion' ? 'discussion' : 'understanding',
    questionId: '',
    evidenceMap: new Map(),
    claimMap: new Map(),
    now,
  };
  const claimStart = archive.claims.length;
  const evidenceStart = archive.evidence.length;

  if (module === 'discussion') {
    const discussion = isObject(raw.discussion) ? raw.discussion : raw;
    if (asArray(discussion.issues).length || asArray(discussion.items).length) {
      applyDiscussionData(archive, { discussion }, ctx, { append: true });
    }
  } else {
    const understanding = isObject(raw.understanding)
      ? raw.understanding
      : { blocks: asArray(raw.blocks), summary: '', coverage: raw.coverage };
    applyUnderstandingData(archive, { understanding, coverage: raw.coverage }, ctx, { append: true });
  }

  touch(archive, now);
  recount(archive);
  return {
    claimIds: archive.claims.slice(claimStart).map((claim) => claim.id),
    evidenceIds: archive.evidence.slice(evidenceStart).map((evidence) => evidence.id),
  };
}

/* ------------------------------------------------------------------ */
/* 阶段 4：问题规划                                                     */
/* ------------------------------------------------------------------ */

function applyPlanningData(archive, data, { append = false } = {}) {
  const raw = asObject(data);
  const ids = createIdAllocator(archive);
  const rawQuestions = asArray(raw.questions).filter(isObject).slice(0, 8);
  if (!append) archive.questions = [];

  const created = [];
  for (const item of rawQuestions) {
    const question = {
      id: ids.next('q'),
      order: archive.questions.length + 1,
      question: clampText(item.question ?? item.title, 300),
      why: clampText(item.why, 600),
      role: pickEnum(item.role, QUESTION_ROLES, 'custom'),
      priority: pickEnum(item.priority, PRIORITIES, 'medium'),
      evidenceNeed: clampText(item.evidenceNeed, 600),
      relation: {
        to: null,
        kind: pickEnum(asObject(item.relation).kind, RELATION_KINDS, created.length === 0 ? 'opens' : 'deepens'),
        note: clampText(asObject(item.relation).note, 400),
      },
      queries: dedupeStrings(asArray(item.queries).map((query) => clampText(query, 160)).filter(Boolean)).slice(0, 4),
      workStatus: 'pending',
      coverage: 'no-evidence',
      coverageHint: '',
      status: 'pending',
      summary: '',
      confidence: 'medium',
      claimIds: [],
      evidenceIds: [],
      mechanism: [],
      counterpoints: [],
      gaps: [],
      branchIds: [],
      entityIds: [],
    };
    if (question.question) {
      archive.questions.push(question);
      created.push({ question, raw: item });
    } else {
      // 空问题浪费 id：直接跳过（id 不复用，避免与模型引用混淆）。
      continue;
    }
  }

  // 关系必须指向本次新建的问题或已有问题，禁止自指。
  const byId = new Map(archive.questions.map((question) => [question.id, question]));
  for (const { question, raw: item } of created) {
    const relation = asObject(item.relation);
    const token = relation.to;
    let targetId = null;
    if (typeof token === 'number' && Number.isInteger(token)) {
      targetId = created[token - 1] ? created[token - 1].question.id : null;
    } else if (typeof token === 'string' && token.trim()) {
      const text = token.trim();
      if (byId.has(text)) targetId = text;
      else if (/^q(\d+)$/.test(text)) {
        const index = Number(text.slice(1)) - 1;
        if (created[index]) targetId = created[index].question.id;
      } else if (text === 'prev' || text === 'previous') {
        const index = created.findIndex((entry) => entry.question === question);
        if (index > 0) targetId = created[index - 1].question.id;
      } else {
        const match = created.find((entry) => entry.question.question === text);
        if (match) targetId = match.question.id;
      }
    }
    question.relation.to = targetId && targetId !== question.id ? targetId : null;
    if (question.relation.to) {
      question.relation.kind = pickEnum(relation.kind, RELATION_KINDS, question.relation.kind || 'deepens');
    }
  }

  return created.map((entry) => entry.question);
}

/** 应用问题规划（外部入口，契约签名两参数；append 供追问新问题内部使用）。 */
export function applyPlanning(archive, data, { append = false } = {}) {
  if (!archive) return archive;
  applyPlanningData(archive, data, { append });
  touch(archive, new Date());
  return archive;
}

/* ------------------------------------------------------------------ */
/* 阶段 5：定向深搜                                                     */
/* ------------------------------------------------------------------ */

/**
 * 合并一个问题的研究单元。
 * unit 里的 evidence / claim id 是本轮局部 id，这里统一重映射成全局 id；
 * 先落证据，再建 claim，最后把 claim 引用回填到机制、反例和问题的聚合字段。
 */
export function mergeResearchUnit(archive, questionId, unit, { sources = [], now = new Date() } = {}) {
  if (!archive) return null;
  const question = findQuestion(archive, String(questionId || ''));
  if (!question) return null;

  const raw = asObject(unit);
  const ids = createIdAllocator(archive);
  const sourceMap = prepareSources(archive, sources, now, ids);
  const ctx = {
    archive,
    ids,
    sourceMap,
    module: 'question',
    questionId: question.id,
    evidenceMap: new Map(),
    claimMap: new Map(),
    now,
  };

  // 1) 证据
  const evidenceList = [];
  for (const rawEvidence of asArray(raw.evidence)) {
    const evidence = ingestEvidence(rawEvidence, ctx);
    if (!evidence) continue;
    evidenceList.push(evidence);
    if (isObject(rawEvidence) && typeof rawEvidence.id === 'string' && rawEvidence.id.trim()) {
      ctx.evidenceMap.set(rawEvidence.id.trim(), evidence.id);
    }
  }

  // 2) 论断
  const claimList = [];
  for (const rawClaim of asArray(raw.claims)) {
    const item = asObject(rawClaim);
    const evidenceIds = resolveEvidenceRefs(item.evidenceIds, ctx);
    const opposeEvidenceIds = resolveEvidenceRefs(item.opposeEvidenceIds, ctx);
    const claim = pushClaim(
      {
        ...item,
        evidenceIds,
        opposeEvidenceIds,
        questionIds: [question.id],
        module: 'question',
      },
      ctx,
    );
    if (!claim) continue;
    claimList.push(claim);
    if (typeof item.id === 'string' && item.id.trim()) ctx.claimMap.set(item.id.trim(), claim.id);
  }

  // 3) 机制
  for (const rawPart of asArray(raw.mechanism)) {
    const item = asObject(rawPart);
    const text = clampText(typeof rawPart === 'string' ? rawPart : item.text, 1600);
    if (!text) continue;
    question.mechanism.push({
      id: ids.next('m'),
      text,
      claimIds: resolveClaimRefs(item.claimIds, ctx),
      evidenceIds: resolveEvidenceRefs(item.evidenceIds, ctx),
    });
  }

  // 4) 反例 / 替代解释
  for (const rawPart of asArray(raw.counterpoints)) {
    const item = asObject(rawPart);
    const text = clampText(typeof rawPart === 'string' ? rawPart : item.text, 1200);
    if (!text) continue;
    question.counterpoints.push({
      id: ids.next('cp'),
      text,
      condition: clampText(item.condition, 400),
      evidenceIds: resolveEvidenceRefs(item.evidenceIds, ctx),
    });
  }

  // 5) 缺口
  for (const rawPart of asArray(raw.gaps)) {
    const item = asObject(rawPart);
    const text = clampText(typeof rawPart === 'string' ? rawPart : item.text, 800);
    if (!text) continue;
    question.gaps.push({
      id: ids.next('g'),
      text,
      whyItMatters: clampText(item.whyItMatters, 600),
      howToClose: clampText(item.howToClose, 600),
    });
  }

  // 6) 分支（挂到全局 branches，问题侧只留 id）
  for (const rawBranch of asArray(raw.branches)) {
    const item = asObject(rawBranch);
    const text = clampText(typeof rawBranch === 'string' ? rawBranch : item.text, 600);
    if (!text) continue;
    const branch = {
      id: ids.next('b'),
      text,
      hook: clampText(item.hook, 600),
      priority: pickEnum(item.priority, PRIORITIES, 'medium'),
      status: pickEnum(item.status, ['open', 'answered'], 'open'),
      questionId: question.id,
      answeredBy: '',
    };
    archive.branches.push(branch);
    if (!question.branchIds.includes(branch.id)) question.branchIds.push(branch.id);
  }

  // 7) 问题聚合字段
  question.claimIds = dedupeStrings([...question.claimIds, ...claimList.map((claim) => claim.id)]);
  question.evidenceIds = dedupeStrings([...question.evidenceIds, ...evidenceList.map((evidence) => evidence.id)]);
  if (raw.summary !== undefined) question.summary = clampText(raw.summary, 200, question.summary);
  question.confidence = pickEnum(raw.confidence, CONFIDENCES, question.confidence);
  const coverage = pickEnum(raw.coverage, QUESTION_COVERAGE, '');
  if (coverage) question.coverageHint = coverage;
  question.workStatus = 'done';
  question.status = 'done';

  touch(archive, now);
  recount(archive);
  return {
    claimIds: claimList.map((claim) => claim.id),
    evidenceIds: evidenceList.map((evidence) => evidence.id),
  };
}

/* ------------------------------------------------------------------ */
/* 阶段 6：证据核查                                                     */
/* ------------------------------------------------------------------ */

/** 应用核查结果：补反对证据、修正论断状态（只降不升）、补反例。 */
export function applyVerification(archive, data, { sources = [], now = new Date() } = {}) {
  if (!archive) return archive;
  const raw = asObject(data);
  const ids = createIdAllocator(archive);
  const sourceMap = prepareSources(archive, sources, now, ids);

  for (const rawUpdate of asArray(raw.updates)) {
    const update = asObject(rawUpdate);
    const question = findQuestion(archive, String(update.questionId || ''));
    if (!question) continue;

    const ctx = {
      archive,
      ids,
      sourceMap,
      module: 'question',
      questionId: question.id,
      evidenceMap: new Map(),
      claimMap: new Map(),
      now,
    };

    // 新证据：先落库；如果给了 claimId/claimIds，按 stance 挂到论断上。
    for (const rawEvidence of asArray(update.evidence)) {
      const evidence = ingestEvidence(rawEvidence, ctx);
      if (!evidence) continue;
      if (isObject(rawEvidence) && typeof rawEvidence.id === 'string' && rawEvidence.id.trim()) {
        ctx.evidenceMap.set(rawEvidence.id.trim(), evidence.id);
      }
      const linkedClaims = dedupeStrings(
        asArray(asObject(rawEvidence).claimIds).concat(asObject(rawEvidence).claimId ? [asObject(rawEvidence).claimId] : []),
      );
      for (const claimId of linkedClaims) {
        const claim = findClaim(archive, claimId);
        if (!claim) continue;
        if (evidence.stance === 'oppose') {
          if (!claim.opposeEvidenceIds.includes(evidence.id)) claim.opposeEvidenceIds.push(evidence.id);
        } else if (!claim.evidenceIds.includes(evidence.id)) {
          claim.evidenceIds.push(evidence.id);
        }
      }
      if (!question.evidenceIds.includes(evidence.id)) question.evidenceIds.push(evidence.id);
    }

    // 论断状态：维持或下调；模型要求上调时最多保留 limited。
    for (const rawClaim of asArray(update.claims)) {
      const item = asObject(rawClaim);
      const claim = findClaim(archive, String(item.claimId || item.id || ''));
      if (!claim) continue;
      if (item.conditions !== undefined) claim.conditions = clampText(item.conditions, 600, claim.conditions);
      if (item.confidence !== undefined) claim.confidence = pickEnum(item.confidence, CONFIDENCES, claim.confidence);
      if (item.note !== undefined) claim.note = clampText(item.note, 600, claim.note);
      const requested = pickEnum(item.evidenceStatus, EVIDENCE_STATUS, '');
      if (!requested) continue;
      const derived = derivedClaimStatus(archive, claim);
      if (STATUS_RANK[requested] <= STATUS_RANK[derived]) {
        claim.evidenceStatusOverride = requested;
      } else if (derived !== 'unsupported') {
        claim.evidenceStatusOverride = 'limited';
      }
    }

    // 反例 / 替代解释
    for (const rawPart of asArray(update.counterpoints)) {
      const item = asObject(rawPart);
      const text = clampText(item.text, 1200);
      if (!text) continue;
      question.counterpoints.push({
        id: ids.next('cp'),
        text,
        condition: clampText(item.condition, 400),
        evidenceIds: resolveEvidenceRefs(item.evidenceIds, ctx),
      });
    }

    const coverage = pickEnum(update.coverage, QUESTION_COVERAGE, '');
    if (coverage) question.coverageHint = coverage;
  }

  if (raw.limits !== undefined) {
    const text = clampText(raw.limits, 1000);
    if (text) {
      archive._verificationLimits = dedupeStrings([...asArray(archive._verificationLimits), text]);
    }
  }

  touch(archive, now);
  recount(archive);
  return archive;
}

/* ------------------------------------------------------------------ */
/* 阶段 7：形成判断                                                     */
/* ------------------------------------------------------------------ */

function appendUnknowns(archive, rawUnknowns, ids, { dedupe = false } = {}) {
  const created = [];
  for (const rawUnknown of asArray(rawUnknowns)) {
    const item = asObject(rawUnknown);
    const text = clampText(typeof rawUnknown === 'string' ? rawUnknown : item.text, 800);
    if (!text) continue;
    const questionId = findQuestion(archive, String(item.questionId || '')) ? String(item.questionId) : '';
    if (dedupe && archive.unknowns.some((unknown) => unknown.text === text && unknown.questionId === questionId)) continue;
    const unknown = {
      id: ids.next('un'),
      questionId,
      text,
      whyItMatters: clampText(item.whyItMatters, 600),
      howToClose: clampText(item.howToClose, 600),
    };
    archive.unknowns.push(unknown);
    created.push(unknown);
  }
  return created;
}

function appendBranches(archive, rawBranches, ids, { dedupe = false, questionId = '' } = {}) {
  const created = [];
  for (const rawBranch of asArray(rawBranches)) {
    const item = asObject(rawBranch);
    const text = clampText(typeof rawBranch === 'string' ? rawBranch : item.text, 600);
    if (!text) continue;
    const targetQuestion = findQuestion(archive, String(item.questionId || '')) ? String(item.questionId) : questionId;
    if (dedupe && archive.branches.some((branch) => branch.text === text && branch.questionId === (targetQuestion || ''))) continue;
    const branch = {
      id: ids.next('b'),
      text,
      hook: clampText(item.hook, 600),
      priority: pickEnum(item.priority, PRIORITIES, 'medium'),
      status: pickEnum(item.status, ['open', 'answered'], 'open'),
      questionId: targetQuestion || '',
      answeredBy: '',
    };
    archive.branches.push(branch);
    created.push(branch);
  }
  return created;
}

function appendConnections(archive, rawConnections, ids) {
  const created = [];
  for (const rawConnection of asArray(rawConnections)) {
    const item = asObject(rawConnection);
    const to = clampText(item.to, 300);
    const mechanism = clampText(item.mechanism, 1600);
    if (!to && !mechanism) continue;
    const fromId = String(item.from || '');
    const from = findQuestion(archive, fromId) || findClaim(archive, fromId) || findJudgment(archive, fromId) ? fromId : '';
    const key = `${from}|${to}|${pickEnum(item.kind, CONNECTION_KINDS, 'dependency')}`;
    if (archive.connections.some((connection) => `${connection.from}|${connection.to}|${connection.kind}` === key)) continue;
    const connection = {
      id: ids.next('x'),
      from,
      to,
      kind: pickEnum(item.kind, CONNECTION_KINDS, 'dependency'),
      mechanism,
      claimIds: filterBySet(item.claimIds, new Set(archive.claims.map((claim) => claim.id))),
      sourceIds: filterBySet(item.sourceIds, new Set(archive.sources.map((source) => source.id))),
      status: pickEnum(item.status, CONNECTION_STATUS, 'suggested'),
      note: clampText(item.note, 600),
    };
    archive.connections.push(connection);
    created.push(connection);
  }
  return created;
}

/** 应用综合判断：judgments / unknowns / branches / connections / tensions / readingNote。 */
export function applySynthesis(archive, data) {
  if (!archive) return archive;
  const raw = asObject(data);
  const ids = createIdAllocator(archive);

  for (const rawJudgment of asArray(raw.judgments)) {
    const item = asObject(rawJudgment);
    const text = clampText(item.text, 800);
    if (!text) continue;
    if (archive.judgments.some((judgment) => judgment.text === text)) continue;
    archive.judgments.push({
      id: ids.next('j'),
      text,
      identity: pickEnum(item.identity, IDENTITIES, 'analysis'),
      confidence: pickEnum(item.confidence, CONFIDENCES, 'medium'),
      conditions: clampText(item.conditions, 600),
      claimIds: filterBySet(item.claimIds, new Set(archive.claims.map((claim) => claim.id))),
      evidenceIds: [],
      sourceIds: [],
      independentSources: 0,
      stale: Boolean(item.stale),
      note: clampText(item.note, 600),
    });
  }

  appendUnknowns(archive, raw.unknowns, ids, { dedupe: true });
  appendBranches(archive, raw.branches, ids, { dedupe: true });
  appendConnections(archive, raw.connections, ids);

  if (raw.tensions !== undefined) {
    archive.tensions = asArray(raw.tensions).map((text) => clampText(text, 300)).filter(Boolean).slice(0, 6);
  }
  if (raw.readingNote !== undefined) archive.readingNote = clampText(raw.readingNote, 2000);

  touch(archive, new Date());
  recount(archive);
  return archive;
}

/* ------------------------------------------------------------------ */
/* 追问：判断局部更新                                                   */
/* ------------------------------------------------------------------ */

/** 按 id 更新判断、追加未知/分支；不重写基础认识与讨论地图。 */
export function applyJudgmentPatch(archive, data, { now = new Date() } = {}) {
  if (!archive) return archive;
  const raw = asObject(data);
  const ids = createIdAllocator(archive);

  for (const rawJudgment of asArray(raw.judgments)) {
    const item = asObject(rawJudgment);
    const requestedId = typeof item.id === 'string' ? item.id.trim() : '';
    let judgment = requestedId ? findJudgment(archive, requestedId) : null;
    const isNew = !judgment;
    if (!judgment) {
      judgment = {
        id: ids.next('j'),
        text: '',
        identity: 'analysis',
        confidence: 'medium',
        conditions: '',
        claimIds: [],
        evidenceIds: [],
        sourceIds: [],
        independentSources: 0,
        stale: false,
        note: '',
      };
      archive.judgments.push(judgment);
    }
    if (item.text !== undefined) judgment.text = clampText(item.text, 800, judgment.text);
    judgment.identity = pickEnum(item.identity, IDENTITIES, judgment.identity);
    judgment.confidence = pickEnum(item.confidence, CONFIDENCES, judgment.confidence);
    if (item.conditions !== undefined) judgment.conditions = clampText(item.conditions, 600, judgment.conditions);
    if (item.claimIds !== undefined) judgment.claimIds = filterBySet(item.claimIds, new Set(archive.claims.map((claim) => claim.id)));
    if (item.stale !== undefined) judgment.stale = Boolean(item.stale);
    if (item.note !== undefined) judgment.note = clampText(item.note, 600, judgment.note);
    if (isNew && !judgment.text) archive.judgments.pop();
  }

  appendUnknowns(archive, raw.unknowns, ids, { dedupe: true });
  appendBranches(archive, raw.branches, ids, { dedupe: true });
  if (raw.revisionNote) archive._lastRevisionNote = clampText(raw.revisionNote, 800);

  touch(archive, now);
  recount(archive);
  return archive;
}

/* ------------------------------------------------------------------ */
/* 追问入口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 追问增量合并。
 *  mode='basics'       追加基础认识块与 claim
 *  mode='discussion'   按 issueId 追加讨论项（未知 issueId 忽略）
 *  mode='question'     并入 targetId 指定问题
 *  mode='new-question' 先建 1 个问题，再并入
 */
export function applyFollowup(archive, { mode = 'question', targetId = '', unit } = {}, { sources = [], now = new Date() } = {}) {
  if (!archive) return archive;
  const rawUnit = asObject(unit);
  const ids = createIdAllocator(archive);
  const sourceMap = prepareSources(archive, sources, now, ids);

  if (mode === 'basics') {
    const understanding = isObject(rawUnit.understanding) ? rawUnit.understanding : { blocks: asArray(rawUnit.blocks) };
    const ctx = {
      archive,
      ids,
      sourceMap,
      module: 'understanding',
      questionId: '',
      evidenceMap: new Map(),
      claimMap: new Map(),
      now,
    };
    applyUnderstandingData(archive, { understanding, coverage: rawUnit.coverage }, ctx, { append: true });
  } else if (mode === 'discussion') {
    const ctx = {
      archive,
      ids,
      sourceMap,
      module: 'discussion',
      questionId: '',
      evidenceMap: new Map(),
      claimMap: new Map(),
      now,
    };
    if (isObject(rawUnit.discussion) || asArray(rawUnit.items).length) {
      applyDiscussionData(archive, { discussion: rawUnit.discussion, items: rawUnit.items }, ctx, { append: true });
    }
  } else if (mode === 'new-question') {
    const seed = rawUnit.question !== undefined ? rawUnit.question : rawUnit;
    const data = typeof seed === 'string'
      ? { questions: [{ question: seed, why: rawUnit.why || '', role: 'custom', priority: 'high', queries: rawUnit.queries }] }
      : { questions: [asObject(seed)] };
    const created = applyPlanningData(archive, data, { append: true });
    if (created.length) mergeResearchUnit(archive, created[0].id, rawUnit, { sources, now });
  } else {
    mergeResearchUnit(archive, String(targetId || ''), rawUnit, { sources, now });
  }

  if (asArray(rawUnit.affectedClaimIds).length) {
    archive._lastAffectedClaimIds = dedupeStrings(rawUnit.affectedClaimIds);
  }
  if (rawUnit.revisionNote) archive._lastRevisionNote = clampText(rawUnit.revisionNote, 800);
  if (rawUnit.answer !== undefined) archive._lastFollowupAnswer = clampText(rawUnit.answer, 2000);

  touch(archive, now);
  recount(archive);
  return archive;
}

/* ------------------------------------------------------------------ */
/* 查找                                                                 */
/* ------------------------------------------------------------------ */

/** 查找论断。 */
export function findClaim(archive, id) {
  return asArray(archive && archive.claims).find((claim) => claim.id === id) || null;
}

/** 查找证据。 */
export function findEvidence(archive, id) {
  return asArray(archive && archive.evidence).find((evidence) => evidence.id === id) || null;
}

/** 查找问题。 */
export function findQuestion(archive, id) {
  return asArray(archive && archive.questions).find((question) => question.id === id) || null;
}

/** 查找讨论议题。 */
export function findIssue(archive, id) {
  return asArray(archive && archive.discussion && archive.discussion.issues).find((issue) => issue.id === id) || null;
}

/** 查找讨论项。 */
export function findDiscussionItem(archive, id) {
  for (const issue of asArray(archive && archive.discussion && archive.discussion.issues)) {
    const item = asArray(issue.items).find((entry) => entry.id === id);
    if (item) return item;
  }
  return null;
}

/** 查找判断。 */
export function findJudgment(archive, id) {
  return asArray(archive && archive.judgments).find((judgment) => judgment.id === id) || null;
}

/** 查找来源。 */
export function findSource(archive, id) {
  return asArray(archive && archive.sources).find((source) => source.id === id) || null;
}

/** 查找分支。 */
export function findBranch(archive, id) {
  return asArray(archive && archive.branches).find((branch) => branch.id === id) || null;
}

/** 查找缺口。 */
export function findGap(archive, id) {
  for (const question of asArray(archive && archive.questions)) {
    const gap = asArray(question.gaps).find((entry) => entry.id === id);
    if (gap) return gap;
  }
  return null;
}

/** v1 兼容别名：旧代码把 claim 叫 conclusion。 */
export const findConclusion = findClaim;

/* ------------------------------------------------------------------ */
/* 独立信源与统计                                                       */
/* ------------------------------------------------------------------ */

/**
 * 独立信源计数：只算 independence 为 primary / independent 的来源；
 * 同域名只算一次，同 originGroupId（同一公告/调查/实验/发言的转述）跨域名也只算一次。
 * 转述（syndicated）与未判定（unknown）不计入——转载不是独立验证。
 */
export function countIndependentSources(archive, sourceIds) {
  const domains = new Set();
  const groups = new Set();
  let count = 0;
  for (const id of asArray(sourceIds)) {
    const source = asArray(archive && archive.sources).find((entry) => entry.id === id);
    if (!source) continue;
    if (source.independence !== 'primary' && source.independence !== 'independent') continue;
    const domain = hostOf(source.canonicalUrl || source.url) || source.id;
    const group = typeof source.originGroupId === 'string' ? source.originGroupId.trim() : '';
    if (group && groups.has(group)) continue;
    if (domains.has(domain)) continue;
    count += 1;
    domains.add(domain);
    if (group) groups.add(group);
  }
  return count;
}

/** 独立性未判定的来源数。 */
export function countUnjudgedSources(archive) {
  return asArray(archive && archive.sources).filter(
    (source) => !source || !['primary', 'independent', 'syndicated'].includes(source.independence),
  ).length;
}

/** 由程序重建 usedFor：来源被哪些证据 / 关联 / 时间线 / 混淆项 / 实体使用。 */
export function rebuildUsedFor(archive) {
  const used = new Map(asArray(archive.sources).map((source) => [source.id, []]));
  const add = (sourceId, refId) => {
    if (!sourceId || !refId) return;
    if (!used.has(sourceId)) used.set(sourceId, []);
    const list = used.get(sourceId);
    if (!list.includes(refId)) list.push(refId);
  };
  for (const evidence of asArray(archive.evidence)) {
    for (const sourceId of asArray(evidence.sourceIds)) add(sourceId, evidence.id);
  }
  for (const connection of asArray(archive.connections)) {
    for (const sourceId of asArray(connection.sourceIds)) add(sourceId, connection.id);
  }
  const understanding = asObject(archive.understanding);
  for (const point of asArray(understanding.timeline)) {
    for (const sourceId of asArray(point.sourceIds)) add(sourceId, point.id);
  }
  for (const item of asArray(understanding.confusables)) {
    for (const sourceId of asArray(item.sourceIds)) add(sourceId, item.id);
  }
  for (const entity of asArray(understanding.entities)) {
    for (const sourceId of asArray(entity.sourceIds)) add(sourceId, entity.id);
  }
  for (const source of asArray(archive.sources)) source.usedFor = used.get(source.id) || [];
}

/** 估算阅读时长（中文约 400 字/分钟）。 */
function estimateReadingMinutes(archive) {
  let chars = 0;
  const understanding = asObject(archive.understanding);
  chars += String(understanding.summary || '').length;
  for (const block of asArray(understanding.blocks)) chars += String(block.text || '').length + String(block.title || '').length;
  for (const entity of asArray(understanding.entities)) chars += String(entity.role || '').length;
  for (const item of asArray(understanding.confusables)) chars += String(item.note || '').length;
  for (const point of asArray(understanding.timeline)) chars += String(point.text || '').length;
  const discussion = asObject(archive.discussion);
  for (const issue of asArray(discussion.issues)) {
    chars += String(issue.summary || '').length + String(issue.question || '').length + String(issue.gaps || '').length;
    for (const item of asArray(issue.items)) chars += String(item.view || '').length + String(item.basis || '').length;
  }
  for (const question of asArray(archive.questions)) {
    chars += String(question.question || '').length + String(question.why || '').length + String(question.summary || '').length;
    for (const gap of asArray(question.gaps)) chars += String(gap.text || '').length;
  }
  for (const claim of asArray(archive.claims)) {
    chars += String(claim.statement || '').length + String(claim.basis || '').length + String(claim.conditions || '').length;
  }
  for (const judgment of asArray(archive.judgments)) chars += String(judgment.text || '').length + String(judgment.conditions || '').length;
  for (const unknown of asArray(archive.unknowns)) chars += String(unknown.text || '').length;
  for (const branch of asArray(archive.branches)) chars += String(branch.text || '').length + String(branch.hook || '').length;
  for (const connection of asArray(archive.connections)) chars += String(connection.mechanism || '').length;
  chars += String(archive.readingNote || '').length;
  return chars > 0 ? Math.max(1, Math.round(chars / 400)) : 0;
}

/**
 * 重算所有派生字段（§3.3）：
 *  - evidence.independentSources / strength
 *  - claim.evidenceStatus（无证据 unsupported；有反对 conflicted；仅 1 条或全 single-source limited；否则 supported）
 *    fact / claim 无证据时降级为 analysis + low
 *  - question.coverage / status 聚合
 *  - judgment 的 evidenceIds / sourceIds / independentSources 从 claimIds 聚合
 *  - sources.usedFor、stats、注释数、阅读时长
 */
export function recount(archive) {
  if (!archive || typeof archive !== 'object') return archive;
  const understanding = asObject(archive.understanding);
  const discussion = asObject(archive.discussion);
  archive.version = ARCHIVE_VERSION;
  archive.sources = asArray(archive.sources);
  archive.evidence = asArray(archive.evidence);
  archive.claims = asArray(archive.claims);
  archive.questions = asArray(archive.questions);
  archive.judgments = asArray(archive.judgments);
  archive.unknowns = asArray(archive.unknowns);
  archive.branches = asArray(archive.branches);
  archive.connections = asArray(archive.connections);

  if (!isObject(archive.understanding)) archive.understanding = emptyArchive({ query: asObject(archive.input).query }).understanding;
  if (!isObject(archive.discussion)) archive.discussion = emptyArchive({ query: asObject(archive.input).query }).discussion;

  // 证据：独立信源数与 strength
  for (const evidence of archive.evidence) {
    if (!isObject(evidence)) continue;
    evidence.sourceIds = asArray(evidence.sourceIds);
    const independent = countIndependentSources(archive, evidence.sourceIds);
    evidence.independentSources = independent;
    if (evidence.sourceIds.length) {
      if (independent === 0) evidence.strength = 'single-source';
      else if (independent === 1 && evidence.sourceIds.length > 1 && evidence.strength !== 'contested') {
        evidence.strength = 'single-source';
      }
    }
    if (evidence.questionId && !archive.questions.some((question) => question.id === evidence.questionId)) {
      evidence.questionId = '';
    }
  }

  // 论断：降级 + 证据状态（模型只能在核查阶段下调，不能升到与证据不符）
  for (const claim of archive.claims) {
    if (!isObject(claim)) continue;
    claim.evidenceIds = asArray(claim.evidenceIds).filter((id) => archive.evidence.some((evidence) => evidence.id === id));
    claim.opposeEvidenceIds = asArray(claim.opposeEvidenceIds).filter((id) => archive.evidence.some((evidence) => evidence.id === id));
    if ((claim.identity === 'fact' || claim.identity === 'claim') && claim.evidenceIds.length === 0) {
      claim.identity = 'analysis';
      claim.confidence = 'low';
      claim.basis = joinText([claim.basis, '现有材料没有提供可核查证据，按分析处理。']);
    }
    const derived = derivedClaimStatus(archive, claim);
    const override = pickEnum(claim.evidenceStatusOverride, EVIDENCE_STATUS, '');
    let status = derived;
    if (derived !== 'conflicted' && override && STATUS_RANK[override] <= STATUS_RANK[derived]) status = override;
    claim.evidenceStatus = status;
  }

  // 问题：claim / evidence / branch 聚合与覆盖状态
  for (const question of archive.questions) {
    if (!isObject(question)) continue;
    const relatedClaims = [];
    for (const id of asArray(question.claimIds)) {
      const claim = findClaim(archive, id);
      if (claim && !relatedClaims.includes(claim)) relatedClaims.push(claim);
    }
    for (const claim of archive.claims) {
      if (asArray(claim.questionIds).includes(question.id) && !relatedClaims.includes(claim)) relatedClaims.push(claim);
    }
    question.claimIds = relatedClaims.map((claim) => claim.id);
    question.evidenceIds = dedupeStrings([
      ...asArray(question.evidenceIds).filter((id) => archive.evidence.some((evidence) => evidence.id === id)),
      ...relatedClaims.flatMap((claim) => [...claim.evidenceIds, ...claim.opposeEvidenceIds]),
    ]);
    question.branchIds = dedupeStrings([
      ...asArray(question.branchIds).filter((id) => archive.branches.some((branch) => branch.id === id)),
      ...archive.branches.filter((branch) => branch.questionId === question.id).map((branch) => branch.id),
    ]);
    if (!WORK_STATUS.includes(question.workStatus)) {
      question.workStatus = QUESTION_STATUS.includes(question.status) ? question.status : 'pending';
    }
    question.status = question.workStatus === 'blocked' ? 'partial' : QUESTION_STATUS.includes(question.workStatus) ? question.workStatus : 'pending';

    let derivedCoverage;
    if (!relatedClaims.length) derivedCoverage = 'no-evidence';
    else if (relatedClaims.some((claim) => claim.evidenceStatus === 'conflicted')) derivedCoverage = 'disputed';
    else if (relatedClaims.some((claim) => claim.evidenceStatus === 'supported')) derivedCoverage = 'answered';
    else derivedCoverage = 'partial';
    const hint = pickEnum(question.coverageHint, QUESTION_COVERAGE, '');
    question.coverage = hint && COVERAGE_RANK[hint] < COVERAGE_RANK[derivedCoverage] ? hint : derivedCoverage;
    if (!QUESTION_COVERAGE.includes(question.coverageHint)) question.coverageHint = '';
  }

  // 判断：证据与独立信源从 claimIds 聚合，不采用模型自报
  for (const judgment of archive.judgments) {
    if (!isObject(judgment)) continue;
    const claims = dedupeStrings(judgment.claimIds).map((id) => findClaim(archive, id)).filter(Boolean);
    judgment.claimIds = claims.map((claim) => claim.id);
    judgment.evidenceIds = dedupeStrings(claims.flatMap((claim) => [...claim.evidenceIds, ...claim.opposeEvidenceIds]));
    judgment.sourceIds = dedupeStrings(
      judgment.evidenceIds.flatMap((id) => {
        const evidence = findEvidence(archive, id);
        return evidence ? evidence.sourceIds : [];
      }),
    );
    judgment.independentSources = countIndependentSources(archive, judgment.sourceIds);
    judgment.stale = Boolean(judgment.stale);
  }

  // 讨论项来源：evidence 来源合并进 item.sourceIds
  for (const issue of asArray(archive.discussion.issues)) {
    for (const item of asArray(issue.items)) {
      const sources = dedupeStrings([
        ...asArray(item.sourceIds).filter((id) => archive.sources.some((source) => source.id === id)),
        ...asArray(item.evidenceIds).flatMap((id) => {
          const evidence = findEvidence(archive, id);
          return evidence ? evidence.sourceIds : [];
        }),
      ]);
      item.sourceIds = sources;
    }
  }

  rebuildUsedFor(archive);

  const previous = asObject(archive.stats);
  const index = buildAnnotationIndex(archive);
  archive.stats = {
    searches: clampNumber(previous.searches, 0, 1e9, 0),
    fetched: clampNumber(previous.fetched, 0, 1e9, 0),
    llmCalls: clampNumber(previous.llmCalls, 0, 1e9, 0),
    sourceCount: archive.sources.length,
    independentSourceCount: countIndependentSources(archive, archive.sources.map((source) => source.id)),
    unjudgedSourceCount: countUnjudgedSources(archive),
    claimCount: archive.claims.length,
    evidenceCount: archive.evidence.length,
    annotationCount: index.entries.length,
    durationMs: clampNumber(previous.durationMs, 0, 1e9, 0),
    tokensIn: clampNumber(previous.tokensIn, 0, 1e12, 0),
    tokensOut: clampNumber(previous.tokensOut, 0, 1e12, 0),
  };
  archive.topic = asObject(archive.topic);
  archive.topic.readingMinutes = estimateReadingMinutes(archive);
  return archive;
}

/* ------------------------------------------------------------------ */
/* 注释索引（程序生成，不写盘）                                         */
/* ------------------------------------------------------------------ */

/**
 * 按阅读顺序生成注释编号：
 *   understanding summary → 各 block → discussion items → 问题下的 claims → judgments 引用
 * 同一 evidence 只编号一次；编号只属于当前输出版本，底层用稳定 id。
 */
export function buildAnnotationIndex(archive) {
  const entries = [];
  const byEvidenceId = {};
  const bySourceId = {};
  const seen = new Map();
  if (!archive || typeof archive !== 'object') return { entries, byEvidenceId, bySourceId };

  const add = (evidenceId, usedBy) => {
    const evidence = findEvidence(archive, String(evidenceId == null ? '' : evidenceId));
    if (!evidence) return;
    const sourceIds = asArray(evidence.sourceIds).filter((id) => findSource(archive, id));
    if (!sourceIds.length) return; // 悬空证据不编号，避免出现打不开的注释
    let entry = seen.get(evidence.id);
    if (!entry) {
      entry = {
        number: entries.length + 1,
        evidenceId: evidence.id,
        sourceIds: sourceIds.slice(),
        locator: evidence.locator || '',
        readScope: evidence.readScope || '',
        quote: evidence.quote || '',
        text: evidence.text || '',
        module: evidence.module || '',
        questionId: evidence.questionId || '',
        usedBy: [],
      };
      entries.push(entry);
      byEvidenceId[entry.evidenceId] = entry;
      seen.set(entry.evidenceId, entry);
      for (const sourceId of sourceIds) {
        if (!bySourceId[sourceId]) bySourceId[sourceId] = [];
        bySourceId[sourceId].push({ number: entry.number, evidenceId: entry.evidenceId });
      }
    }
    if (usedBy && !entry.usedBy.includes(usedBy)) entry.usedBy.push(usedBy);
  };

  const addClaimEvidence = (claim, usedBy) => {
    if (!claim) return;
    for (const id of asArray(claim.evidenceIds)) add(id, usedBy);
    for (const id of asArray(claim.opposeEvidenceIds)) add(id, usedBy);
  };

  const understanding = asObject(archive.understanding);
  // 阅读顺序：一句话解释在 blocks 之前，所以 summary 先编号。
  for (const evidenceId of asArray(understanding.summaryEvidenceIds)) add(evidenceId, 'understanding.summary');
  addClaimEvidence(findClaim(archive, understanding.summaryClaimId), 'understanding.summary');
  for (const block of asArray(understanding.blocks)) {
    for (const evidenceId of asArray(block.evidenceIds)) add(evidenceId, block.id);
    for (const claimId of asArray(block.claimIds)) addClaimEvidence(findClaim(archive, claimId), findClaim(archive, claimId) ? findClaim(archive, claimId).id : block.id);
  }

  for (const issue of asArray(asObject(archive.discussion).issues)) {
    for (const item of asArray(issue.items)) {
      for (const evidenceId of asArray(item.evidenceIds)) add(evidenceId, item.id);
      for (const claimId of asArray(item.claimIds)) addClaimEvidence(findClaim(archive, claimId), claimId);
    }
  }

  for (const question of asArray(archive.questions)) {
    const claimIds = dedupeStrings([
      ...asArray(question.claimIds),
      ...archive.claims.filter((claim) => asArray(claim.questionIds).includes(question.id)).map((claim) => claim.id),
    ]);
    for (const claimId of claimIds) addClaimEvidence(findClaim(archive, claimId), claimId);
    // 直接挂在问题下、没有归入 claim 的证据也要有编号
    for (const evidenceId of asArray(question.evidenceIds)) add(evidenceId, question.id);
  }

  for (const judgment of asArray(archive.judgments)) {
    for (const claimId of asArray(judgment.claimIds)) addClaimEvidence(findClaim(archive, claimId), claimId);
    for (const evidenceId of asArray(judgment.evidenceIds)) add(evidenceId, judgment.id);
  }

  return { entries, byEvidenceId, bySourceId };
}

/* ------------------------------------------------------------------ */
/* 规范化：兼容 v1 档案，v2 幂等                                        */
/* ------------------------------------------------------------------ */

/** id 唯一化：优先保留可读的已有 id，冲突时按前缀顺延。 */
function createEnsureId() {
  const used = new Set();
  function ensure(preferred, prefix) {
    const candidate = typeof preferred === 'string' ? preferred.trim() : '';
    if (candidate && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
    let n = 1;
    while (used.has(`${prefix}${n}`)) n += 1;
    const id = `${prefix}${n}`;
    used.add(id);
    return id;
  }
  return { ensure, used };
}

function normalizeStoredEvidence(rawItem, { id, module, questionId, sourceIdSet, fallbackAt }) {
  const item = asObject(rawItem);
  const text = clampText(item.text, 1200) || clampText(item.quote, 1200);
  if (!text) return null;
  const sourceIds = filterBySet(
    dedupeStrings(asArray(item.sourceIds).concat(item.sourceId ? [item.sourceId] : [])),
    sourceIdSet,
  );
  if (!sourceIds.length) return null; // §4.4：引用不存在来源的 evidence 整条丢弃
  const locator = clampText(item.locator, 160);
  const quote = clampQuote(item.quote);
  return {
    id,
    questionId: questionId || '',
    module: pickEnum(module ?? item.module, ['understanding', 'discussion', 'question'], questionId ? 'question' : 'understanding'),
    text,
    quote,
    locator,
    readScope: pickEnum(item.readScope, READ_SCOPES, '') || inferReadScope(locator, quote, Boolean(asObject(item.fetch).ok)),
    identity: pickEnum(item.identity, IDENTITIES, 'analysis'),
    stance: pickEnum(item.stance, STANCES, 'support'),
    sourceIds,
    strength: pickEnum(item.strength, STRENGTHS, 'secondary'),
    independentSources: 0,
    originGroupId: clampText(item.originGroupId, 120),
    retrievedAt: iso(item.retrievedAt, fallbackAt),
    note: clampText(item.note, 400),
  };
}

function normalizeStoredClaim(rawItem, { id, module, questionIds, evidenceIdSet, questionIdSet }) {
  const item = asObject(rawItem);
  const statement = clampText(item.statement ?? item.text, 800);
  if (!statement) return null;
  let identity = pickEnum(item.identity, IDENTITIES, 'analysis');
  let confidence = pickEnum(item.confidence, CONFIDENCES, 'medium');
  let basis = clampText(item.basis, 800);
  const evidenceIds = filterBySet(item.evidenceIds, evidenceIdSet);
  const opposeEvidenceIds = filterBySet(item.opposeEvidenceIds, evidenceIdSet).filter((evidenceId) => !evidenceIds.includes(evidenceId));
  if (evidenceIds.length === 0) {
    confidence = 'low';
    if (identity === 'fact' || identity === 'claim') {
      identity = 'analysis';
      basis = joinText([basis, '现有材料没有提供可核查证据，按分析处理。']);
    }
  }
  return {
    id,
    questionIds: filterBySet(questionIds, questionIdSet),
    module: pickEnum(module ?? item.module, ['understanding', 'discussion', 'question'], 'question'),
    statement,
    identity,
    confidence,
    attribution: clampText(item.attribution, 300),
    scope: clampText(item.scope, 600),
    basis,
    conditions: clampText(item.conditions, 600),
    evidenceIds,
    opposeEvidenceIds,
    evidenceStatus: 'unsupported',
    evidenceStatusOverride: pickEnum(item.evidenceStatusOverride, EVIDENCE_STATUS, ''),
    note: clampText(item.note, 600),
    supersededBy: typeof item.supersededBy === 'string' ? item.supersededBy : '',
  };
}

function normalizeStoredMechanism(rawList, { ensure, claimIdSet, evidenceIdSet }) {
  const out = [];
  for (const rawPart of asArray(rawList)) {
    const item = asObject(rawPart);
    const text = clampText(typeof rawPart === 'string' ? rawPart : item.text, 1600);
    if (!text) continue;
    out.push({
      id: ensure(item.id, 'm'),
      text,
      claimIds: filterBySet(item.claimIds, claimIdSet),
      evidenceIds: filterBySet(item.evidenceIds, evidenceIdSet),
    });
  }
  return out;
}

function normalizeStoredCounterpoints(rawList, { ensure, evidenceIdSet }) {
  const out = [];
  for (const rawPart of asArray(rawList)) {
    const item = asObject(rawPart);
    const text = clampText(typeof rawPart === 'string' ? rawPart : item.text, 1200);
    if (!text) continue;
    out.push({
      id: ensure(item.id, 'cp'),
      text,
      condition: clampText(item.condition, 400),
      evidenceIds: filterBySet(item.evidenceIds, evidenceIdSet),
    });
  }
  return out;
}

function normalizeStoredGaps(rawList, { ensure }) {
  const out = [];
  for (const rawPart of asArray(rawList)) {
    const item = asObject(rawPart);
    const text = clampText(typeof rawPart === 'string' ? rawPart : item.text, 800);
    if (!text) continue;
    out.push({
      id: ensure(item.id, 'g'),
      text,
      whyItMatters: clampText(item.whyItMatters, 600),
      howToClose: clampText(item.howToClose, 600),
    });
  }
  return out;
}

function normalizeStoredQuestion(rawItem, { id, index, ensure, claimIdSet, evidenceIdSet }) {
  const item = asObject(rawItem);
  const relation = asObject(item.relation);
  const workStatus = pickEnum(item.workStatus, WORK_STATUS, '') || pickEnum(item.status, WORK_STATUS, 'pending');
  return {
    id,
    order: clampNumber(item.order, 1, 1000, index + 1),
    question: clampText(item.question, 300),
    why: clampText(item.why, 600),
    role: pickEnum(item.role, QUESTION_ROLES, 'custom'),
    priority: pickEnum(item.priority, PRIORITIES, 'medium'),
    evidenceNeed: clampText(item.evidenceNeed, 600),
    relation: {
      to: typeof relation.to === 'string' && relation.to.trim() ? relation.to.trim() : null,
      kind: pickEnum(relation.kind, RELATION_KINDS, index === 0 ? 'opens' : 'deepens'),
      note: clampText(relation.note, 400),
    },
    queries: dedupeStrings(asArray(item.queries).map((query) => clampText(query, 160)).filter(Boolean)).slice(0, 4),
    workStatus,
    coverage: pickEnum(item.coverage, QUESTION_COVERAGE, 'no-evidence'),
    coverageHint: pickEnum(item.coverageHint, QUESTION_COVERAGE, ''),
    status: pickEnum(item.status, QUESTION_STATUS, workStatus === 'blocked' ? 'partial' : workStatus),
    summary: clampText(item.summary, 200),
    confidence: pickEnum(item.confidence, CONFIDENCES, 'medium'),
    claimIds: filterBySet(item.claimIds, claimIdSet),
    evidenceIds: filterBySet(item.evidenceIds, evidenceIdSet),
    mechanism: normalizeStoredMechanism(item.mechanism, { ensure, claimIdSet, evidenceIdSet }),
    counterpoints: normalizeStoredCounterpoints(item.counterpoints, { ensure, evidenceIdSet }),
    gaps: normalizeStoredGaps(item.gaps, { ensure }),
    branchIds: [],
    entityIds: [],
  };
}

/**
 * 兜底规范化：把磁盘 / 模型 / v1 数据压回 v2 合法形状。
 *  - v1 的 questions[].conclusions / evidence 提升为全局 claims / evidence，保留可读 id；
 *  - 缺失模块补空，六模块结构不变；
 *  - v2 数据幂等：再次 normalize 不改 id、不改内容。
 */
export function normalizeArchive(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const rawInput = asObject(input.input);
  const rawTopic = asObject(input.topic);
  const query = clampText(rawInput.query || rawTopic.title || input.query, 500, '未命名主题');
  const base = emptyArchive({ query });
  const createdAt = iso(input.createdAt, base.createdAt);
  const updatedAt = iso(input.updatedAt, createdAt);
  const fallbackAt = updatedAt || base.createdAt;

  const archive = { ...base };
  archive.version = ARCHIVE_VERSION;
  archive.id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : base.id;
  archive.createdAt = createdAt;
  archive.updatedAt = updatedAt;
  archive.status = pickEnum(input.status, ARCHIVE_STATUS, 'draft');

  archive.input = {
    query: clampText(rawInput.query, 500, query),
    purpose: pickPurpose(rawInput.purpose, ''),
    angle: clampText(rawInput.angle, 500),
    scope: clampText(rawInput.scope ?? rawTopic.scope, 1200),
    exclusions: clampText(rawInput.exclusions ?? rawTopic.exclusions, 1200),
    discussionWindow: clampText(rawInput.discussionWindow ?? asObject(asObject(input.discussion).scope).window, 120),
    cutoffAt: iso(rawInput.cutoffAt ?? rawTopic.cutoffAt, createdAt),
    language: pickEnum(rawInput.language, LANGUAGES, 'zh'),
    depth: pickEnum(rawInput.depth ?? rawTopic.depth, DEPTHS, 'deep'),
    sourceConstraints: clampText(rawInput.sourceConstraints, 800),
  };
  const searchProviderMode = clampText(rawInput.searchProviderMode, 32);
  if (searchProviderMode) archive.input.searchProviderMode = searchProviderMode;
  const anySearch = asObject(rawInput.anySearch);
  const anySearchTag = clampText(anySearch.tag, 120);
  if (anySearchTag) {
    archive.input.anySearch = { tag: anySearchTag, params: { ...asObject(anySearch.params) } };
  }

  archive.topic = {
    title: clampText(rawTopic.title, 120, archive.input.query || '未命名主题'),
    kind: pickEnum(rawTopic.kind, TOPIC_KINDS, 'concept'),
    definition: clampText(rawTopic.definition, 1200),
    scope: clampText(rawTopic.scope, 1200),
    exclusions: clampText(rawTopic.exclusions, 1200),
    whyNow: clampText(rawTopic.whyNow, 800),
    cutoffAt: iso(rawTopic.cutoffAt, archive.input.cutoffAt),
    depth: pickEnum(rawTopic.depth, DEPTHS, archive.input.depth),
    readingMinutes: clampNumber(rawTopic.readingMinutes, 0, 1000, 0),
  };

  // 扩展字段：§3 未列但 synthesis 会产出；旧版 overview 里的对应内容也提升过来。
  const rawOverview = asObject(input.overview);
  archive.tensions = asArray(input.tensions ?? rawOverview.tensions)
    .map((text) => clampText(text, 300))
    .filter(Boolean)
    .slice(0, 6);
  archive.readingNote = clampText(input.readingNote ?? rawOverview.howToRead, 2000);

  const ensure = createEnsureId();

  /* 来源 */
  archive.anySearchRecords = normalizeAnySearchRecords(input.anySearchRecords);
  archive.sources = [];
  for (const rawSource of asArray(input.sources)) {
    if (!isObject(rawSource)) continue;
    const id = ensure.ensure(rawSource.id, 's');
    archive.sources.push(normalizeSourceRecord(rawSource, id, new Date(fallbackAt)));
  }
  const sourceIdSet = new Set(archive.sources.map((source) => source.id));

  /* 问题 id 先定，v1 嵌套结论/证据要用 */
  const rawQuestions = asArray(input.questions).filter(isObject);
  const questionSeeds = rawQuestions.map((item, index) => ({
    raw: item,
    id: ensure.ensure(/^q\d+$/.test(String(item.id || '').trim()) ? String(item.id).trim() : '', 'q'),
    index,
  }));
  const questionIdSet = new Set(questionSeeds.map((seed) => seed.id));

  /* 证据：v2 全局数组 + v1 嵌套 */
  archive.evidence = [];
  for (const rawEvidence of asArray(input.evidence)) {
    if (!isObject(rawEvidence)) continue;
    const questionId = questionIdSet.has(String(rawEvidence.questionId)) ? String(rawEvidence.questionId) : '';
    const id = ensure.ensure(rawEvidence.id, 'ev');
    const evidence = normalizeStoredEvidence(rawEvidence, {
      id,
      module: pickEnum(rawEvidence.module, ['understanding', 'discussion', 'question'], questionId ? 'question' : 'understanding'),
      questionId,
      sourceIdSet,
      fallbackAt,
    });
    if (evidence) archive.evidence.push(evidence);
  }
  for (const seed of questionSeeds) {
    for (const rawEvidence of asArray(seed.raw.evidence)) {
      if (!isObject(rawEvidence)) continue;
      const id = ensure.ensure(rawEvidence.id, 'ev');
      const evidence = normalizeStoredEvidence(rawEvidence, {
        id,
        module: 'question',
        questionId: seed.id,
        sourceIdSet,
        fallbackAt,
      });
      if (evidence) archive.evidence.push(evidence);
    }
  }
  const evidenceIdSet = new Set(archive.evidence.map((evidence) => evidence.id));

  /* 论断：v2 全局数组 + v1 嵌套结论 */
  archive.claims = [];
  for (const rawClaim of asArray(input.claims)) {
    if (!isObject(rawClaim)) continue;
    const id = ensure.ensure(rawClaim.id, 'c');
    const claim = normalizeStoredClaim(rawClaim, {
      id,
      module: rawClaim.module,
      questionIds: rawClaim.questionIds,
      evidenceIdSet,
      questionIdSet,
    });
    if (claim) archive.claims.push(claim);
  }
  for (const seed of questionSeeds) {
    for (const rawConclusion of asArray(seed.raw.conclusions)) {
      if (!isObject(rawConclusion)) continue;
      const id = ensure.ensure(rawConclusion.id, 'c');
      const claim = normalizeStoredClaim(rawConclusion, {
        id,
        module: 'question',
        questionIds: [seed.id],
        evidenceIdSet,
        questionIdSet,
      });
      if (claim) archive.claims.push(claim);
    }
  }
  const claimIdSet = new Set(archive.claims.map((claim) => claim.id));
  for (const claim of archive.claims) {
    if (claim.supersededBy && !claimIdSet.has(claim.supersededBy)) claim.supersededBy = '';
  }

  /* 问题 */
  archive.questions = questionSeeds.map((seed) =>
    normalizeStoredQuestion(seed.raw, {
      id: seed.id,
      index: seed.index,
      ensure: ensure.ensure,
      claimIdSet,
      evidenceIdSet,
    }),
  );

  /* 基础认识 */
  const rawUnderstanding = asObject(input.understanding);
  archive.understanding.blocks = [];
  for (const rawBlock of asArray(rawUnderstanding.blocks)) {
    if (!isObject(rawBlock)) continue;
    const kind = pickEnum(rawBlock.kind, UNDERSTANDING_KINDS, 'fact');
    archive.understanding.blocks.push({
      id: ensure.ensure(rawBlock.id, 'u'),
      kind,
      title: clampText(rawBlock.title, 120, UNDERSTANDING_TITLES[kind] || '基础说明'),
      text: clampText(rawBlock.text, 1600),
      claimIds: filterBySet(rawBlock.claimIds, claimIdSet),
      evidenceIds: filterBySet(rawBlock.evidenceIds, evidenceIdSet),
    });
  }
  archive.understanding.summary = clampText(rawUnderstanding.summary, 240) || clampText(rawOverview.brief, 240);
  // summary 注释：单数是契约字段；兼容外部/旧数据给的复数 summaryClaimIds（取第一条可解析的）。
  const summaryClaimCandidates = [rawUnderstanding.summaryClaimId]
    .concat(typeof rawUnderstanding.summaryClaimIds === 'string' ? [rawUnderstanding.summaryClaimIds] : asArray(rawUnderstanding.summaryClaimIds))
    .map((id) => String(id == null ? '' : id).trim())
    .filter(Boolean);
  archive.understanding.summaryClaimId = summaryClaimCandidates.find((id) => claimIdSet.has(id)) || '';
  const summaryEvidenceCandidates = asArray(rawUnderstanding.summaryEvidenceIds)
    .concat(rawUnderstanding.summaryEvidenceId ? [rawUnderstanding.summaryEvidenceId] : []);
  archive.understanding.summaryEvidenceIds = filterBySet(summaryEvidenceCandidates, evidenceIdSet);

  archive.understanding.entities = [];
  for (const rawEntity of asArray(rawUnderstanding.entities).concat(asArray(input.entities))) {
    if (!isObject(rawEntity)) continue;
    const name = clampText(rawEntity.name, 160);
    if (!name) continue;
    if (archive.understanding.entities.some((entity) => entity.name === name)) continue;
    archive.understanding.entities.push({
      id: ensure.ensure(rawEntity.id, 'e'),
      name,
      type: pickEnum(rawEntity.type, ['company', 'person', 'technology', 'event', 'organization', 'concept'], 'concept'),
      role: clampText(rawEntity.role, 300),
      claimIds: filterBySet(rawEntity.claimIds, claimIdSet),
      sourceIds: filterBySet(rawEntity.sourceIds, sourceIdSet),
    });
  }

  archive.understanding.confusables = [];
  for (const rawConfusable of asArray(rawUnderstanding.confusables)) {
    if (!isObject(rawConfusable)) continue;
    const term = clampText(rawConfusable.term, 160);
    if (!term) continue;
    archive.understanding.confusables.push({
      id: ensure.ensure(rawConfusable.id, 'cf'),
      term,
      confusedWith: clampText(rawConfusable.confusedWith, 160),
      note: clampText(rawConfusable.note, 600),
      sourceIds: filterBySet(rawConfusable.sourceIds, sourceIdSet),
    });
  }

  archive.understanding.timeline = [];
  for (const rawPoint of asArray(rawUnderstanding.timeline).concat(asArray(input.timeline))) {
    if (!isObject(rawPoint)) continue;
    const at = clampText(rawPoint.at ?? rawPoint.date, 60);
    const text = clampText(rawPoint.text ?? rawPoint.event, 600);
    if (!at && !text) continue;
    archive.understanding.timeline.push({
      id: ensure.ensure(rawPoint.id, 't'),
      at,
      text,
      sourceIds: filterBySet(rawPoint.sourceIds, sourceIdSet),
    });
  }

  const rawUnderstandingCoverage = asObject(rawUnderstanding.coverage);
  const hasUnderstanding = archive.understanding.blocks.length || archive.understanding.summary || archive.understanding.entities.length;
  const understandingCoverageStatus = pickEnum(
    rawUnderstandingCoverage.status,
    MODULE_COVERAGE,
    hasUnderstanding ? 'partial' : 'missing',
  );
  archive.understanding.coverage = {
    status: understandingCoverageStatus,
    note: clampText(rawUnderstandingCoverage.note, 1000),
    limits: clampText(rawUnderstandingCoverage.limits, 1000),
  };
  // 状态必须与覆盖说明一致：coverage 不是 covered 时不允许写 done。
  archive.understanding.status = understandingCoverageStatus === 'covered'
    ? pickEnum(rawUnderstanding.status, ['done', 'partial'], 'done')
    : hasUnderstanding
      ? 'partial'
      : 'empty';

  /* 讨论地图 */
  const rawDiscussion = asObject(input.discussion);
  const rawScope = asObject(rawDiscussion.scope);
  archive.discussion.scope = {
    window: clampText(rawScope.window, 120) || archive.input.discussionWindow,
    platforms: dedupeStrings(asArray(rawScope.platforms).map((entry) => clampText(entry, 80)).filter(Boolean)).slice(0, 12),
    languages: dedupeStrings(asArray(rawScope.languages).map((entry) => clampText(entry, 40)).filter(Boolean)).slice(0, 12),
    materialCount: clampNumber(rawScope.materialCount, 0, 100000, 0),
    speakerCount: clampNumber(rawScope.speakerCount, 0, 100000, 0),
    limits: clampText(rawScope.limits, 1000),
    checkedAt: iso(rawScope.checkedAt, ''),
  };

  archive.discussion.issues = [];
  for (const rawIssue of asArray(rawDiscussion.issues)) {
    if (!isObject(rawIssue)) continue;
    const issue = {
      id: ensure.ensure(rawIssue.id, 'd'),
      question: clampText(rawIssue.question ?? rawIssue.title, 400),
      summary: clampText(rawIssue.summary, 800),
      status: pickEnum(rawIssue.status, MODULE_COVERAGE, asArray(rawIssue.items).length ? 'partial' : 'missing'),
      items: [],
      sides: [],
      disagreement: normalizeDisagreement(rawIssue.disagreement),
      gaps: normalizeGapText(rawIssue.gaps),
    };
    for (const rawItem of asArray(rawIssue.items)) {
      if (!isObject(rawItem)) continue;
      issue.items.push({
        id: ensure.ensure(rawItem.id, 'di'),
        speaker: clampText(rawItem.speaker, 160),
        affiliation: clampText(rawItem.affiliation, 160),
        identity: pickEnum(rawItem.identity, DISCUSSION_IDENTITIES, 'other'),
        at: clampText(rawItem.at ?? rawItem.date, 60),
        channel: clampText(rawItem.channel, 80),
        view: clampText(rawItem.view ?? rawItem.statement, 1200),
        basis: clampText(rawItem.basis, 800),
        claimIds: filterBySet(rawItem.claimIds, claimIdSet),
        evidenceIds: filterBySet(rawItem.evidenceIds, evidenceIdSet),
        sourceIds: filterBySet(rawItem.sourceIds, sourceIdSet),
      });
    }
    for (const rawSide of asArray(rawIssue.sides)) {
      const item = asObject(rawSide);
      const position = clampText(item.position, 800);
      if (!position) continue;
      issue.sides.push({
        position,
        holders: asArray(item.holders).map((holder) => clampText(typeof holder === 'string' ? holder : asObject(holder).name, 160)).filter(Boolean),
        evidenceIds: filterBySet(item.evidenceIds, evidenceIdSet),
      });
    }
    archive.discussion.issues.push(issue);
  }
  // v1 disagreements → 讨论议题（没有 items，保留立场与缺口）
  for (const rawDisagreement of asArray(input.disagreements)) {
    if (!isObject(rawDisagreement)) continue;
    const sides = [];
    for (const rawSide of asArray(rawDisagreement.sides)) {
      const item = asObject(rawSide);
      const position = clampText(item.position, 800);
      if (!position) continue;
      sides.push({
        position,
        holders: asArray(item.holders).map((holder) => clampText(holder, 160)).filter(Boolean),
        evidenceIds: filterBySet(item.evidenceIds, evidenceIdSet),
      });
    }
    const topic = clampText(rawDisagreement.topic, 400);
    if (!topic && !sides.length) continue;
    archive.discussion.issues.push({
      id: ensure.ensure(/^d\d+$/.test(String(rawDisagreement.id || '').trim()) ? String(rawDisagreement.id).trim() : '', 'd'),
      question: topic,
      summary: clampText(rawDisagreement.ourRead, 800),
      status: 'partial',
      items: [],
      sides,
      disagreement: { origin: '', note: clampText(rawDisagreement.origin, 800) },
      gaps: clampText(rawDisagreement.missing, 800),
    });
  }

  const rawDiscussionCoverage = asObject(rawDiscussion.coverage);
  const hasDiscussion = archive.discussion.issues.some((issue) => issue.items.length > 0);
  let discussionCoverageStatus = pickEnum(
    rawDiscussionCoverage.status,
    MODULE_COVERAGE,
    hasDiscussion ? 'covered' : archive.discussion.issues.length ? 'partial' : 'missing',
  );
  if (discussionCoverageStatus === 'covered' && !hasDiscussion) {
    discussionCoverageStatus = archive.discussion.issues.length ? 'partial' : 'missing';
  }
  archive.discussion.coverage = {
    status: discussionCoverageStatus,
    note: clampText(rawDiscussionCoverage.note, 1000),
    limits: clampText(rawDiscussionCoverage.limits, 1000),
  };

  /* 判断：v2 judgments + v1 overview.findings */
  const rawJudgments = Array.isArray(input.judgments)
    ? input.judgments
    : asArray(rawOverview.findings).map((finding) => {
        const item = asObject(finding);
        return { ...item, claimIds: item.claimId ? [item.claimId] : [] };
      });
  archive.judgments = [];
  for (const rawJudgment of rawJudgments) {
    if (!isObject(rawJudgment)) continue;
    const text = clampText(rawJudgment.text, 800);
    if (!text) continue;
    archive.judgments.push({
      id: ensure.ensure(rawJudgment.id, 'j'),
      text,
      identity: pickEnum(rawJudgment.identity, IDENTITIES, 'analysis'),
      confidence: pickEnum(rawJudgment.confidence, CONFIDENCES, 'medium'),
      conditions: clampText(rawJudgment.conditions, 600),
      claimIds: filterBySet(rawJudgment.claimIds, claimIdSet),
      evidenceIds: [],
      sourceIds: [],
      independentSources: 0,
      stale: Boolean(rawJudgment.stale),
      note: clampText(rawJudgment.note, 600),
    });
  }

  /* 未知 */
  archive.unknowns = [];
  for (const rawUnknown of asArray(input.unknowns)) {
    if (!isObject(rawUnknown)) continue;
    const text = clampText(rawUnknown.text, 800);
    if (!text) continue;
    archive.unknowns.push({
      id: ensure.ensure(/^un\d+$/.test(String(rawUnknown.id || '').trim()) ? String(rawUnknown.id).trim() : '', 'un'),
      questionId: questionIdSet.has(String(rawUnknown.questionId)) ? String(rawUnknown.questionId) : '',
      text,
      whyItMatters: clampText(rawUnknown.whyItMatters, 600),
      howToClose: clampText(rawUnknown.howToClose, 600),
    });
  }

  /* 分支：v2 branches + v1 followups（根级与问题级） */
  archive.branches = [];
  const branchCandidates = [];
  for (const rawBranch of asArray(input.branches)) branchCandidates.push({ raw: rawBranch, questionId: '' });
  for (const rawFollowup of asArray(input.followups)) branchCandidates.push({ raw: rawFollowup, questionId: '' });
  for (const seed of questionSeeds) {
    for (const rawFollowup of asArray(seed.raw.followups)) branchCandidates.push({ raw: rawFollowup, questionId: seed.id });
  }
  for (const candidate of branchCandidates) {
    const item = asObject(candidate.raw);
    const text = clampText(typeof candidate.raw === 'string' ? candidate.raw : item.text, 600);
    if (!text) continue;
    const questionId = questionIdSet.has(String(item.questionId || candidate.questionId))
      ? String(item.questionId || candidate.questionId)
      : '';
    if (archive.branches.some((branch) => branch.text === text && branch.questionId === questionId)) continue;
    archive.branches.push({
      id: ensure.ensure(/^b\d+$/.test(String(item.id || '').trim()) ? String(item.id).trim() : '', 'b'),
      text,
      hook: clampText(item.hook, 600),
      priority: pickEnum(item.priority, PRIORITIES, 'medium'),
      status: pickEnum(item.status, ['open', 'answered'], 'open'),
      questionId,
      answeredBy: typeof item.answeredBy === 'string' ? item.answeredBy : '',
    });
  }

  /* 关联 */
  archive.connections = [];
  for (const rawConnection of asArray(input.connections)) {
    if (!isObject(rawConnection)) continue;
    const to = clampText(rawConnection.to, 300);
    const mechanism = clampText(rawConnection.mechanism, 1600);
    if (!to && !mechanism) continue;
    const fromId = String(rawConnection.from || '');
    const from = findQuestion(archive, fromId) || findClaim(archive, fromId) ? fromId : '';
    archive.connections.push({
      id: ensure.ensure(rawConnection.id, 'x'),
      from,
      to,
      kind: pickEnum(rawConnection.kind, CONNECTION_KINDS, 'dependency'),
      mechanism,
      claimIds: filterBySet(rawConnection.claimIds, claimIdSet),
      sourceIds: filterBySet(rawConnection.sourceIds, sourceIdSet),
      status: pickEnum(rawConnection.status, CONNECTION_STATUS, 'suggested'),
      note: clampText(rawConnection.note, 600),
    });
  }

  /* 修订 */
  archive.revisions = [];
  for (const rawRevision of asArray(input.revisions)) {
    if (!isObject(rawRevision)) continue;
    archive.revisions.push({
      id: ensure.ensure(rawRevision.id, 'r'),
      at: iso(rawRevision.at, archive.updatedAt),
      kind: pickEnum(rawRevision.kind, ['initial', 'followup', 'refresh'], 'initial'),
      summary: clampText(rawRevision.summary, 800),
      questionIds: filterBySet(rawRevision.questionIds, questionIdSet),
    });
  }

  /* 知识库记录（v1 结构保留） */
  archive.knowledgeBase = [];
  for (const rawRecord of asArray(input.knowledgeBase)) {
    if (!isObject(rawRecord)) continue;
    archive.knowledgeBase.push({
      id: ensure.ensure(rawRecord.id, 'kb'),
      format: pickEnum(rawRecord.format, ['full', 'brief'], 'full'),
      title: clampText(rawRecord.title, 300),
      kbJobId: clampText(rawRecord.kbJobId, 120),
      sourceId: clampText(rawRecord.sourceId, 120),
      pages: clampNumber(rawRecord.pages, 0, 10000, 0),
      ingestedAt: iso(rawRecord.ingestedAt, ''),
      status: pickEnum(rawRecord.status, ['done', 'ingesting', 'failed'], 'done'),
      note: clampText(rawRecord.note, 400),
    });
  }
  archive.knowledgeBase = archive.knowledgeBase.slice(0, 20);

  /* 统计计数器（派生值由 recount 重算） */
  const rawStats = asObject(input.stats);
  archive.stats = {
    searches: clampNumber(rawStats.searches, 0, 1e9, 0),
    fetched: clampNumber(rawStats.fetched, 0, 1e9, 0),
    llmCalls: clampNumber(rawStats.llmCalls, 0, 1e9, 0),
    sourceCount: 0,
    independentSourceCount: 0,
    unjudgedSourceCount: 0,
    claimCount: 0,
    evidenceCount: 0,
    annotationCount: 0,
    durationMs: clampNumber(rawStats.durationMs, 0, 1e9, 0),
    tokensIn: clampNumber(rawStats.tokensIn, 0, 1e12, 0),
    tokensOut: clampNumber(rawStats.tokensOut, 0, 1e12, 0),
  };

  /* 各集合之间的引用过滤（保证 validate 的 error 可归零） */
  for (const question of archive.questions) {
    if (question.relation.to && !questionIdSet.has(question.relation.to)) question.relation.to = null;
  }
  const entityIdSet = new Set(archive.understanding.entities.map((entity) => entity.id));
  const branchIdSet = new Set(archive.branches.map((branch) => branch.id));
  for (const question of archive.questions) {
    question.claimIds = filterBySet(question.claimIds, claimIdSet);
    question.evidenceIds = filterBySet(question.evidenceIds, evidenceIdSet);
    question.entityIds = filterBySet(question.entityIds, entityIdSet);
    question.branchIds = dedupeStrings([
      ...filterBySet(question.branchIds, branchIdSet),
      ...archive.branches.filter((branch) => branch.questionId === question.id).map((branch) => branch.id),
    ]);
  }
  for (const claim of archive.claims) {
    claim.questionIds = filterBySet(claim.questionIds, questionIdSet);
  }
  for (const branch of archive.branches) {
    if (branch.answeredBy && !(branchIdSet.has(branch.answeredBy) || claimIdSet.has(branch.answeredBy) || questionIdSet.has(branch.answeredBy))) {
      branch.answeredBy = '';
    }
  }
  for (const unknown of archive.unknowns) {
    if (unknown.questionId && !questionIdSet.has(unknown.questionId)) unknown.questionId = '';
  }
  for (const connection of archive.connections) {
    if (connection.from && !questionIdSet.has(connection.from) && !claimIdSet.has(connection.from)) connection.from = '';
  }

  /* pipeline 内部字段：原样保留（不写进对外 schema，但不能在 normalize 时丢掉） */
  for (const key of Object.keys(input)) {
    if (key.startsWith('_')) archive[key] = input[key];
  }

  recount(archive);
  return archive;
}

/* ------------------------------------------------------------------ */
/* 校验                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 校验档案。
 * error 只用于真正破坏追溯性的问题：引用不存在的 source / evidence / claim、重复 id、
 * fact / claim 无证据且未降级。覆盖不足、空讨论、空判断只算 warning。
 */
export function validateArchive(archive) {
  const errors = [];
  const warnings = [];
  if (!archive || typeof archive !== 'object') return { ok: false, errors: ['档案为空'], warnings };
  if (archive.version !== ARCHIVE_VERSION) warnings.push(`档案版本为 ${archive.version}，期望 ${ARCHIVE_VERSION}`);

  const requiredArrays = ['sources', 'evidence', 'claims', 'questions', 'judgments', 'unknowns', 'branches', 'connections', 'revisions'];
  for (const key of requiredArrays) {
    if (!Array.isArray(archive[key])) errors.push(`缺少数组字段 ${key}`);
  }
  if (!isObject(archive.understanding)) errors.push('缺少 understanding 模块');
  if (!isObject(archive.discussion)) errors.push('缺少 discussion 模块');
  if (errors.length) return { ok: false, errors, warnings };

  const sources = archive.sources;
  const evidenceItems = archive.evidence;
  const claims = archive.claims;
  const questions = archive.questions;
  const understanding = archive.understanding;
  const discussion = archive.discussion;
  const blocks = asArray(understanding.blocks);
  const entities = asArray(understanding.entities);
  const confusables = asArray(understanding.confusables);
  const timeline = asArray(understanding.timeline);
  const issues = asArray(discussion.issues);
  const judgments = archive.judgments;
  const unknowns = archive.unknowns;
  const branches = archive.branches;
  const connections = archive.connections;
  const revisions = archive.revisions;

  const sourceIdSet = new Set(sources.map((source) => source.id));
  const evidenceIdSet = new Set(evidenceItems.map((evidence) => evidence.id));
  const claimIdSet = new Set(claims.map((claim) => claim.id));
  const questionIdSet = new Set(questions.map((question) => question.id));
  const blockIdSet = new Set(blocks.map((block) => block.id));
  const issueIdSet = new Set(issues.map((issue) => issue.id));
  const itemIdSet = new Set();
  for (const issue of issues) for (const item of asArray(issue.items)) itemIdSet.add(item.id);
  const branchIdSet = new Set(branches.map((branch) => branch.id));

  const idOwner = new Map();
  const register = (id, where) => {
    if (typeof id !== 'string' || !id.trim()) {
      errors.push(`${where} 缺少 id`);
      return;
    }
    if (idOwner.has(id)) errors.push(`id 重复：${id}（${idOwner.get(id)} 与 ${where}）`);
    else idOwner.set(id, where);
  };
  const registerNested = (id, where) => {
    if (typeof id !== 'string' || !id.trim()) {
      warnings.push(`${where} 缺少 id`);
      return;
    }
    if (idOwner.has(id)) errors.push(`id 重复：${id}（${idOwner.get(id)} 与 ${where}）`);
    else idOwner.set(id, where);
  };

  const checkSourceIds = (ids, where) => {
    for (const id of asArray(ids)) {
      if (!sourceIdSet.has(id)) errors.push(`${where} 引用了不存在的来源 ${id}`);
    }
  };
  const checkEvidenceIds = (ids, where) => {
    for (const id of asArray(ids)) {
      if (!evidenceIdSet.has(id)) errors.push(`${where} 引用了不存在的证据 ${id}`);
    }
  };
  const checkClaimIds = (ids, where) => {
    for (const id of asArray(ids)) {
      if (!claimIdSet.has(id)) errors.push(`${where} 引用了不存在的论断 ${id}`);
    }
  };

  for (const source of sources) {
    register(source.id, '来源');
    if (!canonicalUrl(source.url)) warnings.push(`来源 ${source.id} 的 URL 无效或为空`);
  }

  for (const evidence of evidenceItems) {
    register(evidence.id, '证据');
    if (!evidence.text) warnings.push(`证据 ${evidence.id} 没有正文`);
    if (!asArray(evidence.sourceIds).length) errors.push(`证据 ${evidence.id} 没有来源`);
    checkSourceIds(evidence.sourceIds, `证据 ${evidence.id}`);
    if (!READ_SCOPES.includes(evidence.readScope)) warnings.push(`证据 ${evidence.id} 的 readScope 无效：${evidence.readScope}`);
    if (!evidence.locator) warnings.push(`证据 ${evidence.id} 没有 locator`);
  }

  for (const claim of claims) {
    register(claim.id, '论断');
    if (!claim.statement) warnings.push(`论断 ${claim.id} 没有 statement`);
    if ((claim.identity === 'fact' || claim.identity === 'claim') && !asArray(claim.evidenceIds).length) {
      errors.push(`论断 ${claim.id} 身份为 ${claim.identity} 但没有证据（应降级为 analysis）`);
    }
    checkEvidenceIds([...asArray(claim.evidenceIds), ...asArray(claim.opposeEvidenceIds)], `论断 ${claim.id}`);
    if (!EVIDENCE_STATUS.includes(claim.evidenceStatus)) warnings.push(`论断 ${claim.id} 的 evidenceStatus 无效：${claim.evidenceStatus}`);
  }

  for (const question of questions) {
    register(question.id, '问题');
    if (!WORK_STATUS.includes(question.workStatus)) warnings.push(`问题 ${question.id} 的 workStatus 无效：${question.workStatus}`);
    if (!QUESTION_COVERAGE.includes(question.coverage)) warnings.push(`问题 ${question.id} 的 coverage 无效：${question.coverage}`);
    if (question.relation && question.relation.to && !questionIdSet.has(question.relation.to)) {
      warnings.push(`问题 ${question.id} 的关系指向不存在的 ${question.relation.to}`);
    }
    checkClaimIds(question.claimIds, `问题 ${question.id}`);
    checkEvidenceIds(question.evidenceIds, `问题 ${question.id}`);
    for (const part of asArray(question.mechanism)) {
      registerNested(part.id, `问题 ${question.id} 的机制段`);
      checkClaimIds(part.claimIds, `机制段 ${part.id}`);
      checkEvidenceIds(part.evidenceIds, `机制段 ${part.id}`);
    }
    for (const part of asArray(question.counterpoints)) {
      registerNested(part.id, `问题 ${question.id} 的反例`);
      checkEvidenceIds(part.evidenceIds, `反例 ${part.id}`);
    }
    for (const gap of asArray(question.gaps)) registerNested(gap.id, `问题 ${question.id} 的缺口`);
    for (const branchId of asArray(question.branchIds)) {
      if (!branchIdSet.has(branchId)) warnings.push(`问题 ${question.id} 引用了不存在的分支 ${branchId}`);
    }
  }

  for (const block of blocks) {
    register(block.id, '理解块');
    checkClaimIds(block.claimIds, `理解块 ${block.id}`);
    checkEvidenceIds(block.evidenceIds, `理解块 ${block.id}`);
    if (block.text && !asArray(block.claimIds).length && !asArray(block.evidenceIds).length) {
      warnings.push(`理解块 ${block.id} 没有注释（coverage 可能为 missing）`);
    }
  }
  if (understanding.summaryClaimId && !claimIdSet.has(understanding.summaryClaimId)) {
    errors.push(`understanding.summaryClaimId 引用了不存在的论断 ${understanding.summaryClaimId}`);
  }
  checkEvidenceIds(understanding.summaryEvidenceIds, 'understanding.summary');
  for (const entity of entities) {
    register(entity.id, '实体');
    checkClaimIds(entity.claimIds, `实体 ${entity.id}`);
    checkSourceIds(entity.sourceIds, `实体 ${entity.id}`);
  }
  for (const item of confusables) {
    register(item.id, '混淆项');
    checkSourceIds(item.sourceIds, `混淆项 ${item.id}`);
  }
  for (const point of timeline) {
    register(point.id, '时间线');
    checkSourceIds(point.sourceIds, `时间线 ${point.id}`);
  }
  if (!MODULE_COVERAGE.includes(asObject(understanding.coverage).status)) {
    warnings.push(`基础认识 coverage.status 无效：${asObject(understanding.coverage).status}`);
  }

  for (const issue of issues) {
    register(issue.id, '讨论议题');
    checkEvidenceIds(asArray(issue.sides).flatMap((side) => asArray(side.evidenceIds)), `议题 ${issue.id}`);
    for (const item of asArray(issue.items)) {
      register(item.id, '讨论项');
      checkClaimIds(item.claimIds, `讨论项 ${item.id}`);
      checkEvidenceIds(item.evidenceIds, `讨论项 ${item.id}`);
      checkSourceIds(item.sourceIds, `讨论项 ${item.id}`);
    }
  }
  if (!MODULE_COVERAGE.includes(asObject(discussion.coverage).status)) {
    warnings.push(`讨论地图 coverage.status 无效：${asObject(discussion.coverage).status}`);
  }

  for (const judgment of judgments) {
    register(judgment.id, '判断');
    if (!judgment.text) warnings.push(`判断 ${judgment.id} 没有正文`);
    if (!asArray(judgment.claimIds).length) warnings.push(`判断 ${judgment.id} 没有引用任何论断`);
    checkClaimIds(judgment.claimIds, `判断 ${judgment.id}`);
    checkEvidenceIds(judgment.evidenceIds, `判断 ${judgment.id}`);
    checkSourceIds(judgment.sourceIds, `判断 ${judgment.id}`);
  }

  for (const unknown of unknowns) {
    register(unknown.id, '未知');
    if (unknown.questionId && !questionIdSet.has(unknown.questionId)) {
      warnings.push(`未知 ${unknown.id} 指向不存在的问题 ${unknown.questionId}`);
    }
  }

  for (const branch of branches) {
    register(branch.id, '分支');
    if (branch.questionId && !questionIdSet.has(branch.questionId)) {
      warnings.push(`分支 ${branch.id} 指向不存在的问题 ${branch.questionId}`);
    }
    if (branch.answeredBy && !(branchIdSet.has(branch.answeredBy) || claimIdSet.has(branch.answeredBy) || questionIdSet.has(branch.answeredBy))) {
      warnings.push(`分支 ${branch.id} 的 answeredBy 无法解析：${branch.answeredBy}`);
    }
  }

  for (const connection of connections) {
    register(connection.id, '关联');
    checkClaimIds(connection.claimIds, `关联 ${connection.id}`);
    checkSourceIds(connection.sourceIds, `关联 ${connection.id}`);
    if (connection.from && !questionIdSet.has(connection.from) && !claimIdSet.has(connection.from)) {
      warnings.push(`关联 ${connection.id} 的 from 无法解析：${connection.from}`);
    }
    if (!connection.to && !connection.mechanism) warnings.push(`关联 ${connection.id} 没有对象或机制`);
  }

  for (const revision of revisions) register(revision.id, '修订');

  /* 注释：编号连续、每个编号都落在存在的来源上、正文引用都有编号 */
  const index = buildAnnotationIndex(archive);
  let expectedNumber = 1;
  for (const entry of index.entries) {
    if (entry.number !== expectedNumber) errors.push(`注释编号不连续：第 ${expectedNumber} 个是 ${entry.number}`);
    expectedNumber += 1;
    if (!asArray(entry.sourceIds).length) errors.push(`注释 ${entry.number}（${entry.evidenceId}）没有来源`);
    checkSourceIds(entry.sourceIds, `注释 ${entry.number}`);
  }
  const referencedEvidence = new Set();
  const collectClaimEvidence = (claimIds) => {
    for (const claimId of asArray(claimIds)) {
      const claim = findClaim(archive, claimId);
      if (!claim) continue;
      for (const id of [...asArray(claim.evidenceIds), ...asArray(claim.opposeEvidenceIds)]) referencedEvidence.add(id);
    }
  };
  for (const block of blocks) {
    for (const id of asArray(block.evidenceIds)) referencedEvidence.add(id);
    collectClaimEvidence(block.claimIds);
  }
  for (const id of asArray(understanding.summaryEvidenceIds)) referencedEvidence.add(id);
  collectClaimEvidence([understanding.summaryClaimId]);
  for (const issue of issues) {
    for (const item of asArray(issue.items)) {
      for (const id of asArray(item.evidenceIds)) referencedEvidence.add(id);
      collectClaimEvidence(item.claimIds);
    }
  }
  for (const question of questions) {
    collectClaimEvidence(question.claimIds);
    for (const id of asArray(question.evidenceIds)) referencedEvidence.add(id);
  }
  for (const judgment of judgments) {
    collectClaimEvidence(judgment.claimIds);
    for (const id of asArray(judgment.evidenceIds)) referencedEvidence.add(id);
  }
  for (const evidenceId of referencedEvidence) {
    if (index.byEvidenceId[evidenceId]) continue;
    const evidence = findEvidence(archive, evidenceId);
    if (evidence && asArray(evidence.sourceIds).length) {
      errors.push(`证据 ${evidenceId} 出现在正文引用中，但没有注释编号`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------ */
/* 证据链                                                               */
/* ------------------------------------------------------------------ */

function topicBrief(archive) {
  const topic = asObject(archive.topic);
  return { id: archive.id, title: topic.title || '', definition: topic.definition || '' };
}

function questionBrief(question) {
  if (!question) return null;
  return {
    id: question.id,
    question: question.question || '',
    why: question.why || '',
    coverage: question.coverage || '',
    workStatus: question.workStatus || '',
  };
}

function sourcesOfIds(archive, ids) {
  return asArray(ids).map((id) => findSource(archive, id)).filter(Boolean);
}

function collectBundles(archive, evidenceIds) {
  const bundles = [];
  for (const id of asArray(evidenceIds)) {
    const evidence = findEvidence(archive, id);
    if (!evidence) continue;
    bundles.push({ evidence, sources: sourcesOfIds(archive, evidence.sourceIds) });
  }
  return bundles;
}

function uniqueNumbers(values) {
  const out = [];
  for (const value of asArray(values)) {
    if (typeof value === 'number' && !out.includes(value)) out.push(value);
  }
  return out;
}

function claimChain(archive, claim, index) {
  const question = asArray(claim.questionIds).map((id) => findQuestion(archive, id)).filter(Boolean)[0] || null;
  const supportIds = [];
  const opposeIds = [];
  for (const id of asArray(claim.evidenceIds)) {
    const evidence = findEvidence(archive, id);
    if (!evidence) continue;
    if (evidence.stance === 'oppose') opposeIds.push(id);
    else supportIds.push(id);
  }
  for (const id of asArray(claim.opposeEvidenceIds)) if (!opposeIds.includes(id)) opposeIds.push(id);
  const support = collectBundles(archive, supportIds);
  const oppose = collectBundles(archive, opposeIds);
  const sources = uniqueBy([...support, ...oppose].flatMap((bundle) => bundle.sources), (source) => source.id);
  return {
    kind: 'claim',
    topic: topicBrief(archive),
    question: questionBrief(question),
    claim,
    evidenceStatus: claim.evidenceStatus,
    support,
    oppose,
    gaps: asArray(question && question.gaps),
    sources,
    annotations: uniqueNumbers([...supportIds, ...opposeIds].map((id) => (index.byEvidenceId[id] ? index.byEvidenceId[id].number : null))),
  };
}

function evidenceChain(archive, evidence, index) {
  const question = evidence.questionId ? findQuestion(archive, evidence.questionId) : null;
  const claims = asArray(archive.claims).filter(
    (claim) => asArray(claim.evidenceIds).includes(evidence.id) || asArray(claim.opposeEvidenceIds).includes(evidence.id),
  );
  const bundle = { evidence, sources: sourcesOfIds(archive, evidence.sourceIds) };
  return {
    kind: 'evidence',
    topic: topicBrief(archive),
    question: questionBrief(question),
    claim: claims[0] || null,
    claims,
    evidence,
    support: [bundle],
    oppose: [],
    gaps: asArray(question && question.gaps),
    sources: bundle.sources,
    annotations: index.byEvidenceId[evidence.id] ? [index.byEvidenceId[evidence.id].number] : [],
  };
}

function judgmentChain(archive, judgment, index) {
  const claims = asArray(judgment.claimIds).map((id) => findClaim(archive, id)).filter(Boolean);
  const supportIds = [];
  const opposeIds = [];
  for (const claim of claims) {
    for (const id of asArray(claim.evidenceIds)) {
      const evidence = findEvidence(archive, id);
      if (!evidence) continue;
      if (evidence.stance === 'oppose') opposeIds.push(id);
      else supportIds.push(id);
    }
    for (const id of asArray(claim.opposeEvidenceIds)) if (!opposeIds.includes(id)) opposeIds.push(id);
  }
  const support = collectBundles(archive, dedupeStrings(supportIds));
  const oppose = collectBundles(archive, dedupeStrings(opposeIds));
  const sources = uniqueBy([...support, ...oppose].flatMap((bundle) => bundle.sources), (source) => source.id);
  const question = claims.length ? asArray(claims[0].questionIds).map((id) => findQuestion(archive, id)).filter(Boolean)[0] || null : null;
  return {
    kind: 'judgment',
    topic: topicBrief(archive),
    question: questionBrief(question),
    judgment,
    claims,
    support,
    oppose,
    gaps: asArray(question && question.gaps),
    sources,
    annotations: uniqueNumbers([...supportIds, ...opposeIds].map((id) => (index.byEvidenceId[id] ? index.byEvidenceId[id].number : null))),
  };
}

function blockChain(archive, block, index) {
  const claims = asArray(block.claimIds).map((id) => findClaim(archive, id)).filter(Boolean);
  const evidenceIds = dedupeStrings([...asArray(block.evidenceIds), ...claims.flatMap((claim) => [...claim.evidenceIds, ...claim.opposeEvidenceIds])]);
  const bundles = collectBundles(archive, evidenceIds);
  return {
    kind: 'understanding-block',
    topic: topicBrief(archive),
    question: null,
    block,
    claims,
    support: bundles,
    oppose: [],
    gaps: [],
    sources: uniqueBy(bundles.flatMap((bundle) => bundle.sources), (source) => source.id),
    annotations: uniqueNumbers(evidenceIds.map((id) => (index.byEvidenceId[id] ? index.byEvidenceId[id].number : null))),
  };
}

function discussionItemChain(archive, item, index) {
  const claims = asArray(item.claimIds).map((id) => findClaim(archive, id)).filter(Boolean);
  const evidenceIds = dedupeStrings([...asArray(item.evidenceIds), ...claims.flatMap((claim) => [...claim.evidenceIds, ...claim.opposeEvidenceIds])]);
  const bundles = collectBundles(archive, evidenceIds);
  const issue = asArray(asObject(archive.discussion).issues).find((entry) => asArray(entry.items).includes(item)) || null;
  return {
    kind: 'discussion-item',
    topic: topicBrief(archive),
    question: null,
    issue,
    item,
    claims,
    support: bundles,
    oppose: [],
    gaps: asArray(issue && issue.gaps),
    sources: uniqueBy(bundles.flatMap((bundle) => bundle.sources), (source) => source.id),
    annotations: uniqueNumbers(evidenceIds.map((id) => (index.byEvidenceId[id] ? index.byEvidenceId[id].number : null))),
  };
}

function sourceChain(archive, source, index) {
  const usage = [];
  for (const evidence of asArray(archive.evidence)) {
    if (!asArray(evidence.sourceIds).includes(source.id)) continue;
    const claims = asArray(archive.claims).filter(
      (claim) => asArray(claim.evidenceIds).includes(evidence.id) || asArray(claim.opposeEvidenceIds).includes(evidence.id),
    );
    const question = evidence.questionId ? findQuestion(archive, evidence.questionId) : null;
    usage.push({ evidence, claim: claims[0] || null, claims, question });
  }
  const annotations = asArray(index.bySourceId[source.id]).map((entry) => entry.number);
  return {
    kind: 'source',
    topic: topicBrief(archive),
    question: null,
    source,
    usage,
    support: [],
    oppose: [],
    gaps: [],
    sources: [source],
    annotations,
  };
}

function questionChain(archive, question, index) {
  const claimIds = dedupeStrings([
    ...asArray(question.claimIds),
    ...archive.claims.filter((claim) => asArray(claim.questionIds).includes(question.id)).map((claim) => claim.id),
  ]);
  const claims = claimIds.map((id) => findClaim(archive, id)).filter(Boolean);
  const evidenceIds = dedupeStrings([
    ...asArray(question.evidenceIds),
    ...claims.flatMap((claim) => [...claim.evidenceIds, ...claim.opposeEvidenceIds]),
  ]);
  const bundles = collectBundles(archive, evidenceIds);
  const oppose = bundles.filter((bundle) => bundle.evidence.stance === 'oppose');
  const support = bundles.filter((bundle) => bundle.evidence.stance !== 'oppose');
  return {
    kind: 'question',
    topic: topicBrief(archive),
    question: questionBrief(question),
    claims,
    support,
    oppose,
    gaps: asArray(question.gaps),
    sources: uniqueBy(bundles.flatMap((bundle) => bundle.sources), (source) => source.id),
    annotations: uniqueNumbers(evidenceIds.map((id) => (index.byEvidenceId[id] ? index.byEvidenceId[id].number : null))),
  };
}

/**
 * 证据链：claim / evidence / judgment / understanding block / discussion item /
 * source / question / branch 都可以作为入口，返回可展示的追溯结构。
 */
export function chainOf(archive, refId) {
  if (!archive || !refId) return null;
  const id = String(refId);
  const index = buildAnnotationIndex(archive);

  const claim = findClaim(archive, id);
  if (claim) return claimChain(archive, claim, index);

  const evidence = findEvidence(archive, id);
  if (evidence) return evidenceChain(archive, evidence, index);

  const judgment = findJudgment(archive, id);
  if (judgment) return judgmentChain(archive, judgment, index);

  const block = asArray(asObject(archive.understanding).blocks).find((entry) => entry.id === id);
  if (block) return blockChain(archive, block, index);

  const item = findDiscussionItem(archive, id);
  if (item) return discussionItemChain(archive, item, index);

  const issue = findIssue(archive, id);
  if (issue) {
    return {
      kind: 'discussion-issue',
      topic: topicBrief(archive),
      question: null,
      issue,
      items: asArray(issue.items),
      support: [],
      oppose: [],
      gaps: asArray(issue.gaps),
      sources: sourcesOfIds(archive, asArray(issue.items).flatMap((entry) => entry.sourceIds)),
      annotations: uniqueNumbers(
        asArray(issue.items).flatMap((entry) => asArray(entry.evidenceIds).map((evidenceId) => (index.byEvidenceId[evidenceId] ? index.byEvidenceId[evidenceId].number : null))),
      ),
    };
  }

  const source = findSource(archive, id);
  if (source) return sourceChain(archive, source, index);

  const question = findQuestion(archive, id);
  if (question) return questionChain(archive, question, index);

  const branch = findBranch(archive, id);
  if (branch) {
    const targetQuestion = branch.questionId ? findQuestion(archive, branch.questionId) : null;
    return {
      kind: 'branch',
      topic: topicBrief(archive),
      question: questionBrief(targetQuestion),
      branch,
      answeredBy: branch.answeredBy ? findClaim(archive, branch.answeredBy) || findBranch(archive, branch.answeredBy) || findQuestion(archive, branch.answeredBy) : null,
      support: [],
      oppose: [],
      gaps: [],
      sources: [],
      annotations: [],
    };
  }

  const unknown = asArray(archive.unknowns).find((entry) => entry.id === id);
  if (unknown) {
    return {
      kind: 'unknown',
      topic: topicBrief(archive),
      question: questionBrief(unknown.questionId ? findQuestion(archive, unknown.questionId) : null),
      unknown,
      support: [],
      oppose: [],
      gaps: [{ id: '', text: unknown.text, whyItMatters: unknown.whyItMatters, howToClose: unknown.howToClose }],
      sources: [],
      annotations: [],
    };
  }

  const connection = asArray(archive.connections).find((entry) => entry.id === id);
  if (connection) {
    return {
      kind: 'connection',
      topic: topicBrief(archive),
      question: questionBrief(connection.from ? findQuestion(archive, connection.from) : null),
      connection,
      support: [],
      oppose: [],
      gaps: [],
      sources: sourcesOfIds(archive, connection.sourceIds),
      annotations: [],
    };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* 摘要                                                                 */
/* ------------------------------------------------------------------ */

/** 档案列表摘要（面板左栏 / 工具用）。 */
export function archiveSummary(archive) {
  const topic = asObject(archive && archive.topic);
  const input = asObject(archive && archive.input);
  const branches = asArray(archive && archive.branches);
  const openBranches = branches.filter((branch) => branch.status !== 'answered');
  return {
    id: archive && archive.id,
    title: topic.title || '',
    kind: topic.kind || '',
    query: input.query || '',
    status: archive && archive.status,
    createdAt: archive && archive.createdAt,
    updatedAt: archive && archive.updatedAt,
    depth: topic.depth || input.depth || '',
    questionCount: asArray(archive && archive.questions).length,
    sourceCount: asArray(archive && archive.sources).length,
    claimCount: asArray(archive && archive.claims).length,
    evidenceCount: asArray(archive && archive.evidence).length,
    issueCount: asArray(archive && archive.discussion && archive.discussion.issues).length,
    judgmentCount: asArray(archive && archive.judgments).length,
    unknownCount: asArray(archive && archive.unknowns).length,
    branchCount: branches.length,
    openBranchCount: openBranches.length,
    understandingStatus: asObject(archive && archive.understanding).status || '',
    discussionStatus: asObject(asObject(archive && archive.discussion).coverage).status || '',
    readingMinutes: clampNumber(topic.readingMinutes, 0, 1e6, 0),
    // v1 面板字段兼容
    followupCount: openBranches.length,
  };
}
