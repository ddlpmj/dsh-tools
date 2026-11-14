/**
 * dsh-ai-intel —— AI 情报台（宿主半侧）
 *
 * 一个按钮做两件事：
 *   1) 跑工作区里的采集器（scripts/collect.py：RSS / 页面 diff / arXiv）
 *   2) 对「盲区实体」和「本机抓不到的源」做一轮搜索补充（ctx.web.search）
 * 所有结果追加进 <libraryDir>/数据/基础库.json，只增不减。
 *
 * HTTP 路由（前缀 /dsh-ai-intel，同源 JSON）：
 *   GET  /status                     面板首屏：计数、上次运行、源健康
 *   GET  /today                      今天的条目 + 上次运行 + 最新报告
 *   GET  /library?q=&kind=&limit=    基础库检索（默认 100，最多 500）
 *   GET  /blindspots                 实体矩阵盲区
 *   GET  /runs                       最近运行记录
 *   POST /run                        点一次：采集 + 搜索补充
 *   POST /search  {query,maxResults} 手动补一条搜索
 *
 * 设计约束：
 * - 所有异常在路由层兜底成 { ok:false, error:{code,message} }，绝不冒到宿主进程；
 * - 采集与搜索都在宿主侧完成，不消耗模型 token；
 * - 写库串行：同一时刻只允许一次 run。
 */
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWechatMonitor, canonicalArticleUrl } from './lib/wechat-monitor.js';
import { createWechatProvider } from './lib/wechat-provider.js';

const ROUTE_PREFIX = '/dsh-ai-intel';
const DEFAULT_LIBRARY_DIR = path.join(os.homedir(), 'Documents', 'DSH工具数据', 'AI情报台');
const DEFAULT_COLLECTOR = fileURLToPath(new URL('./collector/collect.py', import.meta.url));
const MAX_BODY_BYTES = 256 * 1024;
const COLLECT_TIMEOUT_MS = 300000;
const ITEMS_MAX = 50000;
const RUNS_MAX = 300;
const TZ = 'Asia/Shanghai';
const DAY_MS = 86400000;

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const str = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const num = (value, fallback, min, max) => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
    return Math.min(max, Math.max(min, n));
  };
  const dirRaw = str(source.libraryDir, DEFAULT_LIBRARY_DIR);
  return {
    libraryDir: path.resolve(expandHome(dirRaw)),
    pythonBin: str(source.pythonBin, 'python3'),
    collector: str(source.collector, ''),
    searchPerRun: num(source.searchPerRun, 6, 0, 20),
    searchMaxResults: num(source.searchMaxResults, 4, 1, 8),
    blindspotDays: num(source.blindspotDays, 7, 1, 90),
    staleDays: num(source.staleDays, 7, 1, 365),
    translateEnabled: source.translateEnabled !== false,
    translatePerRun: num(source.translatePerRun, 300, 0, 600),
    wechatAllowedFeedOrigins: Array.isArray(source.wechatAllowedFeedOrigins) ? source.wechatAllowedFeedOrigins.filter(value => typeof value === 'string') : [],
    wechatProviderFile: str(source.wechatProviderFile, ''),
    wechatProviderOrigin: str(source.wechatProviderOrigin, ''),
    wechatSeedArticles: Array.isArray(source.wechatSeedArticles) ? [...new Set(source.wechatSeedArticles.map(canonicalArticleUrl).filter(Boolean))] : [],
  };
}

function pathsOf(settings) {
  const dataDir = path.join(settings.libraryDir, '数据');
  return {
    dataDir,
    library: path.join(dataDir, '基础库.json'),
    ledger: path.join(dataDir, '采集台账.jsonl'),
    config: path.join(settings.libraryDir, '配置'),
    entities: path.join(settings.libraryDir, '配置', '实体表.json'),
    sources: path.join(settings.libraryDir, '配置', '信息源.json'),
    startups: path.join(settings.libraryDir, '配置', '创业公司库.json'),
    glossary: path.join(settings.libraryDir, '配置', '术语表.json'),
    collector: settings.collector
      ? path.resolve(settings.libraryDir, expandHome(settings.collector))
      : DEFAULT_COLLECTOR,
  };
}

