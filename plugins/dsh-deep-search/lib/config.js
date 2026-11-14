/**
 * lib/config.js —— 配置归一化与路径（CONTRACT §7）。
 *
 * 设计约束：
 *  - 零依赖：只用 node:path / node:os；
 *  - 所有数值都夹在安全区间内，坏配置不让插件起不来；
 *  - 对外只暴露 publicConfig()，绝不把 searchApiKey 写进 /health / /settings 响应。
 */

import os from 'node:os';
import path from 'node:path';

export const DEFAULT_ROOT_DIR_NAME = 'AI大搜索';
export const DEFAULT_SEARCH_BASE_URL = 'https://api.deepseek.com/v1/tools';
export const SEARCH_MODES = ['auto', 'account', 'web', 'api', 'anysearch'];
export const DEPTHS = ['quick', 'deep'];

function numberIn(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function integerIn(value, min, max, fallback) {
  return Math.round(numberIn(value, min, max, fallback));
}

function bool(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(text)) return true;
    if (['0', 'false', 'no', 'off'].includes(text)) return false;
  }
  return fallback;
}

function pick(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** 把 `~` 或相对路径展开成绝对路径。 */
export function resolveDir(value, homeDir) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const home = homeDir || process.env.HOME || os.homedir();
  let expanded = raw;
  if (raw === '~') expanded = home;
  else if (raw.startsWith('~/')) expanded = path.join(home, raw.slice(2));
  return path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(home, expanded);
}

/** 默认数据目录：<home>/Documents/DSH工具数据/AI大搜索 */
export function defaultRootDir(homeDir) {
  const home = homeDir || process.env.HOME || os.homedir();
  return path.join(home, 'Documents', 'DSH工具数据', DEFAULT_ROOT_DIR_NAME);
}

/**
 * 归一化配置。
 * @param {object} raw 用户 / profile 传入的配置
 * @param {{homeDir?: string, env?: Record<string,string>}} [deps]
 */
export function normalizeConfig(raw, deps = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const homeDir = deps.homeDir || process.env.HOME || os.homedir();
  const env = deps.env || process.env;

  const rootDir = resolveDir(source.rootDir, homeDir) || defaultRootDir(homeDir);

  const searchApiKey = text(source.searchApiKey) || text(env[text(source.searchApiKeyEnv, 'DEEPSEEK_API_KEY')]);

  return {
    enabled: bool(source.enabled, true),
    rootDir,
    maxQuestions: integerIn(source.maxQuestions, 3, 8, 6),
    searchesPerQuestion: integerIn(source.searchesPerQuestion, 1, 5, 3),
    searchMaxResults: integerIn(source.searchMaxResults, 3, 20, 8),
    fetchPerQuestion: integerIn(source.fetchPerQuestion, 0, 12, 8),
    fetchMaxChars: integerIn(source.fetchMaxChars, 1000, 30000, 6000),
    defaultDepth: pick(source.defaultDepth, DEPTHS, 'deep'),
    jobTimeoutMs: integerIn(source.jobTimeoutMs, 60000, 3600000, 1500000),
    llmMaxTokens: integerIn(source.llmMaxTokens, 256, 16000, 12000),
    searchApiBaseURL: text(source.searchApiBaseURL, DEFAULT_SEARCH_BASE_URL).replace(/\/+$/, ''),
    searchApiKeyEnv: text(source.searchApiKeyEnv, 'DEEPSEEK_API_KEY'),
    searchApiKey,
    anySearchApiKey: text(source.anySearchApiKey) || text(env.ANYSEARCH_API_KEY),
    searchProviderMode: pick(source.searchProviderMode, SEARCH_MODES, 'auto'),
    maxActiveJobs: integerIn(source.maxActiveJobs, 1, 3, 1),
    modelProvider: text(source.modelProvider),
    model: text(source.model),
    maxResearchConcurrency: integerIn(source.maxResearchConcurrency, 1, 4, 2),
    reasoningEffort: pick(source.reasoningEffort, ['off', 'low', 'medium', 'high', 'max'], 'off'),
    quickQuestions: integerIn(source.quickQuestions, 2, 5, 3),
    maxBasicQueries: integerIn(source.maxBasicQueries, 2, 8, 5),
    maxBasicSources: integerIn(source.maxBasicSources, 4, 20, 10),
    maxDiscussionIssues: integerIn(source.maxDiscussionIssues, 2, 8, 5),
    maxDiscussionSources: integerIn(source.maxDiscussionSources, 6, 30, 12),
    maxSearches: integerIn(source.maxSearches, 10, 80, 48),
    maxFetches: integerIn(source.maxFetches, 6, 80, 80),
    fetchFailureRate: numberIn(source.fetchFailureRate, 0, 1, 0.6),
    fetchMinSamples: integerIn(source.fetchMinSamples, 3, 20, 8),
    fetchConsecutiveFailures: integerIn(source.fetchConsecutiveFailures, 2, 10, 5),
    fetchTimeRatio: numberIn(source.fetchTimeRatio, 0.2, 0.9, 0.55),
  };
}

/** 配置 → 磁盘路径。每次调用都按当前 config.rootDir 计算，支持运行时改目录。 */
export function pathsOf(config) {
  const root = (config && config.rootDir) || defaultRootDir();
  return {
    root,
    topicsDir: path.join(root, 'topics'),
    trashDir: path.join(root, '.trash'),
    indexFile: path.join(root, 'index.json'),
    jobsFile: path.join(root, 'jobs.json'),
    logFile: path.join(root, 'deep-search.log'),
  };
}

/** 可以出现在响应里的配置（不含密钥）。 */
export function publicConfig(config) {
  if (!config || typeof config !== 'object') return {};
  return {
    enabled: Boolean(config.enabled),
    rootDir: config.rootDir || '',
    maxQuestions: config.maxQuestions,
    searchesPerQuestion: config.searchesPerQuestion,
    searchMaxResults: config.searchMaxResults,
    fetchPerQuestion: config.fetchPerQuestion,
    fetchMaxChars: config.fetchMaxChars,
    defaultDepth: config.defaultDepth,
    jobTimeoutMs: config.jobTimeoutMs,
    llmMaxTokens: config.llmMaxTokens,
    searchApiBaseURL: config.searchApiBaseURL,
    searchApiKeyEnv: config.searchApiKeyEnv,
    hasSearchApiKey: Boolean(config.searchApiKey),
    hasAnySearchApiKey: Boolean(config.anySearchApiKey),
    searchProviderMode: config.searchProviderMode,
    maxActiveJobs: config.maxActiveJobs,
    modelProvider: config.modelProvider || '',
    model: config.model || '',
    maxResearchConcurrency: config.maxResearchConcurrency,
    reasoningEffort: config.reasoningEffort,
    quickQuestions: config.quickQuestions,
    maxBasicQueries: config.maxBasicQueries,
    maxBasicSources: config.maxBasicSources,
    maxDiscussionIssues: config.maxDiscussionIssues,
    maxDiscussionSources: config.maxDiscussionSources,
    maxSearches: config.maxSearches,
    maxFetches: config.maxFetches,
    fetchFailureRate: config.fetchFailureRate,
    fetchMinSamples: config.fetchMinSamples,
    fetchConsecutiveFailures: config.fetchConsecutiveFailures,
    fetchTimeRatio: config.fetchTimeRatio,
  };
}
