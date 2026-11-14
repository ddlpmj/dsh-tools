/**
 * lib/render.js —— 主题档案 → Markdown（CONTRACT v2 §3.2、§7）。
 *
 * 两个变体：
 *  - full：完整档案，六模块固定顺序，正文带 [n] 注释，来源索引按编号列出；
 *  - brief：一页纸简报（≤1500 字），保留注释编号与精简来源索引。
 *
 * 约定：
 *  - 纯函数：不改动 archive，不访问网络与磁盘；
 *  - 注释编号来自 model.buildAnnotationIndex（同一 evidence 同号，面板与导出共用）；
 *    model 尚未提供该函数或调用失败时，用本地同构实现兜底，保证 render 可独立测试；
 *  - 空模块保留标题与覆盖限制，不整节省略，也不编造内容补齐；
 *  - 兼容 CONTRACT 增补字段：understanding.summaryClaimIds / summaryEvidenceIds、
 *    archive.tensions、archive.readingNote；字段缺失时跳过，不报错；
 *  - 中文排版干净：无 emoji，不用「综上所述」「以上就是」「核心在于」式套话。
 */

import * as modelModule from './model.js';

/* ------------------------------------------------------------------ */
/* 枚举文案                                                            */
/* ------------------------------------------------------------------ */

const MODULE_TITLES = {
  understanding: '这是什么',
  discussion: '大家在讨论什么',
  questions: '值得深入理解什么',
  judgments: '目前能确定什么',
  branches: '接下来值得查什么',
  sources: '资料来源',
  revisions: '修订记录',
};

const TOPIC_KIND_LABELS = {
  technology: '技术',
  company: '公司',
  phenomenon: '社会现象',
  event: '事件',
  person: '人物',
  concept: '概念',
  policy: '政策',
};

const IDENTITY_LABELS = { fact: '事实', claim: '声称', analysis: '分析', unknown: '未知' };
const CONFIDENCE_LABELS = { high: '高', medium: '中', low: '低' };
const EVIDENCE_STATUS_LABELS = {
  supported: '证据充分',
  limited: '证据有限',
  conflicted: '证据冲突',
  unsupported: '暂无证据',
};
const QUESTION_COVERAGE_LABELS = {
  answered: '已回答',
  partial: '部分回答',
  disputed: '有争议',
  'no-evidence': '无证据',
};
const MODULE_COVERAGE_LABELS = { covered: '已覆盖', partial: '部分覆盖', missing: '缺失' };
const WORK_STATUS_LABELS = {
  pending: '待开始',
  researching: '检索中',
  done: '完成',
  partial: '部分完成',
  failed: '失败',
  blocked: '受阻',
};
const DISCUSSION_IDENTITY_LABELS = {
  company: '公司',
  researcher: '研究者',
  user: '用户',
  media: '媒体',
  official: '官方',
  other: '其他',
};
const ROLE_LABELS = {
  definition: '定义',
  mechanism: '机制',
  evidence: '证据',
  'political-economy': '利益结构',
  uncertainty: '不确定性',
  context: '背景',
  custom: '自定义',
};
const CONNECTION_KIND_LABELS = {
  constraint: '约束',
  dependency: '依赖',
  analogy: '类比',
  'same-root': '同源',
  counterweight: '制衡',
};
const CONNECTION_STATUS_LABELS = { verified: '已证实', suggested: '待验证', unverified: '线索' };
const SOURCE_KIND_LABELS = {
  primary: '原始材料',
  report: '报道',
  data: '数据',
  analysis: '分析',
  interview: '访谈',
  social: '社交帖',
  other: '其他',
};
const INDEPENDENCE_LABELS = {
  primary: '一手',
  independent: '独立',
  syndicated: '转述',
  unknown: '未判定',
};
const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
const BRANCH_STATUS_LABELS = { open: '开放', answered: '已回答' };
const READ_SCOPE_LABELS = {
  'full-text': '全文',
  section: '章节',
  abstract: '摘要',
  snippet: '搜索片段',
  transcript: '转写',
};
const REVISION_KIND_LABELS = { initial: '首轮', followup: '追问', refresh: '刷新' };
const ARCHIVE_STATUS_LABELS = {
  draft: '草稿',
  running: '进行中',
  done: '完成',
  partial: '部分完成',
  failed: '失败',
};
const ENTITY_TYPE_LABELS = {
  company: '公司',
  person: '人物',
  technology: '技术',
  event: '事件',
  organization: '机构',
  concept: '概念',
};
const BLOCK_KIND_LABELS = {
  definition: '这是什么',
  purpose: '解决什么问题',
  'how-it-works': '怎样运作',
  background: '必要背景',
  confusable: '容易混淆',
  fact: '相关事实',
};
const BLOCK_KIND_ORDER = ['definition', 'purpose', 'how-it-works', 'background', 'confusable', 'fact'];
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function uniqueStrings(values) {
  const out = [];
  for (const value of values) {
    if (typeof value === 'string' && value && !out.includes(value)) out.push(value);
  }
  return out;
}

function label(map, value, fallback = '') {
  if (typeof value === 'string' && map[value]) return map[value];
  return fallback || (typeof value === 'string' ? value : '');
}

/** 多行文本清理：去掉围栏，保留段落。 */
function inline(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/```+/g, '')
    .trim();
}

/** 单行字段清理：把换行压成空格。 */
function oneLine(value) {
  return inline(value).replace(/\s*\n+\s*/g, ' ');
}

/** 段落清理：不破坏 Markdown 结构（转义行首标题与引用）。 */
function paragraph(value) {
  return inline(value)
    .replace(/^(#{1,6})\s/gm, '\\$1 ')
    .replace(/^>\s?/gm, '\\> ');
}

/** 截断到 max 个字符，保留省略号。 */
function cap(value, max) {
  const str = String(value ?? '');
  if (!max || str.length <= max) return str;
  return `${str.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function fmtDate(value, { withTime = false } = {}) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).trim();
  try {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(withTime ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : {}),
    }).format(date);
    return formatted.replace(/\//g, '-').replace(/\s+/g, ' ').trim();
  } catch {
    return date.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ');
  }
}

function hostOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 档案索引：来源 / 证据 / 论断                                        */
/* ------------------------------------------------------------------ */

function buildMaps(archive) {
  const safe = archive && typeof archive === 'object' ? archive : {};
  const evidenceById = new Map();
  const claimById = new Map();
  const sourceById = new Map();
  for (const source of asArray(safe.sources)) {
    if (source && text(source.id) && !sourceById.has(source.id)) sourceById.set(source.id, source);
  }
  for (const evidence of asArray(safe.evidence)) {
    if (evidence && text(evidence.id) && !evidenceById.has(evidence.id)) evidenceById.set(evidence.id, evidence);
  }
  for (const claim of asArray(safe.claims)) {
    if (claim && text(claim.id) && !claimById.has(claim.id)) claimById.set(claim.id, claim);
  }
  // v1 兼容：证据与结论嵌在 question 里时也能解析（normalizeArchive 之前的档案）。
  for (const question of asArray(safe.questions)) {
    for (const evidence of asArray(question?.evidence)) {
      if (evidence && text(evidence.id) && !evidenceById.has(evidence.id)) evidenceById.set(evidence.id, evidence);
    }
    for (const claim of asArray(question?.conclusions)) {
      if (claim && text(claim.id) && !claimById.has(claim.id)) claimById.set(claim.id, claim);
    }
  }
  return { evidenceById, claimById, sourceById, sourceIds: new Set(sourceById.keys()) };
}

