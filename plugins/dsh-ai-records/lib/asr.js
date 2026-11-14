/**
 * lib/asr.js —— 云端录音文件识别（DashScope 异步 filetrans）。
 *
 * 流程：提交公网可访问的音频 URL → 轮询任务 → 取 transcription_url → 归一化成段落。
 *
 * 已知限制（实测）：
 *   - file_urls 必须是 http(s) 公网直链；百炼临时存储的 oss:// 与内部私有链接都会被拒
 *     （REQUEST_INVALID_FILE_URL_VALUE / FILE_403_FORBIDDEN）。
 *   - 单声道足够；多声道文件按 channel_id 分开返回。
 *   - 结果里既有整段 text，也有 sentences[begin_time/end_time] 与词级 words。
 */

const DEFAULT_HOST = 'https://cn-beijing.maas.qianwenaiapi.com';
const DEFAULT_MODEL = 'qwen-audio-3.1-asr-flash-filetrans';
const POLL_INTERVAL_MS = 5000;

/**
 * 术语表：ASR 常把公司名/产品名听错，转写后先做确定性替换，再进翻译。
 * 只做字符串替换，不改句子结构；配置里的 glossary 优先于这里的默认值。
 */
const DEFAULT_GLOSSARY = [
  { from: 'WhisperFlow', to: 'Wispr Flow' },
  { from: 'Whisper Flow', to: 'Wispr Flow' },
  { from: 'Open AI', to: 'OpenAI' },
  { from: 'Deep Seek', to: 'DeepSeek' },
  { from: 'Anthro pic', to: 'Anthropic' },
];

