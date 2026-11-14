/**
 * lib/pipeline.js —— v2 研究编排（CONTRACT.md §4）。
 *
 * runInitial：
 *   framing → basics → discussion → coverage → planning
 *          → researching → verifying → synthesizing → linking
 * runFollowup：计划归并 → 检索/精读 → 增量研究 → 局部判断更新 → 写盘
 * runRefresh：重新检索 → 证据核查 → 局部判断更新 → 写盘
 *
 * 设计约束：
 *  - 只用注入的服务，不 import 任何 @deepseek-ai/* 或 npm 包；
 *  - 基础认识与讨论地图在深搜之前完成；覆盖检查不能省；
 *  - 模型 JSON、检索、抓取都不可信：先规范化再进档案；
 *  - 单问题/单模块失败不阻塞整档，标 partial 并写清限制；
 *  - 取消立即停手且不写新内容；超时按 partial 收尾，保留已完成部分；
 *  - 写盘前 normalize + recount，validate 的 error 必须归零。
 */

import * as defaultModel from './model.js';
import * as defaultPrompts from './prompts.js';

const STAGE_RANGES = {
  framing: [2, 6],
  basics: [6, 26],
  discussion: [26, 46],
  coverage: [46, 52],
  planning: [52, 58],
  researching: [58, 82],
  verifying: [82, 90],
  synthesizing: [90, 97],
  linking: [97, 100],
  done: [100, 100],
};

const STAGE_LABELS = {
  framing: '理解输入',
  basics: '基础检索与认识',
  discussion: '讨论检索与地图',
  coverage: '覆盖检查',
  planning: '问题规划',
  researching: '定向深搜',
  verifying: '证据核查',
  synthesizing: '形成判断',
  linking: '校验与写盘',
  done: '完成',
};

const DEFAULTS = {
  maxQuestions: 6,
  quickQuestions: 3,
  searchesPerQuestion: 3,
  searchMaxResults: 8,
  fetchPerQuestion: 8,
  fetchMaxChars: 6000,
  maxResearchConcurrency: 2,
  maxSourcesPerQuestion: 8,
  maxBasicQueries: 5,
  maxBasicSources: 10,
  maxDiscussionIssues: 5,
  maxDiscussionQueriesPerIssue: 2,
  maxDiscussionSources: 12,
  maxSearches: 48,
  maxFetches: 80,
  fetchFailureRate: 0.6,
  fetchMinSamples: 8,
  fetchConsecutiveFailures: 5,
  fetchTimeRatio: 0.55,
  jobTimeoutMs: 1500000,
  llmMaxTokens: 12000,
  defaultDepth: 'deep',
};

const FRAME_SCHEMA_HINT =
  '{"topic":{"title","kind","definition","scope","exclusions","whyNow"},"purpose","discussionWindow","basicQueries":[],"discussionIssues":[{"issue","queries":[]}],"ambiguities":[]}';

const BASICS_SCHEMA_HINT =
  '{"understanding":{"summary","blocks":[{"kind","title","text","claimText","evidence":[{"text","quote","sourceId","locator","readScope","identity","attribution","note"}]}],"entities":[{"name","type","role","sourceIds"}],"confusables":[{"term","confusedWith","note","sourceIds"}],"timeline":[{"at","text","sourceIds"}]},"coverage":{"status","note","limits"}}';

const DISCUSSION_SCHEMA_HINT =
  '{"scope":{"window","platforms":[],"languages":[],"limits","materialCount","speakerCount"},"issues":[{"question","summary","status","items":[{"speaker","affiliation","identity","at","channel","view","basis","evidence":[{"text","quote","sourceId","locator","readScope","identity","note"}]}],"sides":[{"position","holders"}],"disagreement":{"origin","note"},"gaps"}],"coverage":{"status","note","limits"}}';

const COVERAGE_SCHEMA_HINT =
  '{"understanding":{"status","missing":[]},"discussion":{"status","missing":[]},"supplementary":[{"module":"basics|discussion","query","reason"}]}';

const SUPPLEMENT_SCHEMA_HINT =
  '{"blocks":[{"kind","title","text","claimText","evidence":[{"text","quote","sourceId","locator","readScope","identity","attribution","note"}]}],"items":[{"issueId","speaker","affiliation","identity","at","channel","view","basis","evidence":[]}],"coverage":{"status","note"}}';

const PLANNING_SCHEMA_HINT =
  '{"questions":[{"question","why","role","priority","evidenceNeed","queries":[],"relation":{"to","kind","note"}}]}';

const RESEARCH_SCHEMA_HINT =
  '{"summary","confidence","coverage","evidence":[{"id","text","quote","sourceId","locator","readScope","identity","stance","note"}],"claims":[{"statement","identity","confidence","basis","conditions","attribution","evidenceIds":[],"opposeEvidenceIds":[]}],"mechanism":[{"text","evidenceIds":[]}],"counterpoints":[{"text","condition","evidenceIds":[]}],"gaps":[{"text","whyItMatters","howToClose"}],"branches":[{"text","hook","priority"}]}';

const VERIFICATION_SCHEMA_HINT =
  '{"updates":[{"questionId","claims":[{"claimId","evidenceStatus","confidence","note","conditions"}],"evidence":[{"text","quote","sourceId","locator","readScope","identity","stance","note"}],"counterpoints":[{"text","condition"}],"coverage"}],"limits"}';

const SYNTHESIS_SCHEMA_HINT =
  '{"judgments":[{"text","identity","confidence","conditions","claimIds":[]}],"unknowns":[{"text","whyItMatters","howToClose","questionId"}],"branches":[{"text","hook","priority","questionId"}],"connections":[{"from","to","kind","mechanism","claimIds":[],"sourceIds":[],"status"}],"tensions":[],"readingNote"}';

const PLAN_SCHEMA_HINT =
  '{"mode":"basics|discussion|question|new-question","targetId":"q1 或空","reason","queries":[]}';

const FOLLOWUP_SCHEMA_HINT =
  '{"mode","answer","revisionNote","affectedClaimIds":[],"understanding":{},"discussion":{},"question":{},"evidence":[],"claims":[],"mechanism":[],"counterpoints":[],"gaps":[],"branches":[]}';

const JUDGMENT_PATCH_SCHEMA_HINT =
  '{"judgments":[{"id","text","identity","confidence","conditions","claimIds":[],"stale","note"}],"unknowns":[],"branches":[],"revisionNote"}';

