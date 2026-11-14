/**
 * lib/store.js —— 本地资料库存储层。
 *
 * 一切落在纯文件里，方便整体搬走：
 *   <root>/index.json                    条目索引（列表页只读这个）
 *   <root>/items/<id>/meta.json          元信息
 *   <root>/items/<id>/transcript.json    逐字稿（段落 + 词级时间戳）
 *   <root>/items/<id>/translation.json   中文译文（按段落下标对齐）
 *   <root>/items/<id>/chapters.json      章节与关键片段（可选）
 *   <root>/cache/                        运行期缓存
 *
 * 设计约束：
 *   - 不做增量 patch，整文件原子写（tmp + rename）。
 *   - 索引与文件不一致时以文件为准，下次写入时重建索引。
 *   - 全部函数同步，避免并发写同一文件；长任务在 pipeline 层排队。
 */

import fs from 'node:fs';
import path from 'node:path';

const INDEX_VERSION = 1;

/** 生成稳定 id：来源前缀 + 时间 + 随机。 */
export function makeId(prefix = 'item') {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${stamp}-${rand}`;
}

/** 原子写 JSON。 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/** 读 JSON，损坏或缺失返回 undefined。 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

export function createStore({ rootDir, logger }) {
  const root = rootDir;
  const itemsDir = path.join(root, 'items');
  const cacheDir = path.join(root, 'cache');
  const indexPath = path.join(root, 'index.json');

  function ensure() {
    fs.mkdirSync(itemsDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  function itemDir(id) {
    return path.join(itemsDir, id);
  }

  function readIndex() {
    const raw = readJson(indexPath);
    if (raw && raw.version === INDEX_VERSION && Array.isArray(raw.items)) return raw;
    return { version: INDEX_VERSION, items: [], updatedAt: null };
  }

  function writeIndex(index) {
    writeJson(indexPath, { ...index, updatedAt: new Date().toISOString() });
  }

  /** 目录扫描重建索引（自愈用）。 */
  function rebuildIndex() {
    ensure();
    const items = [];
    for (const name of fs.readdirSync(itemsDir)) {
      const meta = readJson(path.join(itemsDir, name, 'meta.json'));
      if (!meta || !meta.id) continue;
      items.push(summaryOf(meta));
    }
    items.sort((a, b) => String(b.publishedAt || b.createdAt || '').localeCompare(String(a.publishedAt || a.createdAt || '')));
    writeIndex({ version: INDEX_VERSION, items });
    return items;
  }

  function list() {
    const index = readIndex();
    if (!index.items.length && fs.existsSync(itemsDir) && fs.readdirSync(itemsDir).length) {
      return rebuildIndex();
    }
    return index.items;
  }

  function getMeta(id) {
    return readJson(path.join(itemDir(id), 'meta.json'));
  }

  function getTranscript(id) {
    return readJson(path.join(itemDir(id), 'transcript.json'));
  }

  function getTranslation(id) {
    return readJson(path.join(itemDir(id), 'translation.json'));
  }

  function getChapters(id) {
    return readJson(path.join(itemDir(id), 'chapters.json'));
  }

  function saveMeta(meta) {
    ensure();
    const next = { ...meta, updatedAt: new Date().toISOString() };
    writeJson(path.join(itemDir(next.id), 'meta.json'), next);
    upsertIndex(summaryOf(next));
    return next;
  }

  function saveTranscript(id, transcript) {
    writeJson(path.join(itemDir(id), 'transcript.json'), transcript);
  }

  function saveTranslation(id, translation) {
    writeJson(path.join(itemDir(id), 'translation.json'), translation);
  }

  function saveChapters(id, chapters) {
    writeJson(path.join(itemDir(id), 'chapters.json'), chapters);
  }

  function upsertIndex(summary) {
    const index = readIndex();
    const at = index.items.findIndex((it) => it.id === summary.id);
    if (at >= 0) index.items[at] = summary;
    else index.items.push(summary);
    index.items.sort((a, b) => String(b.publishedAt || b.createdAt || '').localeCompare(String(a.publishedAt || a.createdAt || '')));
    writeIndex(index);
  }

  function remove(id) {
    const dir = itemDir(id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    const index = readIndex();
    index.items = index.items.filter((it) => it.id !== id);
    writeIndex(index);
  }

  /**
   * 关键词检索：标题、摘要、原文段落、中文译文。
   * 中文按二元组匹配，英文按不区分大小写子串。
   * 返回命中段落（带时间戳），供阅读页跳转。
   */
  function search(query, { limit = 40 } = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const lower = q.toLowerCase();
    const hits = [];
    for (const summary of list()) {
      const meta = getMeta(summary.id);
      if (!meta) continue;
      const titleHit = String(meta.title || '').toLowerCase().includes(lower) || String(meta.summary || '').toLowerCase().includes(lower);
      const transcript = getTranscript(summary.id);
      const translation = getTranslation(summary.id);
      const matched = [];
      const segments = transcript && Array.isArray(transcript.segments) ? transcript.segments : [];
      for (const seg of segments) {
        const text = String(seg.text || '');
        const zh = translation && translation.segments ? String(translation.segments[seg.i] || '') : '';
        if (text.toLowerCase().includes(lower) || zh.includes(q) || charHit(text, q) || charHit(zh, q)) {
          matched.push({ i: seg.i, startMs: seg.startMs, text, zh });
          if (matched.length >= 6) break;
        }
      }
      if (titleHit || matched.length) hits.push({ ...summary, titleHit, matched });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** 中文/混合文本的宽松命中：按二元组切分后全部出现即算命中。 */
  function charHit(text, q) {
    if (!text) return false;
    if (!/[\u4e00-\u9fa5]/.test(q)) return false;
    if (q.length < 2) return text.includes(q);
    for (let i = 0; i + 2 <= q.length; i += 1) {
      if (!text.includes(q.slice(i, i + 2))) return false;
    }
    return true;
  }

  function stats() {
    const items = list();
    const count = (key) => items.filter((it) => it.status && it.status[key] === 'done').length;
    return { total: items.length, asrDone: count('asr'), translateDone: count('translate') };
  }

  return {
    root,
    ensure,
    itemDir,
    list,
    getMeta,
    getTranscript,
    getTranslation,
    getChapters,
    saveMeta,
    saveTranscript,
    saveTranslation,
    saveChapters,
    remove,
    rebuildIndex,
    search,
    stats,
    cacheDir,
    log: (message) => {
      if (logger && typeof logger.warn === 'function') logger.warn(message);
    },
  };
}

/** 索引里的条目摘要。 */
export function summaryOf(meta) {
  return {
    id: meta.id,
    title: meta.title || '未命名',
    sourceName: meta.sourceName || '',
    kind: meta.kind || 'interview',
    lang: meta.lang || '',
    durationSec: meta.durationSec || 0,
    publishedAt: meta.publishedAt || '',
    createdAt: meta.createdAt || '',
    summary: meta.summary || '',
    speakers: Array.isArray(meta.speakers) ? meta.speakers : [],
    favorite: Boolean(meta.favorite),
    progressMs: Number(meta.progressMs) || 0,
    costCny: Number(meta.costCny) || 0,
    costByMonth: meta.costByMonth || null,
    budgetReservation: meta.budgetReservation || null,
    status: meta.status || {},
  };
}
