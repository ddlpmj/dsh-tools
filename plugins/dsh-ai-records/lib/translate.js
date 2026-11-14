/**
 * lib/translate.js —— 按段翻译（宿主 llm 服务）。
 *
 * 对齐原则：段落下标是唯一主键。请求里带序号，回包里必须是等长数组；
 * 长度不符先做一次修复，再失败就整批标记失败，绝不把译文错位挂到别的段落上。
 *
 * 预算原则：只翻传进来的段落，支持从已有译文续跑（已译段落跳过）。
 */

const DEFAULT_BATCH_CHARS = 2400;
const DEFAULT_MAX_TOKENS = 8000;

export class TranslateError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function routes(services) {
  const out = [];
  const push = (provider, model) => {
    if (!provider) return;
    const key = `${provider}::${model || ''}`;
    if (out.some((r) => `${r.provider}::${r.model}` === key)) return;
    out.push({ provider, model: model || '' });
  };
  try {
    const selectionService = services.get('agentDefaultModel');
    const selection = selectionService && typeof selectionService.currentSelection === 'function' ? selectionService.currentSelection() : null;
    if (selection && selection.provider) push(selection.provider, selection.model);
  } catch {
    /* ignore */
  }
  try {
    const llm = services.get('llm');
    const providers = llm && typeof llm.listProviders === 'function' ? llm.listProviders() : [];
    for (const provider of providers || []) {
      const models = provider && Array.isArray(provider.models) ? provider.models : [];
      const first = models[0];
      const id = first && (typeof first === 'string' ? first : first.id || first.model);
      if (id) push(provider.id || provider.name, id);
    }
  } catch {
    /* ignore */
  }
  return out.slice(0, 3);
}

/** 宽松 JSON 数组解析。 */
export function parseArrayLoose(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced ? fenced[1].trim() : text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(body.slice(start, end + 1));
      if (Array.isArray(value)) return value.map((x) => String(x == null ? '' : x));
    } catch {
      /* fall through */
    }
  }
  return null;
}

