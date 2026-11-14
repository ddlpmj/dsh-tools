import { createHash } from 'node:crypto';

export class ConversationError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_CHARS = 2000000;
export const contentIdentity = messages => messages.map(({ id, role, text }) => ({ id, role, text }));
export function conversationModels(messages) {
  return [...new Map(messages.filter(m => m.role === 'assistant' && m.model?.model).map(m => [m.model.provider + '/' + m.model.model, m.model])).values()];
}
const modelLabel = model => model?.model || '模型未记录';
const messageTime = value => typeof value === 'number' && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : '';

function visibleContent(content) {
  const parts = [];
  let attachments = 0;
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image' || block.type === 'file') {
      const name = String(block.attachment?.name || (block.type === 'image' ? '图片' : '文件')).replace(/[\r\n]/g, ' ');
      parts.push(`[附件：${name}；此处仅保存名称，未复制附件内容]`);
      attachments += 1;
    }
  }
  return { text: parts.join('\n\n'), attachments };
}

// Read the complete committed log, including inherited history and messages before
// compaction. Only human prompts and visible assistant messages are exported.
export function extractConversation(snapshot) {
  const messages = [];
  let title = '', running = false, attachments = 0, turn = 0;
  for (const event of snapshot.events || []) {
    if (event.type === 'session/title') title = String(event.data?.title || '');
    if (event.type === 'turn/start') { running = true; turn = Number.isSafeInteger(event.data?.turn) ? event.data.turn : turn + 1; }
    if (event.type === 'turn/end') running = false;
    if (event.surfaceOp !== 'append') continue;
    let role, content;
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      role = 'user'; content = event.data.content;
    } else if (event.type === 'assistant/message') {
      role = 'assistant'; content = event.data?.message?.content;
    } else continue;
    const visible = visibleContent(content);
    if (!visible.text.trim()) continue;
    if (!Number.isSafeInteger(event.seq)) throw new ConversationError('会话消息编号无效，无法安全保存。', 422);
    const origin = event.data?.message?.source;
    const model = role === 'assistant' && origin?.kind === 'model' && typeof origin.model === 'string'
      ? { provider: typeof origin.provider === 'string' ? origin.provider : '', model: origin.model } : null;
    messages.push({ id: String(event.seq), role, text: visible.text, model, turn,
      time: messageTime(event.time),
      phase: role === 'assistant' ? 'answer' : 'question' });
    attachments += visible.attachments;
  }
  const chars = messages.reduce((n, message) => n + message.text.length, 0);
  if (chars > MAX_CHARS) throw new ConversationError('对话超过 200 万字符，暂不支持整段保存。', 413, 'TOO_LARGE');
  title = title.replace(/[\r\n]/g, ' ').trim().slice(0, 200) || messages.find(m => m.role === 'user')?.text.replace(/\s+/g, ' ').slice(0, 60) || '未命名对话';
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'assistant' && messages[i + 1]?.role === 'assistant' && messages[i + 1].turn === messages[i].turn) messages[i].phase = 'progress';
  }
  return { sessionId: String(snapshot.session.id), title, createdAt: snapshot.session.createdAt, messages, chars, attachments, running, models: conversationModels(messages), revision: hash(contentIdentity(messages)) };
}

export function selectConversation(conversation, input) {
  if (conversation.running) throw new ConversationError('AI 仍在回复，请等回复完成后刷新预览再保存。', 409, 'CONFLICT');
  if (input.revision !== conversation.revision) throw new ConversationError('对话已有新内容，请刷新预览后重新保存。', 409, 'CONFLICT');
  if (!Array.isArray(input.messageIds) || !input.messageIds.length || input.messageIds.some(id => typeof id !== 'string')) throw new ConversationError('请至少选择一条消息。');
  const ids = new Set(input.messageIds);
  const messages = conversation.messages.filter(m => ids.has(m.id));
  if (ids.size !== input.messageIds.length || messages.length !== ids.size) throw new ConversationError('所选消息已变化，请刷新预览。', 409, 'CONFLICT');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.trim().length > 200) throw new ConversationError('标题需为 1～200 字。');
  const title = input.title.replace(/[\r\n]/g, ' ').trim();
  // Keep v1 identity stable when model/timestamp metadata is added later.
  const fingerprint = hash({ sessionId: conversation.sessionId, messages: contentIdentity(messages) });
  const scope = messages.length === conversation.messages.length ? '完整对话' : `所选 ${messages.length} 条消息`;
  const models = conversationModels(messages);
  const groups = [];
  for (const message of messages) {
    if (groups.at(-1)?.role === message.role) groups.at(-1).messages.push(message);
    else groups.push({ role: message.role, messages: [message] });
  }
  const markdown = `# ${title}\n\n${scope} · ${messages.length} 条消息\n\n使用模型：${models.length ? models.map(modelLabel).join('、') : '模型未记录'}\n\n` + groups.map(group => {
    const names = [...new Set(group.messages.map(m => modelLabel(m.model)))];
    return `## ${group.role === 'user' ? '我：' : 'AI · ' + names.join(' / ')}\n\n` + group.messages.map((m, i) => {
      const previous = group.messages[i - 1];
      const changed = previous && (previous.model?.model !== m.model?.model || previous.model?.provider !== m.model?.provider);
      return (changed ? `模型：${modelLabel(m.model)}\n\n` : '') + m.text;
    }).join('\n\n');
  }).join('\n\n') + '\n';
  const metadata = { sessionId: conversation.sessionId, messageIds: messages.map(m => m.id), messageCount: messages.length, scope, revision: conversation.revision, models, formatVersion: 2 };
  return { title, markdown, fingerprint, conversation: metadata, transcript: { ...metadata, messages, fingerprint, version: 2 } };
}

export function validateSessionId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,180}$/.test(value)) throw new ConversationError('会话编号无效。');
  return value;
}