// ---------------------------------------------------------------------------
// 基础 IO
// ---------------------------------------------------------------------------
async function readJsonFile(file, fallback) {
  try {
    const text = await fsp.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 12)}.tmp`;
  try {
    await fsp.writeFile(tmp, JSON.stringify(value, null, 1), 'utf8');
    await fsp.rename(tmp, file);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
}

// 所有写入口共用提交队列；耗时的采集、搜索、翻译在事务外执行，
// 提交时重新读取最新库，只合并本次变更，避免用旧快照覆盖另一入口的结果。
const libraryWrites = new Map();
function updateLibrary(settings, change) {
  const file = pathsOf(settings).library;
  const previous = libraryWrites.get(file) || Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const library = await readLibrary(settings);
    const result = change(library);
    await writeJsonFile(file, library);
    return result;
  });
  libraryWrites.set(file, next);
  const cleanup = () => { if (libraryWrites.get(file) === next) libraryWrites.delete(file); };
  next.then(cleanup, cleanup);
  return next;
}

function mergeLibraryItems(incoming, existing) {
  const byId = new Map();
  for (const item of [...incoming, ...existing]) {
    if (!item?.id) continue;
    const prior = byId.get(item.id);
    if (!prior) byId.set(item.id, { ...item });
    else byId.set(item.id, {
      ...item,
      ...prior,
      titleZh: prior.titleZh || (sameTitle(prior.title, item.title) ? item.titleZh : ''),
      entity: [...new Set([...(prior.entity || []), ...(item.entity || [])])],
    });
  }
  return [...byId.values()].slice(0, ITEMS_MAX);
}

async function fileExists(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

function sha(text) {
  return createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function xPostIdentity(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(u.hostname.toLowerCase())) return null;
    const match = u.pathname.match(/^\/([a-z0-9_]{1,15})\/status\/([0-9]{1,25})\/?$/i);
    return match ? { username: match[1], id: match[2] } : null;
  } catch { return null; }
}

function pageKey(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return '';
  }
}

function samePage(left, right) {
  const key = pageKey(left);
  return Boolean(key) && key === pageKey(right);
}

function titleKey(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function sameTitle(left, right) {
  return titleKey(left) === titleKey(right);
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyLibrary() {
  return { version: 1, items: [], runs: [], meta: { lastEventTs: '', searched: {} } };
}

async function readLibrary(settings) {
  const lib = await readJsonFile(pathsOf(settings).library, null);
  if (!lib || typeof lib !== 'object' || !Array.isArray(lib.items)) return emptyLibrary();
  return {
    version: 1,
    items: lib.items,
    runs: Array.isArray(lib.runs) ? lib.runs : [],
    meta: {
      lastEventTs: typeof lib.meta?.lastEventTs === 'string' ? lib.meta.lastEventTs : '',
      searched: lib.meta?.searched && typeof lib.meta.searched === 'object' ? lib.meta.searched : {},
    },
  };
}

async function readLedger(settings) {
  try {
    const text = await fsp.readFile(pathsOf(settings).ledger, 'utf8');
    const rows = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        rows.push(JSON.parse(trimmed));
      } catch {
        /* 单行损坏不影响整体 */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function latestReport(settings) {
  const { dataDir } = pathsOf(settings);
  let names = [];
  try {
    names = await fsp.readdir(dataDir);
  } catch {
    return null;
  }
  const reports = names.filter((name) => /^报告-.*\.md$/.test(name)).sort();
  if (!reports.length) return null;
  const name = reports[reports.length - 1];
  const full = path.join(dataDir, name);
  try {
    const text = await fsp.readFile(full, 'utf8');
    return { name, path: full, text: text.slice(0, 60000) };
  } catch {
    return { name, path: full, text: '' };
  }
}

// ---------------------------------------------------------------------------
// 实体矩阵：盲区
// ---------------------------------------------------------------------------
async function loadEntities(settings) {
  const doc = await readJsonFile(pathsOf(settings).entities, null);
  const list = Array.isArray(doc?.entities) ? doc.entities : [];
  return list.filter((item) => item && typeof item.id === 'string');
}

async function loadSources(settings) {
  const doc = await readJsonFile(pathsOf(settings).sources, null);
  const list = Array.isArray(doc?.sources) ? doc.sources : [];
  return list.filter((item) => item && typeof item.id === 'string');
}

function sourceHealth(sources) {
  const total = sources.length;
  const ok = sources.filter((item) => item.status === 'ok' || item.status === 'html-only' || item.status === 'js-only').length;
  return { total, ok };
}

async function computeBlindspots(settings) {
  const { blindspotDays } = settings;
  const entities = await loadEntities(settings);
  if (!entities.length) return [];
  const cutoff = Date.now() - blindspotDays * DAY_MS;
  const isRecent = (ts) => {
    const at = Date.parse(ts || '');
    return Number.isFinite(at) && at >= cutoff;
  };
  const seen = new Set();
  const ledger = await readLedger(settings);
  for (const row of ledger) {
    if (!isRecent(row?.ts)) continue;
    for (const id of row.entity || []) seen.add(id);
  }
  // 搜索补充也算「有记录」：它确实补上了这个实体最近的动态。
  const library = await readLibrary(settings);
  for (const item of library.items) {
    if (!isRecent(item?.ts)) continue;
    for (const id of item.entity || []) seen.add(id);
  }
  return entities
    .filter((entity) => !seen.has(entity.id))
    .map((entity) => ({ id: entity.id, name: entity.name || entity.id, tier: entity.tier ?? 3 }));
}

// ---------------------------------------------------------------------------
// 采集：跑工作区的 python 采集器
// ---------------------------------------------------------------------------
async function runCollector(settings, sourceIds = null) {
  const { collector } = pathsOf(settings);
  const { pythonBin, libraryDir } = settings;
  await fsp.mkdir(libraryDir, { recursive: true });

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };
    let stdout = '';
    let stderr = '';
    let child;
    try {
      if (sourceIds !== null && (!Array.isArray(sourceIds) || !sourceIds.length)) throw new Error('sourceIds must be a non-empty array');
      const args = [collector];
      if (!settings.collector) args.push('--library-dir', libraryDir);
      args.push(...(sourceIds || []).flatMap(id => ['--source', id]));
      child = spawn(pythonBin, args, { cwd: libraryDir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      done({ ok: false, error: `spawn failed: ${error?.message || error}` });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
      done({ ok: false, error: `collector timeout after ${COLLECT_TIMEOUT_MS}ms`, stdout: stdout.slice(-2000), stderr: stderr.slice(-2000) });
    }, COLLECT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 200000) stdout = stdout.slice(-100000);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ ok: false, error: `spawn error: ${error?.message || error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({
        ok: code === 0,
        code,
        error: code === 0 ? '' : (stderr.trim().split('\n').at(-1) || `collector exited with code ${code}`).slice(0, 500),
        stdout: stdout.slice(-3000),
        stderr: stderr.slice(-3000),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 搜索补充
// ---------------------------------------------------------------------------
function getService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

async function searchOnce(ctx, query, maxResults) {
  const web = getService(ctx, 'web');
  if (!web || typeof web.search !== 'function') {
    return { ok: false, reason: 'WEB_UNAVAILABLE', sources: [] };
  }
  try {
    const result = await web.search({ query, maxResults });
    return { ok: true, sources: Array.isArray(result?.sources) ? result.sources : [] };
  } catch (error) {
    return { ok: false, reason: error?.code || error?.message || 'SEARCH_FAILED', sources: [] };
  }
}

function isAscii(text) {
  return /^[\x20-\x7E]+$/.test(text);
}

function monthLabel() {
  const now = new Date();
  const shifted = new Date(now.getTime() - 30 * DAY_MS);
  const fmt = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const from = fmt(shifted);
  const to = fmt(now);
  return from === to ? to : `${from}~${to}`;
}

/**
 * 组装本轮搜索任务：先补盲区实体，再补本机抓不到的源。
 * 同一目标有冷却时间，避免每天搜同样几句。
 */
function buildSearchJobs(settings, blindspots, sources, searched) {
  const jobs = [];
  const now = Date.now();
  const cooldown = 7 * DAY_MS;
  const tierRank = { 1: 0, 2: 1, 3: 2 };
  const ranked = [...blindspots].sort((a, b) => (tierRank[a.tier] ?? 9) - (tierRank[b.tier] ?? 9));
  const month = monthLabel();

  for (const entity of ranked) {
    if (jobs.length >= settings.searchPerRun) break;
    const key = `entity:${entity.id}`;
    const last = Date.parse(searched[key] || '') || 0;
    if (now - last < cooldown) continue;
    const query = isAscii(entity.name)
      ? `${entity.name} AI news ${month}`
      : `${entity.name} 最新动态 ${month}`;
    jobs.push({ key, reason: 'blindspot', entityId: entity.id, entityName: entity.name, query });
  }

  for (const source of sources) {
    if (jobs.length >= settings.searchPerRun) break;
    if (source.status !== 'blocked' && source.status !== 'dead' && source.status !== 'js-only') continue;
    const key = `source:${source.id}`;
    const last = Date.parse(searched[key] || '') || 0;
    const days = source.status === 'js-only' ? 14 : 3;
    if (now - last < days * DAY_MS) continue;
    const query = isAscii(source.name)
      ? `${source.name} latest update`
      : `${source.name} 最新`;
    jobs.push({ key, reason: `source-${source.status}`, entityId: '', entityName: source.name, query });
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// 界面中文化：把英文标题翻成中文（匿名翻译通道，失败就保留原文）
// ---------------------------------------------------------------------------
const CJK_RE = /[\u3400-\u9fff]/;

function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把模型/产品名换成占位符再送去翻译，翻完换回来：避免 Gemini 变「双子座」、Claude 变「克劳德」。 */
function maskTerms(text, terms) {
  const map = [];
  // 该 AI 术语按完整短语处理，避免把 memory 误译成硬件内存。
  let out = text.replace(/\bagent memory\b/gi, () => {
    const token = 'ZQ' + map.length + 'X';
    map.push([token, '智能体记忆']);
    return token;
  });
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    const pattern = '(?<![A-Za-z0-9])' + escapeRe(term) + '(?:\\s+\\d+(?:\\.\\d+)*)?(?:\\s+[A-Z][A-Za-z0-9+.]*)?';
    out = out.replace(new RegExp(pattern, 'g'), (match) => {
      const token = 'ZQ' + map.length + 'X';
      map.push([token, match]);
      return token;
    });
  }
  return { masked: out, map };
}

function unmaskTerms(text, map) {
  let out = text;
  for (const [token, original] of map) {
    out = out.split(token).join(original);
    out = out.split(token.toLowerCase()).join(original);
  }
  return out.replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '');
}

let glossaryCache = null;
async function loadTerms(settings) {
  const stamp = `${pathsOf(settings).glossary}`;
  if (glossaryCache && glossaryCache.stamp === stamp) return glossaryCache.terms;
  const doc = await readJsonFile(stamp, null);
  const terms = Array.isArray(doc?.terms) ? doc.terms.filter((term) => typeof term === 'string' && term) : [];
  glossaryCache = { stamp, terms };
  return terms;
}

async function translateItems(ctx, items, settings) {
  if (!settings.translateEnabled || !items.length) return 0;
  const translator = getService(ctx, 'translator');
  if (!translator || typeof translator.translate !== 'function') return 0;
  let provider = null;
  try {
    const list = await translator.availableProviders();
    provider = (list || []).find((item) => item === 'google' || item === 'bing') || null;
  } catch {
    return 0;
  }
  if (!provider) return 0;
  const terms = await loadTerms(settings);
  const queue = items.filter((item) => item && item.title && !CJK_RE.test(item.title)).slice(0, settings.translatePerRun);
  let done = 0;
  const worker = async () => {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const { masked, map } = maskTerms(item.title, terms);
        const spec = translator.resolve({ text: masked, targetLanguage: 'zh', provider });
        const out = await translator.translate(spec);
        const translated = typeof out === 'string' ? unmaskTerms(out.trim(), map) : '';
        if (CJK_RE.test(translated)) {
          item.titleZh = translated;
          done += 1;
        }
      } catch {
        /* 单条翻译失败不影响这一轮 */
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return done;
}

// ---------------------------------------------------------------------------
// 一次完整运行
// ---------------------------------------------------------------------------
async function requestedSourceIds(settings, body) {
  const invalid = message => { throw Object.assign(new Error(message), { status: 400, code: 'BAD_SOURCE_IDS' }); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('运行参数必须是 JSON 对象。');
  if (!Object.hasOwn(body, 'sourceIds')) return null;
  if (!Array.isArray(body.sourceIds) || !body.sourceIds.length || body.sourceIds.some(id => typeof id !== 'string' || !id.trim())) {
    invalid('sourceIds 必须是包含已配置来源 ID 的非空字符串数组。');
  }
  const ids = [...new Set(body.sourceIds.map(id => id.trim()))];
  const known = new Set((await loadSources(settings)).map(source => source.id));
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length) invalid('未知来源 ID：' + unknown.join('、').slice(0, 300));
  return ids;
}

async function executeRun(rt, trigger, { sourceIds = null } = {}) {
  const { settings } = rt;
  const library = await readLibrary(settings);
  const startedAt = new Date().toISOString();
  const runId = `run-${startedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;

  const collector = (await fileExists(pathsOf(settings).collector))
    ? await runCollector(settings, sourceIds)
    : { ok: false, error: 'collector-missing', durationMs: 0 };
  const sourceHealthReport = await readJsonFile(path.join(pathsOf(settings).dataDir, '最近采集结果.json'), null);
  if (Date.parse(sourceHealthReport?.runAt || '') >= Date.parse(startedAt) && Date.parse(sourceHealthReport?.runAt || '') <= Date.now() + 5000 && Array.isArray(sourceHealthReport?.sources)
      && sourceHealthReport.sources.every(row => row && typeof row.id === 'string' && typeof row.ok === 'boolean')
      && (!sourceIds || (sourceHealthReport.sources.length === sourceIds.length && sourceHealthReport.sources.every(row => sourceIds.includes(row.id))))) {
    collector.sources = sourceHealthReport.sources.map(row => ({ id: row.id, ok: row.ok === true, n: Number(row.n) || 0, note: typeof row.note === 'string' ? row.note.slice(0, 300) : '', ...(!row.ok ? { error: 'SOURCE_FETCH_FAILED' } : {}) }));
  }

  const ledger = await readLedger(settings);
  const since = library.meta.lastEventTs || '';
  const freshEvents = ledger.filter((row) => typeof row?.ts === 'string' && row.ts > since);
  const lastEventTs = freshEvents.reduce((latest, row) => (row.ts > latest ? row.ts : latest), since);

  const blindspots = sourceIds ? [] : await computeBlindspots(settings);
  const sources = await loadSources(settings);
  const jobs = sourceIds ? [] : buildSearchJobs(settings, blindspots, sources, library.meta.searched);

  const queryLog = [];
  const webItems = [];
  for (const job of jobs) {
    const result = await searchOnce(rt.ctx, job.query, settings.searchMaxResults);
    queryLog.push({
      query: job.query,
      reason: job.reason,
      target: job.entityName,
      ok: result.ok,
      count: result.sources.filter((item) => typeof item?.url === 'string' && item.url).length,
      error: result.ok ? '' : String(result.reason || ''),
    });
    if (result.ok) {
      for (const item of result.sources) {
        const url = typeof item?.url === 'string' ? item.url : '';
        const title = typeof item?.title === 'string' && item.title ? item.title : url;
        if (!url) continue;
        webItems.push({
          id: sha(`web|${url}|${title}`),
          kind: 'web',
          line: 'W',
          title,
          url,
          snippet: typeof item?.snippet === 'string' ? item.snippet.slice(0, 400) : '',
          source: `web:${job.reason}`,
          entity: job.entityId ? [job.entityId] : [],
          official: false,
          ts: new Date().toISOString(),
          runId,
        });
      }
    }
    await sleep(150);
  }

  const seenIds = new Set(library.items.map((item) => item?.id).filter(Boolean));
  const articleSources = new Map(sources.filter((source) => source.type === 'html-list').map((source) => [source.id, source]));
  const editorialSources = new Map(sources.filter(source =>
    source.entity && ['t1', 't2'].includes(source.group) && ['html-list', 'rss', 'qwen-articles'].includes(source.type)
  ).map(source => [source.id, source]));
  const editorialKey = (source, url) => {
    const key = source && pageKey(url);
    return key && key !== pageKey(source.url) ? `${source.entity}\n${key}` : '';
  };
  const knownEditorial = new Map();
  for (const item of library.items) {
    if (item.kind !== 'event' || (item.originKind && item.originKind !== 'news') || item.linkKind === 'unresolved') continue;
    const key = editorialKey(editorialSources.get(item.source), item.url);
    if (key && !knownEditorial.has(key)) knownEditorial.set(key, item.id);
  }
  const xSources = new Map(sources.filter(source => source.platform === 'x').map(source => [source.id, source]));
  const knownXPosts = new Set(library.items.filter(item => item.platform === 'x' || xSources.has(item.source)).map(item => xPostIdentity(item.url)?.id).filter(Boolean));
  const incomingArticleUrls = new Map();
  for (const row of freshEvents) {
    if (!articleSources.has(row.source)) continue;
    const key = `${row.source}\n${titleKey(row.title)}`;
    if (!incomingArticleUrls.has(key)) incomingArticleUrls.set(key, new Set());
    incomingArticleUrls.get(key).add(row.url);
  }
  const eventItems = [];
  for (const row of freshEvents) {
    const title = typeof row?.title === 'string' ? row.title : '';
    if (!title) continue;
    let url = typeof row?.url === 'string' ? row.url : '';
    const xSource = xSources.get(row.source);
    const xPost = xSource ? xPostIdentity(url) : null;
    if (xSource) {
      if (!xPost || xPost.username.toLowerCase() !== String(xSource.username || '').toLowerCase() || knownXPosts.has(xPost.id)) continue;
      knownXPosts.add(xPost.id);
      url = `https://x.com/${xSource.username}/status/${xPost.id}`;
    }
    // 修复首页链接后仍保留旧条目的 ID；新采集不能因 URL 变正确而再插入一份。
    const articleSource = articleSources.get(row.source);
    const sourceItems = articleSource ? library.items.filter((item) => item.source === row.source) : [];
    const candidates = sourceItems.filter((item) => sameTitle(item.title, title));
    const exact = sourceItems.find((item) => samePage(item.url, url));
    const unresolved = candidates.filter((item) => samePage(item.url, articleSource?.url));
    const uniqueIncoming = incomingArticleUrls.get(`${row.source}\n${titleKey(title)}`)?.size === 1;
    const previous = exact || (uniqueIncoming && unresolved.length === 1 ? unresolved[0] : undefined);
    const id = previous?.id || sha(xPost ? `x|${xPost.id}` : `${row.kind || 'event'}|${url}|${title}`);
    const editorialSource = editorialSources.get(row.source);
    const articleKey = row.kind === 'news' ? editorialKey(editorialSource, url) : '';
    if (articleKey && knownEditorial.has(articleKey) && knownEditorial.get(articleKey) !== id) continue;
    if (seenIds.has(id) && (!previous || (samePage(previous.url, url) && sameTitle(previous.title, title) && (previous.published || !row.published)))) continue;
    if (articleKey) knownEditorial.set(articleKey, id);
    seenIds.add(id);
    eventItems.push({
      ...(previous || {}),
      id,
      kind: 'event',
      originKind: row.kind || 'news',
      line: typeof row.line === 'string' ? row.line : 'B',
      title,
      ...(previous && !sameTitle(previous.title, title) ? { titleZh: '' } : {}),
      url,
      source: typeof row.source === 'string' ? row.source : '',
      ...(xPost ? { platform: 'x', uid: 'x:' + xPost.id, username: xSource.username, snippet: typeof row.snippet === 'string' ? row.snippet.slice(0, 6000) : '' } : {}),
      entity: [...new Set([...(previous?.entity || []), ...(editorialSource ? [editorialSource.entity] : []), ...(Array.isArray(row.entity) ? row.entity : [])])],
      official: row.official === true,
      published: (typeof row.published === 'string' && row.published) || previous?.published || '',
      ts: previous?.ts || (typeof row.ts === 'string' ? row.ts : new Date().toISOString()),
      ...(articleSource ? { linkKind: 'article', sourceUrl: articleSource.url } : {}),
      runId: previous?.runId || runId,
    });
  }
  const freshWeb = mergeLibraryItems(webItems, []).filter((item) => !seenIds.has(item.id));

  const translated = await translateItems(rt.ctx, [...freshWeb, ...eventItems], settings);

  const report = await latestReport(settings);
  const run = {
    id: runId,
    trigger,
    ...(sourceIds ? { sourceIds: [...sourceIds] } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    collector: {
      ok: Boolean(collector.ok),
      code: collector.code ?? null,
      durationMs: collector.durationMs ?? 0,
      error: collector.error || '',
      ...(collector.sources ? { sources: collector.sources } : {}),
    },
    added: { events: eventItems.length, web: freshWeb.length },
    translated,
    blindspots: blindspots.map((item) => ({ id: item.id, name: item.name, tier: item.tier })),
    queries: queryLog,
    report: report ? report.name : '',
  };

  return updateLibrary(settings, (latest) => {
    const ids = new Set(latest.items.map((item) => item.id));
    run.added = {
      events: eventItems.filter((item) => !ids.has(item.id)).length,
      web: freshWeb.filter((item) => !ids.has(item.id)).length,
    };
    latest.items = mergeLibraryItems([...freshWeb, ...eventItems], latest.items);
    latest.runs = [run, ...latest.runs].slice(0, RUNS_MAX);
    latest.meta.lastEventTs = [latest.meta.lastEventTs, lastEventTs].sort().at(-1) || '';
    jobs.forEach((job, index) => {
      // 临时故障或空结果不能算补查成功，否则会把盲区冷却七天。
      if (queryLog[index]?.ok && queryLog[index].count > 0) latest.meta.searched[job.key] = run.finishedAt;
    });
    return { run, itemCount: latest.items.length };
  });
}

// ---------------------------------------------------------------------------
// 查询层
// ---------------------------------------------------------------------------
function summarizeStatus(settings, library, sources) {
  const today = dateKey(new Date());
  const counts = { total: library.items.length, today: 0, web: 0 };
  for (const item of library.items) {
    if (dateKey(item?.ts) === today) counts.today += 1;
    if (item?.kind === 'web') counts.web += 1;
  }
  const health = sourceHealth(sources);
  return {
    libraryDir: settings.libraryDir,
    counts: { ...counts, runs: library.runs.length, sourcesOk: health.ok, sourcesTotal: health.total },
    lastRun: library.runs[0] || null,
    running: Boolean(settings.__running),
  };
}

function isJunk(item) {
  if (item?.hiddenReason === 'page-fragment') return true;
  const title = String(item?.title || '');
  if (title.length < 8) return true;
  if (/^[0-9a-f]{16,}/i.test(title)) return true;
  if (/深入合作请联系|扫码关注|点击下载|版权所有/.test(title)) return true;
  if (/^(skip to|contact sales|cookie|privacy|terms)/i.test(title)) return true;
  return false;
}

function entityIndex(entities) {
  const map = new Map();
  for (const entity of entities) {
    map.set(entity.id, { tier: entity.tier ?? 3, name: entity.name || entity.id });
  }
  return map;
}

function isRepositorySource(source) {
  return source?.type === 'github-repos';
}

/** 给条目补上「属于哪一层公司」和实体名，供面板按大公司/明星/创业分组。 */
function decorateItem(item, cx) {
  const ids = Array.isArray(item.entity) ? item.entity : [];
  let tier = null;
  const names = [];
  for (const id of ids) {
    const meta = cx.entityIndex.get(id);
    if (!meta) continue;
    names.push(meta.name);
    if (tier === null || meta.tier < tier) tier = meta.tier;
  }
  const source = cx.sourceById.get(item.source);
  const pointsToSource = source && samePage(item.url, source.url);
  const linkKind = source?.type === 'html-list' && pointsToSource
    ? 'unresolved'
    : item.linkKind || (source?.type === 'page' && pointsToSource ? 'source-page' : 'article');
  const eventType = linkKind === 'source-page' ? 'pageChange' : detectEventType(item.title || '');
  const group = cx.sourceGroup.get(item.source) || '';
  const startup = matchStartup(item, cx.startups);
  let section = 'company';
  if (isRepositorySource(source)) section = 'repos';
  else if (group === 'social') section = 'social';
  else if (MAJOR_TYPES.has(eventType)) section = 'major';
  return {
    ...item,
    // 未找回原文的旧页面片段不再把标题伪装成文章链接。
    url: linkKind === 'unresolved' ? '' : item.url,
    sourceUrl: item.sourceUrl || source?.url || '',
    linkKind,
    published: linkKind === 'source-page' || linkKind === 'unresolved' ? '' : item.published,
    tier,
    entityNames: names,
    eventType,
    section,
    channel: channelOf(item, cx),
    startupId: startup ? startup.id : null,
    startupName: startup ? startup.name : null,
  };
}

const MAJOR_TYPES = new Set(['release', 'funding', 'acquisition', 'ipo', 'shutdown', 'regulation']);

// 内容渠道：官方发布 / 研究论文 / 社交媒体 / 媒体文章
const CHANNEL_BY_GROUP = {
  t1: 'official',
  leading: 'official',
  paper: 'papers',
  social: 'social',
  media: 'media',
  story: 'media',
  t2: 'media',
  t3: 'media',
};

function channelOf(item, cx) {
  const group = cx.sourceGroup.get(item.source) || '';
  // 论文源优先归到「论文」，即使它属于某家公司的官方检索
  if (group === 'paper' || item.kind === 'paper') return 'papers';
  if (cx.officialSources && cx.officialSources.has(item.source)) return 'official';
  return CHANNEL_BY_GROUP[group] || 'media';
}

const EVENT_PATTERNS = [
  ['release', /\b(releas|launch|introduc|unveil|announc|open.?sourc|deploy)\w*\b|发布|推出|上线|开源|开放|首发/i],
  ['funding', /\b(rais|funding|series [a-e]|valuation|invest|backed)\w*\b|融资|估值|募资|天使轮|种子轮|[A-FＡ-Ｆ]轮|Pre[- ]?[A-F]轮/i],
  ['acquisition', /\b(acqui|merger|merges?|buys|takeover)\w*\b|收购|并购|合并|接盘/i],
  ['ipo', /\b(ipo|s-1|listing|goes public|direct list)\w*\b|上市|招股|敲钟/i],
  ['shutdown', /\b(shut ?down|shuts down|discontinu|sunset|bankrupt|layoff|lay off)\w*\b|关停|停止服务|倒闭|裁员/i],
  ['regulation', /\b(lawsuit|sues?|judge|court|regulat|antitrust|ban|fine|probe|inquiry)\w*\b|起诉|诉讼|监管|罚款|禁令|调查/i],
  ['talent', /\b(joins|hires?|hired|departs?|resign|appoint|poach)\w*\b|加入|离职|任命|挖角|招募/i],
  ['pricing', /\b(pricing|price cut|cuts price|free tier|price)\w*\b|定价|降价|免费|提价/i],
  ['partnership', /\b(partner|partnership|collaborat|teams up)\w*\b|合作|联手|战略合作/i],
];

function detectEventType(title) {
  const text = String(title || '');
  for (const pair of EVENT_PATTERNS) {
    if (pair[1].test(text)) return pair[0];
  }
  return 'news';
}

function matchStartup(item, startups) {
  if (!item || !startups.length) return null;
  const entityIds = Array.isArray(item.entity) ? item.entity : [];
  for (const id of entityIds) {
    for (const startup of startups) {
      if (startup.id === id) return startup;
    }
  }
  const title = item.title || '';
  if (!title) return null;
  const t = ' ' + title.toLowerCase() + ' ';
  for (const startup of startups) {
    for (const alias of startup.aliases || []) {
      if (alias.length <= 6) {
        const re = new RegExp('(?<![a-z0-9])' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])');
        if (re.test(t)) return startup;
      } else if (t.includes(alias)) {
        return startup;
      }
    }
  }
  return null;
}

async function loadStartups(settings) {
  const doc = await readJsonFile(pathsOf(settings).startups, null);
  const list = Array.isArray(doc?.startups) ? doc.startups : [];
  return list.filter((item) => item && typeof item.id === 'string');
}

async function buildCx(settings) {
  const [entities, sources, startupDoc] = await Promise.all([
    loadEntities(settings),
    loadSources(settings),
    readJsonFile(pathsOf(settings).startups, null),
  ]);
  const sourceGroup = new Map();
  const sourceEntity = new Map();
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  for (const source of sources) {
    sourceGroup.set(source.id, source.group || '');
    sourceEntity.set(source.id, source.entity || '');
  }
  // 公司自己的源（博客 / 定价页 / 官方 GitHub）→ 官方渠道
  const t1Ids = new Set(entities.filter((entity) => (entity.tier ?? 3) === 1).map((entity) => entity.id));
  const officialSources = new Set();
  for (const source of sources) {
    if (t1Ids.has(source.entity) || source.group === 't1') officialSources.add(source.id);
  }
  const startups = Array.isArray(startupDoc?.startups) ? startupDoc.startups : [];
  const startupCategories = startupDoc && typeof startupDoc.categories === 'object' ? startupDoc.categories : {};
  return { entityIndex: entityIndex(entities), sourceGroup, sourceEntity, sourceById, officialSources, startups, startupCategories, entities, sources };
}

const PSEUDO_ENTITIES = new Set(['media', 'china-media', 'oss', 'vc', 'research']);

function trendsOf(library, cx, days) {
  const now = Date.now();
  const span = days * DAY_MS;
  const curFrom = now - span;
  const prevFrom = now - 2 * span;
  const stat = new Map();
  for (const item of library.items) {
    if (isJunk(item)) continue;
    const at = Date.parse(item?.ts || '');
    if (!Number.isFinite(at) || at < prevFrom) continue;
    for (const id of item.entity || []) {
      if (!cx.entityIndex.has(id) || PSEUDO_ENTITIES.has(id)) continue;
      const row = stat.get(id) || { id, current: 0, previous: 0, lastAt: 0, example: null };
      if (at >= curFrom) {
        row.current += 1;
        if (at > row.lastAt) {
          row.lastAt = at;
          row.example = { title: item.title, url: item.url, source: item.source };
        }
      } else {
        row.previous += 1;
      }
      stat.set(id, row);
    }
  }
  const rows = [];
  for (const [id, row] of stat) {
    const meta = cx.entityIndex.get(id);
    rows.push({
      id,
      name: meta.name,
      tier: meta.tier,
      current: row.current,
      previous: row.previous,
      delta: row.current - row.previous,
      lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
      example: row.example,
    });
  }
  rows.sort((a, b) => b.delta - a.delta || b.current - a.current);
  return { days, items: rows };
}

function startupsView(library, cx, categoryId) {
  const cutoff = Date.now() - 90 * DAY_MS;
  const byStartup = new Map();
  for (const item of library.items) {
    if (isJunk(item)) continue;
    const at = Date.parse(item?.ts || '');
    if (!Number.isFinite(at) || at < cutoff) continue;
    const startup = matchStartup(item, cx.startups);
    if (!startup) continue;
    const row = byStartup.get(startup.id) || { count: 0, lastAt: 0, items: [] };
    row.count += 1;
    if (at > row.lastAt) row.lastAt = at;
    if (row.items.length < 3) row.items.push({ title: item.title, url: item.url, ts: item.ts, section: item.section, eventType: item.eventType });
    byStartup.set(startup.id, row);
  }
  const categories = new Map();
  for (const [catId, label] of Object.entries(cx.startupCategories || {})) {
    categories.set(catId, { id: catId, label, startups: [] });
  }
  for (const startup of cx.startups) {
    const bucket = categories.get(startup.cat);
    if (!bucket) continue;
    if (categoryId && startup.cat !== categoryId) continue;
    const row = byStartup.get(startup.id) || { count: 0, lastAt: 0, items: [] };
    bucket.startups.push({
      id: startup.id,
      name: startup.name,
      region: startup.region || '',
      stage: startup.stage || '',
      count: row.count,
      lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
      items: row.items,
    });
  }
  const list = [...categories.values()]
    .filter((bucket) => bucket.startups.length > 0)
    .map((bucket) => {
      bucket.startups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
      return {
        id: bucket.id,
        label: bucket.label,
        count: bucket.startups.reduce((sum, row) => sum + row.count, 0),
        startups: bucket.startups,
      };
    });
  return { categories: list };
}

/** 每一层覆盖多少、哪些实体已经在沉默。 */
function coverageOf(settings, library, entities) {
  const lastSeen = new Map();
  for (const item of library.items) {
    const at = Date.parse(item?.ts || '');
    if (!Number.isFinite(at)) continue;
    for (const id of item.entity || []) {
      if (!lastSeen.has(id) || at > lastSeen.get(id)) lastSeen.set(id, at);
    }
  }
  const cutoff = Date.now() - settings.staleDays * DAY_MS;
  const coverage = [1, 2, 3].map((tier) => {
    const list = entities.filter((entity) => (entity.tier ?? 3) === tier);
    const covered = list.filter((entity) => lastSeen.has(entity.id)).length;
    return { tier, total: list.length, covered };
  });
  const stale = [];
  for (const entity of entities) {
    const last = lastSeen.get(entity.id);
    if (last && last >= cutoff) continue;
    stale.push({
      id: entity.id,
      name: entity.name || entity.id,
      tier: entity.tier ?? 3,
      lastAt: last ? new Date(last).toISOString() : null,
    });
  }
  stale.sort((a, b) => String(a.lastAt || '').localeCompare(String(b.lastAt || '')));
  return { coverage, stale, staleDays: settings.staleDays };
}

function filterLibrary(library, query) {
  const q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  const kind = typeof query.kind === 'string' ? query.kind.trim() : '';
  const limitRaw = Number.parseInt(query.limit, 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 100;
  let rows = library.items;
  if (kind) rows = rows.filter((item) => item?.kind === kind);
  if (q) {
    rows = rows.filter((item) => {
      const hay = `${item.title || ''} ${item.titleZh || ''} ${item.url || ''} ${item.source || ''} ${(item.entity || []).join(' ')} ${item.snippet || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }
  return { total: rows.length, items: rows.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function isResWritable(res) {
  return res && !res.writableEnded && !res.destroyed;
}

function sendJson(res, status, payload) {
  if (!isResWritable(res)) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = (await readBody(req, MAX_BODY_BYTES)).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('BAD_JSON');
  }
}

function wechatImportView(rt) {
  const state = rt.wechatImport || { running: false, added: 0, existing: 0, failed: 0 };
  return { running: state.running, added: state.added, existing: state.existing, failed: state.failed,
    current: state.current || '', startedAt: state.startedAt || '', finishedAt: state.finishedAt || '' };
}

async function startWechatImport(rt, mode) {
  if (rt.wechatImport?.running) return wechatImportView(rt);
  const auth = await rt.wechatProvider.authStatus();
  if (!auth.authorized) throw Object.assign(new Error('请先扫码授权公众号服务。'), { code: 'AUTH_REQUIRED', status: 503 });
  // The first caller may have awaited authorization while another caller started importing.
  if (rt.wechatImport?.running) return wechatImportView(rt);
  const work = { running: true, added: 0, existing: 0, failed: 0, current: '', startedAt: new Date().toISOString(), errors: {} };
  rt.wechatImport = work;
  rt.wechatImportPromise = (async () => {
    const pending = (await rt.wechat.status()).subscriptions.filter(sub => !sub.feedUrl && sub.seedUrl && sub.enabled !== false);
    for (const intent of pending) {
      if (rt.wechatDisposed) break;
      const matchesIntent = sub => sub.id === intent.id && sub.createdAt === intent.createdAt && (sub.generation || '') === (intent.generation || '') && sub.enabled !== false && !sub.feedUrl;
      work.current = intent.name || intent.seedUrl;
      try {
        if (!(await rt.wechat.status()).subscriptions.some(matchesIntent)) continue;
        const account = await rt.wechatProvider.resolve(intent.seedUrl);
        if (rt.wechatDisposed) break;
        const current = (await rt.wechat.status()).subscriptions;
        if (!current.some(matchesIntent)) continue;
        const before = current.some(sub => sub.feedUrl && sub.accountId === account.id);
        const result = await rt.wechat.addSubscription({ id: intent.id, name: account.name, feedUrl: account.feedUrl,
          accountId: account.id, seedUrl: intent.seedUrl, mode: ['recent', 'history'].includes(mode) ? mode : 'from-now' }, intent);
        if (result.skipped) continue;
        if (before) work.existing++; else work.added++;
      } catch (error) {
        if (rt.wechatDisposed) break;
        if (!(await rt.wechat.status()).subscriptions.some(matchesIntent)) continue;
        work.failed++;
        work.errors[intent.id] = String(error.message || '账号添加失败，请重试。').slice(0, 200);
      }
    }
    if (!rt.wechatDisposed && work.added) await rt.wechat.check();
  })().catch(error => {
    if (!rt.wechatDisposed) { work.failed++; work.errors.general = String(error.message || '账号导入失败，请重试。').slice(0, 200); }
  }).finally(() => { work.running = false; work.current = ''; work.finishedAt = new Date().toISOString(); });
  return wechatImportView(rt);
}

async function handleWechatRoute(rt, req, res, pathname, search) {
  const method = req.method || 'GET';
  if (pathname === '/wechat/provider' && method === 'GET') {
    const provider = await rt.wechatProvider.status();
    const state = await rt.wechat.status();
    const pending = state.subscriptions.filter(sub => !sub.feedUrl).map(sub => ({ id: sub.id, url: sub.seedUrl, enabled: sub.enabled, status: sub.enabled === false ? 'paused' : 'pending', name: sub.name, error: rt.wechatImport?.errors?.[sub.id] || sub.lastError }));
    sendJson(res, 200, { ok: true, ...provider, pending, import: wechatImportView(rt) }); return;
  }
  if (pathname === '/wechat/provider/import' && method === 'POST') {
    const body = await readJsonBody(req);
    const progress = await startWechatImport(rt, body.mode);
    const state = await rt.wechat.status();
    sendJson(res, 202, { ok: true, ...progress, pending: state.subscriptions.filter(sub => !sub.feedUrl), subscriptions: state.subscriptions }); return;
  }
  if (pathname === '/wechat/provider/auth' && (method === 'GET' || method === 'POST')) {
    sendJson(res, 200, { ok: true, ...await (method === 'POST' ? rt.wechatProvider.authCode() : rt.wechatProvider.authStatus()) }); return;
  }
  if (pathname === '/wechat/provider/qr-image' && method === 'GET') {
    const image = await rt.wechatProvider.qrImage();
    res.writeHead(200, { 'content-type': image.mime, 'content-length': image.buffer.length, 'cache-control': 'no-store' }); res.end(image.buffer); return;
  }
  if (pathname === '/wechat/resolve' && method === 'POST') {
    const body = await readJsonBody(req); const account = await rt.wechatProvider.resolve(body.url);
    sendJson(res, 200, { ok: true, account }); return;
  }
  if (pathname === '/wechat/status' && method === 'GET') { sendJson(res, 200, { ...await rt.wechat.status(), checkError: rt.wechatCheckError || '' }); return; }
  if (pathname === '/wechat/articles' && method === 'GET') { sendJson(res, 200, await rt.wechat.articles(Object.fromEntries(search.entries()))); return; }
  if (pathname === '/wechat/article' && method === 'GET') { sendJson(res, 200, await rt.wechat.articleContent(Object.fromEntries(search.entries()))); return; }
  if (pathname === '/wechat/subscriptions' && method === 'POST') { sendJson(res, 200, await rt.wechat.addSubscription(await readJsonBody(req))); return; }
  if (pathname === '/wechat/subscriptions' && method === 'PATCH') { sendJson(res, 200, await rt.wechat.patchSubscription(search.get('id') || '', await readJsonBody(req))); return; }
  if (pathname === '/wechat/subscriptions' && method === 'DELETE') { sendJson(res, 200, await rt.wechat.removeSubscription(search.get('id') || '')); return; }
  if (pathname === '/wechat/settings' && method === 'POST') { sendJson(res, 200, await rt.wechat.configure(await readJsonBody(req))); return; }
  if (pathname === '/wechat/check' && method === 'POST') {
    const body = await readJsonBody(req);
    const job = rt.wechat.check(body);
    if (body.background === true) {
      rt.wechatCheckTask = job; rt.wechatCheckError = '';
      void job.catch(error => { if (!rt.wechatDisposed && rt.wechatCheckTask === job) rt.wechatCheckError = String(error.message || '公众号检查失败，请重试。').slice(0, 200); });
      sendJson(res, 202, { ok: true, running: true });
    } else sendJson(res, 200, await job);
    return;
  }
  if (pathname === '/wechat/read' && method === 'POST') { sendJson(res, 200, await rt.wechat.markRead(await readJsonBody(req))); return; }
  sendError(res, 404, 'NOT_FOUND', '未知的公众号操作。');
}

async function handleRoute(rt, req, res) {
  const { settings, ctx } = rt;
  let pathname = '/';
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    pathname = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const search = url.searchParams;
    const method = req.method || 'GET';

    if (pathname.startsWith('/wechat/')) { await handleWechatRoute(rt, req, res, pathname, search); return; }

    if (method === 'GET' && (pathname === '/' || pathname === '/status')) {
      const library = await readLibrary(settings);
      const sources = await loadSources(settings);
      const entities = await loadEntities(settings);
      const blindspots = await computeBlindspots(settings);
      const sourceNames = {};
      for (const source of sources) if (source.name) sourceNames[source.id] = source.name;
      sendJson(res, 200, {
        ok: true,
        ...summarizeStatus(settings, library, sources),
        ...coverageOf(settings, library, entities),
        sourceNames,
        blindspots: blindspots.length,
        hasCollector: await fileExists(pathsOf(settings).collector),
        webSearch: Boolean(getService(ctx, 'web')),
        generatedAt: new Date().toISOString(),
      });
      return;
    }

    if (method === 'GET' && pathname === '/today') {
      const library = await readLibrary(settings);
      const today = dateKey(new Date());
      const cx = await buildCx(settings);
      const items = library.items
        .filter((item) => dateKey(item?.ts) === today && !isJunk(item))
        .map((item) => decorateItem(item, cx));
      const report = await latestReport(settings);
      sendJson(res, 200, {
        ok: true,
        date: today,
        items,
        run: library.runs[0] || null,
        report: report ? { name: report.name, markdown: report.text } : null,
      });
      return;
    }

    if (method === 'GET' && pathname === '/library') {
      const library = await readLibrary(settings);
      const cx = await buildCx(settings);
      const result = filterLibrary({ ...library, items: library.items.filter((item) => !isJunk(item)) }, Object.fromEntries(search.entries()));
      sendJson(res, 200, { ok: true, total: result.total, items: result.items.map((item) => decorateItem(item, cx)) });
      return;
    }

    if (method === 'GET' && pathname === '/companies') {
      const library = await readLibrary(settings);
      const cx = await buildCx(settings);
      const daysRaw = Number.parseInt(search.get('days') || '30', 10);
      const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 30;
      const cutoff = Date.now() - days * DAY_MS;
      const rows = new Map();
      for (const entity of cx.entities) {
        if ((entity.tier ?? 3) !== 1) continue;
        rows.set(entity.id, {
          id: entity.id,
          name: entity.name,
          counts: { official: 0, papers: 0, media: 0, social: 0 },
          lastAt: 0,
          example: null,
        });
      }
      for (const item of library.items) {
        if (isJunk(item) || isRepositorySource(cx.sourceById.get(item.source))) continue;
        const at = Date.parse(item?.ts || '');
        if (!Number.isFinite(at) || at < cutoff) continue;
        const channel = channelOf(item, cx);
        for (const id of item.entity || []) {
          const row = rows.get(id);
          if (!row) continue;
          row.counts[channel] += 1;
          if (at > row.lastAt) {
            row.lastAt = at;
            row.example = { title: item.titleZh || item.title, url: item.url, ts: item.ts };
          }
        }
      }
      const companies = [...rows.values()].map((row) => ({
        id: row.id,
        name: row.name,
        counts: row.counts,
        total: row.counts.official + row.counts.papers + row.counts.media + row.counts.social,
        lastAt: row.lastAt ? new Date(row.lastAt).toISOString() : null,
        example: row.example,
      }));
      companies.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
      sendJson(res, 200, { ok: true, days, companies });
      return;
    }

    if (method === 'GET' && pathname === '/company-feed') {
      const library = await readLibrary(settings);
      const cx = await buildCx(settings);
      const companyId = search.get('company') || '';
      const daysRaw = Number.parseInt(search.get('days') || '30', 10);
      const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, daysRaw)) : 30;
      const cutoff = Date.now() - days * DAY_MS;
      const t1 = new Set(cx.entities.filter((entity) => (entity.tier ?? 3) === 1).map((entity) => entity.id));
      const channels = { official: [], papers: [], media: [], social: [] };
      for (const item of library.items) {
        if (isJunk(item) || isRepositorySource(cx.sourceById.get(item.source))) continue;
        const at = Date.parse(item?.ts || '');
        if (!Number.isFinite(at) || at < cutoff) continue;
        const ids = (item.entity || []).filter((id) => t1.has(id));
        if (!ids.length) continue;
        if (companyId && !ids.includes(companyId)) continue;
        const decorated = decorateItem(item, cx);
        decorated.channel = channelOf(item, cx);
        decorated.companyNames = ids.map((id) => (cx.entityIndex.get(id) || {}).name || id);
        channels[decorated.channel].push(decorated);
      }
      for (const key of Object.keys(channels)) {
        channels[key].sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
        channels[key] = channels[key].slice(0, 120);
      }
      sendJson(res, 200, { ok: true, days, company: companyId, channels });
      return;
    }

    if (method === 'GET' && pathname === '/trends') {
      const library = await readLibrary(settings);
      const cx = await buildCx(settings);
      const daysRaw = Number.parseInt(search.get('days') || '7', 10);
      const days = Number.isFinite(daysRaw) ? Math.min(60, Math.max(1, daysRaw)) : 7;
      sendJson(res, 200, { ok: true, ...trendsOf(library, cx, days) });
      return;
    }

    if (method === 'GET' && pathname === '/feed') {
      const library = await readLibrary(settings);
      const cx = await buildCx(settings);
      const section = search.get('section') || 'company';
      const daysRaw = Number.parseInt(search.get('days') || '14', 10);
      const days = Number.isFinite(daysRaw) ? Math.min(90, Math.max(1, daysRaw)) : 14;
      const limitRaw = Number.parseInt(search.get('limit') || '200', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, limitRaw)) : 200;
      const cutoff = Date.now() - days * DAY_MS;
      const items = [];
      for (const item of library.items) {
        const at = Date.parse(item?.ts || '');
        if (!Number.isFinite(at) || at < cutoff) continue;
        if (isJunk(item)) continue;
        const decorated = decorateItem(item, cx);
        if (decorated.section !== section) continue;
        items.push(decorated);
        if (items.length >= limit) break;
      }
      sendJson(res, 200, { ok: true, section, days, items });
      return;
    }

    if (method === 'GET' && pathname === '/startups') {
      const library = await readLibrary(settings);
      const cx = await buildCx(settings);
      sendJson(res, 200, { ok: true, ...startupsView(library, cx, search.get('cat') || '') });
      return;
    }

    if (method === 'GET' && pathname === '/blindspots') {
      sendJson(res, 200, { ok: true, items: await computeBlindspots(settings) });
      return;
    }

    if (method === 'GET' && pathname === '/runs') {
      const library = await readLibrary(settings);
      const limitRaw = Number.parseInt(search.get('limit') || '20', 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 20;
      sendJson(res, 200, { ok: true, items: library.runs.slice(0, limit) });
      return;
    }

    if (method === 'POST' && pathname === '/run') {
      const sourceIds = await requestedSourceIds(settings, await readJsonBody(req));
      if (rt.running) {
        sendError(res, 409, 'RUNNING', '上一轮还没跑完，等它结束。');
        return;
      }
      rt.running = true;
      settings.__running = true;
      try {
        const result = await executeRun(rt, 'button', { sourceIds });
        sendJson(res, 200, { ok: true, ...result });
      } finally {
        rt.running = false;
        settings.__running = false;
      }
      return;
    }

    if (method === 'POST' && pathname === '/translate') {
      const body = await readJsonBody(req);
      if (body?.ids !== undefined && (!Array.isArray(body.ids) || !body.ids.length || body.ids.some(id => typeof id !== 'string' || !id.trim()))) {
        sendError(res, 400, 'BAD_REQUEST', 'ids 必须是包含条目 ID 的非空字符串数组。');
        return;
      }
      const ids = body?.ids ? new Set(body.ids.map(id => id.trim())) : null;
      const limitRaw = Number.isFinite(body?.limit) ? Math.floor(body.limit) : 400;
      const limit = Math.min(600, Math.max(1, limitRaw));
      const library = await readLibrary(settings);
      const targets = library.items.filter((item) => item && (!ids || ids.has(item.id)) && item.title && (body?.retranslate === true || !item.titleZh) && !CJK_RE.test(item.title));
      const slice = targets.slice(0, limit).map((item) => ({ ...item, titleZh: undefined }));
      const completed = await translateItems(ctx, slice, { ...settings, translatePerRun: limit });
      let translated = 0;
      if (completed > 0) await updateLibrary(settings, (latest) => {
        const updates = new Map(slice.filter((item) => item.titleZh).map((item) => [item.id, item]));
        for (const item of latest.items) {
          const update = updates.get(item.id);
          if (update && item.title === update.title) {
            item.titleZh = update.titleZh;
            translated += 1;
          }
        }
      });
      sendJson(res, 200, {
        ok: true,
        translated,
        remaining: Math.max(0, targets.length - translated),
      });
      return;
    }

    if (method === 'POST' && pathname === '/search') {
      const body = await readJsonBody(req);
      const query = typeof body?.query === 'string' ? body.query.trim() : '';
      if (!query) {
        sendError(res, 400, 'BAD_REQUEST', 'query 不能为空。');
        return;
      }
      const maxResults = Number.isFinite(body?.maxResults) ? Math.min(8, Math.max(1, body.maxResults)) : 5;
      const result = await searchOnce(ctx, query, maxResults);
      if (!result.ok) {
        sendError(res, 503, 'SEARCH_FAILED', `搜索不可用：${result.reason}`);
        return;
      }
      // 手动搜索也进库，标注 kind=web
      const library = await readLibrary(settings);
      const seen = new Set(library.items.map((item) => item?.id).filter(Boolean));
      const added = [];
      for (const item of result.sources) {
        const url = typeof item?.url === 'string' ? item.url : '';
        if (!url) continue;
        const title = typeof item?.title === 'string' && item.title ? item.title : url;
        const id = sha(`web|${url}|${title}`);
        if (seen.has(id)) continue;
        seen.add(id);
        added.push({
          id,
          kind: 'web',
          line: 'W',
          title,
          url,
          snippet: typeof item?.snippet === 'string' ? item.snippet.slice(0, 400) : '',
          source: 'web:manual',
          entity: [],
          ts: new Date().toISOString(),
          runId: 'manual',
        });
      }
      if (added.length) {
        const committed = await updateLibrary(settings, (latest) => {
          const ids = new Set(latest.items.map((item) => item.id));
          const count = added.filter((item) => !ids.has(item.id)).length;
          latest.items = mergeLibraryItems(added, latest.items);
          return count;
        });
        sendJson(res, 200, { ok: true, sources: result.sources, added: committed });
        return;
      }
      sendJson(res, 200, { ok: true, sources: result.sources, added: added.length });
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `未知路由：${pathname}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'BODY_TOO_LARGE') sendError(res, 413, 'BODY_TOO_LARGE', '请求体过大。');
    else if (message === 'BAD_JSON') sendError(res, 400, 'BAD_JSON', '请求体不是合法 JSON。');
    else if (error && Number.isInteger(error.status) && error.code) sendError(res, error.status, error.code, message);
    else sendError(res, 500, 'INTERNAL', `情报台内部错误：${message}`);
  }
}

// ---------------------------------------------------------------------------
// Agent 工具（与面板按钮同一套实现）
// ---------------------------------------------------------------------------
function renderText(_args, value) {
  return [{ type: 'text', text: String(value ?? '') }];
}

function buildTool(ctx, rt) {
  return {
    name: 'ai_intel',
    description:
      'AI 情报台：查询本地基础库、查看实体盲区、或立刻跑一轮采集 + 搜索补充并写入基础库。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'run', 'library', 'blindspots', 'search'],
          description: 'status=状态摘要；run=跑一轮；library=检索基础库；blindspots=盲区清单；search=手动搜一条。',
        },
        query: { type: 'string', description: 'library 的检索词，或 search 的搜索词。' },
        limit: { type: 'number', description: 'library 返回条数，默认 20，最大 100。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'string' }, render: renderText },
    async execute(args) {
      const { settings } = rt;
      const action = typeof args?.action === 'string' ? args.action : 'status';
      try {
        if (action === 'status') {
          const library = await readLibrary(settings);
          const sources = await loadSources(settings);
          const blindspots = await computeBlindspots(settings);
          const status = summarizeStatus(settings, library, sources);
          return [
            `基础库：${settings.libraryDir}`,
            `条目 ${status.counts.total} 条（今天 ${status.counts.today}，搜索补充 ${status.counts.web}），运行 ${status.counts.runs} 次`,
            `源可用 ${status.counts.sourcesOk}/${status.counts.sourcesTotal}，实体盲区 ${blindspots.length} 个`,
            status.lastRun
              ? `上次运行 ${status.lastRun.finishedAt}：新增事件 ${status.lastRun.added?.events ?? 0}、搜索 ${status.lastRun.added?.web ?? 0}`
              : '还没跑过。',
          ].join('\n');
        }
        if (action === 'run') {
          if (rt.running) return '上一轮还没跑完，等它结束。';
          rt.running = true;
          try {
            const result = await executeRun(rt, 'tool');
            return `跑完了：新增事件 ${result.run.added.events} 条、搜索补充 ${result.run.added.web} 条，基础库累计 ${result.itemCount} 条。报告：${result.run.report || '（无）'}`;
          } finally {
            rt.running = false;
          }
        }
        if (action === 'library') {
          const library = await readLibrary(settings);
          const limit = Number.isFinite(args?.limit) ? Math.min(100, Math.max(1, args.limit)) : 20;
          const result = filterLibrary({ ...library, items: library.items.filter((item) => !isJunk(item)) }, { q: args?.query, limit });
          if (!result.items.length) return '没有匹配的条目。';
          return result.items
            .map((item, index) => `${index + 1}. [${item.kind}/${item.line}] ${item.title} — ${item.source} ${item.url}`)
            .join('\n');
        }
        if (action === 'blindspots') {
          const items = await computeBlindspots(settings);
          if (!items.length) return '没有盲区：所有实体近 7 天都有记录。';
          return items.map((item) => `T${item.tier} ${item.id} ${item.name}`).join('\n');
        }
        if (action === 'search') {
          const query = typeof args?.query === 'string' ? args.query.trim() : '';
          if (!query) return 'search 需要 query。';
          const result = await searchOnce(ctx, query, 5);
          if (!result.ok) return `搜索不可用：${result.reason}`;
          return result.sources.map((item) => `- ${item.title || item.url} ${item.url}`).join('\n') || '没有结果。';
        }
        return `未知 action：${action}`;
      } catch (error) {
        return `情报台操作失败：${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cordis 注册
// ---------------------------------------------------------------------------
export const inject = ['webServer'];

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const rt = { ctx, settings, running: false };
  rt.wechatProvider = createWechatProvider({ privateFile: settings.wechatProviderFile });
  rt.wechat = createWechatMonitor({
    libraryDir: settings.libraryDir,
    allowedFeedOrigins: settings.wechatAllowedFeedOrigins,
    rateLimitOrigins: settings.wechatProviderOrigin ? [settings.wechatProviderOrigin] : [],
    beforeFetch: async subscription => {
      if (settings.wechatProviderOrigin && new URL(subscription.feedUrl).origin === settings.wechatProviderOrigin) await rt.wechatProvider.refresh(subscription.accountId);
    },
    onArticles: async articles => updateLibrary(settings, latest => {
      const known = new Set(latest.items.map(item => canonicalArticleUrl(item.url)).filter(Boolean));
      const incoming = articles.filter(article => { if (known.has(article.url)) return false; known.add(article.url); return true; }).map(article => ({
        id: article.id, kind: 'wechat', line: 'WX', title: article.title, url: article.url, ts: article.publishedAt || article.firstSeenAt,
        published: article.publishedAt, firstSeenAt: article.firstSeenAt, source: 'wechat:' + article.accountId, sourceName: article.accountName, entity: [],
      }));
      latest.items = mergeLibraryItems(incoming, latest.items);
    }),
  });
  ctx.effect(() => {
    let cancelled = false;
    void (async () => {
      for (const seedUrl of settings.wechatSeedArticles) {
        if (cancelled) return;
        await rt.wechat.addSubscription({ seedUrl, mode: 'from-now' }, null, true);
      }
    })().catch(error => { try { console.warn('[dsh-ai-intel] 公众号订阅初始化失败：' + error.message); } catch {} });
    return () => { cancelled = true; rt.wechatDisposed = true; return rt.wechat.dispose(); };
  }, 'dsh-ai-intel: wechat monitor');

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handleRoute(rt, req, res).catch((error) => {
            sendError(res, 500, 'INTERNAL', `情报台内部错误：${error instanceof Error ? error.message : String(error)}`);
          });
        },
      }),
    'dsh-ai-intel: routes',
  );

  const tools = getService(ctx, 'tools');
  if (tools && typeof tools.register === 'function') {
    const definition = buildTool(ctx, rt);
    ctx.effect(() => tools.register(definition), 'dsh-ai-intel: tool');
  }
}
