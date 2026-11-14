/**
 * lib/sources.js —— 来源表与发现层。
 *
 * 两类来源，抓法不同：
 *   podcast（RSS）：一期一条 enclosure，最快路径。
 *   youtube（频道）：频道里混着广告/片段/教程，必须用时长门槛 + 标题关键词筛。
 *
 * 发现只产出「候选」，不直接转写：转写要花钱，先让人（或规则）过一眼。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const os = await import('node:os');

/** 找到可用的 yt-dlp：插件进程的 PATH 和终端不一样，必须显式探测。 */
export function resolveYtDlp() {
  const home = os.homedir();
  const candidates = [path.join(home, '.local', 'bin', 'yt-dlp'), '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp'];
  for (const candidate of candidates) {
    if (candidate === 'yt-dlp') return candidate;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  return 'yt-dlp';
}

const DEFAULT_MIN_DURATION = 20 * 60;
const DEFAULT_TITLE_PATTERN = 'keynote|devday|dev day|大会|主题演讲|发布会|launch|opening|fireside|roundtable|圆桌';

const SOURCES_VERSION = 1;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/** 解析 itunes:duration（可能是秒数，也可能是 01:02:03 / 62:03）。 */
export function parseDuration(raw) {
  const text = String(raw || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return Number(text);
  const parts = text.split(':').map((part) => Number(part) || 0);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

/** 解 HTML 实体：RSS 里的 &#x2014; 这类不解码会一路带进标题。 */
export function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] ?? match);
}

function tag(block, name) {
  const match = new RegExp(`<${name}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`, 'i').exec(block);
  return match ? match[1].trim() : '';
}

/** 解析 RSS，返回最近若干条候选。 */
export function parseFeed(xml, limit = 10) {
  const items = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1, limit + 1);
  for (const raw of blocks) {
    const block = raw.split(/<\/item>/i)[0];
    const enclosure = /<enclosure[^>]*url="([^"]+)"[^>]*>/i.exec(block);
    const title = decodeEntities(tag(block, 'title'));
    if (!title) continue;
    items.push({
      title,
      mediaUrl: enclosure ? enclosure[1] : '',
      publishedAt: tag(block, 'pubDate'),
      durationSec: parseDuration(tag(block, 'itunes:duration')),
      guid: tag(block, 'guid') || (enclosure ? enclosure[1] : title),
      link: tag(block, 'link'),
    });
  }
  return items;
}

/**
 * 转载与二次创作的特征词：watch party、react 视频、直播回放、速览。
 * 这些不是「同一场发布会的另一个上传」，而是别人做的节目，直接排除。
 */
const REPOST_PATTERN = /watch\s*party|reaction|reacts?\b|live\s*from|livestream|live\s*stream|replay|commentary|breakdown|highlights?|in\s+\d+\s+minutes|trailer|teaser|预告|速览|剪辑|reaction/i;

const AI_RELEVANT = /\b(ai|a\.i\.|agent|agents|model|models|llm|gpt|claude|gemini|openai|anthropic|deepmind|nvidia|inference|neural|machine learning|gen ai|生成式|大模型|智能体)\b/i;

/** 发布会候选的相关性：必须对得上某个品牌或带 AI 语境，避免把无关大会收进来。 */
export function isAiRelevant(title) {
  return Boolean(eventSignatureLoose(title)) || AI_RELEVANT.test(String(title || ''));
}

export function isRepost(title) {
  return REPOST_PATTERN.test(String(title || ''));
}

const BRANDS = [
  { key: 'openai', match: /openai|chatgpt/i, official: /openai/i },
  { key: 'anthropic', match: /claude|anthropic/i, official: /claude|anthropic/i },
  { key: 'google', match: /google|deepmind|gemini/i, official: /google|deepmind/i },
  { key: 'nvidia', match: /nvidia|gtc/i, official: /nvidia/i },
  { key: 'meta', match: /\bmeta\b|connect/i, official: /meta/i },
  { key: 'microsoft', match: /microsoft|build/i, official: /microsoft/i },
  { key: 'apple', match: /apple|wwdc/i, official: /apple/i },
];
const EVENTS = [
  { key: 'devday', match: /dev\s*day|devday/i },
  { key: 'io', match: /\bi\/o\b|google\s*io/i },
  { key: 'gtc', match: /\bgtc\b/i },
  { key: 'connect', match: /\bconnect\b/i },
  { key: 'build', match: /\bbuild\b/i },
  { key: 'wwdc', match: /\bwwdc\b/i },
  { key: 'codewithclaude', match: /code\s*with\s*claude/i },
];

/** 同一场发布会的指纹：品牌 + 活动 + 年份。识别不出就返回 null。 */
export function eventSignature(title) {
  const text = String(title || '');
  const brand = BRANDS.find((entry) => entry.match.test(text));
  const event = EVENTS.find((entry) => entry.match.test(text));
  const year = (text.match(/\b(20\d\d)\b/) || [])[1] || '';
  if (!brand || (!event && !year)) return null;
  return `${brand.key}|${event ? event.key : 'na'}|${year}`;
}

