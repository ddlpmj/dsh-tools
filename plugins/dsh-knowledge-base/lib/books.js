/** Independent book workspaces. The main Wiki is never a compilation/search catalog. */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeBase, KbError, sha256Hex } from './kb.js';
import { BookAnalysis } from './book-analysis.js';
import { selectReadingChapters } from './book-content.js';

const BOOK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const iso = () => new Date().toISOString();
const cleanTitle = value => String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
const fileName = value => path.basename(String(value || 'book.txt').replace(/\\/g, '/')).replace(/[\r\n\0]/g, '').slice(0, 180) || 'book.txt';
const chapterSettled = chapter => chapter.status === 'ready' || chapter.status === 'skipped';

export class BookLibrary {
  constructor(options = {}) {
    if (!options.rootDir) throw new KbError('BAD_REQUEST', '缺少书库目录');
    this.rootDir = path.resolve(options.rootDir);
    this.booksRoot = path.join(this.rootDir, 'books');
    this.extractBook = options.extractBook;
    this.compileChapter = options.compileChapter;
    this.maxFileBytes = options.maxFileBytes || 30 * 1024 * 1024;
    this.maxExtractChars = options.maxExtractChars || 5000000;
    this.records = new Map();
    this.knowledge = new Map();
    this.active = new Map();
    this.locks = new Map();
    this.deleting = new Set();
    this.disposed = false;
    this.analysis = new BookAnalysis({ books: this, generate: options.generateAnalysis });
  }

  _id(id) {
    if (typeof id !== 'string' || !BOOK_ID.test(id)) throw new KbError('BAD_REQUEST', '书籍编号不合法');
    return id;
  }

  async _plain(target, directory = false) {
    let stat;
    try { stat = await fsp.lstat(target); } catch (error) {
      if (error.code === 'ENOENT') throw new KbError('NOT_FOUND', '书籍或文件不存在');
      throw error;
    }
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new KbError('BLOCKED_URL', '书库不允许符号链接或跨目录访问');
    return stat;
  }

  async _root(create = true) {
    if (create) await fsp.mkdir(this.booksRoot, { recursive: true });
    await this._plain(this.booksRoot, true);
    return this.booksRoot;
  }

  async _directory(id) {
    this._id(id);
    await this._root(false);
    const target = path.join(this.booksRoot, id);
    await this._plain(target, true);
    return target;
  }

  async _safeKnowledge(id) {
    const bookRoot = await this._directory(id);
    const root = path.join(bookRoot, 'knowledge');
    await this._plain(root, true);
    const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
    if (entries.some(entry => entry.isSymbolicLink())) throw new KbError('BLOCKED_URL', '本书知识库包含符号链接，已阻止访问');
    return root;
  }

  async _atomic(file, value) {
    const temporary = file + '.tmp-' + randomUUID();
    try { await fsp.writeFile(temporary, value); await fsp.rename(temporary, file); }
    finally { await fsp.unlink(temporary).catch(() => {}); }
  }

  async _save(book) {
    const root = await this._directory(book.id);
    book.updatedAt = iso();
    await this._atomic(path.join(root, 'book.json'), JSON.stringify(book, null, 2) + '\n');
  }

  async _load(id) {
    this._id(id);
    const root = await this._directory(id);
    const manifest = path.join(root, 'book.json');
    await this._plain(manifest);
    if (this.records.has(id)) return this.records.get(id);
    let book;
    try { book = JSON.parse(await fsp.readFile(manifest, 'utf8')); } catch { throw new KbError('INTERNAL', '书籍记录无法读取'); }
    if (book.id !== id || !Array.isArray(book.chapters)) throw new KbError('INTERNAL', '书籍记录不合法');
    this.records.set(id, book);
    if (book.chapters.length && book.chapters.every(chapterSettled) && book.status !== 'ready') {
      book.status = 'ready'; book.stage = '本书知识抽取完成'; book.currentChapterId = ''; book.message = ''; book.error = '';
      await this._save(book);
    } else if (book.status === 'running') {
      book.status = 'paused';
      book.stage = '上次处理已中断，可继续抽取';
      for (const chapter of book.chapters) if (chapter.status === 'running') chapter.status = 'pending';
      await this._save(book);
    }
    return book;
  }