function orderedQuestions(archive) {
  return asArray(archive?.questions)
    .filter(Boolean)
    .slice()
    .sort((a, b) => {
      const left = Number.isFinite(a.order) ? a.order : Number.MAX_SAFE_INTEGER;
      const right = Number.isFinite(b.order) ? b.order : Number.MAX_SAFE_INTEGER;
      return left - right;
    });
}

function orderedBlocks(archive) {
  const blocks = asArray(archive?.understanding?.blocks).filter(Boolean);
  const rank = (block) => {
    const index = BLOCK_KIND_ORDER.indexOf(block.kind);
    return index === -1 ? BLOCK_KIND_ORDER.length : index;
  };
  return blocks.slice().sort((a, b) => rank(a) - rank(b));
}

function evidenceIdsOfClaim(claim) {
  if (!claim) return [];
  return uniqueStrings([...asArray(claim.evidenceIds), ...asArray(claim.opposeEvidenceIds)]);
}

/** 显示用：只取支持证据，反对证据在论断行单独标注。 */
function supportEvidenceIdsOfClaim(claim) {
  return claim ? uniqueStrings(asArray(claim.evidenceIds)) : [];
}

/** 从 claimIds 聚合支持证据（展示用，不含反对证据）。 */
function supportEvidenceIdsFromClaims(ctx, claimIds) {
  const out = [];
  for (const claimId of asArray(claimIds)) {
    const claim = ctx.claimById.get(claimId);
    if (!claim) continue;
    for (const evidenceId of supportEvidenceIdsOfClaim(claim)) {
      if (!out.includes(evidenceId)) out.push(evidenceId);
    }
  }
  return out;
}

function evidenceIdsFromClaims(ctx, claimIds) {
  const out = [];
  for (const claimId of asArray(claimIds)) {
    const claim = ctx.claimById.get(claimId);
    if (!claim) continue;
    for (const evidenceId of evidenceIdsOfClaim(claim)) {
      if (!out.includes(evidenceId)) out.push(evidenceId);
    }
  }
  return out;
}

function evidenceIdsOfBlock(ctx, block) {
  return uniqueStrings([...asArray(block?.evidenceIds), ...supportEvidenceIdsFromClaims(ctx, block?.claimIds)]);
}

function evidenceIdsOfItem(ctx, item) {
  return uniqueStrings([...asArray(item?.evidenceIds), ...supportEvidenceIdsFromClaims(ctx, item?.claimIds)]);
}

function evidenceIdsOfJudgment(ctx, judgment) {
  const own = asArray(judgment?.evidenceIds);
  if (own.length) return uniqueStrings(own);
  return supportEvidenceIdsFromClaims(ctx, judgment?.claimIds);
}

/** summary 的 claim 引用：兼容 model v2 的 summaryClaimId 与增补字段 summaryClaimIds。 */
function summaryClaimIdList(understanding) {
  const ids = [];
  if (text(understanding?.summaryClaimId)) ids.push(understanding.summaryClaimId);
  ids.push(...asArray(understanding?.summaryClaimIds));
  return uniqueStrings(ids);
}

/**
 * 一句话解释的注释：understanding.summaryEvidenceIds + summaryClaimId(s)。
 * 字段缺失时返回空数组，summary 不附编号。
 */
function summaryAnnotationIds(ctx) {
  const understanding = ctx.archive?.understanding || {};
  return uniqueStrings([
    ...asArray(understanding.summaryEvidenceIds),
    ...evidenceIdsFromClaims(ctx, summaryClaimIdList(understanding)),
  ]);
}

