/**
 * dsh-ai-records —— 宿主半侧入口。
 *
 * 只做平台适配：把 lib/plugin.js 的 createRuntime 接到宿主服务上。
 *   - 路由：ctx.webServer.register({ kind:'prefix', path:'/dsh-ai-records' })
 *   - 工具：ctx.get('tools').register(...)（可选服务）
 *   - system prompt：一段简短说明（可选服务）
 *   - 生命周期：ctx.effect(...) 注册与卸载，首轮初始化 rt.init()
 */

import { createRuntime, PLUGIN_NAME, ROUTE_PREFIX } from './lib/plugin.js';

export const name = PLUGIN_NAME;

/** 唯一硬依赖：WebServer（路由注册面）。tools / systemPrompt 都是可选服务。 */
export const inject = ['webServer'];


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
  return { info: (m) => write('info', m), warn: (m) => write('warn', m), error: (m) => write('error', m) };
}

function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

function fmtClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const rt = createRuntime({
    ctx,
    config,
    deps: {
      logger: log,
      origin: () => {
        try {
          const server = ctx.webServer;
          return server && typeof server.getOrigin === 'function' ? server.getOrigin() : 'http://127.0.0.1:57810';
        } catch {
          return 'http://127.0.0.1:57810';
        }
      },
    },
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => rt.handleRoute(req, res),
      }),
    'dsh-ai-records: routes',
  );

  const tools = getService(ctx, 'tools');
  if (tools && typeof tools.register === 'function') {
    const definitions = [
      {
        name: 'archive_ingest',
        description: '把一条可公网访问的音频/播客链接加入「AI 访谈档案」，后台转写并翻译成中文。返回条目与任务 id。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '音频或播客直链（http/https，服务端要能取到）' },
            title: { type: 'string', description: '标题' },
            sourceName: { type: 'string', description: '节目或发布方' },
            kind: { type: 'string', enum: ['interview', 'roundtable', 'keynote', 'qa'], description: '内容类型' },
          },
          required: ['url'],
        },
        async execute(args) {
          const { item, job } = rt.enqueue({ ...args, mediaUrl: args.url, sourceUrl: args.url });
          return text(`已入队：${item.title}（条目 ${item.id}，任务 ${job.id}）`);
        },
      },
      {
        name: 'archive_list',
        description: '列出「AI 访谈档案」里的条目，按发布时间倒序。',
        parameters: { type: 'object', properties: { limit: { type: 'number' } } },
        async execute(args) {
          const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
          const items = rt.store.list().slice(0, limit);
          if (!items.length) return text('资料库还是空的。');
          return text(
            items
              .map((it) => `${it.id}｜${it.title}｜${fmtClock(it.durationSec * 1000)}｜转写:${(it.status && it.status.asr) || '-'} 翻译:${(it.status && it.status.translate) || '-'}`)
              .join('\n'),
          );
        },
      },
      {
        name: 'archive_read',
        description: '读一条访谈的逐字稿与中文译文。可按时间范围截取，避免一次读太长。',
        parameters: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            fromMs: { type: 'number', description: '起始毫秒' },
            toMs: { type: 'number', description: '结束毫秒' },
            limit: { type: 'number', description: '最多段落数，默认 60' },
          },
          required: ['id'],
        },
        async execute(args) {
          const transcript = rt.store.getTranscript(args.id);
          if (!transcript) return text('没有这条的逐字稿。');
          const translation = rt.store.getTranslation(args.id);
          const from = Number(args.fromMs) || 0;
          const to = Number(args.toMs) || Number.MAX_SAFE_INTEGER;
          const limit = Math.min(200, Math.max(1, Number(args.limit) || 60));
          const rows = transcript.segments.filter((s) => s.endMs >= from && s.startMs <= to).slice(0, limit);
          return text(
            rows
              .map((s) => {
                const zh = translation && translation.segments ? translation.segments[s.i] : '';
                return `[${fmtClock(s.startMs)}] ${s.text}${zh ? `\n    ${zh}` : ''}`;
              })
              .join('\n'),
          );
        },
      },
      {
        name: 'archive_search',
        description: '在「AI 访谈档案」里跨条目检索原文与中文译文，返回命中段落和可用作跳转的时间戳。',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string' }, limit: { type: 'number' } },
          required: ['q'],
        },
        async execute(args) {
          const hits = rt.store.search(args.q, { limit: Math.min(40, Number(args.limit) || 12) });
          if (!hits.length) return text('没有命中。');
          return text(
            hits
              .map((hit) => {
                const head = `${hit.title}（${hit.id}）`;
                const body = hit.matched.map((m) => `  [${fmtClock(m.startMs)}] ${m.text}`).join('\n');
                return `${head}\n${body}`;
              })
              .join('\n\n'),
          );
        },
      },
      {
        name: 'archive_status',
        description: '查看「AI 访谈档案」的运行状态：条目数、转写/翻译完成数、最近任务。',
        parameters: { type: 'object', properties: {} },
        async execute() {
          const stats = rt.store.stats();
          const jobs = rt.publicJobs().slice(0, 8);
          const lines = [`条目 ${stats.total}｜转写完成 ${stats.asrDone}｜翻译完成 ${stats.translateDone}`];
          for (const job of jobs) lines.push(`· ${job.stage} ${job.progress}% ${job.title}${job.error ? ` — ${job.error}` : ''}`);
          return text(lines.join('\n'));
        },
      },
    ];

    for (const definition of definitions) {
      try {
        ctx.effect(() => tools.register(definition), `dsh-ai-records: tool ${definition.name}`);
      } catch (error) {
        log.warn(`注册工具 ${definition.name} 失败：${error && error.message ? error.message : String(error)}`);
      }
    }
  }

  const systemPrompt = getService(ctx, 'systemPrompt');
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    ctx.effect(
      () =>
        systemPrompt.section({
          name: 'dsh-ai-records',
          order: 62,
          text: () =>
            [
              '「AI 访谈档案」插件已安装：一个收录 AI 访谈、圆桌与发布会的本地资料库，带时间戳原文与中文译文。',
              '- 用户给出音频/播客链接并要求收录时，用 archive_ingest 入队，然后告诉用户在面板里看进度。',
              '- 需要引用原话时用 archive_search 找到段落与时间戳，再用 archive_read 读上下文。',
              '- 引用时带上时间戳，不要改写原文语气。',
            ].join('\n'),
        }),
      'dsh-ai-records: prompt section',
    );
  }

  ctx.effect(() => () => rt.dispose(), 'dsh-ai-records: dispose');

  Promise.resolve()
    .then(() => rt.init())
    .catch((error) => log.warn(`初始化失败（插件仍可运行）：${error && error.message ? error.message : String(error)}`));
}
