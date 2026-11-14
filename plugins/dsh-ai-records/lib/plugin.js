/**
 * lib/plugin.js —— 宿主侧运行时：存储、任务、HTTP 路由。
 *
 * 路由（前缀 /dsh-ai-records）：
 *   GET  /health                 运行状态与统计
 *   GET  /items                  索引列表 + 统计
 *   GET  /items/:id              单条：meta + transcript + translation + chapters
 *   GET  /search?q=              跨条目检索（返回命中段落与时间戳）
 *   POST /ingest                 入队一条音频 URL（可选 title/sourceName/kind/lang）
 *   POST /items/:id/translate    补译缺失段落
 *   DELETE /items/:id            删除条目
 *
 * 任务在进程内排队，一次跑一条；状态写回 meta.status，面板可轮询。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createStore, makeId } from './store.js';
import { createAsr } from './asr.js';
import { createTranslator } from './translate.js';
import { createOss, readOssEnv } from './oss.js';
import { createSources, dedupeCandidates, normalizeTitle, resolveYtDlp } from './sources.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const PLUGIN_NAME = 'dsh-ai-records';
export const ROUTE_PREFIX = '/dsh-ai-records';

const DEFAULT_ROOT = path.join(os.homedir(), 'Documents', 'DSH工具数据', 'AI访谈档案');
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** 读本地 env 文件里的 key（不回显、不落日志）。 */
function readKeyFromFile(file) {
  if (!file) return '';
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = /^\s*(?:export\s+)?DASHSCOPE_API_KEY\s*=\s*(.+?)\s*$/m.exec(text);
    return match ? match[1].replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

/** 从标题里猜人物：`标题 | 嘉宾` 这种格式最常见，取最后一段。 */
export function guessSpeakers(title) {
  const parts = String(title || '').split(/[|｜]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const last = parts[parts.length - 1];
  if (last.length > 40) return [];
  if (/^\d+$/.test(last)) return [];
  return [last];
}

export function createRuntime({ ctx, config = {}, deps = {} }) {
  const logger = deps.logger || console;
  const origin = typeof deps.origin === 'function' ? deps.origin : () => 'http://127.0.0.1:57810';
  const rootDir = config.rootDir ? String(config.rootDir) : DEFAULT_ROOT;

  const asrApiKey = String(config.asrApiKey || '') || readKeyFromFile(config.asrKeyFile);

  const ossConfig = config.ossBucket
    ? { bucket: config.ossBucket, endpoint: config.ossEndpoint, accessKeyId: config.ossAccessKeyId, accessKeySecret: config.ossAccessKeySecret }
    : config.ossEnvFile ? readOssEnv(config.ossEnvFile, fs) : null;
  const oss = deps.oss || (ossConfig && ossConfig.bucket ? createOss({ ...ossConfig, logger }) : null);

  const store = createStore({ rootDir, logger });
  const sources = createSources({ rootDir, logger });
  const asr = createAsr({
    config: { ...config, asrApiKey },
    logger,
  });
  const translator = createTranslator({
    services: { get: (name) => safeGet(ctx, name) },
    config,
    logger,
  });

  /** 进程内任务表。 */
  const jobs = new Map();
  const queue = [];
  let running = false;
  let disposed = false;

  function safeGet(context, name) {
    try {
      return typeof context?.get === 'function' ? context.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  function publicJobs() {
    return [...jobs.values()]
      .map((job) => ({
        id: job.id,
        itemId: job.itemId,
        title: job.title,
        stage: job.stage,
        progress: job.progress,
        error: job.error || '',
        startedAt: job.startedAt,
        finishedAt: job.finishedAt || '',
      }))
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }

  function patchMeta(itemId, patch) {
    const meta = store.getMeta(itemId);
    if (!meta) return undefined;
    return store.saveMeta({ ...meta, ...patch, status: { ...(meta.status || {}), ...(patch.status || {}) } });
  }

  /** 入队一条音频 URL。 */
  function enqueue(input, downloadJob = null) {
    const now = new Date().toISOString();
    const id = String(input.id || '') || makeId('ep');
    if ([...jobs.values()].some((job) => job !== downloadJob && job.itemId === id && !['done', 'failed'].includes(job.stage))) {
      throw new Error('这条已有任务在运行，请等它结束再重试');
    }
    const previous = store.getMeta(id) || {};
    const meta = {
      ...previous,
      id,
      title: String(input.title || '').trim() || '待补充标题',
      sourceName: String(input.sourceName || '').trim(),
      sourceUrl: String(input.sourceUrl || '').trim(),
      mediaUrl: String(input.mediaUrl || '').trim(),
      kind: String(input.kind || 'interview'),
      lang: String(input.lang || ''),
      summary: '',
      durationSec: Number(input.durationSec || previous.durationSec) || 0,
      publishedAt: String(input.publishedAt || ''),
      mediaFile: String(input.mediaFile || ''),
      speakers: Array.isArray(input.speakers) && input.speakers.length ? input.speakers.map((x) => String(x).trim()).filter(Boolean) : guessSpeakers(String(input.title || '')),
      createdAt: previous.createdAt || now,
      status: { asr: 'pending', translate: 'pending' },
      engine: { asr: asr.model },
    };
    meta.budgetReservation = reserveBudget(id, estimateCost(meta));
    if (input.copySource) {
      const ext = path.extname(String(input.copySource)).toLowerCase() || '.mp3';
      const target = path.join(store.itemDir(id), `audio${ext}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(String(input.copySource), target);
      meta.mediaFile = `audio${ext}`;
    }
    store.saveMeta(meta);

    const job = downloadJob || {
      id: makeId('job'),
      itemId: id,
      title: meta.title,
      stage: 'queued',
      progress: 0,
      startedAt: now,
      error: '',
    };
    job.stage = 'queued';
    job.progress = 0;
    jobs.set(job.id, job);
    queue.push({ job, meta });
    void pump();
    return { item: meta, job };
  }

  async function pump() {
    if (running || disposed) return;
    running = true;
    try {
      while (queue.length && !disposed) {
        const next = queue.shift();
        try {
          await runJob(next.job, next.meta);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          next.job.stage = 'failed';
          next.job.error = message;
          next.job.finishedAt = new Date().toISOString();
          const meta = store.getMeta(next.job.itemId);
          patchMeta(next.job.itemId, { status: meta?.status?.asr === 'done' ? { translate: 'failed' } : { asr: 'failed' } });
          if (logger && logger.warn) logger.warn(`[ai-records] 任务失败：${message}`);
        } finally {
          releaseBudget(next.job.itemId);
        }
      }
    } finally {
      running = false;
    }
  }

  /**
   * 解析出 ASR 能取到的音频地址：
   *   1) 元数据里已有的公网链接直接用；
   *   2) 本地文件 + OSS 配置 → 上传后给签名链接，转写完删除对象。
   */
  const CONTENT_TYPES = { '.mp3': 'audio/mpeg', '.opus': 'audio/ogg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.wav': 'audio/wav' };

  async function resolveAudio(meta) {
    if (/^https?:/i.test(String(meta.mediaUrl || ''))) {
      return { url: meta.mediaUrl, cleanup: async () => {} };
    }
    if (!meta.mediaFile) throw new Error('这条没有音频：既没有公网链接，也没有本地文件');
    const file = path.join(store.itemDir(meta.id), path.basename(String(meta.mediaFile)));
    if (!fs.existsSync(file)) throw new Error(`本地音频不存在：${path.basename(String(meta.mediaFile))}`);
    if (!oss) throw new Error('上传音频需要 OSS 配置。请在插件设置中指定 ossEnvFile 或填写 OSS 连接参数。');
    const ext = path.extname(file).toLowerCase();
    const key = `audio/${meta.id}${ext || '.mp3'}`;
    await oss.putObject(key, fs.readFileSync(file), CONTENT_TYPES[ext] || 'application/octet-stream');
    return {
      url: oss.signedUrl(key, 21600),
      cleanup: async () => {
        try {
          await oss.deleteObject(key);
        } catch (error) {
          if (logger && logger.warn) logger.warn(`[ai-records] 清理 OSS 对象失败：${error && error.message ? error.message : String(error)}`);
        }
      },
    };
  }

  async function runJob(job, meta) {
    // 排队期间其它任务的实际估算可能增加；在下一次付费请求前重新检查。
    patchMeta(meta.id, { budgetReservation: reserveBudget(meta.id, estimateCost(meta)) });
    job.stage = 'asr';
    job.progress = 5;
    patchMeta(meta.id, { status: { asr: 'running' } });

    const audio = await resolveAudio(meta);
    let result;
    try {
      result = await asr.transcribeUrl(audio.url, {
        onStage: (stage) => {
          job.stage = stage === 'submit' ? 'asr:submit' : stage === 'poll' ? 'asr:poll' : stage === 'fetch' ? 'asr:fetch' : `asr:${stage}`;
          job.progress = Math.min(70, job.progress + 3);
        },
      });
    } finally {
      if (typeof audio.cleanup === 'function') await audio.cleanup();
    }

    const transcript = {
      formatVersion: 1,
      engine: asr.model,
      lang: meta.lang || result.lang || '',
      durationSec: result.durationSec || 0,
      segments: result.segments,
    };
    store.saveTranscript(meta.id, transcript);
    recordCost(meta.id, (transcript.durationSec / 3600) * ASR_YUAN_PER_HOUR);
    job.progress = 72;
    job.stage = 'translate';
    patchMeta(meta.id, {
      durationSec: transcript.durationSec,
      status: { asr: 'done', translate: 'running' },
    });

    // 中文节目不需要再翻成中文：直接跳过，省时间也省钱
    if (/^zh/i.test(String(meta.lang || ''))) {
      store.saveTranslation(meta.id, { formatVersion: 1, target: 'zh', segments: [], skipped: true });
      patchMeta(meta.id, { status: { translate: 'skipped' } });
      job.progress = 96;
    } else {
      patchMeta(meta.id, { budgetReservation: reserveBudget(meta.id, translationCost(transcript.segments.length)) });
      const { segments, failed } = await translator.translateSegments(
        transcript.segments.map((seg) => ({ i: seg.i, text: seg.text })),
        {
          title: meta.title,
          onProgress: (done, total) => {
            job.progress = 72 + Math.round((done / Math.max(1, total)) * 26);
          },
        },
      );

      recordCost(meta.id, translationCost(transcript.segments.length));

      store.saveTranslation(meta.id, { formatVersion: 1, target: 'zh', segments });
      const status = failed.length ? 'partial' : 'done';
      patchMeta(meta.id, { status: { translate: status } });
    }

    releaseBudget(meta.id);
    job.stage = 'profile';
    job.progress = 96;
    try {
      await profileItem(meta.id);
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 主持/嘉宾识别失败：${error && error.message ? error.message : String(error)}`);
    }

    job.stage = 'summary';
    job.progress = 97;
    try {
      await summarizeItem(meta.id);
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 摘要生成失败：${error && error.message ? error.message : String(error)}`);
    }
    job.stage = 'chapters';
    job.progress = 99;
    try {
      await outlineItem(meta.id);
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 章节生成失败：${error && error.message ? error.message : String(error)}`);
    }

    job.stage = 'done';
    job.progress = 100;
    job.finishedAt = new Date().toISOString();
  }

  /** 补译：只处理空译文段落。 */
  function retranslate(itemId) {
    const meta = store.getMeta(itemId);
    const transcript = store.getTranscript(itemId);
    if (!meta || !transcript) return { ok: false, error: '条目或逐字稿不存在' };
    const existing = store.getTranslation(itemId);
    const current = existing && Array.isArray(existing.segments) ? existing.segments : [];
    const pending = transcript.segments.filter((seg) => !current[seg.i]);
    if (!pending.length) return { ok: true, translated: 0 };
    if ([...jobs.values()].some((job) => job.itemId === itemId && !['done', 'failed'].includes(job.stage))) {
      return { ok: false, error: '这条已有任务在运行，请等它结束再补译' };
    }
    const reservation = reserveBudget(itemId, translationCost(pending.length));
    const job = {
      id: makeId('job'),
      itemId,
      title: meta.title,
      stage: 'translate',
      progress: 0,
      startedAt: new Date().toISOString(),
      error: '',
    };
    jobs.set(job.id, job);
    patchMeta(itemId, { status: { translate: 'running' }, budgetReservation: reservation });
    void (async () => {
      try {
        const { segments, failed } = await translator.translateSegments(
          pending.map((seg) => ({ i: seg.i, text: seg.text })),
          {
            title: meta.title,
            onProgress: (done, total) => {
              job.progress = Math.round((done / Math.max(1, total)) * 100);
            },
          },
        );
        recordCost(itemId, translationCost(pending.length));
        const merged = current.slice();
        pending.forEach((seg, n) => {
          if (segments[n]) merged[seg.i] = segments[n];
        });
        store.saveTranslation(itemId, { formatVersion: 1, target: 'zh', segments: merged });
        patchMeta(itemId, { status: { translate: failed.length ? 'partial' : 'done' } });
        job.stage = 'done';
        job.progress = 100;
      } catch (error) {
        job.stage = 'failed';
        job.error = error && error.message ? error.message : String(error);
        patchMeta(itemId, { status: { translate: 'failed' } });
      } finally {
        releaseBudget(itemId);
        job.finishedAt = new Date().toISOString();
      }
    })();
    return { ok: true, translated: pending.length, jobId: job.id };
  }

  /** 取节选：开头 14 段 + 均匀抽 8 段 + 结尾 8 段，翻译优先。 */
  function buildSample(transcript, translation) {
    const segments = transcript && transcript.segments ? transcript.segments : [];
    if (!segments.length) return '';
    const zh = translation && translation.segments ? translation.segments : [];
    const pick = (index) => zh[segments[index].i] || segments[index].text;
    const picked = new Set();
    segments.slice(0, 14).forEach((_, index) => picked.add(index));
    const step = Math.max(1, Math.floor(segments.length / 9));
    for (let index = Math.floor(step / 2); index < segments.length - 8; index += step) picked.add(index);
    const tailStart = Math.max(0, segments.length - 8);
    segments.slice(tailStart).forEach((_, offset) => picked.add(tailStart + offset));
    return [...picked]
      .sort((a, b) => a - b)
      .map((index) => `[${Math.round(segments[index].startMs / 1000)}s] ${pick(index)}`)
      .join('\n');
  }

  /** 取节目页面的官方描述：YouTube 走 yt-dlp，其它站抓 HTML 去标签。 */
  async function fetchSourceText(meta) {
    const url = String(meta.sourceUrl || '');
    if (!/^https?:/i.test(url)) return '';
    try {
      if (/youtube\.com|youtu\.be/i.test(url)) {
        const { stdout } = await execFileAsync(resolveYtDlp(), ['--no-warnings', '--skip-download', '--print', '%(description)s', url], { timeout: 90000, maxBuffer: 4 * 1024 * 1024 });
        return stdout.trim().slice(0, 6000);
      }
      const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) return '';
      const html = await response.text();
      const desc = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i.exec(html);
      const body = desc ? desc[1] : html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
      return body.replace(/\s+/g, ' ').trim().slice(0, 6000);
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 取页面描述失败：${error && error.message ? error.message : String(error)}`);
      return '';
    }
  }

  /** 认主持人和嘉宾，写回 meta。 */
  async function profileItem(itemId, { signal } = {}) {
    const meta = store.getMeta(itemId);
    if (!meta) throw new Error('条目不存在');
    requireModelBudget();
    const description = await fetchSourceText(meta);
    if (!description) return { host: '', guests: [], org: '' };
    const result = await translator.profile({ title: meta.title, description, showName: meta.sourceName, signal });
    const current = store.getMeta(itemId);
    if (!current) throw new Error('条目已被删除');
    const next = { host: result.host, guests: result.guests, org: result.org };
    if (result.guests.length) {
      const merged = new Set([...(current.speakers || []), ...result.guests, ...(result.host ? [result.host] : [])]);
      next.speakers = [...merged].filter(Boolean);
    }
    patchMeta(itemId, next);
    return result;
  }

  /** 生成并保存摘要。 */
  async function summarizeItem(itemId, { signal } = {}) {
    const meta = store.getMeta(itemId);
    const transcript = store.getTranscript(itemId);
    if (!meta || !transcript) throw new Error('条目或逐字稿不存在');
    requireModelBudget();
    const sample = buildSample(transcript, store.getTranslation(itemId));
    const result = await translator.summarize({ title: meta.title, sample, host: meta.host, guests: meta.guests, signal });
    const current = store.getMeta(itemId);
    if (!current) throw new Error('条目已被删除');
    const points = (result.points || []).map((point) => (point.by ? `${point.by}：${point.text}` : point.text));
    // 页面描述里没认出来的嘉宾，从「观点署名」里补：主持人以外的新名字就是嘉宾
    const hostName = String(current.host || '').trim();
    const derived = [...new Set((result.points || [])
      .map((point) => String(point.by || '').replace(/^(主持人|嘉宾|host|guest)[:：\s]*/i, '').trim())
      .filter((name) => name && name !== hostName && !/^(主持人|嘉宾|播放者|发言人|主持人张小珺)$/.test(name) && name.length <= 24))];
    const guests = [...new Set([...(current.guests || []), ...derived])].slice(0, 5);
    const speakers = [...new Set([...(current.speakers || []), ...(hostName ? [hostName] : []), ...guests])].filter(Boolean);
    const next = patchMeta(itemId, {
      summary: result.summary,
      summaryTopic: result.topic,
      summaryOneLine: result.oneLine,
      summaryPoints: points,
      summaryHighlights: result.highlights || [],
      guests,
      speakers,
    });
    return { meta: next, summary: result };
  }

  /** 生成章节，存 chapters.json。 */
  async function outlineItem(itemId, { signal } = {}) {
    const meta = store.getMeta(itemId);
    const transcript = store.getTranscript(itemId);
    if (!meta || !transcript) throw new Error('条目或逐字稿不存在');
    requireModelBudget();
    const zh = (store.getTranslation(itemId) || {}).segments || [];
    const segments = transcript.segments.map((seg) => ({ startMs: seg.startMs, text: zh[seg.i] || seg.text }));
    const result = await translator.outline({ title: meta.title, segments, signal });
    store.saveChapters(itemId, { formatVersion: 1, ...result });
    return result;
  }

  /** 把一条内容整理成 Markdown，交给「知识库」插件入库。 */
  function buildMarkdown(meta, transcript, translation) {
    const segments = transcript && transcript.segments ? transcript.segments : [];
    const zh = translation && translation.segments ? translation.segments : [];
    const head = [
      `# ${meta.title || '未命名'}`,
      '',
      `- 来源：${meta.sourceName || '—'}`,
      meta.publishedAt ? `- 发布：${String(meta.publishedAt).slice(0, 10)}` : '',
      meta.durationSec ? `- 时长：${Math.round(meta.durationSec / 60)} 分钟` : '',
      meta.sourceUrl ? `- 原链接：${meta.sourceUrl}` : '',
      meta.speakers && meta.speakers.length ? `- 人物：${meta.speakers.join('、')}` : '',
      '',
      '## 逐字稿（时间戳 + 中文对照）',
      '',
    ].filter(Boolean);
    const lines = segments.map((seg) => {
      const clock = new Date(Math.max(0, seg.startMs)).toISOString().slice(11, 19);
      const zhText = zh[seg.i] ? `\n  中文：${zh[seg.i]}` : '';
      return `[${clock}] ${seg.text}${zhText}`;
    });
    let body = `${head.join('\n')}\n${lines.join('\n\n')}`;
    if (body.length > 60000) {
      // 太长会让编译阶段超预算：只留中文，够做检索与实体抽取
      const zhOnly = segments.map((seg) => {
        const clock = new Date(Math.max(0, seg.startMs)).toISOString().slice(11, 19);
        return `[${clock}] ${zh[seg.i] || seg.text}`;
      });
      body = `${head.join('\n')}\n${zhOnly.join('\n')}`.slice(0, 90000);
    }
    return body;
  }

  /** 推送到知识库插件（走它自己的 /ingest-text 接口）。 */
  async function pushToKb(itemId) {
    const meta = store.getMeta(itemId);
    const transcript = store.getTranscript(itemId);
    if (!meta) throw new Error('条目不存在');
    if (!transcript) throw new Error('这条还没有逐字稿');
    const translation = store.getTranslation(itemId);
    const text = buildMarkdown(meta, transcript, translation);
    const response = await fetch(`${origin()}/dsh-kb/ingest-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title: meta.title, ...(meta.sourceUrl && /^https?:/i.test(meta.sourceUrl) ? { url: meta.sourceUrl } : {}) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      throw new Error(payload && payload.error ? String(payload.error) : `知识库返回 HTTP ${response.status}`);
    }
    return { jobId: payload.jobId, sourceId: payload.source && payload.source.id, chars: text.length };
  }

  /** 把候选音频落到本地：YouTube 走 yt-dlp，直链走 fetch。 */
  async function downloadCandidate(candidate, targetDir) {
    fs.mkdirSync(targetDir, { recursive: true });
    const isYoutube = /youtube\.com|youtu\.be/i.test(candidate.mediaUrl || '');
    if (isYoutube) {
      const output = path.join(targetDir, 'audio.mp3');
      await execFileAsync(
        resolveYtDlp(),
        ['--no-warnings', '-f', 'bestaudio/best', '-x', '--audio-format', 'mp3', '--audio-quality', '5', '-o', output, candidate.mediaUrl],
        { timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
      );
      return 'audio.mp3';
    }
    const response = await fetch(candidate.mediaUrl);
    if (!response.ok) throw new Error(`音频下载失败 HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 1024) throw new Error('音频文件过小，可能不是媒体链接');
    const file = path.join(targetDir, 'audio.mp3');
    fs.writeFileSync(file, buffer);
    return 'audio.mp3';
  }

  function ignoredList() {
    const doc = sources.load();
    return Array.isArray(doc.ignored) ? doc.ignored : [];
  }

  function ignoreCandidate(entry) {
    const doc = sources.load();
    const list = Array.isArray(doc.ignored) ? doc.ignored : [];
    const item = { title: String(entry.title || ''), mediaUrl: String(entry.mediaUrl || ''), at: new Date().toISOString() };
    if (!item.title && !item.mediaUrl) throw new Error('缺少 title 或 mediaUrl');
    list.push(item);
    doc.ignored = list.slice(-500);
    sources.save(doc);
    return item;
  }

  /** 同步所有来源，去重后返回尚未入库的候选。 */
  async function syncSources({ limit = 5 } = {}) {
    const enabled = sources.list().filter((source) => source.enabled !== false);
    const found = [];
    const errors = [];
    for (const source of enabled) {
      try {
        const items = await sources.discover(source, limit);
        found.push(...items);
        sources.update(source.id, { lastChecked: new Date().toISOString() });
      } catch (error) {
        errors.push({ source: source.name, error: error && error.message ? error.message : String(error) });
      }
    }
    const ignored = ignoredList();
    const notIgnored = found.filter((candidate) => {
      const title = normalizeTitle(candidate.title || '');
      return !ignored.some((entry) => {
        if (entry.mediaUrl && candidate.mediaUrl && entry.mediaUrl === candidate.mediaUrl) return true;
        const ignoredTitle = normalizeTitle(entry.title || '');
        return Boolean(ignoredTitle && title && (ignoredTitle === title || title.includes(ignoredTitle) || ignoredTitle.includes(title)));
      });
    });
    const deduped = dedupeCandidates(notIgnored);
    const known = store.list().map((item) => normalizeTitle(item.title || '')).filter(Boolean);
    const fresh = deduped.filter((candidate) => {
      const key = normalizeTitle(candidate.title || '');
      if (!key) return false;
      return !known.some((existing) => existing === key || existing.includes(key) || key.includes(existing));
    });
    return { scanned: found.length, afterDedupe: deduped.length, fresh, errors, at: new Date().toISOString() };
  }

  /** 把一个候选取进队列：先下载，再走 OSS → ASR → 翻译 → 摘要。 */
  /**
   * 收录一个候选：接口立刻返回，下载在后台做完再进队列。
   * 不能在请求里同步下载——大文件会把 HTTP 连接拖死（实测 25 分钟音频直接断连）。
   */
  function ingestCandidate(candidate, extra = {}) {
    const id = makeId('ep');
    const now = new Date().toISOString();
    const meta = {
      id,
      title: candidate.title || '待补充标题',
      sourceName: candidate.sourceName || '',
      sourceUrl: candidate.link || candidate.mediaUrl || '',
      mediaUrl: '',
      mediaFile: '',
      kind: candidate.kind || 'interview',
      lang: candidate.lang || '',
      publishedAt: candidate.publishedAt || '',
      summary: '',
      durationSec: Number(candidate.durationSec) || 0,
      speakers: [],
      createdAt: now,
      status: { asr: 'running', translate: 'pending' },
      engine: { asr: asr.model },
      ...extra,
    };
    meta.budgetReservation = reserveBudget(id, estimateCost(meta));
    store.saveMeta(meta);
    const job = { id: makeId('job'), itemId: id, title: meta.title, stage: 'download', progress: 2, startedAt: now, error: '' };
    jobs.set(job.id, job);

    void (async () => {
      try {
        const file = await downloadCandidate(candidate, store.itemDir(id));
        const saved = store.getMeta(id);
        if (!saved) throw new Error('条目在下载期间被删除');
        store.saveMeta({ ...saved, mediaFile: file });
        enqueue({ ...saved, id, mediaFile: file, title: saved.title, sourceName: saved.sourceName, kind: saved.kind, lang: saved.lang, publishedAt: saved.publishedAt }, job);
      } catch (error) {
        job.stage = 'failed';
        job.error = error && error.message ? error.message : String(error);
        patchMeta(id, { status: { asr: 'failed' } });
        releaseBudget(id);
        if (logger && logger.warn) logger.warn(`[ai-records] 收录失败（${candidate.title}）：${job.error}`);
      } finally {
        if (job.stage === 'failed') job.finishedAt = new Date().toISOString();
      }
    })();

    return { item: meta, job, queued: true };
  }

  /** 预算按本地估算管理；持久预留把下载、排队和运行中的费用也计入额度。 */
  const ASR_YUAN_PER_HOUR = 0.79;
  const money = (value) => Math.round((Number(value) || 0) * 1000) / 1000;
  const monthKey = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }).slice(0, 7);
  const translationCost = (count) => money((Math.max(0, Number(count) || 0) / 1000) * 0.25);

  function estimateCost(meta) {
    const seconds = Math.max(0, Number(meta.durationSec) || 0);
    if (!seconds) return null; // 时长未知时占住剩余额度，不允许并发任务反复使用同一份钱。
    const transcript = store.getTranscript(meta.id);
    const count = transcript?.segments?.length || Math.ceil((seconds / 3600) * 1000);
    return Math.max(0.001, money((seconds / 3600) * ASR_YUAN_PER_HOUR + (/^zh/i.test(String(meta.lang || '')) ? 0 : translationCost(count))));
  }

  function monthSpend() {
    const prefix = monthKey();
    let total = 0;
    for (const item of store.list()) {
      if (item.costByMonth && typeof item.costByMonth === 'object') total += Number(item.costByMonth[prefix]) || 0;
      else if (String(item.createdAt || '').startsWith(prefix)) total += Number(item.costCny) || 0;
    }
    return money(total);
  }

  function budgetState(projected = 0, excludeId = '') {
    const configured = Number(config.monthlyBudgetCny);
    const budget = Number.isFinite(configured) && configured >= 0 ? configured : 300;
    const spent = monthSpend();
    const month = monthKey();
    const reserved = money(store.list().reduce((sum, item) => {
      const hold = item.budgetReservation;
      return sum + (item.id !== excludeId && hold?.month === month ? Math.max(0, Number(hold.amount) || 0) : 0);
    }, 0));
    const total = money(spent + reserved + projected);
    return { budget, spent, reserved, projected: total, allowed: total <= budget };
  }

  function reserveBudget(itemId, estimated) {
    const state = budgetState(0, itemId);
    const remaining = money(state.budget - state.spent - state.reserved);
    const amount = estimated === null ? remaining : money(estimated);
    if (remaining <= 0 || amount > remaining) {
      const error = new Error(`本月预算不足：已花 ${state.spent} 元，运行中预留 ${state.reserved} 元，本次预计 ${Math.max(0, amount)} 元，上限 ${state.budget} 元`);
      error.code = 'BUDGET_EXCEEDED';
      throw error;
    }
    return { month: monthKey(), amount };
  }

  function requireModelBudget() {
    const state = budgetState();
    if (money(state.budget - state.spent - state.reserved) <= 0) {
      const error = new Error(`本月预算已用尽或被运行中任务预留（已花 ${state.spent} 元，预留 ${state.reserved} 元，上限 ${state.budget} 元）`);
      error.code = 'BUDGET_EXCEEDED';
      throw error;
    }
  }

  function releaseBudget(itemId) {
    patchMeta(itemId, { budgetReservation: null });
  }

  function recordCost(itemId, amount) {
    const meta = store.getMeta(itemId);
    if (!meta) return;
    const month = monthKey();
    const costs = { ...(meta.costByMonth || {}) };
    if (!meta.costByMonth && meta.costCny) costs[String(meta.createdAt || '').slice(0, 7)] = Number(meta.costCny) || 0;
    costs[month] = money((Number(costs[month]) || 0) + amount);
    const hold = meta.budgetReservation;
    patchMeta(itemId, {
      costCny: money((Number(meta.costCny) || 0) + amount),
      costByMonth: costs,
      budgetReservation: hold ? { ...hold, amount: Math.max(0, money(hold.amount - amount)) } : null,
    });
  }

  /** 导出：Markdown 全文 / SRT 字幕。 */
  function buildExport(meta, transcript, translation, chapters, format) {
    const segments = transcript && transcript.segments ? transcript.segments : [];
    const zh = (translation && translation.segments) || [];
    const clock = (ms) => new Date(Math.max(0, ms)).toISOString().slice(11, 19);
    if (format === 'srt') {
      const srtClock = (value) => {
        const ms = Math.max(0, Math.round(Number(value) || 0));
        const seconds = Math.floor(ms / 1000);
        return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
      };
      return segments
        .map((seg, index) => {
          const text = zh[seg.i] || seg.text;
          return `${index + 1}\n${srtClock(seg.startMs)} --> ${srtClock(seg.endMs)}\n${text}`;
        })
        .join('\n\n');
    }
    const head = [
      `# ${meta.title || '未命名'}`,
      '',
      `> 来源：${meta.sourceName || '—'}｜类型：${meta.kind || '—'}｜时长：${Math.round((meta.durationSec || 0) / 60)} 分钟`,
      meta.sourceUrl ? `> 原链接：${meta.sourceUrl}` : '',
      meta.summary ? `\n${meta.summary}\n` : '',
    ].filter(Boolean);
    const chapterBlock = chapters && Array.isArray(chapters.chapters) && chapters.chapters.length
      ? ['## 章节', '', ...chapters.chapters.map((chapter) => `- ${clock(chapter.startMs)} ${chapter.title}`), '']
      : [];
    const body = segments.map((seg) => {
      const zhText = zh[seg.i] ? `\n${zh[seg.i]}` : '';
      return `**${clock(seg.startMs)}** ${seg.text}${zhText}`;
    });
    return [...head, ...chapterBlock, '## 逐字稿', '', ...body].join('\n');
  }

  /**
   * 来源聚类：两层。
   *   bySource —— 已入库内容按节目归堆，带条数、总时长、花费、最近一期。
   *   byType   —— 配置里的源按类型分组（深访谈 / 中文播客 / 官方发布 / 发布会搜索）。
   */
  function sourceClusters() {
    const items = store.list();
    const map = new Map();
    for (const item of items) {
      const name = item.sourceName || '未标注来源';
      const entry = map.get(name) || { name, count: 0, seconds: 0, costCny: 0, latest: '', kinds: {} };
      entry.count += 1;
      entry.seconds += Number(item.durationSec) || 0;
      entry.costCny += Number(item.costCny) || 0;
      entry.kinds[item.kind || 'interview'] = (entry.kinds[item.kind || 'interview'] || 0) + 1;
      const stamp = String(item.publishedAt || item.createdAt || '');
      if (stamp > entry.latest) entry.latest = stamp;
      map.set(name, entry);
    }
    const bySource = [...map.values()]
      .map((entry) => ({ ...entry, costCny: Number(entry.costCny.toFixed(2)), minutes: Math.round(entry.seconds / 60) }))
      .sort((a, b) => b.count - a.count || b.minutes - a.minutes);

    const typeMap = new Map();
    const typeOf = (source) => {
      if (source.cast === 'event' || source.kind === 'search' || source.kind === 'youtube') return '发布会与演讲';
      if (source.lang === 'zh') return '中文访谈';
      return '英文深访谈';
    };
    for (const source of sources.list()) {
      const type = typeOf(source);
      const entry = typeMap.get(type) || { type, total: 0, configured: 0, lastChecked: '' };
      entry.configured += 1;
      if (source.lastChecked && source.lastChecked > entry.lastChecked) entry.lastChecked = source.lastChecked;
      typeMap.set(type, entry);
    }
    // 用已入库内容的来源名去对配置里的类型，统计每类收了多少条
    const nameToType = new Map();
    for (const source of sources.list()) nameToType.set(source.name, typeOf(source));
    const byType = [...typeMap.values()].map((entry) => ({
      ...entry,
      total: entry.configured,
      items: bySource.filter((source) => nameToType.get(source.name) === entry.type).reduce((sum, source) => sum + source.count, 0),
      minutes: bySource.filter((source) => nameToType.get(source.name) === entry.type).reduce((sum, source) => sum + source.minutes, 0),
    }));

    return { bySource, byType, totalItems: items.length, configuredSources: sources.list().length };
  }

  /** 人物索引：按 speakers 聚合。 */
  function peopleIndex() {
    const map = new Map();
    for (const item of store.list()) {
      for (const name of item.speakers || []) {
        const entry = map.get(name) || { name, count: 0, items: [] };
        entry.count += 1;
        entry.items.push({ id: item.id, title: item.title, durationSec: item.durationSec, favorite: item.favorite });
        map.set(name, entry);
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  /** 主题词：从标题与摘要里数词频，去掉停用词，给一个粗粒度入口。 */
  function topicIndex(limit = 24) {
    const stop = new Set(['the','and','for','with','that','this','from','your','you','how','why','what','are','was','were','will','can','not','but','its','his','her','their','our','they','them','about','into','over','when','where','which','who','whom','all','any','more','most','some','such','than','then','there','these','those','been','being','have','has','had','does','did','doing','的','了','和','与','是','在','我','你','他','她','它','我们','他们','这个','那个','一个','就是','因为','所以','但是','而且','可以','什么','怎么','为什么','如何','这期','那期'])
    const counts = new Map();
    const speakerTokens = new Set();
    for (const item of store.list()) {
      for (const name of item.speakers || []) {
        for (const token of String(name).toLowerCase().match(/[a-z][a-z0-9.+-]{2,}|[\u4e00-\u9fa5]{2,6}/g) || []) speakerTokens.add(token);
      }
    }
    const bump = (term) => {
      const key = term.trim().toLowerCase();
      if (key.length < 2 || stop.has(key) || speakerTokens.has(key)) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    };
    for (const item of store.list()) {
      const text = `${item.title || ''} ${item.summary || ''} ${item.summaryTopic || ''}`;
      for (const word of String(text).match(/[A-Za-z][A-Za-z0-9.+-]{2,}|[\u4e00-\u9fa5]{2,6}/g) || []) bump(word);
    }
    return [...counts.entries()].map(([term, count]) => ({ term, count })).filter((entry) => entry.count >= 2).sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /** 失败重试：按已有元信息重新入队（有本地音频走本地，有链接走链接）。 */
  function retryItem(itemId) {
    const meta = store.getMeta(itemId);
    if (!meta) throw new Error('条目不存在');
    if (!meta.mediaFile && !/^https?:/i.test(String(meta.mediaUrl || ''))) throw new Error('这条既没有本地音频也没有公网链接，无法重试');
    const job = enqueue({ ...meta, id: itemId, mediaUrl: meta.mediaUrl || '' });
    return { item: meta, job: job.job };
  }

  function itemPayload(id) {
    const meta = store.getMeta(id);
    if (!meta) return undefined;
    return {
      meta,
      transcript: store.getTranscript(id) || null,
      translation: store.getTranslation(id) || null,
      chapters: store.getChapters(id) || null,
    };
  }

  // ---- HTTP ---------------------------------------------------------------

  function sendJson(res, value, status = 200) {
    const body = JSON.stringify(value);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  /** 音频播放：支持 Range，浏览器拖动进度条才不会整段重下。 */
  function streamMedia(req, res, id) {
    const meta = store.getMeta(id);
    if (!meta || !meta.mediaFile) return sendJson(res, { ok: false, error: '这条没有本地音频' }, 404);
    const file = path.join(store.itemDir(id), path.basename(String(meta.mediaFile)));
    if (!fs.existsSync(file)) return sendJson(res, { ok: false, error: '音频文件不存在' }, 404);
    const size = fs.statSync(file).size;
    const type = /\.(mp3)$/i.test(file) ? 'audio/mpeg' : /\.(m4a)$/i.test(file) ? 'audio/mp4' : /\.(wav)$/i.test(file) ? 'audio/wav' : 'audio/ogg';
    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : size - 1;
      if (start >= size || end < start) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return undefined;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return undefined;
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=3600',
    });
    fs.createReadStream(file).pipe(res);
    return undefined;
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : null;
    if (route === null) return sendJson(res, { ok: false, error: 'not found' }, 404);

    try {
      if (req.method === 'GET' && route === '/health') {
        return sendJson(res, {
          ok: true,
          root: store.root,
          model: asr.model,
          hasKey: Boolean(asrApiKey),
          stats: store.stats(),
          cost: budgetState(),
          lastAutoRun,
          auto: autoStatus(),
          jobs: publicJobs().slice(0, 20),
        });
      }

      if (req.method === 'GET' && route === '/items') {
        return sendJson(res, { ok: true, items: store.list(), stats: store.stats(), cost: budgetState(), auto: autoStatus(), jobs: publicJobs().slice(0, 20) });
      }

      const mediaMatch = /^\/media\/([A-Za-z0-9-]+)$/.exec(route);
      if (mediaMatch && req.method === 'GET') {
        return streamMedia(req, res, mediaMatch[1]);
      }

      if (req.method === 'GET' && route === '/search') {
        const q = url.searchParams.get('q') || '';
        return sendJson(res, { ok: true, query: q, hits: store.search(q) });
      }

      if (req.method === 'POST' && route === '/ingest') {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const mediaUrl = String(body.url || body.mediaUrl || '').trim();
        const localPath = String(body.path || '').trim();
        if (!mediaUrl && !localPath) return sendJson(res, { ok: false, error: '缺少 url 或本地路径' }, 400);
        if (localPath && !fs.existsSync(localPath)) return sendJson(res, { ok: false, error: `本地文件不存在：${localPath}` }, 400);
        if (!asrApiKey) return sendJson(res, { ok: false, error: '缺少 ASR API Key，先填配置' }, 400);
        const { item, job } = enqueue({ ...body, mediaUrl, copySource: localPath || '', sourceUrl: body.sourceUrl || mediaUrl || localPath });
        return sendJson(res, { ok: true, item, job });
      }

      const itemMatch = /^\/items\/([A-Za-z0-9-]+)$/.exec(route);
      if (itemMatch && req.method === 'GET') {
        const payload = itemPayload(itemMatch[1]);
        if (!payload) return sendJson(res, { ok: false, error: '条目不存在' }, 404);
        return sendJson(res, { ok: true, ...payload });
      }
      if (itemMatch && req.method === 'DELETE') {
        store.remove(itemMatch[1]);
        return sendJson(res, { ok: true });
      }
      if (itemMatch && req.method === 'PATCH') {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        const meta = store.getMeta(itemMatch[1]);
        if (!meta) return sendJson(res, { ok: false, error: '条目不存在' }, 404);
        const next = { ...meta };
        if (typeof body.title === 'string' && body.title.trim()) next.title = body.title.trim();
        if (typeof body.kind === 'string' && body.kind.trim()) next.kind = body.kind.trim();
        if (Array.isArray(body.speakers)) next.speakers = body.speakers.map((x) => String(x).trim()).filter(Boolean);
        if (typeof body.favorite === 'boolean') next.favorite = body.favorite;
        if (Number.isFinite(Number(body.progressMs))) next.progressMs = Math.max(0, Number(body.progressMs));
        if (body.speakerMap && typeof body.speakerMap === 'object' && !Array.isArray(body.speakerMap)) {
          const map = {};
          for (const [from, to] of Object.entries(body.speakerMap)) {
            const value = String(to || '').trim();
            if (from && value) map[String(from)] = value;
          }
          next.speakerMap = map;
        }
        return sendJson(res, { ok: true, meta: store.saveMeta(next) });
      }

      if (req.method === 'GET' && route === '/sources') {
        return sendJson(res, { ok: true, sources: sources.list() });
      }

      if (req.method === 'POST' && route === '/sources/sync') {
        const raw = await readBody(req).catch(() => '');
        const body = raw ? JSON.parse(raw) : {};
        const result = await syncSources({ limit: Number(body.limit) || 5 });
        return sendJson(res, { ok: true, ...result });
      }

      if (req.method === 'POST' && route === '/sources/ingest') {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (!body.mediaUrl) return sendJson(res, { ok: false, error: '缺少 mediaUrl' }, 400);
        const result = ingestCandidate(body);
        return sendJson(res, { ok: true, ...result });
      }

      const summaryMatch = /^\/items\/([A-Za-z0-9-]+)\/summarize$/.exec(route);
      if (summaryMatch && req.method === 'POST') {
        try {
          const result = await summarizeItem(summaryMatch[1]);
          return sendJson(res, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, { ok: false, error: error && error.message ? error.message : String(error) }, error?.code === 'BUDGET_EXCEEDED' ? 409 : 502);
        }
      }

      if (req.method === 'GET' && route === '/auto') {
        return sendJson(res, { ok: true, auto: autoStatus() });
      }

      if (req.method === 'POST' && route === '/auto/run') {
        const result = await autoRun({ manual: true });
        return sendJson(res, { ok: true, result, auto: autoStatus() });
      }

      if (req.method === 'GET' && route === '/clusters') {
        return sendJson(res, { ok: true, ...sourceClusters() });
      }

      if (req.method === 'GET' && route === '/people') {
        return sendJson(res, { ok: true, people: peopleIndex() });
      }

      if (req.method === 'GET' && route === '/topics') {
        return sendJson(res, { ok: true, topics: topicIndex() });
      }

      const retryMatch = /^\/items\/([A-Za-z0-9-]+)\/retry$/.exec(route);
      if (retryMatch && req.method === 'POST') {
        try {
          return sendJson(res, { ok: true, ...retryItem(retryMatch[1]) });
        } catch (error) {
          return sendJson(res, { ok: false, error: error && error.message ? error.message : String(error) }, 400);
        }
      }

      if (req.method === 'POST' && route === '/sources/ignore') {
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        try {
          const entry = ignoreCandidate(body);
          return sendJson(res, { ok: true, ignored: entry, total: ignoredList().length });
        } catch (error) {
          return sendJson(res, { ok: false, error: error && error.message ? error.message : String(error) }, 400);
        }
      }

      if (req.method === 'GET' && route === '/sources/ignored') {
        return sendJson(res, { ok: true, ignored: ignoredList() });
      }

      const exportMatch = /^\/items\/([A-Za-z0-9-]+)\/export$/.exec(route);
      if (exportMatch && req.method === 'GET') {
        const meta = store.getMeta(exportMatch[1]);
        if (!meta) return sendJson(res, { ok: false, error: '条目不存在' }, 404);
        const format = (url.searchParams.get('format') || 'md').toLowerCase();
        const text = buildExport(meta, store.getTranscript(exportMatch[1]), store.getTranslation(exportMatch[1]), store.getChapters(exportMatch[1]), format);
        const ext = format === 'srt' ? 'srt' : 'md';
        const body = Buffer.from(text, 'utf8');
        res.writeHead(200, {
          'Content-Type': format === 'srt' ? 'application/x-subrip; charset=utf-8' : 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(meta.title || exportMatch[1]).slice(0, 80)}.${ext}"`,
          'Content-Length': body.length,
        });
        res.end(body);
        return undefined;
      }

      const profileMatch = /^\/items\/([A-Za-z0-9-]+)\/profile$/.exec(route);
      if (profileMatch && req.method === 'POST') {
        try {
          const result = await profileItem(profileMatch[1]);
          return sendJson(res, { ok: true, ...result, meta: store.getMeta(profileMatch[1]) });
        } catch (error) {
          return sendJson(res, { ok: false, error: error && error.message ? error.message : String(error) }, error?.code === 'BUDGET_EXCEEDED' ? 409 : 502);
        }
      }

      const chapterMatch = /^\/items\/([A-Za-z0-9-]+)\/chapters$/.exec(route);
      if (chapterMatch && req.method === 'POST') {
        try {
          const result = await outlineItem(chapterMatch[1]);
          return sendJson(res, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, { ok: false, error: error && error.message ? error.message : String(error) }, error?.code === 'BUDGET_EXCEEDED' ? 409 : 502);
        }
      }

      const kbMatch = /^\/items\/([A-Za-z0-9-]+)\/kb$/.exec(route);
      if (kbMatch && req.method === 'POST') {
        try {
          const result = await pushToKb(kbMatch[1]);
          return sendJson(res, { ok: true, ...result });
        } catch (error) {
          return sendJson(res, { ok: false, error: error && error.message ? error.message : String(error) }, 502);
        }
      }

      const translateMatch = /^\/items\/([A-Za-z0-9-]+)\/translate$/.exec(route);
      if (translateMatch && req.method === 'POST') {
        return sendJson(res, { ok: true, ...retranslate(translateMatch[1]) });
      }

      return sendJson(res, { ok: false, error: 'not found' }, 404);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      return sendJson(res, { ok: false, error: message }, error?.code === 'BUDGET_EXCEEDED' ? 409 : 500);
    }
  }

  /**
   * 定时任务：按间隔发现新内容，按上限自动收录。
   * 状态落在 <root>/state.json，重启不丢；错过的整点会在启动后补跑一次。
   */
  const stateFile = path.join(rootDir, 'state.json');
  let autoTimer = null;
  let autoRunning = false;

  function readState() {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch {
      return { lastSyncAt: '', runs: [] };
    }
  }

  function writeState(state) {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ ...state, runs: (state.runs || []).slice(-20) }, null, 1));
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 写状态失败：${error && error.message ? error.message : String(error)}`);
    }
  }

  /** 读取间隔（分钟）：未配置或为 0 时关闭。 */
  const autoEveryMinutes = () => {
    const value = Number(config.autoSyncMinutes);
    return Number.isFinite(value) ? value : 0;
  };
  const autoEnabled = () => autoEveryMinutes() > 0;
  const intervalMs = () => Math.max(5, autoEveryMinutes()) * 60 * 1000;

  function todaySpend() {
    const today = new Date().toISOString().slice(0, 10);
    return Number(store.list().filter((item) => String(item.createdAt || '').startsWith(today)).reduce((sum, item) => sum + (Number(item.costCny) || 0), 0).toFixed(2));
  }

  function autoStatus() {
    const state = readState();
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
    const next = last ? last + intervalMs() : Date.now();
    return {
      enabled: autoEnabled(),
      everyMinutes: Math.max(5, autoEveryMinutes()),
      maxPerRun: Number(config.autoMaxPerRun) || 2,
      dailyBudget: Number(config.autoDailyBudgetCny) || 30,
      spentToday: todaySpend(),
      lastSyncAt: state.lastSyncAt || '',
      nextRunAt: new Date(next).toISOString(),
      running: autoRunning,
      recent: (state.runs || []).slice(-5).reverse(),
    };
  }

  async function autoRun({ manual = false } = {}) {
    if (autoRunning) return { skipped: 'already-running' };
    if (!manual && !autoEnabled()) return { skipped: 'disabled' };
    const dailyBudget = Number(config.autoDailyBudgetCny) || 30;
    if (todaySpend() >= dailyBudget) {
      writeState({ ...readState(), lastSyncAt: new Date().toISOString(), runs: [...(readState().runs || []), { at: new Date().toISOString(), skipped: `今日预算已用尽（${todaySpend()} / ${dailyBudget}）` }] });
      if (logger && logger.info) logger.info('[ai-records] 今日预算已用尽，跳过本轮');
      return { skipped: 'daily-budget' };
    }
    autoRunning = true;
    const startedAt = new Date().toISOString();
    try {
      const result = await syncSources({ limit: Number(config.autoScanLimit) || 5 });
      const max = Number(config.autoMaxPerRun) || 2;
      const picked = result.fresh.slice(0, max);
      for (const candidate of picked) {
        try {
          ingestCandidate(candidate);
        } catch (error) {
          if (logger && logger.warn) logger.warn(`[ai-records] 自动收录失败（${candidate.title}）：${error && error.message ? error.message : String(error)}`);
        }
      }
      const record = { at: startedAt, scanned: result.scanned, fresh: result.fresh.length, picked: picked.length, titles: picked.map((item) => item.title) };
      const state = readState();
      writeState({ ...state, lastSyncAt: startedAt, runs: [...(state.runs || []), record] });
      if (logger && logger.info) logger.info(`[ai-records] 定时任务：扫到 ${result.scanned} 条，新增 ${result.fresh.length} 条，收录 ${picked.length} 条`);
      return record;
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 定时任务失败：${error && error.message ? error.message : String(error)}`);
      return { error: error && error.message ? error.message : String(error) };
    } finally {
      autoRunning = false;
      scheduleNext();
    }
  }

  function scheduleNext() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    if (!autoEnabled() || disposed) return;
    const state = readState();
    const last = state.lastSyncAt ? new Date(state.lastSyncAt).getTime() : 0;
    const due = last ? last + intervalMs() : Date.now() + 30 * 1000;
    const delay = Math.max(30 * 1000, due - Date.now());
    autoTimer = setTimeout(() => void autoRun(), Math.min(delay, 24 * 3600 * 1000));
  }

  let lastAutoRun = null;

  /** 恢复中断的任务：进程重启后，卡在 pending/running 的条目要自己继续跑。 */
  /** 找条目目录里已经下好的音频（下载完成但没来得及写 meta 的情况）。 */
  function findAudioFile(itemId) {
    try {
      return fs.readdirSync(store.itemDir(itemId)).find((name) => /^audio\.(mp3|opus|m4a|wav|ogg)$/i.test(name)) || '';
    } catch {
      return '';
    }
  }

  function recoverInterrupted() {
    const items = store.list();
    let resumed = 0;
    for (const item of items) {
      const status = item.status || {};
      const meta = store.getMeta(item.id);
      if (!meta) continue;
      const localFile = meta.mediaFile || findAudioFile(item.id);
      const canRedo = Boolean(localFile) || /^https?:/i.test(String(meta.mediaUrl || ''));
      if ((status.asr === 'pending' || status.asr === 'running') && canRedo) {
        try {
          if (!meta.mediaFile && localFile) {
            meta.mediaFile = localFile;
            store.saveMeta(meta);
          }
          enqueue({ ...meta, id: item.id, mediaFile: localFile, mediaUrl: meta.mediaUrl || '' });
          resumed += 1;
        } catch (error) {
          patchMeta(item.id, { status: { asr: 'failed' } });
          releaseBudget(item.id);
          if (logger && logger.warn) logger.warn(`[ai-records] 恢复失败（${item.title}）：${error && error.message ? error.message : String(error)}`);
        }
        continue;
      }
      if (status.asr === 'done' && status.translate === 'running') {
        try {
          retranslate(item.id);
          resumed += 1;
        } catch (error) {
          patchMeta(item.id, { status: { translate: 'failed' } });
          releaseBudget(item.id);
          if (logger && logger.warn) logger.warn(`[ai-records] 恢复翻译失败（${item.title}）：${error && error.message ? error.message : String(error)}`);
        }
      }
    }
    if (resumed && logger && logger.info) logger.info(`[ai-records] 已恢复 ${resumed} 个中断的任务`);
    return resumed;
  }

  function init() {
    store.ensure();
    store.rebuildIndex();
    sources.load();
    try {
      recoverInterrupted();
    } catch (error) {
      if (logger && logger.warn) logger.warn(`[ai-records] 任务恢复检查失败：${error && error.message ? error.message : String(error)}`);
    }
    scheduleNext();
    if (autoEnabled() && logger && logger.info) logger.info(`[ai-records] 定时任务已排期：每 ${Math.max(5, autoEveryMinutes())} 分钟检查一次新内容`);
  }

  function dispose() {
    disposed = true;
    queue.length = 0;
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
  }

  return { init, dispose, handleRoute, store, enqueue, retranslate, publicJobs, asr, rootDir, syncSources, ingestCandidate, autoRun };
}