/** 按术语表修正文本（大小写不敏感，保留原有首字母形态由术语表决定）。 */
export function applyGlossary(text, glossary = DEFAULT_GLOSSARY) {
  let out = String(text || '');
  for (const entry of glossary) {
    if (!entry || !entry.from || !entry.to) continue;
    const pattern = new RegExp(`\\b${String(entry.from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    out = out.replace(pattern, entry.to);
  }
  return out;
}
const POLL_TIMEOUT_MS = 45 * 60 * 1000;

export class AsrError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function authHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

async function requestJson(url, { method = 'GET', body, headers = {}, timeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AsrError('ASR_BAD_RESPONSE', `接口返回非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
    }
    if (!response.ok) {
      throw new AsrError('ASR_HTTP', `接口返回 HTTP ${response.status}：${json.message || json.code || text.slice(0, 200)}`, { status: response.status, json });
    }
    return json;
  } catch (error) {
    if (error && error.name === 'AbortError') throw new AsrError('ASR_TIMEOUT', '接口请求超时');
    if (error instanceof AsrError) throw error;
    throw new AsrError('ASR_NETWORK', `接口请求失败：${error && error.message ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function createAsr({ config, logger }) {
  const host = String(config.asrHost || DEFAULT_HOST).replace(/\/+$/, '');
  const model = String(config.asrCloudModel || DEFAULT_MODEL);
  const apiKey = String(config.asrApiKey || '').trim();

  function requireKey() {
    if (!apiKey) {
      throw new AsrError('ASR_NO_KEY', '缺少 ASR API Key：在插件配置里填 asrApiKey，或把 key 放在 rootDir/google 外的本地文件里由宿主注入');
    }
  }

  /** 组装请求参数：说话人分离默认开，热词用来钉住专名（如 Wispr Flow）。 */
  function buildParameters() {
    const parameters = { channel_id: [0] };
    if (config.diarization !== false) parameters.diarization_enabled = true;
    const hotwords = Array.isArray(config.hotwords) ? config.hotwords.map((w) => String(w).trim()).filter(Boolean) : [];
    if (hotwords.length) parameters.hotwords = hotwords.slice(0, 100);
    if (Number(config.speakerCount) >= 2) parameters.speaker_count = Number(config.speakerCount);
    return parameters;
  }

  /** 提交一条音频 URL，返回 taskId。 */
  async function submit(fileUrl) {
    requireKey();
    const json = await requestJson(`${host}/api/v1/services/audio/asr/transcription`, {
      method: 'POST',
      headers: { ...authHeaders(apiKey), 'X-DashScope-Async': 'enable' },
      body: { model, input: { file_urls: [fileUrl] }, parameters: buildParameters() },
    });
    const taskId = json && json.output && json.output.task_id;
    if (!taskId) throw new AsrError('ASR_NO_TASK', `提交成功但没拿到 task_id：${JSON.stringify(json).slice(0, 200)}`);
    return taskId;
  }

  /** 轮询直到终态。onTick 用来把状态写回 job。 */
  async function wait(taskId, { onTick, signal } = {}) {
    const started = Date.now();
    let last = null;
    for (;;) {
      if (signal && signal.aborted) throw new AsrError('ASR_ABORTED', '任务已取消');
      if (Date.now() - started > POLL_TIMEOUT_MS) throw new AsrError('ASR_TIMEOUT', '转写任务超时（45 分钟）');
      const json = await requestJson(`${host}/api/v1/tasks/${taskId}`, { headers: authHeaders(apiKey) });
      const output = (json && json.output) || {};
      const status = String(output.task_status || '');
      if (status !== (last || '')) {
        last = status;
        if (typeof onTick === 'function') onTick(status);
      }
      if (status === 'SUCCEEDED') return output;
      if (status === 'FAILED' || status === 'UNKNOWN') {
        throw new AsrError('ASR_TASK_FAILED', `转写失败：${output.code || ''} ${output.message || ''}`.trim(), { output });
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /** 取结果文件并归一化。 */
  async function fetchResult(output) {
    const url = output && output.transcription_url;
    if (!url) throw new AsrError('ASR_NO_RESULT_URL', '任务成功但没有 transcription_url');
    const response = await fetch(url);
    if (!response.ok) throw new AsrError('ASR_RESULT_HTTP', `结果文件下载失败：HTTP ${response.status}`);
    const doc = await response.json();
    return normalize(doc);
  }

  /** 提交并等待，端到端一次调用。 */
  async function transcribeUrl(fileUrl, { onStage, signal } = {}) {
    if (typeof onStage === 'function') onStage('submit');
    const taskId = await submit(fileUrl);
    if (typeof onStage === 'function') onStage('poll', taskId);
    const output = await wait(taskId, {
      signal,
      onTick: (status) => {
        if (typeof onStage === 'function') onStage(status === 'RUNNING' ? 'running' : 'pending', taskId);
      },
    });
    if (typeof onStage === 'function') onStage('fetch');
    return { ...(await fetchResult(output)), taskId };
  }

  return { submit, wait, fetchResult, transcribeUrl, model, host };
}

/** 轻量排版修复：云端返回的整段小写文本补上句首大写与句末标点。只改格式，不改词。 */
export function tidyText(text) {
  let out = String(text || '').trim();
  if (!out) return out;
  if (/^[a-z]/.test(out)) out = out[0].toUpperCase() + out.slice(1);
  out = out.replace(/([.!?])\s+([a-z])/g, (match, punct, ch) => `${punct} ${ch.toUpperCase()}`);
  // 英文里单独出现的 i 基本只有第一人称代词，统一大写（避开 i.e.）
  out = out.replace(/(^|[\s(])i(?=[\s,.'"!?;:]|$)/g, (match, lead) => `${lead}I`);
  if (!/[.!?…。！？"')\]]$/.test(out)) out += '.';
  return out;
}

/**
 * 把接口结果归一化成统一段落结构。
 * @param {any} doc 结果 JSON
 * @returns {{lang: string, durationSec: number, segments: Array<{i:number,startMs:number,endMs:number,text:string,words:Array<{t:string,s:number,e:number}>}>}}
 */
export function normalize(doc, glossary = DEFAULT_GLOSSARY) {
  const transcripts = Array.isArray(doc && doc.transcripts) ? doc.transcripts : [];
  const first = transcripts[0] || {};
  const sentences = Array.isArray(first.sentences) ? first.sentences : [];
  const segments = [];
  let order = 0;
  for (const sentence of sentences) {
    const text = tidyText(applyGlossary(sentence.text, glossary));
    if (!text) continue;
    const startMs = Number(sentence.begin_time) || 0;
    const endMs = Number(sentence.end_time) || startMs;
    const words = Array.isArray(sentence.words)
      ? sentence.words.map((word) => ({ t: String(word.text || ''), s: Number(word.begin_time) || startMs, e: Number(word.end_time) || endMs }))
      : [];
    const speakerId = Number.isFinite(Number(sentence.speaker_id)) ? Number(sentence.speaker_id) : null;
    segments.push({
      i: order,
      startMs,
      endMs,
      text,
      speakerId,
      speaker: speakerId === null ? '' : `Speaker ${speakerId + 1}`,
      words,
    });
    order += 1;
  }
  const durationMs = Number(doc && doc.properties && doc.properties.original_duration_in_milliseconds) || (segments.length ? segments[segments.length - 1].endMs : 0);
  return { lang: '', durationSec: Math.round(durationMs / 1000), segments };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
