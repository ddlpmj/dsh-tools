/**
 * dsh-deep-search —— 宿主半侧（host half）Cordis 插件入口。
 *
 * 只做平台适配：把 lib/plugin.js 的 createRuntime 接到宿主服务上：
 *   - 路由：ctx.webServer.register({ kind:'prefix', path:'/dsh-deep-search' })
 *   - 工具：ctx.get('tools').register(...)（可选服务）
 *   - system prompt：一段简短使用说明（可选服务）
 *   - 生命周期：ctx.effect(...) 注册与卸载；首轮初始化 rt.init()
 *
 * 业务逻辑全部在 lib/ 下，不 import 任何 @deepseek-ai/*。
 */

import { fileURLToPath } from 'node:url';

import {
  createRuntime,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  ROUTE_PREFIX,
  PROMPT_SECTION_NAME,
  PROMPT_SECTION_ORDER,
} from './lib/plugin.js';

export const name = PLUGIN_NAME;

/** 唯一硬依赖：WebServer（路由注册面）；tools / systemPrompt 都是可选服务。 */
export const inject = ['webServer'];

const PLUGIN_ROOT = fileURLToPath(new URL('.', import.meta.url));

function getService(ctx, serviceName) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(serviceName) : undefined;
  } catch {
    return undefined;
  }
}

function makeLogger(ctx) {
  const logger = ctx && ctx.logger;
  const prefix = `[${PLUGIN_NAME}]`;
  const write = (level, message) => {
    try {
      if (logger && typeof logger[level] === 'function') logger[level](`${prefix} ${message}`);
      else if (level === 'error') console.error(`${prefix} ${message}`);
      else if (level === 'warn') console.warn(`${prefix} ${message}`);
    } catch {
      /* ignore */
    }
  };
  return {
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  };
}

export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const rt = createRuntime({
    ctx,
    config,
    deps: {
      logger: log,
      version: PLUGIN_VERSION,
      pluginRoot: PLUGIN_ROOT,
      homeDir: process.env.HOME || '',
      now: () => new Date(),
    },
  });

  ctx.provide('dshResearchSearch', { search: rt.searchWeb });

  // 1) HTTP 路由
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => rt.handleRoute(req, res),
      }),
    'dsh-deep-search: routes',
  );

  // 2) Agent 工具（可选服务）
  const tools = getService(ctx, 'tools');
  if (tools && typeof tools.register === 'function') {
    let definitions = [];
    try {
      definitions = rt.buildToolDefinitions();
    } catch (error) {
      log.warn(`构建工具定义失败：${error && error.message ? error.message : String(error)}`);
    }
    for (const definition of definitions) {
      try {
        ctx.effect(() => tools.register(definition), `dsh-deep-search: tool ${definition.name}`);
      } catch (error) {
        log.warn(`注册工具 ${definition.name} 失败：${error && error.message ? error.message : String(error)}`);
      }
    }
  }

  // 3) system prompt：告诉模型什么时候用这套工具
  const systemPrompt = getService(ctx, 'systemPrompt');
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: PROMPT_SECTION_NAME,
          order: PROMPT_SECTION_ORDER,
          text: () =>
            [
              '「AI 大搜索」提供搜索引擎直搜。用户指定使用它时，用 deep_search 提交用户的原始搜索词。',
              '- 按返回顺序呈现结果，保留标题、原始链接和摘要。用户指定搜索引擎时，传入对应的 searchProviderMode。',
              '- 已有研究档案可通过 deep_search_status、deep_search_read 和 deep_search_export 查阅或导出。',
            ].join('\n'),
        }),
      'dsh-deep-search: prompt section',
    );
  }

  // 4) 卸载清理
  ctx.effect(() => () => rt.dispose(), 'dsh-deep-search: dispose');

  // 5) 首轮初始化（建目录 / 读索引），失败只 warn，不阻塞插件加载
  Promise.resolve()
    .then(() => rt.init())
    .catch((error) => log.warn(`初始化失败（插件仍可运行）：${error && error.message ? error.message : String(error)}`));
}