/** 宽松指纹：只要品牌和活动对得上，年份缺失也算同一场。 */
export function eventSignatureLoose(title) {
  const text = String(title || '');
  const brand = BRANDS.find((entry) => entry.match.test(text));
  const event = EVENTS.find((entry) => entry.match.test(text));
  if (!brand || !event) return null;
  return `${brand.key}|${event.key}`;
}

/** 标题归一：去掉平台噪声词与标点，只保留可用于比对的骨架。 */
export function normalizeTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\b(full|official|highlights?|live|complete|entire|recap|trailer|teaser|keynote|4k|hd|1080p)\b/g, ' ')
    .replace(/(完整版|全程|直播|回放|精剪|预告|花絮|高清)/g, ' ')
    .replace(/[|｜\-–—_·:：,，.。!！?？"'“”‘’()（）\[\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
}

/**
 * 发布会去重：同一场往往有官方版 + 若干转载版。
 * 判定：归一标题相同或互相包含，且时长接近（差 20% 内或 15 分钟内）。
 * 保留规则：优先官方频道（source.cast === 'event' 且 source.official），其次时长更长。
 */
export function dedupeCandidates(items, { durationToleranceMin = 15 } = {}) {
  const kept = [];
  const byEvent = new Map();

  const yearOf = (title) => (String(title || '').match(/\b(20\d\d)\b/) || [])[1] || '';
  const closeEnough = (a, b) => {
    const x = Number(a) || 0;
    const y = Number(b) || 0;
    if (!x || !y) return true;
    return Math.abs(x - y) <= Math.max(durationToleranceMin * 60, Math.max(x, y) * 0.25);
  };

  for (const raw of items) {
    if (isRepost(raw.title)) continue; // watch party / reaction 这类是别人的节目，不是同一场的另一份上传
    const item = raw;

    // 一层：同一场发布会（品牌 + 活动，年份不冲突）
    const loose = eventSignatureLoose(item.title);
    if (loose) {
      const bucket = byEvent.get(loose) || [];
      const year = yearOf(item.title);
      // 主舞台演讲：同一场发布会里「opening keynote / 完整 keynote」只留一份，
      // 哪怕时长差得多（官方版与直播存档版经常差一小时）。分论坛的专场演讲不算重复。
      const keynoteLike = (title) => /keynote|opening|main\s*stage|主题演讲/i.test(String(title || ''));
      const twin = bucket.find((entry) => {
        const otherYear = yearOf(entry.title);
        if (year && otherYear && year !== otherYear) return false;
        if (closeEnough(entry.durationSec, item.durationSec)) return true;
        const bothKeynote = keynoteLike(entry.title) && keynoteLike(item.title);
        if (!bothKeynote) return false;
        const bothMain = /opening|main\s*stage|主题演讲/i.test(entry.title) && /opening|main\s*stage|主题演讲/i.test(item.title);
        const bothLong = (Number(entry.durationSec) || 0) >= 45 * 60 && (Number(item.durationSec) || 0) >= 45 * 60;
        return bothMain || bothLong;
      });
      if (twin) {
        const preferIncoming = (Number(item.durationSec) || 0) > (Number(twin.durationSec) || 0) * 1.15;
        if (preferIncoming) {
          const index = kept.indexOf(twin);
          kept[index] = { ...item, duplicates: [...(twin.duplicates || []), { title: twin.title, sourceName: twin.sourceName, durationSec: twin.durationSec }] };
          bucket[bucket.indexOf(twin)] = kept[index];
        } else {
          twin.duplicates = [...(twin.duplicates || []), { title: item.title, sourceName: item.sourceName, durationSec: item.durationSec }];
        }
        continue;
      }
      const entry = { ...item, duplicates: [] };
      bucket.push(entry);
      byEvent.set(loose, bucket);
      kept.push(entry);
      continue;
    }

    // 二层：标题骨架相似 + 时长接近
    const key = normalizeTitle(item.title);
    if (!key) continue;
    const tokens = new Set(key.split(' ').filter(Boolean));
    const twin = kept.find((existing) => {
      const existingKey = normalizeTitle(existing.title);
      if (!existingKey) return false;
      if (existingKey === key || existingKey.includes(key) || key.includes(existingKey)) return closeEnough(existing.durationSec, item.durationSec);
      const otherTokens = new Set(existingKey.split(' ').filter(Boolean));
      const union = new Set([...tokens, ...otherTokens]);
      const shared = [...tokens].filter((token) => otherTokens.has(token)).length;
      return union.size > 0 && shared / union.size >= 0.55 && closeEnough(existing.durationSec, item.durationSec);
    });
    if (!twin) {
      kept.push({ ...item, duplicates: [] });
      continue;
    }
    const preferIncoming = (Number(item.durationSec) || 0) > (Number(twin.durationSec) || 0) * 1.15;
    if (preferIncoming) {
      const index = kept.indexOf(twin);
      kept[index] = { ...item, duplicates: [...(twin.duplicates || []), { title: twin.title, sourceName: twin.sourceName, durationSec: twin.durationSec }] };
    } else {
      twin.duplicates = [...(twin.duplicates || []), { title: item.title, sourceName: item.sourceName, durationSec: item.durationSec }];
    }
  }
  return kept;
}

export function createSources({ rootDir, logger }) {
  const file = path.join(rootDir, 'sources.json');

  function load() {
    const raw = readJson(file);
    if (raw && Array.isArray(raw.sources)) return raw;
    const seeded = { version: SOURCES_VERSION, sources: [] };
    writeJson(file, seeded);
    return seeded;
  }

  function save(doc) {
    writeJson(file, doc);
  }

  function list() {
    return load().sources;
  }

  function get(id) {
    return list().find((source) => source.id === id);
  }

  function update(id, patch) {
    const doc = load();
    const index = doc.sources.findIndex((source) => source.id === id);
    if (index < 0) return undefined;
    doc.sources[index] = { ...doc.sources[index], ...patch };
    save(doc);
    return doc.sources[index];
  }

  /** 拉一个 RSS 源的最新条目。 */
  async function discoverFeed(source, limit = 5) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(source.feed, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
      });
      if (!response.ok) throw new Error(`RSS 返回 HTTP ${response.status}`);
      const xml = await response.text();
      return parseFeed(xml, limit)
        .filter((item) => item.mediaUrl)
        .map((item) => ({ ...item, sourceId: source.id, sourceName: source.name, kind: source.cast || 'interview', lang: source.lang }));
    } finally {
      clearTimeout(timer);
    }
  }

  /** 列一个 YouTube 频道的最新条目，并按规则筛。 */
  async function discoverChannel(source, limit = 12) {
    const window = Number(source.scanWindow) || 60;
    const { stdout } = await execFileAsync(
      resolveYtDlp(),
      [
        '--no-warnings',
        '--flat-playlist',
        `--playlist-end`,
        String(Math.max(limit, window)),
        '--print',
        '%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s',
        source.channel,
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    const pattern = new RegExp(String(source.titlePattern || DEFAULT_TITLE_PATTERN), 'i');
    const minDuration = Number(source.minDuration) || DEFAULT_MIN_DURATION;
    return stdout
      .split('\n')
      .map((line) => line.split('\t'))
      .filter((cols) => cols.length >= 2 && cols[0])
      .map(([id, title, duration, uploadDate]) => ({
        id,
        title,
        mediaUrl: `https://www.youtube.com/watch?v=${id}`,
        durationSec: Number(duration) || 0,
        publishedAt: uploadDate || '',
      }))
      .filter((item) => item.durationSec >= minDuration && (!source.titleMustMatch || pattern.test(item.title)))
      .map((item) => ({ ...item, sourceId: source.id, sourceName: source.name, kind: source.cast || 'event', lang: source.lang }));
  }

  /**
   * 搜索型来源：发布会这类内容在频道里很稀疏（几十条短视频里才混着一场 keynote），
   * 按关键词搜比翻频道可靠。每个查询取若干条，再过同一套时长/标题规则。
   */
  async function discoverSearch(source, limit = 5) {
    const pattern = new RegExp(String(source.titlePattern || DEFAULT_TITLE_PATTERN), 'i');
    const minDuration = Number(source.minDuration) || DEFAULT_MIN_DURATION;
    const queries = Array.isArray(source.queries) && source.queries.length ? source.queries : [source.query].filter(Boolean);
    const seen = new Map();
    for (const query of queries) {
      try {
        const { stdout } = await execFileAsync(
          resolveYtDlp(),
          ['--no-warnings', '--flat-playlist', '--playlist-end', String(Math.max(limit * 3, 8)), '--print', '%(id)s\t%(title)s\t%(duration)s', `ytsearch${Math.max(limit * 3, 8)}:${query}`],
          { timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        );
        for (const line of stdout.split('\n')) {
          const [id, title, duration] = line.split('\t');
          if (!id || !title || seen.has(id)) continue;
          const durationSec = Number(duration) || 0;
          // 发布会只收长版：片段、Highlights、12 分钟速览都靠时长挡掉
          if (durationSec < minDuration) continue;
          if (!isAiRelevant(title)) continue;
          if (source.titleMustMatch && !pattern.test(title)) continue;
          seen.set(id, {
            id,
            title,
            mediaUrl: `https://www.youtube.com/watch?v=${id}`,
            durationSec,
            publishedAt: '',
            sourceId: source.id,
            sourceName: source.name,
            kind: source.cast || 'event',
            lang: source.lang || 'en',
            query,
          });
        }
      } catch (error) {
        if (logger && logger.warn) logger.warn(`[ai-records] 搜索失败（${query}）：${error && error.message ? error.message : String(error)}`);
      }
    }
    return [...seen.values()];
  }

  /** 发现一个源的新内容。 */
  async function discover(source, limit = 5) {
    if (source.kind === 'podcast') return discoverFeed(source, limit);
    if (source.kind === 'youtube') return discoverChannel(source, Math.max(limit * 2, 12));
    if (source.kind === 'search') return discoverSearch(source, limit);
    throw new Error(`未知来源类型：${source.kind}`);
  }

  return { file, list, get, update, discover, discoverFeed, discoverChannel, discoverSearch, load, save };
}
