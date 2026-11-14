/**
 * lib/plugin.js —— 运行时组装（CONTRACT §7 / §10）。
 *
 * 组装顺序：config → store → search / fetcher / llm → jobs → router。
 * pipeline / prompts / render 由 research-engine 提供（静态 import）；pipeline 延迟到
 * init / 首个任务时创建，创建失败会记录成可读的 engine.error，/health 照常可用。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import * as model from './model.js';
import * as promptsModule from './prompts.js';
import { createPipeline } from './pipeline.js';
import * as renderModule from './render.js';

import { normalizeConfig, publicConfig, SEARCH_MODES } from './config.js';
import { createStore } from './store.js';
import { createSearchService } from './search.js';
import { createAnySearchCatalog } from './anysearch.js';
import { createFetcher } from './fetchpage.js';
import { createLlmService } from './llm.js';
import { createJobQueue } from './jobs.js';
import { buildToolDefinitions as buildToolsFromRuntime } from './tools.js';
import { createRouter, httpError, redactSecrets } from './http.js';

export const PLUGIN_NAME = 'dsh-deep-search';
export const PLUGIN_VERSION = '0.2.0';
export const ROUTE_PREFIX = '/dsh-deep-search';
export const PROMPT_SECTION_NAME = 'plugin:deep-search';
export const PROMPT_SECTION_ORDER = 118;

const SECTION_LIMIT = 18000;

function clipText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}
const SETTINGS_KEYS = [
  'enabled',
  'rootDir',
  'maxQuestions',
  'searchesPerQuestion',
  'searchMaxResults',
  'fetchPerQuestion',
  'fetchMaxChars',
  'defaultDepth',
  'jobTimeoutMs',
  'llmMaxTokens',
  'searchApiBaseURL',
  'searchApiKeyEnv',
  'searchApiKey',
  'searchProviderMode',
  'maxActiveJobs',
  'modelProvider',
  'model',
  'maxResearchConcurrency',
];

const IDENTITY_LABELS = { fact: '事实', claim: '声称', analysis: '分析', unknown: '未知' };
const CONFIDENCE_LABELS = { high: '高', medium: '中', low: '低' };
const STANCE_LABELS = { support: '支持', oppose: '反对', context: '背景' };
const STRENGTH_LABELS = { primary: '一手', secondary: '二手', 'single-source': '单一信源', contested: '有争议' };
const INDEPENDENCE_LABELS = { primary: '原始', independent: '独立', syndicated: '转述', unknown: '未知' };
const RELIABILITY_LABELS = { high: '高', medium: '中', low: '低' };
const KIND_LABELS = {
  primary: '原始资料',
  report: '报道',
  data: '数据',
  analysis: '分析',
  interview: '访谈',
  social: '社交',
  other: '其他',
};
const RELATION_LABELS = { opens: '开启', deepens: '深化', contrasts: '对照', depends: '依赖', closes: '收束' };
const CONNECTION_LABELS = {
  constraint: '约束',
  dependency: '依赖',
  analogy: '类比',
  'same-root': '同源',
  counterweight: '制衡',
};
const CONNECTION_STATUS_LABELS = { verified: '已证实', suggested: '待验证', unverified: '线索' };
export const SECTION_NAMES = ['understanding', 'discussion', 'questions', 'question:<id>', 'judgments', 'branches', 'sources', 'all'];

function safeLogger(logger) {
  const prefix = `[${PLUGIN_NAME}]`;
  return {
    info: (message) => {
      try {
        if (logger && typeof logger.info === 'function') logger.info(`${prefix} ${message}`);
      } catch {
        /* ignore */
      }
    },
    warn: (message) => {
      try {
        if (logger && typeof logger.warn === 'function') logger.warn(`${prefix} ${message}`);
      } catch {
        /* ignore */
      }
    },
    error: (message) => {
      try {
        if (logger && typeof logger.error === 'function') logger.error(`${prefix} ${message}`);
      } catch {
        /* ignore */
      }
    },
  };
}