function claimsForQuestion(ctx, question) {
  if (!question) return [];
  const archive = ctx.archive;
  const wanted = new Set([
    ...asArray(question.claimIds),
    ...asArray(archive.claims)
      .filter((claim) => claim && asArray(claim.questionIds).includes(question.id))
      .map((claim) => claim.id),
  ]);
  const claims = asArray(archive.claims).filter((claim) => claim && wanted.has(claim.id));
  if (claims.length) return claims;
  // v1 兼容：结论嵌在 question 里。
  return asArray(question.conclusions).filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* 注释索引（CONTRACT §3.2）                                            */
/* ------------------------------------------------------------------ */

function finishAnnotationIndex(entries) {
  const sorted = entries.slice().sort((a, b) => a.number - b.number);
  const byEvidenceId = {};
  const bySourceId = {};
  const entryByNumber = new Map();
  for (const entry of sorted) {
    byEvidenceId[entry.evidenceId] = entry;
    entryByNumber.set(entry.number, entry);
    for (const sourceId of entry.sourceIds) {
      if (!bySourceId[sourceId]) bySourceId[sourceId] = [];
      bySourceId[sourceId].push({ number: entry.number, evidenceId: entry.evidenceId });
    }
  }
  return { entries: sorted, byEvidenceId, bySourceId, entryByNumber };
}

/**
 * 本地同构的注释索引：理解块 → 讨论项 → 问题论断 → 判断，
 * 同一 evidence 只编号一次。model.buildAnnotationIndex 未实现时使用。
 */
function localAnnotationIndex(archive) {
  const safe = archive && typeof archive === 'object' ? archive : {};
  const ctx = { archive: safe, ...buildMaps(safe) };
  const entries = [];
  const used = new Map();
  let number = 0;
  const add = (evidenceIds, module, questionId) => {
    for (const evidenceId of uniqueStrings(evidenceIds)) {
      if (used.has(evidenceId)) continue;
      const evidence = ctx.evidenceById.get(evidenceId);
      if (!evidence) continue;
      const sourceIds = uniqueStrings(asArray(evidence.sourceIds)).filter((id) => ctx.sourceIds.has(id));
      if (!sourceIds.length) continue;
      number += 1;
      const entry = {
        number,
        evidenceId,
        sourceIds,
        locator: text(evidence.locator),
        readScope: text(evidence.readScope),
        quote: text(evidence.quote),
        text: text(evidence.text),
        module: text(evidence.module) || module,
        questionId: text(evidence.questionId) || questionId,
        retrievedAt: text(evidence.retrievedAt),
        usedBy: [],
      };
      used.set(evidenceId, entry);
      entries.push(entry);
    }
  };

  // 与 model.buildAnnotationIndex 相同的阅读顺序：
  // understanding blocks（数组顺序）→ summary → discussion items → questions claims → judgments。
  const understanding = safe.understanding || {};
  for (const block of asArray(understanding.blocks)) {
    add(asArray(block?.evidenceIds), 'understanding', '');
    for (const claimId of asArray(block?.claimIds)) {
      add(evidenceIdsOfClaim(ctx.claimById.get(claimId)), 'understanding', '');
    }
  }
  add(asArray(understanding.summaryEvidenceIds), 'understanding', '');
  for (const claimId of summaryClaimIdList(understanding)) {
    add(evidenceIdsOfClaim(ctx.claimById.get(claimId)), 'understanding', '');
  }
  for (const issue of asArray(safe.discussion?.issues)) {
    for (const item of asArray(issue?.items)) {
      add(asArray(item?.evidenceIds), 'discussion', '');
      for (const claimId of asArray(item?.claimIds)) {
        add(evidenceIdsOfClaim(ctx.claimById.get(claimId)), 'discussion', '');
      }
    }
  }
  for (const question of orderedQuestions(safe)) {
    for (const claim of claimsForQuestion(ctx, question)) {
      add(evidenceIdsOfClaim(claim), 'question', text(question.id));
    }
    add(asArray(question.evidenceIds), 'question', text(question.id));
  }
  for (const judgment of asArray(safe.judgments)) {
    for (const claimId of asArray(judgment?.claimIds)) {
      add(evidenceIdsOfClaim(ctx.claimById.get(claimId)), 'judgment', '');
    }
    add(asArray(judgment?.evidenceIds), 'judgment', '');
  }
  return finishAnnotationIndex(entries);
}

function normalizeAnnotationIndex(raw, maps) {
  if (!raw || !Array.isArray(raw.entries)) return null;
  const entries = [];
  const seenNumbers = new Set();
  const seenEvidence = new Set();
  for (const item of raw.entries) {
    if (!item || typeof item !== 'object') continue;
    const number = Number(item.number);
    const evidenceId = text(item.evidenceId);
    if (!Number.isFinite(number) || number <= 0 || !evidenceId) continue;
    if (seenNumbers.has(number) || seenEvidence.has(evidenceId)) continue;
    const evidence = maps.evidenceById.get(evidenceId);
    const sourceIds = uniqueStrings([...asArray(item.sourceIds), ...asArray(evidence?.sourceIds)]).filter((id) =>
      maps.sourceIds.has(id),
    );
    if (!sourceIds.length) continue;
    seenNumbers.add(number);
    seenEvidence.add(evidenceId);
    entries.push({
      number,
      evidenceId,
      sourceIds,
      locator: text(item.locator) || text(evidence?.locator),
      readScope: text(item.readScope) || text(evidence?.readScope),
      quote: text(item.quote) || text(evidence?.quote),
      text: text(item.text) || text(evidence?.text),
      module: text(item.module) || text(evidence?.module),
      questionId: text(item.questionId) || text(evidence?.questionId),
      retrievedAt: text(item.retrievedAt) || text(evidence?.retrievedAt),
      usedBy: asArray(item.usedBy).slice(0, 32),
    });
  }
  if (!entries.length && maps.evidenceById.size > 0) return null;
  return finishAnnotationIndex(entries);
}

function annotationIndexFor(archive, maps) {
  try {
    const build = modelModule && modelModule.buildAnnotationIndex;
    if (typeof build === 'function') {
      const normalized = normalizeAnnotationIndex(build(archive), maps);
      if (normalized) return normalized;
    }
  } catch {
    // model 版本不可用时退回本地实现，不让导出整体失败。
  }
  return localAnnotationIndex(archive);
}

function createContext(archive) {
  const safe = archive && typeof archive === 'object' ? archive : {};
  const maps = buildMaps(safe);
  const index = annotationIndexFor(safe, maps);
  return {
    archive: safe,
    ...maps,
    index,
    entries: index.entries,
    byEvidenceId: index.byEvidenceId,
    bySourceId: index.bySourceId,
    entryByNumber: index.entryByNumber,
  };
}

/* ------------------------------------------------------------------ */
/* 编号与标记                                                          */
/* ------------------------------------------------------------------ */

function numbersFor(ctx, evidenceIds, { max = 0 } = {}) {
  const numbers = [];
  for (const evidenceId of uniqueStrings(asArray(evidenceIds))) {
    const entry = ctx.byEvidenceId[evidenceId];
    if (!entry) continue;
    if (!numbers.includes(entry.number)) numbers.push(entry.number);
  }
  numbers.sort((a, b) => a - b);
  return max > 0 ? numbers.slice(0, max) : numbers;
}

/** `[1][3]`（无前导空格）。 */
function tokensFor(ctx, evidenceIds, options) {
  return numbersFor(ctx, evidenceIds, options)
    .map((number) => `[${number}]`)
    .join('');
}

/** ` [1][3]`（正文行尾追加用）。 */
function marksFor(ctx, evidenceIds, options) {
  const tokens = tokensFor(ctx, evidenceIds, options);
  return tokens ? ` ${tokens}` : '';
}

/** 来源 id → 注释编号（用于实体、时间线、关联等只有 sourceIds 的位置）。 */
function sourceTokensFor(ctx, sourceIds, { max = 0 } = {}) {
  const numbers = [];
  for (const sourceId of uniqueStrings(asArray(sourceIds))) {
    for (const ref of asArray(ctx.bySourceId[sourceId])) {
      const number = Number(ref && ref.number);
      if (Number.isFinite(number) && !numbers.includes(number)) numbers.push(number);
    }
  }
  numbers.sort((a, b) => a - b);
  const limited = max > 0 ? numbers.slice(0, max) : numbers;
  return limited.map((number) => `[${number}]`).join('');
}

function collectNumbers(markdown) {
  const numbers = new Set();
  for (const match of String(markdown ?? '').matchAll(/\[(\d{1,4})\]/g)) {
    const number = Number(match[1]);
    if (Number.isFinite(number) && number > 0) numbers.add(number);
  }
  return numbers;
}

/* ------------------------------------------------------------------ */
/* 通用小段                                                           */
/* ------------------------------------------------------------------ */

function coverageLine(coverage, labelText = '覆盖说明') {
  if (!coverage || typeof coverage !== 'object') return '';
  const parts = [];
  if (coverage.status) parts.push(label(MODULE_COVERAGE_LABELS, coverage.status, '未标注'));
  if (text(coverage.note)) parts.push(oneLine(coverage.note));
  if (text(coverage.limits)) parts.push(`覆盖限制：${oneLine(coverage.limits)}`);
  return parts.length ? `**${labelText}**：${parts.join('；')}` : '';
}

function estimateMinutes(archive) {
  const pieces = [];
  const understanding = archive.understanding || {};
  pieces.push(text(understanding.summary));
  for (const block of asArray(understanding.blocks)) pieces.push(text(block?.text));
  for (const issue of asArray(archive.discussion?.issues)) {
    pieces.push(text(issue?.summary));
    for (const item of asArray(issue?.items)) pieces.push(text(item?.view));
  }
  for (const claim of asArray(archive.claims)) pieces.push(text(claim?.statement));
  for (const question of asArray(archive.questions)) pieces.push(text(question?.summary));
  for (const judgment of asArray(archive.judgments)) pieces.push(text(judgment?.text));
  for (const unknown of asArray(archive.unknowns)) pieces.push(text(unknown?.text));
  const chars = pieces.filter(Boolean).join('').length;
  if (!chars) return 0;
  return Math.max(1, Math.round(chars / 350));
}

function topicTitle(archive) {
  return oneLine(archive?.topic?.title || archive?.input?.query || '未命名主题');
}

/* ------------------------------------------------------------------ */
/* full：标题与元信息                                                  */
/* ------------------------------------------------------------------ */

function metaLine(archive) {
  const topic = archive.topic || {};
  const input = archive.input || {};
  const stats = archive.stats && typeof archive.stats === 'object' ? archive.stats : {};
  const sources = asArray(archive.sources).filter(Boolean);
  const sourceCount = Number.isFinite(stats.sourceCount) ? stats.sourceCount : sources.length;
  const independent = Number.isFinite(stats.independentSourceCount)
    ? stats.independentSourceCount
    : new Set(
        sources
          .filter((source) => source.independence === 'primary' || source.independence === 'independent')
          .map((source) => hostOf(source.url) || source.id),
      ).size;
  const unjudged = Number.isFinite(stats.unjudgedSourceCount) ? stats.unjudgedSourceCount : 0;
  const parts = [];
  if (topic.kind) parts.push(`类型：${label(TOPIC_KIND_LABELS, topic.kind, '未标注')}`);
  const cutoff = topic.cutoffAt || input.cutoffAt;
  parts.push(cutoff ? `信息截止：${fmtDate(cutoff, { withTime: true })}` : '信息截止：未记录');
  const window = archive.discussion?.scope?.window || input.discussionWindow;
  if (text(window)) parts.push(`讨论窗口：${oneLine(window)}`);
  parts.push(`${asArray(archive.questions).filter(Boolean).length} 个问题`);
  if (sourceCount > 0) {
    parts.push(`${sourceCount} 条来源（独立 ${independent}${unjudged ? `，未判定 ${unjudged}` : ''}）`);
  } else {
    parts.push('尚无来源');
  }
  const readingMinutes =
    Number.isFinite(topic.readingMinutes) && topic.readingMinutes > 0 ? topic.readingMinutes : estimateMinutes(archive);
  if (readingMinutes) parts.push(`约 ${readingMinutes} 分钟`);
  if (archive.status && archive.status !== 'done') {
    parts.push(`状态：${label(ARCHIVE_STATUS_LABELS, archive.status, '未标注')}`);
  }
  return `> ${parts.join(' · ')}`;
}

/* ------------------------------------------------------------------ */
/* full：01 这是什么                                                   */
/* ------------------------------------------------------------------ */

function understandingSection(ctx) {
  const archive = ctx.archive;
  const understanding = archive.understanding || {};
  const topic = archive.topic || {};
  const blocks = orderedBlocks(archive);
  const entities = asArray(understanding.entities).filter(Boolean);
  const confusables = asArray(understanding.confusables).filter(Boolean);
  const timeline = asArray(understanding.timeline).filter(Boolean);
  const summary = text(understanding.summary) || text(topic.definition);
  const lines = [`## ${MODULE_TITLES.understanding}`];

  if (text(archive.readingNote)) lines.push(paragraph(archive.readingNote));
  if (summary) lines.push(`${paragraph(summary)}${marksFor(ctx, summaryAnnotationIds(ctx), { max: 6 })}`);
  if (text(topic.scope)) lines.push(`**研究范围**：${paragraph(topic.scope)}`);
  if (text(topic.exclusions)) lines.push(`**不覆盖**：${paragraph(topic.exclusions)}`);
  if (text(topic.whyNow)) lines.push(`**为什么现在看**：${paragraph(topic.whyNow)}`);
  if (text(archive.input?.sourceConstraints)) {
    lines.push(`**资料限定**：${paragraph(archive.input.sourceConstraints)}`);
  }

  for (const block of blocks) {
    let heading = oneLine(block.title) || label(BLOCK_KIND_LABELS, block.kind, '补充说明');
    if (heading === MODULE_TITLES.understanding) heading = block.kind === 'definition' ? '定义' : '补充说明';
    lines.push(`### ${heading}`);
    const body = paragraph(block.text || '');
    const marks = marksFor(ctx, evidenceIdsOfBlock(ctx, block));
    if (body || marks) lines.push(`${body}${marks}`.trim());
  }

  if (entities.length) {
    const blockLines = ['**涉及的主体**', ''];
    for (const entity of entities) {
      const type = label(ENTITY_TYPE_LABELS, entity.type, '其他');
      const marks = sourceTokensFor(ctx, entity.sourceIds, { max: 4 });
      const role = text(entity.role) ? `：${oneLine(entity.role)}` : '';
      blockLines.push(`- **${oneLine(entity.name) || '未命名主体'}**（${type}）${role}${marks ? ` ${marks}` : ''}`);
    }
    lines.push(blockLines.join('\n'));
  }

  if (confusables.length) {
    const blockLines = ['**容易混淆**', ''];
    for (const item of confusables) {
      const marks = sourceTokensFor(ctx, item.sourceIds, { max: 4 });
      const term = `**${oneLine(item.term) || '未命名概念'}**`;
      const withText = text(item.confusedWith) ? `与 **${oneLine(item.confusedWith)}** 容易混` : '';
      const note = text(item.note) ? `：${oneLine(item.note)}` : '';
      blockLines.push(`- ${term}${withText ? ` ${withText}` : ''}${note}${marks ? ` ${marks}` : ''}`);
    }
    lines.push(blockLines.join('\n'));
  }

  if (timeline.length) {
    const blockLines = ['**时间线**', ''];
    for (const item of timeline) {
      const marks = sourceTokensFor(ctx, item.sourceIds, { max: 3 });
      blockLines.push(`- ${oneLine(item.at) || '时间未记录'}：${oneLine(item.text) || '未记录事件'}${marks ? ` ${marks}` : ''}`);
    }
    lines.push(blockLines.join('\n'));
  }

  if (!summary && !blocks.length) {
    lines.push('本轮可访问范围内，还没有形成可靠的基础认识，基础检索未取得可用材料。');
  }

  const coverage = coverageLine(understanding.coverage);
  if (coverage) lines.push(coverage);

  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full：02 大家在讨论什么                                             */
/* ------------------------------------------------------------------ */

function discussionSection(ctx) {
  const archive = ctx.archive;
  const discussion = archive.discussion || {};
  const scope = discussion.scope && typeof discussion.scope === 'object' ? discussion.scope : {};
  const issues = asArray(discussion.issues).filter(Boolean);
  const lines = [`## ${MODULE_TITLES.discussion}`];

  const scopeParts = [];
  if (text(scope.window)) scopeParts.push(`时间窗口 ${oneLine(scope.window)}`);
  const platforms = asArray(scope.platforms).filter(Boolean);
  if (platforms.length) scopeParts.push(`平台 ${platforms.slice(0, 6).map(oneLine).join('、')}`);
  const languages = asArray(scope.languages).filter(Boolean);
  if (languages.length) scopeParts.push(`语言 ${languages.slice(0, 4).map(oneLine).join('、')}`);
  if (Number.isFinite(scope.materialCount) && scope.materialCount > 0) scopeParts.push(`材料 ${scope.materialCount} 篇`);
  if (Number.isFinite(scope.speakerCount) && scope.speakerCount > 0) {
    scopeParts.push(`发言主体 ${scope.speakerCount} 个`);
  }
  if (text(scope.checkedAt)) scopeParts.push(`检索于 ${fmtDate(scope.checkedAt, { withTime: true })}`);
  if (scopeParts.length) lines.push(`**讨论范围**：${scopeParts.join(' · ')}`);
  if (text(scope.limits)) lines.push(`**覆盖限制**：${oneLine(scope.limits)}`);

  if (!issues.length) {
    lines.push('在本轮可访问范围内，尚不足以归纳公开讨论。');
  } else {
    const names = issues
      .map((issue) => oneLine(issue.question || issue.summary))
      .filter(Boolean)
      .slice(0, 5);
    if (names.length) lines.push(`本次查阅的讨论中，反复出现的议题包括：${names.join('；')}。`);
    for (const issue of issues) {
      const status = label(MODULE_COVERAGE_LABELS, issue.status);
      lines.push(`### ${oneLine(issue.question) || '未命名议题'}${status ? `（${status}）` : ''}`);
      if (text(issue.summary)) lines.push(paragraph(issue.summary));
      const items = asArray(issue.items).filter(Boolean);
      if (items.length) {
        const itemLines = [];
        for (const item of items) {
          const affiliation = oneLine(item.affiliation);
          const meta = [
            affiliation && affiliation !== oneLine(item.speaker) ? affiliation : '',
            item.identity ? label(DISCUSSION_IDENTITY_LABELS, item.identity, '身份未标注') : '',
            text(item.at) ? oneLine(item.at) : '',
            text(item.channel) ? oneLine(item.channel) : '',
          ].filter(Boolean);
          const marks = marksFor(ctx, evidenceIdsOfItem(ctx, item));
          itemLines.push(
            `- **${oneLine(item.speaker) || '发言者未确认'}**${meta.length ? `（${meta.join('，')}）` : ''}：${paragraph(item.view || '未记录观点')}${marks}`,
          );
          if (text(item.basis)) itemLines.push(`  - 依据：${oneLine(item.basis)}`);
        }
        lines.push(itemLines.join('\n'));
      } else {
        lines.push('本议题暂未记录可定位的讨论项。');
      }

      const sides = asArray(issue.sides).filter((side) => side && text(side.position));
      if (sides.length) {
        const sideLines = ['**分歧双方**', ''];
        for (const side of sides) {
          const holders = asArray(side.holders).filter(Boolean).map(oneLine);
          const tokens = tokensFor(ctx, side.evidenceIds);
          sideLines.push(
            `- ${holders.length ? `${holders.join('、')}：` : ''}${paragraph(side.position)}${tokens ? ` ${tokens}` : ''}`,
          );
        }
        lines.push(sideLines.join('\n'));
      }

      const disagreement = issue.disagreement && typeof issue.disagreement === 'object' ? issue.disagreement : {};
      if (text(disagreement.origin)) {
        lines.push(
          `**分歧来源**：${oneLine(disagreement.origin)}${text(disagreement.note) ? `。${oneLine(disagreement.note)}` : ''}`,
        );
      } else if (text(disagreement.note)) {
        lines.push(`**分歧说明**：${oneLine(disagreement.note)}`);
      }
      if (text(issue.gaps)) lines.push(`**缺口**：${oneLine(issue.gaps)}`);
    }
  }

  const coverage = coverageLine(discussion.coverage, '模块覆盖');
  if (coverage) lines.push(coverage);
  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full：03 值得深入理解什么                                           */
/* ------------------------------------------------------------------ */

function questionBlock(ctx, question) {
  const lines = [`### ${text(question.id) ? `${question.id} · ` : ''}${oneLine(question.question) || '未命名问题'}`];
  const meta = [
    question.role ? `角色 ${label(ROLE_LABELS, question.role, '自定义')}` : '',
    question.priority ? `优先级 ${label(PRIORITY_LABELS, question.priority)}` : '',
    question.coverage ? `覆盖 ${label(QUESTION_COVERAGE_LABELS, question.coverage)}` : '',
    question.workStatus ? `进度 ${label(WORK_STATUS_LABELS, question.workStatus)}` : '',
    question.confidence ? `置信度 ${label(CONFIDENCE_LABELS, question.confidence)}` : '',
  ].filter(Boolean);
  if (meta.length) lines.push(`*${meta.join(' · ')}*`);
  if (text(question.why)) lines.push(`**为什么问**：${paragraph(question.why)}`);
  if (text(question.evidenceNeed)) lines.push(`**需要什么证据**：${paragraph(question.evidenceNeed)}`);
  if (text(question.summary)) {
    lines.push(`**一句话回答**：${paragraph(question.summary)}${marksFor(ctx, asArray(question.evidenceIds), { max: 4 })}`);
  } else {
    lines.push('**一句话回答**：本轮没有形成一句话回答。');
  }

  const claims = claimsForQuestion(ctx, question);
  if (claims.length) {
    const claimLines = ['**论断**', ''];
    for (const claim of claims) {
      const claimMeta = [
        label(IDENTITY_LABELS, claim.identity, '分析'),
        claim.confidence ? `置信度 ${label(CONFIDENCE_LABELS, claim.confidence)}` : '',
        claim.evidenceStatus ? label(EVIDENCE_STATUS_LABELS, claim.evidenceStatus, '证据状态未标注') : '',
        text(claim.attribution) ? `归属 ${oneLine(claim.attribution)}` : '',
      ].filter(Boolean);
      claimLines.push(
        `- **${oneLine(claim.id) || '未命名论断'}**（${claimMeta.join('；')}）：${paragraph(claim.statement || '未记录论断')}${marksFor(ctx, supportEvidenceIdsOfClaim(claim))}`,
      );
      if (text(claim.basis)) claimLines.push(`  - 依据：${oneLine(claim.basis)}`);
      if (text(claim.conditions)) claimLines.push(`  - 成立条件：${oneLine(claim.conditions)}`);
      if (text(claim.scope)) claimLines.push(`  - 适用范围：${oneLine(claim.scope)}`);
      const oppose = tokensFor(ctx, claim.opposeEvidenceIds);
      if (oppose) claimLines.push(`  - 反对证据：${oppose}`);
      if (text(claim.supersededBy)) claimLines.push(`  - 已被 ${oneLine(claim.supersededBy)} 取代`);
    }
    lines.push(claimLines.join('\n'));
  } else {
    lines.push('**论断**：本轮没有形成可引用证据的论断。');
  }

  const mechanism = asArray(question.mechanism).filter((item) => item && text(item.text));
  if (mechanism.length) {
    const blockLines = ['**机制**', ''];
    for (const item of mechanism) {
      const marks = marksFor(ctx, [
        ...asArray(item.evidenceIds),
        ...supportEvidenceIdsFromClaims(ctx, item.claimIds),
      ]);
      blockLines.push(`- ${text(item.id) ? `${item.id} ` : ''}${paragraph(item.text)}${marks}`);
    }
    lines.push(blockLines.join('\n'));
  }

  const counterpoints = asArray(question.counterpoints).filter((item) => item && text(item.text));
  if (counterpoints.length) {
    const blockLines = ['**反例与限制**', ''];
    for (const item of counterpoints) {
      const marks = marksFor(ctx, item.evidenceIds);
      const condition = text(item.condition) ? `（成立条件：${oneLine(item.condition)}）` : '';
      blockLines.push(`- ${paragraph(item.text)}${condition}${marks}`);
    }
    lines.push(blockLines.join('\n'));
  }

  const gaps = asArray(question.gaps).filter((item) => item && text(item.text));
  if (gaps.length) {
    const blockLines = ['**缺口**', ''];
    for (const gap of gaps) {
      const detail = [
        text(gap.whyItMatters) ? `补上会改变：${oneLine(gap.whyItMatters)}` : '',
        text(gap.howToClose) ? `怎么补：${oneLine(gap.howToClose)}` : '',
      ].filter(Boolean);
      blockLines.push(
        `- ${text(gap.id) ? `${gap.id} ` : ''}${oneLine(gap.text)}${detail.length ? `（${detail.join('；')}）` : ''}`,
      );
    }
    lines.push(blockLines.join('\n'));
  }

  const branchIds = asArray(question.branchIds).filter(Boolean);
  if (branchIds.length) {
    const branchMap = new Map();
    for (const branch of asArray(ctx.archive.branches)) {
      if (branch && text(branch.id)) branchMap.set(branch.id, branch);
    }
    const branchLines = ['**分支**', ''];
    for (const branchId of branchIds) {
      const branch = branchMap.get(branchId);
      if (!branch) {
        branchLines.push(`- ${branchId}（详见「${MODULE_TITLES.branches}」）`);
        continue;
      }
      branchLines.push(
        `- ${oneLine(branch.id)}：${oneLine(branch.text)}${branch.priority ? `（优先级 ${label(PRIORITY_LABELS, branch.priority)}）` : ''}`,
      );
    }
    lines.push(branchLines.join('\n'));
  }

  if (question.workStatus === 'failed' || question.workStatus === 'blocked') {
    lines.push('这个问题的检索没有完成，以上内容只覆盖已读到的材料。');
  }

  return lines.join('\n\n');
}

function questionsSection(ctx) {
  const archive = ctx.archive;
  const questions = orderedQuestions(archive);
  const lines = [`## ${MODULE_TITLES.questions}`];
  if (!questions.length) {
    lines.push('本轮没有形成可单独回答的深度问题，深度分析尚未开始。');
    return lines.join('\n\n');
  }
  const directory = ['**问题目录**', ''];
  for (const question of questions) {
    const meta = [
      question.priority ? `优先级 ${label(PRIORITY_LABELS, question.priority)}` : '',
      question.coverage ? `覆盖 ${label(QUESTION_COVERAGE_LABELS, question.coverage)}` : '',
    ].filter(Boolean);
    directory.push(
      `- **${oneLine(question.id) || '未编号'}** ${oneLine(question.question) || '未命名问题'}${meta.length ? `（${meta.join(' · ')}）` : ''}`,
    );
  }
  lines.push(directory.join('\n'));
  for (const question of questions) lines.push(questionBlock(ctx, question));
  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full：04 目前能确定什么                                             */
/* ------------------------------------------------------------------ */

function judgmentsSection(ctx) {
  const archive = ctx.archive;
  const judgments = asArray(archive.judgments).filter(Boolean);
  const unknowns = asArray(archive.unknowns).filter((item) => item && text(item.text));
  const connections = asArray(archive.connections).filter((item) => item && text(item.mechanism));
  const lines = [`## ${MODULE_TITLES.judgments}`];

  const tensions = asArray(archive.tensions).filter((tension) => text(tension));
  if (tensions.length) {
    const blockLines = ['**值得注意的张力**', ''];
    for (const tension of tensions) blockLines.push(`- ${paragraph(tension)}`);
    lines.push(blockLines.join('\n'));
  }

  if (judgments.length) {
    const blockLines = ['**判断**', ''];
    for (const judgment of judgments) {
      const meta = [
        label(IDENTITY_LABELS, judgment.identity, '分析'),
        judgment.confidence ? `置信度 ${label(CONFIDENCE_LABELS, judgment.confidence)}` : '',
        Number.isFinite(judgment.independentSources) && judgment.independentSources > 0
          ? `${judgment.independentSources} 条独立信源`
          : '',
      ].filter(Boolean);
      blockLines.push(
        `- **${oneLine(judgment.id) || '未编号'}**（${meta.join('；')}）：${paragraph(judgment.text)}${marksFor(ctx, evidenceIdsOfJudgment(ctx, judgment))}`,
      );
      if (text(judgment.conditions)) blockLines.push(`  - 成立条件：${oneLine(judgment.conditions)}`);
      const claimIds = asArray(judgment.claimIds).filter(Boolean);
      if (claimIds.length) blockLines.push(`  - 依据论断：${claimIds.map(oneLine).join('、')}`);
      if (text(judgment.note)) blockLines.push(`  - 备注：${oneLine(judgment.note)}`);
      if (judgment.stale) blockLines.push('  - 状态：可能已过时，需要刷新');
    }
    lines.push(blockLines.join('\n'));
  } else {
    lines.push('本轮还没有形成可辩护的判断。');
  }

  if (unknowns.length) {
    const blockLines = ['**尚未确定**', ''];
    for (const item of unknowns) {
      const detail = [
        text(item.whyItMatters) ? `为什么重要：${oneLine(item.whyItMatters)}` : '',
        text(item.howToClose) ? `怎么补：${oneLine(item.howToClose)}` : '',
      ].filter(Boolean);
      blockLines.push(
        `- ${text(item.id) ? `${item.id} ` : ''}${oneLine(item.text)}${item.questionId ? `（关联 ${oneLine(item.questionId)}）` : ''}${detail.length ? `；${detail.join('；')}` : ''}`,
      );
    }
    lines.push(blockLines.join('\n'));
  } else {
    lines.push('**尚未确定**：本轮没有登记未确定的问题。');
  }

  if (connections.length) {
    const blockLines = ['**关联发现**', ''];
    for (const item of connections) {
      const meta = [label(CONNECTION_KIND_LABELS, item.kind), label(CONNECTION_STATUS_LABELS, item.status)]
        .filter(Boolean)
        .join(' · ');
      const marks = sourceTokensFor(ctx, item.sourceIds, { max: 4 });
      const from = text(item.from) ? `${oneLine(item.from)} → ` : '';
      blockLines.push(
        `- ${text(item.id) ? `${oneLine(item.id)} ` : ''}${from}${oneLine(item.to)}${meta ? `（${meta}）` : ''}：${paragraph(item.mechanism)}${marks ? ` ${marks}` : ''}`,
      );
      if (text(item.note)) blockLines.push(`  - 备注：${oneLine(item.note)}`);
    }
    lines.push(blockLines.join('\n'));
  }

  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full：05 接下来值得查什么                                           */
/* ------------------------------------------------------------------ */

function branchesSection(ctx) {
  const branches = asArray(ctx.archive.branches).filter((item) => item && text(item.text));
  const lines = [`## ${MODULE_TITLES.branches}`];
  if (!branches.length) {
    lines.push('本轮没有登记后续分支。');
    return lines.join('\n\n');
  }
  const sorted = branches
    .slice()
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
  const blockLines = [];
  for (const branch of sorted) {
    const meta = [
      branch.priority ? `${label(PRIORITY_LABELS, branch.priority)}优先级` : '',
      branch.status ? label(BRANCH_STATUS_LABELS, branch.status, '状态未标注') : '',
    ].filter(Boolean);
    blockLines.push(
      `- ${text(branch.id) ? `**${oneLine(branch.id)}** ` : ''}${oneLine(branch.text)}${meta.length ? `（${meta.join(' · ')}）` : ''}`,
    );
    if (text(branch.hook)) blockLines.push(`  - 补上会改变：${oneLine(branch.hook)}`);
    if (text(branch.questionId)) blockLines.push(`  - 来源问题：${oneLine(branch.questionId)}`);
    if (branch.status === 'answered' && text(branch.answeredBy)) {
      blockLines.push(`  - 已由 ${oneLine(branch.answeredBy)} 回答`);
    }
  }
  lines.push(blockLines.join('\n'));
  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full：06 资料来源                                                   */
/* ------------------------------------------------------------------ */

function sourceLink(source) {
  const title = (oneLine(source.title) || hostOf(source.url) || '未命名来源')
    .replace(/\[/g, '（')
    .replace(/\]/g, '）');
  const url = text(source.url) || text(source.canonicalUrl);
  if (!url) return title;
  const safeUrl = url.replace(/\s/g, '%20').replace(/[<>]/g, '');
  return `[${title}](<${safeUrl}>)`;
}

function sourceEntryLines(ctx, entry) {
  const sources = entry.sourceIds.map((id) => ctx.sourceById.get(id)).filter(Boolean);
  if (!sources.length) return [`- **[${entry.number}]** 来源信息缺失（证据 ${entry.evidenceId}）`];
  const primary = sources[0];
  const links = [sourceLink(primary), ...sources.slice(1).map((source) => `、${sourceLink(source)}`)].join('');
  const author = oneLine(primary.author) || oneLine(primary.publisher) || '作者未知';
  const publisher = oneLine(primary.publisher);
  const authorText = publisher && publisher !== author ? `${author}（${publisher}）` : author;
  const meta = [
    `作者/机构：${authorText}`,
    `发布：${primary.publishedAt ? fmtDate(primary.publishedAt) : '未知'}`,
    `性质：${label(SOURCE_KIND_LABELS, primary.kind, '未标注')}`,
    `独立性：${label(INDEPENDENCE_LABELS, primary.independence, '未判定')}`,
  ];
  const lines = [`- **[${entry.number}]** ${links} — ${meta.join(' · ')}`];

  const readBits = [`读取：${label(READ_SCOPE_LABELS, entry.readScope, '未标注读取范围')}`];
  if (text(entry.locator)) readBits.push(`定位：${oneLine(entry.locator)}`);
  const retrievedAt = text(entry.retrievedAt) || text(primary.retrievedAt);
  readBits.push(`获取：${retrievedAt ? fmtDate(retrievedAt, { withTime: true }) : '未记录'}`);
  lines.push(`  - ${readBits.join(' · ')}`);

  const quote = cap(oneLine(entry.quote).replace(/^[「『"']+|[」』"']+$/g, ''), 200);
  if (quote) lines.push(`  - 原文：「${quote}」`);
  if (text(entry.text)) lines.push(`  - 证据：${cap(oneLine(entry.text), 300)}`);
  const evidence = ctx.evidenceById.get(entry.evidenceId);
  const note = text(evidence?.note);
  if (note) lines.push(`  - 口径：${cap(oneLine(note), 200)}`);

  if (sources.length > 1) {
    const others = sources.slice(1).map((source) => {
      const name = oneLine(source.title) || hostOf(source.url) || '未命名来源';
      return source.publishedAt ? `${name}（${fmtDate(source.publishedAt)}）` : name;
    });
    lines.push(`  - 同组来源：${others.join('、')}`);
  }
  return lines;
}

function extraSourceLine(source) {
  const site = oneLine(source.publisher) || hostOf(source.url);
  const meta = [
    site,
    source.publishedAt ? fmtDate(source.publishedAt) : '',
    label(SOURCE_KIND_LABELS, source.kind, ''),
    `独立性：${label(INDEPENDENCE_LABELS, source.independence, '未判定')}`,
  ].filter(Boolean);
  return `- ${sourceLink(source)}${meta.length ? ` — ${meta.join(' · ')}` : ''}；未被正文引用`;
}

function sourcesSection(ctx, body) {
  const usedNumbers = collectNumbers(body);
  const numbered = ctx.entries.filter((entry) => usedNumbers.has(entry.number));
  const referencedSourceIds = new Set();
  for (const entry of numbered) for (const sourceId of entry.sourceIds) referencedSourceIds.add(sourceId);
  const allSources = asArray(ctx.archive.sources).filter((source) => source && text(source.id));
  const extras = allSources.filter((source) => !referencedSourceIds.has(source.id));

  const lines = [`## ${MODULE_TITLES.sources}`];
  if (numbered.length) {
    for (const entry of numbered) lines.push(sourceEntryLines(ctx, entry).join('\n'));
  } else if (!allSources.length) {
    lines.push('本轮没有记录到可核查的来源，正文因此没有注释编号。');
  } else {
    lines.push('本轮记录到的来源没有进入正文注释，列在下方补充阅读。');
  }
  if (extras.length) {
    lines.push(`**补充阅读**（未被正文引用，共 ${extras.length} 条）`);
    lines.push(extras.map((source) => extraSourceLine(source)).join('\n'));
  }
  const records = asArray(ctx.archive.anySearchRecords).filter((record) => text(record?.content));
  if (records.length) {
    lines.push('### AnySearch 结构化数据');
    for (const record of records) {
      const caption = [oneLine(record.title), oneLine(record.tag), oneLine(record.query),
        record.capturedAt ? fmtDate(record.capturedAt, { withTime: true }) : ''].filter(Boolean).join(' · ');
      const literal = [caption, '', ...record.content.split('\n')].map((line) => `    ${line}`).join('\n');
      lines.push(literal);
    }
  }
  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full：07 修订记录                                                   */
/* ------------------------------------------------------------------ */

function revisionsSection(ctx) {
  const revisions = asArray(ctx.archive.revisions).filter(Boolean);
  const lines = [`## ${MODULE_TITLES.revisions}`];
  if (!revisions.length) {
    lines.push('本档案还没有修订记录。');
    return lines.join('\n\n');
  }
  const items = [];
  for (const revision of revisions) {
    const at = text(revision.at) ? fmtDate(revision.at, { withTime: true }) : '时间未记录';
    const kind = label(REVISION_KIND_LABELS, revision.kind, '修订');
    const questionIds = asArray(revision.questionIds).filter(Boolean).map(oneLine);
    items.push(
      `- ${at}（${kind}）：${oneLine(revision.summary) || '无说明'}${questionIds.length ? `（问题：${questionIds.join('、')}）` : ''}`,
    );
  }
  lines.push(items.join('\n'));
  return lines.join('\n\n');
}

/* ------------------------------------------------------------------ */
/* full 组装                                                          */
/* ------------------------------------------------------------------ */

function renderFull(archive) {
  const ctx = createContext(archive);
  const header = [`# ${topicTitle(archive)}`, metaLine(archive)].join('\n\n');
  const body = [
    header,
    understandingSection(ctx),
    discussionSection(ctx),
    questionsSection(ctx),
    judgmentsSection(ctx),
    branchesSection(ctx),
  ]
    .filter(Boolean)
    .join('\n\n');
  const sources = sourcesSection(ctx, body);
  const revisions = revisionsSection(ctx);
  return `${[body, sources, revisions].filter(Boolean).join('\n\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* brief：一页纸简报（≤1500 字）                                       */
/* ------------------------------------------------------------------ */

const BRIEF_LIMITS = [
  {
    summaryMax: 160,
    issueCount: 3,
    issueMax: 70,
    judgmentCount: 4,
    judgmentMax: 95,
    unknownCount: 2,
    branchCount: 2,
    nextMax: 60,
    summaryMarks: 3,
  },
  {
    summaryMax: 160,
    issueCount: 3,
    issueMax: 60,
    judgmentCount: 3,
    judgmentMax: 85,
    unknownCount: 2,
    branchCount: 2,
    nextMax: 55,
    summaryMarks: 2,
  },
  {
    summaryMax: 140,
    issueCount: 2,
    issueMax: 55,
    judgmentCount: 3,
    judgmentMax: 80,
    unknownCount: 1,
    branchCount: 2,
    nextMax: 50,
    summaryMarks: 2,
  },
  {
    summaryMax: 120,
    issueCount: 2,
    issueMax: 48,
    judgmentCount: 2,
    judgmentMax: 70,
    unknownCount: 1,
    branchCount: 1,
    nextMax: 45,
    summaryMarks: 2,
  },
  {
    summaryMax: 100,
    issueCount: 1,
    issueMax: 40,
    judgmentCount: 2,
    judgmentMax: 60,
    unknownCount: 1,
    branchCount: 1,
    nextMax: 40,
    summaryMarks: 1,
  },
];

function briefHeader(ctx) {
  const topic = ctx.archive.topic || {};
  const meta = [];
  if (topic.kind) meta.push(label(TOPIC_KIND_LABELS, topic.kind, '主题'));
  const cutoff = topic.cutoffAt || ctx.archive.input?.cutoffAt;
  if (cutoff) meta.push(`信息截止 ${fmtDate(cutoff)}`);
  const sourceCount = asArray(ctx.archive.sources).filter(Boolean).length;
  meta.push(sourceCount ? `${sourceCount} 条来源` : '来源待补');
  return [`# ${cap(topicTitle(ctx.archive), 80)} · 简报`, `> ${meta.join(' · ')}`].join('\n\n');
}

function briefBodyBlocks(ctx, limit) {
  const archive = ctx.archive;
  const understanding = archive.understanding || {};
  const discussion = archive.discussion || {};
  const blocks = [];

  const summary = text(understanding.summary) || text(archive.topic?.definition);
  const summaryIds = summaryAnnotationIds(ctx);
  blocks.push(
    `**这是什么**\n\n${summary ? cap(paragraph(summary).replace(/\s*\n+\s*/g, ' '), limit.summaryMax) : '本轮还没有形成一句话解释。'}${marksFor(ctx, summaryIds, { max: limit.summaryMarks })}`,
  );

  const issues = asArray(discussion.issues).filter((issue) => issue && (text(issue.question) || text(issue.summary)));
  if (issues.length) {
    const lines = [];
    for (const issue of issues.slice(0, limit.issueCount)) {
      const evidenceIds = uniqueStrings(asArray(issue.items).flatMap((item) => evidenceIdsOfItem(ctx, item)));
      const status = label(MODULE_COVERAGE_LABELS, issue.status);
      lines.push(
        `- ${cap(oneLine(issue.question || issue.summary), limit.issueMax)}${status ? `（${status}）` : ''}${marksFor(ctx, evidenceIds, { max: 2 })}`,
      );
    }
    blocks.push(`**大家在讨论什么**\n\n${lines.join('\n')}`);
  } else {
    blocks.push('**大家在讨论什么**\n\n在本轮可访问范围内，尚不足以归纳公开讨论。');
  }

  const judgments = asArray(archive.judgments).filter((judgment) => judgment && text(judgment.text));
  if (judgments.length) {
    const lines = judgments
      .slice(0, limit.judgmentCount)
      .map(
        (judgment) =>
          `- ${cap(oneLine(judgment.text), limit.judgmentMax)}${marksFor(ctx, evidenceIdsOfJudgment(ctx, judgment), { max: 2 })}`,
      );
    blocks.push(`**目前能判断什么**\n\n${lines.join('\n')}`);
  } else {
    blocks.push('**目前能判断什么**\n\n本轮还没有形成可辩护的判断。');
  }

  const unknowns = asArray(archive.unknowns).filter((item) => item && text(item.text));
  const branches = asArray(archive.branches)
    .filter((branch) => branch && text(branch.text))
    .slice()
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
  const nextLines = [];
  for (const unknown of unknowns.slice(0, limit.unknownCount)) {
    nextLines.push(
      `- 待确认：${cap(oneLine(unknown.text), limit.nextMax)}${text(unknown.howToClose) ? `（怎么补：${cap(oneLine(unknown.howToClose), 30)}）` : ''}`,
    );
  }
  for (const branch of branches.slice(0, limit.branchCount)) {
    nextLines.push(
      `- 下一步：${cap(oneLine(branch.text), limit.nextMax)}${text(branch.hook) ? `（补上会改变：${cap(oneLine(branch.hook), 30)}）` : ''}`,
    );
  }
  blocks.push(
    nextLines.length
      ? `**还缺什么、下一步查什么**\n\n${nextLines.join('\n')}`
      : '**还缺什么、下一步查什么**\n\n本轮没有登记未知与后续分支。',
  );
  return blocks;
}

function briefSourceIndex(ctx, usedNumbers) {
  const numbers = [...usedNumbers].sort((a, b) => a - b);
  const lines = ['**来源索引**', ''];
  if (!numbers.length) {
    lines.push('本轮没有可引用的来源。');
    return lines.join('\n');
  }
  const referenced = new Set();
  for (const number of numbers) {
    const entry = ctx.entryByNumber.get(number);
    if (!entry) continue;
    for (const sourceId of entry.sourceIds) referenced.add(sourceId);
    const source = ctx.sourceById.get(entry.sourceIds[0]);
    const title = cap(oneLine(source?.title) || hostOf(source?.url) || `证据 ${entry.evidenceId}`, 40);
    const site = oneLine(source?.publisher) || hostOf(source?.url);
    const read = label(READ_SCOPE_LABELS, entry.readScope);
    lines.push(`- [${number}] ${title}${site ? `（${site}）` : ''}${read ? ` · ${read}` : ''}`);
  }
  const extra = asArray(ctx.archive.sources).filter((source) => source && text(source.id) && !referenced.has(source.id))
    .length;
  if (extra) lines.push('', `另有 ${extra} 条来源未进入简报，见完整版。`);
  return lines.join('\n');
}

function assembleBrief(ctx, blocks) {
  const usedNumbers = collectNumbers(blocks.join('\n\n'));
  return [briefHeader(ctx), ...blocks, briefSourceIndex(ctx, usedNumbers)].join('\n\n');
}

function renderBrief(archive) {
  const ctx = createContext(archive);
  let blocks = [];
  for (const limit of BRIEF_LIMITS) {
    blocks = briefBodyBlocks(ctx, limit);
    const markdown = assembleBrief(ctx, blocks);
    if (markdown.length + 1 <= 1500) return `${markdown}\n`;
  }
  // 仍然超长：从后往前整段收缩（不会切断来源索引与编号的对应关系）。
  blocks = briefBodyBlocks(ctx, BRIEF_LIMITS[BRIEF_LIMITS.length - 1]);
  while (blocks.length) {
    blocks.pop();
    const markdown = assembleBrief(ctx, blocks);
    if (markdown.length + 1 <= 1500) return `${markdown}\n`;
  }
  return `${assembleBrief(ctx, blocks)}\n`;
}

/* ------------------------------------------------------------------ */
/* 导出                                                               */
/* ------------------------------------------------------------------ */

/**
 * 档案 → Markdown。
 * @param {object} archive
 * @param {{variant?: 'full'|'brief'}} [options]
 * @returns {string}
 */
export function renderArchiveMarkdown(archive, { variant = 'full' } = {}) {
  const safe = archive && typeof archive === 'object' ? archive : {};
  const requested = String(variant || 'full').trim().toLowerCase();
  if (requested === 'brief') return renderBrief(safe);
  return renderFull(safe);
}

/** 导出可选变体（测试 / 面板用）。 */
export const RENDER_VARIANTS = ['full', 'brief'];
