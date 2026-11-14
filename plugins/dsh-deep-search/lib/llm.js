/**
 * lib/llm.js —— 模型路由、流式聚合、JSON 提取与一次修复（CONTRACT §5 / §7）。
 *
 * 路由解析顺序：
 *  1. config.modelProvider + config.model（显式指定）
 *  2. agentDefaultModel.currentSelection() 且 provider 是 deepseek-account 且模型非空
 *  3. { provider:'deepseek-account', model: selection?.model || 'deepseek-flash' }
 *  4. listProviders() 里第一个有 models[0] 的 provider
 * 首选路由失败（MISSING_CREDENTIAL / 空文本等）自动换下一条，最多尝试 2 条。
 *
 * 默认 maxTokens 6000：framing / repair 输出较长，4000 容易截断；实测 maxTokens < ~100 时
 * 推理会占满预算返回空文本，空文本按失败处理。
 */

import { errorMessage, redactSecrets } from './http.js';

const DEFAULT_MAX_TOKENS = 12000;
const MAX_ROUTES = 4;
const MAX_ATTEMPTS = 2;
const SESSION_ID = `dsh-deep-search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** LLM 层错误。 */
export class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function providerName(route) {
  return route && route.provider ? String(route.provider) : '';
}

function modelName(route) {
  return route && route.model ? String(route.model) : '';
}

function dedupeRoutes(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    if (!route || !route.provider) continue;
    const provider = providerName(route);
    const model = modelName(route);
    const key = `${provider}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, model });
  }
  return out;
}

/** 宽松 JSON 提取：去 ``` 围栏 → 取第一个平衡的 {...} → JSON.parse（允许尾逗号重试）。 */
export function parseJsonLoose(raw) {
  const source = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!source.trim()) return { ok: false, error: '模型输出为空', value: undefined };

  const fenced = /```(?:json|javascript|js)?\s*([\s\S]*?)```/i.exec(source);
  const text = (fenced ? fenced[1] : source).trim();

  const candidates = [];
  const firstBrace = text.indexOf('{');
  if (firstBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = firstBrace; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end > firstBrace) candidates.push(text.slice(firstBrace, end + 1));
  }
  candidates.push(text);

  for (const candidate of candidates) {
    for (const attempt of [candidate, candidate.replace(/,\s*([}\]])/g, '$1')]) {
      try {
        const value = JSON.parse(attempt);
        if (value && typeof value === 'object') return { ok: true, value };
      } catch {
        /* 继续尝试 */
      }
    }
  }
  return { ok: false, error: '无法从模型输出中解析出 JSON 对象', value: undefined, raw: source.slice(0, 500) };
}

function normalizeValidation(result) {
  if (result == null) return [];
  if (Array.isArray(result)) return result.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
  if (typeof result === 'string') return result.trim() ? [result] : [];
  if (typeof result === 'boolean') return result ? [] : ['校验未通过'];
  if (typeof result === 'object') {
    if (Array.isArray(result.errors)) return normalizeValidation(result.errors);
    if (result.ok === false) return [typeof result.message === 'string' ? result.message : '校验未通过'];
    return [];
  }
  return [];
}

function runValidation(validate, value) {
  if (typeof validate !== 'function') return [];
  try {
    return normalizeValidation(validate(value));
  } catch (error) {
    return [errorMessage(error, 300)];
  }
}

function buildBuiltinRepair({ raw, error }) {
  const snippet = typeof raw === 'string' ? raw.slice(0, 8000) : String(raw ?? '').slice(0, 8000);
  return {
    system:
      '你是 JSON 修复器。只输出一个严格合法的 JSON 对象，不要输出解释、Markdown 围栏或任何多余文字。字段名与结构必须保持原意，不要编造新事实。',
    prompt: [
      '下面是一段需要修复的模型输出，以及它为什么无法通过解析或校验。',
      `错误：${typeof error === 'string' ? error : JSON.stringify(error)}`,
      '',
      '原始输出：',
      '<<<',
      snippet,
      '>>>',
      '',
      '请只输出修复后的 JSON 对象。',
    ].join('\n'),
  };
}

/**
 * @param {{ctx:object, config:object, logger:object}} options
 */