/* ------------------------------------------------------------------ */
/* 纯工具                                                               */
/* ------------------------------------------------------------------ */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function messageOf(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function clipText(value, max, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/\r\n/g, '\n').trim();
  if (!text) return fallback;
  return text.length <= max ? text : `${text.slice(0, max).trim()}…`;
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of asArray(list)) {
    const value = typeof item === 'string' ? item.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function uniqueIds(list) {
  return uniqueStrings(asArray(list).map(String));
}

function progressOf(stage, ratio) {
  const range = STAGE_RANGES[stage] || [0, 100];
  const safe = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return Math.round(range[0] + (range[1] - range[0]) * safe);
}

function isAbortLike(error, control) {
  if (control?.signal?.aborted) return true;
  if (!error) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  if (['ABORTED', 'ABORT_ERR', 'TIMEOUT'].includes(error.code)) return true;
  return /aborted|abort|canceled|cancelled|超时|已取消/i.test(String(error.message || ''));
}

/** 有并发上限的 map：任一任务失败即停止调度并抛出。 */
async function mapLimit(items, limit, handler) {
  const list = asArray(items);
  if (!list.length) return [];
  const results = new Array(list.length);
  const workerCount = Math.max(1, Math.min(Math.max(1, limit), list.length));
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = await handler(list[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/* ------------------------------------------------------------------ */
/* 工厂                                                                 */
/* ------------------------------------------------------------------ */

export function createPipeline({ ctx, config, store, search, fetcher, llm, prompts, model, logger } = {}) {
  const P = prompts || defaultPrompts;
  const M = model || defaultModel;

  const nowFn = typeof ctx?.now === 'function'
    ? () => {
        try {
          const value = ctx.now();
          const date = value instanceof Date ? value : new Date(value);
          return Number.isFinite(date.getTime()) ? date : new Date();
        } catch {
          return new Date();
        }
      }
    : () => new Date();

  const rawConfig = config && typeof config === 'object' ? config : {};
  const settings = {
    maxQuestions: numberOr(rawConfig.maxQuestions, DEFAULTS.maxQuestions),
    quickQuestions: numberOr(rawConfig.quickQuestions, DEFAULTS.quickQuestions),
    searchesPerQuestion: numberOr(rawConfig.searchesPerQuestion, DEFAULTS.searchesPerQuestion),
    searchMaxResults: numberOr(rawConfig.searchMaxResults, DEFAULTS.searchMaxResults),
    fetchPerQuestion: numberOr(rawConfig.fetchPerQuestion, DEFAULTS.fetchPerQuestion),
    fetchMaxChars: numberOr(rawConfig.fetchMaxChars, DEFAULTS.fetchMaxChars),
    maxResearchConcurrency: numberOr(rawConfig.maxResearchConcurrency, DEFAULTS.maxResearchConcurrency),
    maxSourcesPerQuestion: numberOr(rawConfig.maxSourcesPerQuestion, DEFAULTS.maxSourcesPerQuestion),
    maxBasicQueries: numberOr(rawConfig.maxBasicQueries, DEFAULTS.maxBasicQueries),
    maxBasicSources: numberOr(rawConfig.maxBasicSources, DEFAULTS.maxBasicSources),
    maxDiscussionIssues: numberOr(rawConfig.maxDiscussionIssues, DEFAULTS.maxDiscussionIssues),
    maxDiscussionQueriesPerIssue: numberOr(rawConfig.maxDiscussionQueriesPerIssue, DEFAULTS.maxDiscussionQueriesPerIssue),
    maxDiscussionSources: numberOr(rawConfig.maxDiscussionSources, DEFAULTS.maxDiscussionSources),
    maxSearches: numberOr(rawConfig.maxSearches, DEFAULTS.maxSearches),
    maxFetches: Math.min(80, numberOr(rawConfig.maxFetches, DEFAULTS.maxFetches)),
    fetchFailureRate: Math.min(1, Math.max(0, numberOr(rawConfig.fetchFailureRate, DEFAULTS.fetchFailureRate))),
    fetchMinSamples: Math.max(3, Math.round(numberOr(rawConfig.fetchMinSamples, DEFAULTS.fetchMinSamples))),
    fetchConsecutiveFailures: Math.max(2, Math.round(numberOr(rawConfig.fetchConsecutiveFailures, DEFAULTS.fetchConsecutiveFailures))),
    fetchTimeRatio: Math.min(0.9, Math.max(0.2, numberOr(rawConfig.fetchTimeRatio, DEFAULTS.fetchTimeRatio))),
    jobTimeoutMs: numberOr(rawConfig.jobTimeoutMs, DEFAULTS.jobTimeoutMs),
    llmMaxTokens: numberOr(rawConfig.llmMaxTokens, DEFAULTS.llmMaxTokens),
    defaultDepth: rawConfig.defaultDepth === 'quick' ? 'quick' : DEFAULTS.defaultDepth,
  };

  function numberOr(value, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  function todayString(date = nowFn()) {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 10);
    }
  }

  function logToLogger(level, message) {
    if (!logger) return;
    const fn = level === 'error' ? logger.error : level === 'warn' ? logger.warn : logger.info;
    if (typeof fn !== 'function') return;
    try {
      fn.call(logger, `[deep-search] ${message}`);
    } catch {
      /* 日志失败不影响任务 */
    }
  }

  /** live job 适配：队列传的是带方法的句柄；测试里是普通对象。 */
  function createUi(job) {
    const hasStage = Boolean(job && typeof job.stage === 'function');
    const hasLog = Boolean(job && typeof job.log === 'function');
    const hasCurrent = Boolean(job && typeof job.current === 'function');
    return {
      stage(stage, progress, label) {
        if (hasStage) {
          try {
            job.stage(stage, progress, label);
          } catch {
            /* ignore */
          }
        } else if (job) {
          job.stage = stage;
          if (Number.isFinite(progress)) {
            job.progress = progress;
            job.stageProgress = progress;
          }
          if (label) job.current = { index: 0, total: 0, label };
        }
      },
      current(index, total, label) {
        if (hasCurrent) {
          try {
            job.current(index, total, label);
          } catch {
            /* ignore */
          }
        } else if (job) {
          job.current = { index, total, label };
        }
      },
      log(level, message) {
        const line = clipText(String(message || ''), 600);
        if (!line) return;
        if (hasLog) {
          try {
            job.log(level, line);
          } catch {
            /* ignore */
          }
        } else if (job) {
          if (!Array.isArray(job.log)) job.log = [];
          job.log.push({ at: new Date().toISOString(), level, text: line });
          if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
        }
        logToLogger(level, line);
      },
    };
  }

  /** 取消 / 超时控制。 */
  function createControl(signal, timeoutMs) {
    const controller = new AbortController();
    let timedOut = false;
    const forward = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', forward, { once: true });
    }
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return {
      signal: controller.signal,
      isTimedOut: () => timedOut,
      ensureActive() {
        if (!controller.signal.aborted) return;
        const error = new Error(timedOut ? '任务超时' : '任务已取消');
        error.name = timedOut ? 'TimeoutError' : 'AbortError';
        error.code = timedOut ? 'TIMEOUT' : 'ABORTED';
        throw error;
      },
      dispose() {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', forward);
      },
    };
  }

  function abortError(rs, cause) {
    const error = new Error(rs.ctl.isTimedOut() ? '任务超时' : '任务已取消');
    error.name = rs.ctl.isTimedOut() ? 'TimeoutError' : 'AbortError';
    error.code = rs.ctl.isTimedOut() ? 'TIMEOUT' : 'ABORTED';
    error.cause = cause;
    return error;
  }

  /* ---------------------------------------------------------------- */
  /* 运行上下文                                                        */
  /* ---------------------------------------------------------------- */

  function createRun({ job, signal, topicId, kind }) {
    const now = nowFn();
    const rs = {
      topicId,
      kind,
      job,
      startedAt: Date.now(),
      today: todayString(now),
      ctl: createControl(signal, settings.jobTimeoutMs),
      archive: null,
      baseStats: null,
      counters: { llmCalls: 0, searches: 0, fetched: 0, fetchedFailed: 0 },
      consecutiveFetchFailures: 0,
      fetchStopped: '',
      frame: null,
      basicSourceIds: [],
      discussionSourceIds: [],
      questionSources: new Map(),
      verificationSources: new Map(),
      degraded: false,
      stage: 'framing',
      revisionSummaryText: '',
      revisionAdded: false,
      repairs: 0,
      nowIso: () => nowFn().toISOString(),
      nowDate: () => nowFn(),
    };
    rs.ui = createUi(job);
    rs.elapsed = () => Date.now() - rs.startedAt;
    rs.budget = {
      searchLeft: () => Math.max(0, settings.maxSearches - rs.counters.searches),
      fetchLeft: () => Math.max(0, settings.maxFetches - rs.counters.fetched),
    };
    return rs;
  }

  async function loadArchive(rs) {
    if (!store || typeof store.getTopic !== 'function') throw new Error('store 不可用：缺少 getTopic');
    let raw = null;
    try {
      raw = await store.getTopic(rs.topicId);
    } catch (error) {
      throw new Error(`读取档案失败：${messageOf(error)}`);
    }
    if (!raw) return null;
    const archive = M.normalizeArchive(raw && typeof raw.archive === 'object' ? raw.archive : raw);
    if (rs.topicId && archive.id !== rs.topicId) archive.id = rs.topicId;
    rs.archive = archive;
    rs.baseStats = { ...archive.stats };
    return archive;
  }

  async function saveArchive(rs) {
    if (!rs.archive) return null;
    if (rs.ctl.signal.aborted && !rs.ctl.isTimedOut()) throw abortError(rs, null);
    const archive = M.normalizeArchive(rs.archive);
    rs.archive = archive;
    archive.updatedAt = rs.nowIso();
    M.recount(archive);
    if (store && typeof store.saveTopic === 'function') {
      try {
        await store.saveTopic(archive);
      } catch (error) {
        throw new Error(`保存档案失败：${messageOf(error)}`);
      }
    }
    return archive;
  }

  function commitStats(rs) {
    if (!rs.archive) return;
    const base = rs.baseStats || {};
    const previous = (key) => (Number.isFinite(Number(base[key])) ? Number(base[key]) : 0);
    rs.archive.stats = {
      ...rs.archive.stats,
      searches: previous('searches') + rs.counters.searches,
      fetched: previous('fetched') + rs.counters.fetched,
      llmCalls: previous('llmCalls') + rs.counters.llmCalls,
      durationMs: previous('durationMs') + rs.elapsed(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* LLM：JSON 输出 + 一次修复                                          */
  /* ---------------------------------------------------------------- */

  function asObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (value.ok === false && value.error) return null;
    return value;
  }

  function extractRaw(error) {
    if (!error || typeof error !== 'object') return '';
    for (const key of ['raw', 'text', 'response', 'content', 'output']) {
      if (typeof error[key] === 'string' && error[key].trim()) return error[key];
    }
    return '';
  }

  async function rawJson(rs, built, maxTokens, validate) {
    rs.counters.llmCalls += 1;
    return asObject(
      await llm.json({
        system: built.system,
        prompt: built.prompt,
        maxTokens,
        signal: rs.ctl.signal,
        validate: typeof validate === 'function' ? validate : undefined,
      }),
    );
  }

  async function repairWith(rs, { raw, errors, schemaHint, stage, maxTokens, originalPrompt = '', originalSystem = '' }) {
    if (!raw || typeof P.buildRepairPrompt !== 'function' || rs.repairs >= 2) return null;
    rs.repairs += 1;
    try {
      const built = P.buildRepairPrompt({
        raw: String(raw),
        errors,
        schemaHint,
        originalPrompt,
        system: originalSystem,
      });
      const result = await rawJson(rs, built, maxTokens);
      if (result) rs.ui.log('info', `${stage}：已通过一次 JSON 修复`);
      return result;
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      rs.ui.log('warn', `${stage}：JSON 修复失败（${clipText(messageOf(error), 120)}）`);
      return null;
    }
  }

  async function requestJson(rs, { builder, input, stage, maxTokens, schemaHint, validate }) {
    rs.ctl.ensureActive();
    if (typeof builder !== 'function') throw new Error(`缺少提示词构造器：${stage}`);
    if (!llm || typeof llm.json !== 'function') throw new Error('模型服务不可用：缺少 llm.json');
    const built = builder(input);
    let first = null;
    try {
      first = await rawJson(rs, built, maxTokens, validate);
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      rs.ui.log('warn', `${stage}：模型输出不可用（${clipText(messageOf(error), 160)}）`);
      return repairWith(rs, {
        raw: extractRaw(error),
        errors: [messageOf(error)],
        schemaHint,
        stage,
        maxTokens,
        originalPrompt: built.prompt,
        originalSystem: built.system,
      });
    }
    if (!first) return null;
    const problem = typeof validate === 'function' ? validate(first) : '';
    if (!problem) return first;
    rs.ui.log('warn', `${stage}：输出结构不完整（${problem}）`);
    const repaired = await repairWith(rs, {
      raw: JSON.stringify(first),
      errors: [problem],
      schemaHint,
      stage,
      maxTokens,
      originalPrompt: built.prompt,
      originalSystem: built.system,
    });
    if (repaired) {
      const secondProblem = typeof validate === 'function' ? validate(repaired) : '';
      if (!secondProblem) return repaired;
    }
    return first;
  }

  function validateFrame(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!data.topic || typeof data.topic !== 'object') return '缺少 topic 对象';
    if (!asArray(data.basicQueries).length) return '缺少 basicQueries 数组';
    if (!asArray(data.discussionIssues).length) return '缺少 discussionIssues 数组';
    return '';
  }

  function validateBasics(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    const understanding = data.understanding;
    if (!understanding || typeof understanding !== 'object') return '缺少 understanding 对象';
    if (!asArray(understanding.blocks).length) return 'understanding.blocks 为空';
    return '';
  }

  function validateDiscussion(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!asArray(data.issues).length && data.coverage?.status !== 'missing') return '缺少 issues 数组（材料不足时 coverage.status 应为 missing）';
    return '';
  }

  function validateCoverage(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!data.understanding || !data.discussion) return '缺少 understanding/discussion 评估';
    return '';
  }

  function validatePlanning(data, minQuestions = 1) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    const questions = asArray(data.questions);
    if (questions.length < minQuestions) return `questions 至少 ${minQuestions} 个，当前 ${questions.length} 个`;
    const missing = questions.filter((question) => !question || !asArray(question.queries).filter(Boolean).length);
    if (missing.length) return `有 ${missing.length} 个问题缺少检索词`;
    return '';
  }

  function validateResearch(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!asArray(data.evidence).length) return '缺少 evidence 数组';
    if (!asArray(data.claims).length) return '缺少 claims 数组';
    return '';
  }

  function validateVerification(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!Array.isArray(data.updates)) return '缺少 updates 数组';
    return '';
  }

  function validateSynthesis(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!asArray(data.judgments).length && !asArray(data.unknowns).length) return '缺少 judgments 与 unknowns';
    return '';
  }

  function validatePlan(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!['basics', 'discussion', 'question', 'new-question'].includes(data.mode)) return 'mode 必须是 basics/discussion/question/new-question';
    return '';
  }

  function validateFollowup(data) {
    if (!data || typeof data !== 'object') return '不是 JSON 对象';
    if (!['basics', 'discussion', 'question', 'new-question'].includes(data.mode)) return 'mode 非法';
    return '';
  }

  /* ---------------------------------------------------------------- */
  /* 检索 / 抓取 / 来源                                                 */
  /* ---------------------------------------------------------------- */

  async function ensureSearchAvailable(rs) {
    if (!search || typeof search.search !== 'function') {
      throw new Error('检索服务不可用：缺少 search.search。请检查插件配置或宿主版本。');
    }
    if (typeof search.probe !== 'function') return;
    try {
      const probe = await search.probe({ searchProviderMode: rs.job?.searchProviderMode });
      if (probe && (probe.ok === false || probe.mode === 'none' || probe.mode === 'unavailable')) {
        const hint = probe.error || probe.hint || '未配置可用的检索通道';
        throw new Error(`检索不可用：${hint}。`);
      }
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      if (/^检索不可用/.test(messageOf(error))) throw error;
      rs.ui.log('warn', `检索探测失败，按可用处理：${clipText(messageOf(error), 160)}`);
    }
  }

  async function searchOnce(rs, query) {
    if (rs.counters.searches >= settings.maxSearches) {
      rs.ui.log('warn', `检索预算已用完（${settings.maxSearches} 次），跳过「${clipText(query, 40)}」`);
      return [];
    }
    rs.counters.searches += 1;
    try {
      const result = await search.search(query, {
        maxResults: settings.searchMaxResults,
        signal: rs.ctl.signal,
        searchProviderMode: rs.job?.searchProviderMode,
        anySearch: rs.job?.anySearch,
      });
      if (!result) return [];
      if (result.ok === false) {
        rs.ui.log('warn', `检索失败「${clipText(query, 40)}」：${clipText(result.error, 180)}`);
        return [];
      }
      rs.ctl.ensureActive();
      if (result.mode === 'anysearch' && asArray(result.records).length) {
        M.mergeAnySearchRecords(rs.archive, result.records, {
          query,
          tag: rs.job?.anySearch?.tag,
          capturedAt: rs.nowIso(),
        });
      }
      return asArray(result.sources).filter((item) => item && typeof item === 'object');
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      rs.ui.log('warn', `检索异常「${clipText(query, 40)}」：${clipText(messageOf(error), 180)}`);
      return [];
    }
  }

  async function searchQueries(rs, queries, { concurrency = 2 } = {}) {
    const list = uniqueStrings(queries);
    const rawHits = [];
    await mapLimit(list, Math.min(concurrency, Math.max(1, list.length)), async (query) => {
      rawHits.push(...(await searchOnce(rs, query)));
    });
    return rawHits;
  }

  function cleanSourceTitle(value, fallback) {
    let text = typeof value === 'string' ? value.trim() : '';
    text = text
      .replace(/^\*+\s*(note|提示|注意)\s*[:：]\s*/i, '')
      .replace(/\*+/g, '')
      .replace(/\s*[-–—|]\s*(跳至|跳到|skip to).*$/i, '')
      .trim();
    return clipText(text, 300, fallback);
  }

  function hitOf(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const url = M.canonicalUrl(raw.url || raw.link || raw.canonicalUrl);
    if (!url) return null;
    return {
      url,
      title: cleanSourceTitle(raw.title || raw.name, url),
      summary: clipText(raw.summary || raw.snippet || raw.description || raw.content, 1200),
      publishedAt: M.iso(raw.publishedAt || raw.date || raw.publishTime || raw.published_at || ''),
      publisher: clipText(raw.publisher || raw.site_name || raw.siteName || raw.source, 120, M.hostOf(url)),
      author: clipText(raw.author, 120),
      authority: M.clampNumber(raw.authority, 0, 5, 0),
      rank: M.clampNumber(raw.rank ?? raw.rerank_score ?? raw.score, 0, 1000, 0),
      raw,
    };
  }

  function scoreHit(hit, rs) {
    let recency = 0;
    const published = Date.parse(hit.publishedAt || '');
    if (Number.isFinite(published)) {
      const days = Math.max(0, (rs.startedAt - published) / 86400000);
      recency = days <= 180 ? 1.2 : days <= 730 ? 0.6 : 0;
    }
    return (hit.rank || 0) + (hit.authority || 0) * 0.5 + recency;
  }

  function rankCandidates(rs, rawHits, limit) {
    const byUrl = new Map();
    for (const raw of asArray(rawHits)) {
      const hit = hitOf(raw);
      if (!hit) continue;
      const previous = byUrl.get(hit.url);
      if (!previous || scoreHit(hit, rs) > scoreHit(previous, rs)) byUrl.set(hit.url, hit);
    }
    return [...byUrl.values()]
      .sort((a, b) => scoreHit(b, rs) - scoreHit(a, rs))
      .slice(0, Math.max(1, limit));
  }

  function nextSourceId(archive) {
    const used = new Set(asArray(archive.sources).map((source) => source.id));
    let n = archive.sources.length + 1;
    while (used.has(`s${n}`)) n += 1;
    return `s${n}`;
  }

  function inferKind(hit) {
    const raw = hit.raw && typeof hit.raw === 'object' ? hit.raw.kind : '';
    if (M.SOURCE_KINDS?.includes?.(raw)) return raw;
    const host = M.hostOf(hit.url);
    if (!host) return 'other';
    if (host.endsWith('.gov') || host.endsWith('.gov.cn') || host === 'arxiv.org' || host === 'doi.org' || /(^|\.)sec\.gov$/.test(host)) return 'primary';
    if (/\/(blog|newsroom|press|research|publications|docs)\//i.test(hit.url)) return 'primary';
    if (/(^|\.)(x|twitter|weibo|reddit|zhihu)\.com$/.test(host) || /(^|\.)mp\.weixin\.qq\.com$/.test(host)) return 'social';
    return 'report';
  }

  function isAcademicPrimaryHost(host) {
    const value = String(host || '').toLowerCase().replace(/^www\./, '');
    if (!value) return false;
    const hosts = [
      'acm.org', 'ieee.org', 'tandfonline.com', 'informs.org', 'sciencedirect.com', 'springer.com',
      'nature.com', 'wiley.com', 'sagepub.com', 'ssrn.com', 'jstor.org', 'pubmed.ncbi.nlm.nih.gov',
      'doi.org', 'arxiv.org',
    ];
    if (hosts.some((domain) => value === domain || value.endsWith(`.${domain}`))) return true;
    if (value.endsWith('.edu') || value.endsWith('.edu.cn')) return true;
    return /(^|\.)ac\.[a-z]{2,}(\.|$)/.test(value);
  }

  function inferIndependence(hit) {
    const raw = hit.raw && typeof hit.raw === 'object' ? hit.raw.independence : '';
    if (M.INDEPENDENCE?.includes?.(raw)) return raw;
    const host = M.hostOf(hit.url);
    if (!host) return 'unknown';
    if (host.endsWith('.gov') || host.endsWith('.gov.cn')) return 'primary';
    if (isAcademicPrimaryHost(host)) return 'primary';
    if (/\/(blog|newsroom|press)\//i.test(hit.url)) return 'primary';
    return 'unknown';
  }

  function inferReliability(hit) {
    if (hit.authority >= 4) return 'high';
    if (hit.authority >= 2) return 'medium';
    return hit.authority > 0 ? 'low' : 'medium';
  }

  function ensureSource(rs, hit) {
    const archive = rs.archive;
    const existing = asArray(archive.sources).find(
      (source) => source && (source.canonicalUrl === hit.url || source.url === hit.url),
    );
    if (existing) {
      if (!existing.summary && hit.summary) existing.summary = hit.summary;
      if (!existing.publisher && hit.publisher) existing.publisher = hit.publisher;
      if (!existing.author && hit.author) existing.author = hit.author;
      return existing.id;
    }
    const source = {
      id: nextSourceId(archive),
      url: hit.url,
      canonicalUrl: hit.url,
      title: hit.title,
      publisher: hit.publisher,
      author: hit.author,
      publishedAt: hit.publishedAt,
      retrievedAt: rs.nowIso(),
      kind: inferKind(hit),
      reliability: inferReliability(hit),
      independence: inferIndependence(hit),
      originGroupId: '',
      usedFor: [],
      quote: '',
      excerpt: '',
      summary: hit.summary,
      fetch: { ok: false, status: 0, chars: 0, error: '' },
      authority: hit.authority,
      rank: hit.rank,
    };
    archive.sources.push(source);
    return source.id;
  }

  /** 抓取预算：硬上限 80，其余按时间与失败率动态停。 */
  function fetchStopReason(rs) {
    if (rs.counters.fetched >= settings.maxFetches) {
      return `总数达到硬上限 ${settings.maxFetches} 次`;
    }
    const elapsed = Date.now() - rs.startedAt;
    const timeLimit = settings.jobTimeoutMs * settings.fetchTimeRatio;
    if (elapsed >= timeLimit) {
      const minutes = Math.max(1, Math.round(elapsed / 60000));
      return `时间预算用尽（${minutes} 分钟，任务上限的 ${Math.round(settings.fetchTimeRatio * 100)}%）`;
    }
    if (rs.counters.fetched >= settings.fetchMinSamples) {
      const rate = rs.counters.fetchedFailed / Math.max(1, rs.counters.fetched);
      if (rate >= settings.fetchFailureRate) {
        return `失败率 ${Math.round(rate * 100)}%（${rs.counters.fetchedFailed}/${rs.counters.fetched}）`;
      }
    }
    if (rs.consecutiveFetchFailures >= settings.fetchConsecutiveFailures) {
      return `连续失败 ${rs.consecutiveFetchFailures} 次`;
    }
    return '';
  }

  async function fetchSource(rs, source) {
    if (!source || !source.url) return false;
    if (source.excerpt) return true;
    if (!fetcher || typeof fetcher.fetchPage !== 'function') return false;
    if (rs.fetchStopped) return false;
    const stopReason = fetchStopReason(rs);
    if (stopReason) {
      rs.fetchStopped = stopReason;
      rs.ui.log('warn', `抓取已停：${stopReason}。后续来源保留搜索摘要，注释标 abstract/snippet。`);
      return false;
    }
    rs.counters.fetched += 1;
    try {
      const result = await fetcher.fetchPage(source.url, {
        signal: rs.ctl.signal,
        maxChars: settings.fetchMaxChars,
      });
      if (result && result.ok && typeof result.text === 'string' && result.text.trim()) {
        const text = result.text.slice(0, Math.max(200, settings.fetchMaxChars));
        rs.consecutiveFetchFailures = 0;
        source.fetch = { ok: true, status: Number(result.status) || 200, chars: text.length, error: '' };
        source.excerpt = text;
        if ((!source.title || source.title === source.url) && result.title) source.title = clipText(result.title, 300, source.title);
        return true;
      }
      rs.counters.fetchedFailed += 1;
      rs.consecutiveFetchFailures += 1;
      source.fetch = {
        ok: false,
        status: Number(result?.status) || 0,
        chars: 0,
        error: clipText(result?.error || '抓取失败', 300, '抓取失败'),
      };
      return false;
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      rs.counters.fetchedFailed += 1;
      rs.consecutiveFetchFailures += 1;
      source.fetch = { ok: false, status: 0, chars: 0, error: clipText(messageOf(error), 300) };
      return false;
    }
  }

  function sourcesByIds(rs, ids) {
    const list = asArray(ids)
      .map((id) => asArray(rs.archive.sources).find((source) => source.id === id))
      .filter(Boolean);
    return list;
  }

  async function readSources(rs, sourceIds, limit) {
    const sources = sourcesByIds(rs, sourceIds).slice(0, Math.max(0, limit));
    await mapLimit(sources, Math.min(3, Math.max(1, sources.length)), async (source) => {
      await fetchSource(rs, source);
    });
    return sources;
  }

  /** 给模型读的来源包：只保留必要字段，正文截断。 */
  function packSources(rs, sourceIds) {
    return sourcesByIds(rs, sourceIds).map((source) => ({
      id: source.id,
      title: source.title,
      publisher: source.publisher,
      author: source.author,
      publishedAt: source.publishedAt,
      kind: source.kind,
      independence: source.independence,
      reliability: source.reliability,
      url: source.url,
      summary: source.summary,
      excerpt: source.excerpt,
      fetch: source.fetch,
    }));
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 1：理解输入                                                  */
  /* ---------------------------------------------------------------- */

  function fallbackFrame(rs) {
    const query = rs.archive.input.query || rs.archive.topic.title || '这个主题';
    return {
      topic: {
        title: clipText(query, 80),
        kind: 'concept',
        definition: '',
        scope: '',
        exclusions: '',
        whyNow: '',
      },
      purpose: '了解全景',
      discussionWindow: '近 12 个月',
      basicQueries: [`${query} 是什么`, `${query} 用途 原理`, `${query} 常见误解`],
      discussionIssues: [{ issue: '这个主题目前在讨论什么', queries: [`${query} 讨论 争议`, `${query} 评价`] }],
    };
  }

  async function stageFraming(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'framing';
    rs.ui.stage('framing', STAGE_RANGES.framing[0], '理解输入与检索边界');
    rs.ui.current(0, 1, '确定对象、用途、时间窗口');
    const archive = rs.archive;
    const depth = archive.input.depth === 'quick' ? 'quick' : 'deep';
    let frame = null;
    try {
      frame = await requestJson(rs, {
        builder: P.buildFramePrompt,
        input: {
          query: archive.input.query || archive.topic.title,
          angle: archive.input.angle,
          depth,
          today: rs.today,
        },
        stage: '理解输入',
        maxTokens: Math.min(settings.llmMaxTokens, 10000),
        schemaHint: FRAME_SCHEMA_HINT,
        validate: validateFrame,
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      frame = null;
    }
    if (!frame) {
      frame = fallbackFrame(rs);
      rs.degraded = true;
      rs.ui.log('warn', '理解输入未拿到可用框架，改用通用检索骨架；基础与讨论模块仍会执行。');
    }
    rs.frame = frame;
    M.applyFrame(archive, frame);
    archive.topic.depth = depth;
    archive.topic.cutoffAt = rs.nowIso();
    archive.input.cutoffAt = rs.nowIso();
    archive.input.purpose = clipText(frame.purpose, 80, '了解全景');
    archive.input.discussionWindow = clipText(frame.discussionWindow, 120);
    archive.status = 'running';
    await saveArchive(rs);
    rs.ui.log('info', `范围：${archive.topic.title}（${archive.topic.kind}）；基础检索 ${asArray(frame.basicQueries).length} 条、讨论议题 ${asArray(frame.discussionIssues).length} 个`);
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 2：基础检索 + 基础认识                                        */
  /* ---------------------------------------------------------------- */

  function fallbackUnderstanding(rs, reason) {
    const archive = rs.archive;
    const picked = asArray(rs.basicSourceIds).slice(0, 3).map((id) => asArray(archive.sources).find((source) => source.id === id)).filter(Boolean);
    const titles = picked.map((source) => clipText(source.title, 60)).filter(Boolean);
    const text = picked.length
      ? `本轮检索到 ${rs.basicSourceIds.length} 条资料，但「这是什么」的生成没有完成。可以先从这些来源核对：${titles.join('；')}。`
      : '本轮没有取得可用资料，无法给出可核查的解释。';
    archive.understanding = {
      status: 'partial',
      summary: '',
      blocks: [{ id: 'u1', kind: 'definition', title: '这是什么', text, claimIds: [], evidenceIds: [] }],
      entities: [],
      confusables: [],
      timeline: [],
      coverage: {
        status: picked.length ? 'partial' : 'missing',
        note: text,
        limits: reason || '模型未完成基础认识生成。',
      },
    };
    rs.degraded = true;
  }

  async function stageBasics(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'basics';
    await ensureSearchAvailable(rs);
    rs.ui.stage('basics', STAGE_RANGES.basics[0], '基础检索');
    const archive = rs.archive;
    const title = archive.topic.title || archive.input.query || '';
    const frameQueries = asArray(rs.frame?.basicQueries);
    const queries = uniqueStrings([
      ...frameQueries,
      `${title} 是什么`,
      `${title} 用途 原理`,
      `${title} 常见误解 容易混淆`,
    ]).slice(0, settings.maxBasicQueries);
    rs.ui.current(0, queries.length, '检索基础资料');
    const rawHits = await searchQueries(rs, queries, { concurrency: 2 });
    const candidates = rankCandidates(rs, rawHits, settings.maxBasicSources);
    const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
    rs.basicSourceIds = ids;
    rs.ui.log(ids.length ? 'info' : 'warn', ids.length ? `基础检索：${ids.length} 条来源` : '基础检索没有拿到来源');
    rs.ui.stage('basics', 12, '精读基础资料');
    await readSources(rs, ids, settings.fetchPerQuestion + 2);
    const sources = packSources(rs, ids);
    rs.ui.stage('basics', 16, '生成「这是什么」');
    let data = null;
    try {
      data = await requestJson(rs, {
        builder: P.buildBasicsPrompt,
        input: { topic: archive.topic, query: archive.input.query, sources, today: rs.today },
        stage: '基础认识',
        maxTokens: settings.llmMaxTokens,
        schemaHint: BASICS_SCHEMA_HINT,
        validate: validateBasics,
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      data = null;
    }
    if (data) {
      M.applyBasics(archive, data, { sources: archive.sources, now: rs.nowDate() });
      await saveArchive(rs);
      rs.ui.log('info', `基础认识：${asArray(archive.understanding?.blocks).length} 块、${asArray(archive.understanding?.entities).length} 个实体`);
    } else {
      fallbackUnderstanding(rs, '模型调用失败或输出结构不完整。');
      await saveArchive(rs);
      rs.ui.log('warn', '基础认识未完成，已保留检索来源与覆盖限制。');
    }
    rs.ui.stage('basics', STAGE_RANGES.basics[1], '基础认识完成');
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 3：讨论检索 + 讨论地图                                        */
  /* ---------------------------------------------------------------- */

  function fallbackDiscussion(rs, reason) {
    const archive = rs.archive;
    const seeds = asArray(rs.frame?.discussionIssues);
    const issues = seeds.length
      ? seeds.map((seed, index) => ({
          id: `d${index + 1}`,
          question: clipText(seed.issue, 200, '这个主题目前在讨论什么'),
          summary: '',
          status: 'missing',
          items: [],
          sides: [],
          disagreement: { origin: '证据缺失', note: '' },
          gaps: '本轮未能取得可归纳的公开讨论材料。',
        }))
      : [{
          id: 'd1',
          question: '这个主题目前在讨论什么',
          summary: '',
          status: 'missing',
          items: [],
          sides: [],
          disagreement: { origin: '证据缺失', note: '' },
          gaps: '本轮未能取得可归纳的公开讨论材料。',
        }];
    archive.discussion = {
      scope: {
        window: clipText(rs.frame?.discussionWindow, 120, ''),
        platforms: [],
        languages: ['中文'],
        materialCount: rs.discussionSourceIds.length,
        speakerCount: 0,
        limits: reason || '模型未完成讨论地图生成。',
        checkedAt: rs.nowIso(),
      },
      issues,
      coverage: {
        status: 'missing',
        note: '在本轮可访问范围内，尚不足以归纳公开讨论。',
        limits: reason || '检索材料不足或模型输出不可用。',
      },
    };
    rs.degraded = true;
  }

  function discussionPlatforms(rs, sourceIds) {
    const labels = {
      primary: '官方/一手资料',
      report: '新闻媒体',
      data: '数据',
      analysis: '分析/研究',
      interview: '访谈',
      social: '社交平台',
      other: '其他来源',
    };
    const out = [];
    for (const id of asArray(sourceIds)) {
      const source = asArray(rs.archive.sources).find((item) => item.id === id);
      if (!source) continue;
      const label = labels[source.kind] || '其他来源';
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }

  async function stageDiscussion(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'discussion';
    rs.ui.stage('discussion', STAGE_RANGES.discussion[0], '讨论检索');
    const archive = rs.archive;
    const seeds = asArray(rs.frame?.discussionIssues).slice(0, settings.maxDiscussionIssues);
    const fallbackIssue = { issue: '这个主题目前在讨论什么', queries: [`${archive.topic.title} 讨论 争议`] };
    const planned = seeds.length ? seeds : [fallbackIssue];
    const issueResults = [];
    const allSourceIds = [];
    const failures = [];
    for (let index = 0; index < planned.length; index += 1) {
      rs.ctl.ensureActive();
      const seed = planned[index] || {};
      rs.ui.current(index + 1, planned.length, `检索议题「${clipText(seed.issue, 24)}」`);
      const queries = uniqueStrings([
        ...asArray(seed.queries),
        `${archive.topic.title} ${clipText(seed.issue, 40)}`,
      ]).slice(0, settings.maxDiscussionQueriesPerIssue);
      const hits = await searchQueries(rs, queries, { concurrency: 2 });
      const candidates = rankCandidates(rs, hits, 6);
      const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
      allSourceIds.push(...ids);
      await readSources(rs, ids, Math.min(6, settings.fetchPerQuestion));
      const sourcesPack = packSources(rs, ids);
      let data = null;
      try {
        data = await requestJson(rs, {
          builder: P.buildDiscussionPrompt,
          input: {
            topic: archive.topic,
            query: archive.input.query,
            issues: [{ issue: seed.issue, queries: seed.queries, sourceIds: ids }],
            sources: sourcesPack,
            window: rs.frame?.discussionWindow,
            today: rs.today,
          },
          stage: `讨论地图 ${index + 1}/${planned.length}`,
          maxTokens: Math.min(settings.llmMaxTokens, 6000),
          schemaHint: DISCUSSION_SCHEMA_HINT,
          validate: (value) => {
            if (!value || !Array.isArray(value.issues)) return '缺少 issues 数组';
            return '';
          },
        });
      } catch (error) {
        if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
        data = null;
      }
      if (data && asArray(data.issues).length) {
        for (const issue of asArray(data.issues)) {
          issueResults.push({ ...issue, _sourceIds: ids });
        }
      } else {
        failures.push(clipText(seed.issue, 40));
        issueResults.push({
          question: clipText(seed.issue, 200, '这个主题目前在讨论什么'),
          summary: '',
          status: 'missing',
          items: [],
          sides: [],
          disagreement: { origin: '证据缺失', note: '' },
          gaps: '本轮未能取得可归纳的公开讨论材料。',
          _sourceIds: ids,
        });
      }
      rs.ui.stage('discussion', progressOf('discussion', (index + 1) / Math.max(1, planned.length)), `讨论检索 ${index + 1}/${planned.length}`);
    }
    const uniqueSources = uniqueIds(allSourceIds);
    rs.discussionSourceIds = uniqueSources;
    const speakers = new Set();
    let itemCount = 0;
    for (const issue of issueResults) {
      for (const item of asArray(issue.items)) {
        itemCount += 1;
        const speaker = clipText(item.speaker, 60);
        if (speaker) speakers.add(speaker);
      }
    }
    const coveredCount = issueResults.filter((issue) => issue.status === 'covered' || asArray(issue.items).length > 0).length;
    const status = coveredCount === 0 ? 'missing' : coveredCount === issueResults.length ? 'covered' : 'partial';
    const limits = failures.length
      ? `以下议题的模型整理失败，只保留检索来源与覆盖限制：${failures.join('、')}。`
      : '';
    const data = {
      scope: {
        window: clipText(rs.frame?.discussionWindow, 120),
        platforms: [],
        languages: ['中文'],
        limits,
        materialCount: uniqueSources.length,
        speakerCount: speakers.size,
      },
      issues: issueResults.map((issue) => {
        const { _sourceIds, ...rest } = issue;
        return rest;
      }),
      coverage: {
        status,
        note: itemCount
          ? `本次查阅的讨论中，整理出 ${issueResults.length} 个议题、${itemCount} 条可指认材料。`
          : '在本轮可访问范围内，尚不足以归纳公开讨论。',
        limits,
      },
    };
    if (issueResults.length) {
      M.applyDiscussion(archive, data, { sources: archive.sources, now: rs.nowDate() });
      archive.discussion.scope.checkedAt = rs.nowIso();
      archive.discussion.scope.materialCount = uniqueSources.length;
      archive.discussion.scope.speakerCount = speakers.size;
      if (!asArray(archive.discussion.scope.platforms).length) {
        archive.discussion.scope.platforms = discussionPlatforms(rs, uniqueSources);
      }
      await saveArchive(rs);
      rs.ui.log('info', `讨论地图：${issueResults.length} 个议题、${itemCount} 条材料（覆盖 ${status}）`);
    } else {
      fallbackDiscussion(rs, '没有可整理的讨论议题。');
      await saveArchive(rs);
      rs.ui.log('warn', '讨论地图未完成，已保留覆盖限制。');
    }
    rs.ui.stage('discussion', STAGE_RANGES.discussion[1], '讨论地图完成');
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 4：覆盖检查（缺则补查）                                       */
  /* ---------------------------------------------------------------- */

  function coverageDigest(rs) {
    const archive = rs.archive;
    return {
      understanding: {
        status: archive.understanding?.coverage?.status || 'missing',
        blockCount: asArray(archive.understanding?.blocks).length,
        summary: archive.understanding?.summary || '',
        limits: archive.understanding?.coverage?.limits || '',
      },
      discussion: {
        status: archive.discussion?.coverage?.status || 'missing',
        issueCount: asArray(archive.discussion?.issues).length,
        itemCount: asArray(archive.discussion?.issues).reduce((n, issue) => n + asArray(issue.items).length, 0),
        limits: archive.discussion?.coverage?.limits || '',
      },
    };
  }

  async function stageCoverage(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'coverage';
    rs.ui.stage('coverage', STAGE_RANGES.coverage[0], '检查基础与讨论覆盖');
    const archive = rs.archive;
    const sources = packSources(rs, uniqueIds([...rs.basicSourceIds, ...rs.discussionSourceIds]));
    let data = null;
    try {
      data = await requestJson(rs, {
        builder: P.buildCoveragePrompt,
        input: { topic: archive.topic, understanding: archive.understanding, discussion: archive.discussion, digest: coverageDigest(rs), sources, today: rs.today },
        stage: '覆盖检查',
        maxTokens: Math.min(settings.llmMaxTokens, 6000),
        schemaHint: COVERAGE_SCHEMA_HINT,
        validate: validateCoverage,
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      data = null;
    }
    if (!data) {
      rs.ui.log('info', '覆盖检查没有返回结构，按现有材料继续；限制已写进模块。');
      await saveArchive(rs);
      return;
    }
    M.applyCoverage(archive, data);
    const supplements = asArray(data.supplementary).slice(0, 3);
    if (!supplements.length) {
      rs.ui.log('info', '覆盖检查通过，进入问题规划。');
      await saveArchive(rs);
      return;
    }
    rs.ui.stage('coverage', STAGE_RANGES.coverage[0] + 2, `补查 ${supplements.length} 个缺口`);
    const basicNewIds = [];
    const discussionNewIds = [];
    for (const item of supplements) {
      const query = clipText(item?.query, 160);
      if (!query) continue;
      const hits = await searchQueries(rs, [query], { concurrency: 1 });
      const candidates = rankCandidates(rs, hits, 4);
      const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
      await readSources(rs, ids, 2);
      if (item.module === 'discussion') discussionNewIds.push(...ids);
      else basicNewIds.push(...ids);
    }
    if (basicNewIds.length) {
      const sourcesPack = packSources(rs, uniqueIds(basicNewIds));
      const supplement = await requestJson(rs, {
        builder: P.buildSupplementPrompt,
        input: { topic: archive.topic, module: 'basics', sources: sourcesPack, existing: archive.understanding, today: rs.today },
        stage: '基础补查',
        maxTokens: Math.min(settings.llmMaxTokens, 8000),
        schemaHint: SUPPLEMENT_SCHEMA_HINT,
        validate: () => '',
      }).catch((error) => {
        if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
        return null;
      });
      if (supplement) {
        M.applySupplement(archive, supplement, { sources: archive.sources, module: 'basics', now: rs.nowDate() });
        rs.ui.log('info', `基础补查：新增 ${asArray(supplement.blocks).length} 块`);
      } else {
        rs.ui.log('warn', '基础补查没有返回可用内容，保留覆盖限制。');
      }
    }
    if (discussionNewIds.length) {
      const sourcesPack = packSources(rs, uniqueIds(discussionNewIds));
      const supplement = await requestJson(rs, {
        builder: P.buildSupplementPrompt,
        input: { topic: archive.topic, module: 'discussion', sources: sourcesPack, existing: archive.discussion, today: rs.today },
        stage: '讨论补查',
        maxTokens: Math.min(settings.llmMaxTokens, 8000),
        schemaHint: SUPPLEMENT_SCHEMA_HINT,
        validate: () => '',
      }).catch((error) => {
        if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
        return null;
      });
      if (supplement) {
        M.applySupplement(archive, supplement, { sources: archive.sources, module: 'discussion', now: rs.nowDate() });
        rs.ui.log('info', `讨论补查：新增 ${asArray(supplement.items).length} 条材料`);
      } else {
        rs.ui.log('warn', '讨论补查没有返回可用内容，保留覆盖限制。');
      }
    }
    await saveArchive(rs);
    rs.ui.stage('coverage', STAGE_RANGES.coverage[1], '覆盖检查完成');
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 5：问题规划                                                  */
  /* ---------------------------------------------------------------- */

  function fallbackPlan(rs) {
    const title = clipText(rs.archive.topic.title || rs.archive.input.query, 60);
    return {
      questions: [
        {
          question: `${title} 解决什么问题，替代了旧流程里的哪一步？`,
          why: '先确定它改变的环节，才知道用什么尺子衡量。',
          role: 'definition',
          priority: 'high',
          evidenceNeed: '官方说明、产品文档或可复现的独立测试',
          queries: [`${title} 是什么 解决什么问题`, `${title} 替代 传统方式`],
          relation: { to: null, kind: 'opens', note: '从品类边界开始' },
        },
        {
          question: `它靠什么机制产生结果，关键环节与瓶颈在哪？`,
          why: '机制决定上限，也决定出问题时应先查哪一环。',
          role: 'mechanism',
          priority: 'high',
          evidenceNeed: '技术文档、架构说明或独立拆解',
          queries: [`${title} 原理 机制`, `${title} 技术 架构 瓶颈`],
          relation: { to: 'q1', kind: 'deepens', note: '从是什么进入怎么做到' },
        },
        {
          question: `哪些证据会改变我们对它的判断，现在还缺什么？`,
          why: '给这份档案留一个可更新的把手，避免一次性结论。',
          role: 'uncertainty',
          priority: 'medium',
          evidenceNeed: '最新的独立测试、争议报道或反例',
          queries: [`${title} 争议 风险 数据`, `${title} 最新 进展`],
          relation: { to: 'q2', kind: 'closes', note: '把不确定性收敛成可追踪的信号' },
        },
      ],
    };
  }

  async function stagePlanning(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'planning';
    rs.ui.stage('planning', STAGE_RANGES.planning[0], '规划深度问题');
    const archive = rs.archive;
    const depth = archive.input.depth === 'quick' ? 'quick' : 'deep';
    const maxForDepth = depth === 'quick'
      ? Math.min(4, Math.max(1, settings.quickQuestions), Math.max(1, settings.maxQuestions))
      : Math.min(6, Math.max(1, settings.maxQuestions));
    const count = depth === 'quick' ? Math.min(4, maxForDepth) : Math.min(5, maxForDepth);
    const minQuestions = depth === 'quick' ? Math.min(3, count) : Math.min(4, count);
    const sourceDigest = asArray(archive.sources)
      .slice(0, 16)
      .map((source) => `[${source.id}] ${clipText(source.title, 80)}（${source.publisher || M.hostOf(source.url) || ''}）`)
      .join('\n');
    let data = null;
    try {
      data = await requestJson(rs, {
        builder: P.buildPlanningPrompt,
        input: {
          topic: archive.topic,
          understanding: archive.understanding,
          discussion: archive.discussion,
          sourceDigest,
          depth,
          count,
          today: rs.today,
        },
        stage: '问题规划',
        maxTokens: Math.min(settings.llmMaxTokens, 8000),
        schemaHint: PLANNING_SCHEMA_HINT,
        validate: (value) => validatePlanning(value, minQuestions),
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      data = null;
    }
    if (!data) {
      data = fallbackPlan(rs);
      rs.degraded = true;
      rs.ui.log('warn', '问题规划未拿到可用输出，使用通用骨架（3 个问题）。');
    }
    M.applyPlanning(archive, data);
    if (archive.questions.length > maxForDepth) archive.questions = archive.questions.slice(0, maxForDepth);
    if (!archive.questions.length) {
      M.applyPlanning(archive, fallbackPlan(rs));
      rs.degraded = true;
    }
    await saveArchive(rs);
    rs.ui.log('info', `深度问题 ${archive.questions.length} 个：${archive.questions.map((question) => question.id).join('、')}`);
    rs.ui.stage('planning', STAGE_RANGES.planning[1], '问题规划完成');
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 6：定向深搜                                                  */
  /* ---------------------------------------------------------------- */

  function markQuestionFailed(rs, question, reason) {
    question.workStatus = 'partial';
    question.status = 'partial';
    question.coverage = 'no-evidence';
    question.confidence = 'low';
    if (!question.summary) question.summary = '现有材料不足，未能形成结论。';
    question.gaps.push({
      text: `该问题研究未完成：${reason}。`,
      whyItMatters: '这一问题没有形成结论，整份档案在这条线上不完整。',
      howToClose: '补充检索后重跑该问题（追问或刷新）。',
    });
    rs.degraded = true;
    rs.ui.log('warn', `${question.id} 研究未完成：${reason}`);
  }

  async function researchOneQuestion(rs, question) {
    rs.ctl.ensureActive();
    const archive = rs.archive;
    const fallbackQuery = clipText(`${archive.topic.title} ${question.question}`, 160);
    let queries = uniqueStrings([...asArray(question.queries), fallbackQuery]).slice(0, Math.max(1, settings.searchesPerQuestion));
    if (!queries.length) queries = [fallbackQuery];
    question.workStatus = 'researching';
    question.status = 'researching';
    const hits = await searchQueries(rs, queries, { concurrency: 2 });
    let candidates = rankCandidates(rs, hits, settings.maxSourcesPerQuestion);
    if (!candidates.length) {
      const retry = await searchQueries(rs, [fallbackQuery], { concurrency: 1 });
      candidates = rankCandidates(rs, retry, settings.maxSourcesPerQuestion);
    }
    const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
    rs.questionSources.set(question.id, ids);
    if (!ids.length) {
      markQuestionFailed(rs, question, '没有可用的检索来源');
      return;
    }
    await readSources(rs, ids, settings.fetchPerQuestion);
    const sources = packSources(rs, ids);
    let unit = null;
    try {
      unit = await requestJson(rs, {
        builder: P.buildResearchPrompt,
        input: {
          topic: archive.topic,
          question,
          sources,
          today: rs.today,
        },
        stage: `定向深搜 ${question.id}`,
        maxTokens: Math.min(settings.llmMaxTokens, 10000),
        schemaHint: RESEARCH_SCHEMA_HINT,
        validate: validateResearch,
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      unit = null;
    }
    if (!unit) {
      markQuestionFailed(rs, question, '模型没有返回可用的研究单元');
      return;
    }
    try {
      M.mergeResearchUnit(archive, question.id, unit, { sources: archive.sources, now: rs.nowDate() });
    } catch (error) {
      rs.ui.log('error', `合并研究单元失败 ${question.id}：${clipText(messageOf(error), 200)}`);
      markQuestionFailed(rs, question, '研究单元合并失败');
      return;
    }
    if (!asArray(archive.claims).some((claim) => asArray(claim.questionIds).includes(question.id))) {
      markQuestionFailed(rs, question, '没有形成可核查的论断');
      return;
    }
    question.workStatus = 'done';
    question.status = 'done';
    rs.ui.log('info', `${question.id} 完成：${asArray(archive.claims).filter((claim) => asArray(claim.questionIds).includes(question.id)).length} 条论断 / ${ids.length} 条来源`);
  }

  async function stageResearching(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'researching';
    rs.ui.stage('researching', STAGE_RANGES.researching[0], '定向深搜');
    const questions = asArray(rs.archive.questions);
    const total = Math.max(1, questions.length);
    let done = 0;
    const bump = () => {
      done += 1;
      rs.ui.stage('researching', progressOf('researching', done / total), `定向深搜 ${done}/${total}`);
    };
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(settings.maxResearchConcurrency, questions.length));
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          rs.ctl.ensureActive();
          const index = cursor;
          cursor += 1;
          if (index >= questions.length) return;
          const question = questions[index];
          try {
            await researchOneQuestion(rs, question);
          } catch (error) {
            if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
            markQuestionFailed(rs, question, clipText(messageOf(error), 120));
          }
          bump();
        }
      }),
    );
    await saveArchive(rs);
    rs.ui.log('info', `深搜完成：${questions.filter((question) => question.workStatus === 'done').length}/${total} 个问题完成`);
  }

  /** 给提示词的题目包：把全局 claims/evidence 按问题挂回去。 */
  function hydrateQuestions(archive) {
    const claims = asArray(archive.claims);
    const evidence = asArray(archive.evidence);
    return asArray(archive.questions).map((question) => {
      const claimIds = new Set(asArray(question.claimIds));
      const evidenceIds = new Set(asArray(question.evidenceIds));
      return {
        ...question,
        claims: claims.filter((claim) => claimIds.has(claim.id) || asArray(claim.questionIds).includes(question.id)),
        evidence: evidence.filter((item) => evidenceIds.has(item.id) || item.questionId === question.id),
      };
    });
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 7：证据核查（补反证）                                        */
  /* ---------------------------------------------------------------- */

  function counterQueries(question, title) {
    const core = clipText(question.question, 80);
    return uniqueStrings([
      `${title} ${core} 反例 争议 批评`,
      `${title} ${core} 限制 失败 风险`,
    ]).slice(0, 2);
  }

  async function stageVerifying(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'verifying';
    rs.ui.stage('verifying', STAGE_RANGES.verifying[0], '补查反证与争议');
    const archive = rs.archive;
    const newSourceIds = [];
    const questions = asArray(archive.questions);
    for (let index = 0; index < questions.length; index += 1) {
      rs.ctl.ensureActive();
      const question = questions[index];
      if (question.workStatus === 'failed') continue;
      rs.ui.current(index + 1, questions.length, `核查「${clipText(question.question, 22)}」`);
      const queries = counterQueries(question, archive.topic.title);
      const hits = await searchQueries(rs, queries, { concurrency: 2 });
      const candidates = rankCandidates(rs, hits, 4);
      const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
      await readSources(rs, ids, 3);
      rs.verificationSources.set(question.id, ids);
      newSourceIds.push(...ids);
    }
    const sources = packSources(rs, uniqueIds(newSourceIds));
    if (!sources.length) {
      rs.ui.log('info', '反证检索没有新增来源；按现有证据核查。');
    }
    let data = null;
    try {
      data = await requestJson(rs, {
        builder: P.buildVerificationPrompt,
        input: { topic: archive.topic, questions: hydrateQuestions(archive), sources, today: rs.today },
        stage: '证据核查',
        maxTokens: Math.min(settings.llmMaxTokens, 10000),
        schemaHint: VERIFICATION_SCHEMA_HINT,
        validate: validateVerification,
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      data = null;
    }
    if (data) {
      M.applyVerification(archive, data, { sources: archive.sources, now: rs.nowDate() });
      await saveArchive(rs);
      rs.ui.log('info', `证据核查：更新 ${asArray(data.updates).length} 个问题的证据状态`);
    } else {
      rs.degraded = true;
      rs.ui.log('warn', '证据核查没有返回结构，按现有证据状态继续。');
    }
    rs.ui.stage('verifying', STAGE_RANGES.verifying[1], '核查完成');
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 8：形成判断                                                  */
  /* ---------------------------------------------------------------- */

  function fallbackJudgments(archive) {
    const claims = asArray(archive.claims).filter((claim) => claim.identity !== 'unknown' && asArray(claim.evidenceIds).length);
    const ranked = claims
      .slice()
      .sort((a, b) => {
        const weight = { supported: 3, limited: 2, conflicted: 1, unsupported: 0 };
        return (weight[b.evidenceStatus] || 0) - (weight[a.evidenceStatus] || 0);
      })
      .slice(0, 5);
    return ranked.map((claim, index) => ({
      id: `j${index + 1}`,
      text: claim.statement,
      identity: claim.identity,
      confidence: claim.confidence,
      conditions: claim.conditions || '',
      claimIds: [claim.id],
    }));
  }

  function fallbackUnknowns(archive) {
    const unknowns = [];
    for (const question of asArray(archive.questions)) {
      for (const gap of asArray(question.gaps)) {
        if (unknowns.length >= 5) break;
        unknowns.push({
          text: gap.text,
          whyItMatters: gap.whyItMatters,
          howToClose: gap.howToClose,
          questionId: question.id,
        });
      }
    }
    return unknowns;
  }

  function fallbackBranches(archive) {
    const branches = [];
    for (const question of asArray(archive.questions)) {
      for (const branch of asArray(question.branches)) {
        branches.push({ ...branch, questionId: question.id });
      }
      for (const gap of asArray(question.gaps)) {
        if (branches.length >= 8) break;
        branches.push({
          text: gap.howToClose || gap.text,
          hook: gap.whyItMatters || '补上可能改变这个问题的判断',
          priority: question.priority || 'medium',
          questionId: question.id,
        });
      }
    }
    return branches.slice(0, 8);
  }

  /** synthesis 的 sourceRoles 直接写回来源（模型判定独立性，程序校验枚举）。 */
  function applySourceRoles(archive, data) {
    const roles = asArray(data?.sourceRoles);
    if (!roles.length) return;
    const byId = new Map(asArray(archive.sources).map((source) => [source.id, source]));
    const independence = ['primary', 'independent', 'syndicated', 'unknown'];
    const kinds = ['primary', 'report', 'data', 'analysis', 'interview', 'social', 'other'];
    const reliability = ['high', 'medium', 'low'];
    let applied = 0;
    for (const raw of roles) {
      if (!raw || typeof raw !== 'object') continue;
      const source = byId.get(String(raw.sourceId || ''));
      if (!source) continue;
      if (independence.includes(raw.independence)) source.independence = raw.independence;
      if (kinds.includes(raw.kind)) source.kind = raw.kind;
      if (reliability.includes(raw.reliability)) source.reliability = raw.reliability;
      applied += 1;
    }
    return applied;
  }

  async function stageSynthesizing(rs) {
    rs.ctl.ensureActive();
    rs.stage = 'synthesizing';
    rs.ui.stage('synthesizing', STAGE_RANGES.synthesizing[0], '形成判断');
    const archive = rs.archive;
    let data = null;
    try {
      data = await requestJson(rs, {
        builder: P.buildSynthesisPrompt,
        input: {
          topic: archive.topic,
          understanding: archive.understanding,
          discussion: archive.discussion,
          questions: hydrateQuestions(archive),
          claims: archive.claims,
          sources: packSources(rs, uniqueIds(asArray(archive.evidence).flatMap((item) => asArray(item.sourceIds)))).slice(0, 40),
          today: rs.today,
        },
        stage: '形成判断',
        maxTokens: settings.llmMaxTokens,
        schemaHint: SYNTHESIS_SCHEMA_HINT,
        validate: validateSynthesis,
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      data = null;
    }
    if (data) {
      M.applySynthesis(archive, data);
      const roleCount = applySourceRoles(archive, data);
      if (roleCount) rs.ui.log('info', `来源独立性：已标注 ${roleCount} 条`);
      rs.ui.log('info', `判断 ${asArray(archive.judgments).length} 条、未知 ${asArray(archive.unknowns).length} 个、下一步 ${asArray(archive.branches).length} 条`);
    } else {
      rs.degraded = true;
      const fallback = {
        judgments: fallbackJudgments(archive),
        unknowns: fallbackUnknowns(archive),
        branches: fallbackBranches(archive),
        connections: [],
      };
      M.applySynthesis(archive, fallback);
      rs.ui.log('warn', '综合未拿到可用输出，用程序兜底生成判断与下一步。');
    }
    await saveArchive(rs);
    rs.ui.stage('synthesizing', STAGE_RANGES.synthesizing[1], '判断完成');
  }

  /* ---------------------------------------------------------------- */
  /* 阶段 9：校验与写盘                                                */
  /* ---------------------------------------------------------------- */

  function ensureModules(archive) {
    if (!archive.understanding || typeof archive.understanding !== 'object') {
      archive.understanding = {
        status: 'empty',
        summary: '',
        blocks: [],
        entities: [],
        confusables: [],
        timeline: [],
        coverage: { status: 'missing', note: '本次运行没有完成基础认识。', limits: '' },
      };
    }
    if (!archive.discussion || typeof archive.discussion !== 'object') {
      archive.discussion = {
        scope: { window: '', platforms: [], languages: [], materialCount: 0, speakerCount: 0, limits: '', checkedAt: '' },
        issues: [],
        coverage: { status: 'missing', note: '本次运行没有完成讨论地图。', limits: '' },
      };
    }
    if (!asArray(archive.understanding.blocks).length && archive.understanding.coverage?.status !== 'missing') {
      archive.understanding.coverage = {
        ...(archive.understanding.coverage || {}),
        status: 'missing',
        note: archive.understanding.coverage?.note || '本次运行没有产出可读的基础认识。',
      };
    }
    if (!asArray(archive.discussion.issues).length && archive.discussion.coverage?.status !== 'missing') {
      archive.discussion.coverage = {
        ...(archive.discussion.coverage || {}),
        status: 'missing',
        note: archive.discussion.coverage?.note || '在本轮可访问范围内，尚不足以归纳公开讨论。',
      };
    }
  }

  function enforceInvariants(archive) {
    const sourceIds = new Set(asArray(archive.sources).map((source) => source.id));
    archive.claims = asArray(archive.claims).filter((claim) => {
      if (!claim || !claim.id || !claim.statement) return false;
      claim.evidenceIds = uniqueIds(asArray(claim.evidenceIds)).filter((id) => asArray(archive.evidence).some((ev) => ev.id === id));
      claim.opposeEvidenceIds = uniqueIds(asArray(claim.opposeEvidenceIds)).filter((id) => asArray(archive.evidence).some((ev) => ev.id === id));
      if ((claim.identity === 'fact' || claim.identity === 'claim') && !claim.evidenceIds.length) {
        claim.identity = 'analysis';
        claim.confidence = 'low';
        claim.basis = clipText(`${claim.basis || ''}${claim.basis ? '；' : ''}缺少可引用证据，已降级为分析。`, 800);
      }
      return true;
    });
    const claimIds = new Set(archive.claims.map((claim) => claim.id));
    archive.evidence = asArray(archive.evidence).filter((evidence) => {
      if (!evidence || !evidence.id) return false;
      evidence.sourceIds = uniqueIds(asArray(evidence.sourceIds)).filter((id) => sourceIds.has(id));
      return evidence.sourceIds.length > 0;
    });
    const evidenceIds = new Set(archive.evidence.map((evidence) => evidence.id));
    for (const claim of archive.claims) {
      claim.evidenceIds = claim.evidenceIds.filter((id) => evidenceIds.has(id));
      claim.opposeEvidenceIds = claim.opposeEvidenceIds.filter((id) => evidenceIds.has(id));
    }
    const questionIds = new Set(asArray(archive.questions).map((question) => question.id));
    for (const question of asArray(archive.questions)) {
      question.claimIds = uniqueIds(asArray(question.claimIds)).filter((id) => claimIds.has(id));
      question.evidenceIds = uniqueIds(asArray(question.evidenceIds)).filter((id) => evidenceIds.has(id));
      for (const gap of asArray(question.gaps)) {
        if (!gap.id) gap.id = `g${question.id.replace(/^q/, '')}-${Math.random().toString(36).slice(2, 6)}`;
      }
    }
    for (const issue of asArray(archive.discussion?.issues)) {
      for (const item of asArray(issue.items)) {
        item.claimIds = uniqueIds(asArray(item.claimIds)).filter((id) => claimIds.has(id));
        item.evidenceIds = uniqueIds(asArray(item.evidenceIds)).filter((id) => evidenceIds.has(id));
      }
    }
    for (const block of asArray(archive.understanding?.blocks)) {
      block.claimIds = uniqueIds(asArray(block.claimIds)).filter((id) => claimIds.has(id));
      block.evidenceIds = uniqueIds(asArray(block.evidenceIds)).filter((id) => evidenceIds.has(id));
    }
    archive.judgments = asArray(archive.judgments).filter((judgment) => {
      judgment.claimIds = uniqueIds(asArray(judgment.claimIds)).filter((id) => claimIds.has(id));
      return judgment.claimIds.length > 0 && Boolean(judgment.text);
    });
    archive.unknowns = asArray(archive.unknowns).filter((unknown) => Boolean(unknown && unknown.text));
    archive.branches = asArray(archive.branches).filter((branch) => Boolean(branch && branch.text));
    archive.connections = asArray(archive.connections).filter((connection) => {
      connection.claimIds = uniqueIds(asArray(connection.claimIds)).filter((id) => claimIds.has(id));
      connection.sourceIds = uniqueIds(asArray(connection.sourceIds)).filter((id) => sourceIds.has(id));
      return Boolean(connection.to && connection.mechanism);
    });
    for (const source of asArray(archive.sources)) source.usedFor = [];
    return questionIds;
  }

  function revisionSummary(rs, kind) {
    if (kind !== 'initial' && rs.revisionSummaryText) return M.clampText(rs.revisionSummaryText, 800);
    const archive = rs.archive;
    const understanding = asArray(archive.understanding?.blocks).length;
    const issues = asArray(archive.discussion?.issues).length;
    const items = asArray(archive.discussion?.issues).reduce((n, issue) => n + asArray(issue.items).length, 0);
    const degraded = archive.status === 'partial' ? '部分模块未完成。' : '';
    return M.clampText(
      `首轮研究：基础认识 ${understanding} 块、讨论 ${issues} 个议题（${items} 条材料）、深度问题 ${asArray(archive.questions).length} 个、论断 ${asArray(archive.claims).length} 条、来源 ${asArray(archive.sources).length} 条。${degraded}`,
      800,
    );
  }

  async function stageLinking(rs, { revisionKind = 'initial' } = {}) {
    if (rs.ctl.signal.aborted && !rs.ctl.isTimedOut()) throw abortError(rs, null);
    rs.stage = 'linking';
    rs.ui.stage('linking', STAGE_RANGES.linking[0], '校验引用与写盘');
    const archive = rs.archive;
    ensureModules(archive);
    enforceInvariants(archive);
    commitStats(rs);
    M.recount(archive);
    let validation = M.validateArchive(archive);
    if (validation.errors.length) {
      rs.ui.log('error', `校验仍有 ${validation.errors.length} 个错误：${validation.errors.slice(0, 5).join('；')}`);
      enforceInvariants(archive);
      M.recount(archive);
      validation = M.validateArchive(archive);
      if (validation.errors.length) {
        rs.degraded = true;
        rs.ui.log('error', `兜底后仍有 ${validation.errors.length} 个错误：${validation.errors.slice(0, 5).join('；')}`);
      }
    }
    for (const warning of validation.warnings.slice(0, 20)) rs.ui.log('warn', `校验：${warning}`);
    archive.status = rs.degraded || validation.errors.length ? 'partial' : 'done';
    archive.updatedAt = rs.nowIso();
    const summary = revisionSummary(rs, revisionKind);
    archive.revisions.push({
      id: M.newRevisionId ? M.newRevisionId() : `r${Date.now().toString(36)}`,
      at: archive.updatedAt,
      kind: revisionKind,
      summary,
      questionIds: asArray(archive.questions).map((question) => question.id),
    });
    rs.revisionAdded = true;
    rs.ui.stage('linking', 98, '写入档案');
    await saveArchive(rs);
    rs.ui.stage('done', 100, '已完成');
    rs.ui.log('info', `档案${archive.status === 'done' ? '已完成' : '已按 partial 保存'}：理解 ${asArray(archive.understanding?.blocks).length} 块、讨论 ${asArray(archive.discussion?.issues).length} 议题、${asArray(archive.questions).length} 问题、${asArray(archive.claims).length} 论断、${asArray(archive.sources).length} 来源、${asArray(archive.judgments).length} 判断`);
  }

  async function finalizePartial(rs, { revisionKind, reason }) {
    if (!rs.archive) return null;
    const archive = rs.archive;
    rs.degraded = true;
    ensureModules(archive);
    try {
      enforceInvariants(archive);
      commitStats(rs);
      M.recount(archive);
    } catch (error) {
      rs.ui.log('error', `超时收尾修复失败：${clipText(messageOf(error), 200)}`);
    }
    archive.status = 'partial';
    archive.updatedAt = rs.nowIso();
    if (!rs.revisionAdded) {
      archive.revisions.push({
        id: M.newRevisionId ? M.newRevisionId() : `r${Date.now().toString(36)}`,
        at: archive.updatedAt,
        kind: revisionKind,
        summary: M.clampText(`${reason}。已完成部分保留：${asArray(archive.sources).length} 条来源、${asArray(archive.claims).length} 条论断。`, 800),
        questionIds: asArray(archive.questions).map((question) => question.id),
      });
      rs.revisionAdded = true;
    }
    try {
      await saveArchive(rs);
    } catch (error) {
      rs.ui.log('error', `超时收尾保存失败：${clipText(messageOf(error), 200)}`);
    }
    rs.ui.stage('done', 100, '已按 partial 结束');
    rs.ui.log('warn', `任务按 partial 结束：${reason}`);
    return archive;
  }

  /* ---------------------------------------------------------------- */
  /* 追问 / 刷新辅助                                                   */
  /* ---------------------------------------------------------------- */

  function existingSummaryOf(archive) {
    const lines = [];
    lines.push(`基础认识：${clipText(archive.understanding?.summary, 300) || '（未完成）'}`);
    for (const block of asArray(archive.understanding?.blocks).slice(0, 6)) {
      lines.push(`- ${clipText(block.title, 40)}：${clipText(block.text, 220)}`);
    }
    const issues = asArray(archive.discussion?.issues).slice(0, 6);
    if (issues.length) {
      lines.push('讨论议题：');
      for (const issue of issues) {
        lines.push(`- [${issue.id}] ${clipText(issue.question, 100)}（${clipText(issue.summary, 160)}）`);
      }
    }
    for (const question of asArray(archive.questions)) {
      lines.push(`[${question.id}] ${clipText(question.question, 160)}：${clipText(question.summary, 160)}`);
    }
    return clipText(lines.join('\n'), 6000);
  }

  function existingForFollowup(archive, mode, targetId) {
    if (mode === 'basics') return archive.understanding;
    if (mode === 'discussion') {
      const target = asArray(archive.discussion?.issues).find((issue) => issue.id === targetId);
      return target || archive.discussion;
    }
    if (mode === 'question' || mode === 'new-question') {
      const target = asArray(archive.questions).find((question) => question.id === targetId);
      if (!target) return null;
      return {
        id: target.id,
        question: target.question,
        summary: target.summary,
        claims: asArray(archive.claims).filter((claim) => asArray(claim.questionIds).includes(target.id)),
        evidence: asArray(archive.evidence).filter((evidence) => evidence.questionId === target.id),
      };
    }
    return null;
  }

  function collectBranches(archive) {
    const list = asArray(archive.branches).filter((branch) => branch && branch.text && branch.status !== 'answered');
    for (const question of asArray(archive.questions)) {
      for (const branch of asArray(question.branches)) {
        if (branch && branch.text && branch.status !== 'answered') list.push({ ...branch, questionId: question.id });
      }
    }
    return list.slice(0, 10);
  }

  function markAnsweredBranches(archive, ask, questionId) {
    const target = String(ask || '').trim().toLowerCase();
    if (!target) return;
    for (const branch of asArray(archive.branches)) {
      if (!branch || branch.status === 'answered' || !branch.text) continue;
      const text = String(branch.text).trim().toLowerCase();
      if (text && (text.includes(target) || target.includes(text))) {
        branch.status = 'answered';
        branch.answeredBy = questionId || '';
      }
    }
  }

  function affectedJudgments(archive, affectedClaimIds) {
    const ids = new Set(affectedClaimIds);
    if (!ids.size) return asArray(archive.judgments);
    return asArray(archive.judgments).filter((judgment) => asArray(judgment.claimIds).some((id) => ids.has(id)));
  }

  async function patchJudgments(rs, { claimIds, sources, revisionNote }) {
    const archive = rs.archive;
    const list = affectedJudgments(archive, claimIds);
    if (!list.length) return;
    let data = null;
    try {
      data = await requestJson(rs, {
        builder: P.buildJudgmentPatchPrompt,
        input: {
          topic: archive.topic,
          judgments: list,
          claims: asArray(archive.claims).filter((claim) => list.some((judgment) => asArray(judgment.claimIds).includes(claim.id))),
          sources,
          today: rs.today,
        },
        stage: '局部更新判断',
        maxTokens: Math.min(settings.llmMaxTokens, 8000),
        schemaHint: JUDGMENT_PATCH_SCHEMA_HINT,
        validate: () => '',
      });
    } catch (error) {
      if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
      data = null;
    }
    if (data) {
      M.applyJudgmentPatch(archive, data, { now: rs.nowDate() });
      rs.revisionSummaryText = data.revisionNote || revisionNote || rs.revisionSummaryText;
      rs.ui.log('info', '依赖判断已局部更新。');
    } else {
      rs.ui.log('warn', '依赖判断未更新，旧判断保留。');
    }
  }

  /* ---------------------------------------------------------------- */
  /* 入口 1：首轮研究                                                  */
  /* ---------------------------------------------------------------- */

  async function runInitial(job, signal, { topicId } = {}) {
    const rs = createRun({ job, signal, topicId, kind: 'initial' });
    try {
      await loadArchive(rs);
      if (!rs.archive) {
        const query = job?.input?.query || job?.query || job?.title || '未命名主题';
        rs.archive = M.emptyArchive({ query, now: rs.nowDate() });
        if (topicId) rs.archive.id = topicId;
        rs.baseStats = { ...rs.archive.stats };
        rs.ui.log('warn', '档案不存在，按任务输入创建新档案');
      }
      rs.archive.status = 'running';
      await stageFraming(rs);
      await stageBasics(rs);
      await stageDiscussion(rs);
      await stageCoverage(rs);
      await stagePlanning(rs);
      await stageResearching(rs);
      await stageVerifying(rs);
      await stageSynthesizing(rs);
      await stageLinking(rs, { revisionKind: 'initial' });
      return rs.archive;
    } catch (error) {
      if (isAbortLike(error, rs)) {
        if (rs.ctl.isTimedOut()) {
          await finalizePartial(rs, {
            revisionKind: 'initial',
            reason: `任务超时（${settings.jobTimeoutMs}ms），在「${STAGE_LABELS[rs.stage] || rs.stage}」阶段中止`,
          });
          return rs.archive;
        }
        rs.ui.log('warn', '任务已取消，未写入新的内容');
        throw abortError(rs, error);
      }
      rs.ui.log('error', `任务失败：${clipText(messageOf(error), 300)}`);
      if (rs.archive) {
        rs.archive.status = 'failed';
        rs.archive.updatedAt = rs.nowIso();
        try {
          commitStats(rs);
          await saveArchive(rs);
        } catch (saveError) {
          rs.ui.log('error', `失败状态写入失败：${clipText(messageOf(saveError), 200)}`);
        }
      }
      throw error;
    } finally {
      rs.ctl.dispose();
    }
  }

  /* ---------------------------------------------------------------- */
  /* 入口 2：追问                                                      */
  /* ---------------------------------------------------------------- */

  async function runFollowup(job, signal, { topicId, question } = {}) {
    const rs = createRun({ job, signal, topicId, kind: 'followup' });
    try {
      await loadArchive(rs);
      if (!rs.archive) throw new Error(`档案不存在：${topicId}`);
      const archive = rs.archive;
      const ask = clipText(question, 500);
      if (!ask) throw new Error('追问内容为空');

      rs.stage = 'framing';
      rs.ui.stage('framing', STAGE_RANGES.framing[0], '判断追问方向');
      let plan = null;
      try {
        plan = await requestJson(rs, {
          builder: P.buildFollowupPlanPrompt,
          input: {
            topic: archive.topic,
            question: ask,
            existingSummary: existingSummaryOf(archive),
            branches: collectBranches(archive),
          },
          stage: '追问计划',
          maxTokens: Math.min(settings.llmMaxTokens, 6000),
          schemaHint: PLAN_SCHEMA_HINT,
          validate: validatePlan,
        });
      } catch (error) {
        if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
        plan = null;
      }
      let mode = plan && ['basics', 'discussion', 'question', 'new-question'].includes(plan.mode) ? plan.mode : 'question';
      let targetId = clipText(plan?.targetId, 20);
      if (mode === 'question' && !asArray(archive.questions).some((item) => item.id === targetId)) {
        targetId = asArray(archive.questions)[asArray(archive.questions).length - 1]?.id || '';
        if (!targetId) mode = 'new-question';
        else rs.ui.log('warn', '追问归并未命中具体问题，默认并入最后一个问题');
      }
      if (mode === 'discussion' && !asArray(archive.discussion?.issues).some((issue) => issue.id === targetId)) {
        targetId = asArray(archive.discussion?.issues)[0]?.id || '';
        if (!targetId) mode = 'basics';
      }
      rs.ui.log('info', `追问模式：${mode}${targetId ? ` → ${targetId}` : ''}`);

      rs.stage = 'basics';
      await ensureSearchAvailable(rs);
      rs.ui.stage('basics', STAGE_RANGES.basics[0], '检索追问材料');
      const queries = uniqueStrings([
        ...asArray(plan?.queries),
        ask,
        `${archive.topic.title} ${ask}`,
      ]).slice(0, Math.max(1, settings.searchesPerQuestion));
      const rawHits = await searchQueries(rs, queries, { concurrency: 2 });
      const candidates = rankCandidates(rs, rawHits, settings.maxSourcesPerQuestion);
      const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
      await readSources(rs, ids, settings.fetchPerQuestion);
      const sources = packSources(rs, ids);
      rs.ui.log('info', `追问检索：${ids.length} 条来源`);

      rs.stage = 'researching';
      rs.ui.stage('researching', 50, '回答追问');
      let unit = null;
      try {
        unit = await requestJson(rs, {
          builder: P.buildFollowupResearchPrompt,
          input: {
            topic: archive.topic,
            question: ask,
            plan: { ...(plan || {}), mode, targetId },
            sources,
            existing: existingForFollowup(archive, mode, targetId),
            today: rs.today,
          },
          stage: '追问研究',
          maxTokens: Math.min(settings.llmMaxTokens, 9000),
          schemaHint: FOLLOWUP_SCHEMA_HINT,
          validate: validateFollowup,
        });
      } catch (error) {
        if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
        unit = null;
      }
      if (!unit) {
        rs.degraded = true;
        rs.revisionSummaryText = `追问未完成：模型没有返回可用内容（${clipText(ask, 80)}）`;
        const target = asArray(archive.questions).find((item) => item.id === targetId);
        if (target && (mode === 'question' || mode === 'new-question')) markQuestionFailed(rs, target, '追问没有产出可用研究单元');
        await stageLinking(rs, { revisionKind: 'followup' });
        return archive;
      }
      const beforeClaimIds = new Set(asArray(archive.claims).map((claim) => claim.id));
      const applied = M.applyFollowup(archive, { mode, targetId, unit }, { sources: archive.sources, now: rs.nowDate() });
      const affected = uniqueIds(asArray(unit.affectedClaimIds).concat(asArray(applied?.affectedClaimIds)));
      const freshClaims = asArray(archive.claims).filter((claim) => !beforeClaimIds.has(claim.id));
      if (affected.length && freshClaims.length) {
        for (const claim of asArray(archive.claims)) {
          if (affected.includes(claim.id) && !claim.supersededBy) claim.supersededBy = freshClaims[0].id;
        }
      }
      markAnsweredBranches(archive, ask, targetId);
      const revisionNote = clipText(unit.revisionNote, 300) || `追问：${clipText(ask, 80)}`;
      rs.revisionSummaryText = revisionNote;
      if (affected.length) {
        await patchJudgments(rs, { claimIds: affected, sources, revisionNote });
      }
      await stageLinking(rs, { revisionKind: 'followup' });
      return archive;
    } catch (error) {
      if (isAbortLike(error, rs)) {
        if (rs.ctl.isTimedOut()) {
          await finalizePartial(rs, { revisionKind: 'followup', reason: `追问超时（${settings.jobTimeoutMs}ms）` });
          return rs.archive;
        }
        rs.ui.log('warn', '追问已取消，未写入新的内容');
        throw abortError(rs, error);
      }
      rs.ui.log('error', `追问失败：${clipText(messageOf(error), 300)}`);
      throw error;
    } finally {
      rs.ctl.dispose();
    }
  }

  /* ---------------------------------------------------------------- */
  /* 入口 3：刷新                                                      */
  /* ---------------------------------------------------------------- */

  async function runRefresh(job, signal, { topicId } = {}) {
    const rs = createRun({ job, signal, topicId, kind: 'refresh' });
    try {
      await loadArchive(rs);
      if (!rs.archive) throw new Error(`档案不存在：${topicId}`);
      const archive = rs.archive;
      if (!asArray(archive.questions).length) throw new Error('档案还没有问题，无法刷新');

      rs.stage = 'basics';
      await ensureSearchAvailable(rs);
      rs.ui.stage('basics', STAGE_RANGES.basics[0], '重新检索');
      const total = Math.max(1, archive.questions.length);
      const newByQuestion = new Map();
      for (let index = 0; index < archive.questions.length; index += 1) {
        rs.ctl.ensureActive();
        const question = archive.questions[index];
        rs.ui.current(index + 1, total, `刷新检索「${clipText(question.question, 24)}」`);
        const year = String(rs.nowDate().getFullYear());
        const queries = uniqueStrings([
          ...asArray(question.queries).slice(0, Math.max(1, settings.searchesPerQuestion - 1)),
          `${clipText(question.question, 100)} ${year} 最新进展`,
        ]).slice(0, Math.max(1, settings.searchesPerQuestion));
        const before = new Set(archive.sources.map((source) => source.id));
        const hits = await searchQueries(rs, queries, { concurrency: 2 });
        const candidates = rankCandidates(rs, hits, settings.maxSourcesPerQuestion);
        const ids = uniqueIds(candidates.map((hit) => ensureSource(rs, hit)));
        const fresh = ids.filter((id) => !before.has(id));
        newByQuestion.set(question.id, fresh);
        rs.questionSources.set(question.id, ids);
        await readSources(rs, fresh, 2);
      }
      rs.stage = 'verifying';
      rs.ui.stage('verifying', STAGE_RANGES.verifying[0], '核查证据');
      const allNewIds = uniqueIds([...newByQuestion.values()].flat());
      const sources = packSources(rs, allNewIds);
      const data = await requestJson(rs, {
        builder: P.buildVerificationPrompt,
        input: { topic: archive.topic, questions: hydrateQuestions(archive), sources, today: rs.today },
        stage: '刷新核查',
        maxTokens: Math.min(settings.llmMaxTokens, 10000),
        schemaHint: VERIFICATION_SCHEMA_HINT,
        validate: validateVerification,
      }).catch((error) => {
        if (isAbortLike(error, rs.ctl)) throw abortError(rs, error);
        return null;
      });
      if (data) {
        M.applyVerification(archive, data, { sources: archive.sources, now: rs.nowDate() });
        rs.ui.log('info', `刷新：新增 ${allNewIds.length} 条来源，核查 ${asArray(data.updates).length} 个问题`);
      } else {
        rs.degraded = true;
        rs.ui.log('warn', '刷新核查没有返回结构，保留原证据状态。');
      }
      const affected = asArray(archive.claims)
        .filter((claim) => asArray(claim.questionIds).some((id) => asArray(newByQuestion.get(id)).length))
        .map((claim) => claim.id);
      rs.revisionSummaryText = allNewIds.length
        ? `刷新：新增 ${allNewIds.length} 条来源，更新 ${asArray(newByQuestion.values()).filter((ids) => ids.length).length} 个问题`
        : '刷新：未发现新增来源，保留原档案';
      if (affected.length) await patchJudgments(rs, { claimIds: affected, sources, revisionNote: rs.revisionSummaryText });
      await stageLinking(rs, { revisionKind: 'refresh' });
      return archive;
    } catch (error) {
      if (isAbortLike(error, rs)) {
        if (rs.ctl.isTimedOut()) {
          await finalizePartial(rs, { revisionKind: 'refresh', reason: `刷新超时（${settings.jobTimeoutMs}ms）` });
          return rs.archive;
        }
        rs.ui.log('warn', '刷新已取消，未写入新的内容');
        throw abortError(rs, error);
      }
      rs.ui.log('error', `刷新失败：${clipText(messageOf(error), 300)}`);
      throw error;
    } finally {
      rs.ctl.dispose();
    }
  }

  return { runInitial, runFollowup, runRefresh };
}

export { STAGE_LABELS, STAGE_RANGES, DEFAULTS as PIPELINE_DEFAULTS };
