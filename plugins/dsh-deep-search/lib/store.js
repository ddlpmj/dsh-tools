/**
 * lib/store.js —— 磁盘持久化（CONTRACT §7）。
 *
 * 目录布局（默认 ~/Documents/DSH工具数据/AI大搜索）：
 *   topics/<id>.json    完整档案（原子写）
 *   topics/<id>.md      render.js 生成的完整 Markdown（render 未就绪时跳过）
 *   index.json          档案摘要索引（缺失/损坏时扫 topics/ 重建）
 *   jobs.json           最近 50 个任务
 *   deep-search.log     JSONL 运行日志
 *   .trash/<id>-<ts>/   删除的档案
 *
 * id 一律先做正则校验再拼路径，防路径穿越。
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { pathsOf, SEARCH_MODES } from './config.js';
import { archiveSummary, normalizeArchive } from './model.js';
import { errorMessage, redactSecrets } from './http.js';

export const TOPIC_ID_RE = /^tp-\d{8}-[a-f0-9]{6}$/;
export const JOB_ID_RE = /^job-\d{8}-[a-f0-9]{6}$/;
const MAX_JOBS = 50;
const MAX_LOG_LINES = 200;

function isTopicId(id) {
  return typeof id === 'string' && TOPIC_ID_RE.test(id);
}

function isJobId(id) {
  return typeof id === 'string' && JOB_ID_RE.test(id);
}

function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function tmpName(file) {
  return `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
}

function sortByUpdatedDesc(a, b) {
  const left = Date.parse(a.updatedAt || a.createdAt || '') || 0;
  const right = Date.parse(b.updatedAt || b.createdAt || '') || 0;
  return right - left;
}

function sortByCreatedDesc(a, b) {
  const left = Date.parse(a.createdAt || '') || 0;
  const right = Date.parse(b.createdAt || '') || 0;
  return right - left;
}

function safeLog() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/**
 * @param {{config:object, model:object, logger?:object, render?:object}} options
 */