export function createLlmService({ ctx, config, logger = console } = {}) {
  let promptsPromise = null;
  let lastUsage = null;
  let lastRoute = null;

  function logWarn(message) {
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(`[llm] ${redactSecrets(message)}`);
    } catch {
      /* ignore */
    }
  }

  function getService(name) {
    try {
      return typeof ctx?.get === 'function' ? ctx.get(name) : undefined;
    } catch {
      return undefined;
    }
  }

  function llmService() {
    const llm = getService('llm');
    return llm && typeof llm.stream === 'function' ? llm : null;
  }

  function currentSelection() {
    try {
      const service = getService('agentDefaultModel');
      if (service && typeof service.currentSelection === 'function') return service.currentSelection() || null;
    } catch {
      /* ignore */
    }
    return null;
  }

  function resolveRoutes() {
    const routes = [];
    const explicitProvider = typeof config.modelProvider === 'string' ? config.modelProvider.trim() : '';
    const explicitModel = typeof config.model === 'string' ? config.model.trim() : '';
    if (explicitProvider && explicitModel) routes.push({ provider: explicitProvider, model: explicitModel });

    const selection = currentSelection();
    if (selection && selection.provider === 'deepseek-account' && selection.model) {
      routes.push({ provider: selection.provider, model: selection.model });
    }
    routes.push({ provider: 'deepseek-account', model: (selection && selection.model) || 'deepseek-flash' });

    try {
      const service = getService('llm');
      const providers = service && typeof service.listProviders === 'function' ? service.listProviders() : [];
      for (const provider of Array.isArray(providers) ? providers : []) {
        if (!provider || !provider.id) continue;
        const first = Array.isArray(provider.models) ? provider.models[0] : null;
        const model = typeof first === 'string' ? first : first && (first.id || first.name || first.model);
        if (model) routes.push({ provider: String(provider.id), model: String(model) });
      }
    } catch {
      /* ignore */
    }

    return dedupeRoutes(routes).slice(0, MAX_ROUTES);
  }

  async function streamOnce(route, { system, prompt, maxTokens, signal }) {
    const llm = llmService();
    if (!llm) {
      throw new LlmError('LLM_UNAVAILABLE', '宿主 llm 服务不可用', { route });
    }
    const tokens = Math.max(1, Math.round(Number(maxTokens) || config.llmMaxTokens || DEFAULT_MAX_TOKENS));
    let stream;
    try {
      stream = await llm.stream({
        provider: route.provider,
        model: route.model,
        system: typeof system === 'string' ? system : '',
        messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt ?? '') }] }],
        sessionId: SESSION_ID,
        signal,
        maxTokens: tokens,
        // 结构化研究任务默认关掉思维链，避免推理占满输出预算后返回空文本。
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
      });
    } catch (error) {
      if (signal && signal.aborted) throw Object.assign(new Error('LLM 调用被取消'), { name: 'AbortError' });
      throw new LlmError('LLM_UNAVAILABLE', `模型调用失败：${errorMessage(error, 300)}`, { route, cause: error });
    }
    if (!stream) throw new LlmError('LLM_UNAVAILABLE', '模型服务没有返回流', { route });

    let text = '';
    let finishReason = '';
    lastUsage = null;
    try {
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk.type === 'finish') finishReason = chunk.reason && chunk.reason.kind ? String(chunk.reason.kind) : 'finish';
        else if (chunk.type === 'usage' && chunk.usage) lastUsage = chunk.usage;
      }
    } catch (error) {
      if (signal && signal.aborted) throw Object.assign(new Error('LLM 调用被取消'), { name: 'AbortError' });
      throw new LlmError('LLM_UNAVAILABLE', `模型流读取失败：${errorMessage(error, 300)}`, { route, cause: error });
    }
    if (!text.trim()) {
      throw new LlmError('LLM_EMPTY', `模型返回空文本（finish=${finishReason || 'unknown'}，maxTokens=${tokens}）`, { route });
    }
    return text;
  }

  /**
   * 一次补全，返回纯文本。失败会尝试下一条路由（最多 2 条）。
   */
  async function complete({ system = '', prompt = '', maxTokens, signal } = {}) {
    if (!String(prompt ?? '').trim()) throw new LlmError('BAD_REQUEST', 'prompt 为空');
    const routes = resolveRoutes();
    if (!routes.length) {
      throw new LlmError('LLM_UNAVAILABLE', '没有可用的模型路由', {
        hint: '检查 plugin config.modelProvider / config.model，或在 DSH 里登录 deepseek-account。',
      });
    }
    const failures = [];
    let attempts = 0;
    for (const route of routes) {
      if (attempts >= MAX_ATTEMPTS) break;
      attempts += 1;
      try {
        const text = await streamOnce(route, { system, prompt, maxTokens, signal });
        lastRoute = route;
        return text;
      } catch (error) {
        if (signal && signal.aborted) throw error;
        if (error && (error.name === 'AbortError' || error.code === 'ABORT_ERR')) throw error;
        failures.push(`${route.provider}/${route.model}：${errorMessage(error, 200)}`);
        logWarn(`路由 ${route.provider}/${route.model} 失败，尝试下一条：${errorMessage(error, 200)}`);
      }
    }
    const last = failures[failures.length - 1] || '未知错误';
    throw new LlmError('LLM_UNAVAILABLE', `模型调用失败（尝试 ${attempts} 条路由）：${failures.join('；') || last}`, {
      hint: '确认 DSH 已登录 deepseek-account，或在配置里指定可用的 modelProvider/model。',
    });
  }

  async function loadPrompts() {
    if (!promptsPromise) {
      promptsPromise = import('./prompts.js').catch(() => null);
    }
    return promptsPromise;
  }

  async function repairPrompt(input) {
    try {
      const prompts = await loadPrompts();
      if (prompts && typeof prompts.buildRepairPrompt === 'function') {
        const built = await prompts.buildRepairPrompt(input);
        if (built && typeof built.prompt === 'string' && built.prompt.trim()) {
          return { system: typeof built.system === 'string' ? built.system : '', prompt: built.prompt };
        }
      }
    } catch (error) {
      logWarn(`buildRepairPrompt 不可用，使用内置修复提示：${errorMessage(error, 160)}`);
    }
    return buildBuiltinRepair(input);
  }

  /**
   * 要求模型输出 JSON 并校验；失败时用修复提示再试一次。
   * @param {{system?:string, prompt:string, maxTokens?:number, signal?:AbortSignal, validate?:Function}} input
   */
  async function json({ system = '', prompt, maxTokens, signal, validate } = {}) {
    const firstRaw = await complete({ system, prompt, maxTokens, signal });
    let parsed = parseJsonLoose(firstRaw);
    let errors = parsed.ok ? runValidation(validate, parsed.value) : [parsed.error];
    if (parsed.ok && errors.length === 0) return parsed.value;

    const repair = await repairPrompt({
      raw: firstRaw,
      errors,
      schemaHint: '',
      originalPrompt: prompt,
      system,
      // 兼容内置修复提示（prompts.js 未就绪时）
      error: errors.join('；') || parsed.error || 'JSON 解析失败',
      prompt,
    });
    const secondRaw = await complete({
      system: repair.system || system,
      prompt: repair.prompt,
      maxTokens,
      signal,
    });
    parsed = parseJsonLoose(secondRaw);
    errors = parsed.ok ? runValidation(validate, parsed.value) : [parsed.error];
    if (parsed.ok && errors.length === 0) return parsed.value;

    const snippet = redactSecrets(String(secondRaw || firstRaw || '')).slice(0, 500);
    const error = new LlmError(
      'LLM_JSON_INVALID',
      `模型输出两次都不是合法 / 合规 JSON：${errors.join('；')}；原文片段：${snippet}`,
      { raw: String(secondRaw || firstRaw || '').slice(0, 4000) },
    );
    throw error;
  }

  /** 轻量探测：服务存在 + 路由可解析（不发起真实补全，不烧 token）。 */
  function probe() {
    try {
      const service = llmService();
      if (!service) return { ok: false, provider: '', model: '', routes: [], error: 'LLM 服务不可用' };
      const routes = resolveRoutes();
      if (!routes.length) return { ok: false, provider: '', model: '', routes: [], error: '没有可用模型路由' };
      return { ok: true, provider: routes[0].provider, model: routes[0].model, routes, error: '' };
    } catch (error) {
      return { ok: false, provider: '', model: '', routes: [], error: errorMessage(error, 300) };
    }
  }

  function clearCache() {
    lastUsage = null;
    lastRoute = null;
  }

  return {
    complete,
    json,
    probe,
    clearCache,
    parseJsonLoose,
    get lastUsage() {
      return lastUsage;
    },
    get lastRoute() {
      return lastRoute;
    },
  };
}

export { DEFAULT_MAX_TOKENS };
