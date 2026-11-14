/**
 * lib/tools.js —— Agent 工具定义（CONTRACT §6.1 / §10）。
 *
 * 只依赖运行时对象 rt 暴露的方法，不直接碰 store / jobs / pipeline。
 * 所有工具返回纯文本；失败也返回可读文本，不让异常冒到工具执行层。
 */

import { truncateChars } from './model.js';
import { SEARCH_MODES } from './config.js';

/** 统一的 text 渲染（宿主以 (args, value) 调用 render）。 */
function renderText(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : typeof value === 'object' && value !== null ? JSON.stringify(value, null, 2) : String(value ?? '') }];
}

/** 安全执行并转成文本。 */
async function safe(handler, maxLength = 20000) {
  try {
    const text = await handler();
    return truncateChars(typeof text === 'string' ? text : JSON.stringify(text, null, 2), maxLength);
  } catch (error) {
    const message = error && typeof error === 'object' && error.message ? error.message : String(error);
    return `操作失败：${message}`;
  }
}

/** 描述一轮任务状态的短句。 */
function describeJob(job) {
  if (!job) return '没有进行中的任务。';
  const stageLabels = {
    framing: '理解输入',
    basics: '基础检索与认识',
    discussion: '讨论检索与地图',
    coverage: '覆盖检查',
    planning: '问题规划',
    researching: '定向深搜',
    verifying: '证据核查',
    synthesizing: '形成判断',
    linking: '校验与写盘',
    done: '已完成',
  };
  const stage = stageLabels[job.stage] || job.stage;
  const current = job.current && job.current.label ? `；${job.current.label}` : '';
  return `${job.status} · ${stage} · ${Math.round(job.progress || 0)}%${current}`;
}

/**
 * 构建工具定义。
 * @param {any} rt createRuntime 返回的运行时
 * @returns {Array<object>}
 */
export function buildToolDefinitions(rt) {
  return [
    {
      name: 'deep_search',
      description:
        'Run a direct search through AI 大搜索. Sends the supplied query to the selected search provider and returns the ranked results, including titles, links and snippets. Use when the user asks for search engine results or requests AI 大搜索.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The original search query supplied by the user.' },
          searchProviderMode: { type: 'string', enum: SEARCH_MODES, description: 'Optional provider selection. Omit to use the plugin setting.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      async execute(args) {
        return safe(() => rt.directSearch({ query: args?.query, searchProviderMode: args?.searchProviderMode }), Infinity);
      },
    },
    {
      name: 'deep_search_status',
      description:
        'Show the status of an existing AI 大搜索 research archive. Omit topicId to list existing archives.',
      parameters: {
        type: 'object',
        properties: {
          topicId: { type: 'string', description: 'Existing archive ID. Omit to list recent archives.' },
        },
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      async execute(args) {
        return safe(async () => {
          const status = await rt.statusOf(args?.topicId);
          if (!args?.topicId) {
            const topics = Array.isArray(status?.topics) ? status.topics : [];
            const jobs = Array.isArray(status?.jobs) ? status.jobs : [];
            const lines = ['最近的深度搜索档案：'];
            if (topics.length === 0) lines.push('- （还没有档案）');
            for (const topic of topics.slice(0, 10)) {
              lines.push(`- ${topic.id} · ${topic.title} · ${topic.status} · ${topic.questionCount ?? 0} 问 / ${topic.sourceCount ?? 0} 源`);
            }
            if (jobs.length) {
              lines.push('', '最近任务：');
              for (const job of jobs.slice(0, 6)) lines.push(`- ${job.id} → ${job.topicId} · ${describeJob(job)}`);
            }
            return lines.join('\n');
          }
          const topic = status?.topic;
          const lines = [];
          if (topic) {
            lines.push(`主题：${topic.title}（${topic.id}）`);
            const counts = [`${topic.questionCount ?? 0} 个问题`, `${topic.sourceCount ?? 0} 条来源`];
            if (Number.isFinite(topic.claimCount)) counts.push(`${topic.claimCount} 条论断`);
            if (Number.isFinite(topic.evidenceCount)) counts.push(`${topic.evidenceCount} 条证据`);
            lines.push(`状态：${topic.status} · ${counts.join(' · ')} · 更新于 ${topic.updatedAt}`);
          } else {
            lines.push(`未找到档案：${args.topicId}`);
          }
          lines.push(`任务：${describeJob(status?.job)}`);
          if (status?.job?.error) lines.push(`错误：${status.job.error}`);
          return lines.join('\n');
        });
      },
    },
    {
      name: 'deep_search_read',
      description:
        'Read one section of a finished deep-search dossier as plain text. Assertions keep stable ids (c/ev/q/d/j/b); each claim states its identity and evidence status, and each evidence line its identity, stance, locator and read scope, so you can cite or re-check them. understanding is the default section.',
      parameters: {
        type: 'object',
        properties: {
          topicId: { type: 'string', description: 'Existing archive ID. Required.' },
          section: {
            type: 'string',
            description:
              'understanding (default) | discussion | questions | question:q1 | judgments | branches | sources | all. overview = understanding and map = questions are accepted aliases. all may be truncated on large dossiers; read one module when you need complete text.',
          },
        },
        required: ['topicId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      async execute(args) {
        return safe(async () => {
          if (!args?.topicId) return '缺少 topicId。';
          return rt.readSection(args.topicId, args.section || 'understanding');
        });
      },
    },
    {
      name: 'deep_search_export',
      description:
        'Export a deep-search dossier: full (complete Markdown with annotations and source index), brief (one-page Markdown), or json (raw archive). Returns the filename and content.',
      parameters: {
        type: 'object',
        properties: {
          topicId: { type: 'string', description: 'Topic id. Required.' },
          format: { type: 'string', enum: ['full', 'brief', 'json'], description: 'Default full.' },
        },
        required: ['topicId'],
        additionalProperties: false,
      },
      output: { schema: { type: 'string' }, render: renderText },
      async execute(args) {
        return safe(async () => {
          const { filename, content } = await rt.exportTopic({
            topicId: args?.topicId,
            format: args?.format || 'full',
          });
          return `文件：${filename}\n\n${truncateChars(content, 18000)}`;
        });
      },
    },
  ];
}
