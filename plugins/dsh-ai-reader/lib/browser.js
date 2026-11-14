/** Optional Bloomberg browser transport. Uses the installed Ego Lite CLI, never a shell. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isBloombergArticleUrl } from './bloomberg.js';

const SPACE_NAME = 'DSH AI 阅读助手浏览器';
const MARKER = '__DSH_READER_BROWSER__';
let queue = Promise.resolve();
let availableAfter = 0;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

async function executable(command) {
  if (command) return command;
  for (const candidate of [path.join(os.homedir(), '.local/bin/ego-browser'), '/opt/homebrew/bin/ego-browser', '/usr/local/bin/ego-browser']) {
    try { await fs.access(candidate, 1); return candidate; } catch { /* Try the next installed location. */ }
  }
  return 'ego-browser';
}

function browserScript(url, resultPath, cancelPath, maxBytes, expiresAt) {
  return `
const resultPath = ${JSON.stringify(resultPath)};
const cancelPath = ${JSON.stringify(cancelPath)};
const targetUrl = ${JSON.stringify(url)};
const maxBytes = ${JSON.stringify(maxBytes)};
const expiresAt = ${JSON.stringify(expiresAt)};
const fs = await import('node:fs/promises');
const cancelled = async () => {
  if (Date.now() > expiresAt) throw Error('DSH_READER_CANCELLED');
  try { await fs.stat(${JSON.stringify(path.dirname(resultPath))}); } catch { throw Error('DSH_READER_CANCELLED'); }
  try { await fs.stat(cancelPath); throw Error('DSH_READER_CANCELLED'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
};
let page;
let mayClean = true;
let result;
try {
  await cancelled();
  const task = await taskSpace(${JSON.stringify(SPACE_NAME)});
  page = task.page('p1');
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await cancelled();
  await page.waitForFunction(() => !!document.querySelector('script#__NEXT_DATA__') || /are you a robot|access denied/i.test(document.title), undefined, { timeout: 15000, polling: 200 });
  await cancelled();
    const extracted = await page.evaluate(({ limit, requestedUrl }) => {
    const url = new URL(location.href);
    const host = url.hostname.toLowerCase().replace(/\\.$/, '');
    if (!/^https?:$/.test(url.protocol) || !(host === 'bloomberg.com' || host.endsWith('.bloomberg.com')) || !/^\\/(?:news\\/(?:articles|features|newsletters)|opinion\\/articles)\\/\\d{4}-\\d{2}-\\d{2}\\/[^/]+\\/?$/i.test(url.pathname)) throw Error('BROWSER_TARGET_CHANGED');
    if (url.pathname.replace(/\\/+$/, '') !== new URL(requestedUrl).pathname.replace(/\\/+$/, '')) throw Error('BROWSER_TARGET_CHANGED');
    const raw = document.querySelector('script#__NEXT_DATA__')?.textContent;
    if (!raw || raw.length > limit) throw Error('BROWSER_NO_ARTICLE');
    const data = JSON.parse(raw);
    const story = data?.props?.pageProps?.story;
    if (!Array.isArray(story?.body?.content) || !story.body.content.length) throw Error('BROWSER_NO_ARTICLE');
    const minimal = { headline: story.headline, title: story.title, byline: story.byline,
      authors: Array.isArray(story.authors) ? story.authors.slice(0, 20).map(a => ({ name: a?.name })) : [],
      body: story.body, truncated: story.truncated, isTruncated: story.isTruncated };
    return { url: url.href, nextData: JSON.stringify({ props: { pageProps: { story: minimal } } }) };
  }, { limit: maxBytes, requestedUrl: targetUrl });
  await cancelled();
  result = { ok: true, ...extracted, spaceId: task.spaceId };
} catch (error) {
  const message = String(error?.message || error);
  if (/control|inactive|unassigned|user.?owned|ownership|EGO_TASK_SPACE/i.test(message)) mayClean = false;
  result = { ok: false, code: message.includes('DSH_READER_CANCELLED') ? 'BROWSER_CANCELLED' : 'BROWSER_FAILED' };
} finally {
  if (page && mayClean) await page.goto('about:blank', { waitUntil: 'commit', timeout: 5000 }).catch(() => {});
}
await cancelled();
await fs.writeFile(resultPath, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
console.log(${JSON.stringify(MARKER)} + JSON.stringify({ ok: result.ok, spaceId: result.spaceId }));
`;
}

/** Kept injectable for tests; options are trusted plugin settings, never HTTP input. */
export function fetchBloombergWithBrowser(url, options = {}) {
  if (!isBloombergArticleUrl(url)) return Promise.reject(failure('BROWSER_BLOCKED_URL', '浏览器兜底仅支持 Bloomberg 文章链接'));
  const operation = queue.then(() => run(String(url), options));
  queue = operation.catch(() => {});
  return operation;
}