function nowIsoFrom(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

/** 文件名安全化：去路径分隔符 / 控制字符，保留中文，限长。 */
export function safeFilename(name, max = 80) {
  const text = String(name || '')
    .replace(/[\\/:*?"<>|%\u0000-\u001f\u007f]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim();
  const clipped = text.slice(0, max).trim() || 'dossier';
  return clipped.replace(/[.\s]+$/, '') || 'dossier';
}

function cleanQuery(value) {
  const query = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (query.length < 2) throw httpError('BAD_REQUEST', '检索主题至少 2 个字', '给一个可检索的关键词或话题。');
  if (query.length > 200) throw httpError('BAD_REQUEST', '检索主题最多 200 字', '请缩短主题，把细节放进 angle 或追问里。');
  return query;
}

function cleanQuestion(value) {
  const question = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (question.length < 2) throw httpError('BAD_REQUEST', '追问问题至少 2 个字');
  if (question.length > 1000) throw httpError('BAD_REQUEST', '追问问题最多 1000 字');
  return question;
}

function label(map, value, fallback = '') {
  return map[value] || fallback || String(value || '');
}

/* ── 阅读节文本（v2：六模块，全局 claims / evidence 用 id 索引） ───────── */

const TOPIC_KIND_LABELS = {
  technology: '技术',
  company: '公司',
  phenomenon: '现象',
  event: '事件',
  person: '人物',
  concept: '概念',
  policy: '政策',
};
const MODULE_LABELS = { understanding: '基础认识', discussion: '讨论地图', question: '深度分析' };
const MODULE_STATUS_LABELS = { done: '完成', partial: '部分完成', empty: '空' };
const COVERAGE_LABELS = {
  covered: '已覆盖',
  partial: '部分覆盖',
  missing: '缺失',
  answered: '已回答',
  disputed: '有争议',
  'no-evidence': '无证据',
};
const WORK_STATUS_LABELS = {
  pending: '待研究',
  researching: '检索中',
  done: '已完成',
  partial: '部分完成',
  failed: '失败',
  blocked: '受阻',
};
const EVIDENCE_STATUS_LABELS = {
  supported: '证据充足',
  limited: '证据有限',
  conflicted: '证据冲突',
  unsupported: '缺少证据',
};
const READ_SCOPE_LABELS = {
  'full-text': '全文',
  section: '章节',
  abstract: '摘要',
  snippet: '搜索片段',
  transcript: '转写',
};
const QUESTION_ROLE_LABELS = {
  definition: '定义',
  mechanism: '机制',
  evidence: '证据',
  'political-economy': '政治经济',
  uncertainty: '不确定性',
  context: '背景',
  custom: '自定义',
};
const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
const SPEAKER_IDENTITY_LABELS = {
  company: '公司',
  researcher: '研究者',
  user: '用户',
  media: '媒体',
  official: '官方',
  other: '其他',
};
const ENTITY_TYPE_LABELS = {
  company: '公司',
  person: '人物',
  technology: '技术',
  event: '事件',
  organization: '组织',
  concept: '概念',
};
const BLOCK_KIND_LABELS = {
  definition: '定义',
  purpose: '解决什么问题',
  'how-it-works': '怎样运作',
  background: '必要背景',
  confusable: '容易混淆',
  fact: '事实',
};
const BRANCH_STATUS_LABELS = { open: '待研究', answered: '已回答' };
const DISAGREEMENT_ORIGINS = ['数据口径', '时间差', '利益相关', '定义差异', '样本差异', '证据缺失'];
const REVISION_KIND_LABELS = { initial: '首轮', followup: '追问', refresh: '刷新' };

const SECTION_ALIASES = { overview: 'understanding', map: 'questions' };

function asList(value) {
  return Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined) : [];
}

function asText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasNumber(value) {
  return Number.isFinite(Number(value));
}

function listText(value) {
  return asList(value)
    .map((item) => asText(item) || String(item ?? ''))
    .filter(Boolean)
    .join('、');
}

function joinIds(value, fallback = '（无）') {
  const ids = asList(value)
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
  return ids.length ? ids.join('、') : fallback;
}

function idCollector(initial = []) {
  const ids = [];
  const seen = new Set();
  const push = (value) => {
    const id = String(value ?? '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  asList(initial).forEach(push);
  return { ids, push };
}

function normalizeSectionName(value) {
  const raw = String(value ?? '').trim();
  const name = raw || 'understanding';
  return SECTION_ALIASES[name] || name;
}

function topicTitle(archive) {
  return asText(archive?.topic?.title) || asText(archive?.input?.query) || '未命名主题';
}

function topicMeta(archive) {
  const topic = archive?.topic || {};
  const input = archive?.input || {};
  const counts = `问题 ${asList(archive?.questions).length} 个｜论断 ${asList(archive?.claims).length} 条｜证据 ${asList(archive?.evidence).length} 条｜来源 ${asList(archive?.sources).length} 条`;
  const reading = hasNumber(topic.readingMinutes) && Number(topic.readingMinutes) > 0 ? `｜约 ${asNumber(topic.readingMinutes)} 分钟` : '';
  return `类型：${label(TOPIC_KIND_LABELS, topic.kind, '未标')}｜深度：${asText(topic.depth) || asText(input.depth) || 'deep'}｜档案状态：${asText(archive?.status) || 'draft'}｜信息截止：${asText(topic.cutoffAt) || '未知'}｜${counts}${reading}`;
}

function indexArchive(archive) {
  const claims = new Map();
  const evidence = new Map();
  const sources = new Map();
  for (const claim of asList(archive?.claims)) {
    const id = asText(claim?.id);
    if (id) claims.set(id, claim);
  }
  for (const item of asList(archive?.evidence)) {
    const id = asText(item?.id);
    if (id) evidence.set(id, item);
  }
  for (const source of asList(archive?.sources)) {
    const id = asText(source?.id);
    if (id) sources.set(id, source);
  }
  return { claims, evidence, sources };
}

function claimLines(claim, { indent = '  ', includeModule = false } = {}) {
  const id = asText(claim?.id) || 'c?';
  const header = [
    label(IDENTITY_LABELS, claim?.identity, '身份未标'),
    label(EVIDENCE_STATUS_LABELS, claim?.evidenceStatus, '证据状态未标'),
    `置信度 ${label(CONFIDENCE_LABELS, claim?.confidence, '未标')}`,
  ].join('｜');
  const lines = [`${indent}${id}〔${header}〕${asText(claim?.statement) || '（无论断正文）'}`];
  const meta = [];
  if (asText(claim?.attribution)) meta.push(`归因：${asText(claim.attribution)}`);
  if (asText(claim?.scope)) meta.push(`范围：${asText(claim.scope)}`);
  if (asText(claim?.conditions)) meta.push(`成立条件：${asText(claim.conditions)}`);
  if (asText(claim?.basis)) meta.push(`依据：${asText(claim.basis)}`);
  if (includeModule) {
    const questionIds = joinIds(claim?.questionIds, '');
    meta.push(`所属：${label(MODULE_LABELS, claim?.module, asText(claim?.module) || '未标')}${questionIds ? ` ${questionIds}` : ''}`);
  }
  if (meta.length) lines.push(`${indent}  ${meta.join('｜')}`);
  lines.push(`${indent}  支持证据：${joinIds(claim?.evidenceIds)}｜反对证据：${joinIds(claim?.opposeEvidenceIds)}`);
  if (asText(claim?.supersededBy)) lines.push(`${indent}  已被 ${asText(claim.supersededBy)} 取代（旧论断保留）`);
  return lines;
}

function evidenceLines(evidence, { indent = '  ' } = {}) {
  const id = asText(evidence?.id) || 'ev?';
  const independent = hasNumber(evidence?.independentSources) ? String(asNumber(evidence.independentSources)) : '未计';
  const header = [
    label(IDENTITY_LABELS, evidence?.identity, '身份未标'),
    label(STANCE_LABELS, evidence?.stance, '立场未标'),
    label(STRENGTH_LABELS, evidence?.strength, '强度未标'),
    `读取 ${label(READ_SCOPE_LABELS, evidence?.readScope, '未标读取范围')}`,
    `定位 ${asText(evidence?.locator) || '未标定位'}`,
    `独立信源 ${independent}`,
    `来源 ${joinIds(evidence?.sourceIds)}`,
  ].join('｜');
  const lines = [`${indent}${id}〔${header}〕${asText(evidence?.text) || '（无复述）'}`];
  if (asText(evidence?.quote)) lines.push(`${indent}  原文：「${asText(evidence.quote)}」`);
  if (asText(evidence?.note)) lines.push(`${indent}  说明：${asText(evidence.note)}`);
  return lines;
}

function claimRefLines(ids, index, options = {}) {
  const lines = [];
  const indent = options.indent || '  ';
  for (const rawId of asList(ids)) {
    const id = String(rawId ?? '').trim();
    if (!id) continue;
    const claim = index.claims.get(id);
    if (claim) lines.push(...claimLines(claim, { ...options, indent }));
    else lines.push(`${indent}${id}（未找到该论断，可能已废弃）`);
  }
  return lines;
}

function evidenceRefLines(ids, index, options = {}) {
  const lines = [];
  const indent = options.indent || '  ';
  for (const rawId of asList(ids)) {
    const id = String(rawId ?? '').trim();
    if (!id) continue;
    const evidence = index.evidence.get(id);
    if (evidence) lines.push(...evidenceLines(evidence, { ...options, indent }));
    else lines.push(`${indent}${id}（未找到该证据，可能已被清理）`);
  }
  return lines;
}

function collectClaimEvidenceIds(claimIds, index, baseIds = []) {
  const collector = idCollector(baseIds);
  for (const claimId of asList(claimIds)) {
    const claim = index.claims.get(String(claimId ?? '').trim());
    if (!claim) continue;
    asList(claim.evidenceIds).forEach(collector.push);
    asList(claim.opposeEvidenceIds).forEach(collector.push);
  }
  return collector.ids;
}

function collectQuestionClaimIds(question, index) {
  // v2 以 questions[].claimIds 为准；只有旧档案缺这个字段时才按 questionIds 反查。
  if (Array.isArray(question?.claimIds)) return idCollector(question.claimIds).ids;
  const collector = idCollector();
  const questionId = asText(question?.id);
  if (questionId) {
    for (const claim of index.claims.values()) {
      if (asList(claim?.questionIds).map((item) => String(item)).includes(questionId)) collector.push(claim.id);
    }
  }
  return collector.ids;
}

function collectQuestionEvidenceIds(question, index, claimIds) {
  const collector = idCollector();
  if (Array.isArray(question?.evidenceIds)) {
    asList(question.evidenceIds).forEach(collector.push);
  } else {
    const questionId = asText(question?.id);
    if (questionId) {
      for (const evidence of index.evidence.values()) {
        if (asText(evidence?.questionId) === questionId) collector.push(evidence.id);
      }
    }
  }
  for (const claimId of asList(claimIds)) {
    const claim = index.claims.get(String(claimId ?? '').trim());
    if (!claim) continue;
    asList(claim.evidenceIds).forEach(collector.push);
    asList(claim.opposeEvidenceIds).forEach(collector.push);
  }
  // 机制段与反例自身引用的证据也列进本节，避免正文出现无法就地展开的 ev id。
  for (const part of asList(question?.mechanism)) asList(part?.evidenceIds).forEach(collector.push);
  for (const part of asList(question?.counterpoints)) asList(part?.evidenceIds).forEach(collector.push);
  return collector.ids;
}

function coverageText(coverage) {
  const value = coverage && typeof coverage === 'object' ? coverage : {};
  const parts = [`覆盖：${label(COVERAGE_LABELS, value.status, '未标')}`];
  if (asText(value.note)) parts.push(`说明：${asText(value.note)}`);
  if (asText(value.limits)) parts.push(`限制：${asText(value.limits)}`);
  return parts.join('｜');
}

/** 01 这是什么。 */
function understandingText(archive, index = indexArchive(archive)) {
  const understanding = archive?.understanding && typeof archive.understanding === 'object' ? archive.understanding : {};
  const topic = archive?.topic || {};
  const lines = [`【这是什么】${topicTitle(archive)}`, topicMeta(archive)];
  if (asText(topic.definition)) lines.push('', `定义：${asText(topic.definition)}`);
  if (asText(topic.scope)) lines.push(`范围：${asText(topic.scope)}`);
  if (asText(topic.exclusions)) lines.push(`不覆盖：${asText(topic.exclusions)}`);
  if (asText(topic.whyNow)) lines.push(`为什么现在看：${asText(topic.whyNow)}`);

  const summary = asText(understanding.summary) || asText(archive?.overview?.brief);
  if (summary) lines.push('', `一句话解释：${summary}`);
  const summaryClaimId = asText(understanding.summaryClaimId);
  const summaryEvidenceIds = asList(understanding.summaryEvidenceIds);
  if (summary && (summaryClaimId || summaryEvidenceIds.length)) {
    const refs = [];
    if (summaryClaimId) refs.push(`论断 ${summaryClaimId}`);
    if (summaryEvidenceIds.length) refs.push(`证据 ${joinIds(summaryEvidenceIds)}`);
    lines.push(`  依据：${refs.join('｜')}`);
  }
  const moduleStatus = asText(understanding.status);
  lines.push(`模块状态：${label(MODULE_STATUS_LABELS, moduleStatus, moduleStatus || '未标')}`);

  const blocks = asList(understanding.blocks);
  lines.push('', '理解块：');
  if (!blocks.length) lines.push('（本轮没有可展示的理解块）');
  for (const block of blocks) {
    const title = asText(block?.title);
    lines.push(`- ${asText(block?.id) || 'u?'}〔${label(BLOCK_KIND_LABELS, block?.kind, asText(block?.kind) || '未标')}〕${title ? `${title}：` : ''}${asText(block?.text) || '（无正文）'}`);
    const refs = [];
    if (asList(block?.claimIds).length) refs.push(`论断 ${joinIds(block.claimIds)}`);
    if (asList(block?.evidenceIds).length) refs.push(`证据 ${joinIds(block.evidenceIds)}`);
    if (refs.length) lines.push(`  引用：${refs.join('｜')}`);
  }

  const entities = asList(understanding.entities);
  if (entities.length) {
    lines.push('', '实体：');
    for (const entity of entities) {
      const meta = [label(ENTITY_TYPE_LABELS, entity?.type, asText(entity?.type) || '未标')];
      if (asText(entity?.role)) meta.push(asText(entity.role));
      const refs = [];
      if (asList(entity?.claimIds).length) refs.push(`论断 ${joinIds(entity.claimIds)}`);
      if (asList(entity?.sourceIds).length) refs.push(`来源 ${joinIds(entity.sourceIds)}`);
      lines.push(`- ${asText(entity?.id) || 'e?'} ${asText(entity?.name) || '（未命名）'}（${meta.join('｜')}）${refs.length ? `｜${refs.join('｜')}` : ''}`);
    }
  }

  const confusables = asList(understanding.confusables);
  if (confusables.length) {
    lines.push('', '容易混淆：');
    for (const item of confusables) {
      const confusedWith = asText(item?.confusedWith);
      const sourceIds = asList(item?.sourceIds);
      lines.push(`- ${asText(item?.id) || 'cf?'} ${asText(item?.term) || '（未命名）'}${confusedWith ? `（容易和「${confusedWith}」混）` : ''}：${asText(item?.note) || '（未写差别）'}${sourceIds.length ? `（来源 ${joinIds(sourceIds)}）` : ''}`);
    }
  }

  const timeline = asList(understanding.timeline);
  if (timeline.length) {
    lines.push('', '时间线：');
    for (const item of timeline) {
      const sourceIds = asList(item?.sourceIds);
      lines.push(`- ${asText(item?.id) || 't?'} ${asText(item?.at) || '时间未知'}：${asText(item?.text) || '（未写）'}${sourceIds.length ? `（来源 ${joinIds(sourceIds)}）` : ''}`);
    }
  }

  const claimIds = idCollector(summaryClaimId ? [summaryClaimId] : []);
  for (const block of blocks) asList(block?.claimIds).forEach(claimIds.push);
  for (const entity of entities) asList(entity?.claimIds).forEach(claimIds.push);
  for (const claim of index.claims.values()) {
    if (asText(claim?.module) === 'understanding') claimIds.push(claim.id);
  }
  const baseEvidenceIds = [...summaryEvidenceIds, ...blocks.flatMap((block) => asList(block?.evidenceIds))];
  const evidenceIds = collectClaimEvidenceIds(claimIds.ids, index, baseEvidenceIds);
  if (claimIds.ids.length) lines.push('', '理解层论断：', ...claimRefLines(claimIds.ids, index));
  if (evidenceIds.length) lines.push('', '理解层证据：', ...evidenceRefLines(evidenceIds, index));
  lines.push('', coverageText(understanding.coverage));
  return lines;
}

/** 02 大家在讨论什么。 */
function discussionText(archive, index = indexArchive(archive)) {
  const discussion = archive?.discussion && typeof archive.discussion === 'object' ? archive.discussion : {};
  const scope = discussion.scope && typeof discussion.scope === 'object' ? discussion.scope : {};
  const lines = [`【大家在讨论什么】${topicTitle(archive)}`];
  const scopeParts = [];
  if (asText(scope.window)) scopeParts.push(`时间窗口 ${asText(scope.window)}`);
  const platforms = listText(scope.platforms);
  if (platforms) scopeParts.push(`平台 ${platforms}`);
  const languages = listText(scope.languages);
  if (languages) scopeParts.push(`语言 ${languages}`);
  if (hasNumber(scope.materialCount)) scopeParts.push(`材料 ${asNumber(scope.materialCount)} 篇`);
  if (hasNumber(scope.speakerCount)) scopeParts.push(`发言主体 ${asNumber(scope.speakerCount)} 人`);
  if (asText(scope.checkedAt)) scopeParts.push(`核查时间 ${asText(scope.checkedAt)}`);
  lines.push(`讨论范围：${scopeParts.length ? scopeParts.join('｜') : '未标注'}`);
  if (asText(scope.limits)) lines.push(`访问限制：${asText(scope.limits)}`);

  const issueClaims = idCollector();
  const issueEvidence = idCollector();
  const issues = asList(discussion.issues);
  lines.push('', '议题：');
  if (!issues.length) lines.push('（在本轮可访问范围内，尚不足以归纳公开讨论）');
  for (const issue of issues) {
    lines.push(`- ${asText(issue?.id) || 'd?'}〔${label(COVERAGE_LABELS, issue?.status, '未标')}〕${asText(issue?.question) || '（未写议题）'}`);
    if (asText(issue?.summary)) lines.push(`  概述：${asText(issue.summary)}`);
    const items = asList(issue?.items);
    if (!items.length) lines.push('  讨论项：（本轮未取到可归属的发言）');
    else {
      lines.push('  讨论项：');
      for (const item of items) {
        const meta = [];
        if (asText(item?.affiliation)) meta.push(asText(item.affiliation));
        meta.push(label(SPEAKER_IDENTITY_LABELS, item?.identity, '身份未标'));
        if (asText(item?.at)) meta.push(asText(item.at));
        if (asText(item?.channel)) meta.push(asText(item.channel));
        lines.push(`  - ${asText(item?.id) || 'di?'} ${asText(item?.speaker) || '（发言人未知）'}（${meta.join('｜')}）：${asText(item?.view) || '（无观点）'}`);
        if (asText(item?.basis)) lines.push(`    依据：${asText(item.basis)}`);
        const claimIds = asList(item?.claimIds).map(String);
        const evidenceIds = asList(item?.evidenceIds).map(String);
        const sourceIds = asList(item?.sourceIds).map(String);
        const refs = [];
        if (claimIds.length) refs.push(`论断 ${claimIds.join('、')}`);
        if (evidenceIds.length) refs.push(`证据 ${evidenceIds.join('、')}`);
        if (sourceIds.length) refs.push(`来源 ${sourceIds.join('、')}`);
        if (refs.length) lines.push(`    ${refs.join('｜')}`);
        claimIds.forEach(issueClaims.push);
        evidenceIds.forEach(issueEvidence.push);
      }
    }
    const sides = asList(issue?.sides);
    if (sides.length) {
      lines.push('  立场：');
      for (const side of sides) {
        const holders = listText(side?.holders);
        const evidenceIds = asList(side?.evidenceIds).map(String);
        evidenceIds.forEach(issueEvidence.push);
        lines.push(`  - ${asText(side?.position) || '（未写立场）'}${holders ? `（持有者：${holders}）` : ''}${evidenceIds.length ? `（证据 ${evidenceIds.join('、')}）` : ''}`);
      }
    }
    const disagreement = issue?.disagreement && typeof issue.disagreement === 'object' ? issue.disagreement : {};
    let origin = asText(disagreement.origin);
    let disagreementNote = asText(disagreement.note);
    if (!origin && DISAGREEMENT_ORIGINS.includes(disagreementNote)) {
      origin = disagreementNote;
      disagreementNote = '';
    }
    if (origin || disagreementNote) {
      lines.push(`  分歧来源：${origin || '未标'}${disagreementNote ? `（${disagreementNote}）` : ''}`);
    }
    const gaps = Array.isArray(issue?.gaps) ? listText(issue.gaps) : asText(issue?.gaps);
    if (gaps) lines.push(`  缺口：${gaps}`);
  }

  for (const claim of index.claims.values()) {
    if (asText(claim?.module) === 'discussion') issueClaims.push(claim.id);
  }
  const evidenceIds = collectClaimEvidenceIds(issueClaims.ids, index, issueEvidence.ids);
  if (issueClaims.ids.length) lines.push('', '讨论层论断：', ...claimRefLines(issueClaims.ids, index));
  if (evidenceIds.length) lines.push('', '讨论层证据：', ...evidenceRefLines(evidenceIds, index));
  lines.push('', coverageText(discussion.coverage));
  return lines;
}

/** 03 单个深度问题。 */
function questionText(archive, question, index = indexArchive(archive)) {
  const lines = [];
  const header = [];
  if (asText(question?.role)) header.push(label(QUESTION_ROLE_LABELS, question.role, question.role));
  if (asText(question?.priority)) header.push(`优先级 ${label(PRIORITY_LABELS, question.priority, question.priority)}`);
  const workStatus = asText(question?.workStatus) || asText(question?.status);
  header.push(`工作 ${label(WORK_STATUS_LABELS, workStatus, workStatus || '未标')}`);
  const coverage = asText(question?.coverage);
  header.push(`覆盖 ${label(COVERAGE_LABELS, coverage, coverage || '未标')}`);
  lines.push(`${asText(question?.id) || 'q?'}〔${header.join('｜')}〕${asText(question?.question) || '（问题文本缺失）'}`);
  if (asText(question?.why)) lines.push(`  为什么研究：${asText(question.why)}`);
  if (asText(question?.evidenceNeed)) lines.push(`  需要的证据：${asText(question.evidenceNeed)}`);
  const relation = question?.relation && typeof question.relation === 'object' ? question.relation : {};
  if (asText(relation.to)) {
    lines.push(`  关系：${label(RELATION_LABELS, relation.kind, asText(relation.kind) || '关联')} → ${asText(relation.to)}${asText(relation.note) ? `（${asText(relation.note)}）` : ''}`);
  }
  if (asText(question?.summary)) {
    lines.push(`  一句话回答（置信度 ${label(CONFIDENCE_LABELS, question?.confidence, '未标')}）：${asText(question.summary)}`);
  }

  const claimIds = collectQuestionClaimIds(question, index);
  if (claimIds.length) lines.push('  论断：', ...claimRefLines(claimIds, index, { indent: '  ', includeModule: true }));
  else lines.push('  论断：（本轮没有形成可引用论断）');
  const evidenceIds = collectQuestionEvidenceIds(question, index, claimIds);
  if (evidenceIds.length) lines.push('  证据：', ...evidenceRefLines(evidenceIds, index, { indent: '  ' }));

  const mechanism = asList(question?.mechanism);
  if (mechanism.length) {
    lines.push('  机制：');
    for (const part of mechanism) {
      lines.push(`  - ${asText(part?.id) || 'm?'} ${asText(part?.text) || '（未写机制）'}${asList(part?.claimIds).length ? `（论断 ${joinIds(part.claimIds)}）` : ''}`);
    }
  }

  const counterpoints = asList(question?.counterpoints);
  if (counterpoints.length) {
    lines.push('  反例与边界：');
    for (const part of counterpoints) {
      const condition = asText(part?.condition);
      const partEvidence = asList(part?.evidenceIds).map(String);
      lines.push(`  - ${asText(part?.id) || 'cp?'} ${asText(part?.text) || '（未写反例）'}${condition ? `（条件：${condition}）` : ''}${partEvidence.length ? `（证据 ${partEvidence.join('、')}）` : ''}`);
    }
  }

  const gaps = asList(question?.gaps);
  if (gaps.length) {
    lines.push('  缺口：');
    for (const gap of gaps) {
      if (typeof gap === 'string') {
        lines.push(`  - ${gap}`);
        continue;
      }
      const extras = [];
      if (asText(gap?.whyItMatters)) extras.push(`为什么重要：${asText(gap.whyItMatters)}`);
      if (asText(gap?.howToClose)) extras.push(`怎么补：${asText(gap.howToClose)}`);
      lines.push(`  - ${asText(gap?.id) || 'g?'} ${asText(gap?.text) || '（未写缺口）'}${extras.length ? `（${extras.join('；')}）` : ''}`);
    }
  }

  const branchIds = asList(question?.branchIds).map(String);
  if (branchIds.length) lines.push(`  分支：${branchIds.join('、')}`);
  return lines;
}

/** 03 问题目录。 */
function questionsText(archive, index = indexArchive(archive)) {
  const questions = asList(archive?.questions);
  const lines = [`【值得深入理解什么】${topicTitle(archive)}｜共 ${questions.length} 个问题`];
  if (!questions.length) {
    lines.push('', '（本轮没有生成深度问题）');
    return lines;
  }
  for (const question of questions) lines.push('', ...questionText(archive, question, index));
  return lines;
}

/** 判断、未知、关联（04）。 */
function connectionsText(archive, index = indexArchive(archive)) {
  const connections = asList(archive?.connections);
  const lines = ['关联发现：'];
  if (!connections.length) {
    lines.push('（暂无关联）');
    return lines;
  }
  for (const connection of connections) {
    const kind = label(CONNECTION_LABELS, connection?.kind, asText(connection?.kind) || '关联');
    const status = label(CONNECTION_STATUS_LABELS, connection?.status, '未标状态');
    lines.push(`- ${asText(connection?.id) || 'x?'}：${asText(connection?.from) || '起点'} → ${asText(connection?.to) || '（未写对象）'}（${kind}｜${status}）`);
    if (asText(connection?.mechanism)) lines.push(`  机制：${asText(connection.mechanism)}`);
    if (asList(connection?.claimIds).length) lines.push(`  论断：${joinIds(connection.claimIds)}`);
    if (asList(connection?.sourceIds).length) lines.push(`  来源：${joinIds(connection.sourceIds)}`);
    if (asText(connection?.note)) lines.push(`  说明：${asText(connection.note)}`);
  }
  return lines;
}

function judgmentsText(archive, index = indexArchive(archive), { compact = false } = {}) {
  const judgments = asList(archive?.judgments);
  const lines = [`【目前能确定什么】${topicTitle(archive)}`];
  const claimIds = idCollector();
  const judgmentEvidence = idCollector();
  if (!judgments.length) lines.push('', '判断：（本轮没有形成明确判断）');
  else {
    lines.push('', '判断：');
    for (const judgment of judgments) {
      const header = [
        label(IDENTITY_LABELS, judgment?.identity, '身份未标'),
        `置信度 ${label(CONFIDENCE_LABELS, judgment?.confidence, '未标')}`,
      ];
      if (hasNumber(judgment?.independentSources)) header.push(`独立信源 ${asNumber(judgment.independentSources)}`);
      lines.push(`- ${asText(judgment?.id) || 'j?'}〔${header.join('｜')}〕${asText(judgment?.text) || '（判断文本缺失）'}`);
      if (asText(judgment?.conditions)) lines.push(`  成立条件：${asText(judgment.conditions)}`);
      if (asList(judgment?.claimIds).length) lines.push(`  依据论断：${joinIds(judgment.claimIds)}`);
      if (asList(judgment?.evidenceIds).length) lines.push(`  证据：${joinIds(judgment.evidenceIds)}`);
      if (asList(judgment?.sourceIds).length) lines.push(`  来源：${joinIds(judgment.sourceIds)}`);
      if (judgment?.stale === true) lines.push('  状态：已过时（stale），需要刷新');
      if (asText(judgment?.note)) lines.push(`  说明：${asText(judgment.note)}`);
      asList(judgment?.claimIds).forEach(claimIds.push);
      asList(judgment?.evidenceIds).forEach(judgmentEvidence.push);
    }
  }

  // compact 用于 all：论断/证据细节已在前面各节出现，这里只保留判断本身的引用 id。
  if (!compact) {
    const evidenceIds = collectClaimEvidenceIds(claimIds.ids, index, judgmentEvidence.ids);
    if (claimIds.ids.length) lines.push('', '判断依据论断：', ...claimRefLines(claimIds.ids, index));
    if (evidenceIds.length) lines.push('', '判断依据证据：', ...evidenceRefLines(evidenceIds, index));
  }

  const unknowns = asList(archive?.unknowns);
  lines.push('', '未知：');
  if (!unknowns.length) lines.push('（暂无未知）');
  for (const unknown of unknowns) {
    const extras = [];
    if (asText(unknown?.whyItMatters)) extras.push(`为什么重要：${asText(unknown.whyItMatters)}`);
    if (asText(unknown?.howToClose)) extras.push(`怎么补：${asText(unknown.howToClose)}`);
    const questionId = asText(unknown?.questionId);
    lines.push(`- ${asText(unknown?.id) || 'un?'}${questionId ? `（问题 ${questionId}）` : ''}：${asText(unknown?.text) || '（未写）'}${extras.length ? `（${extras.join('；')}）` : ''}`);
  }

  const tensions = asList(archive?.tensions);
  if (tensions.length) {
    lines.push('', '核心张力：');
    for (const tension of tensions) {
      const text = typeof tension === 'string' ? tension.trim() : asText(tension?.text);
      if (text) lines.push(`- ${text}`);
    }
  }

  lines.push('', ...connectionsText(archive, index));
  if (asText(archive?.readingNote)) lines.push('', `阅读提示：${asText(archive.readingNote)}`);
  return lines;
}

/** 05 接下来值得查什么。 */
function branchesText(archive) {
  const branches = asList(archive?.branches);
  const open = branches.filter((branch) => asText(branch?.status) !== 'answered').length;
  const lines = [`【接下来值得查什么】${topicTitle(archive)}｜共 ${branches.length} 条（待研究 ${open} / 已回答 ${branches.length - open}）`];
  if (!branches.length) {
    lines.push('', '（暂无分支）');
    return lines;
  }
  lines.push('');
  for (const branch of branches) {
    const header = [
      `优先级 ${label(PRIORITY_LABELS, branch?.priority, '未标')}`,
      label(BRANCH_STATUS_LABELS, branch?.status, asText(branch?.status) || '待研究'),
    ];
    lines.push(`- ${asText(branch?.id) || 'b?'}〔${header.join('｜')}〕${asText(branch?.text) || '（分支未写）'}`);
    if (asText(branch?.hook)) lines.push(`  补上会改变：${asText(branch.hook)}`);
    if (asText(branch?.questionId)) lines.push(`  关联问题：${asText(branch.questionId)}`);
    if (asText(branch?.answeredBy)) lines.push(`  已由：${asText(branch.answeredBy)}`);
  }
  return lines;
}

/** 06 资料来源：定位、读取范围、作者、独立性、被引用位置。 */
function sourcesText(archive, index = indexArchive(archive)) {
  const sources = asList(archive?.sources);
  const lines = [`【资料来源】${topicTitle(archive)}｜共 ${sources.length} 条`];
  if (!sources.length) {
    lines.push('', '（暂无来源）');
    return lines;
  }
  for (const source of sources) {
    const id = asText(source?.id) || 's?';
    lines.push('', `- ${id} ${asText(source?.title) || '（无标题）'}`);
    const meta = [
      `站点 ${asText(source?.publisher) || model.hostOf(source?.url) || '未知'}`,
      `作者/机构 ${asText(source?.author) || '未标注'}`,
      `发布 ${asText(source?.publishedAt) || '日期未知'}`,
      `获取 ${asText(source?.retrievedAt) || '未标注'}`,
      `类型 ${label(KIND_LABELS, source?.kind, '未标')}`,
      `独立性 ${label(INDEPENDENCE_LABELS, source?.independence, '未标')}`,
      `可靠度 ${label(RELIABILITY_LABELS, source?.reliability, '未标')}`,
    ];
    if (hasNumber(source?.authority)) meta.push(`权威度 ${asNumber(source.authority)}`);
    lines.push(`  ${meta.join('｜')}`);
    lines.push(`  URL：${asText(source?.url) || '（无）'}`);
    if (asText(source?.quote)) lines.push(`  关键引文：「${asText(source.quote)}」`);
    if (asText(source?.summary)) lines.push(`  摘要：${asText(source.summary)}`);
    if (source?.fetch && source.fetch.ok) lines.push(`  精读：${asNumber(source.fetch.chars)} 字（HTTP ${asNumber(source.fetch.status)}）`);
    else if (source?.fetch && asText(source.fetch.error)) lines.push(`  抓取失败：${asText(source.fetch.error)}`);

    const usages = [];
    for (const evidence of index.evidence.values()) {
      if (asList(evidence?.sourceIds).map((item) => String(item)).includes(id)) usages.push(evidence);
    }
    if (usages.length) {
      lines.push('  被引用：');
      for (const evidence of usages) {
        const usedByClaims = [];
        for (const claim of index.claims.values()) {
          const refs = [...asList(claim?.evidenceIds), ...asList(claim?.opposeEvidenceIds)].map(String);
          if (refs.includes(asText(evidence?.id))) usedByClaims.push(asText(claim.id));
        }
        const locator = asText(evidence?.locator) || '未标定位';
        const readScope = label(READ_SCOPE_LABELS, evidence?.readScope, '未标读取范围');
        lines.push(`  - ${asText(evidence?.id) || 'ev?'}（${readScope}｜定位 ${locator}${usedByClaims.length ? `｜被用于论断 ${usedByClaims.join('、')}` : ''}）`);
      }
    } else if (asList(source?.usedFor).length) {
      lines.push(`  被引用：${joinIds(source.usedFor)}`);
    } else {
      lines.push('  被引用：（尚无论断引用）');
    }
    if (asText(source?.originGroupId)) lines.push(`  同源分组：${asText(source.originGroupId)}`);
    if (asText(source?.canonicalUrl) && asText(source.canonicalUrl) !== asText(source.url)) {
      lines.push(`  规范链接：${asText(source.canonicalUrl)}`);
    }
  }
  return lines;
}

/** 全部六模块 + 修订记录。 */
function allText(archive, index = indexArchive(archive)) {
  const lines = [
    ...understandingText(archive, index),
    '',
    ...discussionText(archive, index),
    '',
    ...questionsText(archive, index),
    '',
    ...judgmentsText(archive, index, { compact: true }),
    '',
    ...branchesText(archive),
    '',
    ...sourcesText(archive, index),
  ];
  const revisions = asList(archive?.revisions);
  if (revisions.length) {
    lines.push('', '【修订记录】');
    for (const revision of revisions) {
      const questionIds = asList(revision?.questionIds);
      lines.push(`- ${asText(revision?.id) || 'r?'} ${asText(revision?.at) || '时间未知'} ${label(REVISION_KIND_LABELS, revision?.kind, asText(revision?.kind) || '修订')}：${asText(revision?.summary) || '（未写改动）'}${questionIds.length ? `（涉及问题 ${joinIds(questionIds)}）` : ''}`);
    }
  }
  return lines;
}

/**
 * 按章节名渲染纯文本。未知章节抛 BAD_REQUEST。
 * 默认 understanding；overview / map 为兼容别名。
 */
export function buildSectionText(archive, section) {
  const name = normalizeSectionName(section);
  const index = indexArchive(archive);
  if (name === 'understanding') return understandingText(archive, index).join('\n');
  if (name === 'discussion') return discussionText(archive, index).join('\n');
  if (name === 'questions') return questionsText(archive, index).join('\n');
  if (name === 'judgments') return judgmentsText(archive, index).join('\n');
  if (name === 'branches') return branchesText(archive).join('\n');
  if (name === 'sources') return sourcesText(archive, index).join('\n');
  if (name === 'all') return allText(archive, index).join('\n');
  if (name.startsWith('question:')) {
    const id = name.slice('question:'.length).trim();
    const question = asList(archive?.questions).find((item) => asText(item?.id) === id);
    if (!question) {
      const available = asList(archive?.questions).map((item) => asText(item?.id)).filter(Boolean);
      return `未找到问题：${id || '（空）'}。可用问题：${available.join('、') || '（无）'}`;
    }
    return questionText(archive, question, index).join('\n');
  }
  throw httpError('BAD_REQUEST', `未知章节：${name}`, `可用章节：${SECTION_NAMES.join(' / ')}（overview = understanding，map = questions）`);
}

/**
 * 创建运行时。
 * @param {{ctx:object, config?:object, deps?:object}} options
 */
export function createRuntime({ ctx, config: rawConfig, deps = {} } = {}) {
  const logger = safeLogger(deps.logger);
  const homeDir = deps.homeDir || process.env.HOME || '';
  const env = typeof deps.env === 'object' && deps.env ? deps.env : process.env;
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const startedAt = Date.now();

  const config = normalizeConfig(rawConfig, { homeDir, env });

  const store = createStore({ config, model, logger, render: deps.render });
  const search = createSearchService({ ctx, config, logger, fetchImpl: deps.fetchImpl });
  const anySearchCatalog = createAnySearchCatalog({ fetchImpl: deps.fetchImpl });
  const fetcher = createFetcher({ ctx, config, logger, fetchImpl: deps.fetchImpl });
  const llm = createLlmService({ ctx, config, logger });
  const jobs = createJobQueue({ store, logger, maxActive: config.maxActiveJobs });

  const engine = {
    ready: false,
    error: '',
    prompts: deps.prompts || promptsModule,
    render: deps.render || renderModule,
  };
  let pipeline = null;
  let router = null;
  let initialized = false;
  let initPromise = null;
  let settingsPromise = null;
  let disposed = false;

  async function ensureEngine() {
    if (pipeline) return true;
    try {
      if (deps.pipeline && typeof deps.pipeline === 'object' && typeof deps.pipeline.runInitial === 'function') {
        pipeline = deps.pipeline;
      } else {
        // 给 pipeline 一个安全 ctx：Cordis context 在未 inject 时读 `ctx.now` 会抛
        // “cannot get property without inject”，这里显式提供 now/get，其余服务已直接注入。
        const pipelineCtx = {
          now: () => now(),
          get: (name) => getService(name),
        };
        pipeline = createPipeline({
          ctx: pipelineCtx,
          config,
          store,
          search,
          fetcher,
          llm,
          prompts: engine.prompts,
          model,
          logger,
        });
      }
      engine.ready = true;
      engine.error = '';
      logger.info('研究引擎已就绪（prompts / pipeline / render）');
      return true;
    } catch (error) {
      engine.ready = false;
      engine.error = redactSecrets(error && error.message ? error.message : String(error)).slice(0, 400);
      logger.warn(`研究引擎初始化失败：${engine.error}`);
      return false;
    }
  }

  async function getRenderer() {
    if (engine.render && typeof engine.render.renderArchiveMarkdown === 'function') return engine.render;
    if (deps.render && typeof deps.render.renderArchiveMarkdown === 'function') return deps.render;
    return null;
  }

  function getService(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  function requireEnabled() {
    if (!config.enabled) {
      throw httpError('PLUGIN_DISABLED', '「AI 大搜索」已被禁用', '在插件设置里把 enabled 设为 true。');
    }
  }

  /** Run one search for another local plugin without creating a research dossier. */
  async function searchWeb(query, { maxResults, signal } = {}) {
    signal?.throwIfAborted();
    await init();
    signal?.throwIfAborted();
    requireEnabled();
    if (disposed) throw httpError('PLUGIN_DISABLED', '「AI 大搜索」已卸载');
    return search.search(cleanQuery(query), { maxResults, signal });
  }

  async function searchSelection(searchProviderMode, anySearch) {
    if (searchProviderMode !== undefined && !SEARCH_MODES.includes(searchProviderMode)) {
      throw httpError('BAD_REQUEST', '检索来源无效');
    }
    const selection = await anySearchCatalog.validate(anySearch);
    if (selection && searchProviderMode && searchProviderMode !== 'anysearch') {
      throw httpError('BAD_REQUEST', '手动垂直检索需使用 AnySearch 检索来源');
    }
    const providerMode = searchProviderMode || (selection || config.searchProviderMode === 'anysearch' ? 'anysearch' : undefined);
    if (providerMode === 'anysearch' && !config.anySearchApiKey) {
      throw httpError('SEARCH_UNAVAILABLE', 'AnySearch API Key 未配置', '配置 AnySearch API Key 后重试。');
    }
    return { providerMode, selection };
  }

  /** 原词检索只调用搜索提供方，不依赖研究引擎。 */
  async function directSearch({ query, searchProviderMode, anySearch, signal } = {}) {
    signal?.throwIfAborted();
    if (typeof query !== 'string' || !query.trim()) throw httpError('BAD_REQUEST', '请输入检索词');
    if (query.length > 500) throw httpError('BAD_REQUEST', '检索词最多 500 字');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(query)) {
      throw httpError('BAD_REQUEST', '检索词含有无法处理的控制字符');
    }
    await (settingsPromise ??= loadStoredSettings());
    signal?.throwIfAborted();
    requireEnabled();
    if (disposed) throw httpError('PLUGIN_DISABLED', '「AI 大搜索」已卸载');
    const { providerMode, selection } = await searchSelection(searchProviderMode, anySearch);
    signal?.throwIfAborted();
    const result = await search.search(query, {
      searchProviderMode: providerMode,
      anySearch: selection,
      signal,
      direct: true,
    });
    if (!result.ok) throw httpError(result.error.code, result.error.message, result.error.hint);
    return result;
  }

  async function requireTopic(topicId) {
    const id = String(topicId || '').trim();
    if (!/^tp-\d{8}-[a-f0-9]{6}$/.test(id)) {
      throw httpError('BAD_REQUEST', `topicId 格式不正确：${id || '（空）'}`);
    }
    const archive = await store.getTopic(id);
    if (!archive) throw httpError('NOT_FOUND', `档案不存在：${id}`);
    return archive;
  }

  async function markArchiveAfterFailure(topicId, kind, previousStatus) {
    try {
      const archive = await store.getTopic(topicId);
      if (!archive) return;
      if (archive.status !== 'running' && archive.status !== 'draft') return;
      archive.status = kind === 'initial' ? 'failed' : previousStatus && previousStatus !== 'running' ? previousStatus : 'partial';
      archive.updatedAt = nowIsoFrom(now);
      await store.saveTopic(archive);
    } catch (error) {
      logger.warn(`更新失败档案状态出错（忽略）：${error && error.message ? error.message : String(error)}`);
    }
  }

  function makeTask({ topicId, kind, extra = {}, previousStatus = '' }) {
    return async (job, signal) => {
      const ready = await ensureEngine();
      if (!ready || !pipeline) {
        throw httpError(
          'ENGINE_UNAVAILABLE',
          `研究引擎尚未就绪：${engine.error || 'lib/pipeline.js 不存在'}`,
          '这是并行开发中的已知状态；pipeline.js 就绪后重新发起即可。',
        );
      }
      const method = kind === 'initial' ? 'runInitial' : kind === 'followup' ? 'runFollowup' : 'runRefresh';
      if (typeof pipeline[method] !== 'function') {
        throw httpError('ENGINE_UNAVAILABLE', `pipeline.${method} 尚未实现`);
      }
      try {
        return await pipeline[method](job, signal, { topicId, ...extra });
      } catch (error) {
        await markArchiveAfterFailure(topicId, kind, previousStatus);
        throw error;
      }
    };
  }

  /** 启动一份新档案。 */
  async function startTopic({ query, angle = '', depth, searchProviderMode, anySearch } = {}) {
    requireEnabled();
    const clean = cleanQuery(query);
    const { providerMode, selection } = await searchSelection(searchProviderMode, anySearch);
    const depthValue = depth === 'quick' || depth === 'deep' ? depth : config.defaultDepth;
    const archive = model.emptyArchive({
      query: clean,
      angle: typeof angle === 'string' ? angle.slice(0, 200) : '',
      depth: depthValue,
      language: 'zh',
      now: now(),
    });
    archive.status = 'running';
    archive.updatedAt = nowIsoFrom(now);
    if (providerMode === 'anysearch') archive.input.searchProviderMode = 'anysearch';
    if (selection) archive.input.anySearch = selection;
    await store.saveTopic(archive);

    let job;
    try {
      job = jobs.enqueue({
        topicId: archive.id,
        kind: 'initial',
        searchProviderMode: providerMode,
        anySearch: selection,
        task: makeTask({ topicId: archive.id, kind: 'initial' }),
      });
    } catch (error) {
      archive.status = 'failed';
      archive.updatedAt = nowIsoFrom(now);
      await store.saveTopic(archive).catch(() => {});
      throw error;
    }
    logger.info(`新建档案 ${archive.id}（${clean}，${depthValue}）→ ${job.id}`);
    return { topicId: archive.id, jobId: job.id };
  }

  /** 追问：补进已有档案。 */
  async function ask({ topicId, question } = {}) {
    requireEnabled();
    const archive = await requireTopic(topicId);
    const clean = cleanQuestion(question);
    if (jobs.hasActive(archive.id)) {
      throw httpError('CONFLICT', '该档案已有任务在运行', '等当前任务结束后再追问；可在面板里取消当前任务。');
    }
    const previousStatus = archive.status;
    const job = jobs.enqueue({
      topicId: archive.id,
      kind: 'followup',
      searchProviderMode: archive.input?.searchProviderMode,
      anySearch: archive.input?.anySearch,
      task: makeTask({ topicId: archive.id, kind: 'followup', extra: { question: clean }, previousStatus }),
    });
    logger.info(`追问 ${archive.id}：${clean.slice(0, 60)} → ${job.id}`);
    return { topicId: archive.id, jobId: job.id };
  }

  /** 刷新：用现有问题重新检索（接口 §6）。 */
  async function refreshTopic({ topicId } = {}) {
    requireEnabled();
    const archive = await requireTopic(topicId);
    if (jobs.hasActive(archive.id)) {
      throw httpError('CONFLICT', '该档案已有任务在运行', '等当前任务结束后再刷新。');
    }
    const previousStatus = archive.status;
    const job = jobs.enqueue({
      topicId: archive.id,
      kind: 'refresh',
      searchProviderMode: archive.input?.searchProviderMode,
      anySearch: archive.input?.anySearch,
      task: makeTask({ topicId: archive.id, kind: 'refresh', previousStatus }),
    });
    return { topicId: archive.id, jobId: job.id };
  }

  function compactJob(job, { withLog = false } = {}) {
    if (!job) return null;
    return {
      id: job.id,
      topicId: job.topicId,
      kind: job.kind,
      searchProviderMode: job.searchProviderMode,
      anySearchTag: job.anySearchTag,
      status: job.status,
      stage: job.stage,
      progress: Math.round(Number(job.progress) || 0),
      current: job.current && typeof job.current === 'object' ? { ...job.current } : { index: 0, total: 0, label: '' },
      error: job.error || '',
      ...(withLog ? { log: Array.isArray(job.log) ? job.log.slice(-50) : [] } : {}),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  async function statusOf(topicId) {
    const allJobs = await jobs.list();
    if (topicId) {
      const id = String(topicId).trim();
      const topic = /^tp-\d{8}-[a-f0-9]{6}$/.test(id) ? await store.getTopic(id) : null;
      if (!topic) return { ok: true, topic: null, job: null, jobs: [] };
      const topicJobs = allJobs.filter((job) => job.topicId === id).map((job) => compactJob(job, { withLog: true }));
      const job = topicJobs.find((item) => item.status === 'running') || topicJobs.find((item) => item.status === 'queued') || topicJobs[0] || null;
      return {
        ok: true,
        topic: model.archiveSummary(topic),
        job,
        jobs: topicJobs,
      };
    }
    const topics = await store.listTopics({ limit: 20 });
    return {
      ok: true,
      topic: null,
      job: null,
      topics,
      jobs: allJobs.slice(0, 10).map((job) => compactJob(job)),
    };
  }

  /** 读档案某一节 → 中文纯文本，上限 18000 字。 */
  async function readSection(topicId, section = 'understanding') {
    const archive = await requireTopic(topicId);
    return clipText(buildSectionText(archive, section), SECTION_LIMIT);
  }

  async function buildFallbackMarkdown(archive, variant) {
    const title = `# ${topicTitle(archive)}`;
    const index = indexArchive(archive);
    if (variant === 'brief') {
      const body = [...understandingText(archive, index), '', ...judgmentsText(archive, index)];
      return `${title}\n\n${body.join('\n')}`;
    }
    return `${title}\n\n${allText(archive, index).join('\n')}`;
  }

  /** 导出：full / brief / json。 */
  async function exportTopic({ topicId, format = 'full' } = {}) {
    const archive = await requireTopic(topicId);
    const variant = String(format || 'full').toLowerCase();
    if (!['full', 'brief', 'json'].includes(variant)) {
      throw httpError('BAD_REQUEST', `未知导出格式：${variant}`, '可用格式：full / brief / json。');
    }
    const base = safeFilename(`${archive.topic.title || archive.id}-${archive.id}-${variant}`);
    if (variant === 'json') {
      return { filename: `${base}.json`, content: `${JSON.stringify(archive, null, 2)}\n` };
    }
    let content = '';
    try {
      const renderer = await getRenderer();
      if (renderer && typeof renderer.renderArchiveMarkdown === 'function') {
        content = renderer.renderArchiveMarkdown(archive, { variant });
      }
    } catch (error) {
      logger.warn(`Markdown 渲染失败，使用内置导出：${error && error.message ? error.message : String(error)}`);
    }
    if (typeof content !== 'string' || !content.trim()) content = await buildFallbackMarkdown(archive, variant);
    return { filename: `${base}.md`, content };
  }

  async function health() {
    let topics = [];
    try {
      topics = await store.listTopics({ limit: 500 });
    } catch (error) {
      logger.warn(`health 读取档案列表失败：${error && error.message ? error.message : String(error)}`);
    }
    let jobList = [];
    try {
      jobList = await jobs.list();
    } catch (error) {
      logger.warn(`health 读取任务列表失败：${error && error.message ? error.message : String(error)}`);
    }
    let searchProbe;
    try {
      searchProbe = await search.probe();
    } catch (error) {
      searchProbe = { mode: null, modes: [], error: { code: 'SEARCH_UNAVAILABLE', message: String(error && error.message ? error.message : error) } };
    }
    const llmProbe = llm.probe();
    return {
      ok: true,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      enabled: Boolean(config.enabled),
      dataRoot: store.dataRoot,
      engine: { ready: Boolean(engine.ready), error: engine.error || '' },
      llm: llmProbe,
      search: searchProbe,
      model: llmProbe.ok ? { provider: llmProbe.provider, model: llmProbe.model } : null,
      counts: {
        topics: topics.length,
        jobs: jobList.length,
        running: jobList.filter((job) => job.status === 'running').length,
        queued: jobList.filter((job) => job.status === 'queued').length,
        ...jobs.counts(),
      },
      config: publicConfig(config),
      initialized,
      uptimeMs: Date.now() - startedAt,
    };
  }

  function getSettings() {
    return publicConfig(config);
  }

  async function updateSettings(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw httpError('BAD_REQUEST', 'settings 必须是 JSON 对象');
    }
    const updates = {};
    for (const key of SETTINGS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) updates[key] = patch[key];
    }
    if (Object.keys(updates).length === 0) {
      throw httpError('BAD_REQUEST', `没有可更新字段`, `可更新字段：${SETTINGS_KEYS.join(', ')}`);
    }
    await (settingsPromise ??= loadStoredSettings());
    const previousRoot = config.rootDir;
    const next = normalizeConfig({ ...config, ...updates }, { homeDir, env });
    Object.assign(config, next);
    await store.init();
    search.clearCache();
    jobs.setMaxActive(config.maxActiveJobs);
    try {
      await store.writeSettings(publicConfig(config));
      // rootDir 变化时，在旧目录留一份指针，插件重启后还能找到新目录。
      if (previousRoot && previousRoot !== config.rootDir) {
        await fsp.mkdir(previousRoot, { recursive: true });
        await fsp.writeFile(
          path.join(previousRoot, 'settings.json'),
          `${JSON.stringify(publicConfig(config), null, 2)}\n`,
          'utf8',
        );
      }
    } catch (error) {
      logger.warn(`设置持久化失败（本次仍生效）：${error && error.message ? error.message : String(error)}`);
    }
    return publicConfig(config);
  }

  async function loadStoredSettings() {
    try {
      const stored = await store.readSettings();
      if (!stored) return;
      const cleaned = {};
      for (const key of SETTINGS_KEYS) {
        if (Object.prototype.hasOwnProperty.call(stored, key)) cleaned[key] = stored[key];
      }
      if (Object.keys(cleaned).length === 0) return;
      Object.assign(config, normalizeConfig({ ...config, ...cleaned }, { homeDir, env }));
    } catch (error) {
      logger.warn(`读取已保存设置失败（忽略）：${error && error.message ? error.message : String(error)}`);
    }
  }

  async function restoreInterrupted() {
    let restored = 0;
    try {
      const persisted = await store.listJobs();
      for (const job of persisted) {
        if (job.status !== 'running' && job.status !== 'queued') continue;
        await store.saveJob({
          ...job,
          status: 'failed',
          error: job.error || '插件重启，任务已中断',
          finishedAt: nowIsoFrom(now),
        });
        restored += 1;
      }
    } catch (error) {
      logger.warn(`恢复中断任务失败：${error && error.message ? error.message : String(error)}`);
    }
    try {
      const topics = await store.listTopics({ limit: 500 });
      for (const summary of topics) {
        if (summary.status !== 'running' && summary.status !== 'draft') continue;
        const archive = await store.getTopic(summary.id);
        if (!archive) continue;
        archive.status = archive.questions.length || archive.sources.length ? 'partial' : 'failed';
        archive.updatedAt = nowIsoFrom(now);
        await store.saveTopic(archive);
      }
    } catch (error) {
      logger.warn(`修正中断档案状态失败：${error && error.message ? error.message : String(error)}`);
    }
    if (restored) logger.warn(`已把 ${restored} 个中断任务标记为 failed`);
  }

  async function init() {
    if (disposed) return;
    if (initPromise) return initPromise;
    initPromise = (async () => {
      await (settingsPromise ??= loadStoredSettings());
      await store.init();
      await restoreInterrupted();
      await ensureEngine();
      search.clearCache();
      llm.clearCache();
      initialized = true;
    })();
    return initPromise;
  }

  async function dispose() {
    disposed = true;
    try {
      await jobs.dispose();
    } catch {
      /* ignore */
    }
    search.clearCache();
    llm.clearCache();
  }

  async function getTopic(topicId) {
    const id = String(topicId || '').trim();
    if (!/^tp-\d{8}-[a-f0-9]{6}$/.test(id)) return null;
    return store.getTopic(id);
  }

  async function listTopics({ q = '', limit = 100 } = {}) {
    return store.listTopics({ q, limit });
  }

  async function deleteTopic(topicId) {
    const id = String(topicId || '').trim();
    if (!/^tp-\d{8}-[a-f0-9]{6}$/.test(id)) return null;
    return store.deleteTopic(id);
  }

  async function getJob(jobId) {
    const id = String(jobId || '').trim();
    if (!/^job-\d{8}-[a-f0-9]{6}$/.test(id)) return null;
    return jobs.get(id);
  }

  async function cancelJob(jobId) {
    const job = await getJob(jobId);
    if (!job) return { ok: false, code: 'NOT_FOUND', message: `任务不存在：${jobId}` };
    if (!jobs.cancel(String(jobId).trim())) {
      return { ok: false, code: 'CONFLICT', message: '任务已结束，无法取消' };
    }
    return { ok: true, id: job.id };
  }

  function handleRoute(req, res) {
    if (!router) router = createRouter({ runtime: rt, prefix: ROUTE_PREFIX });
    return router.handle(req, res);
  }

  function buildToolDefinitions() {
    return buildToolsFromRuntime(rt);
  }

  async function recordKnowledgeBase(topicId, input = {}) {
    const archive = await requireTopic(topicId);
    const body = input && typeof input === 'object' ? input : {};
    const format = String(body.format || 'full').toLowerCase() === 'brief' ? 'brief' : 'full';
    const title = clipText(body.title || `AI 大搜索 · ${archive.topic.title}`, 300);
    const kbJobId = clipText(body.kbJobId, 120);
    const sourceId = clipText(body.sourceId, 120);
    const pages = Number.isFinite(Number(body.pages)) ? Math.max(0, Math.round(Number(body.pages))) : 0;
    const ingestedAt = /^\d{4}-\d{2}-\d{2}T/.test(String(body.ingestedAt || '')) ? String(body.ingestedAt) : nowIsoFrom(now);
    const list = Array.isArray(archive.knowledgeBase) ? archive.knowledgeBase.slice() : [];
    const record = {
      id: `kb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      format,
      title,
      kbJobId,
      sourceId,
      pages,
      ingestedAt,
      status: body.status === 'failed' ? 'failed' : 'done',
      note: clipText(body.note, 400),
    };
    // 同一次 KB 任务重复上报时更新，不重复记。
    const existing = kbJobId ? list.findIndex((item) => item.kbJobId === kbJobId) : -1;
    if (existing >= 0) list[existing] = { ...list[existing], ...record, id: list[existing].id };
    else list.unshift(record);
    archive.knowledgeBase = list.slice(0, 20);
    archive.updatedAt = nowIsoFrom(now);
    await store.saveTopic(archive);
    return { ok: true, knowledgeBase: archive.knowledgeBase, archiveUpdatedAt: archive.updatedAt };
  }

  async function findJobForTopic(topicId) {
    const id = String(topicId || '').trim();
    if (!id) return null;
    try {
      const list = await jobs.list();
      const owned = list.filter((job) => job && job.topicId === id);
      if (!owned.length) return null;
      return (
        owned.find((job) => job.status === 'running' || job.status === 'queued') ||
        owned[0]
      );
    } catch {
      return null;
    }
  }

  const rt = {
    init,
    dispose,
    searchWeb,
    directSearch,
    anySearchDomains: anySearchCatalog.domains,
    anySearchCapabilities: anySearchCatalog.capabilities,
    startTopic,
    ask,
    refreshTopic,
    statusOf,
    readSection,
    exportTopic,
    handleRoute,
    buildToolDefinitions,
    health,
    getTopic,
    listTopics,
    deleteTopic,
    getJob,
    recordKnowledgeBase,
    findJobForTopic,
    cancelJob,
    getSettings,
    updateSettings,
    config,
    services: { store, search, fetcher, llm, jobs, get pipeline() { return pipeline; }, engine },
  };

  return rt;
}