  _coverage(book) {
    const eligible = book.chapters.filter(chapter => chapter.status !== 'skipped');
    const ready = eligible.filter(chapter => chapter.status === 'ready');
    return { ...book.coverage, completedChapters: ready.length, totalChapters: eligible.length, processedChars: ready.reduce((n, chapter) => n + (chapter.processedChars ?? chapter.chars), 0) };
  }

  _public(book, summary = false) {
    const result = {
      id: book.id, title: book.title, name: book.name, mime: book.mime, bytes: book.bytes,
      createdAt: book.createdAt, updatedAt: book.updatedAt, status: book.status,
      stage: book.stage || '', message: book.message || '', currentChapterId: book.currentChapterId || '',
      coverage: this._coverage(book), warnings: book.warnings || [], error: book.error || '', stats: book.stats,
    };
    result.progress = result.coverage.totalChapters ? result.coverage.completedChapters / result.coverage.totalChapters : 0;
    if (!summary) result.chapters = book.chapters.map(chapter => {
      const { file, ...publicChapter } = chapter;
      return publicChapter;
    });
    return clone(result);
  }

  async list() {
    await this._root();
    const entries = await fsp.readdir(this.booksRoot, { withFileTypes: true });
    const books = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !BOOK_ID.test(entry.name)) continue;
      try {
        const item = this._public(await this._load(entry.name), true);
        try { item.reading = await this.analysis.summary(entry.name); }
        catch { item.reading = { status: 'failed', stage: '精读记录无法读取，原书仍可阅读' }; }
        books.push(item);
      }
      catch (error) {
        if (error.code === 'NOT_FOUND') continue;
        books.push({ id: entry.name, title: '无法读取的书籍', name: '', mime: '', bytes: 0, createdAt: '', updatedAt: '', status: 'failed', stage: '书籍记录无法读取，可删除后重新导入', message: '', currentChapterId: '', coverage: { originalChars: 0, originalCharsKnown: false, extractedChars: 0, processedChars: 0, completedChapters: 0, totalChapters: 0, truncated: false, coverageComplete: false }, warnings: [], error: '书籍记录损坏或无法访问，可删除后重新导入', stats: { pages: 0, entities: 0, topics: 0, sources: 0 }, progress: 0 });
      }
    }
    return books.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id) { return this._public(await this._load(id)); }

  /** Refresh old EPUB coverage only when the extracted text is byte-for-byte unchanged. */
  async refreshReadingSource(id) {
    const book = await this._load(id);
    if (book.coverage?.format !== 'epub' || book.coverage.coverageComplete || typeof this.extractBook !== 'function') return;
    const original = await this.readOriginal(id);
    let extracted;
    try { extracted = await this.extractBook(original.buffer, { name: book.name, mime: book.mime, maxChars: this.maxExtractChars }); }
    catch { return; } // Existing recognized text remains readable if reparsing is unavailable.
    if (!extracted.coverageComplete) return;
    const parts = [];
    for (const chapter of book.chapters) parts.push((await this.readChapter(id, chapter.id)).text);
    if (parts.join('') !== extracted.text) return;
    book.coverage = { ...book.coverage, originalChars: extracted.originalChars, originalCharsKnown: extracted.originalCharsKnown,
      extractedChars: extracted.extractedChars, truncated: extracted.truncated, coverageComplete: extracted.coverageComplete };
    const benignPaths = new Set(extracted.warnings.filter(w => /^已略过(?:封面|空白)页：/.test(w)).map(w => w.split('：').slice(1).join('：')));
    book.warnings = [...new Set([...(book.warnings || []).filter(w => {
      const match = /^章节仅含图片或无可读文字，未抽取：(.+)$/.exec(w);
      return !match || !benignPaths.has(match[1]);
    }), ...extracted.warnings])];
    await this._save(book);
  }

  async _locked(id, callback) {
    const previous = this.locks.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(callback);
    this.locks.set(id, next);
    try { return await next; }
    finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }

  async create(input = {}) {
    if (this.disposed) throw new KbError('CONFLICT', '书库正在重载');
    const buffer = input.buffer;
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new KbError('BAD_REQUEST', '书籍文件不能为空');
    if (buffer.length > this.maxFileBytes) throw new KbError('TOO_LARGE', `书籍文件超过 ${Math.round(this.maxFileBytes / 1024 / 1024)} MB 上限`);
    if (typeof this.extractBook !== 'function') throw new KbError('INTERNAL', '书籍解析器不可用');
    const name = fileName(input.name);
    const extracted = await this.extractBook(buffer, { name, mime: String(input.mime || ''), maxChars: this.maxExtractChars });
    const text = String(extracted.text || '');
    const chapters = extracted.chapters;
    if (!text || !Array.isArray(chapters) || !chapters.length) throw new KbError('EXTRACT_FAILED', '未能识别书籍正文和章节');
    let offset = 0;
    const ids = new Set();
    for (const chapter of chapters) {
      if (!chapter.id || ids.has(chapter.id) || chapter.startChar !== offset || chapter.endChar <= offset || text.slice(chapter.startChar, chapter.endChar) !== chapter.text) throw new KbError('EXTRACT_FAILED', '章节覆盖不完整，未创建书籍');
      ids.add(chapter.id); offset = chapter.endChar;
    }
    if (offset !== text.length) throw new KbError('EXTRACT_FAILED', '章节没有覆盖全部已识别正文');
    const title = cleanTitle(input.title) || cleanTitle(extracted.title) || cleanTitle(name);
    const { excludedChapters } = selectReadingChapters(chapters, title);
    const excludedIds = new Set(excludedChapters.map(chapter => chapter.id));
    await this._root();
    const id = randomUUID();
    const root = path.join(this.booksRoot, id);
    await fsp.mkdir(root);
    try {
      await fsp.mkdir(path.join(root, 'original'));
      await fsp.mkdir(path.join(root, 'chapters'));
      const extension = /^\.[a-z0-9]{1,10}$/i.test(path.extname(name)) ? path.extname(name).toLowerCase() : '.bin';
      const originalFile = 'source' + extension;
      await fsp.writeFile(path.join(root, 'original', originalFile), buffer);
      const metadata = [];
      for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        const file = `chapter-${String(i + 1).padStart(5, '0')}.txt`;
        await fsp.writeFile(path.join(root, 'chapters', file), chapter.text);
        metadata.push({ id: String(chapter.id), title: cleanTitle(chapter.title) || `第 ${i + 1} 部分`, file, startChar: chapter.startChar, endChar: chapter.endChar, chars: chapter.text.length, status: excludedIds.has(chapter.id) ? 'skipped' : 'pending', sourceId: '', pages: [], error: '', completedAt: null });
      }
      const kb = new KnowledgeBase(path.join(root, 'knowledge'), { chapterPages: options => this._chapterSearchPages(id, options) });
      await kb.init();
      const book = {
        version: 1, id, title, name,
        mime: String(input.mime || ''), bytes: buffer.length, originalFile,
        createdAt: iso(), updatedAt: iso(), status: 'imported', stage: '原书已保存，等待抽取知识',
        chapters: metadata, warnings: Array.isArray(extracted.warnings) ? extracted.warnings.map(String) : [], error: '',
        coverage: { originalChars: Number.isFinite(extracted.originalChars) ? extracted.originalChars : text.length, originalCharsKnown: extracted.originalCharsKnown !== false, extractedChars: text.length, truncated: extracted.truncated === true, coverageComplete: extracted.coverageComplete !== false && extracted.truncated !== true, chapterMode: extracted.chapterMode || 'parts', format: extracted.format || '' },
        stats: kb.counts(),
      };
      this.records.set(id, book); this.knowledge.set(id, kb);
      await this._save(book);
      return this._public(book);
    } catch (error) {
      this.records.delete(id); this.knowledge.delete(id);
      await fsp.rm(root, { recursive: true, force: true });
      throw error;
    }
  }

  async getKnowledgeBase(id) {
    await this._load(id);
    const root = await this._safeKnowledge(id);
    if (!this.knowledge.has(id)) this.knowledge.set(id, new KnowledgeBase(root, { chapterPages: options => this._chapterSearchPages(id, options) }));
    const kb = this.knowledge.get(id);
    await kb.ensureState();
    return kb;
  }

  async _chapterTexts(book) {
    const chapters = [];
    for (const chapter of book.chapters) chapters.push(await this.readChapter(book.id, chapter.id));
    return chapters;
  }

  /** Search the retained passages. Direct source links still address the complete chapter. */
  async _chapterSearchPages(id, { forSearch = false } = {}) {
    const book = await this._load(id);
    const originals = await this._chapterTexts(book);
    const chapters = forSearch ? selectReadingChapters(originals, book.title).chapters : originals;
    return chapters.map(chapter => ({ path: `book-chapters/${chapter.id}.md`, title: `《${book.title}》·${chapter.title}`,
      text: chapter.text, readingRanges: chapter.readingRanges, type: 'chapter', chapterId: chapter.id, aliases: [], tags: [] }));
  }

  async readChapter(id, chapterId) {
    const book = await this._load(id);
    const chapter = book.chapters.find(item => item.id === chapterId);
    if (!chapter) throw new KbError('NOT_FOUND', '本书中不存在该章节');
    if (!/^chapter-\d{5}\.txt$/.test(chapter.file)) throw new KbError('INTERNAL', '章节文件记录不合法');
    const root = await this._directory(id);
    await this._plain(path.join(root, 'chapters'), true);
    const target = path.join(root, 'chapters', chapter.file);
    await this._plain(target);
    const { file, ...metadata } = chapter;
    return { ...clone(metadata), text: await fsp.readFile(target, 'utf8') };
  }

  async readOriginal(id) {
    const book = await this._load(id);
    const root = await this._directory(id);
    await this._plain(path.join(root, 'original'), true);
    if (!/^source\.[a-z0-9]{1,10}$/i.test(book.originalFile)) throw new KbError('INTERNAL', '原书文件记录不合法');
    const target = path.join(root, 'original', book.originalFile);
    await this._plain(target);
    return { name: book.name, mime: book.mime, buffer: await fsp.readFile(target) };
  }

  async start(id) {
    return this._locked(this._id(id), async () => {
      if (this.disposed || this.deleting.has(id)) throw new KbError('CONFLICT', '书籍正在删除或书库正在重载');
      const book = await this._load(id);
      if (book.chapters.every(chapterSettled)) {
        if (book.status !== 'ready') { book.status = 'ready'; book.stage = '本书知识抽取完成'; book.currentChapterId = ''; book.message = ''; book.error = ''; await this._save(book); }
        return this._public(book);
      }
      if (this.active.has(id)) return this._public(book);
      if (typeof this.compileChapter !== 'function') throw new KbError('NO_MODEL', '模型服务不可用');
      const controller = new AbortController();
      const active = { controller, promise: null };
      book.status = 'running'; book.error = ''; book.stage = '准备逐章抽取知识';
      await this._save(book);
      this.active.set(id, active);
      active.promise = this._run(book, controller.signal).catch(async error => {
        book.status = controller.signal.aborted ? 'paused' : 'failed'; book.error = controller.signal.aborted ? '' : String(error.message || error);
        await this._save(book).catch(() => {});
      }).finally(() => { if (this.active.get(id) === active) this.active.delete(id); });
      return this._public(book);
    });
  }

  async _run(book, signal) {
    const kb = await this.getKnowledgeBase(book.id);
    const selection = selectReadingChapters(await this._chapterTexts(book), book.title);
    const selectedById = new Map(selection.chapters.map(chapter => [chapter.id, chapter]));
    for (const chapter of book.chapters) {
      if (signal.aborted) break;
      if (chapterSettled(chapter)) continue;
      const selected = selectedById.get(chapter.id);
      if (!selected) {
        chapter.status = 'skipped'; chapter.error = '';
        await this._save(book);
        continue;
      }
      chapter.status = 'running'; chapter.error = ''; book.currentChapterId = chapter.id; book.stage = `正在抽取：${chapter.title}`;
      await this._save(book);
      try {
        await this._safeKnowledge(book.id);
        const text = selected.readingRanges.map(range => selected.text.slice(range.startChar, range.endChar)).join('\n\n');
        const sourceTitle = `《${book.title}》·${chapter.title}`;
        const chapterIdentity = sha256Hex(book.id + '\0' + chapter.id + '\0' + selected.text);
        const source = (await kb.registerSource({ kind: 'note', name: `${chapter.id}.txt`, title: sourceTitle, text, chars: text.length, bytes: Buffer.byteLength(text), sha256: chapterIdentity, textHash: chapterIdentity })).source;
        chapter.sourceId = source.id;
        await this._save(book);
        const result = await this.compileChapter({ book: this._public(book, true), chapter: clone(chapter), source: { ...source, text }, kb, signal, onProgress: (stage, progress, message) => { book.stage = String(stage || chapter.title); book.message = String(message || ''); } });
        if (signal.aborted) throw new Error('已暂停');
        if ((result.warnings || []).some(warning => String(warning).startsWith('编译兜底：'))) {
          throw new KbError('LLM_FAILED', '本章未能生成结构化知识，原文已保留，请重试');
        }
        await this._safeKnowledge(book.id);
        const applied = await kb.applyCompiledSource(source.id, result);
        chapter.pages = applied.pages;
        book.stats = kb.counts();
        const warnings = [...(result.warnings || []), ...(applied.warnings || [])].map(item => `${chapter.title}：${item}`);
        book.warnings = [...new Set([...(book.warnings || []), ...warnings])].slice(0, 200);
        const writeFailures = (applied.warnings || []).filter(warning => /^页面《[\s\S]*》写入失败：|^追加更新失败：/.test(String(warning)));
        if (writeFailures.length) throw new KbError('INTERNAL', '本章部分知识页未能写入，原文及已生成页面保留，请重试。' + writeFailures.join('；'));
        chapter.status = 'ready'; chapter.completedAt = iso(); chapter.error = ''; chapter.processedChars = text.length;
        await this._save(book);
      } catch (error) {
        chapter.status = signal.aborted ? 'pending' : 'failed'; chapter.error = signal.aborted ? '' : String(error.message || error);
        book.status = signal.aborted ? 'paused' : book.chapters.some(item => item.status === 'ready') ? 'partial' : 'failed';
        book.error = chapter.error; book.stage = signal.aborted ? '已暂停，可继续抽取' : '本章抽取失败，可重试';
        await this._save(book);
        return;
      }
    }
    const completed = book.chapters.every(chapterSettled);
    book.status = completed ? 'ready' : 'paused';
    book.stage = completed ? '本书知识抽取完成' : '已暂停，可继续抽取';
    book.currentChapterId = ''; book.message = ''; book.stats = kb.counts();
    await this._save(book);
  }

  async wait(id) { const active = this.active.get(this._id(id)); if (active) await active.promise; return this.get(id); }

  async pause(id) {
    const active = await this._locked(this._id(id), async () => { await this._load(id); const job = this.active.get(id); if (job) job.controller.abort(); return job; });
    if (active) await active.promise;
    return this.get(id);
  }

  async remove(id) {
    const active = await this._locked(this._id(id), async () => { await this._directory(id); this.deleting.add(id); const job = this.active.get(id); if (job) job.controller.abort(); return job; });
    try {
      if (active) await active.promise;
      await this.analysis.stop(id);
      return await this._locked(id, async () => {
        const root = await this._directory(id);
        await fsp.rm(root, { recursive: true, force: false });
        this.records.delete(id); this.knowledge.delete(id);
        return { id, deleted: true };
      });
    } finally { this.deleting.delete(id); }
  }

  async dispose() {
    this.disposed = true;
    const active = [...this.active.values()];
    for (const job of active) job.controller.abort();
    await Promise.allSettled([...active.map(job => job.promise), this.analysis.dispose()]);
  }
}