async function run(url, options) {
  const { signal } = options;
  if (signal?.aborted) throw failure('BROWSER_CANCELLED', '浏览器读取已取消');
  const cooldown = availableAfter - Date.now();
  if (cooldown > 0) await new Promise((resolve, reject) => {
    const timer = setTimeout(done, cooldown);
    function done() { signal?.removeEventListener('abort', abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(failure('BROWSER_CANCELLED', '浏览器读取已取消')); }
    signal?.addEventListener('abort', abort, { once: true });
  });
  if (signal?.aborted) throw failure('BROWSER_CANCELLED', '浏览器读取已取消');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(100, Math.min(60000, options.timeoutMs)) : 45000;
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, Math.min(5 * 1024 * 1024, options.maxBytes)) : 5 * 1024 * 1024;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-reader-browser-'));
  const resultPath = path.join(directory, 'result.json');
  const cancelPath = path.join(directory, 'cancel');
  let child;
  let forceKill;
  try {
    const command = await executable(typeof options.command === 'string' ? options.command : '');
    const launcher = options.spawnImpl || spawn;
    await new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      let output = '';
      let sawMarker = false;
      const settle = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      const stop = (error) => {
        // The CLI forwards work to a remote runtime. Give any old script time to exit
        // before another request can reuse p1, even if the forwarding process dies.
        availableAfter = Math.max(availableAfter, Date.now() + 35000);
        fs.writeFile(cancelPath, 'cancelled', { mode: 0o600 }).catch(() => {});
        try { child?.kill('SIGTERM'); } catch { /* Already gone. */ }
        forceKill = setTimeout(() => { try { child?.kill('SIGKILL'); } catch { /* Already gone. */ } }, 1000);
        forceKill.unref?.();
        settle(error);
      };
      const abort = () => stop(failure('BROWSER_CANCELLED', '浏览器读取已取消'));
      const timer = setTimeout(() => stop(failure('BROWSER_TIMEOUT', '浏览器读取超时，请稍后重试')), timeoutMs);
      try {
        child = launcher(command, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      } catch (error) {
        settle(failure('BROWSER_UNAVAILABLE', '浏览器读取服务不可用，请检查 Ego Lite 是否已安装并运行'));
        return;
      }
      child.on('error', () => settle(failure('BROWSER_UNAVAILABLE', '浏览器读取服务不可用，请检查 Ego Lite 是否已安装并运行')));
      const collectStatus = (chunk) => {
        bytes += chunk.length;
        if (bytes > 65536) { stop(failure('BROWSER_TOO_LARGE', '浏览器读取返回了异常大小的状态信息')); return; }
        output += chunk.toString();
        sawMarker ||= output.includes(MARKER);
      };
      child.stdout?.on('data', collectStatus);
      // Ego currently sends script console output through stderr; accept the marker
      // from either pipe, but never return diagnostics or page content to the client.
      child.stderr?.on('data', collectStatus);
      child.on('close', (code) => {
        clearTimeout(forceKill);
        if (code !== 0 || !sawMarker) settle(failure('BROWSER_FAILED', '浏览器未能读取正文，请确认浏览器可访问该文章'));
        else settle();
      });
      child.stdin?.on('error', () => {});
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdin.end(browserScript(url, resultPath, cancelPath, maxBytes, Date.now() + timeoutMs));
    });
    const stat = await fs.stat(resultPath).catch(() => null);
    if (!stat || stat.size > maxBytes) throw failure('BROWSER_TOO_LARGE', '浏览器返回的正文数据缺失或超过大小上限');
    let result;
    try { result = JSON.parse(await fs.readFile(resultPath, 'utf8')); }
    catch { throw failure('BROWSER_FAILED', '浏览器未能返回有效正文数据'); }
    if (result.ok !== true) throw failure('BROWSER_FAILED', '浏览器未取得文章正文，可能需要在浏览器中完成访问验证或登录');
    if (!isBloombergArticleUrl(result.url) || typeof result.nextData !== 'string' || Buffer.byteLength(result.nextData) > maxBytes) {
      throw failure('BROWSER_BLOCKED_URL', '浏览器未返回受支持的 Bloomberg 文章');
    }
    if (new URL(result.url).pathname.replace(/\/+$/, '') !== new URL(url).pathname.replace(/\/+$/, '')) {
      throw failure('BROWSER_BLOCKED_URL', '浏览器跳转到了另一篇文章，未将其作为当前文章读取');
    }
    let data;
    try { data = JSON.parse(result.nextData); } catch { throw failure('BROWSER_FAILED', '浏览器返回的文章数据格式不正确'); }
    if (!Array.isArray(data?.props?.pageProps?.story?.body?.content) || !data.props.pageProps.story.body.content.length) {
      throw failure('BROWSER_FAILED', '浏览器页面没有返回可解析的正文');
    }
    const safe = JSON.stringify(data).replace(/</g, '\\u003c');
    return { html: `<html><head><meta property="og:site_name" content="Bloomberg"><script id="__NEXT_DATA__" type="application/json">${safe}</script></head><body></body></html>`,
      finalUrl: result.url, via: 'browser', spaceId: result.spaceId };
  } finally {
    // Cancellation flag remains until bounded remote work has had a chance to see it.
    if (signal?.aborted || availableAfter > Date.now()) {
      const timer = setTimeout(() => fs.rm(directory, { recursive: true, force: true }).catch(() => {}), 36000);
      timer.unref?.();
    } else await fs.rm(directory, { recursive: true, force: true });
  }
}