export function createTranslator({ services, config, logger }) {
  const sessionId = `dsh-ai-records-${Date.now().toString(36)}`;
  const batchChars = Number(config.translateBatchChars) || DEFAULT_BATCH_CHARS;
  const maxTokens = Number(config.translateMaxTokens) || DEFAULT_MAX_TOKENS;

  async function callModel({ system, prompt, signal, route }) {
    const llm = services.get('llm');
    if (!llm || typeof llm.stream !== 'function') throw new TranslateError('LLM_UNAVAILABLE', '宿主 llm 服务不可用');
    const stream = await llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      sessionId,
      signal,
      maxTokens,
    });
    let text = '';
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    }
    if (!text.trim()) throw new TranslateError('LLM_EMPTY', '模型返回空文本');
    return text;
  }

  /**
   * 翻译一批段落。
   * @param {Array<{i:number,text:string}>} segments
   * @param {{title?:string, glossary?:string[], signal?:AbortSignal, onProgress?:(done:number,total:number)=>void}} options
   * @returns {Promise<{segments:string[], failed:number[]}>}
   */
  async function translateSegments(segments, options = {}) {
    const list = Array.isArray(segments) ? segments : [];
    const result = new Array(list.length).fill('');
    const failed = [];
    if (!list.length) return { segments: result, failed };

    const available = routes(services);
    if (!available.length) throw new TranslateError('LLM_UNAVAILABLE', '没有可用的模型路由，请在 DSH 里登录或选模型');
    const route = available[0];

    const system = [
      '你是科技媒体编辑，负责把英文访谈逐段译成简体中文。',
      '规则：逐段对应，不合并不拆分；保留专有名词、产品名、模型名的英文原文；不添加解释；不省略口语填充。',
      options.glossary && options.glossary.length ? `术语表（优先采用）：${options.glossary.join('、')}` : '',
      '只输出一个 JSON 数组，元素是各段的中文译文，顺序与输入完全一致，不要输出任何其他文字。',
    ]
      .filter(Boolean)
      .join('\n');

    let done = 0;
    let cursor = 0;
    while (cursor < list.length) {
      const batch = [];
      let chars = 0;
      while (cursor + batch.length < list.length && chars < batchChars) {
        const seg = list[cursor + batch.length];
        chars += String(seg.text || '').length + 8;
        batch.push(seg);
      }
      if (!batch.length) break;

      const numbered = batch.map((seg, n) => `[[${n + 1}]] ${String(seg.text || '').trim()}`).join('\n');
      const prompt = [
        options.title ? `节目：${options.title}` : '',
        `请翻译下面 ${batch.length} 段，输出长度恰为 ${batch.length} 的 JSON 字符串数组。`,
        numbered,
      ]
        .filter(Boolean)
        .join('\n\n');

      let parsed = null;
      for (let attempt = 0; attempt < 2 && !parsed; attempt += 1) {
        const extra = attempt === 0 ? '' : `\n\n注意：上一次输出不是长度为 ${batch.length} 的 JSON 数组，这次只输出数组本身。`;
        try {
          const raw = await callModel({ system, prompt: prompt + extra, signal: options.signal, route });
          const candidate = parseArrayLoose(raw);
          if (candidate && candidate.length === batch.length) parsed = candidate;
        } catch (error) {
          if (options.signal && options.signal.aborted) throw error;
          if (logger && logger.warn) logger.warn(`[ai-records] 翻译批次失败：${error && error.message ? error.message : String(error)}`);
        }
      }

      if (parsed) {
        parsed.forEach((zh, n) => {
          result[cursor + n] = zh;
        });
      } else {
        batch.forEach((seg, n) => failed.push(seg.i != null ? seg.i : cursor + n));
      }

      cursor += batch.length;
      done += batch.length;
      if (typeof options.onProgress === 'function') options.onProgress(done, list.length);
    }
    return { segments: result, failed };
  }

  /**
   * 生成内容摘要：输入节选，输出 {type, topic, summary, points[]}。
   * 只读节选（开头/中段/结尾），不送全文，控制成本。
   */
  /**
   * 生成结构化摘要卡：主题、一句话结论、概要、观点（带出处）、亮点。
   * 输入是节选 + 可选的嘉宾信息，输出严格 JSON。
   */
  async function summarize({ title, sample, host, guests, signal }) {
    const available = routes(services);
    if (!available.length) throw new TranslateError('LLM_UNAVAILABLE', '没有可用的模型路由');
    const system = [
      '你是科技媒体的资深编辑，要给一期访谈/圆桌/发布会做一张「读完就懂」的摘要卡。',
      '输出严格 JSON，字段：',
      '{"topic":"一句话题目，20 字内","oneLine":"一句话说清这期的核心结论或最大反差，35 字内","summary":"220-280 字概要：谁在谈什么、为什么现在谈、讲了哪些关键事实","points":[{"by":"谁说的（主持人/嘉宾名，没有就写发言人）","text":"这个人的一个明确观点，30-45 字"}],"highlights":["2-3 条亮点：具体数字、反直觉说法、可引用的金句，每条 25 字内"]}',
      '规则：只写节选里出现过的内容，不推测；points 给 3-5 条，要能看出分歧或立场差异；不要写"本期节目将带你了解"这类空话；只输出 JSON。',
      host ? `主持人：${host}` : '',
      guests && guests.length ? `嘉宾：${guests.join('、')}` : '',
    ].filter(Boolean).join('\n');
    const prompt = [`标题：${title || ''}`, '', '节选：', String(sample || '').slice(0, 7000)].join('\n');
    const raw = await callModel({ system, prompt, signal, route: available[0] });
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new TranslateError('SUMMARY_BAD_JSON', '摘要不是合法 JSON');
    const parsed = JSON.parse(body.slice(start, end + 1));
    return {
      topic: String(parsed.topic || '').slice(0, 60),
      oneLine: String(parsed.oneLine || '').slice(0, 120),
      summary: String(parsed.summary || '').slice(0, 800),
      points: (Array.isArray(parsed.points) ? parsed.points : [])
        .map((point) => ({ by: String((point && point.by) || '').slice(0, 40), text: String((point && point.text) || '').slice(0, 160) }))
        .filter((point) => point.text)
        .slice(0, 5),
      highlights: (Array.isArray(parsed.highlights) ? parsed.highlights : []).map((line) => String(line).slice(0, 140)).filter(Boolean).slice(0, 3),
    };
  }

  /** 从标题与页面描述里认人：主持人、嘉宾、机构。 */
  async function profile({ title, description, showName, signal }) {
    const available = routes(services);
    if (!available.length) return { host: '', guests: [], org: '' };
    const system = [
      '你是节目信息整理员。给你一期节目的标题和官方描述，判断主持人和嘉宾。',
      '输出严格 JSON：{"host":"主持人姓名，没有就空字符串","guests":["嘉宾姓名"],"org":"节目或主办方名称"}',
      '规则：优先用描述里明确出现的名字；如果描述没写但节目本身就是主持人名字命名的，可以据此填 host；其余情况留空，不要猜；名字保留英文原文；只输出 JSON。',
    ].join('\n');
    const prompt = [
      showName ? `节目：${showName}` : '',
      `标题：${title || ''}`,
      '',
      '官方描述：',
      String(description || '').slice(0, 3500),
    ].filter(Boolean).join('\n');
    try {
      const raw = await callModel({ system, prompt, signal, route: available[0] });
      const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
      const body = fenced ? fenced[1] : raw;
      const start = body.indexOf('{');
      const end = body.lastIndexOf('}');
      if (start < 0 || end <= start) return { host: '', guests: [], org: '' };
      const parsed = JSON.parse(body.slice(start, end + 1));
      return {
        host: String(parsed.host || '').slice(0, 60),
        guests: (Array.isArray(parsed.guests) ? parsed.guests : []).map((name) => String(name).slice(0, 60)).filter(Boolean).slice(0, 6),
        org: String(parsed.org || '').slice(0, 60),
      };
    } catch {
      return { host: '', guests: [], org: '' };
    }
  }

  /**
   * 生成章节与关键片段。输入带时间戳的段落清单，输出章节骨架。
   * 只读节选段落（均匀抽样），控制输入长度。
   */
  async function outline({ title, segments, signal }) {
    const available = routes(services);
    if (!available.length) throw new TranslateError('LLM_UNAVAILABLE', '没有可用的模型路由');
    const system = [
      '你是播客编辑，负责给一期节目切章节。',
      '输入是一串带秒级时间戳的句子。输出严格 JSON：{"chapters":[{"startSec":数字,"title":"章节名（8 字内）","moments":[{"startSec":数字,"title":"这一章里最值得单独拎出来的一句话（25 字内，用中文概括，不要直译长句）"}]}]}。',
      '规则：6-12 章；每章 1-3 个 moments；startSec 必须来自输入里出现过的时间戳；覆盖开头到结尾；不要编造内容。',
      '只输出 JSON。',
    ].join('\n');
    const list = (segments || []).map((seg) => `${Math.round(seg.startMs / 1000)}s ${seg.text}`).join('\n').slice(0, 9000);
    const prompt = [`节目：${title || ''}`, '', list].join('\n');
    const raw = await callModel({ system, prompt, signal, route: available[0] });
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new TranslateError('OUTLINE_BAD_JSON', '章节输出不是合法 JSON');
    const parsed = JSON.parse(body.slice(start, end + 1));
    const chapters = (Array.isArray(parsed.chapters) ? parsed.chapters : [])
      .map((chapter) => ({
        startMs: Math.max(0, Number(chapter.startSec) || 0) * 1000,
        title: String(chapter.title || '').slice(0, 40),
        moments: (Array.isArray(chapter.moments) ? chapter.moments : [])
          .map((moment) => ({ startMs: Math.max(0, Number(moment.startSec) || 0) * 1000, title: String(moment.title || '').slice(0, 80) }))
          .filter((moment) => moment.title),
      }))
      .filter((chapter) => chapter.title)
      .sort((a, b) => a.startMs - b.startMs);
    return { chapters };
  }

  return { translateSegments, summarize, outline, profile };
}
