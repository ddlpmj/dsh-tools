/**
 * lib/jobs.js —— 串行任务队列（CONTRACT §3.6 / §7）。
 *
 * 状态机：queued → running → done | partial | failed | canceled
 *  - 最多 maxActive 个并发；默认 1（避免 token 风暴）；
 *  - pipeline 只操作 live job 的 stage()/log()/current() 方法，落盘由队列负责（节流 + 终态立即写）；
 *  - job.cancel() / queue.cancel(id) → abort，running 任务由 signal 或终态判断收敛；
 *  - dispose() abort 全部并停止派发。
 *
 * live job 对外形状（方法与只读属性）：
 *   job.id / topicId / kind / createdAt / searchProviderMode / anySearch（后两项可选）
 *   job.stage(name, progress?, label?)
 *   job.log(level, text)
 *   job.current(index, total, label?)
 *   job.cancel() → boolean
 *   job.status / job.progress / job.error / job.startedAt / job.finishedAt（只读属性）
 * queue.get/list 返回与 CONTRACT §3.6 一致的纯 JSON 快照（stage/progress/current/log 都是值）。
 */

import { newJobId } from './model.js';
import { errorMessage, redactSecrets } from './http.js';

const MAX_LOG_ENTRIES = 200;
const PERSIST_DEBOUNCE_MS = 250;
const TERMINAL_STATUSES = new Set(['done', 'partial', 'failed', 'canceled']);

function nowIso() {
  return new Date().toISOString();
}

function safeLogger(logger) {
  return {
    info: (message) => {
      try {
        if (logger && typeof logger.info === 'function') logger.info(message);
      } catch {
        /* ignore */
      }
    },
    warn: (message) => {
      try {
        if (logger && typeof logger.warn === 'function') logger.warn(message);
      } catch {
        /* ignore */
      }
    },
    error: (message) => {
      try {
        if (logger && typeof logger.error === 'function') logger.error(message);
      } catch {
        /* ignore */
      }
    },
  };
}

function snapshot(rt) {
  const state = rt.state;
  return {
    id: rt.job.id,
    topicId: rt.job.topicId,
    kind: rt.job.kind,
    searchProviderMode: rt.job.searchProviderMode,
    anySearchTag: rt.job.anySearch?.tag,
    status: state.status,
    stage: state.stage,
    progress: state.progress,
    current: { ...state.current },
    log: state.log.map((entry) => ({ ...entry })),
    error: state.error,
    createdAt: rt.job.createdAt,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
  };
}

/**
 * @param {{store:object, logger?:object, maxActive?:number}} options
 */