export function createStore({ config, model, logger: rawLogger, render } = {}) {
  const logger = rawLogger && typeof rawLogger === 'object' ? rawLogger : safeLog();
  let renderModule;
  const writeChains = new Map();

  function paths() {
    return pathsOf(config);
  }

  function warn(message) {
    try {
      if (typeof logger.warn === 'function') logger.warn(`[store] ${redactSecrets(message)}`);
    } catch {
      /* ignore */
    }
  }

  async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
  }

  async function ensureBase() {
    const { root, topicsDir, trashDir } = paths();
    await ensureDir(root);
    await ensureDir(topicsDir);
    await ensureDir(trashDir);
  }

  async function readJson(file, fallback = null) {
    try {
      const raw = await fsp.readFile(file, 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error && error.code === 'ENOENT') return fallback;
      if (error && error.name === 'SyntaxError') {
        warn(`JSON 损坏：${path.basename(file)}（${errorMessage(error, 120)}）`);
        return fallback;
      }
      warn(`读取失败：${path.basename(file)}（${errorMessage(error, 120)}）`);
      return fallback;
    }
  }

  async function writeJsonAtomic(file, value) {
    await ensureDir(path.dirname(file));
    const tmp = tmpName(file);
    try {
      await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await fsp.rename(tmp, file);
    } catch (error) {
      try {
        await fsp.unlink(tmp);
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  function serialize(key, operation) {
    const previous = writeChains.get(key) || Promise.resolve();
    const next = previous.then(operation, operation);
    writeChains.set(key, next.catch(() => {}));
    return next;
  }

  async function getRenderer() {
    if (render && typeof render.renderArchiveMarkdown === 'function') return render;
    if (renderModule !== undefined) return renderModule;
    try {
      renderModule = await import('./render.js');
    } catch {
      renderModule = null;
    }
    return renderModule;
  }

  async function writeMarkdown(archive) {
    try {
      const renderer = await getRenderer();
      if (!renderer || typeof renderer.renderArchiveMarkdown !== 'function') return;
      const markdown = renderer.renderArchiveMarkdown(archive, { variant: 'full' });
      if (typeof markdown !== 'string' || !markdown.trim()) return;
      const { topicsDir } = paths();
      const file = path.join(topicsDir, `${archive.id}.md`);
      const tmp = tmpName(file);
      await fsp.writeFile(tmp, markdown, 'utf8');
      await fsp.rename(tmp, file);
    } catch (error) {
      warn(`Markdown 写入失败（不影响 JSON）：${errorMessage(error, 200)}`);
    }
  }

  async function scanTopics() {
    const { topicsDir } = paths();
    let names = [];
    try {
      names = await fsp.readdir(topicsDir);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') warn(`扫描 topics 失败：${errorMessage(error, 160)}`);
      return [];
    }
    const ids = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5))
      .filter(isTopicId);
    const summaries = [];
    for (const id of ids) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(topicsDir, `${id}.json`), 'utf8'));
        const archive = normalizeArchive({ ...raw, id });
        summaries.push(archiveSummary(archive));
      } catch (error) {
        warn(`索引重建跳过损坏档案 ${id}：${errorMessage(error, 160)}`);
      }
    }
    return summaries.sort(sortByUpdatedDesc);
  }

  async function readIndex() {
    const { indexFile } = paths();
    const parsed = await readJson(indexFile, null);
    if (!Array.isArray(parsed)) return null;
    const entries = parsed.filter(
      (entry) => entry && typeof entry === 'object' && isTopicId(entry.id) && typeof entry.title === 'string',
    );
    return entries.sort(sortByUpdatedDesc);
  }

  async function rebuildIndex() {
    return serialize('index', async () => {
      const summaries = await scanTopics();
      await writeJsonAtomic(paths().indexFile, summaries);
      return summaries;
    });
  }

  async function listTopics({ q = '', limit = 100 } = {}) {
    let entries = await readIndex();
    if (entries === null) entries = await rebuildIndex();
    const keyword = String(q || '').trim().toLowerCase();
    const filtered = keyword
      ? entries.filter((entry) =>
          [entry.title, entry.query, entry.kind].some((value) =>
            String(value || '').toLowerCase().includes(keyword),
          ),
        )
      : entries;
    const max = Math.max(1, Math.round(Number(limit) || 100));
    return filtered.slice(0, max).map((entry) => ({ ...entry }));
  }

  async function updateIndexEntry(archive) {
    return serialize('index', async () => {
      const { indexFile } = paths();
      let entries = await readJson(indexFile, null);
      if (!Array.isArray(entries)) entries = await scanTopics();
      let summary;
      try {
        summary = archiveSummary(normalizeArchive(archive));
      } catch (error) {
        summary = null;
        warn(`生成索引摘要失败：${errorMessage(error, 160)}`);
      }
      const next = entries.filter((entry) => entry && entry.id !== archive.id);
      if (summary) next.push(summary);
      next.sort(sortByUpdatedDesc);
      await writeJsonAtomic(indexFile, next);
    });
  }

  async function saveTopic(archive) {
    if (!archive || typeof archive !== 'object' || !isTopicId(archive.id)) {
      const error = new Error('档案 id 非法或缺失');
      error.code = 'BAD_REQUEST';
      throw error;
    }
    const { topicsDir } = paths();
    await ensureBase();
    const file = path.join(topicsDir, `${archive.id}.json`);
    await writeJsonAtomic(file, archive);
    await writeMarkdown(archive);
    await updateIndexEntry(archive);
    return archive;
  }

  async function getTopic(id) {
    if (!isTopicId(id)) return null;
    const { topicsDir } = paths();
    const raw = await readJson(path.join(topicsDir, `${id}.json`), null);
    if (!raw || typeof raw !== 'object') return null;
    try {
      const archive = normalizeArchive({ ...raw, id });
      return archive;
    } catch (error) {
      warn(`档案解析失败 ${id}：${errorMessage(error, 200)}`);
      return null;
    }
  }

  async function deleteTopic(id) {
    if (!isTopicId(id)) return null;
    const archive = await getTopic(id);
    if (!archive) return null;
    const { topicsDir, trashDir } = paths();
    const target = path.join(trashDir, `${id}-${compactTimestamp()}`);
    await ensureDir(target);
    const moved = [];
    for (const ext of ['json', 'md']) {
      const from = path.join(topicsDir, `${id}.${ext}`);
      try {
        await fsp.rename(from, path.join(target, `${id}.${ext}`));
        moved.push(ext);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') warn(`移入回收站失败 ${id}.${ext}：${errorMessage(error, 160)}`);
      }
    }
    await serialize('index', async () => {
      const { indexFile } = paths();
      const entries = (await readJson(indexFile, null)) || (await scanTopics());
      const next = entries.filter((entry) => entry && entry.id !== id);
      await writeJsonAtomic(indexFile, next);
    });
    try {
      await fsp.writeFile(
        path.join(target, 'meta.json'),
        `${JSON.stringify({ id, deletedAt: new Date().toISOString(), title: archive.topic.title, moved }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      /* 元数据失败不影响删除 */
    }
    return { id, trashDir: target, moved };
  }

  async function listJobs() {
    const { jobsFile } = paths();
    const parsed = await readJson(jobsFile, []);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((job) => job && typeof job === 'object' && isJobId(job.id))
      .sort(sortByCreatedDesc)
      .slice(0, MAX_JOBS)
      .map((job) => ({ ...job }));
  }

  async function getJob(id) {
    if (!isJobId(id)) return null;
    const jobs = await listJobs();
    return jobs.find((job) => job.id === id) || null;
  }

  function sanitizeJob(job) {
    const statuses = ['queued', 'running', 'done', 'partial', 'failed', 'canceled'];
    const levels = ['info', 'warn', 'error'];
    const log = Array.isArray(job.log)
      ? job.log.slice(-MAX_LOG_LINES).map((entry) => ({
          at: typeof entry?.at === 'string' ? entry.at : new Date().toISOString(),
          level: levels.includes(entry?.level) ? entry.level : 'info',
          text: String(entry?.text ?? '').slice(0, 1000),
        }))
      : [];
    const current = job.current && typeof job.current === 'object' ? job.current : {};
    return {
      id: job.id,
      topicId: String(job.topicId || ''),
      kind: ['initial', 'followup', 'refresh'].includes(job.kind) ? job.kind : 'initial',
      searchProviderMode: SEARCH_MODES.includes(job.searchProviderMode) ? job.searchProviderMode : undefined,
      anySearchTag: typeof job.anySearchTag === 'string' ? job.anySearchTag.slice(0, 100) : undefined,
      status: statuses.includes(job.status) ? job.status : 'queued',
      stage: String(job.stage || 'framing').slice(0, 40),
      progress: Math.min(100, Math.max(0, Number(job.progress) || 0)),
      current: {
        index: Math.max(0, Number(current.index) || 0),
        total: Math.max(0, Number(current.total) || 0),
        label: String(current.label || '').slice(0, 300),
      },
      log,
      error: String(job.error || '').slice(0, 1200),
      createdAt: typeof job.createdAt === 'string' ? job.createdAt : new Date().toISOString(),
      startedAt: typeof job.startedAt === 'string' ? job.startedAt : '',
      finishedAt: typeof job.finishedAt === 'string' ? job.finishedAt : '',
    };
  }

  async function saveJob(job) {
    if (!job || !isJobId(job.id)) {
      const error = new Error('任务 id 非法或缺失');
      error.code = 'BAD_REQUEST';
      throw error;
    }
    return serialize('jobs', async () => {
      const { jobsFile } = paths();
      const existing = await readJson(jobsFile, []);
      const list = Array.isArray(existing) ? existing.filter((item) => item && isJobId(item.id)) : [];
      const record = sanitizeJob(job);
      const next = list.filter((item) => item.id !== record.id);
      next.push(record);
      next.sort(sortByCreatedDesc);
      await writeJsonAtomic(jobsFile, next.slice(0, MAX_JOBS));
      return record;
    });
  }

  async function appendLog(entry = {}) {
    try {
      const { logFile } = paths();
      await ensureBase();
      const line = {
        at: typeof entry.at === 'string' ? entry.at : new Date().toISOString(),
        level: ['info', 'warn', 'error'].includes(entry.level) ? entry.level : 'info',
        text: String(entry.text ?? '').slice(0, 2000),
      };
      await fsp.appendFile(logFile, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      warn(`写日志失败：${errorMessage(error, 160)}`);
    }
  }

  async function readSettings() {
    const { root } = paths();
    const parsed = await readJson(path.join(root, 'settings.json'), null);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  }

  async function writeSettings(settings) {
    const { root } = paths();
    await ensureDir(root);
    await writeJsonAtomic(path.join(root, 'settings.json'), settings);
  }

  async function init() {
    await ensureBase();
  }

  return {
    init,
    get dataRoot() {
      return paths().root;
    },
    pathsOf: () => paths(),
    listTopics,
    getTopic,
    saveTopic,
    deleteTopic,
    listJobs,
    getJob,
    saveJob,
    appendLog,
    readSettings,
    writeSettings,
    rebuildIndex,
  };
}