export function createJobQueue({ store, logger, maxActive = 1 } = {}) {
  const log = safeLogger(logger);
  let maxActiveNow = Math.max(1, Math.round(Number(maxActive) || 1));
  const live = new Map();
  const pending = [];
  let active = 0;
  let disposed = false;

  function persist(rt, { immediate = false } = {}) {
    if (!store || typeof store.saveJob !== 'function') return Promise.resolve();
    const write = () => store.saveJob(snapshot(rt)).catch((error) => log.warn(`[jobs] 落盘失败：${errorMessage(error, 160)}`));
    if (immediate) {
      if (rt.persistTimer) {
        clearTimeout(rt.persistTimer);
        rt.persistTimer = null;
      }
      return write();
    }
    if (rt.persistTimer) return Promise.resolve();
    rt.persistTimer = setTimeout(() => {
      rt.persistTimer = null;
      write();
    }, PERSIST_DEBOUNCE_MS);
    if (typeof rt.persistTimer.unref === 'function') rt.persistTimer.unref();
    return Promise.resolve();
  }

  function appendLog(rt, level, text) {
    const entry = {
      at: nowIso(),
      level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
      text: String(text ?? '').slice(0, 1000),
    };
    rt.state.log.push(entry);
    if (rt.state.log.length > MAX_LOG_ENTRIES) rt.state.log.splice(0, rt.state.log.length - MAX_LOG_ENTRIES);
    if (entry.level === 'error') log.error(`[${rt.job.id}] ${entry.text}`);
    else if (entry.level === 'warn') log.warn(`[${rt.job.id}] ${entry.text}`);
  }

  function defineReadonly(target, name, getter) {
    Object.defineProperty(target, name, {
      get: getter,
      set: (value) => {
        if (name === 'status' || name === 'progress' || name === 'error') {
          // 允许 pipeline 写终态标记，但仍以队列状态机为主
          if (name === 'status' && TERMINAL_STATUSES.has(String(value))) rtRef(target).state.status = String(value);
          else if (name === 'progress') rtRef(target).state.progress = Math.min(100, Math.max(0, Number(value) || 0));
          else rtRef(target).state.error = String(value || '');
        }
      },
      enumerable: true,
      configurable: true,
    });
  }

  const refs = new WeakMap();
  function rtRef(job) {
    return refs.get(job);
  }

  function attachJob(rt) {
    const job = rt.job;
    refs.set(job, rt);
    const methods = {
      stage(stage, progress, label) {
        if (typeof stage === 'string' && stage.trim()) rt.state.stage = stage.trim().slice(0, 40);
        if (Number.isFinite(Number(progress))) rt.state.progress = Math.min(100, Math.max(0, Math.round(Number(progress))));
        if (typeof label === 'string' && label.trim()) rt.state.current.label = label.trim().slice(0, 300);
        persist(rt);
        return job;
      },
      log(level, text) {
        appendLog(rt, level, text);
        persist(rt);
        return job;
      },
      current(index, total, label) {
        rt.state.current = {
          index: Math.max(0, Math.round(Number(index) || 0)),
          total: Math.max(0, Math.round(Number(total) || 0)),
          label: typeof label === 'string' ? label.slice(0, 300) : rt.state.current.label,
        };
        persist(rt);
        return job;
      },
      cancel() {
        return cancel(job.id);
      },
    };
    Object.assign(job, methods);
    defineReadonly(job, 'status', () => rt.state.status);
    defineReadonly(job, 'progress', () => rt.state.progress);
    defineReadonly(job, 'error', () => rt.state.error);
    defineReadonly(job, 'startedAt', () => rt.state.startedAt);
    defineReadonly(job, 'finishedAt', () => rt.state.finishedAt);
    defineReadonly(job, 'stageName', () => rt.state.stage);
    return job;
  }

  function finalize(rt, status) {
    const state = rt.state;
    if (rt.finalized) return;
    rt.finalized = true;
    state.status = status;
    state.finishedAt = nowIso();
    if (status === 'done' || status === 'partial') {
      state.progress = 100;
      state.stage = 'done';
      state.current = { index: state.current.total, total: state.current.total, label: status === 'partial' ? '部分完成' : '完成' };
    } else if (status === 'canceled') {
      state.stage = 'done';
      state.current = { index: state.current.index, total: state.current.total, label: '已取消' };
    } else {
      state.current = { index: state.current.index, total: state.current.total, label: state.current.label || '任务失败' };
      if (!state.error) state.error = '任务失败';
      log.warn(`[${rt.job.id}] 失败：${state.error}`);
    }
    persist(rt, { immediate: true });
  }

  function start(rt) {
    const state = rt.state;
    state.status = 'running';
    state.startedAt = nowIso();
    const controller = new AbortController();
    rt.controller = controller;
    active += 1;
    persist(rt, { immediate: true });
    Promise.resolve()
      .then(() => rt.task(rt.job, controller.signal))
      .then((result) => {
        if (rt.canceled || controller.signal.aborted || disposed) {
          finalize(rt, 'canceled');
          return;
        }
        const flagged =
          result === 'partial' ||
          (result && typeof result === 'object' && (result.status === 'partial' || result.partial === true)) ||
          rt.partial === true;
        finalize(rt, flagged ? 'partial' : 'done');
      })
      .catch((error) => {
        if (rt.canceled || controller.signal.aborted || disposed) {
          finalize(rt, 'canceled');
          return;
        }
        const message = redactSecrets(errorMessage(error, 1000));
        if (!state.error) state.error = message;
        appendLog(rt, 'error', message);
        finalize(rt, 'failed');
      })
      .finally(() => {
        active = Math.max(0, active - 1);
        rt.controller = null;
        pump();
      });
  }

  function pump() {
    if (disposed) return;
    while (active < maxActiveNow && pending.length > 0) {
      const rt = pending.shift();
      if (!rt || rt.canceled || TERMINAL_STATUSES.has(rt.state.status)) continue;
      start(rt);
    }
  }

  function enqueue({ topicId, kind = 'initial', searchProviderMode, anySearch, task } = {}) {
    if (typeof task !== 'function') throw new Error('enqueue 需要 task(job, signal) 函数');
    if (disposed) throw new Error('任务队列已释放');
    const job = {
      id: newJobId(),
      topicId: String(topicId || ''),
      kind: ['initial', 'followup', 'refresh'].includes(kind) ? kind : 'initial',
      searchProviderMode,
      anySearch,
      createdAt: nowIso(),
    };
    const rt = {
      job,
      task,
      controller: null,
      canceled: false,
      finalized: false,
      partial: false,
      persistTimer: null,
      state: {
        status: 'queued',
        stage: 'framing',
        progress: 0,
        current: { index: 0, total: 0, label: '排队中' },
        log: [],
        error: '',
        startedAt: '',
        finishedAt: '',
      },
    };
    attachJob(rt);
    live.set(job.id, rt);
    pending.push(rt);
    persist(rt, { immediate: true });
    const kick = setTimeout(() => {
      if (!disposed && rt.state.status === 'queued' && !rt.canceled) pump();
    }, 0);
    if (typeof kick.unref === 'function') kick.unref();
    return job;
  }

  function cancel(id) {
    const key = String(id || '');
    const rt = live.get(key);
    if (!rt) return false;
    if (rt.finalized || TERMINAL_STATUSES.has(rt.state.status)) return false;
    rt.canceled = true;
    const index = pending.indexOf(rt);
    if (index >= 0) {
      pending.splice(index, 1);
      finalize(rt, 'canceled');
      return true;
    }
    if (rt.state.status === 'running') {
      rt.state.status = 'canceled';
      rt.state.finishedAt = nowIso();
      rt.state.stage = 'done';
      rt.state.current = { index: rt.state.current.index, total: rt.state.current.total, label: '已取消' };
      appendLog(rt, 'warn', '任务已取消');
      persist(rt, { immediate: true });
      try {
        if (rt.controller) rt.controller.abort();
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  async function get(id) {
    const key = String(id || '');
    const rt = live.get(key);
    if (rt) return snapshot(rt);
    if (store && typeof store.getJob === 'function') {
      try {
        return await store.getJob(key);
      } catch (error) {
        log.warn(`[jobs] 读取任务失败：${errorMessage(error, 160)}`);
      }
    }
    return null;
  }

  async function list() {
    const records = new Map();
    if (store && typeof store.listJobs === 'function') {
      try {
        for (const job of await store.listJobs()) records.set(job.id, job);
      } catch (error) {
        log.warn(`[jobs] 读取任务列表失败：${errorMessage(error, 160)}`);
      }
    }
    for (const rt of live.values()) records.set(rt.job.id, snapshot(rt));
    return [...records.values()].sort((a, b) => (Date.parse(b.createdAt || '') || 0) - (Date.parse(a.createdAt || '') || 0));
  }

  function hasActive(topicId = '') {
    const target = String(topicId || '');
    for (const rt of live.values()) {
      if (rt.job.topicId !== target) continue;
      if (rt.state.status === 'queued' || rt.state.status === 'running') return true;
    }
    return false;
  }

  function counts() {
    let running = 0;
    let queued = 0;
    for (const rt of live.values()) {
      if (rt.state.status === 'running') running += 1;
      else if (rt.state.status === 'queued') queued += 1;
    }
    return { active, running, queued, live: live.size };
  }

  async function dispose() {
    disposed = true;
    pending.length = 0;
    const writes = [];
    for (const rt of live.values()) {
      rt.canceled = true;
      try {
        if (rt.controller) rt.controller.abort();
      } catch {
        /* ignore */
      }
      if (!TERMINAL_STATUSES.has(rt.state.status)) {
        rt.state.status = 'canceled';
        rt.state.finishedAt = nowIso();
        rt.state.stage = 'done';
        rt.state.current = { index: rt.state.current.index, total: rt.state.current.total, label: '已取消（插件卸载）' };
      }
      writes.push(persist(rt, { immediate: true }));
    }
    await Promise.allSettled(writes);
  }

  function setMaxActive(value) {
    maxActiveNow = Math.max(1, Math.round(Number(value) || 1));
    pump();
  }

  function markPartial(id) {
    const rt = live.get(String(id || ''));
    if (rt) rt.partial = true;
  }

  return { enqueue, get, list, cancel, dispose, hasActive, counts, setMaxActive, markPartial, snapshot: (id) => {
    const rt = live.get(String(id || ''));
    return rt ? snapshot(rt) : null;
  } };
}
